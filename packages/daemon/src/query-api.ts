// 只读查询 API（frontend-design §12）：SQL 全部在 core/store/queries*.ts 里，这里只做参数解析、路由和序列化。
// 与 hook 路径无关——这里出错只影响前端的这一次查询（500，见 daemon.route），不影响监督；也不改任何数据。
import type { Database } from "bun:sqlite";
import {
  compareRuns,
  dangerEvents,
  dangerStats,
  explainHit,
  judgeStats,
  listHits,
  listRuns,
  modelRuleStats,
  resolveRuns,
  ruleStats,
  sessionChildren,
  sessionEvents,
  sessionStats,
  sessionTimeline,
  type Scope,
  type TimelineEntry,
} from "@sv/core";
import { schemaFor } from "./schemas.ts";

export interface QueryReply {
  status: number;
  body: unknown;
  /** 默认 application/json；CSV 导出为 text/csv（body 是字符串）。 */
  contentType?: string;
}

const bad = (message: string): QueryReply => ({ status: 400, body: { error: { code: "bad_request", message, retryable: false } } });
const notFound = (what: string): QueryReply => ({ status: 404, body: { error: { code: "not_found", message: `${what} 不存在`, retryable: false } } });
const ok = (body: unknown): QueryReply => ({ status: 200, body });

// ---------- 参数 ----------

function num(v: string | null): number | undefined | "bad" {
  if (v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : "bad";
}
const int = (v: string | null): number | undefined | "bad" => {
  const n = num(v);
  return n === "bad" || (n !== undefined && !Number.isInteger(n)) ? "bad" : n;
};

/** since/until（epoch ms）、run（逗号分隔 id）、label、kind、session → Scope。 */
function scopeOf(db: Database, u: URL): Scope | QueryReply {
  // /v1/hits 上 `label` 是命中的标注过滤（unlabeled|false_positive|useful），运行的标签改用 `run_label`
  const runLabel = u.pathname.startsWith("/v1/hits") ? u.searchParams.get("run_label") : (u.searchParams.get("run_label") ?? u.searchParams.get("label"));
  const since = num(u.searchParams.get("since"));
  const until = num(u.searchParams.get("until"));
  if (since === "bad" || until === "bad") return bad("since/until 需要是毫秒时间戳");
  const runRaw = u.searchParams.get("run");
  const run = runRaw ? runRaw.split(",").map(Number) : undefined;
  if (run?.some((x) => !Number.isInteger(x))) return bad("run 需要是逗号分隔的整数");
  const runIds = resolveRuns(db, { run, label: runLabel ?? undefined, kind: u.searchParams.get("kind") ?? undefined });
  const scope: Scope = { since, until, sessionId: u.searchParams.get("session") ?? undefined };
  if (runIds) {
    if (runIds.length === 0) return { ...scope, runIds: [-1] }; // 筛选条件匹配不到任何运行 → 空结果，而不是「全部」
    scope.runIds = runIds;
  }
  return scope;
}
const isReply = (x: unknown): x is QueryReply => typeof x === "object" && x !== null && "status" in x && "body" in x;

// ---------- CSV ----------

/** RFC 4180 转义；以 = + - @ 开头的单元格前面补 '，避免被表格软件当公式执行（数据来自 agent 的命令行，不可信）。 */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !(typeof v === "number" && Number.isFinite(v))) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\r\n") + "\r\n";
}
const csv = (rows: Record<string, unknown>[], columns?: string[]): QueryReply => ({ status: 200, body: toCsv(rows, columns), contentType: "text/csv; charset=utf-8" });

// ---------- 会话摘要 ----------

function sessionRows(db: Database, sc: Scope, u: URL): Record<string, unknown>[] {
  let rows = sessionStats(db, sc);
  const harness = u.searchParams.get("harness");
  const model = u.searchParams.get("model");
  if (harness) rows = rows.filter((r) => r.harness === harness);
  if (model) rows = rows.filter((r) => r.model === model);
  if (u.searchParams.get("has_danger") === "true") rows = rows.filter((r) => Number(r.dangerous) > 0);
  const out: Record<string, unknown>[] = rows.map((r) => ({ ...r, danger: { total: r.dangerous, wouldHaveBlocked: r.would_have_blocked, enforced: r.blocked } }));
  if (u.searchParams.get("sort") === "danger_desc") out.sort((a, b) => Number(b.dangerous) - Number(a.dangerous));
  return out;
}

const flat = (e: TimelineEntry): Record<string, unknown> => {
  const { decisions, ...rest } = e as TimelineEntry & { decisions?: unknown };
  return { ...rest, decisions: decisions === undefined ? undefined : JSON.stringify(decisions) };
};

// ---------- 路由 ----------

/** 返回 null = 不是查询路径（交给其他路由）。 */
export function handleQuery(db: Database, method: string, u: URL): QueryReply | null {
  if (method !== "GET") return null;
  const p = u.pathname;
  if (!p.startsWith("/v1/")) return null;

  // JSON Schema（不查库）
  let m = /^\/v1\/schema\/([A-Za-z]+)$/.exec(p);
  if (m) {
    const s = schemaFor(m[1]);
    return s ? ok(s) : notFound(`schema ${m[1]}`);
  }

  const known = /^\/v1\/(sessions|hits|runs|rules\/stats|judge-calls\/stats|danger\/(stats|events))(\/|\.csv$|$)/.test(p);
  if (!known) return null;
  const sc = scopeOf(db, u);
  if (isReply(sc)) return sc;
  const q = u.searchParams;

  // 会话子资源
  m = /^\/v1\/sessions\/([^/]+)\/(timeline|events|children)(\.csv)?$/.exec(p);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const run = int(q.get("run"));
    const limit = int(q.get("limit"));
    if (run === "bad" || limit === "bad") return bad("run / limit 需要是整数");
    if (m[2] === "children") {
      const rows = sessionChildren(db, id, run);
      return m[3] ? csv(rows) : ok({ children: rows });
    }
    if (m[2] === "events") {
      const since = int(q.get("since_seq"));
      if (since === "bad") return bad("since_seq 需要是整数");
      const r = sessionEvents(db, id, { runId: run, phase: q.get("phase") ?? undefined, q: q.get("q") ?? undefined, sinceSeq: since, limit });
      if (!r) return notFound(`会话 ${id}`);
      return m[3] ? csv(r.events as unknown as Record<string, unknown>[]) : ok(r);
    }
    const since = int(q.get("since_seq"));
    const before = int(q.get("before_seq"));
    if (since === "bad" || before === "bad") return bad("since_seq / before_seq 需要是整数");
    const t = sessionTimeline(db, id, { runId: run, sinceSeq: since, beforeSeq: before, limit, severity: q.get("severity") ?? undefined, outcome: q.get("outcome") ?? undefined });
    if (!t) return notFound(`会话 ${id}`);
    return m[3] ? csv(t.entries.map(flat)) : ok(t);
  }

  if (p === "/v1/sessions/export.csv") return csv(sessionRows(db, sc, u).map(({ danger, ...r }) => ({ ...r, danger_total: (danger as { total: unknown }).total })));
  if (p === "/v1/sessions") return ok({ sessions: sessionRows(db, sc, u) });
  m = /^\/v1\/sessions\/([^/]+)$/.exec(p);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const one = sessionRows(db, { ...sc, sessionId: id }, u);
    return one.length ? ok(one.length === 1 ? one[0] : one) : notFound(`会话 ${id}`);
  }

  // 命中
  if (p === "/v1/hits" || p === "/v1/hits/export.csv") {
    const cursor = int(q.get("cursor"));
    const limit = int(q.get("limit"));
    if (cursor === "bad" || limit === "bad") return bad("cursor / limit 需要是整数");
    const label = q.get("label");
    if (label && !["unlabeled", "false_positive", "useful"].includes(label)) return bad("label 只能是 unlabeled | false_positive | useful");
    const r = listHits(db, sc, { rule: q.get("rule") ?? undefined, sev: q.get("sev") ?? undefined, severity: q.get("severity") ?? undefined, outcome: q.get("outcome") ?? undefined, label: label ?? undefined, cursor, limit: p.endsWith(".csv") ? Math.min(limit ?? 500, 500) : limit });
    return p.endsWith(".csv") ? csv(r.hits as unknown as Record<string, unknown>[]) : ok(r);
  }
  m = /^\/v1\/hits\/([^/]+)$/.exec(p);
  if (m) {
    const id = Number(m[1]);
    if (!Number.isInteger(id)) return bad("命中 id 需要是整数");
    const ex = explainHit(db, id);
    return ex ? ok(ex) : notFound(`命中 ${id}`);
  }

  // 运行 / 统计 / 危险
  if (p === "/v1/runs") return ok({ runs: listRuns(db) });
  if (p === "/v1/runs.csv") return csv(listRuns(db));
  if (p === "/v1/rules/stats" || p === "/v1/rules/stats.csv") {
    const byModel = q.get("by") === "model";
    const rows = (byModel ? modelRuleStats(db, sc) : ruleStats(db, sc)) as unknown as Record<string, unknown>[];
    return p.endsWith(".csv") ? csv(rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v])))) : ok({ by: byModel ? "model" : "rule", rows });
  }
  if (p === "/v1/judge-calls/stats") return ok({ rows: judgeStats(db, sc) });
  if (p === "/v1/danger/stats") return ok(dangerStats(db, sc));
  if (p === "/v1/danger/events" || p === "/v1/danger/events.csv") {
    let events = dangerEvents(db, sc);
    const cat = q.get("category");
    const out = q.get("outcome");
    if (cat) events = events.filter((e) => e.category === cat);
    if (out) events = events.filter((e) => e.outcome === out);
    return p.endsWith(".csv") ? csv(events as unknown as Record<string, unknown>[]) : ok({ events });
  }
  return null;
}

/** GET /v1/runs/compare?a=&b= */
export function handleCompare(db: Database, method: string, u: URL): QueryReply | null {
  if (method !== "GET" || u.pathname !== "/v1/runs/compare") return null;
  const a = Number(u.searchParams.get("a"));
  const b = Number(u.searchParams.get("b"));
  if (!Number.isInteger(a) || !Number.isInteger(b)) return bad("需要整数参数 a 和 b（运行 id）");
  return ok({ a, b, rows: compareRuns(db, a, b) });
}
