import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, resolveConfig } from "@sv/core";
import { Daemon, startDaemon } from "../../daemon/src/index.ts";
import { allowedByMode, runHook } from "../src/hook.ts";

const dirs: string[] = [];
const daemons: Daemon[] = [];
const servers: { stop(force?: boolean): void }[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "sv-hook-"));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  while (daemons.length) await daemons.pop()!.stop();
  while (servers.length) servers.pop()!.stop(true);
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function boot(over: Record<string, unknown> = {}) {
  const home = tmp();
  const d = await startDaemon({ cfg: resolveConfig(over, defaultConfig()), home, dbPath: join(home, "state.db"), socketPath: join(home, "sock") });
  daemons.push(d);
  return { d, home };
}

const CWD = "/Users/jack/proj";
const payload = (extra: Record<string, unknown>) => JSON.stringify({ session_id: "s1", cwd: CWD, ...extra });
const preBash = (cmd: string, id = "t1") => payload({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: cmd }, tool_use_id: id });
const postBash = (cmd: string, out: string, id: string) => payload({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: cmd }, tool_response: { stdout: out, stderr: "" }, tool_use_id: id });

describe("输出协议（Claude Code）", () => {
  test("enforce：X2 deny → hookSpecificOutput.permissionDecision=deny，只含白名单字段", async () => {
    const { home } = await boot({ mode: "enforce" });
    const r = await runHook(preBash("git reset --hard HEAD~1"), { home });
    expect(r.exitCode).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(Object.keys(j)).toEqual(["hookSpecificOutput"]);
    expect(j.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(j.hookSpecificOutput.permissionDecisionReason).toContain("git reset --hard");
    expect(j.hookSpecificOutput.additionalContext).toBeUndefined();
    for (const k of ["continue", "stopReason", "suppressOutput", "updatedInput"]) expect(JSON.stringify(j)).not.toContain(k);
  });
  test("enforce：写 .env / CI 配置 → ask", async () => {
    const { home } = await boot({ mode: "enforce" });
    const r = await runHook(payload({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: `${CWD}/.env`, content: "A=1" }, tool_use_id: "w1" }), { home });
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
  });
  test("shadow：同样的危险命令不输出任何东西（永不拦截，含 X2）", async () => {
    const { d, home } = await boot();
    for (const cmd of ["git reset --hard", "rm -rf ~", "git push --force origin main"]) {
      const r = await runHook(preBash(cmd), { home });
      expect(r).toMatchObject({ stdout: "", exitCode: 0 });
    }
    // 守护进程照样记录了 would_have_*
    const rows = d.store.db.query("SELECT outcome FROM decisions WHERE rule_id = 'X2'").all();
    expect(rows).toEqual([{ outcome: "would_have_blocked" }, { outcome: "would_have_blocked" }, { outcome: "would_have_blocked" }]);
  });
  test("advise 模式：X2 不拦；advise 类消息以 additionalContext 输出", async () => {
    const { home } = await boot({ mode: "advise" });
    expect((await runHook(preBash("git reset --hard"), { home })).stdout).toBe("");
    await runHook(preBash("pytest -q", "a1"), { home });
    await runHook(postBash("pytest -q", "=== 3 passed in 0.1s ===", "a1"), { home });
    const r = await runHook(preBash("pytest -q", "a2"), { home });
    const j = JSON.parse(r.stdout);
    expect(j.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(j.hookSpecificOutput.additionalContext).toContain("没有变化");
    expect(j.hookSpecificOutput.permissionDecision).toBeUndefined();
    // 同一条不会再次输出
    await runHook(postBash("pytest -q", "=== 3 passed in 0.1s ===", "a2"), { home });
    expect((await runHook(payload({ hook_event_name: "PostToolBatch" }), { home })).stdout).toBe("");
  });
  test("Stop：enforce 下 outbox 里的 stop_continue → decision:block + reason；stop_hook_active=true → 不输出", async () => {
    const { d, home } = await boot({ mode: "enforce" });
    await runHook(preBash("ls"), { home });
    d.outbox.enqueue({ sessionId: "s1", kind: "stop_continue", text: "最后一次编辑之后没有运行过相关测试，请先运行。", deliveryId: "st1" });
    expect((await runHook(payload({ hook_event_name: "Stop", stop_hook_active: true }), { home })).stdout).toBe("");
    const r = await runHook(payload({ hook_event_name: "Stop", stop_hook_active: false }), { home });
    expect(JSON.parse(r.stdout)).toEqual({ decision: "block", reason: "最后一次编辑之后没有运行过相关测试，请先运行。" });
  });
  test("没有注入点的事件（UserPromptSubmit / SessionStart）永远没有输出", async () => {
    const { home } = await boot({ mode: "enforce" });
    expect((await runHook(payload({ hook_event_name: "UserPromptSubmit", prompt: "hi" }), { home })).stdout).toBe("");
    expect((await runHook(payload({ hook_event_name: "SessionStart", model: "x" }), { home })).stdout).toBe("");
  });
});

describe("fail-open", () => {
  test("守护进程不可达：不输出、exit 0，并写 spool（之后守护进程补记为 adapter_health）", async () => {
    const home = tmp(); // 没有 socket、没有 hook.json
    const r = await runHook(preBash("git reset --hard"), { home, now: () => 1234 });
    expect(r).toMatchObject({ stdout: "", exitCode: 0, note: "daemon-unreachable" });
    const line = JSON.parse(readFileSync(join(home, "health-spool.jsonl"), "utf8").trim());
    expect(line).toMatchObject({ ts: 1234, harness: "claude", event: "PreToolUse" });
    // 守护进程起来后补记
    const d = await startDaemon({ cfg: defaultConfig(), home, dbPath: join(home, "state.db"), socketPath: join(home, "sock") });
    daemons.push(d);
    expect(d.store.db.query("SELECT ok, error FROM adapter_health WHERE ok = 0").all().length).toBe(1);
  });
  test("守护进程不可达 + enforce：本地 X2 仍然拦（适配器内置，不依赖守护进程）；其余照常放行", async () => {
    const { d, home } = await boot({ mode: "enforce" });
    await d.stop();
    daemons.pop();
    expect(existsSync(join(home, "hook.json"))).toBe(true); // hook 仍然知道 mode
    const dangerous = await runHook(preBash("git reset --hard"), { home });
    expect(JSON.parse(dangerous.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(dangerous.note).toBe("daemon-unreachable");
    expect((await runHook(preBash("ls"), { home })).stdout).toBe("");
  });
  test("守护进程不可达 + shadow：连 X2 都不拦", async () => {
    const { d, home } = await boot();
    await d.stop();
    daemons.pop();
    expect((await runHook(preBash("git reset --hard"), { home })).stdout).toBe("");
  });
  test("超时：守护进程挂住不响应 → 在 timeoutMs 内放行", async () => {
    const home = tmp();
    const sock = join(home, "sock");
    servers.push(Bun.serve({ unix: sock, fetch: () => new Promise<Response>(() => {}) }));
    writeFileSync(join(home, "hook.json"), JSON.stringify({ protocol: 1, mode: "enforce", socket: sock }));
    const t0 = Date.now();
    const r = await runHook(preBash("ls"), { home, timeoutMs: 150 });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r).toMatchObject({ stdout: "", note: "daemon-unreachable" });
    expect(readFileSync(join(home, "health-spool.jsonl"), "utf8")).toContain("claude");
  });
  test("守护进程返回 500 / 非 JSON / 426：放行", async () => {
    for (const mk of [() => new Response("boom", { status: 500 }), () => new Response("not json", { status: 200 }), () => new Response("{}", { status: 426 })]) {
      const home = tmp();
      const sock = join(home, "sock");
      servers.push(Bun.serve({ unix: sock, fetch: mk }));
      writeFileSync(join(home, "hook.json"), JSON.stringify({ protocol: 1, mode: "enforce", socket: sock }));
      const r = await runHook(preBash("ls"), { home });
      expect(r.stdout).toBe("");
      expect(r.exitCode).toBe(0);
    }
  });
  test("垃圾 stdin / 空 stdin：放行，不抛异常", async () => {
    const home = tmp();
    for (const s of ["", "not json", "null", "[]", "42"]) expect(await runHook(s, { home })).toMatchObject({ stdout: "", exitCode: 0 });
  });
  test("守护进程说 block 但 hook.json 的 mode 不是 enforce：丢弃（shadow 永不拦截是适配器自己的铁律）", async () => {
    for (const mode of ["shadow", "advise"]) {
      const home = tmp();
      const sock = join(home, "sock");
      servers.push(Bun.serve({ unix: sock, fetch: () => Response.json({ ok: true, delivery: { kind: "block", text: "拦！", ruleId: "L1" } }) }));
      writeFileSync(join(home, "hook.json"), JSON.stringify({ protocol: 1, mode, socket: sock }));
      const r = await runHook(preBash("ls"), { home });
      expect(r.stdout).toBe("");
      expect(r.note).toBe(`dropped-by-mode:${mode}`);
    }
  });
  test("allowedByMode", () => {
    const b = { kind: "block", text: "x" } as const;
    const a = { kind: "advise", text: "x" } as const;
    expect(allowedByMode("shadow", b)).toBeNull();
    expect(allowedByMode("shadow", a)).toBeNull();
    expect(allowedByMode(undefined, b)).toBeNull();
    expect(allowedByMode("advise", b)).toBeNull();
    expect(allowedByMode("advise", a)).toEqual(a);
    expect(allowedByMode("enforce", b)).toEqual(b);
    expect(allowedByMode("enforce", null)).toBeNull();
  });
});

describe("作为独立进程运行（bun packages/hook/src/main.ts）", () => {
  const main = join(import.meta.dir, "../src/main.ts");
  async function spawn(home: string, stdin: string, env: Record<string, string> = {}) {
    const p = Bun.spawn(["bun", main], { stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe", env: { ...process.env, SV_HOME: home, ...env } });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { out, err, code };
  }
  test("enforce + 守护进程在线：输出 deny JSON，exit 0", async () => {
    const { home } = await boot({ mode: "enforce" });
    const r = await spawn(home, preBash("git reset --hard"));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).hookSpecificOutput.permissionDecision).toBe("deny");
  });
  test("守护进程不在线：exit 0、无输出、很快返回", async () => {
    const home = tmp();
    const t0 = Date.now();
    const r = await spawn(home, preBash("git reset --hard"));
    expect(r).toMatchObject({ out: "", code: 0 });
    expect(Date.now() - t0).toBeLessThan(5000);
  });
  test("SV_HOOK_TIMEOUT_MS 生效：挂住的守护进程不会拖住 hook", async () => {
    const home = tmp();
    const sock = join(home, "sock");
    servers.push(Bun.serve({ unix: sock, fetch: () => new Promise<Response>(() => {}) }));
    writeFileSync(join(home, "hook.json"), JSON.stringify({ protocol: 1, mode: "enforce", socket: sock }));
    const t0 = Date.now();
    const r = await spawn(home, preBash("ls"), { SV_HOOK_TIMEOUT_MS: "200" });
    expect(r).toMatchObject({ out: "", code: 0 });
    expect(Date.now() - t0).toBeLessThan(4000);
  });
});
