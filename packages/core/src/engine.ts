// 引擎：Event → tracker → 检测器 → policy。回放和（以后的）守护进程共用。
import { defaultConfig, type Config } from "./config.ts";
import { ALL_DETECTORS, detectAll, mkHit, type DetectCtx, type Detector, type Hit } from "./detectors/index.ts";
import type { Event } from "./event.ts";
import type { JudgeFn } from "./judge/types.ts";
import { parsePlanMd, type Plan } from "./plan.ts";
import { outcomeOf, Policy, type Decision, type PolicyOptions } from "./policy.ts";
import { SessionTracker } from "./session.ts";
import type { JudgeCallRecord, LogSink } from "./store/sink.ts";

export interface EngineOptions {
  cfg?: Config;
  judge?: JudgeFn;
  policy?: PolicyOptions;
  detectors?: Detector[];
  /** .supervisor/plan.md 的内容（优先于自动提取）。 */
  planMd?: string;
  /** 结构化日志（design §18）：每处理一条事件调用一次。 */
  sink?: LogSink;
}

export interface StepRecord {
  event: Event;
  hits: Hit[];
  decisions: Decision[];
  /** deferJudge=true 时：M 级后台 judge 的工作；调用 engine.runDeferred(rec) 执行。 */
  deferred?: () => Promise<Decision[]>;
}

export class Engine {
  readonly cfg: Config;
  readonly tracker: SessionTracker;
  readonly policy: Policy;
  readonly records: StepRecord[] = [];
  private lastHitStepCount = 0;
  private lastR4StepCount = 0;
  private readonly judge?: JudgeFn;
  private readonly detectors: Detector[];
  private readonly sink?: LogSink;
  private judgeCalls: JudgeCallRecord[] = [];

  constructor(opts: EngineOptions = {}) {
    this.cfg = opts.cfg ?? defaultConfig();
    this.tracker = new SessionTracker({ testFull: this.cfg.test.full, testFast: this.cfg.test.fast, extraPatterns: this.cfg.test.extra_patterns });
    this.policy = new Policy(this.cfg, this.tracker, opts.policy);
    this.sink = opts.sink;
    // 包一层记录每次 judge 调用（请求/结果/时间），供日志使用
    this.judge = opts.judge
      ? async (req) => {
          const result = await opts.judge!(req);
          this.judgeCalls.push({ req, result, ts: this.tracker.lastEventTs });
          return result;
        }
      : undefined;
    this.detectors = opts.detectors ?? ALL_DETECTORS;
    if (opts.planMd) this.tracker.setFilePlan(parsePlanMd(opts.planMd));
  }

  get plan(): Plan | null {
    return this.tracker.effectivePlan();
  }

  ctx(): DetectCtx {
    return { s: this.tracker, cfg: this.cfg, th: this.cfg.thresholds };
  }

  async feed(e: Event, opts: { deferJudge?: boolean } = {}): Promise<StepRecord> {
    this.tracker.ingest(e);
    const ctx = this.ctx();
    const hits = detectAll(e, ctx, this.detectors);
    const r4 = this.r4(e, ctx, hits);
    if (r4) hits.push(r4);
    if (hits.some((h) => h.ruleId !== "INTERNAL" && h.sev !== "L")) this.lastHitStepCount = this.tracker.steps.length;
    const decisions = await this.policy.handle(e, hits, this.judge, { deferM: opts.deferJudge });
    const deferred = this.policy.takeDeferred();
    this.registerSent(e, decisions);
    const rec: StepRecord = { event: e, hits, decisions, deferred };
    this.records.push(rec);
    const calls = this.takeJudgeCalls(hits);
    try {
      this.sink?.onFeed({ event: e, hits, decisions, judgeCalls: calls, tracker: this.tracker, cfg: this.cfg });
    } catch (err) {
      // 日志写入失败不能影响监督（fail-open）：只在 stderr 提示一次
      if (!this.sinkWarned) console.error("[sv] 日志写入失败（已忽略，监督继续）：", String(err));
      this.sinkWarned = true;
    }
    return rec;
  }

  private sinkWarned = false;

  /** 真正生效的监督消息：登记 origin 哈希（P0-6），并记入「已发消息」。 */
  private registerSent(e: Event, decisions: Decision[]): void {
    for (const d of decisions) {
      if (d.applied && d.message && ["advise", "block", "ask", "stop_continue"].includes(d.action)) {
        this.tracker.registry.register(d.message);
        this.tracker.sentMessages.push({ seq: e.seq, ruleId: d.hit.ruleId, text: d.message });
      }
    }
  }

  /** 取走属于这些命中的 judge 调用（feed 与后台 judge 可能交错，只拿自己的）。 */
  private takeJudgeCalls(hits: Hit[]): JudgeCallRecord[] {
    const mine = (c: JudgeCallRecord) => c.req.hits.some((h) => hits.some((x) => x.ruleId === h.ruleId && x.key === h.key && x.seq === h.seq));
    const taken = this.judgeCalls.filter(mine);
    this.judgeCalls = this.judgeCalls.filter((c) => !mine(c));
    return taken;
  }

  /**
   * 执行 feed(…, {deferJudge:true}) 留下的后台 judge 工作：迟到的决策追加到 rec.decisions，
   * 写日志（sink.onLate），返回迟到的决策（守护进程据此把 applied 的消息入 outbox）。
   */
  async runDeferred(rec: StepRecord): Promise<Decision[]> {
    const work = rec.deferred;
    if (!work) return [];
    rec.deferred = undefined;
    const late = await work();
    for (const d of late) d.outcome = outcomeOf(d);
    rec.decisions.push(...late);
    this.registerSent(rec.event, late);
    const calls = this.takeJudgeCalls(late.map((d) => d.hit));
    try {
      this.sink?.onLate?.({ event: rec.event, hits: rec.hits, decisions: late, judgeCalls: calls, tracker: this.tracker, cfg: this.cfg });
    } catch (err) {
      if (!this.sinkWarned) console.error("[sv] 日志写入失败（已忽略，监督继续）：", String(err));
      this.sinkWarned = true;
    }
    return late;
  }

  /** 关闭日志（结算未走完的遵从观察窗口、结束 run）。 */
  close(): void {
    this.sink?.close();
  }

  async run(events: Iterable<Event>): Promise<StepRecord[]> {
    for (const e of events) await this.feed(e);
    return this.records;
  }

  /** R4：没有其他触发时的定期抽查。 */
  private r4(e: Event, ctx: DetectCtx, hits: Hit[]): Hit | null {
    if (e.phase !== "post" || !e.tool) return null;
    const n = this.tracker.steps.length;
    const base = this.cfg.detect.r4_interval_steps;
    const interval = n < this.policy.r4BoostUntilStep ? Math.max(1, Math.floor(base / 2)) : base;
    const since = n - Math.max(this.lastHitStepCount, this.lastR4StepCount);
    if (since < interval || hits.some((h) => h.sev !== "L")) return null;
    if (this.policy.paused) return null;
    this.lastR4StepCount = n;
    return mkHit(e, ctx, { ruleId: "R4", sev: "M", category: "other", key: `R4:${n}`, detail: { everySteps: interval }, message: `已连续 ${since} 步没有触发其他规则，定期抽查。` });
  }

  get allHits(): Hit[] {
    return this.records.flatMap((r) => r.hits);
  }

  get allDecisions(): Decision[] {
    return this.records.flatMap((r) => r.decisions);
  }
}
