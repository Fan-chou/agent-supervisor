// supervisord：常驻守护进程。接收 hook 事件 → 规整成 Event → Engine.feed → LogSink 一个事务写入；
// 把要送给 agent 的消息放进 outbox，在合适的注入点原子领取并送出（design §1、§3.4）。
// 约束：任何内部错误都 fail-open（返回空决定，不阻断 agent）；mode=shadow 时永不产生会生效的拦截（含 X2，只记 would_have_*）。
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  Engine, LogStore, Outbox, StoreSink, beginRun, truncate, checkPrecondition, computeWsFingerprint, createJudgeClient, expandHome, loadInjectionHashes, loadPlan, parsePlanMd, saveInjection, savePlan, wsToString,
  type Config, type Decision, type Delivery, type JudgeFn, type OutboxKind, type Precondition, type StepRecord, type JudgeClient,
} from "@sv/core";
import { normalizeClaudeHook, type ClaudeHookPayload } from "../../adapter-claude/src/index.ts";
import { handleCompare, handleQuery } from "./query-api.ts";
import { normalizeOpenCodeEvent, type OpenCodePayload } from "../../adapter-opencode/src/index.ts";
import { normalizeCodexHook, type CodexHookPayload } from "../../adapter-codex/src/index.ts";

export const PROTOCOL = 1;
export const DAEMON_VERSION = "0.1.0-m3";

export interface DaemonOptions {
  cfg: Config;
  /** 数据目录（socket、token、hook.json、spool 都在这里），默认 ~/.agent-supervisor。 */
  home?: string;
  dbPath?: string;
  socketPath?: string;
  /** 额外监听 127.0.0.1:port（必须带 token）。0 = 随机端口。不传则只监听 UDS。 */
  port?: number;
  /** 注入 judge（测试用）；不传时按 cfg.judge.enabled 创建真实客户端。 */
  judge?: JudgeFn;
  now?: () => number;
  /** Stop 钩子里最多等后台 judge 多久（毫秒），默认 3500（Stop 硬超时 4 秒）。 */
  stopWaitMs?: number;
  idleEvictMs?: number;
  /** 测试用：不创建 UDS，只用 TCP。 */
  noUnix?: boolean;
}

export interface HookResponse {
  ok: boolean;
  protocol: number;
  /** 要输出给 harness 的消息；null = 没有要说的（hook 应当 exit 0 且不输出）。 */
  delivery: Delivery | null;
  /** Claude/Codex 的钩子名，或 OpenCode 的 permission.evaluate / context。 */
  hookPoint: string | null;
  mode: Config["mode"];
  error?: string;
  /** 调试/日志：本次处理了哪些事件。 */
  seqs?: number[];
}

export type HookHarness = "claude" | "codex" | "opencode";
export const HARNESSES: readonly HookHarness[] = ["claude", "codex", "opencode"];

interface Runtime {
  harness: HookHarness;
  sessionId: string;
  engine: Engine;
  sink: StoreSink;
  seq: number;
  chain: Promise<unknown>;
  lastActive: number;
  model?: string;
  /** decision → 日志行 id（sink 回调填，用来把 outbox 和 deliveries 对上）。 */
  ids: WeakMap<Decision, { decisionId: number; deliveryRowId?: number }>;
  planStamp?: unknown;
  planChecked: boolean;
  /** OpenCode：最近一次 tool.before 的 callID（拦截决定要绑定到它，见 Precondition.callId）。 */
  lastPreId?: string;
}

const DIRECT_AT_PRE: OutboxKind[] = ["block", "ask", "advise"];
const KINDS_AT: Record<string, OutboxKind[]> = {
  // OpenCode V2：拦截只在 permission.evaluate（deny 必须带 message），建议只在 context hook；tool.before/after 只收事件
  "permission.evaluate": ["block", "ask"],
  context: ["advise"],
  PreToolUse: DIRECT_AT_PRE,
  PostToolUse: ["advise"],
  PostToolUseFailure: ["advise"],
  PostToolBatch: ["advise"],
  Stop: ["stop_continue"],
};

export class Daemon {
  readonly cfg: Config;
  readonly home: string;
  readonly store: LogStore;
  readonly outbox: Outbox;
  readonly runId: number;
  readonly judgeClient?: JudgeClient;
  readonly judge?: JudgeFn;
  readonly socketPath?: string;
  readonly token: string;
  readonly startedAt: number;
  port?: number;
  private servers: { stop(force?: boolean): void | Promise<void> }[] = [];
  private sessions = new Map<string, Runtime>();
  private pendingDeferred = new Set<Promise<unknown>>();
  private lastHealthOk = new Map<string, number>();
  private evictTimer?: ReturnType<typeof setInterval>;
  private readonly now: () => number;
  private stopped = false;
  private readonly claimer = `daemon-${process.pid}`;

  private constructor(private readonly opts: DaemonOptions) {
    this.cfg = opts.cfg;
    this.now = opts.now ?? Date.now;
    this.home = expandHome(opts.home ?? "~/.agent-supervisor");
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.home, 0o700);
    } catch {
      /* 不是我们创建的目录就不强行改 */
    }
    this.store = new LogStore(opts.dbPath ?? (opts.home ? join(this.home, "state.db") : this.cfg.log.db), { jsonlDir: this.cfg.log.jsonl_dir, storeEventBodies: this.cfg.log.store_event_bodies, storeJudgeBodies: this.cfg.log.store_judge_bodies, now: this.now });
    this.outbox = new Outbox(this.store, this.now);
    this.startedAt = this.now();
    if (opts.judge) this.judge = opts.judge;
    else if (this.cfg.judge.enabled) {
      this.judgeClient = createJudgeClient({ cfg: this.cfg.judge });
      this.judge = this.judgeClient.judge;
    }
    this.runId = beginRun(this.store, this.cfg, { kind: "live", label: "daemon", source: `pid ${process.pid}`, judgeMode: this.judge ? "live" : "off", version: DAEMON_VERSION, ts: this.startedAt });
    this.token = this.loadOrCreateToken();
    this.socketPath = opts.noUnix ? undefined : expandHome(opts.socketPath ?? this.cfg.runtime.socket.replace("~/.agent-supervisor", this.home));
  }

  static async start(opts: DaemonOptions): Promise<Daemon> {
    const d = new Daemon(opts);
    await d.listen();
    d.ingestSpool();
    d.writeHookConfig();
    d.evictTimer = setInterval(() => d.evictIdle(), 60_000);
    (d.evictTimer as { unref?: () => void }).unref?.();
    return d;
  }

  // ---------- 本地鉴权 ----------

  private loadOrCreateToken(): string {
    const p = join(this.home, "token");
    if (existsSync(p)) {
      const t = readFileSync(p, "utf8").trim();
      if (t) return t;
    }
    const t = randomBytes(32).toString("hex");
    writeFileSync(p, t + "\n", { mode: 0o600 });
    chmodSync(p, 0o600);
    return t;
  }

  private authorized(req: Request, viaUnix: boolean): boolean {
    if (viaUnix) return true; // UDS 靠 0600 的 socket 文件和 0700 的目录做访问控制
    const h = req.headers.get("authorization") ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) return false;
    const a = Buffer.from(m[1].trim());
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private async listen(): Promise<void> {
    const handler = (viaUnix: boolean) => (req: Request) => this.route(req, viaUnix);
    if (this.socketPath) {
      mkdirSync(dirname(this.socketPath), { recursive: true, mode: 0o700 });
      if (existsSync(this.socketPath)) {
        // 残留的旧 socket（上次崩溃）：能连上说明另一个守护进程在跑，拒绝启动；连不上就清掉
        const alive = await fetch("http://localhost/v1/hello", { unix: this.socketPath, signal: AbortSignal.timeout(500) }).then(() => true, () => false);
        if (alive) throw new Error(`已有守护进程在监听 ${this.socketPath}`);
        unlinkSync(this.socketPath);
      }
      const prevMask = process.umask(0o077); // 创建 socket 的瞬间就是 0600，没有可被他人连接的窗口
      try {
        const s = Bun.serve({ unix: this.socketPath, fetch: handler(true), maxRequestBodySize: 4 * 1024 * 1024 });
        this.servers.push(s);
      } finally {
        process.umask(prevMask);
      }
      chmodSync(this.socketPath, 0o600);
    }
    if (this.opts.port !== undefined) {
      const s = Bun.serve({ hostname: "127.0.0.1", port: this.opts.port, fetch: handler(false), maxRequestBodySize: 4 * 1024 * 1024 });
      this.port = s.port;
      this.servers.push(s);
    }
  }

  /** hook 在守护进程不可达时也要知道 mode / socket 位置：写一个只含这些的小文件。 */
  private writeHookConfig(): void {
    const p = join(this.home, "hook.json");
    const tmp = p + ".tmp";
    writeFileSync(tmp, JSON.stringify({ protocol: PROTOCOL, mode: this.cfg.mode, socket: this.socketPath, port: this.port, pid: process.pid, startedAt: this.startedAt, updatedAt: this.now() }, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, p);
  }

  // ---------- HTTP 路由 ----------

  private async route(req: Request, viaUnix: boolean): Promise<Response> {
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-sv-protocol": String(PROTOCOL), "x-sv-daemon-version": DAEMON_VERSION } });
    let harness: HookHarness | "claude" = "claude"; // 出错时记到哪个适配器的健康度上（请求体里带了 harness 就用它）
    try {
      if (!this.authorized(req, viaUnix)) return json(401, { error: { code: "unauthorized", message: "缺少或无效的 token", retryable: false } });
      const url = new URL(req.url);
      const proto = req.headers.get("x-sv-protocol");
      if (proto !== null && Number(proto) !== PROTOCOL) return json(426, { error: { code: "protocol_mismatch", message: `守护进程协议 ${PROTOCOL}，客户端 ${proto}`, retryable: false } });
      if (req.method === "GET" && url.pathname === "/v1/hello") return json(200, { protocol: PROTOCOL, version: DAEMON_VERSION, mode: this.cfg.mode, startedAt: this.startedAt });
      if (req.method === "GET" && url.pathname === "/v1/status") return json(200, this.status());
      // 前端的只读查询（不在 hook 路径上；出错只是这一次查询 500，被 catch 住）
      try {
        const q = handleQuery(this.store.db, req.method, url) ?? handleCompare(this.store.db, req.method, url);
        if (q) return json(q.status, q.body);
      } catch (err) {
        // 查询失败只影响这一次查询：不算适配器故障，也不动 hook 路径
        return json(500, { error: { code: "query_failed", message: String((err as Error)?.message ?? err).slice(0, 200), retryable: true } });
      }
      if (req.method === "POST" && url.pathname === "/v1/hook") {
        const body = (await req.json()) as { harness?: string; payload?: ClaudeHookPayload };
        if (!HARNESSES.includes(body.harness as HookHarness) || !body.payload || typeof body.payload !== "object") return json(400, { error: { code: "bad_request", message: "需要 {harness:'claude'|'codex'|'opencode', payload}", retryable: false } });
        harness = body.harness as HookHarness;
        return json(200, await this.handleHook(body.payload, harness));
      }
      if (req.method === "POST" && url.pathname === "/v1/adapter-health") {
        const b = (await req.json()) as { harness?: string; ok?: boolean; error?: string };
        this.store.insertAdapterHealth({ ts: this.now(), harness: String(b.harness ?? "unknown"), ok: b.ok !== false, error: b.error });
        return json(200, { ok: true });
      }
      return json(404, { error: { code: "not_found", message: url.pathname, retryable: false } });
    } catch (err) {
      // fail-open：内部错误不能让 agent 被卡住；返回 200 + 空决定，同时记一条适配器健康异常
      this.safeHealth(harness as string, false, `daemon_error: ${String((err as Error)?.message ?? err)}`);
      return json(200, { ok: false, protocol: PROTOCOL, delivery: null, hookPoint: null, mode: this.cfg.mode, error: "internal" } satisfies HookResponse);
    }
  }

  status() {
    const since = this.now() - 15 * 60_000;
    const fails = (this.store.db.query("SELECT harness, COUNT(*) AS n FROM adapter_health WHERE ok = 0 AND ts >= ? GROUP BY harness").all(since) as { harness: string; n: number }[]);
    return {
      protocol: PROTOCOL,
      version: DAEMON_VERSION,
      mode: this.cfg.mode,
      startedAt: this.startedAt,
      runId: this.runId,
      db: this.store.db.filename,
      sessions: this.sessions.size,
      outbox: this.outbox.counts(),
      adapterFailures15m: Object.fromEntries(fails.map((f) => [f.harness, f.n])),
      judge: this.judge ? { enabled: true, base_url: this.cfg.judge.base_url, model: this.cfg.judge.model, stats: this.judgeClient ? Object.fromEntries(this.judgeClient.stats) : undefined } : { enabled: false },
    };
  }

  // ---------- 适配器健康 ----------

  private safeHealth(harness: string, ok: boolean, error?: string): void {
    try {
      this.store.insertAdapterHealth({ ts: this.now(), harness, ok, error });
    } catch {
      /* 日志失败不影响监督 */
    }
  }

  /** hook 在守护进程不可达时写下的失败记录（health-spool.jsonl）：下次能连上时补记为 adapter_health。 */
  ingestSpool(): number {
    const p = join(this.home, "health-spool.jsonl");
    if (!existsSync(p)) return 0;
    const tmp = p + `.${process.pid}.ingest`;
    try {
      renameSync(p, tmp); // 原子取走，hook 之后的新写入进新文件
    } catch {
      return 0;
    }
    let n = 0;
    for (const line of readFileSync(tmp, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as { ts?: number; harness?: string; error?: string };
        this.store.insertAdapterHealth({ ts: r.ts ?? this.now(), harness: r.harness ?? "unknown", ok: false, error: r.error ?? "unreachable" });
        n++;
      } catch {
        /* 损坏的行跳过 */
      }
    }
    unlinkSync(tmp);
    return n;
  }

  // ---------- 会话运行时 ----------

  private runtime(harness: HookHarness, sessionId: string, cwd?: string): Runtime {
    // 内存里的运行时按 (harness, sessionId) 分开；持久化表（sessions/outbox/injections/plans）仍只按 session_id，依赖 session id 是 UUID
    const key = `${harness}:${sessionId}`;
    let rt = this.sessions.get(key);
    if (rt) return rt;
    const ids = new WeakMap<Decision, { decisionId: number; deliveryRowId?: number }>();
    const sink = new StoreSink(this.store, { runId: this.runId, deferredDelivery: true, onDecisionLogged: (d, i) => ids.set(d, i) });
    const engine = new Engine({ cfg: this.cfg, judge: this.judge, sink, policy: { trustInferredUnchanged: false } });
    for (const h of loadInjectionHashes(this.store, sessionId)) engine.tracker.registry.addHash(h);
    const plan = loadPlan(this.store, sessionId);
    if (plan) engine.tracker.plan = plan;
    if (cwd) engine.tracker.cwd = cwd;
    rt = { harness, sessionId, engine, sink, seq: 0, chain: Promise.resolve(), lastActive: this.now(), ids, planChecked: false };
    this.sessions.set(key, rt);
    return rt;
  }

  /** .supervisor/plan.md（项目里的计划文件）优先于 agent 自己的待办。 */
  private loadPlanFile(rt: Runtime, cwd?: string): void {
    if (rt.planChecked || !cwd) return;
    rt.planChecked = true;
    const p = join(cwd, ".supervisor", "plan.md");
    try {
      if (existsSync(p) && statSync(p).size < 200_000) rt.engine.tracker.setFilePlan(parsePlanMd(readFileSync(p, "utf8")));
    } catch {
      /* 读不到就当没有 */
    }
  }

  private evictIdle(): void {
    const limit = this.opts.idleEvictMs ?? 6 * 3_600_000;
    for (const [id, rt] of this.sessions) {
      if (this.now() - rt.lastActive > limit) {
        rt.engine.close();
        this.sessions.delete(id);
      }
    }
  }

  // ---------- hook 处理 ----------

  async handleHook(payload: ClaudeHookPayload | CodexHookPayload | OpenCodePayload, harness: HookHarness = "claude"): Promise<HookResponse> {
    // OpenCode 的线格式用 sessionID / directory；Claude/Codex 用 session_id / cwd
    const oc = harness === "opencode" ? (payload as OpenCodePayload) : undefined;
    const sessionIdGuess = String(oc ? (oc.sessionID ?? "unknown") : ((payload as ClaudeHookPayload).session_id ?? "unknown"));
    const rt = this.runtime(harness, sessionIdGuess, oc ? oc.directory : (payload as ClaudeHookPayload).cwd);
    rt.lastActive = this.now();
    // 同一会话的 hook 串行处理，保证事件顺序
    const run = rt.chain.then(() => this.process(rt, payload));
    rt.chain = run.catch(() => undefined);
    return run;
  }

  private async process(rt: Runtime, payload: ClaudeHookPayload | CodexHookPayload | OpenCodePayload): Promise<HookResponse> {
    const t = this.now();
    const nopts = { nextSeq: () => rt.seq++, now: t, classify: rt.engine.tracker.opts, model: rt.model };
    const norm =
      rt.harness === "opencode"
        ? normalizeOpenCodeEvent(payload as OpenCodePayload, nopts)
        : rt.harness === "codex"
          ? normalizeCodexHook(payload as CodexHookPayload, nopts)
          : normalizeClaudeHook(payload as ClaudeHookPayload, nopts);
    if (norm.model) rt.model = norm.model;
    if (norm.cwd && !rt.engine.tracker.cwd) rt.engine.tracker.cwd = norm.cwd;
    this.loadPlanFile(rt, norm.cwd);
    const resp: HookResponse = { ok: true, protocol: PROTOCOL, delivery: null, hookPoint: norm.hookPoint, mode: this.cfg.mode, seqs: norm.events.map((e) => e.seq) };

    let direct: Delivery | null = null;
    const records: StepRecord[] = [];
    for (const e of norm.events) {
      if (rt.harness === "opencode" && e.phase === "pre") rt.lastPreId = e.toolUseId ?? "";
      await this.attachFingerprint(rt, e);
      const rec = await rt.engine.feed(e, { deferJudge: true });
      records.push(rec);
      // OpenCode：tool.before 只收事件，拦截决定一律进 outbox，等同一次调用的 permission.evaluate 来领（deny 只能在 evaluate 上给）
      direct = direct ?? (rt.harness === "opencode" ? null : this.fromDecisions(rt, rec, norm.stopHookActive));
      this.queueApplied(rt, rec, rec.decisions, direct, norm.stopHookActive);
      this.persistPlan(rt);
      if (rec.deferred) this.runLater(rt, rec);
    }
    // Stop：最多等一小会儿后台 judge（P3 的 Stop 续跑要靠它），超时就让它在后台继续，结果走 outbox
    if (norm.hookPoint === "Stop") {
      const waits = [...this.pendingDeferred];
      if (waits.length) await Promise.race([Promise.allSettled(waits), new Promise((r) => setTimeout(r, this.opts.stopWaitMs ?? 3500))]);
    }
    // Stop 且 stop_hook_active=true：不再 block（Claude 内置续跑上限），也不消耗 outbox 里的消息
    const skipOutbox = norm.hookPoint === "Stop" && norm.stopHookActive;
    resp.delivery = direct ?? (skipOutbox ? null : this.fromOutbox(rt, norm.hookPoint));
    if (resp.delivery) this.confirmDirect(rt, resp.delivery, norm.hookPoint);
    this.healthOk(rt.harness);
    return resp;
  }

  /** 工作区指纹（design §4.3）：只在可能用于「期间无改动」判断时同步计算，带 2 秒超时。 */
  private async attachFingerprint(rt: Runtime, e: import("@sv/core").Event): Promise<void> {
    if (!e.shell || (e.phase !== "pre" && e.phase !== "post")) return;
    const cwd = e.cwd ?? rt.engine.tracker.cwd;
    if (!cwd) return;
    const cls = e.shell.cls;
    const repeated = rt.engine.tracker.steps.some((s) => s.argsHash === e.tool?.argsHash);
    if (!(repeated || cls === "test_full" || cls === "test_targeted" || cls === "build" || cls === "typecheck" || cls === "lint")) return;
    const w = await computeWsFingerprint(cwd, { timeoutMs: 2000 });
    e.wsFingerprint = wsToString(w);
  }

  /** 这次 feed 里能立刻送出的决定：pre 上的拦截/确认、stop 上的续跑。shadow/advise 下 applied=false，所以永远不会走到这里。 */
  private fromDecisions(rt: Runtime, rec: StepRecord, stopHookActive: boolean): Delivery | null {
    const e = rec.event;
    if (e.phase === "pre") {
      const d = rec.decisions.find((x) => x.applied && (x.action === "block" || x.action === "ask") && !x.atNextPre);
      return d ? this.toDelivery(rt, d) : null;
    }
    if (e.phase === "stop" && !stopHookActive) {
      const d = rec.decisions.find((x) => x.applied && x.action === "stop_continue");
      return d ? this.toDelivery(rt, d) : null;
    }
    return null;
  }

  private toDelivery(rt: Runtime, d: Decision): Delivery {
    const ids = rt.ids.get(d);
    const kind = d.action === "stop_continue" ? "stop_continue" : d.action === "ask" ? "ask" : d.action === "block" ? "block" : "advise";
    return { kind, text: truncate(d.message ?? d.reason), ruleId: d.hit.ruleId, deliveryId: `d-${this.runId}-${ids?.decisionId ?? `${rt.sessionId}-${d.hit.seq}`}`, createdAtSeq: d.hit.seq };
  }

  /** 生效的决定：不能立刻送出的（advise、post 阶段的 block、stop 已在续跑中…）放进 outbox 等注入点。 */
  private queueApplied(rt: Runtime, rec: StepRecord, decisions: Decision[], direct: Delivery | null, stopHookActive = false): void {
    const tr = rt.engine.tracker;
    for (const d of decisions) {
      if (!d.applied || !d.message) continue;
      if (!["advise", "block", "ask", "stop_continue"].includes(d.action)) continue;
      if (d.action === "stop_continue" && stopHookActive) continue;
      const ids = rt.ids.get(d);
      const deliveryId = `d-${this.runId}-${ids?.decisionId ?? `${rt.sessionId}-${d.hit.seq}-${d.hit.ruleId}`}`;
      if (direct && direct.deliveryId === deliveryId) continue; // 已经直接送出
      const lastFail = [...tr.steps].reverse().find((s) => s.status === "fail" && s.errFp);
      const real = (w?: string) => !!w && w !== "non-git" && w !== "timeout" && w !== "error";
      const pre: Precondition = { maxSteps: 10, createdStep: tr.steps.length };
      if ((d.hit.ruleId === "L1" || d.hit.ruleId === "L3") && lastFail?.errFp) pre.errFp = lastFail.errFp;
      if (["L1", "L2", "T1", "T6"].includes(d.hit.ruleId) && real(tr.lastWs)) pre.ws = tr.lastWs;
      // OpenCode：pre 阶段产生的 block/ask 绑定到这次调用（evaluate 不带 callID）；之后调用已结束或已有新的调用就作废（宁可漏拦，不误拦）
      if (rt.harness === "opencode" && rec.event.phase === "pre" && (d.action === "block" || d.action === "ask")) pre.callId = rec.event.toolUseId ?? "";
      const kind: OutboxKind = d.action === "stop_continue" ? "stop_continue" : d.action === "ask" ? "ask" : d.action === "block" ? "block" : "advise";
      this.outbox.enqueue({
        sessionId: rt.sessionId,
        runId: this.runId,
        decisionId: ids?.decisionId,
        ruleId: d.hit.ruleId,
        category: d.hit.category,
        kind,
        text: d.message,
        deliveryId,
        createdSeq: rec.event.seq,
        ttlMs: this.cfg.budgets.rule_cooldown_s * 1000,
        precondition: pre,
      });
    }
  }

  /** 后台 judge：不挡 hook；完成后迟到的决策写日志并进 outbox。 */
  private runLater(rt: Runtime, rec: StepRecord): void {
    const p = rt.engine
      .runDeferred(rec)
      .then((late) => {
        this.queueApplied(rt, rec, late, null, false);
      })
      .catch((err) => {
        console.error("[sv] 后台 judge 处理失败（已忽略）：", String(err));
      })
      .finally(() => this.pendingDeferred.delete(p));
    this.pendingDeferred.add(p);
  }

  /** 从 outbox 原子领取一条能在这个注入点送出的消息；投递前复核前置条件，不成立的丢弃（stale）。 */
  private fromOutbox(rt: Runtime, hookPoint: string | null): Delivery | null {
    if (!hookPoint) return null;
    this.outbox.expireOld();
    const tr = rt.engine.tracker;
    const lastFail = [...tr.steps].reverse().find((s) => s.status === "fail" && s.errFp);
    const lastStep = tr.last();
    for (let i = 0; i < 5; i++) {
      const row = this.outbox.claim({ sessionId: rt.sessionId, claimer: this.claimer, leaseMs: 30_000, kinds: KINDS_AT[hookPoint] });
      if (!row) return null;
      const why = checkPrecondition(row.precondition_json ? (JSON.parse(row.precondition_json) as Precondition) : null, { steps: tr.steps.length, lastErrFp: lastStep?.status === "fail" ? lastStep.errFp : lastFail && lastFail === lastStep ? lastFail.errFp : undefined, lastWs: tr.lastWs, openCallId: rt.lastPreId && tr.pending.has(rt.lastPreId) ? rt.lastPreId : undefined });
      if (why) {
        this.outbox.markStale(row.id, this.claimer, why);
        if (row.decision_id) this.store.markDeliveryDropped(row.decision_id, `stale: ${why}`);
        continue;
      }
      const kind = row.kind;
      // 登记的必须是「实际输出的字符串」：render 会 trim 并截断到 600 字符，Codex 的 Stop reason 会被当作 user prompt 回显（P0-6）
      const emitted = truncate(row.text);
      const delivery: Delivery = { kind, text: emitted, ruleId: row.rule_id ?? undefined, deliveryId: row.delivery_id, createdAtSeq: row.created_seq ?? undefined };
      this.outbox.markDelivered(row.id, this.claimer, hookPoint);
      if (row.decision_id) this.store.markDeliverySentByDecision(row.decision_id, hookPoint, this.now());
      saveInjection(this.store, rt.sessionId, emitted, this.now());
      rt.engine.tracker.registry.register(emitted);
      return delivery;
    }
    return null;
  }

  /** 直接送出的决定也要登记：deliveries 标已送达、injections 记哈希（P0-6）。 */
  private confirmDirect(rt: Runtime, d: Delivery, hookPoint: string | null): void {
    // 来自 outbox 的已经在 fromOutbox 里确认过；这里处理 fromDecisions 的直接送出
    const row = this.store.db.query("SELECT id FROM outbox WHERE delivery_id = ?").get(d.deliveryId ?? "") as { id: number } | null;
    if (row) return;
    saveInjection(this.store, rt.sessionId, d.text, this.now()); // d.text 已经是截断后的输出文本（toDelivery）
    rt.engine.tracker.registry.register(d.text);
    const decId = Number(String(d.deliveryId ?? "").split("-").pop());
    if (Number.isFinite(decId)) this.store.markDeliverySentByDecision(decId, hookPoint ?? "unknown", this.now());
  }

  private persistPlan(rt: Runtime): void {
    const plan = rt.engine.tracker.plan;
    if (plan && plan !== rt.planStamp) {
      rt.planStamp = plan;
      try {
        savePlan(this.store, rt.sessionId, plan, this.now());
      } catch {
        /* 持久化失败不影响监督 */
      }
    }
  }

  private healthOk(harness: string): void {
    const t = this.now();
    const last = this.lastHealthOk.get(harness) ?? 0;
    if (t - last > 60_000) {
      this.lastHealthOk.set(harness, t);
      this.safeHealth(harness, true);
    }
  }

  // ---------- 退出 ----------

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.evictTimer) clearInterval(this.evictTimer);
    for (const s of this.servers) await s.stop(true);
    // 给后台 judge 一点时间收尾，然后关闭每个会话的引擎（结算遵从观察窗口）并结束 run
    await Promise.race([Promise.allSettled([...this.pendingDeferred]), new Promise((r) => setTimeout(r, 2000))]);
    for (const rt of this.sessions.values()) rt.engine.close();
    this.sessions.clear();
    try {
      this.store.endRun(this.runId, this.now());
    } finally {
      this.store.close();
    }
    if (this.socketPath && existsSync(this.socketPath)) unlinkSync(this.socketPath);
  }
}

export async function startDaemon(opts: DaemonOptions): Promise<Daemon> {
  return Daemon.start(opts);
}

