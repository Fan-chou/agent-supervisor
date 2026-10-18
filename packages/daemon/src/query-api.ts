// 只读查询 API（frontend-design §12 的第一批）：全部直接调用 core/store/queries.ts 里已有的函数，不在这里写 SQL。
// 与 hook 路径无关——这里出错只影响前端的这一次查询（500），不影响监督；也不改任何数据。
import type { Database } from "bun:sqlite";
import { compareRuns, dangerEvents, dangerStats, explainHit, judgeStats, listRuns, modelRuleStats, resolveRuns, ruleStats, sessionStats, type Scope } from "@sv/core";

export interface QueryReply {
  status: number;
  body: unknown;
}

const bad = (message: string): QueryReply => ({ status: 400, body: { error: { code: "bad_request", message, retryable: false } } });
const notFound = (what: string): QueryReply => ({ status: 404, body: { error: { code: "not_found", message: `${what} 不存在`, retryable: false } } });

function num(v: string | null): number | undefined | "bad" {
  if (v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : "bad";
}

/** since/until（epoch ms）、run（逗号分隔 id）、label、session → Scope。 */
function scopeOf(db: Database, u: URL): Scope | QueryReply {
  const since = num(u.searchParams.get("since"));
  const until = num(u.searchParams.get("until"));
  if (since === "bad" || until === "bad") return bad("since/until 需要是毫秒时间戳");
  const runRaw = u.searchParams.get("run");
  const run = runRaw ? runRaw.split(",").map(Number) : undefined;
  if (run?.some((x) => !Number.isInteger(x))) return bad("run 需要是逗号分隔的整数");
  const runIds = resolveRuns(db, { run, label: u.searchParams.get("label") ?? undefined, kind: u.searchParams.get("kind") ?? undefined });
  const scope: Scope = { since, until, sessionId: u.searchParams.get("session") ?? undefined };
  if (runIds) {
    if (runIds.length === 0) return { ...scope, runIds: [-1] }; // 筛选条件匹配不到任何运行 → 空结果，而不是「全部」
    scope.runIds = runIds;
  }
  return scope;
}

const isReply = (x: Scope | QueryReply): x is QueryReply => "status" in x;

/** 返回 null = 不是查询路径（交给其他路由）。 */
export function handleQuery(db: Database, method: string, u: URL): QueryReply | null {
  if (method !== "GET") return null;
  const p = u.pathname;
  const m = /^\/v1\/(sessions|hits|runs|rules\/stats|judge-calls\/stats|danger\/(?:stats|events))(?:\/([^/]+))?$/.exec(p);
  if (!m) return null;
  const sc = scopeOf(db, u);
  if (isReply(sc)) return sc;
  switch (m[1]) {
    case "sessions": {
      let rows = sessionStats(db, sc);
      const harness = u.searchParams.get("harness");
      const model = u.searchParams.get("model");
      if (harness) rows = rows.filter((r) => r.harness === harness);
      if (model) rows = rows.filter((r) => r.model === model);
      if (u.searchParams.get("has_danger") === "true") rows = rows.filter((r) => Number(r.dangerous) > 0);
      const withDanger: Record<string, unknown>[] = rows.map((r) => ({ ...r, danger: { total: r.dangerous, wouldHaveBlocked: r.would_have_blocked, enforced: r.blocked } }));
      if (u.searchParams.get("sort") === "danger_desc") withDanger.sort((a, b) => Number(b.dangerous) - Number(a.dangerous));
      if (m[2]) {
        const one = withDanger.filter((r) => r.session_id === m[2]);
        return one.length ? { status: 200, body: one.length === 1 ? one[0] : one } : notFound(`会话 ${m[2]}`);
      }
      return { status: 200, body: { sessions: withDanger } };
    }
    case "hits": {
      if (!m[2]) return null; // 命中列表需要新的查询（尚未提供）
      const id = Number(m[2]);
      if (!Number.isInteger(id)) return bad("命中 id 需要是整数");
      const ex = explainHit(db, id);
      return ex ? { status: 200, body: ex } : notFound(`命中 ${id}`);
    }
    case "runs": {
      return m[2] ? null : { status: 200, body: { runs: listRuns(db) } };
    }
    case "rules/stats":
      return { status: 200, body: u.searchParams.get("by") === "model" ? { by: "model", rows: modelRuleStats(db, sc) } : { by: "rule", rows: ruleStats(db, sc) } };
    case "judge-calls/stats":
      return { status: 200, body: { rows: judgeStats(db, sc) } };
    case "danger/stats":
      return { status: 200, body: dangerStats(db, sc) };
    case "danger/events":
      return { status: 200, body: { events: dangerEvents(db, sc) } };
  }
  return null;
}

/** GET /v1/runs/compare?a=&b= 单独处理（路径多一段）。 */
export function handleCompare(db: Database, method: string, u: URL): QueryReply | null {
  if (method !== "GET" || u.pathname !== "/v1/runs/compare") return null;
  const a = Number(u.searchParams.get("a"));
  const b = Number(u.searchParams.get("b"));
  if (!Number.isInteger(a) || !Number.isInteger(b)) return bad("需要整数参数 a 和 b（运行 id）");
  return { status: 200, body: { a, b, rows: compareRuns(db, a, b) } };
}
