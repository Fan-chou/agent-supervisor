// sv-hook × Codex：同一个二进制按参数/载荷区分；shadow 永不拦截；任何故障 fail-open；输出只有白名单字段。
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, resolveConfig } from "@sv/core";
import { Daemon, startDaemon } from "../../daemon/src/index.ts";
import { resolveHarness, runHook } from "../src/hook.ts";

const dirs: string[] = [];
const daemons: Daemon[] = [];
const servers: { stop(force?: boolean): void }[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "sv-hookcx-"));
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
const payload = (extra: Record<string, unknown>) => JSON.stringify({ session_id: "cx1", cwd: CWD, model: "gpt-x", turn_id: "t1", ...extra });
const preBash = (cmd: string, id = "c1") => payload({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: cmd }, tool_use_id: id });
const prePatch = (patch: string) => payload({ hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: ["apply_patch", patch] }, tool_use_id: "p1" });
const ENV_PATCH = "*** Begin Patch\n*** Add File: .env\n+A=1\n*** End Patch";
const CX = { harness: "codex" as const };
const FORBIDDEN = ["continue", "stopReason", "suppressOutput", "updatedInput", "updatedMCPToolOutput", "systemMessage", '"ask"'];

describe("harness 判定", () => {
  test("命令行参数优先；其次 SV_HARNESS；再其次载荷特征（turn_id）；默认 claude", () => {
    expect(resolveHarness(["codex"], {})).toBe("codex");
    expect(resolveHarness(["--harness=codex"], {})).toBe("codex");
    expect(resolveHarness(["claude"], { SV_HARNESS: "codex" }, { turn_id: "t" })).toBe("claude");
    expect(resolveHarness([], { SV_HARNESS: "codex" })).toBe("codex");
    expect(resolveHarness([], {}, { turn_id: "t" })).toBe("codex");
    expect(resolveHarness([], {}, { hook_event_name: "PreToolUse" })).toBe("claude");
    expect(resolveHarness([], {})).toBe("claude");
    expect(resolveHarness(["whatever"], {})).toBe("claude");
  });
});

describe("输出协议（Codex）", () => {
  test("enforce：X2 → permissionDecision=deny，只含三个白名单字段", async () => {
    const { home } = await boot({ mode: "enforce" });
    const r = await runHook(preBash("git reset --hard HEAD~1"), { home, ...CX });
    expect(r.exitCode).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(Object.keys(j)).toEqual(["hookSpecificOutput"]);
    expect(Object.keys(j.hookSpecificOutput).sort()).toEqual(["hookEventName", "permissionDecision", "permissionDecisionReason"]);
    expect(j.hookSpecificOutput.permissionDecision).toBe("deny");
    for (const k of FORBIDDEN) expect(r.stdout).not.toContain(k);
  });
  test("enforce：写 .env（apply_patch）在 Codex 上是 deny，不是 ask", async () => {
    const { home } = await boot({ mode: "enforce" });
    const r = await runHook(prePatch(ENV_PATCH), { home, ...CX });
    const j = JSON.parse(r.stdout);
    expect(j.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(r.stdout).not.toContain('"ask"');
  });
  test("shadow / advise：X2 永远不输出（只由守护进程记 would_have_blocked）", async () => {
    for (const mode of ["shadow", "advise"] as const) {
      const { d, home } = await boot({ mode });
      for (const p of [preBash("git reset --hard HEAD~1"), prePatch(ENV_PATCH)]) {
        const r = await runHook(p, { home, ...CX });
        expect(r.stdout, mode).toBe("");
        expect(r.exitCode).toBe(0);
      }
      const n = d.store.db.query("SELECT COUNT(*) AS n FROM decisions d JOIN hits h ON h.id = d.hit_id WHERE h.rule_id = 'X2' AND d.outcome = 'would_have_blocked'").get() as { n: number };
      expect(n.n, mode).toBe(2);
    }
  });
  test("通过 `harness` 参数以外的方式（SV_HARNESS 不在 runHook 里读）：载荷带 turn_id 且没有显式 harness → 按 codex 处理", async () => {
    const { home } = await boot({ mode: "enforce" });
    const r = await runHook(preBash("git reset --hard HEAD~1"), { home }); // 没传 harness
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });
  test("enforce + 守护进程不可达：本地 X2 仍然 deny（X2 不依赖守护进程）；spool 标 codex", async () => {
    const home = tmp();
    writeFileSync(join(home, "hook.json"), JSON.stringify({ protocol: 1, mode: "enforce", socket: join(home, "nope.sock") }));
    const r = await runHook(preBash("git reset --hard HEAD~1"), { home, ...CX, timeoutMs: 500 });
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(r.note).toBe("daemon-unreachable");
    expect(JSON.parse(readFileSync(join(home, "health-spool.jsonl"), "utf8").trim().split("\n")[0])).toMatchObject({ harness: "codex", event: "PreToolUse" });
  });
  test("守护进程不可达：不输出、exit 0，spool 记 harness=codex；之后守护进程补记为 codex 的 adapter_health", async () => {
    const home = tmp();
    const r = await runHook(preBash("ls"), { home, ...CX, timeoutMs: 500 });
    expect(r).toMatchObject({ stdout: "", exitCode: 0, note: "daemon-unreachable" });
    const line = JSON.parse(readFileSync(join(home, "health-spool.jsonl"), "utf8").trim());
    expect(line).toMatchObject({ harness: "codex", event: "PreToolUse" });
    // 守护进程之后启动：补记
    const d = await startDaemon({ cfg: resolveConfig({}, defaultConfig()), home, dbPath: join(home, "state.db"), socketPath: join(home, "sock") });
    daemons.push(d);
    const st = d.status();
    expect(st.adapterFailures15m).toEqual({ codex: 1 });
  });
  test("坏 stdin / 空 stdin / 非对象：fail-open", async () => {
    const home = tmp();
    for (const s of ["", "not json", "[1,2]", "null", "42"]) expect(await runHook(s, { home, ...CX })).toMatchObject({ stdout: "", exitCode: 0 });
  });
  test("超时：守护进程不响应 → 不输出、exit 0", async () => {
    const home = tmp();
    const sock = join(home, "slow.sock");
    servers.push(Bun.serve({ unix: sock, fetch: () => new Promise<Response>(() => {}) }));
    writeFileSync(join(home, "hook.json"), JSON.stringify({ protocol: 1, mode: "enforce", socket: sock }));
    const t0 = Date.now();
    const r = await runHook(preBash("ls"), { home, ...CX, timeoutMs: 150 });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r).toMatchObject({ stdout: "", exitCode: 0, note: "daemon-unreachable" });
  });
  test("守护进程说 block 但 mode 不是 enforce：丢弃（shadow 永不拦截是适配器自己的铁律）；advise 只放行 advise", async () => {
    for (const [mode, kind, expectOut] of [["shadow", "block", false], ["shadow", "advise", false], ["advise", "block", false], ["advise", "advise", true], ["enforce", "block", true]] as const) {
      const home = tmp();
      const sock = join(home, "fake.sock");
      servers.push(Bun.serve({ unix: sock, fetch: () => Response.json({ ok: true, delivery: { kind, text: "测试消息。", ruleId: "L1" } }) }));
      writeFileSync(join(home, "hook.json"), JSON.stringify({ protocol: 1, mode, socket: sock }));
      const r = await runHook(preBash("ls"), { home, ...CX });
      expect(r.stdout !== "", `${mode}/${kind}`).toBe(expectOut);
      if (!expectOut && kind !== "advise") expect(r.note).toBe(`dropped-by-mode:${mode}`);
    }
  });
  test("Stop：enforce 下守护进程的 stop_continue → {decision:'block', reason}；stop_hook_active=true 时不输出", async () => {
    const { d, home } = await boot({ mode: "enforce" });
    await runHook(preBash("ls"), { home, ...CX });
    d.outbox.enqueue({ sessionId: "cx1", kind: "stop_continue", text: "最后一次编辑之后没有运行过测试，请先运行相关测试。", deliveryId: "s1" });
    const active = await runHook(payload({ hook_event_name: "Stop", stop_hook_active: true }), { home, ...CX });
    expect(active.stdout).toBe("");
    const r = await runHook(payload({ hook_event_name: "Stop", stop_hook_active: false }), { home, ...CX });
    expect(JSON.parse(r.stdout)).toEqual({ decision: "block", reason: "最后一次编辑之后没有运行过测试，请先运行相关测试。" });
  });
  test("PostToolUse 的建议 → additionalContext（advise 模式）；没有 permissionDecision/decision", async () => {
    const { d, home } = await boot({ mode: "advise" });
    await runHook(preBash("ls"), { home, ...CX });
    d.outbox.enqueue({ sessionId: "cx1", kind: "advise", text: "上一次运行之后没有改动过文件。", deliveryId: "a1" });
    const r = await runHook(payload({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: "a", tool_use_id: "c1" }), { home, ...CX });
    const j = JSON.parse(r.stdout);
    expect(j.hookSpecificOutput).toEqual({ hookEventName: "PostToolUse", additionalContext: "上一次运行之后没有改动过文件。" });
    expect(r.stdout).not.toContain("permissionDecision");
    expect(r.stdout).not.toContain('"decision"');
  });
  test("Codex 没有的事件（PostToolUseFailure）与 UserPromptSubmit/SessionStart：即使守护进程给了 delivery 也不输出", async () => {
    const home = tmp();
    const sock = join(home, "fake.sock");
    servers.push(Bun.serve({ unix: sock, fetch: () => Response.json({ ok: true, delivery: { kind: "advise", text: "测试消息。" } }) }));
    writeFileSync(join(home, "hook.json"), JSON.stringify({ protocol: 1, mode: "enforce", socket: sock }));
    for (const name of ["PostToolUseFailure", "PostToolBatch", "UserPromptSubmit", "SessionStart", "PermissionRequest"]) {
      const r = await runHook(payload({ hook_event_name: name, tool_name: "Bash", tool_input: { command: "ls" }, prompt: "x" }), { home, ...CX });
      expect(r.stdout, name).toBe("");
    }
  });
});

describe("SV_HOOK_DUMP（默认关）", () => {
  const SECRET = "sk-abcdefghijklmnop1234567890XYZ";
  test("默认不落盘；打开后写入脱敏后的载荷，文件 0600、目录 0700", async () => {
    const home = tmp();
    await runHook(preBash(`curl -H "Authorization: Bearer ${SECRET}" x`), { home, ...CX, timeoutMs: 200 });
    expect(existsSync(join(home, "dumps"))).toBe(false);
    await runHook(preBash(`API_KEY=${SECRET} make`), { home, ...CX, timeoutMs: 200, dump: true, now: () => Date.UTC(2026, 9, 18) });
    const f = join(home, "dumps", "codex-2026-10-18.jsonl");
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "dumps")).mode & 0o777).toBe(0o700);
    const text = readFileSync(f, "utf8");
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text.trim()).payload).toMatchObject({ hook_event_name: "PreToolUse", session_id: "cx1" });
  });
});
