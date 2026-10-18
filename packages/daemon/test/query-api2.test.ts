// 只读查询 API 第二批：timeline / events / children / hits 列表 / CSV / schema（响应按 schema 校验）。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, resolveConfig } from "@sv/core";
import { Daemon, startDaemon } from "../src/index.ts";
import { SCHEMA_NAMES, schemaFor } from "../src/schemas.ts";
import { csvCell, toCsv } from "../src/query-api.ts";
import { validate } from "./helpers/validate.ts";

const dirs: string[] = [];
const daemons: Daemon[] = [];
afterEach(async () => {
  while (daemons.length) await daemons.pop()!.stop();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
async function boot(over: Record<string, unknown> = {}) {
  const home = mkdtempSync(join(tmpdir(), "sv-qb-"));
  dirs.push(home);
  const d = await startDaemon({ cfg: resolveConfig(over, defaultConfig()), home, dbPath: join(home, "state.db"), socketPath: join(home, "sock"), port: 0 });
  daemons.push(d);
  return d;
}
const get = (d: Daemon, path: string) => fetch(`http://localhost${path}`, { unix: d.socketPath! });
const json = async (d: Daemon, path: string) => (await get(d, path)).json() as Promise<any>;
const post = (d: Daemon, payload: unknown, harness = "claude") => fetch("http://localhost/v1/hook", { unix: d.socketPath!, method: "POST", body: JSON.stringify({ harness, payload }) });

async function seed(d: Daemon) {
  const cwd = mkdtempSync(join(tmpdir(), "sv-qb-cwd-"));
  dirs.push(cwd);
  const cc = (extra: Record<string, unknown>) => ({ session_id: "cc-1", cwd, model: "m-a", ...extra });
  await post(d, cc({ hook_event_name: "UserPromptSubmit", prompt: "go" }));
  let n = 0;
  const call = async (cmd: string) => {
    const id = `t${n++}`;
    await post(d, cc({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: cmd }, tool_use_id: id }));
    await post(d, cc({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: cmd }, tool_response: { stdout: "ok" }, tool_use_id: id }));
  };
  await call("ls");
  await call("git reset --hard HEAD~1");
  await call("=cmd|' /C calc'!A0"); // CSV 公式注入样本
  await post(d, cc({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "sleep 9" }, tool_use_id: "pending-1" }));
  await post(d, { session_id: "cx-1", cwd, model: "m-b", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "c1" }, "codex");
}

describe("timeline / events / children", () => {
  test("timeline：调用合并、pending、命中带危险字段；响应符合 schema", async () => {
    const d = await boot();
    await seed(d);
    const t = await json(d, "/v1/sessions/cc-1/timeline");
    expect(validate(schemaFor("Timeline")!, t)).toEqual([]);
    const calls = t.entries.filter((e: any) => e.type === "call");
    expect(calls.length).toBe(4);
    expect(calls.at(-1)).toMatchObject({ status: "pending", toolUseId: "pending-1" });
    const hit = t.entries.find((e: any) => e.type === "hit" && e.ruleId === "X2");
    expect(hit).toMatchObject({ dangerous: true, dangerCategory: "git", outcome: "would_have_blocked" });
    const danger = await json(d, "/v1/sessions/cc-1/timeline?severity=dangerous");
    expect(danger.entries.map((e: any) => e.type)).toEqual(["hit"]);
    const page = await json(d, "/v1/sessions/cc-1/timeline?limit=2");
    expect(page.entries.length).toBe(2);
    expect(page.hasMore).toBe(true);
    const older = await json(d, `/v1/sessions/cc-1/timeline?before_seq=${t.entries.at(-1).seq}&limit=2`);
    expect(older.entries.length).toBe(2);
  });
  test("实时跟随：since_seq 之后 pending 调用的 post 以同一个 seq 再出现，状态变 ok", async () => {
    const d = await boot();
    await seed(d);
    const t = await json(d, "/v1/sessions/cc-1/timeline");
    const pend = t.entries.find((e: any) => e.toolUseId === "pending-1");
    const maxSeq = t.entries.at(-1).seq;
    await post(d, { session_id: "cc-1", cwd: "/tmp", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "sleep 9" }, tool_response: { stdout: "" }, tool_use_id: "pending-1" });
    const inc = await json(d, `/v1/sessions/cc-1/timeline?since_seq=${maxSeq}`);
    const again = inc.entries.find((e: any) => e.toolUseId === "pending-1");
    expect(again.seq).toBe(pend.seq);
    expect(again.status).not.toBe("pending");
  });
  test("events：phase / q 过滤；children 为空数组；未知会话 404；参数非法 400", async () => {
    const d = await boot();
    await seed(d);
    const ev = await json(d, "/v1/sessions/cc-1/events?phase=pre&q=reset");
    expect(ev.events.length).toBe(1);
    expect(ev.events[0].normCmd).toContain("git reset");
    expect((await json(d, "/v1/sessions/cc-1/children")).children).toEqual([]);
    expect((await get(d, "/v1/sessions/nope/timeline")).status).toBe(404);
    expect((await get(d, "/v1/sessions/nope/events")).status).toBe(404);
    expect((await get(d, "/v1/sessions/cc-1/timeline?limit=x")).status).toBe(400);
    expect((await get(d, "/v1/sessions/cc-1/timeline?before_seq=1.5")).status).toBe(400);
  });
});

describe("/v1/rules 与 /v1/config（只读）", () => {
  test("rules：目录 + 生效阈值 + 覆盖；符合 schema；改配置阈值跟着变", async () => {
    const d = await boot({ thresholds: { L2_repeat: 7 }, rules: { S1: { disabled: true } } });
    const r = await json(d, "/v1/rules");
    expect(validate(schemaFor("RuleList")!, r)).toEqual([]);
    expect(r.mode).toBe("shadow");
    expect(r.rules.find((x: any) => x.id === "L2").thresholds.repeat).toBe(7);
    expect(r.rules.find((x: any) => x.id === "S1")).toMatchObject({ disabled: true, override: { disabled: true } });
    expect(r.rules.find((x: any) => x.id === "X2").level).toBe("H");
  });
  test("config：api key 只有变量名和是否已设置，凭据被遮掉，响应里没有密钥值；符合 schema；POST 不被接受", async () => {
    const prev = process.env.SV_TEST_JUDGE_KEY;
    process.env.SV_TEST_JUDGE_KEY = "sk-should-never-appear-0123456789";
    try {
      const d = await boot({ judge: { api_key_env: "SV_TEST_JUDGE_KEY", request: { headers: { Authorization: "Bearer sk-zzzzzzzzzzzzzzzzzzzz" } } } });
      const res = await get(d, "/v1/config");
      const text = await res.text();
      expect(text).not.toContain("sk-should-never-appear");
      expect(text).not.toContain("sk-zzzz");
      const c = JSON.parse(text);
      expect(validate(schemaFor("ConfigView")!, c)).toEqual([]);
      expect(c.judge).toEqual({ api_key_env: "SV_TEST_JUDGE_KEY", api_key_set: true });
      expect(c.config.mode).toBe("shadow");
      expect(c.config.judge.request.headers.Authorization).toBe("••••");
      expect((await fetch("http://localhost/v1/config", { unix: d.socketPath!, method: "POST", body: "{}" })).status).toBe(404);
    } finally {
      if (prev === undefined) delete process.env.SV_TEST_JUDGE_KEY;
      else process.env.SV_TEST_JUDGE_KEY = prev;
    }
  });
  test("HTTP 没有 token → 401（rules / config 同样要鉴权）", async () => {
    const d = await boot();
    for (const p of ["/v1/rules", "/v1/config", "/v1/judge-calls"]) expect((await fetch(`http://127.0.0.1:${d.port}${p}`)).status, p).toBe(401);
  });
});

describe("sessions：recent 排序、q / state 过滤", () => {
  test("last_ts / state / events 字段；sort=recent 最近活动在前；q 匹配 session_id / model / project；state 过滤；非法值 400", async () => {
    let t = 1_700_000_000_000;
    const home = mkdtempSync(join(tmpdir(), "sv-qs-"));
    dirs.push(home);
    const d = await startDaemon({ cfg: resolveConfig({}, defaultConfig()), home, dbPath: join(home, "state.db"), socketPath: join(home, "sock"), now: () => t });
    daemons.push(d);
    const cc = (sid: string, model: string) => post(d, { session_id: sid, cwd: "/tmp/proj-x", model, hook_event_name: "UserPromptSubmit", prompt: "hi" });
    await cc("old-one", "model-a");
    t += 20 * 60_000; // 20 分钟后
    await cc("new-one", "model-b");
    t += 60_000;
    const all = await json(d, "/v1/sessions?sort=recent");
    expect(all.sessions.map((s: any) => s.session_id)).toEqual(["new-one", "old-one"]);
    const byId = Object.fromEntries(all.sessions.map((s: any) => [s.session_id, s]));
    expect(byId["new-one"]).toMatchObject({ state: "active", events: 1 });
    expect(byId["old-one"]).toMatchObject({ state: "idle" });
    expect(byId["old-one"].last_ts).toBeLessThan(byId["new-one"].last_ts);
    for (const s of all.sessions) expect(validate(schemaFor("SessionSummary")!, s), JSON.stringify(s)).toEqual([]);
    expect((await json(d, "/v1/sessions?state=idle")).sessions.map((s: any) => s.session_id)).toEqual(["old-one"]);
    expect((await json(d, "/v1/sessions?state=active")).sessions.map((s: any) => s.session_id)).toEqual(["new-one"]);
    expect((await json(d, "/v1/sessions?q=MODEL-B")).sessions.map((s: any) => s.session_id)).toEqual(["new-one"]);
    expect((await json(d, "/v1/sessions?q=old")).sessions.length).toBe(1);
    expect((await json(d, "/v1/sessions?q=nothing-matches")).sessions).toEqual([]);
    expect((await get(d, "/v1/sessions?state=bogus")).status).toBe(400);
    expect((await get(d, "/v1/sessions?sort=bogus")).status).toBe(400);
    expect((await json(d, "/v1/sessions/new-one")).state).toBe("active");
  });
});

describe("hits 列表", () => {
  test("游标分页、按规则 / 级别 / 会话 / 结局 / 标注过滤；符合 schema", async () => {
    const d = await boot();
    await seed(d);
    const all = await json(d, "/v1/hits");
    expect(all.hits.length).toBeGreaterThan(0);
    for (const h of all.hits) expect(validate(schemaFor("Hit")!, h), JSON.stringify(h)).toEqual([]);
    const p1 = await json(d, "/v1/hits?limit=1");
    expect(p1.hits.length).toBe(1);
    if (all.hits.length > 1) {
      expect(p1.nextCursor).toBe(p1.hits[0].id);
      const p2 = await json(d, `/v1/hits?limit=1&cursor=${p1.nextCursor}`);
      expect(p2.hits[0].id).toBeLessThan(p1.hits[0].id);
    }
    expect((await json(d, "/v1/hits?rule=X2")).hits.every((h: any) => h.ruleId === "X2")).toBe(true);
    expect((await json(d, "/v1/hits?severity=dangerous&session=cc-1&outcome=would_have_blocked")).hits.length).toBe(1);
    expect((await json(d, "/v1/hits?session=cx-1")).hits).toEqual([]);
    d.store.mark(all.hits[0].id, "false_positive");
    expect((await json(d, "/v1/hits?label=false_positive")).hits.map((h: any) => h.id)).toEqual([all.hits[0].id]);
    expect((await get(d, "/v1/hits?label=bogus")).status).toBe(400);
    expect((await get(d, "/v1/hits?cursor=x")).status).toBe(400);
  });
});

describe("CSV 导出", () => {
  test("csvCell / toCsv：引号、逗号、换行转义；以 = + - @ 开头的文本加 ' 前缀；数字（含负数）不加", () => {
    expect(csvCell('a,"b"\nc')).toBe('"a,""b""\nc"');
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("@x")).toBe("'@x");
    expect(csvCell("-5 files")).toBe("'-5 files");
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell(null)).toBe("");
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
    expect(toCsv([{ a: 1, b: "x" }, { a: 2 }])).toBe("a,b\r\n1,x\r\n2,\r\n");
  });
  test("各 .csv 端点：content-type、表头、行数；公式注入样本被中和", async () => {
    const d = await boot();
    await seed(d);
    for (const p of ["/v1/hits/export.csv", "/v1/sessions/export.csv", "/v1/sessions/cc-1/timeline.csv", "/v1/sessions/cc-1/events.csv", "/v1/danger/events.csv", "/v1/rules/stats.csv", "/v1/runs.csv"]) {
      const r = await get(d, p);
      expect(r.status, p).toBe(200);
      expect(r.headers.get("content-type"), p).toContain("text/csv");
      const text = await r.text();
      expect(text.split("\r\n").length, p).toBeGreaterThan(2);
    }
    const ev = await (await get(d, "/v1/sessions/cc-1/events.csv")).text();
    expect(ev).toContain("'=cmd");
    expect(ev).not.toMatch(/(^|,)=cmd/m);
    expect((await get(d, "/v1/sessions/nope/timeline.csv")).status).toBe(404);
  });
});

describe("/v1/schema", () => {
  test("每个名字都能取到、自带 $defs 与版本；未知名字 404；真实响应按 schema 校验", async () => {
    const d = await boot();
    await seed(d);
    for (const n of SCHEMA_NAMES) {
      const s = await json(d, `/v1/schema/${n}`);
      expect(s.$id).toBe(`sv/v1/${n}`);
      expect(s.$defs[n]).toBeTruthy();
    }
    expect((await get(d, "/v1/schema/Nope")).status).toBe(404);
    const sessions = await json(d, "/v1/sessions");
    for (const s of sessions.sessions) expect(validate(schemaFor("SessionSummary")!, s), JSON.stringify(s)).toEqual([]);
    for (const e of (await json(d, "/v1/danger/events")).events) expect(validate(schemaFor("DangerEvent")!, e)).toEqual([]);
    expect(validate(schemaFor("DangerStats")!, await json(d, "/v1/danger/stats"))).toEqual([]);
    for (const r of (await json(d, "/v1/rules/stats")).rows) expect(validate(schemaFor("RuleStat")!, r), JSON.stringify(r)).toEqual([]);
    for (const r of (await json(d, "/v1/runs")).runs) expect(validate(schemaFor("Run")!, r), JSON.stringify(r)).toEqual([]);
    expect(validate(schemaFor("Status")!, await json(d, "/v1/status"))).toEqual([]);
  });
  test("校验器自检：缺字段 / 错类型 / 错 enum 会被发现", () => {
    const tl = schemaFor("TimelineEvent")!;
    expect(validate(tl, { type: "event", seq: 1, ts: 1, phase: "pre", origin: null, model: null })).toEqual([]);
    expect(validate(tl, { type: "event", seq: "1", ts: 1, phase: "pre", origin: null, model: null }).length).toBe(1);
    expect(validate(tl, { type: "call", seq: 1, ts: 1, phase: "pre", origin: null, model: null }).length).toBe(1);
    expect(validate(tl, { type: "event" }).length).toBeGreaterThan(1);
  });
});
