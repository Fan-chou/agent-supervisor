// 引擎 → 日志库的桥：每处理一条事件，把事件、命中（含阈值）、judge 调用、决策、投递、用户覆盖写入 SQLite。
import type { Config } from "../config.ts";
import { thresholdsForRule } from "../config.ts";
import type { Hit } from "../detectors/types.ts";
import type { Event } from "../event.ts";
import type { JudgeRequest, JudgeResult } from "../judge/types.ts";
import type { Decision } from "../policy.ts";
import type { SessionTracker } from "../session.ts";
import { canonicalJson, shortHash } from "../hash.ts";
import { LogStore } from "./store.ts";

/** 开始一次运行：记录当时生效的阈值（及其哈希）、预算、模式、命令行覆盖，供之后按阈值对比。 */
export function beginRun(store: LogStore, cfg: Config, o: { kind: "live" | "replay" | "eval"; label?: string; source?: string; judgeMode?: string; overrides?: string[]; version?: string; ts?: number }): number {
  const tuning = { thresholds: cfg.thresholds, budgets: cfg.budgets, detect: cfg.detect, rules: cfg.rules };
  return store.startRun({
    kind: o.kind,
    label: o.label,
    source: o.source,
    mode: cfg.mode,
    judgeMode: o.judgeMode,
    thresholds: tuning,
    thresholdsHash: shortHash(canonicalJson(tuning)),
    overrides: o.overrides,
    version: o.version,
    ts: o.ts,
  });
}

export interface JudgeCallRecord {
  req: JudgeRequest;
  result: JudgeResult;
  ts: number;
}

export interface FeedInfo {
  event: Event;
  hits: Hit[];
  decisions: Decision[];
  judgeCalls: JudgeCallRecord[];
  tracker: SessionTracker;
  cfg: Config;
}

export interface LogSink {
  onFeed(info: FeedInfo): void;
  close(): void;
}

export interface StoreSinkOptions {
  runId: number;
  /** 投递通道名前缀：回放里是 "replay"，线上是空。 */
  channelPrefix?: string;
  sourceFile?: string;
  /** 是否在 close 时结束 run。 */
  endRunOnClose?: boolean;
}

interface Watch {
  kind: "argsHash" | "cls";
  value: string;
}
interface Pending {
  deliveryId: number;
  watch: Watch;
  seen: number;
}

const NUMERIC_DETAIL = (d: Record<string, unknown> | undefined) => {
  const o: Record<string, number> = {};
  for (const [k, v] of Object.entries(d ?? {})) if (typeof v === "number") o[k] = v;
  return o;
};

/** 被建议/拦截之后，接下来 N 次调用里 agent 有没有继续做同一件事。 */
const COMPLIANCE_WINDOW = 3;

function watchOf(h: Hit, e: Event): Watch | null {
  switch (h.ruleId) {
    case "L1":
    case "L2":
    case "L3":
    case "T1":
    case "T6":
      return e.tool ? { kind: "argsHash", value: e.tool.argsHash } : null;
    case "T2":
      return { kind: "cls", value: "test_full" };
    case "T4":
      return { kind: "cls", value: "probe" };
    case "T5":
      return { kind: "cls", value: "smoke_script" };
    default:
      return null;
  }
}

export class StoreSink implements LogSink {
  private pending: Pending[] = [];
  private lastSilenced = "none";
  private started = new Set<string>();
  private readonly prefix: string;

  constructor(readonly store: LogStore, private readonly o: StoreSinkOptions) {
    this.prefix = o.channelPrefix ? o.channelPrefix + ":" : "";
  }

  get runId(): number {
    return this.o.runId;
  }

  private channelOf(e: Event): string {
    return this.prefix + (e.phase === "pre" ? "PreToolUse" : e.phase === "stop" ? "Stop" : "PostToolBatch");
  }

  onFeed(info: FeedInfo): void {
    const { event: e, hits, decisions, judgeCalls, tracker, cfg } = info;
    const runId = this.o.runId;
    this.store.transaction(() => {
      if (!this.started.has(e.sessionId) || e.phase === "session") {
        this.started.add(e.sessionId);
        this.store.upsertSession(runId, { sessionId: e.sessionId, harness: e.harness, model: tracker.model ?? e.model, cwd: tracker.cwd ?? e.cwd, sourceFile: this.o.sourceFile, ts: e.ts });
      } else if (e.model && e.model !== undefined) {
        this.store.upsertSession(runId, { sessionId: e.sessionId, model: e.model, cwd: tracker.cwd });
      }
      this.store.insertEvent(runId, e);

      // 先处理上一批投递的遵从情况：本事件若是一次调用，就是「之后的调用」
      this.advanceCompliance(e);

      const callIdByHit = new Map<Hit, number>();
      const callIds: number[] = [];
      for (const jc of judgeCalls) {
        const r = jc.result;
        const meta = r.meta ?? {};
        const out = r.kind === "ok" ? r.out : undefined;
        const id = this.store.insertJudgeCall(runId, {
          sessionId: e.sessionId,
          ts: jc.ts,
          ruleIds: jc.req.hits.map((h) => h.ruleId),
          sync: jc.req.sync,
          routeModel: meta.routeModel,
          model: r.model,
          status: r.kind,
          verdict: out?.verdict,
          confidence: out?.confidence,
          category: out?.category,
          messageRaw: out?.message_to_agent,
          reason: out?.reason,
          latencyMs: meta.latencyMs,
          promptTokens: meta.promptTokens,
          completionTokens: meta.completionTokens,
          cachedTokens: meta.cachedTokens,
          costUsd: meta.costUsd,
          retries: meta.retries,
          httpRequests: meta.httpRequests,
          formatLevel: meta.formatLevel,
          formatDowngraded: meta.formatDowngraded,
          repairs: meta.repairs,
          error: r.kind === "error" ? r.error : r.kind === "timeout" ? "timeout" : r.kind === "parse_fail" ? "parse_fail" : undefined,
          request: meta.requestBody,
          response: meta.responseBody ?? (out ? JSON.stringify(out) : undefined),
        });
        callIds.push(id);
        for (const h of jc.req.hits) callIdByHit.set(h, id);
      }

      const hitIds = new Map<Hit, number>();
      const callIndex = tracker.steps.length + (e.phase === "pre" ? 1 : 0);
      for (const h of hits) {
        const id = this.store.insertHit(runId, {
          sessionId: h.sessionId,
          seq: h.seq,
          ts: h.ts,
          callIndex: Math.max(callIndex, 1),
          ruleId: h.ruleId,
          sev: h.sev,
          category: h.category,
          phase: h.phase,
          key: h.key,
          evidence: h.evidence,
          observed: NUMERIC_DETAIL(h.detail),
          threshold: { ...thresholdsForRule(h.ruleId, cfg), scale: tracker.scaleOf(h.ruleId) },
          detail: h.detail,
          message: h.message,
          verified: h.verified,
          observeOnly: h.observeOnly,
          blockable: h.blockable,
          explicit: h.explicit,
          model: tracker.model ?? e.model,
          // X2 危险操作：不论 mode 都记为 dangerous，含类别 / 对象 / 原因
          ...(h.ruleId === "X2"
            ? { severity: "dangerous", dangerCategory: String(h.detail?.category ?? h.x2?.category ?? ""), dangerSubject: String(h.detail?.subject ?? ""), dangerReason: h.message }
            : {}),
        });
        hitIds.set(h, id);
      }

      const newPending: Pending[] = [];
      for (const d of decisions) {
        let hitId = hitIds.get(d.hit);
        if (hitId === undefined) {
          // 降级路径里 policy 会克隆 hit（如 H→M）：按 rule+key+seq 回找
          const m = hits.find((h) => h.ruleId === d.hit.ruleId && h.key === d.hit.key && h.seq === d.hit.seq);
          hitId = m ? hitIds.get(m) : undefined;
        }
        if (hitId === undefined) continue;
        let jcId: number | undefined;
        for (const [h, id] of callIdByHit) if (h === d.hit || (h.ruleId === d.hit.ruleId && h.key === d.hit.key && h.seq === d.hit.seq)) jcId = id;
        const decId = this.store.insertDecision(runId, {
          sessionId: e.sessionId,
          hitId,
          judgeCallId: jcId,
          ts: e.ts,
          ruleId: d.hit.ruleId,
          action: d.action,
          applied: d.applied,
          mode: cfg.mode,
          reason: d.reason,
          suppressedBy: d.suppressedBy,
          message: d.message,
          wouldBlockIfVerified: d.wouldBlockIfVerified,
          atNextPre: d.atNextPre,
          counted: d.counted,
          outcome: d.outcome,
        });
        if (["advise", "block", "ask", "stop_continue"].includes(d.action)) {
          const watch = watchOf(d.hit, e);
          const delId = this.store.insertDelivery(runId, {
            sessionId: e.sessionId,
            decisionId: decId,
            ruleId: d.hit.ruleId,
            ts: e.ts,
            channel: this.channelOf(e),
            delivered: d.applied,
            deliveredTs: d.applied ? e.ts : undefined,
            expiredReason: d.applied ? undefined : `not_applied_in_mode_${cfg.mode}`,
            text: d.message ?? d.reason,
            watch,
          });
          if (watch && d.applied) newPending.push({ deliveryId: delId, watch, seen: 0 });
        }
      }
      this.pending.push(...newPending);

      // 用户覆盖：#sv off / #sv quiet
      if (tracker.silenced !== this.lastSilenced) {
        this.lastSilenced = tracker.silenced;
        if (tracker.silenced !== "none") this.store.insertOverride({ runId, sessionId: e.sessionId, ts: e.ts, kind: tracker.silenced === "off" ? "sv_off" : "sv_quiet", targetType: "session", actor: "user", note: "prompt 里的 #sv 指令" });
      }
      if (e.phase === "post") this.store.setSessionCalls(runId, e.sessionId, tracker.steps.length);
    });
  }

  private advanceCompliance(e: Event): void {
    if (e.phase !== "pre" || !e.tool || this.pending.length === 0) return;
    const cls = e.shell?.cls;
    const keep: Pending[] = [];
    for (const p of this.pending) {
      const hit = p.watch.kind === "argsHash" ? e.tool.argsHash === p.watch.value : cls === p.watch.value;
      if (hit) {
        this.store.setCompliance(p.deliveryId, false, `之后的调用里又出现了同样的${p.watch.kind === "argsHash" ? "调用" : "类别 " + p.watch.value}`);
        continue;
      }
      p.seen++;
      if (p.seen >= COMPLIANCE_WINDOW) this.store.setCompliance(p.deliveryId, true, `之后 ${COMPLIANCE_WINDOW} 次调用里没有重复`);
      else keep.push(p);
    }
    this.pending = keep;
  }

  close(): void {
    // 窗口还没走完的投递：遵从情况未知，保持 NULL，并写明原因
    for (const p of this.pending) this.store.setCompliance(p.deliveryId, null, "会话结束时观察窗口未走完");
    this.pending = [];
    if (this.o.endRunOnClose) this.store.endRun(this.o.runId);
  }
}
