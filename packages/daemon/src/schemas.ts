// GET /v1/schema/{name}：带版本号的 JSON Schema（frontend-design §9.2，Go 侧由它生成结构体）。
// 约定：协议加字段只增不删，所以对象一律 additionalProperties: true（新字段不会让旧客户端校验失败）；
// required 只列「永远存在」的字段；可空字段写成 type: [..., "null"]。
// 守护进程的真实响应在 test/schemas.test.ts 里按这些 Schema 校验，防止 TS 与 Schema 漂移。

export const SCHEMA_VERSION = "v1";

type S = Record<string, unknown>;
const str: S = { type: "string" };
const int: S = { type: "integer" };
const num: S = { type: "number" };
const bool: S = { type: "boolean" };
const nul = (s: S): S => ({ ...s, type: [s.type as string, "null"] });
const arr = (items: S): S => ({ type: "array", items });
const en = (...values: string[]): S => ({ type: "string", enum: values });
const nulEn = (...values: string[]): S => ({ type: ["string", "null"], enum: [...values, null] });
const obj = (properties: Record<string, S>, required: string[] = Object.keys(properties)): S => ({ type: "object", properties, required, additionalProperties: true });
const rec = (valueType: S): S => ({ type: "object", additionalProperties: valueType });

const Decision = obj({
  id: int,
  action: en("ignore", "advise", "block", "ask", "stop_continue"),
  applied: bool,
  mode: nul(str),
  outcome: nulEn("blocked", "would_have_blocked", "asked", "would_have_asked", "continued", "would_have_continued", "advised", "would_have_advised"),
  suppressedBy: nul(str),
  wouldBlockIfVerified: bool,
  atNextPre: bool,
  message: nul(str),
});

const TimelineCall = obj(
  { type: en("call"), seq: int, postSeq: nul(int), ts: int, toolUseId: nul(str), tool: nul(str), kind: nul(str), cmdClass: nul(str), normCmd: nul(str), mutating: nul(bool), status: en("ok", "fail", "unknown", "pending"), exitCode: nul(int), errFp: nul(str), model: nul(str) },
);
const TimelineEvent = obj({ type: en("event"), seq: int, ts: int, phase: str, origin: nul(str), model: nul(str) });
const TimelineHit = obj({
  type: en("hit"),
  seq: int,
  ts: int,
  hitId: int,
  ruleId: str,
  sev: en("L", "M", "H"),
  severity: nulEn("low", "medium", "high", "dangerous"),
  dangerous: bool,
  dangerCategory: nul(str),
  dangerSubject: nul(str),
  dangerReason: nul(str),
  category: nul(str),
  phase: nul(str),
  callIndex: nul(int),
  message: nul(str),
  observeOnly: bool,
  decisions: arr({ $ref: "#/$defs/Decision" }),
  outcome: nul(str),
  applied: bool,
});
const TimelineEntry: S = { oneOf: [{ $ref: "#/$defs/TimelineCall" }, { $ref: "#/$defs/TimelineEvent" }, { $ref: "#/$defs/TimelineHit" }] };

const Hit = obj({
  id: int,
  runId: int,
  sessionId: str,
  seq: int,
  ts: int,
  ruleId: str,
  sev: en("L", "M", "H"),
  severity: nulEn("low", "medium", "high", "dangerous"),
  dangerous: bool,
  category: nul(str),
  phase: nul(str),
  message: nul(str),
  model: nul(str),
  action: nul(str),
  outcome: nul(str),
  applied: bool,
  label: nulEn("false_positive", "useful"),
});

const danger = obj({ total: int, wouldHaveBlocked: int, enforced: int });
const SessionSummary = obj(
  { run_id: int, session_id: str, harness: nul(str), model: nul(str), project: nul(str), calls: nul(int), hits_L: int, hits_M: int, hits_H: int, alarms: int, dangerous: int, would_have_blocked: int, blocked: int, judge_calls: int, danger, first_ts: nul(int), last_ts: nul(int), events: int, state: en("active", "idle", "ended") },
  ["run_id", "session_id", "harness", "model", "project", "calls", "hits_L", "hits_M", "hits_H", "alarms", "dangerous", "would_have_blocked", "blocked", "judge_calls", "danger", "events", "state"],
);
const DangerEvent = obj({ hitId: int, runId: int, sessionId: str, ts: int, callIndex: nul(int), category: nul(str), subject: nul(str), reason: nul(str), action: nul(str), outcome: nul(str), mode: nul(str), model: nul(str) });
const DangerStats = obj({
  total: int,
  enforced: int,
  wouldHaveBlocked: int,
  byCategory: rec(int),
  byOutcome: rec(int),
  bySession: arr(obj({ runId: int, sessionId: str, dangerous: int, wouldHaveBlocked: int, enforced: int })),
});
const RuleStat = obj({ rule: str, hits: int, sessions: int, hitsPer100Calls: nul(num), sessionRate: nul(num), bySev: rec(int), actions: rec(int), outcomes: rec(int), suppressed: rec(int), applied: int, labeledFp: int, labeledUseful: int, fpRate: nul(num), delivered: int, complied: int, notComplied: int, complianceRate: nul(num) });
const Run = obj({ id: int, kind: en("live", "replay", "eval"), label: nul(str), source: nul(str), mode: nul(str), judge_mode: nul(str), thresholds_hash: nul(str), overrides_json: nul(str), started_ts: int, ended_ts: nul(int), sessions: int, hits: int }, ["id", "kind", "started_ts", "sessions", "hits"]);
const Status = obj({ protocol: int, version: str, mode: en("shadow", "advise", "enforce"), startedAt: int, runId: int, db: str, sessions: int, outbox: rec(int), adapterFailures15m: rec(int), judge: obj({ enabled: bool, base_url: str, model: str }, ["enabled"]) }, ["protocol", "version", "mode", "startedAt", "runId", "sessions", "adapterFailures15m"]);
const Delivery = obj({ kind: en("block", "ask", "advise", "stop_continue"), text: str, deliveryId: str, ruleId: str, createdAtSeq: int }, ["kind", "text"]);
const StreamMessage = obj(
  { streamId: str, type: en("session", "event", "hit", "decision", "delivery", "status", "heartbeat", "reset"), ts: int, sessionId: str, harness: str, runId: int, seq: int, phase: str, tool: str, status: str, model: str, ruleId: str, sev: str, category: str, dangerous: bool, action: str, applied: bool, outcome: nul(str), deliveryId: str, kind: str, hookPoint: str, mode: str, sessions: int, reason: str },
  ["streamId", "type", "ts"],
);
const Timeline = obj({ runId: int, entries: arr({ $ref: "#/$defs/TimelineEntry" }), hasMore: bool });

const JudgeCall = obj({
  id: int,
  runId: int,
  sessionId: str,
  harness: nul(str),
  ts: int,
  ruleIds: arr(str),
  sync: bool,
  routeModel: nul(str),
  model: nul(str),
  status: str,
  verdict: nul(str),
  confidence: nul(num),
  category: nul(str),
  latencyMs: nul(num),
  promptTokens: nul(num),
  completionTokens: nul(num),
  cachedTokens: nul(num),
  costUsd: nul(num),
  retries: nul(num),
  formatDowngraded: bool,
  error: nul(str),
});
const JudgeCallList = obj({
  calls: arr({ $ref: "#/$defs/JudgeCall" }),
  nextCursor: nul(int),
  totals: obj({ calls: int, ok: int, failed: int, parseFail: int, promptTokens: num, completionTokens: num, cachedTokens: num, costUsd: nul(num), latencyP50: nul(num), latencyP95: nul(num) }),
});
const JudgeCallDetail = obj(
  { ...(JudgeCall.properties as Record<string, S>), reason: nul(str), messageRaw: nul(str), httpRequests: nul(num), formatLevel: nul(str), repairs: arr(str), request: { type: ["object", "null"] }, response: { type: ["object", "null"] }, bodiesStored: bool, hits: arr({ type: "object" }), decisions: arr({ type: "object" }), deliveries: arr({ type: "object" }) },
  ["id", "repairs", "bodiesStored", "hits", "decisions", "deliveries"],
);

const Rule = obj(
  { id: str, title: str, category: str, level: en("L", "M", "H", "M→H", "L→M", "observe"), source: str, observeOnly: bool, thresholds: { type: "object" }, override: nul({ type: "object" }), disabled: bool, edited: bool, protected: bool },
  ["id", "title", "category", "level", "thresholds", "override", "disabled", "edited", "protected"],
);
const RuleList = obj({ rules: arr({ $ref: "#/$defs/Rule" }), mode: en("shadow", "advise", "enforce") });
const ConfigView = obj({ config: { type: "object" }, judge: obj({ api_key_env: str, api_key_set: bool }), sources: rec(en("default", "configured", "rules.local")), source: en("daemon-startup") });
const ConfigValidation = obj({ valid: bool, errors: arr(str), warnings: arr(str), diff: arr(obj({ path: str, from: {}, to: {} }, ["path"])), enablesBlocking: bool });

const RunDetail = obj({
  id: int,
  kind: en("live", "replay", "eval"),
  label: nul(str),
  source: nul(str),
  mode: nul(str),
  judge_mode: nul(str),
  version: nul(str),
  thresholds_hash: nul(str),
  started_ts: int,
  ended_ts: nul(int),
  tuning: { type: ["object", "null"] },
  overrides: arr(str),
  sessions: int,
  calls: int,
  hits: int,
  judge_calls: int,
});

const DEFS: Record<string, S> = { RunDetail, Rule, RuleList, ConfigView, ConfigValidation, Decision, TimelineCall, TimelineEvent, TimelineHit, TimelineEntry, Hit, SessionSummary, DangerEvent, DangerStats, RuleStat, Run, Status, Delivery, StreamMessage, Timeline, JudgeCall, JudgeCallList, JudgeCallDetail };
export const SCHEMA_NAMES = Object.keys(DEFS).filter((n) => !["TimelineCall", "TimelineEvent", "TimelineHit"].includes(n));

/** 返回自包含的 Schema（$defs 里带上所有定义，$ref 就地可解析）；未知名字返回 null。 */
export function schemaFor(name: string): S | null {
  const s = DEFS[name];
  if (!s) return null;
  return { $schema: "https://json-schema.org/draft/2020-12/schema", $id: `sv/${SCHEMA_VERSION}/${name}`, title: name, ...s, $defs: DEFS };
}
