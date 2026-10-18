// 守护进程 × harness=opencode：线格式 {event, sessionID, …}；拦截只在 permission.evaluate、建议只在 context；shadow 永不拦截。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogStore, defaultConfig, resolveConfig } from "@sv/core";
import { Daemon, startDaemon, type HookResponse } from "../src/index.ts";

const dirs: string[] = [];
const daemons: Daemon[] = [];
const tmp = (p = "sv-doc-") => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  while (daemons.length) await daemons.pop()!.stop();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
async function boot(over: Record<string, unknown> = {}) {
  const home = tmp();
  const d = await startDaemon({ cfg: resolveConfig(over, defaultConfig()), home, dbPath: join(home, "state.db"), socketPath: join(home, "sock") });
  daemons.push(d);
  return { d, home };
}
async function post(d: Daemon, payload: unknown, harness = "opencode"): Promise<HookResponse> {
  const r = await fetch("http://localhost/v1/hook", { unix: d.socketPath!, method: "POST", headers: { "content-type": "application/json", "x-sv-protocol": "1" }, body: JSON.stringify({ harness, payload }) });
  return (await r.json()) as HookResponse;
}
function gitRepo(): string {
  const d = tmp("sv-repo-");
  const sh = (...a: string[]) => {
    const r = Bun.spawnSync(a, { cwd: d });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  };
  sh("git", "init", "-q");
  sh("git", "config", "user.email", "t@example.com");
  sh("git", "config", "user.name", "t");
  writeFileSync(join(d, "a.txt"), "x\n");
  sh("git", "add", ".");
  sh("git", "commit", "-q", "-m", "init");
  return d;
}

let n = 0;
const SID = "oc-A";
const OC = (cwd: string, extra: Record<string, unknown>, sid = SID) => ({ sessionID: sid, directory: cwd, model: { providerID: "p", modelID: "any-model" }, ...extra });
const before = (cwd: string, tool: string, args: unknown, id: string) => OC(cwd, { event: "tool.before", tool, args, callID: id });
const after = (cwd: string, tool: string, args: unknown, id: string, o: { fail?: boolean } = {}) =>
  OC(cwd, { event: "tool.after", tool, args, callID: id, status: o.fail ? "error" : "completed", ...(o.fail ? { error: { message: "Command exited with code 1\nE   AssertionError: expected 4" } } : { result: { output: "ok", metadata: { exit: 0 } } }) });
const evaluate = (cwd: string) => OC(cwd, { event: "permission.evaluate" });
const context = (cwd: string, extra: Record<string, unknown> = {}) => OC(cwd, { event: "context", ...extra });
/** 一次完整的 bash 调用，顺序：before → evaluate → after。返回 evaluate 的响应（拦截决定在这里领取）。 */
async function bash(d: Daemon, cwd: string, cmd: string, o: { fail?: boolean } = {}) {
  const id = `call_${n++}`;
  const args = { command: cmd };
  const b = await post(d, before(cwd, "bash", args, id));
  const ev = await post(d, evaluate(cwd));
  await post(d, after(cwd, "bash", args, id, o));
  return { before: b, evaluate: ev };
}

describe("harness=opencode", () => {
  test("/v1/hook 接受 opencode；事件、会话、模型名按 opencode 记录；status=error 判失败", async () => {
    const { d, home } = await boot();
    const cwd = tmp("sv-nogit-");
    await post(d, OC(cwd, { event: "session.created" }));
    await post(d, context(cwd, { userMessage: { id: "u1", text: "fix it" } }));
    await bash(d, cwd, "pytest -q", { fail: true });
    await d.stop();
    daemons.pop();
    const s = new LogStore(join(home, "state.db"));
    expect(s.db.query("SELECT harness, model FROM sessions").get()).toEqual({ harness: "opencode", model: "p/any-model" });
    expect(s.db.query("SELECT e.phase AS phase, e.status AS status, e.tool_name AS tool FROM events e WHERE e.tool_name = 'bash' ORDER BY e.seq").all()).toEqual([
      { phase: "pre", status: null, tool: "bash" },
      { phase: "post", status: "fail", tool: "bash" },
    ]);
    expect(s.db.query("SELECT origin, phase FROM events WHERE phase = 'prompt'").get()).toEqual({ origin: "user", phase: "prompt" });
  });
  test("坏请求：缺字段/未知事件名不报错、不产生输出（fail-open）；未知 harness 仍然 400", async () => {
    const { d } = await boot();
    expect((await post(d, {})).delivery).toBeNull();
    expect((await post(d, { event: "wat", sessionID: "z" })).delivery).toBeNull();
    const r = await fetch("http://localhost/v1/hook", { unix: d.socketPath!, method: "POST", body: JSON.stringify({ harness: "gemini", payload: { sessionID: "x" } }) });
    expect(r.status).toBe(400);
  });
  test("enforce：X2（git reset --hard）在 tool.before 上不直接返回，留在 outbox，同一次调用的 permission.evaluate 领取 → block；只领一次", async () => {
    const { d } = await boot({ mode: "enforce" });
    const cwd = gitRepo();
    const r = await bash(d, cwd, "git reset --hard HEAD~1");
    expect(r.before.delivery).toBeNull();
    expect(r.before.hookPoint).toBeNull();
    expect(r.evaluate.hookPoint).toBe("permission.evaluate");
    expect(r.evaluate.delivery).toMatchObject({ kind: "block", ruleId: "X2" });
    expect((await post(d, evaluate(cwd))).delivery).toBeNull();
  });
  test("拦截绑定到产生它的那次调用：before(N) 没有 evaluate → after(N) → before(N+1) → evaluate 不会误拦 N+1（该行记为 stale）", async () => {
    const { d } = await boot({ mode: "enforce" });
    const cwd = gitRepo();
    const reset = { command: "git reset --hard HEAD~1" };
    await post(d, before(cwd, "bash", reset, "N")); // X2 决定入 outbox；这次调用没有触发 evaluate（无权限闸门/配置放行）
    await post(d, after(cwd, "bash", reset, "N"));
    await post(d, before(cwd, "bash", { command: "ls" }, "N1"));
    const r = await post(d, evaluate(cwd));
    expect(r.delivery).toBeNull();
    const row = d.store.db.query("SELECT state, stale_reason FROM outbox").get() as { state: string; stale_reason: string };
    expect(row.state).toBe("stale");
    expect(row.stale_reason).toContain("已结束");
  });
  test("顺序相反（evaluate 先于 before）：before(N) → after(N) → evaluate(N+1) → before(N+1)：同样不误拦", async () => {
    const { d } = await boot({ mode: "enforce" });
    const cwd = gitRepo();
    const reset = { command: "git reset --hard HEAD~1" };
    await post(d, before(cwd, "bash", reset, "N"));
    await post(d, after(cwd, "bash", reset, "N"));
    expect((await post(d, evaluate(cwd))).delivery).toBeNull();
    await post(d, before(cwd, "bash", { command: "ls" }, "N1"));
    expect((await post(d, evaluate(cwd))).delivery).toBeNull();
    expect(d.store.db.query("SELECT state FROM outbox").get()).toEqual({ state: "stale" });
  });
  test("pre 没有 callID → 无法绑定 → 拦截失效（fail-open），不会被任何 evaluate 领走", async () => {
    const { d } = await boot({ mode: "enforce" });
    const cwd = gitRepo();
    await post(d, OC(cwd, { event: "tool.before", tool: "bash", args: { command: "git reset --hard HEAD~1" } }));
    expect((await post(d, evaluate(cwd))).delivery).toBeNull();
    expect(d.store.db.query("SELECT state FROM outbox").get()).toEqual({ state: "stale" });
  });
  test("enforce：写 .env（edit 工具）也走 evaluate 的 block", async () => {
    const { d } = await boot({ mode: "enforce" });
    const cwd = gitRepo();
    expect((await post(d, before(cwd, "write", { filePath: join(cwd, ".env"), content: "A=1" }, "w1"))).delivery).toBeNull();
    expect((await post(d, evaluate(cwd))).delivery).toMatchObject({ kind: "block", ruleId: "X2" });
  });
  test("enforce：同一失败命令第 3 次尝试 → evaluate 领到 L1 block", async () => {
    const { d } = await boot({ mode: "enforce" });
    const cwd = gitRepo();
    const r: Awaited<ReturnType<typeof bash>>[] = [];
    for (let i = 0; i < 3; i++) r.push(await bash(d, cwd, "pytest tests/a.py", { fail: true }));
    expect(r[0].evaluate.delivery).toBeNull();
    expect(r[2].evaluate.delivery).toMatchObject({ kind: "block", ruleId: "L1" });
  });
  test("建议只在 context 领取；block/ask 不会在 context 上出现，advise 不会在 evaluate / tool.before / tool.after 上出现", async () => {
    const { d } = await boot({ mode: "enforce" });
    const cwd = tmp("sv-nogit-");
    await bash(d, cwd, "ls");
    d.outbox.enqueue({ sessionId: SID, kind: "advise", text: "最近两次失败原因相同，先看第一条报错。", deliveryId: "adv1" });
    d.outbox.enqueue({ sessionId: SID, kind: "stop_continue", text: "请先跑测试。", deliveryId: "stop1" });
    expect((await post(d, evaluate(cwd))).delivery).toBeNull();
    expect((await post(d, before(cwd, "bash", { command: "ls" }, "z1"))).delivery).toBeNull();
    expect((await post(d, after(cwd, "bash", { command: "ls" }, "z1"))).delivery).toBeNull();
    const c = await post(d, context(cwd));
    expect(c.hookPoint).toBe("context");
    expect(c.delivery).toMatchObject({ kind: "advise", text: "最近两次失败原因相同，先看第一条报错。" });
    expect((await post(d, context(cwd))).delivery).toBeNull(); // 只领一次
    expect(d.outbox.get(2)!.state).toBe("pending"); // OpenCode 上没有 Stop 注入点，stop_continue 不会被领走
  });
  test("shadow：循环、X2 都永不拦截（tool.before / evaluate / context 全部无输出），只记录 would_have_blocked", async () => {
    const { d, home } = await boot();
    const cwd = gitRepo();
    for (let i = 0; i < 4; i++) {
      const r = await bash(d, cwd, "pytest tests/a.py", { fail: true });
      expect(r.before.delivery).toBeNull();
      expect(r.evaluate.delivery).toBeNull();
    }
    const x = await bash(d, cwd, "git reset --hard HEAD~1");
    expect(x.evaluate.delivery).toBeNull();
    await post(d, before(cwd, "write", { filePath: join(cwd, ".env"), content: "A=1" }, "w9"));
    expect((await post(d, evaluate(cwd))).delivery).toBeNull();
    expect((await post(d, context(cwd))).delivery).toBeNull();
    await d.stop();
    daemons.pop();
    const s = new LogStore(join(home, "state.db"));
    const x2 = s.db.query("SELECT d.action, d.applied, d.outcome FROM hits h JOIN decisions d ON d.hit_id = h.id WHERE h.rule_id = 'X2' ORDER BY h.id").all() as Record<string, unknown>[];
    expect(x2.length).toBe(2);
    expect(x2.every((r) => r.applied === 0 && r.outcome === "would_have_blocked" && r.action === "block")).toBe(true);
    expect(s.db.query("SELECT COUNT(*) AS n FROM decisions WHERE applied = 1 AND action IN ('block','ask','stop_continue')").get()).toEqual({ n: 0 });
    expect(s.db.query("SELECT COUNT(*) AS n FROM outbox").get()).toEqual({ n: 0 });
  });
  test("P0-6：context 注入的建议随后作为 user 消息回显 → 该 prompt 事件判为 origin=supervisor", async () => {
    const { d, home } = await boot({ mode: "enforce" });
    const cwd = tmp("sv-nogit-");
    await bash(d, cwd, "ls");
    const text = "最近两次失败原因相同，先看第一条报错，再决定是否换一种做法。";
    d.outbox.enqueue({ sessionId: SID, kind: "advise", text, deliveryId: "adv-echo" });
    const c = await post(d, context(cwd));
    expect(c.delivery!.text).toBe(text);
    await post(d, context(cwd, { userMessage: { id: "u9", text } }));
    await post(d, context(cwd, { userMessage: { id: "u10", text: "真正的用户消息" } }));
    await d.stop();
    daemons.pop();
    const s = new LogStore(join(home, "state.db"));
    expect(s.db.query("SELECT origin FROM events WHERE phase = 'prompt' ORDER BY seq").all()).toEqual([{ origin: "supervisor" }, { origin: "user" }]);
  });
  test("规则通用：换模型名，命中序列一致", async () => {
    const run = async (model: string) => {
      const { d, home } = await boot();
      const cwd = gitRepo();
      for (let i = 0; i < 3; i++) {
        const id = `c${i}`;
        await post(d, { ...before(cwd, "bash", { command: "pytest tests/a.py" }, id), model });
        await post(d, { ...after(cwd, "bash", { command: "pytest tests/a.py" }, id, { fail: true }), model });
      }
      await d.stop();
      daemons.pop();
      const s = new LogStore(join(home, "state.db"));
      return s.db.query("SELECT rule_id, seq FROM hits ORDER BY id").all();
    };
    const a = await run("model-a");
    const b = await run("gpt-9");
    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual(b);
  });
  test("适配器健康度按 opencode 记，且与 claude/codex 分开", async () => {
    const { d } = await boot();
    const cwd = tmp("sv-nogit-");
    await post(d, context(cwd));
    const st = (await (await fetch("http://localhost/v1/status", { unix: d.socketPath! })).json()) as { sessions: number };
    expect(st.sessions).toBe(1);
    const row = d.store.db.query("SELECT harness, ok FROM adapter_health").all() as { harness: string; ok: number }[];
    expect(row.some((r) => r.harness === "opencode" && r.ok === 1)).toBe(true);
  });
});
