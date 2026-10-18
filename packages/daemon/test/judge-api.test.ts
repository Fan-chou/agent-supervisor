// /v1/judge-calls 列表 / 详情 / CSV：对着 daemon 日志库里的 judge 调用查询（直接用 store.insertJudgeCall 造数据，不发网络请求）。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, resolveConfig } from "@sv/core";
import { Daemon, startDaemon } from "../src/index.ts";
import { schemaFor } from "../src/schemas.ts";
import { validate } from "./helpers/validate.ts";

const dirs: string[] = [];
const daemons: Daemon[] = [];
afterEach(async () => {
  while (daemons.length) await daemons.pop()!.stop();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
async function boot(over: Record<string, unknown> = {}) {
  const home = mkdtempSync(join(tmpdir(), "sv-jc-"));
  dirs.push(home);
  const d = await startDaemon({ cfg: resolveConfig(over, defaultConfig()), home, dbPath: join(home, "state.db"), socketPath: join(home, "sock") });
  daemons.push(d);
  return d;
}
const get = (d: Daemon, path: string) => fetch(`http://localhost${path}`, { unix: d.socketPath! });
const json = async (d: Daemon, path: string) => (await get(d, path)).json() as Promise<any>;
const post = (d: Daemon, harness: string, payload: unknown) => fetch("http://localhost/v1/hook", { unix: d.socketPath!, method: "POST", body: JSON.stringify({ harness, payload }) });

async function seed(d: Daemon) {
  // 两个会话（claude / codex），各有一次事件，这样 sessions 表里有 harness
  await post(d, "claude", { session_id: "cc-1", cwd: "/tmp", hook_event_name: "UserPromptSubmit", prompt: "x" });
  await post(d, "codex", { session_id: "cx-1", cwd: "/tmp", hook_event_name: "UserPromptSubmit", prompt: "x" });
  const run = d.runId;
  const base = { sync: false, status: "ok" };
  const ids = [
    d.store.insertJudgeCall(run, { ...base, sessionId: "cc-1", ts: 1000, ruleIds: ["L1", "L3"], routeModel: "route-a", model: "m-a", verdict: "advise", confidence: 0.8, category: "loop", reason: "同一错误重复", latencyMs: 900, promptTokens: 1000, completionTokens: 50, cachedTokens: 400, costUsd: 0.01, request: JSON.stringify({ messages: [{ role: "user", content: "key=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA 请判断" }] }), response: JSON.stringify({ verdict: "advise" }), repairs: ["strip_fence"] }),
    d.store.insertJudgeCall(run, { ...base, sessionId: "cc-1", ts: 2000, ruleIds: ["T1"], sync: true, routeModel: "route-a", model: "m-a", verdict: "ignore", status: "ok", latencyMs: 1500, promptTokens: 500, completionTokens: 20, cachedTokens: 0 }),
    d.store.insertJudgeCall(run, { ...base, sessionId: "cx-1", ts: 3000, ruleIds: ["L1"], routeModel: "route-b", model: "m-b", status: "parse_fail", error: "无法解析", latencyMs: 3000 }),
    d.store.insertJudgeCall(run, { ...base, sessionId: "cx-1", ts: 4000, ruleIds: ["L10"], model: "m-b", status: "timeout", error: "timeout" }),
  ];
  return ids;
}

describe("/v1/judge-calls", () => {
  test("列表：最新在前，不含正文；带 harness；totals 与筛选一致；符合 schema", async () => {
    const d = await boot();
    await seed(d);
    const r = await json(d, "/v1/judge-calls");
    expect(validate(schemaFor("JudgeCallList")!, r), JSON.stringify(validate(schemaFor("JudgeCallList")!, r))).toEqual([]);
    expect(r.calls.map((c: any) => c.ts)).toEqual([4000, 3000, 2000, 1000]);
    expect(r.calls.find((c: any) => c.ts === 1000)).toMatchObject({ harness: "claude", ruleIds: ["L1", "L3"], model: "m-a", routeModel: "route-a", verdict: "advise" });
    expect(r.calls.find((c: any) => c.ts === 3000).harness).toBe("codex");
    expect(JSON.stringify(r)).not.toContain("sk-ant");
    expect(r.calls[0]).not.toHaveProperty("request");
    expect(r.totals).toMatchObject({ calls: 4, ok: 2, failed: 2, parseFail: 1, promptTokens: 1500, cachedTokens: 400, completionTokens: 70 });
    expect(r.totals.costUsd).toBe(0.01);
    expect(r.nextCursor).toBeNull();
  });
  test("过滤：harness / model / route_model / rule（精确匹配 L1，不匹配 L10）/ verdict / status / sync / q / session；totals 随筛选变化", async () => {
    const d = await boot();
    await seed(d);
    const ts = async (qs: string) => (await json(d, `/v1/judge-calls?${qs}`)).calls.map((c: any) => c.ts);
    expect(await ts("harness=codex")).toEqual([4000, 3000]);
    expect(await ts("model=m-a")).toEqual([2000, 1000]);
    expect(await ts("route_model=route-b")).toEqual([3000]);
    expect(await ts("rule=L1")).toEqual([3000, 1000]);
    expect(await ts("rule=L10")).toEqual([4000]);
    expect(await ts("verdict=ignore")).toEqual([2000]);
    expect(await ts("status=parse_fail")).toEqual([3000]);
    expect(await ts("sync=true")).toEqual([2000]);
    expect(await ts("q=重复")).toEqual([1000]);
    expect(await ts("q=%25")).toEqual([]); // % 按字面匹配
    expect(await ts("session=cx-1")).toEqual([4000, 3000]);
    const t = (await json(d, "/v1/judge-calls?harness=claude")).totals;
    expect(t).toMatchObject({ calls: 2, ok: 2, failed: 0 });
    expect((await json(d, "/v1/judge-calls?cache=exclude")).totals.promptTokens).toBe(1100); // 1500 - 400
    expect((await json(d, "/v1/judge-calls?cache=include")).totals.promptTokens).toBe(1500);
  });
  test("游标分页：limit + nextCursor；totals 不受 limit 影响", async () => {
    const d = await boot();
    await seed(d);
    const p1 = await json(d, "/v1/judge-calls?limit=3");
    expect(p1.calls.length).toBe(3);
    expect(p1.totals.calls).toBe(4);
    const p2 = await json(d, `/v1/judge-calls?limit=3&cursor=${p1.nextCursor}`);
    expect(p2.calls.length).toBe(1);
    expect(p2.nextCursor).toBeNull();
  });
  test("详情：请求 / 响应（脱敏）、修复记录、关联的命中 / 决策 / 投递；符合 schema；404 / 400", async () => {
    const d = await boot();
    const [first] = await seed(d);
    const hitId = d.store.insertHit(d.runId, { sessionId: "cc-1", seq: 1, ts: 1000, ruleId: "L1", sev: "M" });
    const decId = d.store.insertDecision(d.runId, { sessionId: "cc-1", hitId, judgeCallId: first, ts: 1000, ruleId: "L1", action: "advise", applied: false, mode: "shadow", outcome: "would_have_advised", message: "m" });
    const det = await json(d, `/v1/judge-calls/${first}`);
    expect(validate(schemaFor("JudgeCallDetail")!, det)).toEqual([]);
    expect(det).toMatchObject({ id: first, bodiesStored: true, repairs: ["strip_fence"], harness: "claude", reason: "同一错误重复" });
    expect(JSON.stringify(det.request)).not.toContain("sk-ant-api03");
    expect(det.request.messages[0].role).toBe("user");
    expect(det.response).toEqual({ verdict: "advise" });
    expect(det.hits.map((h: any) => h.id)).toEqual([hitId]);
    expect(det.decisions).toEqual([{ id: decId, hitId, action: "advise", applied: false, mode: "shadow", outcome: "would_have_advised", message: "m" }]);
    expect(det.deliveries).toEqual([]);
    expect((await get(d, "/v1/judge-calls/99999")).status).toBe(404);
    expect((await get(d, "/v1/judge-calls/abc")).status).toBe(404); // 非数字路径不是详情
    expect((await get(d, "/v1/judge-calls?sync=maybe")).status).toBe(400);
    expect((await get(d, "/v1/judge-calls?cache=what")).status).toBe(400);
    expect((await get(d, "/v1/judge-calls?limit=x")).status).toBe(400);
  });
  test("没有保存正文（store_judge_bodies=false）：bodiesStored=false，request/response 为 null，统计字段仍在", async () => {
    const d = await boot({ log: { store_judge_bodies: false } });
    const [first] = await seed(d);
    const det = await json(d, `/v1/judge-calls/${first}`);
    expect(det).toMatchObject({ bodiesStored: false, request: null, response: null, promptTokens: 1000 });
  });
  test("CSV：表头 + 行；stats 仍可用；空库返回空列表和 0 合计", async () => {
    const d = await boot();
    const empty = await json(d, "/v1/judge-calls");
    expect(empty.calls).toEqual([]);
    expect(empty.totals).toMatchObject({ calls: 0, costUsd: null, latencyP50: null });
    await seed(d);
    const r = await get(d, "/v1/judge-calls/export.csv?rule=L1");
    expect(r.headers.get("content-type")).toContain("text/csv");
    const lines = (await r.text()).trim().split("\r\n");
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain("ruleIds");
    expect(lines[2]).toContain("L1 L3");
    expect((await json(d, "/v1/judge-calls/stats")).rows.length).toBe(2);
  });
});
