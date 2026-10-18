import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogStore } from "@sv/core";
import { main } from "../src/sv.ts";
import { claudeHooksJson, codexHooksJson, codexInstallSnippet, installSnippet, launchdPlist } from "../src/install.ts";

const ROOT = join(import.meta.dir, "../../..");
const SV = join(ROOT, "packages/cli/src/sv.ts");
const FX = join(ROOT, "test/fixtures");
const dirs: string[] = [];
const stops: (() => void)[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "sv-cli-d-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (stops.length) stops.pop()!();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function run(args: string[]) {
  const out: string[] = [];
  const o1 = console.log;
  const o2 = console.error;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void out.push(a.join(" "));
  try {
    return { code: await main(args), out: out.join("\n") };
  } finally {
    console.log = o1;
    console.error = o2;
  }
}

describe("sv start / status：守护进程生命周期", () => {
  test("前台启动 → status 可查 → SIGTERM 优雅退出（run 结束、socket 移除、exit 0）", async () => {
    const home = tmp();
    const p = Bun.spawn(["bun", SV, "start", "--home", home], { stdout: "pipe", stderr: "pipe" });
    const sock = join(home, "sock");
    for (let i = 0; i < 100 && !existsSync(sock); i++) await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(sock)).toBe(true);
    const st = await run(["status", "--home", home]);
    expect(st.code).toBe(0);
    expect(JSON.parse(st.out)).toMatchObject({ protocol: 1, mode: "shadow", judge: { enabled: false } });
    p.kill("SIGTERM");
    expect(await p.exited).toBe(0);
    expect(existsSync(sock)).toBe(false);
    const s = new LogStore(join(home, "state.db"));
    const run1 = s.db.query("SELECT kind, ended_ts FROM runs").get() as { kind: string; ended_ts: number };
    expect(run1.kind).toBe("live");
    expect(run1.ended_ts).toBeGreaterThan(0);
    expect((await run(["status", "--home", home])).code).toBe(1); // 退出后不可达
  });
  test("sv start --judge=live --mode enforce：status 里能看到 judge 与 mode", async () => {
    const home = tmp();
    const p = Bun.spawn(["bun", SV, "start", "--home", home, "--mode", "enforce", "--judge=live"], { stdout: "pipe", stderr: "pipe" });
    const sock = join(home, "sock");
    for (let i = 0; i < 100 && !existsSync(sock); i++) await new Promise((r) => setTimeout(r, 50));
    const st = JSON.parse((await run(["status", "--home", home])).out);
    expect(st).toMatchObject({ mode: "enforce", judge: { enabled: true, base_url: "http://127.0.0.1:3425/v1", model: "supervisor-judge" } });
    p.kill("SIGTERM");
    await p.exited;
  });
  test("已有守护进程占着 socket → 第二个 start 失败并给出原因", async () => {
    const home = tmp();
    const p = Bun.spawn(["bun", SV, "start", "--home", home], { stdout: "pipe", stderr: "pipe" });
    const sock = join(home, "sock");
    for (let i = 0; i < 100 && !existsSync(sock); i++) await new Promise((r) => setTimeout(r, 50));
    const second = await run(["start", "--home", home]);
    expect(second.code).toBe(2);
    expect(second.out).toContain("已有守护进程");
    p.kill("SIGTERM");
    await p.exited;
  });
});

describe("sv install：只打印，不改文件", () => {
  test("hooks 片段：固定路径的 command 钩子；PreToolUse 20 秒，其余 5 秒；没有 npx", () => {
    const j = JSON.parse(claudeHooksJson()).hooks;
    expect(Object.keys(j).sort()).toEqual(["PostToolBatch", "PostToolUse", "PostToolUseFailure", "PreToolUse", "SessionStart", "Stop", "UserPromptSubmit"]);
    expect(j.PreToolUse[0].hooks[0]).toMatchObject({ type: "command", command: "~/.agent-supervisor/bin/sv-hook", timeout: 20 });
    expect(j.PostToolUse[0].hooks[0].timeout).toBe(5);
    expect(claudeHooksJson()).not.toContain("npx");
    expect(launchdPlist()).toContain("supervisord");
    expect(installSnippet({ launchd: true })).toContain("launchctl load");
  });
  test("CLI：sv install claude 输出片段，不创建任何文件；未知 harness 报用法", async () => {
    const before = existsSync(join(process.env.HOME ?? "/nonexistent", ".agent-supervisor-test-marker"));
    const r = await run(["install", "claude", "--launchd"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("sv-hook");
    expect(r.out).toContain("PreToolUse");
    expect(existsSync(join(process.env.HOME ?? "/nonexistent", ".agent-supervisor-test-marker"))).toBe(before);
    expect((await run(["install", "opencode"])).code).toBe(2);
  });
  test("Codex 片段：固定命令串 `sv-hook codex`；只含 Codex 有的事件；PreToolUse 20 秒其余 5 秒；没有 npx；提示信任审核与未实测", () => {
    const j = JSON.parse(codexHooksJson()).hooks;
    expect(Object.keys(j).sort()).toEqual(["PostToolUse", "PreToolUse", "SessionStart", "Stop", "UserPromptSubmit"]); // 没有 PostToolUseFailure / PostToolBatch
    expect(j.PreToolUse[0].hooks[0]).toEqual({ type: "command", command: "~/.agent-supervisor/bin/sv-hook codex", timeout: 20 });
    expect(j.Stop[0].hooks[0].timeout).toBe(5);
    expect(codexHooksJson()).not.toContain("npx");
    const s = codexInstallSnippet();
    expect(s).toContain("/hooks");
    expect(s).toContain("哈希");
    expect(s).toContain("没有在 0.163 上实测");
    expect(s).toContain("SV_HOOK_DUMP=1");
  });
  test("CLI：sv install codex 只打印；退出码 0；不读也不写 ~/.codex（用一个假 HOME 验证目录没有被创建）", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "sv-fakehome-"));
    try {
      const p = Bun.spawn(["bun", SV, "install", "codex"], { env: { ...process.env, HOME: fakeHome }, stdout: "pipe", stderr: "pipe" });
      const out = await new Response(p.stdout).text();
      expect(await p.exited).toBe(0);
      expect(out).toContain("sv-hook codex");
      expect(existsSync(join(fakeHome, ".codex"))).toBe(false);
      expect(readdirSync(fakeHome)).toEqual([]);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

describe("sv replay --judge=live（对着本机 mock server）", () => {
  const GOOD = { verdict: "advise", confidence: 0.82, category: "loop", message_to_agent: "同一调用已连续失败，建议先读报错再改。", reason: "r", evidence_steps: [], watch: [], done: false };
  test("走 config.judge.base_url；结果显示 judge=live；日志里有 judge 调用；stderr 报 parse_fail 率", async () => {
    const seen: any[] = [];
    let bad = false;
    const s = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        seen.push(await req.json());
        return Response.json({ choices: [{ message: { content: bad ? "不是 JSON" : JSON.stringify(GOOD) } }] });
      },
    });
    stops.push(() => s.stop(true));
    const dir = tmp();
    const cfgPath = join(dir, "config.yaml");
    writeFileSync(cfgPath, `judge:\n  enabled: true\n  base_url: http://127.0.0.1:${s.port}/v1\n  model: test-judge\n`);
    const db = join(dir, "state.db");
    const r = await run(["replay", join(FX, "claude/fail-loop.jsonl"), "--judge=live", "--config", cfgPath, "--log", db, "--label", "live"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("judge=live");
    expect(r.out).toMatch(/judge test-judge: 调用 \d+ ok \d+ parse_fail 0/);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0].model).toBe("test-judge");
    const store = new LogStore(db);
    expect((store.db.query("SELECT model, status FROM judge_calls").get() as { model: string }).model).toBe("test-judge");
    // 换成坏响应：失败率可在 sv stats --by judge 里看到
    bad = true;
    const db2 = join(dir, "bad.db");
    const r2 = await run(["replay", join(FX, "claude/fail-loop.jsonl"), "--judge=live", "--config", cfgPath, "--log", db2]);
    expect(r2.out).toMatch(/parse_fail [1-9]/);
    const stats = await run(["stats", "--db", db2, "--by", "judge", "--format", "json"]);
    const rows = JSON.parse(stats.out) as { model: string; parseFailRate: number }[];
    expect(rows[0].model).toBe("test-judge");
    expect(rows[0].parseFailRate).toBe(1);
  });
  test("judge 不可达：replay 照常完成（fail-open）", async () => {
    const dir = tmp();
    const cfgPath = join(dir, "config.yaml");
    writeFileSync(cfgPath, `judge:\n  enabled: true\n  base_url: http://127.0.0.1:1/v1\n  timeout_async_s: 1\n`);
    const r = await run(["replay", join(FX, "claude/fail-loop.jsonl"), "--judge=live", "--config", cfgPath]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("L1");
  });
});
