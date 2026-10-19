// 前端用的只读查询（frontend-design §3、§12）：会话时间线、原始事件、命中列表、子 agent。
// 风格同 queries.ts：SQL 全部写在这里，方便审阅；只读，不改任何数据。
import type { Database } from "bun:sqlite";
import { _internal as qi, type Scope } from "./queries.ts";

const { where, q, LATEST_LABEL, pct } = qi;
const clampLimit = (n: number | undefined, def: number, max: number) => Math.max(1, Math.min(max, Math.floor(Number.isFinite(n) ? (n as number) : def)));

/** 会话所在的运行：显式给了就用它，否则取包含该会话的最新一次运行。 */
export function sessionRun(db: Database, sessionId: string, runId?: number): number | null {
  if (runId !== undefined) return (db.query("SELECT run_id FROM sessions WHERE run_id = ? AND session_id = ?").get(runId, sessionId) as { run_id: number } | null)?.run_id ?? null;
  return (db.query("SELECT MAX(run_id) AS r FROM sessions WHERE session_id = ?").get(sessionId) as { r: number | null } | null)?.r ?? null;
}

export interface TimelineDecision {
  id: number;
  action: string;
  applied: boolean;
  mode: string | null;
  outcome: string | null;
  suppressedBy: string | null;
  wouldBlockIfVerified: boolean;
  atNextPre: boolean;
  message: string | null;
}

export type TimelineEntry =
  | {
      type: "call";
      /** pre 的 seq（只有 post 的调用用 post 的 seq）。UI 用它作为主键：同一调用的 post 到达时会带着同一个 seq 再出现一次。 */
      seq: number;
      postSeq: number | null;
      ts: number;
      toolUseId: string | null;
      tool: string | null;
      kind: string | null;
      cmdClass: string | null;
      normCmd: string | null;
      mutating: boolean | null;
      /** ok / fail / unknown / pending；还没有 post 为 pending。 */
      status: string;
      exitCode: number | null;
      errFp: string | null;
      model: string | null;
    }
  | { type: "event"; seq: number; ts: number; phase: string; origin: string | null; model: string | null }
  | {
      type: "hit";
      seq: number;
      ts: number;
      hitId: number;
      ruleId: string;
      sev: string;
      severity: string | null;
      dangerous: boolean;
      dangerCategory: string | null;
      dangerSubject: string | null;
      dangerReason: string | null;
      category: string | null;
      phase: string | null;
      callIndex: number | null;
      message: string | null;
      observeOnly: boolean;
      decisions: TimelineDecision[];
      outcome: string | null;
      applied: boolean;
    };

export interface TimelineOpts {
  runId?: number;
  /** 只要 seq 大于它的（实时跟随）。 */
  sinceSeq?: number;
  /** 只要 seq 小于它的，并取最靠近它的 limit 条（向上翻页）。 */
  beforeSeq?: number;
  limit?: number;
  /** 给了 severity / outcome 就只返回满足条件的命中（不含调用与事件）。 */
  severity?: string;
  outcome?: string;
}

export interface Timeline {
  runId: number;
  entries: TimelineEntry[];
  /** 这个方向上还有没返回的条目。 */
  hasMore: boolean;
}

function decisionsOf(db: Database, hitIds: number[]): Map<number, TimelineDecision[]> {
  const out = new Map<number, TimelineDecision[]>();
  if (!hitIds.length) return out;
  const rows = q<Record<string, unknown>>(db, `SELECT * FROM decisions WHERE hit_id IN (${hitIds.map(() => "?").join(",")}) ORDER BY id`, hitIds);
  for (const d of rows) {
    const list = out.get(d.hit_id as number) ?? [];
    list.push({
      id: d.id as number,
      action: d.action as string,
      applied: d.applied === 1,
      mode: (d.mode as string) ?? null,
      outcome: (d.outcome as string) ?? null,
      suppressedBy: (d.suppressed_by as string) ?? null,
      wouldBlockIfVerified: d.would_block_if_verified === 1,
      atNextPre: d.at_next_pre === 1,
      message: (d.message as string) ?? null,
    });
    out.set(d.hit_id as number, list);
  }
  return out;
}

function callEntry(first: Record<string, unknown>, post: Record<string, unknown> | undefined): TimelineEntry {
  const res = post ?? (first.phase === "post" ? first : undefined);
  return {
    type: "call",
    seq: first.seq as number,
    postSeq: res ? (res.seq as number) : null,
    ts: first.ts as number,
    toolUseId: (first.tool_use_id as string) ?? null,
    tool: (first.tool_name as string) ?? null,
    kind: (first.tool_kind as string) ?? null,
    cmdClass: (first.cmd_class as string) ?? null,
    normCmd: (first.norm_cmd as string) ?? null,
    mutating: first.mutating === null || first.mutating === undefined ? null : first.mutating === 1,
    status: res ? ((res.status as string) ?? "unknown") : "pending",
    exitCode: res ? ((res.exit_code as number) ?? null) : null,
    errFp: res ? ((res.err_fp as string) ?? null) : null,
    model: (first.model as string) ?? null,
  };
}

/** 调用（pre+post 按 tool_use_id 合并）+ 命中 + 处置的合并视图，按 seq 升序。会话不存在返回 null。 */
export function sessionTimeline(db: Database, sessionId: string, opts: TimelineOpts = {}): Timeline | null {
  const runId = sessionRun(db, sessionId, opts.runId);
  if (runId === null) return null;
  const limit = clampLimit(opts.limit, 200, 1000);
  const tail = opts.beforeSeq !== undefined && opts.sinceSeq === undefined;
  const cond: string[] = ["run_id = ?", "session_id = ?"];
  const args: (number | string)[] = [runId, sessionId];
  if (opts.sinceSeq !== undefined) (cond.push("seq > ?"), args.push(opts.sinceSeq));
  if (opts.beforeSeq !== undefined) (cond.push("seq < ?"), args.push(opts.beforeSeq));
  const order = tail ? "DESC" : "ASC";
  const entries: TimelineEntry[] = [];

  // ----- 命中（带处置）-----
  const hcond = [...cond];
  const hargs = [...args];
  if (opts.severity) (hcond.push("severity = ?"), hargs.push(opts.severity));
  const hits = q<Record<string, unknown>>(db, `SELECT * FROM hits WHERE ${hcond.join(" AND ")} AND observe_only = 0 ORDER BY seq ${order}, id ${order} LIMIT ?`, [...hargs, limit + 1]);
  const decs = decisionsOf(db, hits.map((h) => h.id as number));
  const hitEntries = hits.map((h): TimelineEntry => {
    const ds = decs.get(h.id as number) ?? [];
    return {
      type: "hit",
      seq: h.seq as number,
      ts: h.ts as number,
      hitId: h.id as number,
      ruleId: h.rule_id as string,
      sev: h.sev as string,
      severity: (h.severity as string) ?? null,
      dangerous: h.severity === "dangerous",
      dangerCategory: (h.danger_category as string) ?? null,
      dangerSubject: (h.danger_subject as string) ?? null,
      dangerReason: (h.danger_reason as string) ?? null,
      category: (h.category as string) ?? null,
      phase: (h.phase as string) ?? null,
      callIndex: (h.call_index as number) ?? null,
      message: (h.message as string) ?? null,
      observeOnly: false,
      decisions: ds,
      outcome: (ds.find((d) => d.outcome) ?? ds[0])?.outcome ?? null,
      applied: ds.some((d) => d.applied),
    };
  });
  const filteredHits = opts.outcome ? hitEntries.filter((h) => h.type === "hit" && h.decisions.some((d) => d.outcome === opts.outcome)) : hitEntries;

  if (opts.severity || opts.outcome) {
    entries.push(...filteredHits);
  } else {
    // ----- 事件：pre/post 合并成「调用」；其余（prompt/stop/session…）原样 -----
    const evs = q<Record<string, unknown>>(db, `SELECT * FROM events WHERE ${cond.join(" AND ")} ORDER BY seq ${order} LIMIT ?`, [...args, limit + 1]);
    const ids = [...new Set(evs.map((e) => e.tool_use_id).filter((x): x is string => typeof x === "string"))];
    const partners = new Map<string, Record<string, unknown>[]>();
    if (ids.length) {
      for (const r of q<Record<string, unknown>>(db, `SELECT * FROM events WHERE run_id = ? AND session_id = ? AND tool_use_id IN (${ids.map(() => "?").join(",")}) ORDER BY seq`, [runId, sessionId, ...ids])) {
        const k = r.tool_use_id as string;
        partners.set(k, [...(partners.get(k) ?? []), r]);
      }
    }
    const seen = new Set<string>();
    for (const e of evs) {
      if (e.phase !== "pre" && e.phase !== "post") {
        entries.push({ type: "event", seq: e.seq as number, ts: e.ts as number, phase: e.phase as string, origin: (e.origin as string) ?? null, model: (e.model as string) ?? null });
        continue;
      }
      const id = e.tool_use_id as string | null;
      if (!id) {
        entries.push(callEntry(e, undefined));
        continue;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      const pair = partners.get(id) ?? [];
      const pre = pair.find((p) => p.phase === "pre");
      const post = pair.find((p) => p.phase === "post");
      entries.push(pre ? callEntry(pre, post) : callEntry(post ?? e, undefined)); // 实时跟随时，旧调用的 post 到达会以 pre 的 seq 再出现一次
    }
    entries.push(...filteredHits);
  }
  entries.sort((a, b) => a.seq - b.seq || (a.type === "hit" ? 1 : 0) - (b.type === "hit" ? 1 : 0));
  let out = entries;
  let hasMore = hits.length > limit || (out.length > limit);
  if (out.length > limit) out = tail ? out.slice(out.length - limit) : out.slice(0, limit);
  if (!out.length) hasMore = false;
  return { runId, entries: out, hasMore };
}

export interface RawEvent {
  runId: number;
  sessionId: string;
  seq: number;
  ts: number;
  phase: string;
  origin: string | null;
  toolUseId: string | null;
  tool: string | null;
  kind: string | null;
  cmdClass: string | null;
  normCmd: string | null;
  status: string | null;
  exitCode: number | null;
  errFp: string | null;
  model: string | null;
}

/** 原始事件（不合并）。q 在 norm_cmd / tool_name 里做子串匹配（LIKE，特殊字符已转义）。 */
export function sessionEvents(db: Database, sessionId: string, opts: { runId?: number; phase?: string; q?: string; sinceSeq?: number; limit?: number } = {}): { runId: number; events: RawEvent[]; hasMore: boolean } | null {
  const runId = sessionRun(db, sessionId, opts.runId);
  if (runId === null) return null;
  const limit = clampLimit(opts.limit, 200, 1000);
  const cond = ["run_id = ?", "session_id = ?"];
  const args: (number | string)[] = [runId, sessionId];
  if (opts.phase) (cond.push("phase = ?"), args.push(opts.phase));
  if (opts.sinceSeq !== undefined) (cond.push("seq > ?"), args.push(opts.sinceSeq));
  if (opts.q) {
    cond.push("(norm_cmd LIKE ? ESCAPE '\\' OR tool_name LIKE ? ESCAPE '\\')");
    const like = `%${opts.q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
    args.push(like, like);
  }
  const rows = q<Record<string, unknown>>(db, `SELECT * FROM events WHERE ${cond.join(" AND ")} ORDER BY seq LIMIT ?`, [...args, limit + 1]);
  const events = rows.slice(0, limit).map(
    (e): RawEvent => ({
      runId,
      sessionId,
      seq: e.seq as number,
      ts: e.ts as number,
      phase: e.phase as string,
      origin: (e.origin as string) ?? null,
      toolUseId: (e.tool_use_id as string) ?? null,
      tool: (e.tool_name as string) ?? null,
      kind: (e.tool_kind as string) ?? null,
      cmdClass: (e.cmd_class as string) ?? null,
      normCmd: (e.norm_cmd as string) ?? null,
      status: (e.status as string) ?? null,
      exitCode: (e.exit_code as number) ?? null,
      errFp: (e.err_fp as string) ?? null,
      model: (e.model as string) ?? null,
    }),
  );
  return { runId, events, hasMore: rows.length > limit };
}

export interface HitRow {
  id: number;
  runId: number;
  sessionId: string;
  seq: number;
  ts: number;
  ruleId: string;
  sev: string;
  severity: string | null;
  dangerous: boolean;
  category: string | null;
  phase: string | null;
  message: string | null;
  model: string | null;
  /** 最新一条有结局的处置（没有结局取最新一条）。 */
  action: string | null;
  outcome: string | null;
  applied: boolean;
  /** false_positive | useful | null（最新一条标注）。 */
  label: string | null;
}

export interface HitFilter {
  rule?: string;
  sev?: string;
  severity?: string;
  outcome?: string;
  /** unlabeled | false_positive | useful */
  label?: string;
  /** 只取 id 小于它的（按 id 倒序翻页）。 */
  cursor?: number;
  limit?: number;
}

/** 命中列表：最新在前，用 id 游标分页；nextCursor 为 null 表示没有更多。不含 observe_only 的命中。 */
export function listHits(db: Database, scope: Scope = {}, f: HitFilter = {}): { hits: HitRow[]; nextCursor: number | null } {
  const w = where(scope);
  const args: (number | string)[] = [...w.args];
  const cond = [w.sql.replace(/\b(run_id|ts|session_id)\b/g, "h.$1"), "h.observe_only = 0"];
  if (f.rule) (cond.push("h.rule_id = ?"), args.push(f.rule));
  if (f.sev) (cond.push("h.sev = ?"), args.push(f.sev));
  if (f.severity) (cond.push("h.severity = ?"), args.push(f.severity));
  if (f.cursor !== undefined) (cond.push("h.id < ?"), args.push(f.cursor));
  if (f.label === "unlabeled") cond.push("ll.kind IS NULL");
  else if (f.label === "false_positive") cond.push("ll.kind = 'mark_false_positive'");
  else if (f.label === "useful") cond.push("ll.kind = 'mark_useful'");
  if (f.outcome) (cond.push("EXISTS (SELECT 1 FROM decisions d WHERE d.hit_id = h.id AND d.outcome = ?)"), args.push(f.outcome));
  const limit = clampLimit(f.limit, 100, 500);
  const rows = q<Record<string, unknown>>(
    db,
    `SELECT h.*, ll.kind AS label_kind,
            (SELECT d.action FROM decisions d WHERE d.hit_id = h.id ORDER BY (d.outcome IS NULL), d.id DESC LIMIT 1) AS d_action,
            (SELECT d.outcome FROM decisions d WHERE d.hit_id = h.id ORDER BY (d.outcome IS NULL), d.id DESC LIMIT 1) AS d_outcome,
            (SELECT MAX(d.applied) FROM decisions d WHERE d.hit_id = h.id) AS d_applied
       FROM hits h LEFT JOIN (${LATEST_LABEL}) ll ON ll.hit_id = h.id
      WHERE ${cond.join(" AND ")} ORDER BY h.id DESC LIMIT ?`,
    [...args, limit + 1],
  );
  const page = rows.slice(0, limit).map(
    (h): HitRow => ({
      id: h.id as number,
      runId: h.run_id as number,
      sessionId: h.session_id as string,
      seq: h.seq as number,
      ts: h.ts as number,
      ruleId: h.rule_id as string,
      sev: h.sev as string,
      severity: (h.severity as string) ?? null,
      dangerous: h.severity === "dangerous",
      category: (h.category as string) ?? null,
      phase: (h.phase as string) ?? null,
      message: (h.message as string) ?? null,
      model: (h.model as string) ?? null,
      action: (h.d_action as string) ?? null,
      outcome: (h.d_outcome as string) ?? null,
      applied: h.d_applied === 1,
      label: h.label_kind === "mark_false_positive" ? "false_positive" : h.label_kind === "mark_useful" ? "useful" : null,
    }),
  );
  return { hits: page, nextCursor: rows.length > limit ? page[page.length - 1].id : null };
}

/** 某会话的子 agent 会话（sessions.parent_session_id）。目前没有适配器填这一列，所以通常为空。 */
export function sessionChildren(db: Database, sessionId: string, runId?: number): Record<string, unknown>[] {
  const run = sessionRun(db, sessionId, runId);
  if (run === null) return [];
  return q<Record<string, unknown>>(db, "SELECT run_id, session_id, harness, model, project, calls, started_ts, ended_ts, parent_session_id FROM sessions WHERE run_id = ? AND parent_session_id = ? ORDER BY started_ts, session_id", [run, sessionId]);
}

// ---------- 运行详情（回放 / 评测 / live） ----------

const tryJson = (s: unknown): unknown => {
  if (typeof s !== "string") return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

/** 一次运行的详情：列表字段 + 当时生效的阈值/预算/规则配置（thresholds_json）+ `--set` 覆盖 + 会话与命中汇总。不存在返回 null。 */
export function runDetail(db: Database, id: number) {
  const r = q<Record<string, unknown>>(db, "SELECT * FROM runs WHERE id = ?", [id])[0];
  if (!r) return null;
  const counts = q<Record<string, unknown>>(
    db,
    `SELECT (SELECT COUNT(*) FROM sessions WHERE run_id = r.id) AS sessions,
            (SELECT COUNT(*) FROM events WHERE run_id = r.id AND phase = 'post') AS calls,
            (SELECT COUNT(*) FROM hits WHERE run_id = r.id AND observe_only = 0) AS hits,
            (SELECT COUNT(*) FROM judge_calls WHERE run_id = r.id) AS judge_calls
       FROM runs r WHERE r.id = ?`,
    [id],
  )[0];
  return {
    id: r.id as number,
    kind: r.kind as string,
    label: (r.label as string) ?? null,
    source: (r.source as string) ?? null,
    mode: (r.mode as string) ?? null,
    judge_mode: (r.judge_mode as string) ?? null,
    version: (r.version as string) ?? null,
    thresholds_hash: (r.thresholds_hash as string) ?? null,
    started_ts: r.started_ts as number,
    ended_ts: (r.ended_ts as number) ?? null,
    /** 当时生效的 {thresholds, budgets, detect, rules}。 */
    tuning: tryJson(r.thresholds_json),
    overrides: (tryJson(r.overrides_json) as string[] | null) ?? [],
    sessions: counts.sessions as number,
    calls: counts.calls as number,
    hits: counts.hits as number,
    judge_calls: counts.judge_calls as number,
  };
}

// ---------- judge 调用（列表 / 详情；正文只在详情里） ----------

export interface JudgeCallRow {
  id: number;
  runId: number;
  sessionId: string;
  harness: string | null;
  ts: number;
  ruleIds: string[];
  sync: boolean;
  routeModel: string | null;
  model: string | null;
  status: string;
  verdict: string | null;
  confidence: number | null;
  category: string | null;
  latencyMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  cachedTokens: number | null;
  costUsd: number | null;
  retries: number | null;
  formatDowngraded: boolean;
  error: string | null;
}

export interface JudgeCallFilter {
  harness?: string;
  model?: string;
  routeModel?: string;
  /** 调用涉及的规则（rule_ids 里包含）。 */
  rule?: string;
  verdict?: string;
  status?: string;
  sync?: boolean;
  /** 在 reason / message_raw / category / error 里做子串匹配。 */
  q?: string;
  /** 只取 id 小于它的（倒序翻页）。 */
  cursor?: number;
  limit?: number;
  /** include（默认）= 提示词 token 含缓存命中部分；exclude = 扣掉缓存命中。只影响 totals.promptTokens。 */
  cache?: "include" | "exclude";
}

export interface JudgeTotals {
  calls: number;
  ok: number;
  failed: number;
  parseFail: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  /** 上游没返回 usage 时为 null（不估算）。 */
  costUsd: number | null;
  latencyP50: number | null;
  latencyP95: number | null;
}

const jcFrom = `FROM judge_calls j LEFT JOIN sessions s ON s.run_id = j.run_id AND s.session_id = j.session_id`;

function jcWhere(scope: Scope, f: JudgeCallFilter): { sql: string; args: (number | string)[] } {
  const w = where(scope);
  const cond = [w.sql.replace(/\b(run_id|ts|session_id)\b/g, "j.$1")];
  const args = [...w.args];
  const eq = (col: string, v: string | undefined) => v && (cond.push(`${col} = ?`), args.push(v));
  eq("s.harness", f.harness);
  eq("j.model", f.model);
  eq("j.route_model", f.routeModel);
  eq("j.verdict", f.verdict);
  eq("j.status", f.status);
  if (f.sync !== undefined) (cond.push("j.sync = ?"), args.push(f.sync ? 1 : 0));
  if (f.rule) (cond.push("(',' || j.rule_ids || ',') LIKE ? ESCAPE '\\'"), args.push(`%,${f.rule.replace(/[\\%_]/g, (c) => "\\" + c)},%`));
  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
    cond.push("(j.reason LIKE ? ESCAPE '\\' OR j.message_raw LIKE ? ESCAPE '\\' OR j.category LIKE ? ESCAPE '\\' OR j.error LIKE ? ESCAPE '\\')");
    args.push(like, like, like, like);
  }
  return { sql: cond.join(" AND "), args };
}

const jcRow = (r: Record<string, unknown>): JudgeCallRow => ({
  id: r.id as number,
  runId: r.run_id as number,
  sessionId: r.session_id as string,
  harness: (r.harness as string) ?? null,
  ts: r.ts as number,
  ruleIds: String(r.rule_ids ?? "").split(",").filter(Boolean),
  sync: r.sync === 1,
  routeModel: (r.route_model as string) ?? null,
  model: (r.model as string) ?? null,
  status: r.status as string,
  verdict: (r.verdict as string) ?? null,
  confidence: (r.confidence as number) ?? null,
  category: (r.category as string) ?? null,
  latencyMs: (r.latency_ms as number) ?? null,
  promptTokens: (r.prompt_tokens as number) ?? null,
  completionTokens: (r.completion_tokens as number) ?? null,
  cachedTokens: (r.cached_tokens as number) ?? null,
  costUsd: (r.cost_usd as number) ?? null,
  retries: (r.retries as number) ?? null,
  formatDowngraded: r.format_downgraded === 1,
  error: (r.error as string) ?? null,
});

/** 列表（不含请求/响应正文）+ 同一筛选条件下的合计；最新在前，id 游标。 */
export function listJudgeCalls(db: Database, scope: Scope = {}, f: JudgeCallFilter = {}): { calls: JudgeCallRow[]; nextCursor: number | null; totals: JudgeTotals } {
  const w = jcWhere(scope, f);
  const limit = clampLimit(f.limit, 100, 500);
  const rows = q<Record<string, unknown>>(
    db,
    `SELECT j.id, j.run_id, j.session_id, s.harness AS harness, j.ts, j.rule_ids, j.sync, j.route_model, j.model, j.status, j.verdict, j.confidence, j.category, j.latency_ms, j.prompt_tokens, j.completion_tokens, j.cached_tokens, j.cost_usd, j.retries, j.format_downgraded, j.error
       ${jcFrom} WHERE ${w.sql}${f.cursor !== undefined ? " AND j.id < ?" : ""} ORDER BY j.id DESC LIMIT ?`,
    [...w.args, ...(f.cursor !== undefined ? [f.cursor] : []), limit + 1],
  );
  const page = rows.slice(0, limit).map(jcRow);
  // 合计：与列表同一筛选条件（不受游标和 limit 影响）
  const all = q<Record<string, unknown>>(db, `SELECT j.status, j.latency_ms, j.prompt_tokens, j.completion_tokens, j.cached_tokens, j.cost_usd ${jcFrom} WHERE ${w.sql}`, w.args);
  const sum = (k: string) => all.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const lat = all.map((r) => Number(r.latency_ms)).filter((x) => Number.isFinite(x) && x > 0);
  const costs = all.filter((r) => r.cost_usd !== null && r.cost_usd !== undefined);
  const prompt = sum("prompt_tokens");
  const cached = sum("cached_tokens");
  const totals: JudgeTotals = {
    calls: all.length,
    ok: all.filter((r) => r.status === "ok").length,
    failed: all.filter((r) => r.status !== "ok").length,
    parseFail: all.filter((r) => r.status === "parse_fail").length,
    promptTokens: f.cache === "exclude" ? Math.max(0, prompt - cached) : prompt,
    completionTokens: sum("completion_tokens"),
    cachedTokens: cached,
    costUsd: costs.length ? Math.round(costs.reduce((a, r) => a + Number(r.cost_usd), 0) * 10000) / 10000 : null,
    latencyP50: pct(lat, 0.5),
    latencyP95: pct(lat, 0.95),
  };
  return { calls: page, nextCursor: rows.length > limit ? page[page.length - 1].id : null, totals };
}

const parseJson = (s: unknown): unknown => {
  if (typeof s !== "string") return null;
  try {
    return JSON.parse(s);
  } catch {
    return s; // 不是 JSON（例如原始文本）就原样给
  }
};

/** 详情：列表字段 + 请求/响应（已在写入时脱敏；`store_judge_bodies=false` 时为 null）+ 修复记录 + 关联的命中 / 决策 / 投递。不存在返回 null。 */
export function judgeCallDetail(db: Database, id: number) {
  const r = q<Record<string, unknown>>(db, `SELECT j.*, s.harness AS harness ${jcFrom} WHERE j.id = ?`, [id])[0];
  if (!r) return null;
  const decisions = q<Record<string, unknown>>(db, "SELECT * FROM decisions WHERE judge_call_id = ? ORDER BY id", [id]);
  const decIds = decisions.map((d) => d.id as number);
  const hitIds = [...new Set(decisions.map((d) => d.hit_id as number))];
  const hits = hitIds.length ? q<Record<string, unknown>>(db, `SELECT id, rule_id, sev, severity, category, seq, ts, message FROM hits WHERE id IN (${hitIds.map(() => "?").join(",")}) ORDER BY id`, hitIds) : [];
  const deliveries = decIds.length ? q<Record<string, unknown>>(db, `SELECT id, decision_id, channel, delivered, delivered_ts, expired_reason, text, complied FROM deliveries WHERE decision_id IN (${decIds.map(() => "?").join(",")}) ORDER BY id`, decIds) : [];
  return {
    ...jcRow(r),
    reason: (r.reason as string) ?? null,
    messageRaw: (r.message_raw as string) ?? null,
    httpRequests: (r.http_requests as number) ?? null,
    formatLevel: (r.format_level as string) ?? null,
    repairs: parseJson(r.repairs_json) ?? [],
    request: parseJson(r.request_json),
    response: parseJson(r.response_json),
    bodiesStored: r.request_json !== null || r.response_json !== null,
    hits,
    decisions: decisions.map((d) => ({ id: d.id, hitId: d.hit_id, action: d.action, applied: d.applied === 1, mode: d.mode ?? null, outcome: d.outcome ?? null, message: d.message ?? null })),
    deliveries,
  };
}

// ---------- 会话活动（recent 排序 / state 过滤） ----------

export interface SessionActivity {
  firstTs: number | null;
  lastTs: number | null;
  events: number;
  /** sessions.ended_ts（有适配器写入时才有）。 */
  endedTs: number | null;
}

/** 每个 (run, session) 的首末事件时间；key 是 `${runId}:${sessionId}`。 */
export function sessionActivity(db: Database, scope: Scope = {}): Map<string, SessionActivity> {
  const w = where(scope);
  const rows = q<Record<string, unknown>>(db, `SELECT run_id, session_id, MIN(ts) AS first_ts, MAX(ts) AS last_ts, COUNT(*) AS n FROM events WHERE ${w.sql} GROUP BY run_id, session_id`, w.args);
  const ended = new Map(q<Record<string, unknown>>(db, "SELECT run_id, session_id, ended_ts FROM sessions").map((r) => [`${r.run_id}:${r.session_id}`, (r.ended_ts as number) ?? null]));
  const out = new Map<string, SessionActivity>();
  for (const r of rows) {
    const k = `${r.run_id}:${r.session_id}`;
    out.set(k, { firstTs: (r.first_ts as number) ?? null, lastTs: (r.last_ts as number) ?? null, events: r.n as number, endedTs: ended.get(k) ?? null });
  }
  return out;
}

export type SessionState = "active" | "idle" | "ended";

/** ended：适配器写了 ended_ts；active：最近 activeMs 内有事件；否则 idle。 */
export function sessionStateOf(a: SessionActivity | undefined, now: number, activeMs = 5 * 60_000): SessionState {
  if (a?.endedTs) return "ended";
  return a?.lastTs !== null && a?.lastTs !== undefined && now - a.lastTs <= activeMs ? "active" : "idle";
}

// ---------- judge 健康与路由（frontend-design §5；全部来自 judge_calls，不猜） ----------

export type JudgeHealth = "ok" | "degraded" | "unavailable" | "idle";
export interface JudgeCallLite {
  id: number;
  ts: number;
  status: string;
  error: string | null;
  format_level: string | null;
  format_downgraded: number | null;
}
const PARSE_FAIL_WARN = 0.15;
const PARSE_FAIL_MIN_SAMPLES = 10;
const CONSECUTIVE_FAIL = 3;

/** 一组调用（按 ts 升序）→ 健康状态与可追溯的原因。idle = 窗口内没有调用。 */
export function judgeHealthOf(calls: JudgeCallLite[]): { health: JudgeHealth; reasons: string[]; lastFailure: JudgeCallLite | null } {
  if (!calls.length) return { health: "idle", reasons: [], lastFailure: null };
  const fails = calls.filter((c) => c.status !== "ok");
  const lastFailure = fails.length ? fails[fails.length - 1]! : null;
  const reasons: string[] = [];
  let tail = 0;
  for (let i = calls.length - 1; i >= 0 && calls[i]!.status !== "ok"; i--) tail++;
  const pf = calls.filter((c) => c.status === "parse_fail").length;
  const down = calls.filter((c) => Number(c.format_downgraded) === 1);
  if (tail >= CONSECUTIVE_FAIL) reasons.push(`最近连续 ${tail} 次调用失败`);
  if (calls.length >= PARSE_FAIL_MIN_SAMPLES && pf / calls.length > PARSE_FAIL_WARN) reasons.push(`parse_fail 率 ${Math.round((pf / calls.length) * 1000) / 10}% 高于警告线 ${PARSE_FAIL_WARN * 100}%（样本 ≥${PARSE_FAIL_MIN_SAMPLES}）`);
  if (down.length) reasons.push(`response_format 已降级 ${down.length} 次，当前 ${down[down.length - 1]!.format_level ?? "?"}`);
  const health: JudgeHealth = tail >= CONSECUTIVE_FAIL ? "unavailable" : reasons.length ? "degraded" : "ok";
  return { health, reasons, lastFailure };
}

type RouteCall = JudgeCallLite & { sync: number | null; rule_ids: string | null; latency_ms: number | null };
const callsIn = (db: Database, scope: Scope) => {
  const w = where(scope);
  return q<RouteCall>(db, `SELECT id, ts, status, error, format_level, format_downgraded, sync, rule_ids, latency_ms FROM judge_calls WHERE ${w.sql} ORDER BY ts, id`, w.args);
};

/** /v1/status 里的 judge 健康（只看 now 之前 windowMs 内的调用）。 */
export function judgeHealth(db: Database, now: number, windowMs = 15 * 60_000) {
  const calls = callsIn(db, { since: now - windowMs });
  const h = judgeHealthOf(calls);
  return { health: h.health, recent_calls: calls.length, recent_failures: calls.filter((c) => c.status !== "ok").length, last_error: h.lastFailure?.error ?? null };
}

const useText = (w: { rule?: string; sync?: boolean }): string => {
  const p: string[] = [];
  if (w.sync !== undefined) p.push(w.sync ? "同步（sync=true）" : "异步（sync=false）");
  if (w.rule !== undefined) p.push(`规则 ${w.rule}`);
  return p.length ? p.join(" · ") : "（未写匹配条件）";
};

export interface JudgeRoutesCfg {
  enabled: boolean;
  base_url: string;
  model: string;
  routes: { when: { rule?: string; sync?: boolean }; model: string }[];
}

/** 每个「用途」（judge.routes 的每一条 + 默认）当前走哪个模型、状态、为什么。每次调用按它当时的 sync 与命中规则重新匹配到路由。 */
export function judgeRoutes(db: Database, cfg: JudgeRoutesCfg, scope: Scope, matcher: (sync: boolean, ruleIds: string[]) => number | null) {
  const groups = new Map<number | null, RouteCall[]>();
  for (const c of callsIn(db, scope)) {
    const ids = (c.rule_ids ?? "").split(",").filter(Boolean); // 库里是逗号分隔
    const k = matcher(Number(c.sync) === 1, ids);
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  const row = (index: number | null, when: { rule?: string; sync?: boolean }, model: string) => {
    const cs = groups.get(index) ?? [];
    const h = judgeHealthOf(cs);
    const n = (st: string) => cs.filter((c) => c.status === st).length;
    const lat = cs.map((c) => Number(c.latency_ms)).filter((x) => Number.isFinite(x) && x > 0);
    const reasons = [index === null ? (cfg.routes.length ? "没有路由命中时走 judge.model" : "没有配置路由：所有调用走 judge.model") : `routes[${index}] 命中`, ...h.reasons];
    if (!cfg.enabled) reasons.push("judge 未启用");
    return {
      index,
      use: index === null ? "默认" : useText(when),
      when,
      model,
      status: h.health === "idle" ? "unused" : h.health,
      calls: cs.length,
      ok: n("ok"),
      parse_fail: n("parse_fail"),
      parse_fail_rate: cs.length ? n("parse_fail") / cs.length : null,
      timeouts: n("timeout"),
      errors: n("error"),
      latency_p95: pct(lat, 0.95) ?? null,
      format_level: [...cs].reverse().find((c) => c.format_level)?.format_level ?? null,
      format_downgrades: cs.filter((c) => Number(c.format_downgraded) === 1).length,
      last_failure_id: h.lastFailure?.id ?? null,
      last_failure_ts: h.lastFailure?.ts ?? null,
      last_failure_status: h.lastFailure?.status ?? null,
      last_failure_error: h.lastFailure?.error ?? null,
      reasons,
    };
  };
  return {
    enabled: cfg.enabled,
    base_url: cfg.base_url,
    default_model: cfg.model,
    since: scope.since ?? null,
    routes: [...cfg.routes.map((r, i) => row(i, r.when ?? {}, r.model)), row(null, {}, cfg.model)],
  };
}
