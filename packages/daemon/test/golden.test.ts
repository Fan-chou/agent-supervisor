// 黄金样例（frontend-design §9.2）：test/fixtures/api/*.json 是 TS 与 Go 两端共用的 API 响应样例。
// TS 侧的三件事：① 每个样例都符合对应的 JSON Schema；② 每个 Schema 都有样例（或被别的样例整体覆盖）；
// ③ 样例的字段集合与守护进程的真实响应一致（防漂移：加了/删了字段必须同步样例）。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, resolveConfig } from "@sv/core";
import { Daemon, startDaemon } from "../src/index.ts";
import { SCHEMA_NAMES, schemaFor } from "../src/schemas.ts";
import { validate } from "./helpers/validate.ts";

const DIR = join(import.meta.dir, "../../../test/fixtures/api");
interface Fx {
  file: string;
  schema: string;
  values: any[];
}
const fixtures: Fx[] = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => {
    const j = JSON.parse(readFileSync(join(DIR, f), "utf8"));
    return { file: f, schema: j.schema as string, values: j.values ?? [j.value] };
  });

describe("黄金样例：符合 Schema", () => {
  for (const fx of fixtures) {
    test(`${fx.file} → ${fx.schema}`, () => {
      const s = schemaFor(fx.schema);
      expect(s, `未知 schema ${fx.schema}`).toBeTruthy();
      for (const v of fx.values) expect(validate(s!, v), JSON.stringify(v)).toEqual([]);
    });
  }
  test("每个对外 Schema 都有样例（子定义由包含它们的样例整体覆盖）", () => {
    const covered = new Set(fixtures.map((f) => f.schema));
    const inline = new Set(["Decision", "TimelineEntry", "JudgeCall", "Rule", "JudgeRouteRow"]); // 分别在 Timeline / JudgeCallList / RuleList 里
    for (const n of SCHEMA_NAMES) expect(covered.has(n) || inline.has(n), n).toBe(true);
  });
  test("StreamMessage 样例覆盖全部 8 种 type；streamId 格式 <epoch>.<n>", () => {
    const f = fixtures.find((x) => x.schema === "StreamMessage")!;
    expect(new Set(f.values.map((v) => v.type))).toEqual(new Set(["session", "event", "hit", "decision", "delivery", "status", "heartbeat", "reset"]));
    for (const v of f.values) expect(v.streamId).toMatch(/^[0-9a-z]+\.\d+$/);
  });
  test("样例里没有密钥形态的内容", () => {
    for (const f of fixtures) expect(JSON.stringify(f.values)).not.toMatch(/sk-[A-Za-z0-9]{10,}|Bearer\s+[A-Za-z0-9]{8,}/);
  });
});

describe("黄金样例：字段集合与真实响应一致（防漂移）", () => {
  const dirs: string[] = [];
  const daemons: Daemon[] = [];
  afterEach(async () => {
    while (daemons.length) await daemons.pop()!.stop();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });
  const keys = (o: object) => Object.keys(o).sort();
  const fx = (schema: string) => fixtures.find((f) => f.schema === schema)!.values[0];

  test("SessionSummary / Hit / DangerEvent / DangerStats / RuleStat / Run / Status / JudgeCall(+Detail) / Timeline 各类条目", async () => {
    const home = mkdtempSync(join(tmpdir(), "sv-gold-"));
    dirs.push(home);
    const d = await startDaemon({ cfg: resolveConfig({}, defaultConfig()), home, dbPath: join(home, "state.db"), socketPath: join(home, "sock") });
    daemons.push(d);
    const post = (payload: unknown) => fetch("http://localhost/v1/hook", { unix: d.socketPath!, method: "POST", body: JSON.stringify({ harness: "claude", payload }) });
    const cc = (extra: Record<string, unknown>) => ({ session_id: "g-1", cwd: "/tmp", model: "m", ...extra });
    await post(cc({ hook_event_name: "UserPromptSubmit", prompt: "go" }));
    for (const [id, cmd] of [["a", "ls"], ["b", "git reset --hard HEAD~1"]] as const) {
      await post(cc({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: cmd }, tool_use_id: id }));
      await post(cc({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: cmd }, tool_response: { stdout: "ok" }, tool_use_id: id }));
    }
    await post(cc({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "sleep 1" }, tool_use_id: "pend" }));
    const jid = d.store.insertJudgeCall(d.runId, { sessionId: "g-1", ts: 1, ruleIds: ["L1"], sync: false, status: "ok", model: "m", request: "{}", response: "{}" });
    const get = async (p: string) => (await fetch(`http://localhost${p}`, { unix: d.socketPath! })).json() as Promise<any>;

    expect(keys((await get("/v1/sessions")).sessions[0])).toEqual(keys(fx("SessionSummary")));
    const hits = (await get("/v1/hits")).hits;
    expect(keys(hits[0])).toEqual(keys(fx("Hit")));
    expect(keys((await get("/v1/danger/events")).events[0])).toEqual(keys(fx("DangerEvent")));
    expect(keys(await get("/v1/danger/stats"))).toEqual(keys(fx("DangerStats")));
    expect(keys((await get("/v1/rules/stats")).rows[0])).toEqual(keys(fx("RuleStat")));
    expect(keys((await get("/v1/runs")).runs[0])).toEqual(keys(fx("Run")).filter((k) => k in (fx("Run") as object)));
    expect(keys(await get(`/v1/runs/${d.runId}`))).toEqual(keys(fx("RunDetail")));
    const st = await get("/v1/status");
    for (const k of keys(fx("Status"))) expect(keys(st), `Status.${k}`).toContain(k);
    const jr = await get("/v1/judge/routes");
    expect(keys(jr)).toEqual(keys(fx("JudgeRoutes")));
    expect(keys(jr.routes[0])).toEqual(keys(fx("JudgeRoutes").routes[0]));
    const jl = await get("/v1/judge-calls");
    expect(keys(jl)).toEqual(keys(fx("JudgeCallList")));
    expect(keys(jl.calls[0])).toEqual(keys(fx("JudgeCallList").calls[0]));
    expect(keys(jl.totals)).toEqual(keys(fx("JudgeCallList").totals));
    const jd = await get(`/v1/judge-calls/${jid}`);
    expect(keys(jd)).toEqual(keys(fx("JudgeCallDetail")));
    const tl = await get("/v1/sessions/g-1/timeline");
    const tfx = fx("Timeline");
    expect(keys(tl)).toEqual(keys(tfx));
    for (const type of ["call", "event", "hit"]) {
      const live = tl.entries.find((e: any) => e.type === type);
      const gold = tfx.entries.find((e: any) => e.type === type);
      expect(keys(live), `timeline ${type}`).toEqual(keys(gold));
    }
    const liveDecision = tl.entries.find((e: any) => e.type === "hit").decisions[0];
    expect(keys(liveDecision)).toEqual(keys(tfx.entries.find((e: any) => e.type === "hit").decisions[0]));
    const rules = await get("/v1/rules");
    expect(keys(rules)).toEqual(keys(fx("RuleList")));
    for (const k of ["id", "title", "category", "level", "thresholds", "override", "disabled"]) expect(keys(rules.rules[0])).toContain(k);
    expect(keys(await get("/v1/config"))).toEqual(keys(fx("ConfigView")));
  });
});
