// 日志库：写入、保留期清理、JSONL 镜像/导出（design §18）。
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { redact } from "../redact.ts";
import { DDL, MIGRATIONS_V2, SCHEMA_VERSION, TABLES, type TableName } from "./schema.ts";

export function expandHome(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

export interface StoreOptions {
  /** 非空时，每条记录同时追加到该目录下的 <table>-YYYY-MM-DD.jsonl。 */
  jsonlDir?: string | null;
  storeEventBodies?: boolean;
  storeJudgeBodies?: boolean;
  /** 注入时钟（测试用）。 */
  now?: () => number;
}

type Row = Record<string, unknown>;
const json = (x: unknown) => (x === undefined || x === null ? null : JSON.stringify(x));
const bool = (x: unknown) => (x === undefined || x === null ? null : x ? 1 : 0);

export class LogStore {
  readonly db: Database;
  private readonly jsonlDir: string | null;
  readonly storeEventBodies: boolean;
  readonly storeJudgeBodies: boolean;
  private readonly now: () => number;

  constructor(path: string, opts: StoreOptions = {}) {
    const p = path === ":memory:" ? path : resolve(expandHome(path));
    if (p !== ":memory:") mkdirSync(dirname(p), { recursive: true });
    this.db = new Database(p, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.db.run("PRAGMA busy_timeout = 3000");
    this.jsonlDir = opts.jsonlDir ? resolve(expandHome(opts.jsonlDir)) : null;
    this.storeEventBodies = opts.storeEventBodies ?? true;
    this.storeJudgeBodies = opts.storeJudgeBodies ?? true;
    this.now = opts.now ?? Date.now;
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    for (const stmt of DDL) this.db.run(stmt);
    const cur = this.db.query("SELECT value FROM schema_meta WHERE key='schema_version'").get() as { value: string } | null;
    if (cur && Number(cur.value) > SCHEMA_VERSION) throw new Error(`日志库 schema 版本 ${cur.value} 比当前程序（${SCHEMA_VERSION}）新`);
    // v1 → v2：旧库的 hits / decisions 缺新增的列，补上（CREATE TABLE IF NOT EXISTS 不会改已有的表）
    for (const m of MIGRATIONS_V2) {
      const cols = this.db.query(`PRAGMA table_info(${m.table})`).all() as { name: string }[];
      if (!cols.some((c) => c.name === m.column)) this.db.run(`ALTER TABLE ${m.table} ADD COLUMN ${m.column} ${m.type}`);
    }
    this.db.run("CREATE INDEX IF NOT EXISTS idx_hits_severity ON hits (severity, run_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_decisions_outcome ON decisions (outcome)");
    this.db.run("INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [String(SCHEMA_VERSION)]);
  }

  get schemaVersion(): number {
    return Number((this.db.query("SELECT value FROM schema_meta WHERE key='schema_version'").get() as { value: string }).value);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  private mirror(table: TableName, row: Row): void {
    if (!this.jsonlDir) return;
    mkdirSync(this.jsonlDir, { recursive: true });
    const day = new Date(this.now()).toISOString().slice(0, 10);
    appendFileSync(join(this.jsonlDir, `${table}-${day}.jsonl`), JSON.stringify(row) + "\n");
  }

  private insert(table: TableName, row: Row): number {
    const full: Row = { ...row, logged_ts: this.now() };
    const cols = Object.keys(full);
    const res = this.db.run(`INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, cols.map((c) => full[c] as never));
    const id = Number(res.lastInsertRowid);
    this.mirror(table, { id, ...full });
    return id;
  }

  // ---------- runs / sessions ----------

  startRun(r: { kind: "live" | "replay" | "eval"; label?: string; source?: string; mode?: string; judgeMode?: string; thresholds?: unknown; thresholdsHash?: string; overrides?: string[]; config?: unknown; version?: string; ts?: number }): number {
    return this.insert("runs", {
      kind: r.kind,
      label: r.label ?? null,
      source: r.source ?? null,
      started_ts: r.ts ?? this.now(),
      mode: r.mode ?? null,
      judge_mode: r.judgeMode ?? null,
      thresholds_json: json(r.thresholds),
      thresholds_hash: r.thresholdsHash ?? null,
      overrides_json: json(r.overrides),
      config_json: json(r.config),
      version: r.version ?? null,
    });
  }

  endRun(runId: number, ts = this.now()): void {
    this.db.run("UPDATE runs SET ended_ts = ? WHERE id = ?", [ts, runId]);
  }

  upsertSession(runId: number, s: { sessionId: string; harness?: string; model?: string; cwd?: string; sourceFile?: string; parentSessionId?: string; ts?: number }): void {
    const project = s.cwd ? s.cwd.replace(/\/+$/, "") : null;
    const exists = this.db.query("SELECT id FROM sessions WHERE run_id=? AND session_id=?").get(runId, s.sessionId);
    if (!exists) {
      this.insert("sessions", {
        run_id: runId,
        session_id: s.sessionId,
        harness: s.harness ?? null,
        model: s.model ?? null,
        cwd: s.cwd ?? null,
        project,
        source_file: s.sourceFile ?? null,
        parent_session_id: s.parentSessionId ?? null,
        started_ts: s.ts ?? null,
      });
    } else {
      // model / cwd 可能是后来才知道的
      this.db.run("UPDATE sessions SET model = COALESCE(?, model), cwd = COALESCE(?, cwd), project = COALESCE(?, project), harness = COALESCE(?, harness), ended_ts = COALESCE(?, ended_ts) WHERE run_id=? AND session_id=?", [s.model ?? null, s.cwd ?? null, project, s.harness ?? null, s.ts ?? null, runId, s.sessionId]);
    }
  }

  setSessionCalls(runId: number, sessionId: string, calls: number): void {
    this.db.run("UPDATE sessions SET calls = ? WHERE run_id=? AND session_id=?", [calls, runId, sessionId]);
  }

  // ---------- 记录 ----------

  insertEvent(runId: number, e: import("../event.ts").Event): number {
    // 整条事件的 JSON 正文也要脱敏：tool.input / shell.cmd 里可能带密钥
    const body = this.storeEventBodies ? redact(JSON.stringify(e)) : null;
    return this.insert("events", {
      run_id: runId,
      session_id: e.sessionId,
      seq: e.seq,
      ts: e.ts,
      phase: e.phase,
      origin: e.origin,
      tool_use_id: e.toolUseId ?? null,
      agent_id: e.agentId ?? null,
      model: e.model ?? null,
      tool_name: e.tool?.name ?? null,
      tool_kind: e.tool?.kind ?? null,
      cmd_class: e.shell?.cls ?? null,
      args_hash: e.tool?.argsHash ?? null,
      norm_cmd: e.shell?.normCmd ? redact(e.shell.normCmd) : null,
      mutating: bool(e.shell?.mutating),
      status: e.result?.status ?? null,
      exit_code: e.result?.exitCode ?? null,
      err_fp: e.result?.errFingerprint ?? null,
      out_hash: e.result?.outHash ?? null,
      ws_fp: e.wsFingerprint ?? null,
      context_tokens: e.usage?.contextTokens ?? null,
      body_json: body,
    });
  }

  insertHit(
    runId: number,
    h: { sessionId: string; seq: number; ts: number; callIndex?: number; ruleId: string; sev: string; category?: string; phase?: string; key?: string; evidence?: number[]; observed?: unknown; threshold?: unknown; detail?: unknown; message?: string; verified?: boolean; observeOnly?: boolean; blockable?: boolean; explicit?: boolean; model?: string; severity?: string; dangerCategory?: string; dangerSubject?: string; dangerReason?: string },
  ): number {
    return this.insert("hits", {
      run_id: runId,
      session_id: h.sessionId,
      seq: h.seq,
      ts: h.ts,
      call_index: h.callIndex ?? null,
      rule_id: h.ruleId,
      sev: h.sev,
      category: h.category ?? null,
      phase: h.phase ?? null,
      key: h.key ?? null,
      evidence_json: json(h.evidence),
      observed_json: json(h.observed),
      threshold_json: json(h.threshold),
      detail_json: h.detail === undefined ? null : redact(JSON.stringify(h.detail)),
      message: h.message ? redact(h.message) : null,
      verified: bool(h.verified),
      observe_only: h.observeOnly ? 1 : 0,
      blockable: h.blockable ? 1 : 0,
      explicit: h.explicit ? 1 : 0,
      model: h.model ?? null,
      severity: h.severity ?? ({ L: "low", M: "medium", H: "high" } as Record<string, string>)[h.sev] ?? null,
      danger_category: h.dangerCategory ?? null,
      danger_subject: h.dangerSubject ? redact(h.dangerSubject) : null,
      danger_reason: h.dangerReason ? redact(h.dangerReason) : null,
    });
  }

  insertJudgeCall(
    runId: number,
    c: { sessionId: string; ts: number; ruleIds: string[]; sync: boolean; routeModel?: string; model?: string; status: string; verdict?: string; confidence?: number; category?: string; messageRaw?: string | null; reason?: string; latencyMs?: number; promptTokens?: number; completionTokens?: number; cachedTokens?: number; costUsd?: number; retries?: number; httpRequests?: number; formatLevel?: string; formatDowngraded?: boolean; repairs?: string[]; error?: string; request?: string; response?: string },
  ): number {
    const bodies = this.storeJudgeBodies;
    return this.insert("judge_calls", {
      run_id: runId,
      session_id: c.sessionId,
      ts: c.ts,
      rule_ids: c.ruleIds.join(","),
      sync: bool(c.sync),
      route_model: c.routeModel ?? null,
      model: c.model ?? null,
      status: c.status,
      verdict: c.verdict ?? null,
      confidence: c.confidence ?? null,
      category: c.category ?? null,
      message_raw: c.messageRaw ? redact(c.messageRaw) : null,
      reason: c.reason ? redact(c.reason) : null,
      latency_ms: c.latencyMs ?? null,
      prompt_tokens: c.promptTokens ?? null,
      completion_tokens: c.completionTokens ?? null,
      cached_tokens: c.cachedTokens ?? null,
      cost_usd: c.costUsd ?? null,
      retries: c.retries ?? null,
      http_requests: c.httpRequests ?? null,
      format_level: c.formatLevel ?? null,
      format_downgraded: bool(c.formatDowngraded),
      repairs_json: json(c.repairs),
      error: c.error ? redact(c.error).slice(0, 500) : null,
      request_json: bodies && c.request ? redact(c.request) : null,
      response_json: bodies && c.response ? redact(c.response) : null,
    });
  }

  insertDecision(
    runId: number,
    d: { sessionId: string; hitId: number; judgeCallId?: number; ts: number; ruleId: string; action: string; applied: boolean; mode?: string; reason?: string; suppressedBy?: string; message?: string; wouldBlockIfVerified?: boolean; atNextPre?: boolean; counted?: boolean; outcome?: string },
  ): number {
    return this.insert("decisions", {
      run_id: runId,
      session_id: d.sessionId,
      hit_id: d.hitId,
      judge_call_id: d.judgeCallId ?? null,
      ts: d.ts,
      rule_id: d.ruleId,
      action: d.action,
      applied: d.applied ? 1 : 0,
      mode: d.mode ?? null,
      reason: d.reason ?? null,
      suppressed_by: d.suppressedBy ?? null,
      message: d.message ? redact(d.message) : null,
      would_block_if_verified: bool(d.wouldBlockIfVerified),
      at_next_pre: bool(d.atNextPre),
      counted: bool(d.counted),
      outcome: d.outcome ?? null,
    });
  }

  insertDelivery(
    runId: number,
    d: { sessionId: string; decisionId: number; ruleId: string; ts: number; channel: string; delivered: boolean; deliveredTs?: number; expiredReason?: string; text?: string; watch?: unknown },
  ): number {
    return this.insert("deliveries", {
      run_id: runId,
      session_id: d.sessionId,
      decision_id: d.decisionId,
      rule_id: d.ruleId,
      ts: d.ts,
      channel: d.channel,
      delivered: d.delivered ? 1 : 0,
      delivered_ts: d.deliveredTs ?? null,
      expired_reason: d.expiredReason ?? null,
      text: d.text ? redact(d.text) : null,
      watch_json: json(d.watch),
    });
  }

  setCompliance(deliveryId: number, complied: boolean | null, note?: string): void {
    this.db.run("UPDATE deliveries SET complied = ?, compliance_note = ? WHERE id = ?", [bool(complied), note ?? null, deliveryId]);
    this.mirror("deliveries", { id: deliveryId, complied, compliance_note: note, update: true });
  }

  insertOverride(o: { runId?: number; sessionId?: string; ts?: number; kind: OverrideKind; targetType: "session" | "hit" | "decision" | "judge_call"; targetId?: number; actor?: string; note?: string }): number {
    return this.insert("overrides", {
      run_id: o.runId ?? null,
      session_id: o.sessionId ?? null,
      ts: o.ts ?? this.now(),
      kind: o.kind,
      target_type: o.targetType,
      target_id: o.targetId ?? null,
      actor: o.actor ?? "user",
      note: o.note ? redact(o.note) : null,
    });
  }

  /** 把一次命中标为误报 / 有用（覆盖之前的标注：最新一条为准）。 */
  mark(hitId: number, label: "false_positive" | "useful", note?: string): number {
    const hit = this.db.query("SELECT run_id, session_id FROM hits WHERE id = ?").get(hitId) as { run_id: number; session_id: string } | null;
    if (!hit) throw new Error(`没有 id=${hitId} 的命中`);
    return this.insertOverride({ runId: hit.run_id, sessionId: hit.session_id, kind: label === "false_positive" ? "mark_false_positive" : "mark_useful", targetType: "hit", targetId: hitId, note });
  }

  insertAdapterHealth(h: { ts?: number; harness: string; ok: boolean; error?: string }): number {
    return this.insert("adapter_health", { ts: h.ts ?? this.now(), harness: h.harness, ok: h.ok ? 1 : 0, error: h.error ? redact(h.error).slice(0, 300) : null });
  }

  // ---------- 保留期 ----------

  /**
   * 删除 logged_ts 早于保留期的行。被人工标注过的命中（及其决策/投递）不删——标注是人工成本。
   * retentionDays<=0 表示不清理。返回每张表删除的行数。
   */
  prune(retentionDays: number, now = this.now()): Record<string, number> {
    const out: Record<string, number> = {};
    if (!(retentionDays > 0)) return out;
    const cutoff = now - retentionDays * 86_400_000;
    const labeled = `(SELECT target_id FROM overrides WHERE target_type='hit' AND kind IN ('mark_false_positive','mark_useful'))`;
    const del = (name: string, sql: string, ...args: unknown[]) => {
      const r = this.db.run(sql, args as never[]);
      out[name] = Number(r.changes);
    };
    this.transaction(() => {
      del("deliveries", `DELETE FROM deliveries WHERE logged_ts < ? AND decision_id NOT IN (SELECT id FROM decisions WHERE hit_id IN ${labeled})`, cutoff);
      del("decisions", `DELETE FROM decisions WHERE logged_ts < ? AND hit_id NOT IN ${labeled}`, cutoff);
      del("hits", `DELETE FROM hits WHERE logged_ts < ? AND id NOT IN ${labeled}`, cutoff);
      del("judge_calls", `DELETE FROM judge_calls WHERE logged_ts < ? AND id NOT IN (SELECT judge_call_id FROM decisions WHERE judge_call_id IS NOT NULL)`, cutoff);
      del("events", `DELETE FROM events WHERE logged_ts < ?`, cutoff);
      del("adapter_health", `DELETE FROM adapter_health WHERE logged_ts < ?`, cutoff);
      del("overrides", `DELETE FROM overrides WHERE logged_ts < ? AND kind NOT IN ('mark_false_positive','mark_useful')`, cutoff);
      del("sessions", `DELETE FROM sessions WHERE logged_ts < ? AND NOT EXISTS (SELECT 1 FROM hits h WHERE h.run_id = sessions.run_id AND h.session_id = sessions.session_id)`, cutoff);
      del("runs", `DELETE FROM runs WHERE logged_ts < ? AND ended_ts IS NOT NULL AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.run_id = runs.id) AND NOT EXISTS (SELECT 1 FROM hits h WHERE h.run_id = runs.id)`, cutoff);
    });
    return out;
  }

  // ---------- JSONL 导出 ----------

  /** 把所有表导出为 <dir>/<table>.jsonl，返回每张表的行数。 */
  exportJsonl(dir: string): Record<string, number> {
    const d = resolve(expandHome(dir));
    mkdirSync(d, { recursive: true });
    const counts: Record<string, number> = {};
    for (const t of TABLES) {
      const rows = this.db.query(`SELECT * FROM ${t} ORDER BY rowid`).all() as Row[];
      writeFileSync(join(d, `${t}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
      counts[t] = rows.length;
    }
    return counts;
  }

  count(table: TableName): number {
    return (this.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  }
}

export type OverrideKind = "sv_off" | "sv_quiet" | "sv_unmute" | "manual_allow" | "manual_reject" | "mark_false_positive" | "mark_useful" | "mark_reviewed";
