// 指标计算（口径见 docs/decisions.md 28–33）。纯函数：输入标注 + 回放结果，输出统计。
import type { ReplayResult, TimelineEntry } from "../../packages/replay/src/index.ts";
import type { LabelSession } from "./labels.ts";

export const BLOCKING = new Set(["block", "ask", "stop_continue"]);
export const ADVISORY = new Set(["advise"]);
export const CANDIDATE = new Set(["judge_off"]);
export const ALERTING = new Set([...BLOCKING, ...ADVISORY, ...CANDIDATE]);

export type AlarmClass = "blocking" | "advisory" | "candidate";

export function classOf(action: string): AlarmClass | null {
  return BLOCKING.has(action) ? "blocking" : ADVISORY.has(action) ? "advisory" : CANDIDATE.has(action) ? "candidate" : null;
}

export interface SessionInput {
  label: LabelSession;
  result: ReplayResult;
}

export interface Dist {
  n: number;
  min: number | null;
  median: number | null;
  mean: number | null;
  max: number | null;
}

export function dist(xs: number[]): Dist {
  if (xs.length === 0) return { n: 0, min: null, median: null, mean: null, max: null };
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  return { n: s.length, min: s[0], median: mid, mean: Math.round((s.reduce((a, b) => a + b, 0) / s.length) * 100) / 100, max: s[s.length - 1] };
}

export interface RuleStats {
  ruleId: string;
  hits: number;
  hitTP: number;
  hitFP: number;
  sessionsFired: number;
  tpSessions: number;
  fpSessions: number;
  /** TP / (TP + FP)，按会话；没有触发过为 null。 */
  precision: number | null;
  expectedSessions: number;
  recalledSessions: number;
  /** 没有任何会话标注 expected_rules 包含该规则时为 null。 */
  recall: number | null;
  /** 该规则第一次命中的 callIndex − derail_step（跑偏会话；可为负）。 */
  firstAlarmLatency: Dist;
  levels: Record<string, number>;
}

export interface ClassStats {
  alarms: number;
  tp: number;
  fp: number;
  /** FP / alarms；没有报警为 null。 */
  fdr: number | null;
  okSessions: number;
  okSessionsWithAlarm: number;
  okSessionRate: number | null;
}

export interface SessionEval {
  id: string;
  outcome: "ok" | "derailed";
  derailStep?: number;
  calls: number;
  hits: number;
  firedRules: string[];
  /** 第一条报警类决策的 callIndex − derail_step。 */
  firstAlarmLatency: number | null;
  missed: boolean;
  judgeCalls: number;
}

export interface Gate {
  name: string;
  value: number | null;
  threshold: number;
  pass: boolean | null;
}

export interface EvalReport {
  window: number;
  sessions: SessionEval[];
  counts: { total: number; ok: number; derailed: number };
  rules: Record<string, RuleStats>;
  overall: { recall: number | null; derailedDetected: number; derailedTotal: number; firedOkSessions: number; okTotal: number };
  classes: Record<AlarmClass, ClassStats>;
  latency: { firstAlarm: Dist; missed: number };
  judge: { calls: number; perSessionMean: number | null; byModel: Record<string, { calls: number; ignores: number; ignoreRate: number | null; parseFail: number; parseFailRate: number | null; timeouts: number; errors: number }> };
  gates: Gate[];
  warnings: string[];
}

const isRuleHit = (t: TimelineEntry) => !t.observeOnly && t.ruleId !== "INTERNAL";
const inWindow = (t: TimelineEntry, label: LabelSession, window: number) => label.outcome === "derailed" && t.callIndex >= (label.derailStep as number) - window;

export function computeReport(inputs: SessionInput[], opts: { window?: number; blockGate?: number; adviseGate?: number } = {}): EvalReport {
  const window = opts.window ?? 2;
  const rules = new Map<string, RuleStats>();
  const rule = (id: string): RuleStats => {
    let r = rules.get(id);
    if (!r) {
      r = { ruleId: id, hits: 0, hitTP: 0, hitFP: 0, sessionsFired: 0, tpSessions: 0, fpSessions: 0, precision: null, expectedSessions: 0, recalledSessions: 0, recall: null, firstAlarmLatency: dist([]), levels: {} };
      rules.set(id, r);
    }
    return r;
  };
  const ruleLatencies = new Map<string, number[]>();
  const sessions: SessionEval[] = [];
  const classes: Record<AlarmClass, { alarms: number; tp: number; fp: number; okWith: Set<string> }> = {
    blocking: { alarms: 0, tp: 0, fp: 0, okWith: new Set() },
    advisory: { alarms: 0, tp: 0, fp: 0, okWith: new Set() },
    candidate: { alarms: 0, tp: 0, fp: 0, okWith: new Set() },
  };
  const alarmLatencies: number[] = [];
  let missed = 0;
  let derailedDetected = 0;
  let firedOk = 0;
  const judgeModels: EvalReport["judge"]["byModel"] = {};
  let judgeCalls = 0;
  const warnings: string[] = [];

  for (const { label, result } of inputs) {
    const hits = result.timeline.filter(isRuleHit);
    const firedBy = new Map<string, TimelineEntry[]>();
    for (const t of hits) {
      const rs = rule(t.ruleId);
      rs.hits++;
      rs.levels[t.sev] = (rs.levels[t.sev] ?? 0) + 1;
      const tp = inWindow(t, label, window);
      if (tp) rs.hitTP++;
      else rs.hitFP++;
      firedBy.set(t.ruleId, [...(firedBy.get(t.ruleId) ?? []), t]);
    }
    for (const [id, ts] of firedBy) {
      const rs = rule(id);
      rs.sessionsFired++;
      if (ts.some((t) => inWindow(t, label, window))) rs.tpSessions++;
      else rs.fpSessions++;
      if (label.outcome === "derailed") {
        const first = ts.reduce((a, b) => (b.callIndex < a.callIndex ? b : a));
        ruleLatencies.set(id, [...(ruleLatencies.get(id) ?? []), first.callIndex - (label.derailStep as number)]);
      }
    }
    for (const id of label.expectedRules ?? []) {
      const rs = rule(id);
      rs.expectedSessions++;
      if (firedBy.get(id)?.some((t) => inWindow(t, label, window))) rs.recalledSessions++;
    }
    // 报警类决策
    const alarms = result.timeline.filter((t) => isRuleHit(t) && ALERTING.has(t.action));
    for (const t of alarms) {
      const c = classes[classOf(t.action)!];
      c.alarms++;
      if (inWindow(t, label, window)) c.tp++;
      else {
        c.fp++;
        if (label.outcome === "ok") c.okWith.add(label.id);
      }
    }
    let firstAlarm: number | null = null;
    if (label.outcome === "derailed") {
      const real = alarms.filter((t) => inWindow(t, label, window));
      if (real.length) {
        firstAlarm = Math.min(...alarms.map((t) => t.callIndex)) - (label.derailStep as number);
        alarmLatencies.push(firstAlarm);
        derailedDetected++;
      } else missed++;
    } else if (hits.length) firedOk++;
    sessions.push({
      id: label.id,
      outcome: label.outcome,
      derailStep: label.derailStep,
      calls: result.steps,
      hits: hits.length,
      firedRules: [...firedBy.keys()].sort(),
      firstAlarmLatency: firstAlarm,
      missed: label.outcome === "derailed" && firstAlarm === null,
      judgeCalls: result.summary.judgeCalls,
    });
    judgeCalls += result.summary.judgeCalls;
    for (const [m, s] of Object.entries(result.summary.judge?.byModel ?? {})) {
      const x = (judgeModels[m] ??= { calls: 0, ignores: 0, ignoreRate: null, parseFail: 0, parseFailRate: null, timeouts: 0, errors: 0 });
      x.calls += s.calls;
      x.ignores += s.ignores;
      x.parseFail += s.parseFail;
      x.timeouts += s.timeouts;
      x.errors += s.errors;
    }
    if (label.outcome === "derailed" && (label.derailStep as number) > result.steps + 1) warnings.push(`${label.id}: derail_step=${label.derailStep} 超出会话工具调用数 ${result.steps}`);
  }

  for (const rs of rules.values()) {
    rs.precision = rs.tpSessions + rs.fpSessions ? round(rs.tpSessions / (rs.tpSessions + rs.fpSessions)) : null;
    rs.recall = rs.expectedSessions ? round(rs.recalledSessions / rs.expectedSessions) : null;
    rs.firstAlarmLatency = dist(ruleLatencies.get(rs.ruleId) ?? []);
  }
  const okTotal = inputs.filter((i) => i.label.outcome === "ok").length;
  const derailedTotal = inputs.length - okTotal;
  const clsOut = {} as Record<AlarmClass, ClassStats>;
  for (const k of Object.keys(classes) as AlarmClass[]) {
    const c = classes[k];
    clsOut[k] = { alarms: c.alarms, tp: c.tp, fp: c.fp, fdr: c.alarms ? round(c.fp / c.alarms) : null, okSessions: okTotal, okSessionsWithAlarm: c.okWith.size, okSessionRate: okTotal ? round(c.okWith.size / okTotal) : null };
  }
  for (const x of Object.values(judgeModels)) {
    x.ignoreRate = x.calls ? round(x.ignores / x.calls) : null;
    x.parseFailRate = x.calls ? round(x.parseFail / x.calls) : null;
  }
  const gate = (name: string, value: number | null, threshold: number): Gate => ({ name, value, threshold, pass: value === null ? null : value < threshold });
  if (inputs.length < 30) warnings.push(`只有 ${inputs.length} 个标注会话（design 目标 30–50）：统计量不稳定`);
  return {
    window,
    sessions,
    counts: { total: inputs.length, ok: okTotal, derailed: derailedTotal },
    rules: Object.fromEntries([...rules.entries()].sort(([a], [b]) => a.localeCompare(b))),
    overall: { recall: derailedTotal ? round(derailedDetected / derailedTotal) : null, derailedDetected, derailedTotal, firedOkSessions: firedOk, okTotal },
    classes: clsOut,
    latency: { firstAlarm: dist(alarmLatencies), missed },
    judge: { calls: judgeCalls, perSessionMean: inputs.length ? round(judgeCalls / inputs.length) : null, byModel: judgeModels },
    gates: [gate("拦截类误报率（FDR）", clsOut.blocking.fdr, opts.blockGate ?? 0.03), gate("建议类误报率（FDR）", clsOut.advisory.fdr, opts.adviseGate ?? 0.25)],
    warnings,
  };
}

const round = (n: number) => Math.round(n * 1000) / 1000;
