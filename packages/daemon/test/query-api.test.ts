// 只读查询 API：对着真实守护进程产生的日志查询；不写 SQL，全部走 core/store/queries.ts。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, resolveConfig } from "@sv/core";
import { Daemon, startDaemon } from "../src/index.ts";

const dirs: string[] = [];
const daemons: Daemon[] = [];
afterEach(async () => {
  while (daemons.length) await daemons.pop()!.stop();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
async function boot(over: Record<string, unknown> = {}) {
  const home = mkdtempSync(join(tmpdir(), "sv-qa-"));
  dirs.push(home);
  const d = await startDaemon({ cfg: resolveConfig(over, defaultConfig()), home, dbPath: join(home, "state.db"), socketPath: join(home, "sock") });
  daemons.push(d);
  return d;
}
const get = (d: Daemon, path: string) => fetch(`http://localhost${path}`, { unix: d.socketPath! });
const post = (d: Daemon, harness: string, payload: unknown) => fetch("http://localhost/v1/hook", { unix: d.socketPath!, method: "POST", body: JSON.stringify({ harness, payload }) });

async function seed(d: Daemon) {
  const cwd = mkdtempSync(join(tmpdir(), "sv-qa-cwd-"));
  dirs.push(cwd);
  const cc = (extra: Record<string, unknown>) => ({ session_id: "cc-1", cwd, model: "m-a", ...extra });
  await post(d, "claude", cc({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git reset --hard HEAD~1" }, tool_use_id: "t1" }));
  await post(d, "claude", cc({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "git reset --hard HEAD~1" }, tool_response: { stdout: "ok" }, tool_use_id: "t1" }));
  await post(d, "codex", { session_id: "cx-1", cwd, model: "m-b", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "c1" });
  await post(d, "opencode", { sessionID: "oc-1", directory: cwd, model: "m-c", event: "tool.before", tool: "bash", args: { command: "ls" }, callID: "o1" });
}

describe("只读查询 API", () => {
  test("GET /v1/sessions：三个 harness 的会话都在，带 danger 汇总；harness / has_danger / sort 过滤", async () => {
    const d = await boot();
    await seed(d);
    const all = (await (await get(d, "/v1/sessions")).json()) as { sessions: Record<string, any>[] };
    expect(all.sessions.map((s) => s.harness).sort()).toEqual(["claude", "codex", "opencode"]);
    const cc = all.sessions.find((s) => s.harness === "claude")!;
    expect(cc.danger).toEqual({ total: 1, wouldHaveBlocked: 1, enforced: 0 }); // shadow：本应拦截，没有拦
    const only = (await (await get(d, "/v1/sessions?harness=opencode")).json()) as { sessions: unknown[] };
    expect(only.sessions.length).toBe(1);
    const dg = (await (await get(d, "/v1/sessions?has_danger=true&sort=danger_desc")).json()) as { sessions: Record<string, any>[] };
    expect(dg.sessions.map((s) => s.session_id)).toEqual(["cc-1"]);
  });
  test("GET /v1/sessions/{id}：存在 → 摘要；不存在 → 404", async () => {
    const d = await boot();
    await seed(d);
    const r = await get(d, "/v1/sessions/cx-1");
    expect(r.status).toBe(200);
    expect(((await r.json()) as { harness: string }).harness).toBe("codex");
    expect((await get(d, "/v1/sessions/nope")).status).toBe(404);
  });
  test("GET /v1/danger/stats 与 /v1/danger/events：shadow 下 would_have_blocked，不是 blocked", async () => {
    const d = await boot();
    await seed(d);
    const st = (await (await get(d, "/v1/danger/stats")).json()) as { total: number; wouldHaveBlocked: number; enforced: number; byCategory: Record<string, number> };
    expect(st).toMatchObject({ total: 1, wouldHaveBlocked: 1, enforced: 0 });
    const ev = (await (await get(d, "/v1/danger/events?session=cc-1")).json()) as { events: { outcome: string; sessionId: string }[] };
    expect(ev.events).toHaveLength(1);
    expect(ev.events[0]).toMatchObject({ outcome: "would_have_blocked", sessionId: "cc-1" });
    expect(((await (await get(d, "/v1/danger/events?session=other")).json()) as { events: unknown[] }).events).toEqual([]);
  });
  test("GET /v1/hits/{id}（explain 链路）、/v1/rules/stats、/v1/runs、/v1/judge-calls/stats、/v1/runs/compare", async () => {
    const d = await boot();
    await seed(d);
    const ev = (await (await get(d, "/v1/danger/events")).json()) as { events: { hitId: number }[] };
    const hit = (await (await get(d, `/v1/hits/${ev.events[0].hitId}`)).json()) as { hit: { rule_id: string }; decisions: unknown[] };
    expect(hit.hit.rule_id).toBe("X2");
    expect(hit.decisions.length).toBeGreaterThan(0);
    expect((await get(d, "/v1/hits/99999")).status).toBe(404);
    expect((await get(d, "/v1/hits/abc")).status).toBe(400);
    const rs = (await (await get(d, "/v1/rules/stats")).json()) as { by: string; rows: { rule: string }[] };
    expect(rs.by).toBe("rule");
    expect(rs.rows.some((r) => r.rule === "X2")).toBe(true);
    expect(((await (await get(d, "/v1/rules/stats?by=model")).json()) as { by: string }).by).toBe("model");
    const runs = (await (await get(d, "/v1/runs")).json()) as { runs: { kind: string }[] };
    expect(runs.runs[0].kind).toBe("live");
    expect((await get(d, "/v1/judge-calls/stats")).status).toBe(200);
    expect((await get(d, "/v1/runs/compare?a=1&b=1")).status).toBe(200);
    expect((await get(d, "/v1/runs/compare?a=x")).status).toBe(400);
  });
  test("参数校验：since 不是数字 / run 不是整数 → 400；label 匹配不到任何运行 → 空结果而不是全部", async () => {
    const d = await boot();
    await seed(d);
    expect((await get(d, "/v1/sessions?since=abc")).status).toBe(400);
    expect((await get(d, "/v1/sessions?run=1,x")).status).toBe(400);
    const none = (await (await get(d, "/v1/sessions?label=does-not-exist")).json()) as { sessions: unknown[] };
    expect(none.sessions).toEqual([]);
  });
  test("只读：POST 不会命中查询路径；查询内部出错返回 500，不算适配器故障，hook 路径不受影响", async () => {
    const d = await boot();
    await seed(d);
    expect((await fetch("http://localhost/v1/sessions", { unix: d.socketPath!, method: "POST", body: "{}" })).status).toBe(404);
    const before = (d.store.db.query("SELECT COUNT(*) AS n FROM adapter_health WHERE ok = 0").get() as { n: number }).n;
    d.store.db.run("ALTER TABLE hits RENAME TO hits_gone"); // 制造查询失败
    const r = await get(d, "/v1/danger/stats");
    expect(r.status).toBe(500);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("query_failed");
    expect((d.store.db.query("SELECT COUNT(*) AS n FROM adapter_health WHERE ok = 0").get() as { n: number }).n).toBe(before);
    d.store.db.run("ALTER TABLE hits_gone RENAME TO hits");
    expect((await get(d, "/v1/danger/stats")).status).toBe(200);
  });
  test("HTTP + token 也能查；没有 token → 401", async () => {
    const home = mkdtempSync(join(tmpdir(), "sv-qa-"));
    dirs.push(home);
    const d = await startDaemon({ cfg: resolveConfig({}, defaultConfig()), home, dbPath: join(home, "state.db"), socketPath: join(home, "sock"), port: 0 });
    daemons.push(d);
    expect((await fetch(`http://127.0.0.1:${d.port}/v1/sessions`)).status).toBe(401);
    const token = (await Bun.file(join(home, "token")).text()).trim();
    expect((await fetch(`http://127.0.0.1:${d.port}/v1/sessions`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
  });
});
