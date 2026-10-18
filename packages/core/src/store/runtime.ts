// 运行状态表：outbox（原子领取 + 租约 + 复核前置条件 + 过期丢弃）、injections（origin 哈希）、plans（design §3.4 / P0-8 / §10）。
import { shortHash } from "../hash.ts";
import type { Plan } from "../plan.ts";
import { redact } from "../redact.ts";
import type { LogStore } from "./store.ts";

export type OutboxKind = "advise" | "block" | "ask" | "stop_continue";
export type OutboxState = "pending" | "claimed" | "delivered" | "stale" | "expired";

export interface OutboxRow {
  id: number;
  session_id: string;
  run_id: number | null;
  decision_id: number | null;
  rule_id: string | null;
  category: string | null;
  kind: OutboxKind;
  text: string;
  delivery_id: string;
  created_seq: number | null;
  created_ts: number;
  expires_ts: number | null;
  precondition_json: string | null;
  state: OutboxState;
  lease_until: number | null;
  claimed_by: string | null;
  attempts: number;
  delivered_ts: number | null;
  delivered_channel: string | null;
  stale_reason: string | null;
}

/** 投递前要复核的前置条件（design §3.4）：条件不再成立的消息丢弃并记为 stale。 */
export interface Precondition {
  /** 「同一错误指纹仍是最近一次结果」。 */
  errFp?: string;
  /** 「工作区指纹没变」。 */
  ws?: string;
  /** 入队后最多再过多少步（调用）仍然有效。 */
  maxSteps?: number;
  createdStep?: number;
  /** 绑定到产生这条消息的那次调用（OpenCode：拦截只能在 permission.evaluate 上领取，evaluate 本身不带 callID）。
   *  只有该调用仍是「最近一次、还没结束的 pre」时才有效；空串 = 无法绑定，一律失效（fail-open）。 */
  callId?: string;
}

export interface PreconditionView {
  steps: number;
  lastErrFp?: string;
  lastWs?: string;
  /** 最近一次 pre 的 toolUseId，且它还没有 post（还在进行中）；否则 undefined。 */
  openCallId?: string;
}

/** 返回 null 表示条件成立；否则返回失效原因。 */
export function checkPrecondition(pre: Precondition | null | undefined, v: PreconditionView): string | null {
  if (!pre) return null;
  if (pre.errFp !== undefined && v.lastErrFp !== pre.errFp) return "最近一次结果的错误指纹已变化";
  if (pre.ws !== undefined && v.lastWs !== pre.ws) return "工作区指纹已变化";
  if (pre.callId !== undefined && (pre.callId === "" || v.openCallId !== pre.callId)) return "产生拦截的那次调用已结束，或已有新的调用";
  if (pre.maxSteps !== undefined && pre.createdStep !== undefined && v.steps - pre.createdStep > pre.maxSteps) return "超过有效步数";
  return null;
}

export interface EnqueueInput {
  sessionId: string;
  runId?: number;
  decisionId?: number;
  ruleId?: string;
  category?: string;
  kind: OutboxKind;
  text: string;
  /** 唯一键：同一个 deliveryId 只入队一次。 */
  deliveryId: string;
  createdSeq?: number;
  ttlMs?: number;
  precondition?: Precondition;
}

export class Outbox {
  constructor(private readonly store: LogStore, private readonly now: () => number = Date.now) {}

  private get db() {
    return this.store.db;
  }

  /** 入队；deliveryId 重复返回 null（去重）。文本落盘前脱敏。 */
  enqueue(m: EnqueueInput): number | null {
    const ts = this.now();
    const r = this.db
      .query(
        `INSERT INTO outbox (session_id, run_id, decision_id, rule_id, category, kind, text, delivery_id, created_seq, created_ts, expires_ts, precondition_json, state, attempts, logged_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)
         ON CONFLICT(delivery_id) DO NOTHING RETURNING id`,
      )
      .get(m.sessionId, m.runId ?? null, m.decisionId ?? null, m.ruleId ?? null, m.category ?? null, m.kind, redact(m.text), m.deliveryId, m.createdSeq ?? null, ts, m.ttlMs ? ts + m.ttlMs : null, m.precondition ? JSON.stringify(m.precondition) : null, ts) as { id: number } | null;
    return r ? r.id : null;
  }

  /**
   * 原子领取一条：单条 `UPDATE … WHERE id = (SELECT …) RETURNING *`，SQLite 的写锁保证
   * 多个进程/连接同时领取时每条消息只会被一个领取者拿到。
   * 可领取 = pending，或租约已过期的 claimed（回收，attempts+1）；已过有效期的不领。
   */
  claim(o: { sessionId: string; claimer: string; leaseMs: number; kinds?: OutboxKind[] }): OutboxRow | null {
    const t = this.now();
    const kinds = o.kinds ?? ["advise", "block", "ask", "stop_continue"];
    const row = this.db
      .query(
        `UPDATE outbox SET state = 'claimed', lease_until = ?, claimed_by = ?, attempts = attempts + 1
          WHERE id = (SELECT id FROM outbox
                       WHERE session_id = ? AND kind IN (${kinds.map(() => "?").join(",")})
                         AND (state = 'pending' OR (state = 'claimed' AND lease_until <= ?))
                         AND (expires_ts IS NULL OR expires_ts > ?)
                       ORDER BY id LIMIT 1)
        RETURNING *`,
      )
      .get(t + o.leaseMs, o.claimer, o.sessionId, ...kinds, t, t) as OutboxRow | null;
    return row;
  }

  /** 只有当前持有租约的领取者才能确认投递（租约被别人回收后，旧领取者的确认无效）。 */
  markDelivered(id: number, claimer: string, channel: string): boolean {
    const r = this.db.run("UPDATE outbox SET state='delivered', delivered_ts=?, delivered_channel=?, lease_until=NULL WHERE id=? AND state='claimed' AND claimed_by=?", [this.now(), channel, id, claimer]);
    return r.changes === 1;
  }

  /** 复核失败：前置条件不再成立，丢弃并记原因。 */
  markStale(id: number, claimer: string, reason: string): boolean {
    const r = this.db.run("UPDATE outbox SET state='stale', stale_reason=?, lease_until=NULL WHERE id=? AND state='claimed' AND claimed_by=?", [reason, id, claimer]);
    return r.changes === 1;
  }

  /** 放回队列（比如这个注入点放不下这类消息）。 */
  release(id: number, claimer: string): boolean {
    const r = this.db.run("UPDATE outbox SET state='pending', claimed_by=NULL, lease_until=NULL WHERE id=? AND state='claimed' AND claimed_by=?", [id, claimer]);
    return r.changes === 1;
  }

  /** 把过了有效期、还没送出的消息标为 expired（pending，或租约也过期的 claimed）。 */
  expireOld(): number {
    const t = this.now();
    return this.db.run("UPDATE outbox SET state='expired' WHERE expires_ts IS NOT NULL AND expires_ts <= ? AND (state='pending' OR (state='claimed' AND lease_until <= ?))", [t, t]).changes;
  }

  get(id: number): OutboxRow | null {
    return this.db.query("SELECT * FROM outbox WHERE id = ?").get(id) as OutboxRow | null;
  }

  list(sessionId: string, states?: OutboxState[]): OutboxRow[] {
    const st = states ?? ["pending", "claimed", "delivered", "stale", "expired"];
    return this.db.query(`SELECT * FROM outbox WHERE session_id = ? AND state IN (${st.map(() => "?").join(",")}) ORDER BY id`).all(sessionId, ...st) as OutboxRow[];
  }

  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db.query("SELECT state, COUNT(*) AS n FROM outbox GROUP BY state").all() as { state: string; n: number }[]) out[r.state] = r.n;
    return out;
  }

  /** 保留期清理：只删终态（delivered / stale / expired）。 */
  prune(cutoffLoggedTs: number): number {
    return this.db.run("DELETE FROM outbox WHERE state IN ('delivered','stale','expired') AND logged_ts < ?", [cutoffLoggedTs]).changes;
  }
}

// ---------- injections（origin 哈希）----------

export function normForHash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function saveInjection(store: LogStore, sessionId: string, text: string, ts = Date.now()): void {
  store.db.run("INSERT INTO injections (session_id, hash, ts, text_len, logged_ts) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id, hash) DO NOTHING", [sessionId, shortHash(normForHash(text)), ts, text.length, Date.now()]);
}

export function loadInjectionHashes(store: LogStore, sessionId: string): string[] {
  return (store.db.query("SELECT hash FROM injections WHERE session_id = ?").all(sessionId) as { hash: string }[]).map((r) => r.hash);
}

export function hasInjection(store: LogStore, sessionId: string, text: string): boolean {
  return !!store.db.query("SELECT 1 FROM injections WHERE session_id = ? AND hash = ?").get(sessionId, shortHash(normForHash(text)));
}

// ---------- plans ----------

export function savePlan(store: LogStore, sessionId: string, plan: Plan, ts = Date.now()): void {
  store.db.run(
    `INSERT INTO plans (session_id, source, items_json, text, explicit_allow_json, updated_ts, logged_ts) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET source=excluded.source, items_json=excluded.items_json, text=excluded.text, explicit_allow_json=excluded.explicit_allow_json, updated_ts=excluded.updated_ts, logged_ts=excluded.logged_ts`,
    [sessionId, plan.source, JSON.stringify(plan.items), redact(plan.text), JSON.stringify(plan.explicitAllow), ts, Date.now()],
  );
}

export function loadPlan(store: LogStore, sessionId: string): Plan | null {
  const r = store.db.query("SELECT * FROM plans WHERE session_id = ?").get(sessionId) as { source: "auto" | "file"; items_json: string; text: string | null; explicit_allow_json: string | null } | null;
  if (!r) return null;
  return { source: r.source, items: JSON.parse(r.items_json), text: r.text ?? "", explicitAllow: JSON.parse(r.explicit_allow_json ?? "[]") };
}
