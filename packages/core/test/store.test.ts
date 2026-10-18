import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogStore, StoreSink, beginRun, compareRuns, createJudgeClient, defaultConfig, explainHit, judgeStats, modelRuleStats, ruleStats, resolveRuns, sessionStats, suppressCodeOf, totals, applyOverride, type JudgeTransport } from "../src/index.ts";
import { PYTEST_FAIL, PYTEST_PASS, Sim, cfgWith } from "./sim.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "sv-store-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function mkSim(opts: ConstructorParameters<typeof Sim>[0] = {}, storeOpts: ConstructorParameters<typeof LogStore>[1] = {}) {
  const store = new LogStore(":memory:", storeOpts);
  const cfg = opts.cfg ?? defaultConfig();
  const runId = beginRun(store, cfg, { kind: "replay", label: "t", judgeMode: opts.judge ? "mock" : "off" });
  const sink = new StoreSink(store, { runId, channelPrefix: "replay" });
  const sim = new Sim({ ...opts, cfg, sink });
  return { store, runId, sink, sim };
}

describe("schema", () => {
  test("建表、版本号、WAL（文件库）；重复打开不报错", () => {
    const d = tmp();
    const s = new LogStore(join(d, "state.db"));
    expect(s.schemaVersion).toBe(1);
    expect((s.db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
    const tables = (s.db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
    for (const t of ["runs", "sessions", "events", "hits", "judge_calls", "decisions", "deliveries", "overrides", "adapter_health", "schema_meta"]) expect(tables).toContain(t);
    s.close();
    const s2 = new LogStore(join(d, "state.db"));
    expect(s2.schemaVersion).toBe(1);
    s2.close();
  });
  test("日志库版本比程序新 → 拒绝打开", () => {
    const d = tmp();
    const s = new LogStore(join(d, "x.db"));
    s.db.run("UPDATE schema_meta SET value='99' WHERE key='schema_version'");
    s.close();
    expect(() => new LogStore(join(d, "x.db"))).toThrow(/比当前程序/);
  });
});

describe("写入：事件、命中（含阈值与证据）、决策、投递", () => {
  test("一次 L1 失败循环产生完整链路", async () => {
    const { store, runId, sim } = mkSim({ trustInferred: true });
    await sim.start();
    await sim.prompt("fix it");
    for (let i = 0; i < 3; i++) await sim.bash("pytest tests/a.py", { fail: true, out: PYTEST_FAIL(i) });
    sim.engine.close();
    expect(store.count("events")).toBeGreaterThanOrEqual(8);
    const hits = store.db.query("SELECT * FROM hits WHERE rule_id='L1' ORDER BY id").all() as Record<string, unknown>[];
    expect(hits.length).toBeGreaterThanOrEqual(2);
    const m = hits.find((h) => h.sev === "M")!;
    expect(JSON.parse(m.threshold_json as string)).toMatchObject({ advise_after_failures: 2 });
    expect(JSON.parse(m.observed_json as string)).toMatchObject({ count: 2 });
    expect(JSON.parse(m.evidence_json as string)).toHaveLength(2);
    expect(m.key).toContain("L1:");
    expect(m.observe_only).toBe(0);
    expect(m.call_index).toBeGreaterThanOrEqual(2);
    const h = hits.find((x) => x.sev === "H")!;
    expect(h.phase).toBe("pre");
    expect(h.blockable).toBe(1);
    const dec = store.db.query("SELECT * FROM decisions WHERE hit_id=?").all(h.id as number) as Record<string, unknown>[];
    expect(dec).toHaveLength(1);
    expect(dec[0]).toMatchObject({ action: "block", applied: 0, mode: "shadow" });
    // 抑制/降级原因是结构化的
    expect(store.db.query("SELECT COUNT(*) AS n FROM decisions WHERE suppressed_by IS NOT NULL").get()).toBeTruthy();
    // 投递：shadow 下没有送达
    const del = store.db.query("SELECT * FROM deliveries WHERE decision_id=?").get(dec[0].id as number) as Record<string, unknown>;
    expect(del).toMatchObject({ channel: "replay:PreToolUse", delivered: 0, expired_reason: "not_applied_in_mode_shadow" });
    expect(runId).toBe(1);
    expect(store.db.query("SELECT calls FROM sessions").get()).toEqual({ calls: 3 });
  });
  test("模型名只记录：events / hits / sessions 里都有 model", async () => {
    const { store, sim } = mkSim({ model: "kimi-k2" });
    await sim.start();
    await sim.prompt("x");
    for (let i = 0; i < 2; i++) await sim.bash("pytest -q", { out: PYTEST_PASS });
    expect(store.db.query("SELECT DISTINCT model FROM events WHERE model IS NOT NULL").all()).toEqual([{ model: "kimi-k2" }]);
    expect((store.db.query("SELECT model FROM hits LIMIT 1").get() as { model: string }).model).toBe("kimi-k2");
    expect((store.db.query("SELECT model FROM sessions").get() as { model: string }).model).toBe("kimi-k2");
  });
  test("run 记录当时生效的阈值、哈希和命令行覆盖；阈值不同哈希不同", () => {
    const store = new LogStore(":memory:");
    const base = defaultConfig();
    const a = beginRun(store, base, { kind: "replay", label: "a" });
    const b = beginRun(store, applyOverride(base, "thresholds.T1.H=4"), { kind: "replay", label: "b", overrides: ["thresholds.T1.H=4"] });
    const c = beginRun(store, base, { kind: "replay", label: "c" });
    const row = (id: number) => store.db.query("SELECT * FROM runs WHERE id=?").get(id) as Record<string, string>;
    expect(row(a).thresholds_hash).not.toBe(row(b).thresholds_hash);
    expect(row(a).thresholds_hash).toBe(row(c).thresholds_hash);
    expect(JSON.parse(row(b).thresholds_json).thresholds.T1.H).toBe(4);
    expect(JSON.parse(row(b).overrides_json)).toEqual(["thresholds.T1.H=4"]);
    expect(resolveRuns(store.db, { label: "b" })).toEqual([b]);
  });
  test("敏感内容落盘前脱敏：命令、输出、消息、judge 请求响应都找不到密钥", async () => {
    const SECRET = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const transport: JudgeTransport = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ verdict: "advise", confidence: 0.8, category: "loop", message_to_agent: `不要再用 ${SECRET} 重试同一个调用了，先读报错。`, reason: SECRET, evidence_steps: [], watch: [], done: false }) } }], usage: { prompt_tokens: 1200, completion_tokens: 80 } }) });
    const client = createJudgeClient({ cfg: defaultConfig().judge, transport, env: {} });
    const { store, sim } = mkSim({ judge: client.judge, cfg: cfgWith({ mode: "enforce" }) });
    await sim.start();
    await sim.prompt(`use ${SECRET}`);
    for (let i = 0; i < 4; i++) await sim.bash(`curl -H "Authorization: Bearer abcdef0123456789tokenvalue" https://x.test ${SECRET}`, { out: `denied ${SECRET}` });
    sim.engine.close();
    const dump = JSON.stringify([...["events", "hits", "decisions", "judge_calls", "deliveries"].map((t) => store.db.query(`SELECT * FROM ${t}`).all())]);
    expect(dump).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(dump).not.toContain("abcdef0123456789tokenvalue");
    expect(dump).toContain("REDACTED");
  });
  test("store_event_bodies / store_judge_bodies = false：只留指纹与统计字段", async () => {
    const { store, sim } = mkSim({}, { storeEventBodies: false, storeJudgeBodies: false });
    await sim.start();
    await sim.prompt("x");
    await sim.bash("pytest -q", { out: PYTEST_PASS });
    expect(store.db.query("SELECT COUNT(*) AS n FROM events WHERE body_json IS NOT NULL").get()).toEqual({ n: 0 });
    expect((store.db.query("SELECT args_hash FROM events WHERE tool_name IS NOT NULL LIMIT 1").get() as { args_hash: string }).args_hash).toBeTruthy();
  });
  test("日志写入失败不影响监督（fail-open）", async () => {
    const { store, sim } = mkSim();
    store.close(); // 故意关掉库，之后每次写入都会抛
    const orig = console.error;
    console.error = () => {};
    try {
      await sim.start();
      await sim.prompt("x");
      const [pre] = await sim.bash("git reset --hard");
      expect(pre.hits.some((h) => h.ruleId === "X2")).toBe(true);
    } finally {
      console.error = orig;
    }
  });
});

describe("judge 调用日志", () => {
  const good = { verdict: "advise", confidence: 0.82, category: "loop", message_to_agent: "同一错误已重复三次，建议先阅读报错再改。", reason: "r", evidence_steps: [3], watch: [], done: false };
  test("记录模型、延迟、token、重试、response_format 降级、修复、请求/响应（脱敏）", async () => {
    let n = 0;
    const transport: JudgeTransport = async (_u, init) => {
      n++;
      const body = JSON.parse(init.body);
      if (body.response_format?.type === "json_schema") return { ok: false, status: 400, text: async () => '{"error":"response_format json_schema is not supported"}' };
      await new Promise((r) => setTimeout(r, 15));
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "<think>x</think>" + JSON.stringify(good) } }], usage: { prompt_tokens: 900, completion_tokens: 60, prompt_tokens_details: { cached_tokens: 300 } } }) };
    };
    const client = createJudgeClient({ cfg: { ...defaultConfig().judge, model: "route-a" }, transport, env: {} });
    const { store, sim } = mkSim({ judge: client.judge, cfg: cfgWith({ mode: "enforce" }) });
    await sim.start();
    await sim.prompt("x");
    for (let i = 0; i < 4; i++) await sim.bash("cat x.log", { out: "same" });
    const j = store.db.query("SELECT * FROM judge_calls").get() as Record<string, any>;
    expect(n).toBe(2);
    expect(j).toMatchObject({ model: "route-a", route_model: "route-a", status: "ok", verdict: "advise", prompt_tokens: 900, completion_tokens: 60, cached_tokens: 300, format_level: "json_object", format_downgraded: 1, http_requests: 2, sync: 0 });
    expect(j.latency_ms).toBeGreaterThanOrEqual(10);
    expect(JSON.parse(j.repairs_json)).toContain("strip-think");
    expect(j.request_json).toContain("Recent steps");
    expect(j.response_json).toContain("choices");
    // 决策指回 judge 调用
    const d = store.db.query("SELECT * FROM decisions WHERE judge_call_id IS NOT NULL").get() as Record<string, any>;
    expect(d.judge_call_id).toBe(j.id);
    expect(d.action).toBe("advise");
    expect(d.applied).toBe(1);
  });
  test("超时 / 解析失败 / 出错也各记一行", async () => {
    for (const [mk, status] of [
      [() => new Promise<never>(() => {}), "timeout"],
      [async () => ({ ok: true, status: 200, text: async () => "no json here" }), "parse_fail"],
      [async () => { throw new Error("ECONNREFUSED"); }, "error"],
    ] as const) {
      const client = createJudgeClient({ cfg: defaultConfig().judge, transport: mk as unknown as JudgeTransport, env: {}, timeoutMs: { sync: 20, async: 20 } });
      const { store, sim } = mkSim({ judge: client.judge });
      await sim.start();
      await sim.prompt("x");
      for (let i = 0; i < 4; i++) await sim.bash("cat x.log", { out: "same" });
      expect((store.db.query("SELECT status FROM judge_calls").get() as { status: string }).status).toBe(status);
    }
  });
});

describe("投递与遵从", () => {
  test("enforce：建议送达；之后又重复同一调用 → complied=0；换了做法 → complied=1", async () => {
    const mkRun = async (repeat: boolean) => {
      const { store, sim } = mkSim({ cfg: cfgWith({ mode: "enforce" }) });
      await sim.start();
      await sim.prompt("fix");
      await sim.bash("pytest -q", { out: PYTEST_PASS });
      await sim.bash("pytest -q", { out: PYTEST_PASS }); // T1 advise 在这次 pre 上
      if (repeat) await sim.bash("pytest -q", { out: PYTEST_PASS });
      else for (const c of ["ls", "cat a.py", "rg foo"]) await sim.bash(c, { out: c });
      for (let i = 0; i < 3; i++) await sim.bash(`echo ${i}`, { out: String(i) });
      sim.engine.close();
      return store.db.query("SELECT * FROM deliveries WHERE rule_id='T1' ORDER BY id").get() as Record<string, any>;
    };
    const bad = await mkRun(true);
    expect(bad).toMatchObject({ delivered: 1, channel: "replay:PreToolUse", complied: 0 });
    const good = await mkRun(false);
    expect(good).toMatchObject({ delivered: 1, complied: 1 });
  });
  test("观察窗口没走完 → complied 为 NULL 并写明原因", async () => {
    const { store, sim } = mkSim({ cfg: cfgWith({ mode: "enforce" }) });
    await sim.start();
    await sim.prompt("fix");
    await sim.bash("pytest -q", { out: PYTEST_PASS });
    await sim.bash("pytest -q", { out: PYTEST_PASS });
    sim.engine.close();
    const d = store.db.query("SELECT * FROM deliveries WHERE rule_id='T1'").get() as Record<string, any>;
    expect(d.complied).toBeNull();
    expect(d.compliance_note).toContain("窗口未走完");
  });
});

describe("用户覆盖", () => {
  test("#sv off / #sv quiet 被记录为 override；手动放行/驳回、标误报", async () => {
    const { store, runId, sim } = mkSim();
    await sim.start();
    await sim.prompt("fix it #sv quiet");
    await sim.prompt("now #sv off");
    expect(store.db.query("SELECT kind, target_type FROM overrides ORDER BY id").all()).toEqual([
      { kind: "sv_quiet", target_type: "session" },
      { kind: "sv_off", target_type: "session" },
    ]);
    const hitId = store.insertHit(runId, { sessionId: "s", seq: 1, ts: 1, ruleId: "L1", sev: "M" });
    const decId = store.insertDecision(runId, { sessionId: "s", hitId, ts: 1, ruleId: "L1", action: "advise", applied: false });
    store.mark(hitId, "false_positive", "这是正常的重试");
    store.insertOverride({ runId, sessionId: "s", kind: "manual_reject", targetType: "decision", targetId: decId, note: "不该提醒" });
    expect(store.db.query("SELECT kind FROM overrides WHERE target_type='hit'").all()).toEqual([{ kind: "mark_false_positive" }]);
    expect(() => store.mark(9999, "useful")).toThrow(/没有 id=9999/);
  });
});

describe("查询：命中率 / 误报率 / 按模型 / 对比", () => {
  async function twoModelStore() {
    const store = new LogStore(":memory:");
    const cfg = defaultConfig();
    const runId = beginRun(store, cfg, { kind: "replay", label: "x" });
    for (const [model, n] of [["model-a", 4], ["model-b", 2]] as const) {
      const sink = new StoreSink(store, { runId });
      const sim = new Sim({ model, cfg, sink });
      sim.engine.tracker.cwd = "/work/proj";
      await sim.start();
      await sim.prompt("x");
      for (let i = 0; i < n; i++) await sim.bash("cat build.log", { out: "same" });
      for (let i = 0; i < 2; i++) await sim.bash("pytest -q", { out: PYTEST_PASS });
      sink.close();
    }
    return { store, runId };
  }
  test("ruleStats：命中数、会话数、每 100 调用命中、处置计数；人工标注 → 误报率", async () => {
    const { store } = await twoModelStore();
    const rs = ruleStats(store.db, {});
    const l2 = rs.find((r) => r.rule === "L2")!;
    expect(l2.hits).toBe(1); // 只有 model-a 重复了 4 次
    expect(l2.sessions).toBe(1);
    expect(l2.hitsPer100Calls).toBeCloseTo((1 / totals(store.db, {}).calls) * 100, 1);
    const t1 = rs.find((r) => r.rule === "T1")!;
    expect(t1.hits).toBe(2);
    expect(t1.actions.advise).toBe(2);
    expect(t1.fpRate).toBeNull(); // 还没有标注
    const ids = (store.db.query("SELECT id FROM hits WHERE rule_id='T1' ORDER BY id").all() as { id: number }[]).map((r) => r.id);
    store.mark(ids[0], "false_positive");
    store.mark(ids[1], "useful");
    store.mark(ids[1], "false_positive"); // 最新一条为准
    const t1b = ruleStats(store.db, {}).find((r) => r.rule === "T1")!;
    expect(t1b).toMatchObject({ labeledFp: 2, labeledUseful: 0, fpRate: 1 });
  });
  test("modelRuleStats：模型只用来事后统计", async () => {
    const { store } = await twoModelStore();
    const rows = modelRuleStats(store.db, {});
    const a = rows.find((r) => r.model === "model-a" && r.rule === "L2")!;
    expect(a.hits).toBe(1);
    expect(rows.find((r) => r.model === "model-b" && r.rule === "L2")).toBeUndefined();
    expect(rows.find((r) => r.model === "model-b" && r.rule === "T1")?.calls).toBe(2 + 0 + 2 - 0 - 0 || 4);
  });
  test("Scope：按 run、事件时间、会话过滤", async () => {
    const { store, runId } = await twoModelStore();
    expect(ruleStats(store.db, { runIds: [999] })).toEqual([]);
    expect(ruleStats(store.db, { runIds: [runId] }).length).toBeGreaterThan(0);
    expect(ruleStats(store.db, { since: Date.now() + 1e12 })).toEqual([]);
    expect(sessionStats(store.db, {}).length).toBe(1); // 同一个 sessionId 下两个 Sim 共用
  });
  test("compareRuns：同一批会话在两套阈值下的差异", async () => {
    const store = new LogStore(":memory:");
    const run = async (cfg = defaultConfig(), label = "r") => {
      const runId = beginRun(store, cfg, { kind: "replay", label });
      const sink = new StoreSink(store, { runId });
      const sim = new Sim({ cfg, sink, trustInferred: true });
      await sim.start();
      await sim.prompt("x");
      for (let i = 0; i < 5; i++) await sim.bash("pytest -q", { out: PYTEST_PASS });
      sink.close();
      return runId;
    };
    const a = await run(defaultConfig(), "base");
    const b = await run(applyOverride(defaultConfig(), "thresholds.T1.H=5"), "t1h5");
    const t1 = compareRuns(store.db, a, b).find((r) => r.rule === "T1")!;
    expect(t1.hitsA).toBeGreaterThan(0);
    expect(t1.blocksA).toBeGreaterThan(t1.blocksB); // H 阈值从 3 调到 5：被拦的次数变少
  });
  test("judgeStats：按模型的 ignore 率 / parse_fail 率 / 延迟分位 / token", () => {
    const store = new LogStore(":memory:");
    const run = store.startRun({ kind: "live" });
    const add = (model: string, status: string, verdict: string | undefined, latency: number, pt: number) => store.insertJudgeCall(run, { sessionId: "s", ts: 1, ruleIds: ["L1"], sync: false, model, status, verdict, latencyMs: latency, promptTokens: pt, completionTokens: 10, formatDowngraded: false });
    add("m1", "ok", "ignore", 100, 1000);
    add("m1", "ok", "advise", 300, 1000);
    add("m1", "parse_fail", undefined, 200, 1000);
    add("m1", "timeout", undefined, 400, 0);
    add("m2", "ok", "ignore", 50, 500);
    const s = judgeStats(store.db, {});
    const m1 = s.find((x) => x.model === "m1")!;
    expect(m1).toMatchObject({ calls: 4, ok: 2, ignores: 1, advises: 1, parseFail: 1, timeouts: 1, ignoreRate: 0.25, parseFailRate: 0.25, promptTokens: 3000 });
    expect(m1.latencyP50).toBe(200);
    expect(m1.latencyP95).toBe(400);
    expect(s.find((x) => x.model === "m2")?.ignoreRate).toBe(1);
  });
  test("explainHit：命中 → 证据事件 → 决策 → judge → 投递 → 标注", async () => {
    const { store, sim } = mkSim({ cfg: cfgWith({ mode: "enforce" }) });
    await sim.start();
    await sim.prompt("fix");
    for (let i = 0; i < 2; i++) await sim.bash("pytest tests/a.py", { fail: true, out: PYTEST_FAIL(i) });
    const hit = store.db.query("SELECT id FROM hits WHERE rule_id='L1' AND sev='M'").get() as { id: number };
    store.mark(hit.id, "useful", "确实在空转");
    const x = explainHit(store.db, hit.id)!;
    expect(x.hit.rule_id).toBe("L1");
    expect(x.events.length).toBeGreaterThan(0);
    expect(x.decisions.length).toBe(1);
    expect(x.labels).toHaveLength(1);
    expect(explainHit(store.db, 12345)).toBeNull();
  });
});

describe("保留期与导出", () => {
  test("prune 按 logged_ts 清理；被人工标注过的命中及其决策不清理", () => {
    let now = 1_000_000_000_000;
    const store = new LogStore(":memory:", { now: () => now });
    const run = store.startRun({ kind: "live" });
    const h1 = store.insertHit(run, { sessionId: "s", seq: 1, ts: 1, ruleId: "L1", sev: "M" });
    const h2 = store.insertHit(run, { sessionId: "s", seq: 2, ts: 2, ruleId: "L1", sev: "M" });
    store.insertDecision(run, { sessionId: "s", hitId: h1, ts: 1, ruleId: "L1", action: "advise", applied: true });
    store.insertDecision(run, { sessionId: "s", hitId: h2, ts: 2, ruleId: "L1", action: "advise", applied: true });
    store.insertOverride({ sessionId: "s", kind: "sv_quiet", targetType: "session" });
    store.mark(h2, "useful");
    now += 20 * 86_400_000;
    const fresh = store.insertHit(run, { sessionId: "s", seq: 3, ts: 3, ruleId: "L2", sev: "M" });
    const r = store.prune(14, now);
    expect(r.hits).toBe(1); // h1 被清，h2（有标注）和 fresh 保留
    expect((store.db.query("SELECT id FROM hits ORDER BY id").all() as { id: number }[]).map((x) => x.id)).toEqual([h2, fresh]);
    expect(store.count("decisions")).toBe(1);
    expect(store.db.query("SELECT kind FROM overrides ORDER BY id").all()).toEqual([{ kind: "mark_useful" }]);
    expect(store.prune(0, now)).toEqual({}); // 0 = 不清理
  });
  test("jsonl_dir：写入时同步镜像；exportJsonl 导出所有表", async () => {
    const d = tmp();
    const { store, sim } = mkSim({}, { jsonlDir: join(d, "mirror") });
    await sim.start();
    await sim.prompt("x");
    for (let i = 0; i < 2; i++) await sim.bash("pytest -q", { out: PYTEST_PASS });
    const files = readdirSync(join(d, "mirror"));
    expect(files.some((f) => f.startsWith("events-"))).toBe(true);
    expect(files.some((f) => f.startsWith("hits-"))).toBe(true);
    const line = readFileSync(join(d, "mirror", files.find((f) => f.startsWith("hits-"))!), "utf8").trim().split("\n")[0];
    expect(JSON.parse(line)).toHaveProperty("rule_id");
    const counts = store.exportJsonl(join(d, "export"));
    expect(counts.events).toBe(store.count("events"));
    expect(existsSync(join(d, "export", "hits.jsonl"))).toBe(true);
    expect(readFileSync(join(d, "export", "events.jsonl"), "utf8").trim().split("\n")).toHaveLength(counts.events);
  });
});

describe("suppressCodeOf：每个抑制原因都有结构化代码", () => {
  test("映射", () => {
    const cases: [string, string][] = [
      ["user #sv off", "user_off"],
      ["user #sv quiet", "user_quiet"],
      ["同规则同指纹冷却中", "cooldown"],
      ["同 category 10 步内不重复", "category_dedupe"],
      ["L 级本地建议每条规则每会话最多 1 次", "l_once"],
      ["连续拦截已达上限（2），降级为 advise", "consecutive_cap"],
      ["工作区指纹未核实（非 git/超时/无指纹），只给建议", "unverified_ws"],
      ["5 秒内同类命中合并到上一次 judge 调用", "judge_merged"],
      ["本会话 judge 调用次数已用完", "judge_budget"],
      ["两次 judge 之间冷却中", "judge_cooldown"],
      ["judge done=true，暂停 R4/P4 抽查", "paused"],
      ["judge timeout，fail-open 放行", "fail_open"],
      ["P3：Stop 续跑次数已用完，降级为 advise", "stop_budget"],
      ["judge 判 block，但置信度不足或受上限约束，降级为 advise", "block_downgraded"],
    ];
    for (const [reason, code] of cases) expect(suppressCodeOf(reason)).toBe(code as never);
    expect(suppressCodeOf("judge 判 advise")).toBeUndefined();
  });
});
