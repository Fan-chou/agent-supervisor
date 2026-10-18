// 升级策略（design §7、§9）：命中 → 动作。冷却、预算、连续拦截上限、fail-open、自适应阈值。
import type { Config } from "./config.ts";
import type { Hit } from "./detectors/types.ts";
import type { Event } from "./event.ts";
import { filterJudgeMessage } from "./judge/filter.ts";
import type { JudgeFn, JudgeResult } from "./judge/types.ts";
import type { SessionTracker } from "./session.ts";

export type Action =
  | "log" //          只记录
  | "advise" //       本地预设或 judge 给出的建议，进 outbox
  | "block" //        拦截（pre 阶段）
  | "ask" //          让用户确认（X2 在 Claude 上）
  | "stop_continue" // Stop 阶段让 agent 继续
  | "ignore" //       judge 判 ignore
  | "judge_off" //    M 级，judge 关闭（回放 --judge=off），记录「本会查询 judge」
  | "skip"; //        被冷却/预算/静默/故障挡掉

export interface Decision {
  hit: Hit;
  action: Action;
  /** 为什么是这个动作（便于回放对账）。 */
  reason: string;
  message?: string;
  judge?: { kind: JudgeResult["kind"]; verdict?: string; confidence?: number; model?: string };
  /** 在当前 mode 下是否真的会生效（shadow 只记录）。 */
  applied: boolean;
  /** 条件满足时会拦截，但工作区指纹没核实（回放里常见）。 */
  wouldBlockIfVerified?: boolean;
  /** judge 判 block，要等下一个注入点（pre）才能执行。 */
  atNextPre?: boolean;
  /** 受连续拦截上限约束的拦截（同一次调用上多个规则同时拦，只计 1 次）。 */
  counted?: boolean;
}

export interface PolicyOptions {
  /** 回放时没有真实指纹：把「由事件推断的未改动」当作已核实（结果里仍会标注）。 */
  trustInferredUnchanged?: boolean;
}

const sevOrder = { H: 0, M: 1, L: 2 } as const;
const isCountRule = (id: string) => id === "L1" || id === "T1" || (id === "P1");

export class Policy {
  private judgeCalls = 0;
  private lastJudgeTs = -Infinity;
  private lastJudgeByCategory = new Map<string, number>();
  private lastFired = new Map<string, { stepCount: number; ts: number }>();
  private blockedAt = new Map<string, { stepCount: number; ts: number }>();
  private lastAdviseByCategory = new Map<string, number>();
  private lAdviseCount = new Map<string, number>();
  private consecutiveBlocks = 0;
  private lastBlockedArgs: string | undefined;
  private ignoreStreak = new Map<string, number>();
  private stopContinues = 0;
  /** R4 抽查间隔减半的截止步数 / 暂停标记。 */
  r4BoostUntilStep = -1;
  paused = false; // judge done=true：暂停 R4 和 P4，直到下一次 M 级命中
  readonly judgeLog: { ruleId: string; result: JudgeResult["kind"]; model?: string; verdict?: string; sync?: boolean }[] = [];

  constructor(
    private readonly cfg: Config,
    private readonly s: SessionTracker,
    private readonly opts: PolicyOptions = {},
  ) {}

  get judgeCallCount(): number {
    return this.judgeCalls;
  }

  private modeApplies(kind: "block" | "advise"): boolean {
    if (this.cfg.mode === "enforce") return true;
    if (this.cfg.mode === "advise") return kind === "advise";
    return false;
  }

  private cooledDown(h: Hit, e: Event): boolean {
    const prev = this.lastFired.get(h.key);
    if (!prev) return false;
    return this.s.steps.length - prev.stepCount < this.cfg.budgets.rule_cooldown_steps && e.ts - prev.ts < this.cfg.budgets.rule_cooldown_s * 1000;
  }

  private markFired(h: Hit, e: Event): void {
    this.lastFired.set(h.key, { stepCount: this.s.steps.length, ts: e.ts });
  }

  /** 此前对同一 key 的 pre 拦截判断是否仍在有效期内（与冷却用同一组窗口：10 步 / 5 分钟，两个条件同时满足）。 */
  private blockStillValid(h: Hit, e: Event): boolean {
    const prev = this.blockedAt.get(h.key);
    if (!prev) return false;
    return this.s.steps.length - prev.stepCount < this.cfg.budgets.rule_cooldown_steps && e.ts - prev.ts < this.cfg.budgets.rule_cooldown_s * 1000;
  }

  /** 处理一条事件上产生的全部命中。 */
  async handle(e: Event, hits: Hit[], judge?: JudgeFn): Promise<Decision[]> {
    const out: Decision[] = [];
    const sorted = [...hits].sort((a, b) => sevOrder[a.sev] - sevOrder[b.sev]);
    const mHits: Hit[] = [];
    for (const h of sorted) {
      const d = await this.one(e, h, judge, mHits);
      if (d) out.push(d);
    }
    // M 级：同一事件上的同类命中合并成一次 judge 调用
    if (mHits.length) out.push(...(await this.judgeBatch(e, mHits, judge)));
    // 连续拦截计数：同一次调用上多个规则同时拦只计 1 次；被放行的不同调用重置
    if (out.some((d) => d.counted)) this.consecutiveBlocks++;
    if (e.phase === "pre" && e.tool) {
      if (out.some((d) => d.action === "block")) {
        this.lastBlockedArgs = e.tool.argsHash;
      } else if (this.lastBlockedArgs !== e.tool.argsHash) {
        this.consecutiveBlocks = 0;
      }
    }
    return out;
  }

  private async one(e: Event, h: Hit, judge: JudgeFn | undefined, mHits: Hit[]): Promise<Decision | null> {
    const base = (action: Action, reason: string, extra: Partial<Decision> = {}): Decision => ({ hit: h, action, reason, applied: false, ...extra });

    // 用户覆盖：#sv off 关掉一切（X2 是适配器本地规则，不受影响）；#sv quiet 关掉建议
    if (this.s.silenced === "off" && h.ruleId !== "X2") return base("skip", "user #sv off");
    if (h.observeOnly) return base("log", "observe-only（只在回放中观察）");
    if (h.ruleId === "INTERNAL") return base("log", "detector error");

    // ---- X2：本地拦截，不问 judge，不受上限约束，不依赖 mode（规则配置为 block 时） ----
    if (h.ruleId === "X2") {
      const act = this.cfg.rules.X2_dangerous?.action ?? "block";
      if (act === "off") return base("log", "X2 disabled by config");
      const ask = h.x2?.action === "ask";
      this.markFired(h, e);
      // X2 跟随 mode：shadow 只记录（action 仍标 ask/deny 供观察）；advise 模式下也不拦。不受连续拦截上限约束。
      return base(ask ? "ask" : "block", "X2 本地规则，不受连续拦截上限约束", { message: h.message, applied: this.modeApplies("block") });
    }

    // ---- 显式 P1（plan.md 里写了 allow）：本地拦截，不问 judge，不受上限约束 ----
    if (h.explicit && h.blockable && h.phase === "pre") {
      this.markFired(h, e);
      return base("block", "P1 显式 allow，不受连续拦截上限约束", { message: h.message, applied: this.modeApplies("block") });
    }

    if (h.sev === "L") return this.localLevel(e, h, base);

    // 能在 pre 上拦截的 H 命中：冷却只挡「放行类」结局（advise / ignore），不挡 block——
    // 否则被拦的调用一重试就落进冷却被放行，「连续拦截 ≤2」会变成 ≤1。冷却在 hardLevel 里按结局处理。
    if (h.sev === "H" && h.blockable && h.phase === "pre") return this.hardLevel(e, h, judge, base);

    if (this.cooledDown(h, e)) return base("skip", "同规则同指纹冷却中");

    if (h.sev === "H") return this.hardLevel(e, h, judge, base);

    // ---- M：进入 judge 队列 ----
    if (this.s.silenced === "quiet") return base("skip", "user #sv quiet");
    mHits.push(h);
    return null;
  }

  private localLevel(e: Event, h: Hit, base: (a: Action, r: string, x?: Partial<Decision>) => Decision): Decision {
    if (!h.message) return base("log", "L 级只记录");
    if (this.s.silenced === "quiet") return base("skip", "user #sv quiet");
    if (this.cooledDown(h, e)) return base("skip", "同规则同指纹冷却中");
    const cat = h.category;
    const lastCat = this.lastAdviseByCategory.get(cat);
    if (lastCat !== undefined && this.s.steps.length - lastCat < 10 && !h.ruleId.startsWith("T")) return base("skip", "同 category 10 步内不重复");
    if (!h.ruleId.startsWith("T")) {
      const n = this.lAdviseCount.get(h.ruleId) ?? 0;
      if (n >= 1) return base("skip", "L 级本地建议每条规则每会话最多 1 次");
      this.lAdviseCount.set(h.ruleId, n + 1);
    }
    this.markFired(h, e);
    this.lastAdviseByCategory.set(cat, this.s.steps.length);
    return base("advise", "L 级本地预设建议", { message: h.message, applied: this.modeApplies("advise") });
  }

  private async hardLevel(e: Event, h: Hit, judge: JudgeFn | undefined, base: (a: Action, r: string, x?: Partial<Decision>) => Decision): Promise<Decision> {
    // H 只能在 pre 上拦截；不是 pre 就降级为 M 处理
    if (!(h.blockable && h.phase === "pre")) {
      const m = await this.judgeBatch(e, [{ ...h, sev: "M" }], judge);
      return m[0];
    }
    const capped = isCountRule(h.ruleId) && !h.explicit;
    const capNow = capped && this.consecutiveBlocks >= this.cfg.budgets.max_consecutive_blocks;
    const verified = h.verified === true;
    const gateOk = verified || !!this.opts.trustInferredUnchanged;
    // 之前已经对同一个调用做过「拦截」判断（含 judge 的判断）：沿用，不再重复问 judge、不烧预算
    if (gateOk && !capNow && this.blockStillValid(h, e)) {
      return {
        hit: h,
        action: "block",
        reason: "沿用此前对同一调用的拦截判断（指纹已复核）",
        message: h.message,
        applied: this.modeApplies("block"),
        wouldBlockIfVerified: !verified,
        counted: capped,
      };
    }
    // 放行类结局（降级 advise、judge 放行）之后的冷却：10 步或 5 分钟内同一指纹不再重复提示，调用直接放行
    if (this.cooledDown(h, e)) return base("skip", "同规则同指纹冷却中（此前已放行/降级）");
    if (capNow) {
      this.markFired(h, e);
      return base("advise", `连续拦截已达上限（${this.cfg.budgets.max_consecutive_blocks}），降级为 advise`, { message: h.message, applied: this.modeApplies("advise") });
    }
    // 拦截前必须确认工作区指纹：L1/T1 只有「核实过没改动」才允许按规则拦截
    if (!gateOk) {
      this.markFired(h, e);
      return base("advise", "工作区指纹未核实（非 git/超时/无指纹），只给建议", { message: h.message, wouldBlockIfVerified: true, applied: this.modeApplies("advise") });
    }
    // 同步问 judge（≤15 秒）
    let jr: JudgeResult | undefined;
    if (judge && this.judgeCalls < this.cfg.budgets.judge_calls_per_session) {
      this.judgeCalls++;
      this.lastJudgeTs = e.ts;
      jr = await judge({ hits: [h], sync: true, session: this.s });
      this.judgeLog.push({ ruleId: h.ruleId, result: jr.kind, model: jr.model, verdict: jr.kind === "ok" ? jr.out.verdict : undefined, sync: true });
    }
    const jsum = jr ? { kind: jr.kind, verdict: jr.kind === "ok" ? jr.out.verdict : undefined, confidence: jr.kind === "ok" ? jr.out.confidence : undefined, model: jr.model } : undefined;
    const doBlock = (reason: string): Decision => {
      // block 不写冷却记录（否则重试会被放行，且上限触发后降级出来的 advise 也会被它挡掉）；只缓存判断结果
      this.blockedAt.set(h.key, { stepCount: this.s.steps.length, ts: e.ts });
      return base("block", reason, { message: h.message, judge: jsum, applied: this.modeApplies("block"), wouldBlockIfVerified: !verified, counted: capped });
    };
    if (jr && jr.kind === "ok") {
      if (jr.out.verdict === "ignore") {
        this.markFired(h, e);
        return base("ignore", "judge 判 ignore，放行", { judge: jsum });
      }
      if (jr.out.verdict === "advise") {
        this.markFired(h, e);
        const f = filterJudgeMessage(jr.out.message_to_agent, h.message ?? "");
        return base("advise", "judge 判 advise，放行并附建议", { message: f.text, judge: jsum, applied: this.modeApplies("advise") });
      }
      return doBlock("judge 判 block");
    }
    // judge 关闭、超时、出错或解析失败：L1/T1 能用确定性条件复核，按规则默认动作（拦截）
    if (h.ruleId === "L1" || h.ruleId === "T1") return doBlock(jr ? `judge ${jr.kind}，按规则默认动作拦截（指纹已复核）` : "judge 关闭，按规则默认动作拦截（指纹已复核）");
    this.markFired(h, e);
    return base("advise", `judge ${jr?.kind ?? "off"}，其余 H 候选降级为 advise`, { message: h.message, judge: jsum, applied: this.modeApplies("advise") });
  }

  private async judgeBatch(e: Event, hits: Hit[], judge: JudgeFn | undefined): Promise<Decision[]> {
    const mk = (h: Hit, action: Action, reason: string, extra: Partial<Decision> = {}): Decision => ({ hit: h, action, reason, applied: false, ...extra });
    if (!judge) return hits.map((h) => mk(h, "judge_off", "M 级：judge 关闭，记录为待判断"));
    const out: Decision[] = [];
    // 按 category 合并
    const byCat = new Map<string, Hit[]>();
    for (const h of hits) byCat.set(h.category, [...(byCat.get(h.category) ?? []), h]);
    for (const [cat, group] of byCat) {
      const lead = group[0];
      const rest = group.slice(1);
      const lastCat = this.lastJudgeByCategory.get(cat);
      if (lastCat !== undefined && e.ts - lastCat < 5000) {
        out.push(...group.map((h) => mk(h, "skip", "5 秒内同类命中合并到上一次 judge 调用")));
        continue;
      }
      if (this.judgeCalls >= this.cfg.budgets.judge_calls_per_session) {
        out.push(...group.map((h) => mk(h, "skip", "本会话 judge 调用次数已用完")));
        continue;
      }
      if (e.ts - this.lastJudgeTs < this.cfg.budgets.judge_cooldown_s * 1000) {
        out.push(...group.map((h) => mk(h, "skip", "两次 judge 之间冷却中")));
        continue;
      }
      if (this.paused && (lead.ruleId === "R4" || lead.ruleId === "P4")) {
        out.push(...group.map((h) => mk(h, "skip", "judge done=true，暂停 R4/P4 抽查")));
        continue;
      }
      this.judgeCalls++;
      this.lastJudgeTs = e.ts;
      this.lastJudgeByCategory.set(cat, e.ts);
      if (lead.ruleId !== "R4" && lead.ruleId !== "P4") this.paused = false;
      const jr = await judge({ hits: group, sync: false, session: this.s });
      this.judgeLog.push({ ruleId: lead.ruleId, result: jr.kind, model: jr.model, verdict: jr.kind === "ok" ? jr.out.verdict : undefined });
      const jsum = { kind: jr.kind, verdict: jr.kind === "ok" ? jr.out.verdict : undefined, confidence: jr.kind === "ok" ? jr.out.confidence : undefined, model: jr.model };
      for (const h of rest) out.push(mk(h, "skip", "与同类命中合并为一次 judge 调用", { judge: jsum }));
      this.markFired(lead, e);
      if (jr.kind === "timeout" || jr.kind === "error") {
        // fail-open：放行并记录
        out.push(mk(lead, "skip", `judge ${jr.kind}，fail-open 放行`, { judge: jsum }));
        continue;
      }
      if (jr.kind === "parse_fail") {
        out.push(mk(lead, "ignore", "judge_parse_fail：当作 ignore", { judge: jsum }));
        continue;
      }
      const v = jr.out;
      if (v.done) this.paused = true;
      this.adapt(lead.ruleId, v.verdict, v.confidence);
      if (v.verdict === "ignore") {
        out.push(mk(lead, "ignore", "judge 判 ignore", { judge: jsum }));
        continue;
      }
      const f = filterJudgeMessage(v.message_to_agent, lead.message ?? "");
      const isX = lead.ruleId.startsWith("X");
      if (v.verdict === "block" && v.confidence >= this.cfg.judge.block_confidence && !isX && lead.category !== "unsafe") {
        const capped = this.consecutiveBlocks >= this.cfg.budgets.max_consecutive_blocks;
        if (!capped) {
          out.push(mk(lead, "block", "judge 判 block 且置信度达标", { message: f.text, judge: jsum, applied: this.modeApplies("block"), atNextPre: lead.phase !== "pre", counted: lead.phase === "pre" }));
          continue;
        }
      }
      // 其余情况：block 降级为 advise；P3 走 Stop 续跑（≤2）
      if (lead.ruleId === "P3") {
        if (this.stopContinues < this.cfg.budgets.max_stop_continues) {
          this.stopContinues++;
          out.push(mk(lead, "stop_continue", "P3：Stop 阶段让 agent 继续（每会话最多 2 次）", { message: f.text, judge: jsum, applied: this.modeApplies("block") }));
        } else out.push(mk(lead, "advise", "P3：Stop 续跑次数已用完，降级为 advise", { message: f.text, judge: jsum, applied: this.modeApplies("advise") }));
        continue;
      }
      const lastAdv = this.lastAdviseByCategory.get(cat);
      if (lastAdv !== undefined && this.s.steps.length - lastAdv < 10) {
        out.push(mk(lead, "skip", "同 category 10 步内不重复", { judge: jsum }));
        continue;
      }
      this.lastAdviseByCategory.set(cat, this.s.steps.length);
      out.push(mk(lead, "advise", v.verdict === "block" ? "judge 判 block，但置信度不足或受上限约束，降级为 advise" : "judge 判 advise", { message: f.text, judge: jsum, applied: this.modeApplies("advise") }));
    }
    return out;
  }

  /** §5.7 自适应：同一规则连续 3 次 ignore → 阈值 ×2；block/高置信 advise → R4 间隔减半 10 步。 */
  private adapt(ruleId: string, verdict: string, confidence: number): void {
    if (verdict === "ignore") {
      const n = (this.ignoreStreak.get(ruleId) ?? 0) + 1;
      this.ignoreStreak.set(ruleId, n);
      if (n >= 3) {
        this.s.scale.set(ruleId, (this.s.scale.get(ruleId) ?? 1) * 2);
        this.ignoreStreak.set(ruleId, 0);
      }
    } else {
      this.ignoreStreak.set(ruleId, 0);
      if (verdict === "block" || confidence >= 0.85) this.r4BoostUntilStep = this.s.steps.length + 10;
    }
  }
}
