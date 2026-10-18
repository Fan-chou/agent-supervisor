import { describe, expect, test } from "bun:test";
import { applyOverride, defaultConfig, loadConfigFile, resolveConfig } from "../src/config.ts";
import { PYTEST_FAIL, PYTEST_PASS, Sim, cfgWith } from "./sim.ts";

// 模型名只记录、不参与判定：下面的 Sim 用不同的 model / harness，结果必须一样。
const GPT = { model: "gpt-5-codex", harness: "codex" as const };

describe("只有一套阈值，不按模型分档", () => {
  test("配置里没有 profiles / model_profiles", () => {
    const cfg = defaultConfig() as unknown as Record<string, unknown>;
    expect(cfg.profiles).toBeUndefined();
    expect(cfg.model_profiles).toBeUndefined();
    expect(cfg.thresholds).toBeDefined();
  });
  test("模型名不影响命中：同一段会话在任意模型名下得到相同的命中序列", async () => {
    const run = async (opts: ConstructorParameters<typeof Sim>[0]) => {
      const s = new Sim(opts);
      await s.prompt("fix");
      for (let i = 0; i < 4; i++) await s.bash("pytest -q", { out: PYTEST_PASS });
      return s.hits.map((h) => `${h.ruleId}:${h.sev}:${h.phase}`);
    };
    const base = await run({});
    expect(base.length).toBeGreaterThan(0);
    for (const model of ["gpt-5-codex", "claude-sonnet-5-5", "o3-mini", "kimi-k2", undefined]) {
      expect(await run({ model })).toEqual(base);
    }
    expect(await run({ harness: "codex", model: "gpt-5" })).toEqual(base);
  });
  test("config.example.yaml 能被加载，thresholds 与默认值一致", () => {
    const cfg = loadConfigFile(new URL("../../../config.example.yaml", import.meta.url).pathname);
    expect(cfg.thresholds).toEqual(defaultConfig().thresholds);
    expect(cfg.thresholds.T1).toEqual({ advise: 2, H: 3 });
    expect(cfg.mode).toBe("shadow");
    expect(cfg.log.retention_days).toBe(14);
  });
  test("block_on 是 thresholds.T1.H 的别名；显式的 thresholds.T1.H 优先", () => {
    expect(resolveConfig({ rules: { T1_rerun_unchanged: { block_on: 4 } } }).thresholds.T1.H).toBe(4);
    expect(resolveConfig({ rules: { T1_rerun_unchanged: { block_on: 4 } }, thresholds: { T1: { advise: 2, H: 5 } } }).thresholds.T1.H).toBe(5);
  });
  test("applyOverride（sv replay --set 用）：点号路径、JSON 值、不修改原配置、拒绝不存在的路径", () => {
    const cfg = defaultConfig();
    const c2 = applyOverride(cfg, "thresholds.T1.H=4");
    expect(c2.thresholds.T1.H).toBe(4);
    expect(cfg.thresholds.T1.H).toBe(3);
    expect(applyOverride(cfg, "budgets.judge_cooldown_s=30").budgets.judge_cooldown_s).toBe(30);
    expect(applyOverride(cfg, "mode=enforce").mode).toBe("enforce");
    expect(() => applyOverride(cfg, "nope.x=1")).toThrow();
    expect(() => applyOverride(cfg, "garbage")).toThrow();
  });
  test("applyOverride 严格：写错键名不能悄悄通过（否则 --compare 会得出「这个阈值没影响」的错误结论）", () => {
    const cfg = defaultConfig();
    expect(() => applyOverride(cfg, "thresholds.T1.h=4")).toThrow(/没有路径/);
    expect(() => applyOverride(cfg, "thresholds.L2_repeats=5")).toThrow(/没有路径/);
    expect(() => applyOverride(cfg, "thresholds.T9={\"advise\":2}")).toThrow(/没有路径/);
    expect(() => applyOverride(cfg, "thresholds.T1.H=abc")).toThrow(/需要数字/);
    expect(() => applyOverride(cfg, "thresholds.L2_repeat=\"x\"")).toThrow(/需要数字/);
    expect(() => applyOverride(cfg, "mode=3")).toThrow(/需要字符串/);
    // 唯一的例外：给 T1–T8 的阶梯新增 L / advise / M / H 级别
    expect(applyOverride(cfg, "thresholds.T3.M=2").thresholds.T3).toEqual({ advise: 1, M: 2 });
    expect(() => applyOverride(cfg, "thresholds.T3.X=2")).toThrow(/没有路径/);
  });
  test("每个 --set 的合法键都真的改变检测结果（不是只改了日志里的哈希）", async () => {
    const hitsOf = async (assignment: string | null, drive: (s: Sim) => Promise<void>, rule: string) => {
      const s = new Sim({ cfg: assignment ? applyOverride(defaultConfig(), assignment) : defaultConfig() });
      await drive(s);
      return s.hitsOf(rule).length;
    };
    // T3.M：给 T3 加一个 M 级阈值，第 1 次满足 advise 的同时也满足 M → 级别变了
    const t3 = async (s: Sim) => {
      await s.prompt("fix");
      await s.edit("/work/proj/src/foo.py", "a", "b");
      await s.bash("pytest", { out: PYTEST_PASS });
    };
    const s0 = new Sim();
    await t3(s0);
    const s1 = new Sim({ cfg: applyOverride(defaultConfig(), "thresholds.T3.M=1") });
    await t3(s1);
    expect(s0.hitsOf("T3")[0].sev).toBe("L");
    expect(s1.hitsOf("T3")[0].sev).toBe("M");
    // 原先写死在检测器里的阈值现在也能调：L3 需要 3 次 → 2 次
    const l3 = async (s: Sim) => {
      for (const f of ["a", "b"]) await s.bash(`python ${f}.py`, { fail: true, out: "Traceback (most recent call last):\n  File \"x.py\", line 3, in f\nKeyError: 'x'" });
    };
    expect(await hitsOf(null, l3, "L3")).toBe(0);
    expect(await hitsOf("thresholds.L3_repeat=2", l3, "L3")).toBe(1);
    // L6：读 3 次 → 2 次
    const l6 = async (s: Sim) => {
      for (let i = 0; i < 2; i++) await s.read("/work/proj/src/a.py");
    };
    expect(await hitsOf(null, l6, "L6")).toBe(0);
    expect(await hitsOf("thresholds.L6_reads=2", l6, "L6")).toBe(1);
    // S4 / S2 / L4 同理：键存在且被读取
    const l4 = async (s: Sim) => {
      for (const [o, n] of [["A", "B"], ["B", "A"]]) await s.edit("/work/proj/src/a.py", o, n);
    };
    expect(await hitsOf(null, l4, "L4")).toBe(0);
    expect(await hitsOf("thresholds.L4_returns=1", l4, "L4")).toBe(1);
  });
  test("thresholdsForRule（写进日志）与配置一致，不再有字面量", async () => {
    const { thresholdsForRule } = await import("../src/config.ts");
    const cfg = applyOverride(defaultConfig(), "thresholds.L3_window=20");
    expect(thresholdsForRule("L3", cfg)).toEqual({ repeat: 3, window_steps: 20 });
    expect(thresholdsForRule("L1", applyOverride(cfg, "thresholds.L1_block_after=3"))).toEqual({ advise_after_failures: 2, block_after_failures: 3 });
    expect(thresholdsForRule("S4", cfg)).toEqual({ subagents: 15, empty_run: 3 });
    expect(thresholdsForRule("R3", cfg)).toMatchObject({ ratio: 0.85 });
  });
});

describe("T1 没改动就重跑同一条测试命令", () => {
  test("第 2 次 advise（L 级本地建议，事实陈述），第 3 次 H", async () => {
    const s = new Sim();
    await s.prompt("fix");
    await s.bash("pytest -q", { out: PYTEST_PASS });
    const [pre2] = await s.bash("pytest -q", { out: PYTEST_PASS });
    const h = pre2.hits.find((x) => x.ruleId === "T1");
    expect(h?.sev).toBe("L");
    expect(h?.message).toContain("没有变化");
    expect(h?.message).toContain("3 通过");
    const [pre3] = await s.bash("pytest -q", { out: PYTEST_PASS });
    expect(pre3.hits.find((x) => x.ruleId === "T1")?.sev).toBe("H");
  });
  test("第 3 次 H（blockable）；非 git/推断时不拦只 advise", async () => {
    const s = new Sim(GPT);
    await s.prompt("fix");
    await s.bash("pytest -q", { out: PYTEST_PASS });
    await s.bash("pytest -q", { out: PYTEST_PASS });
    const [pre3] = await s.bash("pytest -q", { out: PYTEST_PASS });
    const h = pre3.hits.find((x) => x.ruleId === "T1");
    expect(h?.sev).toBe("H");
    expect(h?.blockable).toBe(true);
    expect(h?.verified).toBe(false);
    const d = pre3.decisions.find((x) => x.hit.ruleId === "T1")!;
    expect(d.action).toBe("advise"); // 未核实 → 不拦
    expect(d.wouldBlockIfVerified).toBe(true);
  });
  test("GPT 档 + 指纹核实 → 按规则拦截（judge 关闭 = 规则默认动作）", async () => {
    const s = new Sim(GPT);
    await s.prompt("fix");
    for (let i = 0; i < 2; i++) await s.bash("pytest -q", { out: PYTEST_PASS, ws: "fpA" });
    const [pre3] = await s.bash("pytest -q", { out: PYTEST_PASS, ws: "fpA" });
    expect(pre3.hits.find((x) => x.ruleId === "T1")?.verified).toBe(true);
    expect(pre3.decisions.find((x) => x.hit.ruleId === "T1")?.action).toBe("block");
  });
  test("期间有编辑 → 不报", async () => {
    const s = new Sim(GPT);
    await s.prompt("fix");
    await s.bash("pytest -q", { out: PYTEST_PASS });
    await s.edit("/work/proj/src/a.py", "a", "b");
    const [pre] = await s.bash("pytest -q", { out: PYTEST_PASS });
    expect(pre.hits.some((x) => x.ruleId === "T1")).toBe(false);
  });
  test("期间有 mutating 命令 → 不报", async () => {
    const s = new Sim(GPT);
    await s.bash("pytest -q", { out: PYTEST_PASS });
    await s.bash("npm run build", { out: "ok" });
    const [pre] = await s.bash("pytest -q", { out: PYTEST_PASS });
    expect(pre.hits.some((x) => x.ruleId === "T1")).toBe(false);
  });
  test("期间外部进程改了文件（指纹变了）→ 不报", async () => {
    const s = new Sim(GPT);
    await s.bash("pytest -q", { out: PYTEST_PASS, ws: "A" });
    const [pre] = await s.bash("pytest -q", { out: PYTEST_PASS, ws: "B" });
    // pre 的指纹与上次 post 比较
    expect(pre.hits.some((x) => x.ruleId === "T1")).toBe(false);
  });
  test("不同命令不算同一条", async () => {
    const s = new Sim(GPT);
    await s.bash("pytest tests/a.py", { out: PYTEST_PASS });
    const [pre] = await s.bash("pytest tests/b.py", { out: PYTEST_PASS });
    expect(pre.hits.some((x) => x.ruleId === "T1")).toBe(false);
  });
  test("例外：任务是写测试 → 降一级（H→M）", async () => {
    const s = new Sim(GPT);
    await s.prompt("请给 parser 补测试");
    for (let i = 0; i < 2; i++) await s.bash("pytest -q", { out: PYTEST_PASS, ws: "A" });
    const [pre3] = await s.bash("pytest -q", { out: PYTEST_PASS, ws: "A" });
    expect(pre3.hits.find((x) => x.ruleId === "T1")?.sev).toBe("M");
  });
  test("连续拦截上限：第 3 次拦截降级为 advise（T1 受限）", async () => {
    const s = new Sim({ ...GPT, cfg: cfgWith({ mode: "enforce" }) });
    await s.prompt("fix");
    for (let i = 0; i < 2; i++) await s.bash("pytest -q", { out: PYTEST_PASS, ws: "A" });
    const actions: string[] = [];
    for (let i = 0; i < 4; i++) {
      // 默认 5 秒间隔：冷却不能把重复的拦截放行
      const [pre] = await s.bash("pytest -q", { out: PYTEST_PASS, ws: "A" });
      actions.push(pre.decisions.find((x) => x.hit.ruleId === "T1" && x.hit.sev === "H")?.action ?? "-");
    }
    expect(actions).toEqual(["block", "block", "advise", "skip"]);
  });
});
