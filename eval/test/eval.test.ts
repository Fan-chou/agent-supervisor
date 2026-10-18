import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { main } from "../../packages/cli/src/sv.ts";
import type { ReplayResult, TimelineEntry } from "../../packages/replay/src/index.ts";
import { LabelError, loadLabels, parseLabels, type LabelSession } from "../src/labels.ts";
import { classOf, computeReport, dist, type SessionInput } from "../src/metrics.ts";
import { defaultMockFactory, renderEvalText, renderSweepText, runEval, runPromptAb, runSweep } from "../src/run.ts";

const ROOT = join(import.meta.dir, "../..");
const LABELS = join(ROOT, "test/fixtures/labels.yaml");

function entry(over: Partial<TimelineEntry> & { ruleId: string; callIndex: number }): TimelineEntry {
  return { seq: over.callIndex * 2, ts: 0, relMs: 0, step: over.callIndex, sev: "M", category: "loop", phase: "post", action: "advise", applied: false, reason: "", evidence: [], ...over };
}
function result(timeline: TimelineEntry[], steps = 20, judge: ReplayResult["summary"]["judge"] = { calls: 0, byModel: {} }): ReplayResult {
  return { sessionId: "s", harness: "claude", judgeMode: "off", events: 0, steps, durationMs: 0, plan: null, timeline, summary: { hits: timeline.length, byRule: {}, judgeCalls: judge.calls, firstHitMs: {}, judge }, warnings: [] };
}
const L = (o: Partial<LabelSession> & { id: string; outcome: "ok" | "derailed" }): LabelSession => ({ file: "x", ...o });

describe("labels.yaml 解析与校验", () => {
  test("合成标注能加载，相对路径按 labels 所在目录解析", () => {
    const l = loadLabels(LABELS);
    expect(l.sessions).toHaveLength(8);
    expect(l.sessions[1]).toMatchObject({ id: "claude-fail-loop", outcome: "derailed", derailStep: 2, expectedRules: ["L1", "L3"] });
    expect(l.sessions[0].file).toBe(join(ROOT, "test/fixtures/claude/success.jsonl"));
  });
  test("eval/labels.example.yaml 是合法 schema 示例（但不含真实数据）", () => {
    const l = loadLabels(join(ROOT, "eval/labels.example.yaml"));
    expect(l.sessions.map((s) => s.id)).toEqual(["example-ok", "example-loop"]);
  });
  test("校验错误给出明确信息", () => {
    const p = (y: string) => () => parseLabels(y, "/tmp", "t.yaml");
    expect(p("version: 1\nsessions: oops")).toThrow(/sessions/);
    expect(p("sessions:\n  - {id: a, file: f, outcome: derailed}")).toThrow(/derail_step/);
    expect(p("sessions:\n  - {id: a, file: f, outcome: derailed, derail_step: 0}")).toThrow(/derail_step/);
    expect(p("sessions:\n  - {id: a, file: f, outcome: ok, derail_step: 3}")).toThrow(/不应有/);
    expect(p("sessions:\n  - {id: a, file: f, outcome: maybe}")).toThrow(/outcome/);
    expect(p("sessions:\n  - {id: a, outcome: ok}")).toThrow(/file/);
    expect(p("sessions:\n  - {id: a, file: f, outcome: ok}\n  - {id: a, file: g, outcome: ok}")).toThrow(/重复/);
    expect(p("version: 2\nsessions: []")).toThrow(LabelError);
    expect(p("42")).toThrow(/对象/);
  });
});

describe("指标口径", () => {
  test("dist", () => {
    expect(dist([])).toEqual({ n: 0, min: null, median: null, mean: null, max: null });
    expect(dist([3, -1, 2, 10])).toEqual({ n: 4, min: -1, median: 2.5, mean: 3.5, max: 10 });
  });
  test("classOf", () => {
    expect(classOf("block")).toBe("blocking");
    expect(classOf("ask")).toBe("blocking");
    expect(classOf("stop_continue")).toBe("blocking");
    expect(classOf("advise")).toBe("advisory");
    expect(classOf("judge_off")).toBe("candidate");
    for (const a of ["log", "skip", "ignore"]) expect(classOf(a)).toBeNull();
  });
  test("TP/FP：窗口内算 TP；跑偏前的早报算 FP；正常会话任何命中都是 FP", () => {
    const inputs: SessionInput[] = [
      { label: L({ id: "d1", outcome: "derailed", derailStep: 10, expectedRules: ["L1", "L3"] }), result: result([entry({ ruleId: "L1", callIndex: 8 }), entry({ ruleId: "L1", callIndex: 12 })]) },
      { label: L({ id: "d2", outcome: "derailed", derailStep: 10 }), result: result([entry({ ruleId: "L1", callIndex: 3 })]) }, // 太早：FP，且漏报
      { label: L({ id: "ok1", outcome: "ok" }), result: result([entry({ ruleId: "L1", callIndex: 5 }), entry({ ruleId: "S1", callIndex: 7 })]) },
      { label: L({ id: "ok2", outcome: "ok" }), result: result([]) },
    ];
    const r = computeReport(inputs, { window: 2 });
    const l1 = r.rules.L1;
    expect(l1).toMatchObject({ hits: 4, sessionsFired: 3, tpSessions: 1, fpSessions: 2, hitTP: 2, hitFP: 2 });
    expect(l1.precision).toBeCloseTo(1 / 3, 2);
    expect(r.rules.S1).toMatchObject({ tpSessions: 0, fpSessions: 1, precision: 0 });
    // 窗口：derail_step−window = 8，所以第 8 步的命中算 TP
    expect(r.overall).toMatchObject({ derailedDetected: 1, derailedTotal: 2, firedOkSessions: 1, okTotal: 2 });
    expect(r.overall.recall).toBe(0.5);
    expect(r.latency.missed).toBe(1);
    // L1 recall：d1 的 expected_rules 含 L1，且在窗口内触发 → 1/1；L3 在 expected_rules 里但从没触发 → 0/1（漏报也要看得见）
    expect(l1.recall).toBe(1);
    expect(r.rules.L3).toMatchObject({ hits: 0, expectedSessions: 1, recall: 0, precision: null });
  });
  test("recall 的分母只来自 expected_rules；没有标注时为 null，不编造", () => {
    const r = computeReport([{ label: L({ id: "d", outcome: "derailed", derailStep: 5 }), result: result([entry({ ruleId: "L2", callIndex: 6 })]) }]);
    expect(r.rules.L2.recall).toBeNull();
    expect(r.rules.L2.precision).toBe(1);
    const r2 = computeReport([{ label: L({ id: "d", outcome: "derailed", derailStep: 5, expectedRules: ["L2", "L9"] }), result: result([entry({ ruleId: "L2", callIndex: 6 })]) }]);
    expect(r2.rules.L2.recall).toBe(1);
    expect(r2.rules.L9).toMatchObject({ expectedSessions: 1, recalledSessions: 0, recall: 0, hits: 0, precision: null });
  });
  test("首次报警延迟：callIndex − derail_step，可以为负；pre 阶段的 callIndex 已是 step+1", () => {
    const r = computeReport([
      { label: L({ id: "a", outcome: "derailed", derailStep: 10 }), result: result([entry({ ruleId: "S1", callIndex: 12, action: "judge_off" }), entry({ ruleId: "L1", callIndex: 9, action: "block", sev: "H", phase: "pre" })]) },
      { label: L({ id: "b", outcome: "derailed", derailStep: 4 }), result: result([entry({ ruleId: "L1", callIndex: 7 })]) },
    ]);
    expect(r.sessions[0].firstAlarmLatency).toBe(-1); // 第一条报警是第 9 次调用（pre 阶段），跑偏点是 10
    expect(r.sessions[1].firstAlarmLatency).toBe(3);
    expect(r.rules.L1.firstAlarmLatency).toMatchObject({ n: 2, min: -1, max: 3 });
    expect(r.latency.firstAlarm).toMatchObject({ n: 2, min: -1, median: 1, max: 3 });
  });
  test("窗口之前的早报是 FP，不能拉低首次报警延迟（噪声越早，数字不能越好看）", () => {
    const r = computeReport([
      { label: L({ id: "d", outcome: "derailed", derailStep: 10 }), result: result([entry({ ruleId: "L1", callIndex: 3 }), entry({ ruleId: "L1", callIndex: 12 })]) },
    ]);
    // 会话算检出（第 12 步的报警在窗口内），延迟 +2，而不是 3−10=−7
    expect(r.sessions[0].firstAlarmLatency).toBe(2);
    expect(r.sessions[0].missed).toBe(false);
    expect(r.rules.L1.firstAlarmLatency).toMatchObject({ n: 1, min: 2, max: 2 });
    expect(r.latency.firstAlarm).toMatchObject({ min: 2, max: 2 });
    // 第 3 步那条按命中级计为 FP
    expect(r.rules.L1).toMatchObject({ hitTP: 1, hitFP: 1, tpSessions: 1, fpSessions: 0 });
    expect(r.classes.advisory).toMatchObject({ alarms: 2, tp: 1, fp: 1 });
    // 只有窗口之前的报警 → 漏报，没有延迟数字
    const early = computeReport([{ label: L({ id: "d", outcome: "derailed", derailStep: 10 }), result: result([entry({ ruleId: "L1", callIndex: 3 })]) }]);
    expect(early.sessions[0]).toMatchObject({ missed: true, firstAlarmLatency: null });
    expect(early.rules.L1.firstAlarmLatency.n).toBe(0);
  });
  test("报警分类：observeOnly、log、skip、ignore 不计入；FDR 与门槛", () => {
    const mk = (action: string, callIndex: number, extra: Partial<TimelineEntry> = {}) => entry({ ruleId: "R", callIndex, action: action as never, ...extra });
    const r = computeReport([
      { label: L({ id: "d", outcome: "derailed", derailStep: 5 }), result: result([mk("block", 6), mk("advise", 7), mk("advise", 8), mk("log", 6), mk("skip", 6), mk("ignore", 6), mk("advise", 6, { observeOnly: true })]) },
      { label: L({ id: "ok", outcome: "ok" }), result: result([mk("advise", 3), mk("block", 4, { ruleId: "X2" })]) },
    ]);
    expect(r.classes.blocking).toMatchObject({ alarms: 2, tp: 1, fp: 1, fdr: 0.5, okSessionsWithAlarm: 1, okSessions: 1, okSessionRate: 1 });
    expect(r.classes.advisory).toMatchObject({ alarms: 3, tp: 2, fp: 1 });
    expect(r.classes.advisory.fdr).toBeCloseTo(1 / 3, 2);
    const [blockGate, adviseGate] = r.gates;
    expect(blockGate).toMatchObject({ threshold: 0.03, pass: false });
    expect(adviseGate).toMatchObject({ threshold: 0.25, pass: false });
  });
  test("没有报警 → FDR 为 null，门槛 n/a（不算通过）", () => {
    const r = computeReport([{ label: L({ id: "ok", outcome: "ok" }), result: result([]) }]);
    expect(r.classes.blocking.fdr).toBeNull();
    expect(r.gates.every((g) => g.pass === null)).toBe(true);
    expect(r.warnings.join("\n")).toContain("30–50");
  });
  test("judge 统计：按 model 汇总 ignore 率与解析失败率", () => {
    const j = (calls: number, ignores: number, parseFail: number) => ({ calls, byModel: { "model-a": { calls, ignores, parseFail, timeouts: 0, errors: 0 } } });
    const r = computeReport([
      { label: L({ id: "a", outcome: "ok" }), result: result([], 10, j(2, 1, 0)) },
      { label: L({ id: "b", outcome: "ok" }), result: result([], 10, j(2, 0, 2)) },
    ]);
    expect(r.judge.calls).toBe(4);
    expect(r.judge.perSessionMean).toBe(2);
    expect(r.judge.byModel["model-a"]).toMatchObject({ calls: 4, ignoreRate: 0.25, parseFailRate: 0.5 });
  });
});

describe("端到端：合成标注 × 合成样本", () => {
  test("每条规则的 precision / recall / 延迟都可见（judge=off）", async () => {
    const { report } = await runEval(loadLabels(LABELS), { judge: "off" });
    expect(report.counts).toEqual({ total: 8, ok: 2, derailed: 6 });
    for (const id of ["L1", "L3", "P1", "S1", "T1", "T2", "X1", "X2"]) {
      expect(report.rules[id], id).toBeDefined();
      expect(report.rules[id].precision, id).not.toBeNull();
    }
    expect(report.rules.L1.recall).toBe(1);
    expect(report.overall.recall).toBe(1);
    expect(report.overall.firedOkSessions).toBe(0);
    expect(report.classes.candidate.alarms).toBeGreaterThan(0); // judge 关闭：M 级是「待 judge」候选
    const fl = report.sessions.find((s) => s.id === "claude-fail-loop")!;
    expect(fl.firstAlarmLatency).toBe(1); // 第 3 次调用上的 L1（M）
  });
  test("mock judge：出现建议类与 judge 统计", async () => {
    const { report } = await runEval(loadLabels(LABELS), { judge: "mock" });
    expect(report.classes.advisory.alarms).toBeGreaterThan(0);
    expect(report.judge.calls).toBeGreaterThan(0);
    expect(report.judge.byModel.mock.calls).toBe(report.judge.calls);
    expect(report.judge.byModel.mock.parseFailRate).toBe(0);
  });
  test("回放失败的会话被报告而不是中断整个评测", async () => {
    const l = parseLabels("sessions:\n  - {id: gone, file: nope.jsonl, outcome: ok}\n  - {id: fine, file: claude/success.jsonl, outcome: ok}", join(ROOT, "test/fixtures"));
    const { report } = await runEval(l);
    expect(report.counts.total).toBe(1);
    expect(report.warnings.join("\n")).toContain("gone");
  });
  test("文本报告含规则表、门槛、judge 小节", async () => {
    const { report } = await runEval(loadLabels(LABELS));
    const t = renderEvalText(report);
    for (const s of ["precision", "recall", "首次报警延迟", "门槛（§12.7）", "judge：调用", "claude-fail-loop"]) expect(t).toContain(s);
  });
  test("提示 A/B 管道：两种写法各跑一遍（mock 下结果相同）", async () => {
    const ab = await runPromptAb(loadLabels(LABELS), { judgeFactory: defaultMockFactory });
    expect(ab.diff.length).toBeGreaterThan(0);
    expect(ab.diff.every((d) => d.precisionRecall === d.precisionIgnoreDefault)).toBe(true);
    expect(ab.note).toContain("live");
  });
});

describe("sv eval CLI", () => {
  async function run(args: string[]) {
    const lines: string[] = [];
    const out = console.log;
    const err = console.error;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    console.error = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      return { code: await main(args), out: lines.join("\n") };
    } finally {
      console.log = out;
      console.error = err;
    }
  }
  test("text / json / --ab / 缺参数 / 坏标注", async () => {
    const t = await run(["eval", LABELS]);
    expect(t.code).toBe(0);
    expect(t.out).toContain("评测会话 8");
    const j = await run(["eval", LABELS, "--format=json", "--judge=mock"]);
    expect(JSON.parse(j.out).counts.total).toBe(8);
    const ab = await run(["eval", LABELS, "--ab"]);
    expect(ab.out).toContain("提示写法 A");
    expect((await run(["eval"])).code).toBe(2);
    expect((await run(["eval", join(ROOT, "package.json")])).code).toBe(2);
  });
});

describe("eval 写日志 + 阈值扫描", () => {
  test("runEval 记一条 kind=eval 的运行，含阈值哈希与覆盖项，回放写在这个 run 下", async () => {
    const { LogStore, applyOverride, defaultConfig } = await import("@sv/core");
    const store = new LogStore(":memory:");
    const cfg = applyOverride(defaultConfig(), "thresholds.T1.H=4");
    const { runId, report } = await runEval(loadLabels(LABELS), { cfg, logStore: store, label: "x", overrides: ["thresholds.T1.H=4"] });
    const run = store.db.query("SELECT * FROM runs WHERE id=?").get(runId!) as Record<string, string>;
    expect(run).toMatchObject({ kind: "eval", label: "x" });
    expect(JSON.parse(run.overrides_json)).toEqual(["thresholds.T1.H=4"]);
    expect(run.ended_ts).toBeTruthy();
    expect(store.db.query("SELECT COUNT(*) AS n FROM sessions WHERE run_id=?").get(runId!)).toEqual({ n: report.counts.total });
    expect((store.db.query("SELECT COUNT(*) AS n FROM hits WHERE run_id=?").get(runId!) as { n: number }).n).toBeGreaterThan(0);
  });
  test("runSweep：每个取值各跑一遍、各写一条运行；改变真正生效的阈值会改变结果", async () => {
    const { LogStore } = await import("@sv/core");
    const store = new LogStore(":memory:");
    const points = await runSweep(loadLabels(LABELS), { path: "thresholds.T1.H", values: ["3", "5", "99"] }, { logStore: store, label: "sw" });
    expect(points).toHaveLength(3);
    expect(store.db.query("SELECT label FROM runs ORDER BY id").all()).toEqual([{ label: "sw:thresholds.T1.H=3" }, { label: "sw:thresholds.T1.H=5" }, { label: "sw:thresholds.T1.H=99" }]);
    const blocks = points.map((p) => p.report.classes.blocking.alarms);
    expect(blocks[0]).toBeGreaterThan(blocks[2]); // H 阈值 3 → 99：拦截类报警变少
    const t1H = (p: (typeof points)[number]) => p.report.rules.T1.levels.H ?? 0;
    expect(t1H(points[0])).toBeGreaterThan(t1H(points[2]));
    const text = renderSweepText("thresholds.T1.H", points);
    expect(text).toContain("阈值扫描 thresholds.T1.H = 3 | 5 | 99");
    expect(text).toContain("拦截类");
    expect(text).toMatch(/run \d+/);
  });
  test("扫描键名写错 → 直接报错，一个都不跑（不会得出「没影响」的错误结论）", async () => {
    const { LogStore } = await import("@sv/core");
    const store = new LogStore(":memory:");
    await expect(runSweep(loadLabels(LABELS), { path: "thresholds.T1.h", values: ["3", "4"] }, { logStore: store })).rejects.toThrow(/没有路径/);
    expect(store.count("runs")).toBe(0);
  });
  test("sv eval --sweep CLI", async () => {
    const lines: string[] = [];
    const o1 = console.log;
    const o2 = console.error;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    console.error = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      expect(await main(["eval", LABELS, "--sweep", "thresholds.T1.H=3,4"])).toBe(0);
      expect(lines.join("\n")).toContain("阈值扫描 thresholds.T1.H = 3 | 4");
      lines.length = 0;
      expect(await main(["eval", LABELS, "--sweep", "thresholds.T1.h=3,4"])).toBe(2);
      expect(lines.join("\n")).toContain("扫描有误");
      expect(await main(["eval", LABELS, "--sweep", "thresholds.T1.H=3"])).toBe(2);
    } finally {
      console.log = o1;
      console.error = o2;
    }
  });
});
