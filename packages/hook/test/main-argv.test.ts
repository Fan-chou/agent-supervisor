// 端到端：真的启动 packages/hook/src/main.ts 进程，证明「同一个二进制按命令行参数区分 harness」。
// 同一个输入（写 <cwd>/.env，且载荷里没有 turn_id）：Claude 上是 ask，Codex 上是 deny（Codex 不支持 ask）。
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = join(import.meta.dir, "../src/main.ts");
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function runMain(args: string[], envOver: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "sv-main-"));
  dirs.push(home);
  // 守护进程不可达（socket 不存在）+ enforce：只有本地 X2 能产生输出
  writeFileSync(join(home, "hook.json"), JSON.stringify({ protocol: 1, mode: "enforce", socket: join(home, "nope.sock") }));
  const env: Record<string, string> = { ...(process.env as Record<string, string>), SV_HOME: home, SV_HOOK_TIMEOUT_MS: "300", ...envOver };
  if (!("SV_HARNESS" in envOver)) delete env.SV_HARNESS;
  const payload = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s1", cwd: "/Users/jack/proj", tool_name: "Write", tool_input: { file_path: "/Users/jack/proj/.env", content: "A=1" }, tool_use_id: "w1" });
  const p = Bun.spawn(["bun", MAIN, ...args], { env, stdin: new Blob([payload]), stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  const code = await p.exited;
  return { out, code, home };
}

test("无参数 → claude：写 .env 是 ask；exit 0", async () => {
  const r = await runMain([]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out).hookSpecificOutput.permissionDecision).toBe("ask");
});
test("参数 `claude` → ask", async () => {
  const r = await runMain(["claude"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out).hookSpecificOutput.permissionDecision).toBe("ask");
});
test("参数 `codex` → 同一个输入变成 deny；exit 0；spool 标 codex", async () => {
  const r = await runMain(["codex"]);
  expect(r.code).toBe(0);
  const j = JSON.parse(r.out);
  expect(j.hookSpecificOutput.permissionDecision).toBe("deny");
  expect(Object.keys(j.hookSpecificOutput).sort()).toEqual(["hookEventName", "permissionDecision", "permissionDecisionReason"]);
  expect(readFileSync(join(r.home, "health-spool.jsonl"), "utf8")).toContain('"harness":"codex"');
});
test("参数 `--harness=codex` → deny", async () => {
  const r = await runMain(["--harness=codex"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out).hookSpecificOutput.permissionDecision).toBe("deny");
});
test("参数优先于 SV_HARNESS：`claude` + SV_HARNESS=codex → ask；无参数 + SV_HARNESS=codex → deny", async () => {
  expect(JSON.parse((await runMain(["claude"], { SV_HARNESS: "codex" })).out).hookSpecificOutput.permissionDecision).toBe("ask");
  expect(JSON.parse((await runMain([], { SV_HARNESS: "codex" })).out).hookSpecificOutput.permissionDecision).toBe("deny");
});
test("不会因为参数乱写而崩：未知参数当作默认 claude，exit 0", async () => {
  const r = await runMain(["--what"]);
  expect(r.code).toBe(0);
  expect(existsSync(join(r.home, "dumps"))).toBe(false);
});
