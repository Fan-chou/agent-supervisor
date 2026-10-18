// 守护进程 + live judge（对着本机 mock server 的真实 HTTP，不碰外部服务）。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogStore, defaultConfig, judgeStats, resolveConfig } from "@sv/core";
import { Daemon, startDaemon, type HookResponse } from "../src/index.ts";

const dirs: string[] = [];
const daemons: Daemon[] = [];
const stops: (() => void)[] = [];
const tmp = (p = "sv-live-") => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  while (daemons.length) await daemons.pop()!.stop();
  while (stops.length) stops.pop()!();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function boot(over: Record<string, unknown>) {
  const home = tmp();
  const d = await startDaemon({ cfg: resolveConfig(over, defaultConfig()), home, dbPath: join(home, "state.db"), socketPath: join(home, "sock") });
  daemons.push(d);
  return { d, home };
}
const uds = (d: Daemon) => ({ unix: d.socketPath! });
async function post(d: Daemon, payload: unknown): Promise<HookResponse> {
  const r = await fetch("http://localhost/v1/hook", { ...uds(d), method: "POST", headers: { "x-sv-protocol": "1" }, body: JSON.stringify({ harness: "claude", payload }) });
  return (await r.json()) as HookResponse;
}
let n = 0;
const H = (cwd: string, extra: Record<string, unknown>) => ({ session_id: "live-1", cwd, ...extra });
async function bash(d: Daemon, cwd: string, cmd: string, out: string) {
  const id = `tu_${n++}`;
  const r = await post(d, H(cwd, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: cmd }, tool_use_id: id }));
  await post(d, H(cwd, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: cmd }, tool_response: { stdout: out, stderr: "" }, tool_use_id: id }));
  return r;
}

const GOOD = { verdict: "advise", confidence: 0.82, category: "loop", message_to_agent: "同一调用输出完全相同，建议换个办法获取信息。", reason: "r", evidence_steps: [], watch: [], done: false };
function mock(handler: () => Response) {
  const seen: { body: any; headers: Record<string, string> }[] = [];
  const s = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      seen.push({ body: await req.json(), headers: Object.fromEntries(req.headers) });
      return handler();
    },
  });
  stops.push(() => s.stop(true));
  return { seen, baseUrl: `http://127.0.0.1:${s.port}/v1` };
}
const SECRET = "sk-abcdefghijklmnopqrstuvwxyz123456";

describe("live judge × 守护进程", () => {
  test("按 config 调 judge：key 只来自环境变量；请求/响应脱敏后入日志；建议经 outbox 送出", async () => {
    const m = mock(() => Response.json({ choices: [{ message: { content: JSON.stringify(GOOD) } }], usage: { prompt_tokens: 700, completion_tokens: 50 } }));
    const old = process.env.SUPERVISOR_API_KEY;
    process.env.SUPERVISOR_API_KEY = "sk-live-REALKEY1234567890abcdef";
    try {
      const { d, home } = await boot({ mode: "advise", judge: { enabled: true, base_url: m.baseUrl } });
      const cwd = tmp("sv-nogit-");
      for (let i = 0; i < 4; i++) await bash(d, cwd, `curl -s https://x.test/a -H "Authorization: Bearer abcdef0123456789tokenvalue" ${SECRET}`, "same output");
      await new Promise((r) => setTimeout(r, 200));
      const next = await post(d, H(cwd, { hook_event_name: "PostToolBatch" }));
      expect(next.delivery).toMatchObject({ kind: "advise", ruleId: "L2" });
      expect(m.seen).toHaveLength(1);
      expect(m.seen[0].headers.authorization).toBe("Bearer sk-live-REALKEY1234567890abcdef");
      expect(m.seen[0].body.model).toBe("supervisor-judge");
      await d.stop();
      daemons.pop();
      const s = new LogStore(join(home, "state.db"));
      const j = s.db.query("SELECT * FROM judge_calls").get() as Record<string, any>;
      expect(j).toMatchObject({ status: "ok", verdict: "advise", prompt_tokens: 700, completion_tokens: 50, sync: 0, model: "supervisor-judge" });
      const dump = JSON.stringify(["judge_calls", "events", "hits", "decisions", "outbox", "deliveries"].map((t) => s.db.query(`SELECT * FROM ${t}`).all()));
      for (const leak of ["abcdefghijklmnopqrstuvwxyz123456", "abcdef0123456789tokenvalue", "REALKEY"]) expect(dump).not.toContain(leak);
      expect(j.request_json).toContain("<untrusted>");
      expect(j.request_json).toContain("REDACTED");
    } finally {
      if (old === undefined) delete process.env.SUPERVISOR_API_KEY;
      else process.env.SUPERVISOR_API_KEY = old;
    }
  });
  test("解析失败率可统计：judge 一直吐垃圾 → judge_calls 全是 parse_fail，agent 不受影响（fail-open）", async () => {
    const m = mock(() => Response.json({ choices: [{ message: { content: "对不起，我不会输出 JSON" } }] }));
    const { d, home } = await boot({ mode: "enforce", judge: { enabled: true, base_url: m.baseUrl } });
    const cwd = tmp("sv-nogit-");
    for (let i = 0; i < 4; i++) expect((await bash(d, cwd, "cat build.log", "same")).delivery).toBeNull();
    await new Promise((r) => setTimeout(r, 300));
    expect((await post(d, H(cwd, { hook_event_name: "PostToolBatch" }))).delivery).toBeNull();
    const st = (await (await fetch("http://localhost/v1/status", uds(d))).json()) as { judge: { enabled: boolean; stats: Record<string, { parseFail: number; calls: number }> } };
    expect(st.judge.enabled).toBe(true);
    expect(st.judge.stats["supervisor-judge"]).toMatchObject({ calls: 1, parseFail: 1 });
    expect(m.seen).toHaveLength(2); // 异步调用解析失败会重试 1 次
    await d.stop();
    daemons.pop();
    const s = new LogStore(join(home, "state.db"));
    expect(judgeStats(s.db, {})[0]).toMatchObject({ model: "supervisor-judge", calls: 1, parseFail: 1, parseFailRate: 1 });
    expect(s.db.query("SELECT action FROM decisions WHERE rule_id='L2'").get()).toEqual({ action: "ignore" });
  });
  test("json_schema 被上游拒绝 → 回退 json_object；日志记录 format_level 与降级", async () => {
    const m = mock(() => Response.json({ choices: [{ message: { content: JSON.stringify(GOOD) } }] }));
    let first = true;
    const wrapped = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const body = await req.json();
        if (body.response_format?.type === "json_schema") {
          first = false;
          return Response.json({ error: { message: "response_format json_schema is not supported" } }, { status: 400 });
        }
        return Response.json({ choices: [{ message: { content: JSON.stringify(GOOD) } }] });
      },
    });
    stops.push(() => wrapped.stop(true));
    void m;
    const { d, home } = await boot({ mode: "advise", judge: { enabled: true, base_url: `http://127.0.0.1:${wrapped.port}/v1` } });
    const cwd = tmp("sv-nogit-");
    for (let i = 0; i < 4; i++) await bash(d, cwd, "cat build.log", "same");
    await new Promise((r) => setTimeout(r, 200));
    await d.stop();
    daemons.pop();
    expect(first).toBe(false);
    const s = new LogStore(join(home, "state.db"));
    expect(s.db.query("SELECT status, format_level, format_downgraded, http_requests FROM judge_calls").get()).toEqual({ status: "ok", format_level: "json_object", format_downgraded: 1, http_requests: 2 });
  });
  test("judge 不可达：fail-open，本地规则（X2）照常工作", async () => {
    const { d } = await boot({ mode: "enforce", judge: { enabled: true, base_url: "http://127.0.0.1:1/v1" } });
    const cwd = "/Users/jack/proj";
    for (let i = 0; i < 4; i++) expect((await bash(d, cwd, "cat build.log", "same")).ok).toBe(true);
    const r = await post(d, H(cwd, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git reset --hard" }, tool_use_id: "x" }));
    expect(r.delivery?.kind).toBe("block");
  });
  test("judge.enabled=false（默认）：从不发请求", async () => {
    const m = mock(() => Response.json({ choices: [{ message: { content: JSON.stringify(GOOD) } }] }));
    const { d } = await boot({ mode: "enforce", judge: { enabled: false, base_url: m.baseUrl } });
    const cwd = tmp("sv-nogit-");
    for (let i = 0; i < 4; i++) await bash(d, cwd, "cat build.log", "same");
    await new Promise((r) => setTimeout(r, 100));
    expect(m.seen).toHaveLength(0);
  });
});
