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
    expect(applyOverride(cfg, "thresholds.T9={\"advise\":2}").thresholds).toHaveProperty("T9");
    expect(() => applyOverride(cfg, "nope.x=1")).toThrow();
    expect(() => applyOverride(cfg, "garbage")).toThrow();
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
