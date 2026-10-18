// 日志查询（design §18.3）。`sv stats` 用它；SQL 全部写在这里，方便复盘和审阅。
import type { Database } from "bun:sqlite";

export interface Scope {
  /** 限定某几次运行（replay / live）。空 = 所有运行。 */
  runIds?: number[];
  /** 事件时间下限 / 上限（epoch ms，按 ts 过滤，不是 logged_ts）。 */
  since?: number;
  until?: number;
  /** 限定会话。 */
  sessionId?: string;
}

interface W {
  sql: string;
  args: (number | string)[];
}

function where(scope: Scope, opts: { ts?: string } = {}): W {
  const parts: string[] = [];
  const args: (number | string)[] = [];
  const ts = opts.ts ?? "ts";
  if (scope.runIds?.length) {
    parts.push(`run_id IN (${scope.runIds.map(() => "?").join(",")})`);
    args.push(...scope.runIds);
  }
  if (scope.since !== undefined) (parts.push(`${ts} >= ?`), args.push(scope.since));
  if (scope.until !== undefined) (parts.push(`${ts} <= ?`), args.push(scope.until));
  if (scope.sessionId) (parts.push(`session_id = ?`), args.push(scope.sessionId));
  return { sql: parts.length ? parts.join(" AND ") : "1=1", args };
}

const q = <T>(db: Database, sql: string, args: (number | string)[] = []) => db.query(sql).all(...(args as never[])) as T[];

/** 把 --run 3 / --label foo 解析成 run id 列表。 */
export function resolveRuns(db: Database, sel: { run?: number[]; label?: string; kind?: string }): number[] | undefined {
  if (!sel.run?.length && !sel.label && !sel.kind) return undefined;
  const parts: string[] = [];
  const args: (number | string)[] = [];
  if (sel.run?.length) (parts.push(`id IN (${sel.run.map(() => "?").join(",")})`), args.push(...sel.run));
  if (sel.label) (parts.push("label = ?"), args.push(sel.label));
  if (sel.kind) (parts.push("kind = ?"), args.push(sel.kind));
  return q<{ id: number }>(db, `SELECT id FROM runs WHERE ${parts.join(" AND ")} ORDER BY id`, args).map((r) => r.id);
}

export function listRuns(db: Database) {
  return q<Record<string, unknown>>(
    db,
    `SELECT r.id, r.kind, r.label, r.source, r.mode, r.judge_mode, r.thresholds_hash, r.overrides_json, r.started_ts, r.ended_ts,
            (SELECT COUNT(*) FROM sessions s WHERE s.run_id = r.id) AS sessions,
            (SELECT COUNT(*) FROM hits h WHERE h.run_id = r.id AND h.observe_only = 0) AS hits
       FROM runs r ORDER BY r.id`,
  );
}

// ---------- 规则统计：命中率 / 误报率 ----------

/** 每个命中的最新一条人工标注（误报 / 有用）。 */
const LATEST_LABEL = `
  SELECT o.target_id AS hit_id, o.kind AS kind
    FROM overrides o
   WHERE o.target_type = 'hit' AND o.kind IN ('mark_false_positive','mark_useful')
     AND o.id = (SELECT MAX(o2.id) FROM overrides o2 WHERE o2.target_type='hit' AND o2.target_id=o.target_id AND o2.kind IN ('mark_false_positive','mark_useful'))`;

export interface RuleStat {
  rule: string;
  hits: number;
  sessions: number;
  /** 每 100 次工具调用的命中数。 */
  hitsPer100Calls: number | null;
  /** 触发过该规则的会话占比。 */
  sessionRate: number | null;
  bySev: Record<string, number>;
  actions: Record<string, number>;
  suppressed: Record<string, number>;
  applied: number;
  labeledFp: number;
  labeledUseful: number;
  /** 已标注的命中里，被标为误报的比例；没有标注为 null。 */
  fpRate: number | null;
  delivered: number;
  complied: number;
  notComplied: number;
  /** 遵从率 = complied / (complied + notComplied)；没有可判定的投递为 null。 */
  complianceRate: number | null;
}

const rate = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : null);

export function totals(db: Database, scope: Scope): { calls: number; sessions: number } {
  const w = where(scope);
  const calls = (db.query(`SELECT COUNT(*) AS n FROM events WHERE phase='post' AND tool_name IS NOT NULL AND ${w.sql}`).get(...(w.args as never[])) as { n: number }).n;
  const sessions = (db.query(`SELECT COUNT(DISTINCT run_id || ':' || session_id) AS n FROM events WHERE ${w.sql}`).get(...(w.args as never[])) as { n: number }).n;
  return { calls, sessions };
}

export function ruleStats(db: Database, scope: Scope = {}): RuleStat[] {
  const w = where(scope);
  const { calls, sessions } = totals(db, scope);
  const base = q<{ rule_id: string; hits: number; sessions: number; fp: number; useful: number }>(
    db,
    `SELECT h.rule_id, COUNT(*) AS hits, COUNT(DISTINCT h.run_id || ':' || h.session_id) AS sessions,
            SUM(CASE WHEN l.kind='mark_false_positive' THEN 1 ELSE 0 END) AS fp,
            SUM(CASE WHEN l.kind='mark_useful' THEN 1 ELSE 0 END) AS useful
       FROM hits h LEFT JOIN (${LATEST_LABEL}) l ON l.hit_id = h.id
      WHERE h.observe_only = 0 AND h.rule_id != 'INTERNAL' AND ${w.sql.replace(/\b(run_id|ts|session_id)\b/g, "h.$1")}
      GROUP BY h.rule_id ORDER BY h.rule_id`,
    w.args,
  );
  const out = new Map<string, RuleStat>();
  for (const b of base) {
    out.set(b.rule_id, {
      rule: b.rule_id,
      hits: b.hits,
      sessions: b.sessions,
      hitsPer100Calls: calls ? Math.round((b.hits / calls) * 10000) / 100 : null,
      sessionRate: rate(b.sessions, sessions),
      bySev: {},
      actions: {},
      suppressed: {},
      applied: 0,
      labeledFp: b.fp,
      labeledUseful: b.useful,
      fpRate: rate(b.fp, b.fp + b.useful),
      delivered: 0,
      complied: 0,
      notComplied: 0,
      complianceRate: null,
    });
  }
  const dw = where(scope).sql.replace(/\b(run_id|ts|session_id)\b/g, "d.$1");
  for (const r of q<{ rule_id: string; sev: string; n: number }>(db, `SELECT h.rule_id, h.sev, COUNT(*) AS n FROM hits h WHERE h.observe_only=0 AND ${w.sql.replace(/\b(run_id|ts|session_id)\b/g, "h.$1")} GROUP BY h.rule_id, h.sev`, w.args)) {
    const s = out.get(r.rule_id);
    if (s) s.bySev[r.sev] = r.n;
  }
  for (const r of q<{ rule_id: string; action: string; suppressed_by: string | null; applied: number; n: number }>(db, `SELECT d.rule_id, d.action, d.suppressed_by, d.applied, COUNT(*) AS n FROM decisions d WHERE ${dw} GROUP BY d.rule_id, d.action, d.suppressed_by, d.applied`, w.args)) {
    const s = out.get(r.rule_id);
    if (!s) continue;
    s.actions[r.action] = (s.actions[r.action] ?? 0) + r.n;
    if (r.suppressed_by) s.suppressed[r.suppressed_by] = (s.suppressed[r.suppressed_by] ?? 0) + r.n;
    if (r.applied) s.applied += r.n;
  }
  for (const r of q<{ rule_id: string; delivered: number; complied: number | null; n: number }>(db, `SELECT d.rule_id, d.delivered, d.complied, COUNT(*) AS n FROM deliveries d WHERE ${dw} GROUP BY d.rule_id, d.delivered, d.complied`, w.args)) {
    const s = out.get(r.rule_id);
    if (!s) continue;
    if (r.delivered) s.delivered += r.n;
    if (r.complied === 1) s.complied += r.n;
    if (r.complied === 0) s.notComplied += r.n;
  }
  for (const s of out.values()) s.complianceRate = rate(s.complied, s.complied + s.notComplied);
  return [...out.values()];
}

// ---------- 按模型：模型名只记录，这里事后看谁更容易触发什么 ----------

export interface ModelRuleStat {
  model: string;
  calls: number;
  rule: string;
  hits: number;
  hitsPer100Calls: number | null;
}

export function modelRuleStats(db: Database, scope: Scope = {}): ModelRuleStat[] {
  const w = where(scope);
  const calls = new Map(q<{ model: string | null; n: number }>(db, `SELECT model, COUNT(*) AS n FROM events WHERE phase='post' AND tool_name IS NOT NULL AND ${w.sql} GROUP BY model`, w.args).map((r) => [r.model ?? "unknown", r.n]));
  const rows = q<{ model: string | null; rule_id: string; n: number }>(db, `SELECT model, rule_id, COUNT(*) AS n FROM hits WHERE observe_only=0 AND rule_id!='INTERNAL' AND ${w.sql} GROUP BY model, rule_id ORDER BY model, rule_id`, w.args);
  return rows.map((r) => {
    const m = r.model ?? "unknown";
    const c = calls.get(m) ?? 0;
    return { model: m, calls: c, rule: r.rule_id, hits: r.n, hitsPer100Calls: c ? Math.round((r.n / c) * 10000) / 100 : null };
  });
}

// ---------- judge ----------

export interface JudgeStat {
  model: string;
  calls: number;
  ok: number;
  ignores: number;
  advises: number;
  blocks: number;
  parseFail: number;
  timeouts: number;
  errors: number;
  ignoreRate: number | null;
  parseFailRate: number | null;
  latencyP50: number | null;
  latencyP95: number | null;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  costUsd: number;
  retries: number;
  formatDowngrades: number;
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
};

export function judgeStats(db: Database, scope: Scope = {}): JudgeStat[] {
  const w = where(scope);
  const rows = q<Record<string, number | string | null>>(db, `SELECT * FROM judge_calls WHERE ${w.sql} ORDER BY model`, w.args);
  const by = new Map<string, Record<string, number | string | null>[]>();
  for (const r of rows) by.set(String(r.model ?? "unknown"), [...(by.get(String(r.model ?? "unknown")) ?? []), r]);
  return [...by.entries()].map(([model, rs]) => {
    const n = (f: (r: Record<string, number | string | null>) => boolean) => rs.filter(f).length;
    const sum = (k: string) => rs.reduce((a, r) => a + (Number(r[k]) || 0), 0);
    const lat = rs.map((r) => Number(r.latency_ms)).filter((x) => Number.isFinite(x) && x > 0);
    const ok = n((r) => r.status === "ok");
    return {
      model,
      calls: rs.length,
      ok,
      ignores: n((r) => r.verdict === "ignore"),
      advises: n((r) => r.verdict === "advise"),
      blocks: n((r) => r.verdict === "block"),
      parseFail: n((r) => r.status === "parse_fail"),
      timeouts: n((r) => r.status === "timeout"),
      errors: n((r) => r.status === "error"),
      ignoreRate: rate(n((r) => r.verdict === "ignore"), rs.length),
      parseFailRate: rate(n((r) => r.status === "parse_fail"), rs.length),
      latencyP50: pct(lat, 0.5),
      latencyP95: pct(lat, 0.95),
      promptTokens: sum("prompt_tokens"),
      completionTokens: sum("completion_tokens"),
      cachedTokens: sum("cached_tokens"),
      costUsd: Math.round(sum("cost_usd") * 10000) / 10000,
      retries: sum("retries"),
      formatDowngrades: n((r) => Number(r.format_downgraded) === 1),
    };
  });
}

// ---------- 会话 ----------

export function sessionStats(db: Database, scope: Scope = {}) {
  const w = where(scope);
  return q<Record<string, unknown>>(
    db,
    `SELECT s.run_id, s.session_id, s.harness, s.model, s.project, s.calls,
            (SELECT COUNT(*) FROM hits h WHERE h.run_id=s.run_id AND h.session_id=s.session_id AND h.observe_only=0 AND h.sev='L') AS hits_L,
            (SELECT COUNT(*) FROM hits h WHERE h.run_id=s.run_id AND h.session_id=s.session_id AND h.observe_only=0 AND h.sev='M') AS hits_M,
            (SELECT COUNT(*) FROM hits h WHERE h.run_id=s.run_id AND h.session_id=s.session_id AND h.observe_only=0 AND h.sev='H') AS hits_H,
            (SELECT COUNT(*) FROM decisions d WHERE d.run_id=s.run_id AND d.session_id=s.session_id AND d.action IN ('advise','block','ask','stop_continue')) AS alarms,
            (SELECT COUNT(*) FROM judge_calls j WHERE j.run_id=s.run_id AND j.session_id=s.session_id) AS judge_calls
       FROM sessions s WHERE ${w.sql.replace(/\b(run_id|session_id)\b/g, "s.$1").replace(/\bts\b/g, "s.started_ts")} ORDER BY s.run_id, s.session_id`,
    w.args,
  );
}

// ---------- 对比两次运行（replay 调阈值） ----------

export interface RunDiffRow {
  rule: string;
  hitsA: number;
  hitsB: number;
  deltaHits: number;
  alarmsA: number;
  alarmsB: number;
  deltaAlarms: number;
  blocksA: number;
  blocksB: number;
}

export function compareRuns(db: Database, a: number, b: number): RunDiffRow[] {
  const sa = new Map(ruleStats(db, { runIds: [a] }).map((r) => [r.rule, r]));
  const sb = new Map(ruleStats(db, { runIds: [b] }).map((r) => [r.rule, r]));
  const alarms = (s?: RuleStat) => (s ? (s.actions.advise ?? 0) + (s.actions.block ?? 0) + (s.actions.ask ?? 0) + (s.actions.stop_continue ?? 0) : 0);
  return [...new Set([...sa.keys(), ...sb.keys()])].sort().map((rule) => {
    const x = sa.get(rule);
    const y = sb.get(rule);
    return { rule, hitsA: x?.hits ?? 0, hitsB: y?.hits ?? 0, deltaHits: (y?.hits ?? 0) - (x?.hits ?? 0), alarmsA: alarms(x), alarmsB: alarms(y), deltaAlarms: alarms(y) - alarms(x), blocksA: x?.actions.block ?? 0, blocksB: y?.actions.block ?? 0 };
  });
}

/** 取一次命中及其完整链路：事件 → 命中 → judge → 决策 → 投递 → 标注。`sv explain <hit-id>` 用。 */
export function explainHit(db: Database, hitId: number) {
  const hit = db.query("SELECT * FROM hits WHERE id = ?").get(hitId) as Record<string, unknown> | null;
  if (!hit) return null;
  const decisions = q<Record<string, unknown>>(db, "SELECT * FROM decisions WHERE hit_id = ? ORDER BY id", [hitId]);
  const judgeIds = decisions.map((d) => d.judge_call_id).filter((x): x is number => typeof x === "number");
  const judge = judgeIds.length ? q<Record<string, unknown>>(db, `SELECT * FROM judge_calls WHERE id IN (${judgeIds.map(() => "?").join(",")})`, judgeIds) : [];
  const decIds = decisions.map((d) => d.id as number);
  const deliveries = decIds.length ? q<Record<string, unknown>>(db, `SELECT * FROM deliveries WHERE decision_id IN (${decIds.map(() => "?").join(",")})`, decIds) : [];
  const labels = q<Record<string, unknown>>(db, "SELECT * FROM overrides WHERE target_type='hit' AND target_id = ? ORDER BY id", [hitId]);
  const evidence: number[] = JSON.parse((hit.evidence_json as string) ?? "[]");
  const events = evidence.length
    ? q<Record<string, unknown>>(db, `SELECT seq, ts, phase, tool_name, cmd_class, norm_cmd, status, exit_code, err_fp FROM events WHERE run_id = ? AND session_id = ? AND seq IN (${evidence.map(() => "?").join(",")}) ORDER BY seq`, [hit.run_id as number, hit.session_id as string, ...evidence])
    : [];
  return { hit, events, decisions, judge, deliveries, labels };
}
