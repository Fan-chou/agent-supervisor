// 守护进程 × harness=codex：同一个 /v1/hook 按 harness 选归一化器；健康度按适配器分开；origin 登记用的是实际输出的字符串。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogStore, defaultConfig, resolveConfig } from "@sv/core";
import { Daemon, startDaemon, type HookResponse } from "../src/index.ts";

const dirs: string[] = [];
const daemons: Daemon[] = [];
const tmp = (p = "sv-dcx-") => {
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
const uds = (d: Daemon) => ({ unix: d.socketPath! });
async function post(d: Daemon, harness: string, payload: unknown): Promise<HookResponse> {
  const r = await fetch("http://localhost/v1/hook", { ...uds(d), method: "POST", headers: { "content-type": "application/json", "x-sv-protocol": "1" }, body: JSON.stringify({ harness, payload }) });
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
const CX = (cwd: string, extra: Record<string, unknown>, sid = "cx-A") => ({ session_id: sid, cwd, model: "gpt-x", transcript_path: "/x/rollout.jsonl", ...extra });
const cxPre = (cwd: string, cmd: string, id: string, sid?: string) => CX(cwd, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: cmd }, tool_use_id: id }, sid);
const cxPost = (cwd: string, cmd: string, out: string, id: string, sid?: string) => CX(cwd, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: cmd }, tool_response: out, tool_use_id: id }, sid);
async function bash(d: Daemon, cwd: string, cmd: string, o: { fail?: boolean } = {}) {
  const id = `call_${n++}`;
  const r = await post(d, "codex", cxPre(cwd, cmd, id));
  await post(d, "codex", cxPost(cwd, cmd, o.fail ? "Process exited with code 1\nOutput:\nE   AssertionError: expected 4" : "Process exited with code 0\nOutput:\nok", id));
  return r;
}

describe("harness=codex", () => {
  test("/v1/hook 接受 codex；事件、会话、模型名按 codex 记录；退出码来自输出头", async () => {
    const { d, home } = await boot();
    const cwd = tmp("sv-nogit-");
    await post(d, "codex", CX(cwd, { hook_event_name: "SessionStart", source: "startup" }));
    await post(d, "codex", CX(cwd, { hook_event_name: "UserPromptSubmit", prompt: "fix it" }));
    await bash(d, cwd, "pytest -q", { fail: true });
    await d.stop();
    daemons.pop();
    const s = new LogStore(join(home, "state.db"));
    expect(s.db.query("SELECT harness, model FROM sessions").get()).toEqual({ harness: "codex", model: "gpt-x" });
    expect(s.db.query("SELECT s.harness AS harness, e.phase AS phase, e.status AS status, e.exit_code AS exit_code FROM events e JOIN sessions s ON s.session_id = e.session_id WHERE e.tool_name = 'Bash' ORDER BY e.seq").all()).toEqual([
      { harness: "codex", phase: "pre", status: null, exit_code: null },
      { harness: "codex", phase: "post", status: "fail", exit_code: 1 },
    ]);
  });
  test("未知 harness → 400（opencode 等第一阶段不接）", async () => {
    const { d } = await boot();
    const r = await fetch("http://localhost/v1/hook", { ...uds(d), method: "POST", body: JSON.stringify({ harness: "opencode", payload: { session_id: "x" } }) });
    expect(r.status).toBe(400);
  });
  test("同一个 session_id 在 claude 和 codex 上是两个独立的会话运行时", async () => {
    const { d } = await boot();
    const cwd = tmp("sv-nogit-");
    await post(d, "claude", { session_id: "same", cwd, hook_event_name: "UserPromptSubmit", prompt: "a" });
    await post(d, "codex", { session_id: "same", cwd, hook_event_name: "UserPromptSubmit", prompt: "b" });
    const st = (await (await fetch("http://localhost/v1/status", uds(d))).json()) as { sessions: number };
    expect(st.sessions).toBe(2);
  });
  test("enforce：codex 上同一失败命令第 3 次尝试被拦（kind=block，由 sv-hook 渲染成 deny）", async () => {
    const { d } = await boot({ mode: "enforce" });
    const cwd = gitRepo();
    const r: HookResponse[] = [];
    for (let i = 0; i < 3; i++) r.push(await bash(d, cwd, "pytest tests/a.py", { fail: true }));
    expect(r[0].delivery).toBeNull();
    expect(r[2].delivery).toMatchObject({ kind: "block", ruleId: "L1" });
    expect(r[2].hookPoint).toBe("PreToolUse");
  });
  test("shadow：codex 上同样的循环、X2 都永不拦截，只记录 would_have_*", async () => {
    const { d, home } = await boot();
    const cwd = gitRepo();
    for (let i = 0; i < 4; i++) expect((await bash(d, cwd, "pytest tests/a.py", { fail: true })).delivery).toBeNull();
    expect((await post(d, "codex", cxPre(cwd, "git reset --hard HEAD~1", "x1"))).delivery).toBeNull();
    expect((await post(d, "codex", CX(cwd, { hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: "*** Begin Patch\n*** Add File: .env\n+A=1\n*** End Patch", tool_use_id: "x2" }))).delivery).toBeNull();
    await d.stop();
    daemons.pop();
    const s = new LogStore(join(home, "state.db"));
    const x2 = s.db.query("SELECT h.danger_category, d.action, d.applied, d.outcome FROM hits h JOIN decisions d ON d.hit_id = h.id WHERE h.rule_id = 'X2' ORDER BY h.id").all() as Record<string, unknown>[];
    expect(x2.length).toBe(2);
    expect(x2.every((r) => r.applied === 0 && r.outcome === "would_have_blocked" && r.action === "block")).toBe(true); // Codex 上没有 ask，一律 block
    expect(s.db.query("SELECT COUNT(*) AS n FROM decisions WHERE applied = 1 AND action IN ('block','ask','stop_continue')").get()).toEqual({ n: 0 });
  });
  test("codex 的 Stop：stop_hook_active=true 不 block 也不消耗 outbox；Codex 没有的事件（PostToolUseFailure）不产生注入", async () => {
    const { d } = await boot({ mode: "enforce" });
    const cwd = tmp("sv-nogit-");
    await bash(d, cwd, "ls");
    d.outbox.enqueue({ sessionId: "cx-A", kind: "stop_continue", text: "最后一次编辑之后没有运行过测试，请先运行相关测试。", deliveryId: "stop1" });
    expect((await post(d, "codex", CX(cwd, { hook_event_name: "Stop", stop_hook_active: true }))).delivery).toBeNull();
    expect(d.outbox.get(1)!.state).toBe("pending");
    expect((await post(d, "codex", CX(cwd, { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "ls" } }))).hookPoint).toBeNull();
    expect((await post(d, "codex", CX(cwd, { hook_event_name: "Stop", stop_hook_active: false }))).delivery).toMatchObject({ kind: "stop_continue" });
  });

  test("P0-6：超过 600 字符的 Stop reason——登记的是实际输出的（截断后的）字符串，回显成 user prompt 时判为 supervisor", async () => {
    const { d } = await boot({ mode: "enforce" });
    const cwd = tmp("sv-nogit-");
    await bash(d, cwd, "ls");
    const long = "最后一次编辑之后没有运行过相关测试。".repeat(80);
    expect(long.length).toBeGreaterThan(600);
    d.outbox.enqueue({ sessionId: "cx-A", kind: "stop_continue", text: long, deliveryId: "stop-long" });
    const r = await post(d, "codex", CX(cwd, { hook_event_name: "Stop", stop_hook_active: false }));
    expect(r.delivery!.text.length).toBeLessThanOrEqual(600);
    expect(r.delivery!.text.endsWith("…")).toBe(true);
    // Codex 把 reason 作为新的 user prompt 送回来
    await post(d, "codex", CX(cwd, { hook_event_name: "UserPromptSubmit", prompt: "继续做" }));
    await post(d, "codex", CX(cwd, { hook_event_name: "UserPromptSubmit", prompt: r.delivery!.text }));
    const rows = d.store.db.query("SELECT origin FROM events WHERE phase = 'prompt' AND run_id = ? ORDER BY seq").all(d.runId) as { origin: string }[];
    expect(rows.map((x) => x.origin)).toEqual(["user", "supervisor"]);
  });
  test("P0-6（Claude 同样修复）：outbox 里的长建议送出后，登记的是截断后的字符串", async () => {
    const { d } = await boot({ mode: "enforce" });
    const cwd = tmp("sv-nogit-");
    const sid = "cl-A";
    const id = "tu1";
    await post(d, "claude", { session_id: sid, cwd, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: id });
    d.outbox.enqueue({ sessionId: sid, kind: "advise", text: "建议。".repeat(300), deliveryId: "adv-long" });
    const r = await post(d, "claude", { session_id: sid, cwd, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: { stdout: "ok" }, tool_use_id: id });
    expect(r.delivery!.text.length).toBeLessThanOrEqual(600);
    await post(d, "claude", { session_id: sid, cwd, hook_event_name: "UserPromptSubmit", prompt: "hi" });
    await post(d, "claude", { session_id: sid, cwd, hook_event_name: "UserPromptSubmit", prompt: r.delivery!.text });
    const rows = d.store.db.query("SELECT origin FROM events WHERE phase = 'prompt' AND session_id = ? ORDER BY seq").all(sid) as { origin: string }[];
    expect(rows.map((x) => x.origin)).toEqual(["user", "supervisor"]);
  });

  test("适配器健康度按 harness 分开：codex 的失败不算在 claude 头上", async () => {
    const { d } = await boot();
    const cwd = tmp("sv-nogit-");
    await post(d, "codex", cxPre(cwd, "ls", "h1")); // 成功 → ok 记在 codex 上
    await post(d, "claude", { session_id: "c", cwd, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } });
    const rep = (harness: string, ok: boolean, error?: string) => fetch("http://localhost/v1/adapter-health", { ...uds(d), method: "POST", body: JSON.stringify({ harness, ok, error }) });
    await rep("codex", false, "daemon-unreachable");
    await rep("codex", false, "hook-exception: x");
    await rep("claude", false, "timeout");
    const st = (await (await fetch("http://localhost/v1/status", uds(d))).json()) as { adapterFailures15m: Record<string, number> };
    expect(st.adapterFailures15m).toEqual({ codex: 2, claude: 1 });
    const okRows = d.store.db.query("SELECT harness FROM adapter_health WHERE ok = 1 ORDER BY harness").all();
    expect(okRows).toEqual([{ harness: "claude" }, { harness: "codex" }]);
  });
  test("hook 载荷在守护进程里出内部错误时，失败记在请求里的那个 harness 上（fail-open：返回空决定）", async () => {
    const { d } = await boot();
    // payload 里 session_id 是对象：不会抛；用 cwd 非字符串 + 破坏 tool_input 的 getter 不现实，这里直接验证 safeHealth 的归属：
    (d as unknown as { process: () => never }).process = () => {
      throw new Error("boom");
    };
    const r = await post(d, "codex", { session_id: "e", hook_event_name: "Stop" });
    expect(r).toMatchObject({ ok: false, delivery: null, error: "internal" });
    const st = (await (await fetch("http://localhost/v1/status", uds(d))).json()) as { adapterFailures15m: Record<string, number> };
    expect(st.adapterFailures15m).toEqual({ codex: 1 });
  });
  test("模型名只进日志：换三个模型名，codex 上的命中序列一致", async () => {
    const run = async (model: string) => {
      const { d, home } = await boot();
      const cwd = tmp("sv-nogit-");
      for (let i = 0; i < 4; i++) {
        const id = `m${i}`;
        await post(d, "codex", { ...cxPre(cwd, "cat build.log", id), model });
        await post(d, "codex", { ...cxPost(cwd, "cat build.log", "same", id), model });
      }
      await d.stop();
      daemons.pop();
      const s = new LogStore(join(home, "state.db"));
      return s.db.query("SELECT rule_id, sev FROM hits ORDER BY id").all();
    };
    const a = await run("gpt-x");
    expect(a.length).toBeGreaterThan(0);
    expect(await run("some-other")).toEqual(a);
    expect(await run("third-model")).toEqual(a);
  });
});
