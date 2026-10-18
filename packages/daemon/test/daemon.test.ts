import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogStore, defaultConfig, mockJudge, resolveConfig, type JudgeFn } from "@sv/core";
import { Daemon, startDaemon, type HookResponse } from "../src/index.ts";

const dirs: string[] = [];
const daemons: Daemon[] = [];
function tmp(p = "sv-daemon-") {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  while (daemons.length) await daemons.pop()!.stop();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function boot(over: Record<string, unknown> = {}, opts: Partial<Parameters<typeof startDaemon>[0]> = {}) {
  const home = opts.home ?? tmp();
  const cfg = resolveConfig(over, defaultConfig());
  const d = await startDaemon({ cfg, home, dbPath: join(home, "state.db"), socketPath: join(home, "sock"), ...opts });
  daemons.push(d);
  return { d, home, cfg };
}

const uds = (d: Daemon) => ({ unix: d.socketPath! });
async function post(d: Daemon, body: unknown, headers: Record<string, string> = {}): Promise<HookResponse> {
  const r = await fetch("http://localhost/v1/hook", { ...uds(d), method: "POST", headers: { "content-type": "application/json", "x-sv-protocol": "1", ...headers }, body: JSON.stringify({ harness: "claude", payload: body }) });
  return (await r.json()) as HookResponse;
}

let n = 0;
const H = (cwd: string, extra: Record<string, unknown>) => ({ session_id: "sess-A", cwd, transcript_path: "/x/y.jsonl", ...extra });
const pre = (cwd: string, tool: string, input: unknown, id = `tu_${n++}`) => H(cwd, { hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, tool_use_id: id });
const postOk = (cwd: string, tool: string, input: unknown, out: string, id: string) => H(cwd, { hook_event_name: "PostToolUse", tool_name: tool, tool_input: input, tool_response: { stdout: out, stderr: "" }, tool_use_id: id });
const postFail = (cwd: string, tool: string, input: unknown, err: string, id: string) => H(cwd, { hook_event_name: "PostToolUseFailure", tool_name: tool, tool_input: input, error: err, tool_use_id: id });

/** 一次完整的 bash 调用：Pre → Post。返回 Pre 的响应。 */
async function bash(d: Daemon, cwd: string, cmd: string, o: { fail?: boolean; out?: string } = {}) {
  const id = `tu_${n++}`;
  const r = await post(d, pre(cwd, "Bash", { command: cmd }, id));
  if (o.fail) await post(d, postFail(cwd, "Bash", { command: cmd }, "Exit code 1\n" + (o.out ?? "E   AssertionError: expected 4"), id));
  else await post(d, postOk(cwd, "Bash", { command: cmd }, o.out ?? "ok", id));
  return r;
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

describe("本地鉴权与协议", () => {
  test("UDS：socket 0600、数据目录 0700、token 文件 0600；hello/status 可用", async () => {
    const { d, home } = await boot();
    expect(statSync(d.socketPath!).mode & 0o777).toBe(0o600);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, "token")).mode & 0o777).toBe(0o600);
    const hello = (await (await fetch("http://localhost/v1/hello", uds(d))).json()) as Record<string, unknown>;
    expect(hello).toMatchObject({ protocol: 1, mode: "shadow" });
    const st = (await (await fetch("http://localhost/v1/status", uds(d))).json()) as Record<string, unknown>;
    expect(st).toMatchObject({ protocol: 1, mode: "shadow", sessions: 0, judge: { enabled: false } });
  });
  test("127.0.0.1 HTTP：没有 token / token 错误 → 401；正确 token → 200；只绑定回环地址", async () => {
    const { d } = await boot({}, { port: 0, noUnix: true });
    const url = `http://127.0.0.1:${d.port}/v1/hello`;
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await fetch(url, { headers: { authorization: "Bearer " + d.token.slice(0, -1) } })).status).toBe(401);
    expect((await fetch(url, { headers: { authorization: "Bearer " + d.token } })).status).toBe(200);
    const body = await (await fetch(url, { headers: { authorization: "Bearer " + d.token } })).text();
    expect(body).not.toContain(d.token); // 响应里不回显 token
  });
  test("协议版本不一致 → 426；未知路径 404；缺 payload 400", async () => {
    const { d } = await boot();
    expect((await fetch("http://localhost/v1/hello", { ...uds(d), headers: { "x-sv-protocol": "2" } })).status).toBe(426);
    expect((await fetch("http://localhost/v1/nope", uds(d))).status).toBe(404);
    expect((await fetch("http://localhost/v1/hook", { ...uds(d), method: "POST", body: JSON.stringify({ harness: "claude" }) })).status).toBe(400);
    expect((await fetch("http://localhost/v1/hook", { ...uds(d), method: "POST", body: JSON.stringify({ harness: "gemini", payload: {} }) })).status).toBe(400);
  });
  test("token 在重启后保持不变；hook.json 记录 mode 与 socket（hook 在守护进程不可达时也知道）", async () => {
    const { d, home } = await boot({ mode: "enforce" });
    const t = d.token;
    const hj = JSON.parse(readTextSync(join(home, "hook.json")));
    expect(hj).toMatchObject({ protocol: 1, mode: "enforce", socket: d.socketPath });
    expect(statSync(join(home, "hook.json")).mode & 0o777).toBe(0o600);
    await d.stop();
    daemons.pop();
    const { d: d2 } = await boot({ mode: "shadow" }, { home });
    expect(d2.token).toBe(t);
  });
  test("已有守护进程在监听同一个 socket → 拒绝启动；残留的死 socket 文件 → 清掉后启动", async () => {
    const { d, home } = await boot();
    await expect(startDaemon({ cfg: defaultConfig(), home, dbPath: join(home, "other.db"), socketPath: d.socketPath })).rejects.toThrow(/已有守护进程/);
    await d.stop();
    daemons.pop();
    writeFileSync(join(home, "sock"), ""); // 死文件
    const { d: d2 } = await boot({}, { home });
    expect((await fetch("http://localhost/v1/hello", uds(d2))).status).toBe(200);
  });
});

const readTextSync = (p: string) => require("node:fs").readFileSync(p, "utf8") as string;

describe("hook 事件 → Engine.feed → 日志（一个事务）", () => {
  test("live run 记录；会话、事件、命中、决策都写进 state.db；停止时 run 结束", async () => {
    const { d, home } = await boot();
    const cwd = tmp("sv-nogit-");
    await post(d, H(cwd, { hook_event_name: "SessionStart", model: "claude-sonnet-5-5", source: "startup" }));
    await post(d, H(cwd, { hook_event_name: "UserPromptSubmit", prompt: "fix the failing test" }));
    for (let i = 0; i < 4; i++) await bash(d, cwd, "cat build.log", { out: "same" });
    await d.stop();
    daemons.pop();
    const s = new LogStore(join(home, "state.db"));
    const run = s.db.query("SELECT * FROM runs WHERE id = ?").get(d.runId) as Record<string, any>;
    expect(run).toMatchObject({ kind: "live", mode: "shadow", judge_mode: "off" });
    expect(run.ended_ts).toBeGreaterThan(0);
    expect(s.db.query("SELECT model, harness FROM sessions").get()).toEqual({ model: "claude-sonnet-5-5", harness: "claude" });
    expect(s.db.query("SELECT COUNT(*) AS n FROM events WHERE run_id = ?").get(d.runId)).toEqual({ n: 2 + 8 });
    const hit = s.db.query("SELECT rule_id, sev FROM hits WHERE rule_id='L2'").get();
    expect(hit).toEqual({ rule_id: "L2", sev: "M" });
    expect(s.db.query("SELECT model FROM events WHERE tool_name = 'Bash' LIMIT 1").get()).toEqual({ model: "claude-sonnet-5-5" });
  });
  test("shadow：所有响应都是空决定；X2 只记录 severity=dangerous / would_have_blocked，从不拦截", async () => {
    const { d, home } = await boot();
    const cwd = "/Users/jack/proj";
    const r1 = await post(d, pre(cwd, "Bash", { command: "git reset --hard HEAD~1" }));
    const r2 = await post(d, pre(cwd, "Write", { file_path: "/Users/jack/proj/.env", content: "A=1" }));
    const r3 = await post(d, pre(cwd, "Bash", { command: "rm -rf ~" }));
    for (const r of [r1, r2, r3]) expect(r.delivery).toBeNull();
    await d.stop();
    daemons.pop();
    const s = new LogStore(join(home, "state.db"));
    const rows = s.db.query("SELECT h.severity, h.danger_category, d.action, d.applied, d.outcome FROM hits h JOIN decisions d ON d.hit_id = h.id WHERE h.rule_id = 'X2' ORDER BY h.id").all();
    expect(rows).toEqual([
      { severity: "dangerous", danger_category: "git", action: "block", applied: 0, outcome: "would_have_blocked" },
      { severity: "dangerous", danger_category: "env", action: "ask", applied: 0, outcome: "would_have_asked" },
      { severity: "dangerous", danger_category: "rm", action: "block", applied: 0, outcome: "would_have_blocked" },
    ]);
    expect(s.db.query("SELECT COUNT(*) AS n FROM outbox").get()).toEqual({ n: 0 });
  });
  test("advise 模式：X2 也不拦（只有 enforce 才拦）", async () => {
    const { d } = await boot({ mode: "advise" });
    expect((await post(d, pre("/Users/jack/proj", "Bash", { command: "git push --force" }))).delivery).toBeNull();
  });
  test("enforce：X2 → deny / ask 直接放进响应；决策 outcome=blocked / asked，delivery 标已送达", async () => {
    const { d, home } = await boot({ mode: "enforce" });
    const cwd = "/Users/jack/proj";
    const r1 = await post(d, pre(cwd, "Bash", { command: "git reset --hard" }));
    expect(r1.delivery).toMatchObject({ kind: "block", ruleId: "X2" });
    expect(r1.delivery!.text).toContain("git reset --hard");
    const r2 = await post(d, pre(cwd, "Write", { file_path: "/Users/jack/proj/.github/workflows/ci.yml", content: "x" }));
    expect(r2.delivery).toMatchObject({ kind: "ask", ruleId: "X2" });
    // 连续 3 次 X2 全部拦截（不受连续拦截上限约束）
    for (let i = 0; i < 3; i++) expect((await post(d, pre(cwd, "Bash", { command: "git reset --hard" }))).delivery?.kind).toBe("block");
    await d.stop();
    daemons.pop();
    const s = new LogStore(join(home, "state.db"));
    expect(s.db.query("SELECT outcome FROM decisions WHERE rule_id='X2' ORDER BY id LIMIT 2").all()).toEqual([{ outcome: "blocked" }, { outcome: "asked" }]);
    expect(s.db.query("SELECT delivered, channel FROM deliveries WHERE rule_id='X2' ORDER BY id LIMIT 1").get()).toEqual({ delivered: 1, channel: "PreToolUse" });
    expect(s.db.query("SELECT COUNT(*) AS n FROM injections").get()).toEqual({ n: 2 }); // 两条不同的文案
  });
});

describe("L1 / T1：拦截前同步复核工作区指纹", () => {
  test("git 仓库里，同一失败命令第 3 次尝试在 pre 上被拦（enforce）", async () => {
    const { d } = await boot({ mode: "enforce" });
    const cwd = gitRepo();
    const r: HookResponse[] = [];
    for (let i = 0; i < 3; i++) r.push(await bash(d, cwd, "pytest tests/a.py", { fail: true }));
    expect(r[0].delivery).toBeNull();
    expect(r[1].delivery?.kind).not.toBe("block"); // 第 2 次最多是 T1 的 advise
    expect(r[2].delivery).toMatchObject({ kind: "block", ruleId: "L1" });
  });
  test("非 git 目录：指纹无法核实，只给建议、不拦截", async () => {
    const { d } = await boot({ mode: "enforce" });
    const cwd = tmp("sv-nogit-");
    const kinds: (string | undefined)[] = [];
    for (let i = 0; i < 3; i++) kinds.push((await bash(d, cwd, "pytest tests/a.py", { fail: true })).delivery?.kind);
    expect(kinds).not.toContain("block");
  });
  test("shadow：同样的循环永不拦截，但日志里有 would_have_blocked 的 L1 决策", async () => {
    const { d, home } = await boot();
    const cwd = gitRepo();
    for (let i = 0; i < 4; i++) expect((await bash(d, cwd, "pytest tests/a.py", { fail: true })).delivery).toBeNull();
    await d.stop();
    daemons.pop();
    const s = new LogStore(join(home, "state.db"));
    const rows = s.db.query("SELECT d.action, d.applied, d.outcome FROM decisions d JOIN hits h ON h.id = d.hit_id WHERE h.rule_id='L1' AND h.sev='H'").all() as { action: string; applied: number; outcome: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((x) => x.applied === 0)).toBe(true);
    expect(rows.some((x) => x.outcome === "would_have_blocked")).toBe(true);
  });
});

describe("outbox：advise 排队、在注入点原子送出、复核前置条件", () => {
  test("T1 advise（advise 模式）在同一次 PreToolUse 响应里送出一次，不会重复；deliveries/injections 已更新", async () => {
    const { d, home } = await boot({ mode: "advise" });
    const cwd = tmp("sv-nogit-");
    const r1 = await bash(d, cwd, "pytest -q", { out: "=== 3 passed in 0.1s ===" });
    expect(r1.delivery).toBeNull();
    const r2 = await bash(d, cwd, "pytest -q", { out: "=== 3 passed in 0.1s ===" });
    expect(r2.delivery).toMatchObject({ kind: "advise", ruleId: "T1" });
    expect(r2.delivery!.text).toContain("没有变化");
    // 下一个注入点不会再收到同一条
    expect((await post(d, H(cwd, { hook_event_name: "PostToolBatch" }))).delivery).toBeNull();
    await d.stop();
    daemons.pop();
    const s = new LogStore(join(home, "state.db"));
    expect(s.db.query("SELECT state, delivered_channel, attempts FROM outbox").all()).toEqual([{ state: "delivered", delivered_channel: "PreToolUse", attempts: 1 }]);
    expect(s.db.query("SELECT delivered, channel FROM deliveries WHERE rule_id='T1'").get()).toEqual({ delivered: 1, channel: "PreToolUse" });
    expect(s.db.query("SELECT COUNT(*) AS n FROM injections").get()).toEqual({ n: 1 });
  });
  test("前置条件不再成立 → 丢弃为 stale，deliveries 记原因，不送出", async () => {
    const { d, home } = await boot({ mode: "advise" });
    const cwd = tmp("sv-nogit-");
    await bash(d, cwd, "echo hi", { out: "hi" });
    d.outbox.enqueue({ sessionId: "sess-A", kind: "advise", text: "这条建议针对的错误已经不是最近一次结果了。", deliveryId: "manual-1", precondition: { errFp: "not-the-last-error" } });
    const r = await post(d, H(cwd, { hook_event_name: "PostToolBatch" }));
    expect(r.delivery).toBeNull();
    expect(d.outbox.get(1)).toMatchObject({ state: "stale", stale_reason: "最近一次结果的错误指纹已变化" });
    void home;
  });
  test("过期的消息不送出（expired）", async () => {
    let t = 1_700_000_000_000;
    const { d } = await boot({ mode: "advise" }, { now: () => t });
    const cwd = tmp("sv-nogit-");
    d.outbox.enqueue({ sessionId: "sess-A", kind: "advise", text: "很久以前的建议，现在已经不相关了。", deliveryId: "old", ttlMs: 1000 });
    t += 10_000;
    const r = await post(d, H(cwd, { hook_event_name: "PostToolBatch" }));
    expect(r.delivery).toBeNull();
    expect(d.outbox.get(1)!.state).toBe("expired");
  });
  test("block 类消息只在 PreToolUse 送出（Post 类注入点不会拿走它）", async () => {
    const { d } = await boot({ mode: "enforce" });
    const cwd = tmp("sv-nogit-");
    await bash(d, cwd, "ls");
    d.outbox.enqueue({ sessionId: "sess-A", kind: "block", text: "judge 判定：下一步会重复无效的操作，请换个做法。", deliveryId: "blk" });
    expect((await post(d, H(cwd, { hook_event_name: "PostToolBatch" }))).delivery).toBeNull();
    expect(d.outbox.get(1)!.state).toBe("pending");
    const r = await post(d, pre(cwd, "Bash", { command: "ls" }));
    expect(r.delivery).toMatchObject({ kind: "block", deliveryId: "blk" });
  });
  test("Stop：stop_hook_active=true 时不 block，也不消耗 outbox 里的 stop_continue", async () => {
    const { d } = await boot({ mode: "enforce" });
    const cwd = tmp("sv-nogit-");
    await bash(d, cwd, "ls");
    d.outbox.enqueue({ sessionId: "sess-A", kind: "stop_continue", text: "最后一次编辑之后没有运行过测试，请先运行相关测试。", deliveryId: "stop1" });
    expect((await post(d, H(cwd, { hook_event_name: "Stop", stop_hook_active: true }))).delivery).toBeNull();
    expect(d.outbox.get(1)!.state).toBe("pending");
    expect((await post(d, H(cwd, { hook_event_name: "Stop", stop_hook_active: false }))).delivery).toMatchObject({ kind: "stop_continue" });
  });
});

describe("后台 judge 不挡 hook", () => {
  test("慢 judge：hook 立刻响应；judge 完成后建议进 outbox，下一个注入点送出；日志里有 judge 调用和决策", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inner = mockJudge();
    const slow: JudgeFn = async (req) => {
      await gate;
      return inner(req);
    };
    const { d, home } = await boot({ mode: "advise" }, { judge: slow });
    const cwd = tmp("sv-nogit-");
    const t0 = Date.now();
    const rs: HookResponse[] = [];
    for (let i = 0; i < 4; i++) rs.push(await bash(d, cwd, "cat build.log", { out: "same" }));
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(rs.every((r) => r.delivery === null)).toBe(true);
    release();
    await new Promise((r) => setTimeout(r, 100));
    const next = await post(d, H(cwd, { hook_event_name: "PostToolBatch" }));
    expect(next.delivery).toMatchObject({ kind: "advise", ruleId: "L2" });
    await d.stop();
    daemons.pop();
    const s = new LogStore(join(home, "state.db"));
    expect(s.db.query("SELECT status, model FROM judge_calls").get()).toEqual({ status: "ok", model: "mock" });
    expect(s.db.query("SELECT action, applied FROM decisions WHERE rule_id='L2'").get()).toEqual({ action: "advise", applied: 1 });
    expect(s.db.query("SELECT delivered, channel FROM deliveries WHERE rule_id='L2'").get()).toEqual({ delivered: 1, channel: "PostToolBatch" });
  });
  test("shadow + judge：judge 照常调用并记录，但什么都不会送给 agent", async () => {
    const { d, home } = await boot({}, { judge: mockJudge() });
    const cwd = tmp("sv-nogit-");
    for (let i = 0; i < 4; i++) expect((await bash(d, cwd, "cat build.log", { out: "same" })).delivery).toBeNull();
    await new Promise((r) => setTimeout(r, 50));
    expect((await post(d, H(cwd, { hook_event_name: "PostToolBatch" }))).delivery).toBeNull();
    await d.stop();
    daemons.pop();
    const s = new LogStore(join(home, "state.db"));
    expect(s.count("judge_calls")).toBe(1);
    expect(s.db.query("SELECT outcome FROM decisions WHERE rule_id='L2'").get()).toEqual({ outcome: "would_have_advised" });
    expect(s.count("outbox")).toBe(0);
  });
  test("Stop：P3 的 stop_continue 靠 judge——Stop 钩子里最多等 stopWaitMs，赶得上就直接送出", async () => {
    const { d } = await boot({ mode: "enforce" }, { judge: mockJudge(), stopWaitMs: 1500 });
    const cwd = tmp("sv-nogit-");
    await post(d, H(cwd, { hook_event_name: "UserPromptSubmit", prompt: "fix the parser" }));
    await post(d, postOk(cwd, "Edit", { file_path: "/work/proj/src/a.py", old_string: "a", new_string: "b" }, "updated", "e1"));
    const r = await post(d, H(cwd, { hook_event_name: "Stop", stop_hook_active: false }));
    expect(r.delivery).toMatchObject({ kind: "stop_continue", ruleId: "P3" });
  });
  test("Stop：judge 太慢赶不上 → 不阻塞 Stop（fail-open），结果留在 outbox", async () => {
    const never: JudgeFn = () => new Promise(() => {});
    const { d } = await boot({ mode: "enforce" }, { judge: never, stopWaitMs: 100 });
    const cwd = tmp("sv-nogit-");
    await post(d, H(cwd, { hook_event_name: "UserPromptSubmit", prompt: "fix the parser" }));
    await post(d, postOk(cwd, "Edit", { file_path: "/work/proj/src/a.py", old_string: "a", new_string: "b" }, "updated", "e1"));
    const t0 = Date.now();
    const r = await post(d, H(cwd, { hook_event_name: "Stop", stop_hook_active: false }));
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(r.delivery).toBeNull();
    await d.stop(); // 退出时不会被永不返回的 judge 卡住
    daemons.pop();
  });
});

describe("fail-open 与健康记录", () => {
  test("内部错误（日志库被关掉）→ 仍然返回 200 + 空决定；不抛、不阻断", async () => {
    const { d } = await boot({ mode: "enforce" });
    const cwd = "/Users/jack/proj";
    expect((await post(d, pre(cwd, "Bash", { command: "ls" }))).ok).toBe(true);
    d.store.close();
    const r = await post(d, pre(cwd, "Bash", { command: "ls" }));
    expect(r.delivery).toBeNull();
    expect(r.ok).toBe(false);
    daemons.pop(); // store 已关，stop() 不再重复关闭
  });
  test("适配器失败 spool（hook 在守护进程不可达时写下的）被补记为 adapter_health；status 里能看到近 15 分钟失败数", async () => {
    const { d, home } = await boot();
    const now = Date.now();
    writeFileSync(join(home, "health-spool.jsonl"), [JSON.stringify({ ts: now, harness: "claude", error: "ECONNREFUSED" }), "垃圾行", JSON.stringify({ ts: now, harness: "claude", error: "timeout" })].join("\n") + "\n");
    expect(d.ingestSpool()).toBe(2);
    expect(existsSync(join(home, "health-spool.jsonl"))).toBe(false);
    const st = (await (await fetch("http://localhost/v1/status", uds(d))).json()) as { adapterFailures15m: Record<string, number> };
    expect(st.adapterFailures15m.claude).toBe(2);
    expect(d.store.db.query("SELECT error FROM adapter_health WHERE ok = 0 ORDER BY id").all()).toEqual([{ error: "ECONNREFUSED" }, { error: "timeout" }]);
  });
  test("启动时自动补记 spool；POST /v1/adapter-health 也能写", async () => {
    const home = tmp();
    writeFileSync(join(home, "health-spool.jsonl"), JSON.stringify({ ts: Date.now(), harness: "claude", error: "before-start" }) + "\n");
    const { d } = await boot({}, { home });
    expect(d.store.db.query("SELECT error FROM adapter_health WHERE ok = 0").all()).toEqual([{ error: "before-start" }]);
    await fetch("http://localhost/v1/adapter-health", { ...uds(d), method: "POST", body: JSON.stringify({ harness: "claude", ok: false, error: "reported" }) });
    expect(d.store.db.query("SELECT COUNT(*) AS n FROM adapter_health WHERE error = 'reported'").get()).toEqual({ n: 1 });
  });
  test("成功的 hook 也会（限频地）记一条 ok 健康样本", async () => {
    const { d } = await boot();
    await bash(d, tmp("sv-nogit-"), "ls");
    await bash(d, tmp("sv-nogit-"), "ls");
    expect(d.store.db.query("SELECT COUNT(*) AS n FROM adapter_health WHERE ok = 1").get()).toEqual({ n: 1 });
  });
});

describe("优雅退出与恢复", () => {
  test("stop()：关闭每个会话的引擎（结算遵从窗口）、结束 live run、移除 socket", async () => {
    const { d, home } = await boot({ mode: "advise" });
    const cwd = tmp("sv-nogit-");
    await bash(d, cwd, "pytest -q", { out: "=== 3 passed in 0.1s ===" });
    await bash(d, cwd, "pytest -q", { out: "=== 3 passed in 0.1s ===" }); // T1 advise 已送出，遵从窗口尚未走完
    const sock = d.socketPath!;
    await d.stop();
    daemons.pop();
    expect(existsSync(sock)).toBe(false);
    const s = new LogStore(join(home, "state.db"));
    expect((s.db.query("SELECT ended_ts FROM runs WHERE id = ?").get(d.runId) as { ended_ts: number }).ended_ts).toBeGreaterThan(0);
    expect(s.db.query("SELECT complied, compliance_note FROM deliveries WHERE rule_id='T1'").get()).toEqual({ complied: null, compliance_note: "会话结束时观察窗口未走完" });
    await d.stop(); // 幂等
  });
  test("重启后恢复：injections 哈希（回显仍被识别为 supervisor）、plans", async () => {
    const home = tmp();
    const cwd = tmp("sv-nogit-");
    const b1 = await boot({ mode: "advise" }, { home });
    await bash(b1.d, cwd, "pytest -q", { out: "=== 3 passed in 0.1s ===" });
    const r = await bash(b1.d, cwd, "pytest -q", { out: "=== 3 passed in 0.1s ===" });
    const injected = r.delivery!.text;
    await post(b1.d, postOk(cwd, "TodoWrite", { todos: [{ content: "改 src/auth/login.py", status: "in_progress", activeForm: "x" }] }, "ok", "td1"));
    await b1.d.stop();
    daemons.pop();
    const b2 = await boot({ mode: "advise" }, { home });
    await post(b2.d, H(cwd, { hook_event_name: "UserPromptSubmit", prompt: "hello" })); // 触发会话运行时创建
    await post(b2.d, H(cwd, { hook_event_name: "UserPromptSubmit", prompt: injected }));
    // 重启后第二条 prompt 与之前注入的文本相同：从 injections 表恢复的哈希把它认成 supervisor 回显（P0-6）
    const rows = b2.d.store.db.query("SELECT origin FROM events WHERE phase = 'prompt' AND run_id = ? ORDER BY seq").all(b2.d.runId) as { origin: string }[];
    expect(rows.map((x) => x.origin)).toEqual(["user", "supervisor"]);
    expect(b2.d.store.db.query("SELECT COUNT(*) AS n FROM injections").get()).toEqual({ n: 1 });
    expect(b2.d.store.db.query("SELECT source FROM plans WHERE session_id = 'sess-A'").get()).toEqual({ source: "auto" });
  });
  test(".supervisor/plan.md 在会话开始时被读取：显式 allow 的 P1 在 enforce 下直接拦截", async () => {
    const { d } = await boot({ mode: "enforce" });
    const cwd = tmp("sv-nogit-");
    mkdirSync(join(cwd, ".supervisor"));
    writeFileSync(join(cwd, ".supervisor", "plan.md"), "# t\n- [ ] 修登录\nallow: src/auth/**\n");
    const ok = await post(d, pre(cwd, "Edit", { file_path: join(cwd, "src/auth/login.py"), old_string: "a", new_string: "b" }));
    expect(ok.delivery).toBeNull();
    const bad = await post(d, pre(cwd, "Edit", { file_path: join(cwd, "src/billing/x.py"), old_string: "a", new_string: "b" }));
    expect(bad.delivery).toMatchObject({ kind: "block", ruleId: "P1" });
  });
  test("同一会话的并发 hook 被串行处理：seq 单调且不丢事件", async () => {
    const { d, home } = await boot();
    const cwd = tmp("sv-nogit-");
    await Promise.all(Array.from({ length: 20 }, (_, i) => post(d, pre(cwd, "Bash", { command: `echo ${i}` }, `par_${i}`))));
    await d.stop();
    daemons.pop();
    const s = new LogStore(join(home, "state.db"));
    const seqs = (s.db.query("SELECT seq FROM events WHERE phase='pre' ORDER BY id").all() as { seq: number }[]).map((r) => r.seq);
    expect(seqs).toHaveLength(20);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(20);
  });
});

describe("模型名只记录、不参与判定", () => {
  test("不同模型名下同一段会话得到相同的命中", async () => {
    const run = async (model: string) => {
      const { d, home } = await boot({ mode: "advise" });
      const cwd = tmp("sv-nogit-");
      await post(d, H(cwd, { hook_event_name: "SessionStart", model }));
      for (let i = 0; i < 3; i++) await bash(d, cwd, "pytest -q", { out: "=== 3 passed in 0.1s ===" });
      await d.stop();
      daemons.pop();
      const s = new LogStore(join(home, "state.db"));
      return (s.db.query("SELECT rule_id || ':' || sev || ':' || phase AS k FROM hits ORDER BY id").all() as { k: string }[]).map((r) => r.k);
    };
    const a = await run("gpt-5-codex");
    expect(a.length).toBeGreaterThan(0);
    expect(await run("claude-sonnet-5-5")).toEqual(a);
    expect(await run("kimi-k2")).toEqual(a);
  });
});
