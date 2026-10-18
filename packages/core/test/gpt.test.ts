import { describe, expect, test } from "bun:test";
import { pickProfile, defaultConfig, resolveConfig, loadConfigFile } from "../src/config.ts";
import { PYTEST_FAIL, PYTEST_PASS, Sim, cfgWith } from "./sim.ts";

const GPT = { model: "gpt-5-codex", harness: "codex" as const };

describe("档位选择", () => {
  test("按 model 正则（锚定开头）选档，拿不到 model 用默认档", () => {
    const cfg = defaultConfig();
    expect(pickProfile("gpt-5", cfg).name).toBe("gpt");
    expect(pickProfile("o3-mini", cfg).name).toBe("gpt");
    expect(pickProfile("codex-mini", cfg).name).toBe("gpt");
    expect(pickProfile("claude-sonnet-5-5", cfg).name).toBe("default");
    expect(pickProfile("my-gpt-clone", cfg).name).toBe("default"); // 锚定开头
    expect(pickProfile(undefined, cfg).name).toBe("default");
  });
  test("config.example.yaml 能被加载，并映射到阶梯", () => {
    const cfg = loadConfigFile(new URL("../../../config.example.yaml", import.meta.url).pathname);
    expect(cfg.profiles.default.T2.advise).toBe(3);
    expect(cfg.profiles.gpt.T2.advise).toBe(2);
    expect(cfg.profiles.gpt.T4.advise).toBe(4);
    expect(cfg.profiles.default.T4.L).toBe(6);
    expect(cfg.profiles.gpt.T5.advise).toBe(2);
    expect(cfg.profiles.gpt.verify_calls_per_turn).toBe(12);
    expect(cfg.profiles.gpt.T1.H).toBe(3);
    expect(cfg.profiles.default.T1.H).toBeUndefined();
    expect(cfg.mode).toBe("shadow");
  });
  test("resolveConfig：block_on 只作用于 GPT 档", () => {
    const cfg = resolveConfig({ rules: { T1_rerun_unchanged: { block_on: 4 } } });
    expect(cfg.profiles.gpt.T1.H).toBe(4);
    expect(cfg.profiles.default.T1.H).toBeUndefined();
  });
});

describe("T1 没改动就重跑同一条测试命令", () => {
  test("默认档：第 2 次 advise（L 级本地建议，事实陈述），第 3 次仍 advise", async () => {
    const s = new Sim();
    await s.prompt("fix");
    await s.bash("pytest -q", { out: PYTEST_PASS });
    const [pre2] = await s.bash("pytest -q", { out: PYTEST_PASS });
    const h = pre2.hits.find((x) => x.ruleId === "T1");
    expect(h?.sev).toBe("L");
    expect(h?.message).toContain("没有变化");
    expect(h?.message).toContain("3 通过");
    const [pre3] = await s.bash("pytest -q", { out: PYTEST_PASS });
    expect(pre3.hits.find((x) => x.ruleId === "T1")?.sev).toBe("L");
  });
  test("GPT 档：第 3 次 H（blockable）；非 git/推断时不拦只 advise", async () => {
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

describe("T2 / T3", () => {
  test("T2 默认档：本轮无编辑的第 3 次 full → advise", async () => {
    const s = new Sim();
    await s.prompt("fix");
    await s.bash("pytest", { out: PYTEST_PASS });
    await s.bash("pytest -x", { out: PYTEST_PASS });
    expect(s.hitsOf("T2")).toHaveLength(0);
    await s.bash("pytest -q", { out: PYTEST_PASS });
    expect(s.hitsOf("T2")).toHaveLength(1);
  });
  test("T2 GPT 档：第 2 次 advise，第 4 次 M", async () => {
    const s = new Sim(GPT);
    await s.prompt("fix");
    for (let i = 0; i < 4; i++) await s.bash(`pytest -p no:cacheprovider${i ? " -x".repeat(i) : ""}`, { out: PYTEST_PASS });
    expect(s.hitsOf("T2").map((h) => h.sev)).toEqual(["L", "M"]);
  });
  test("T2：中间有编辑则重新计数", async () => {
    const s = new Sim();
    await s.prompt("fix");
    await s.bash("pytest", { out: PYTEST_PASS });
    await s.bash("pytest -x", { out: PYTEST_PASS });
    await s.edit("/work/proj/src/a.py", "a", "b");
    await s.bash("pytest -q", { out: PYTEST_PASS });
    expect(s.hitsOf("T2")).toHaveLength(0);
  });
  test("T3：改了文件后仍跑 full → 提示具体 targeted 路径，只提一次", async () => {
    const s = new Sim();
    await s.prompt("fix");
    await s.edit("/work/proj/src/foo.py", "a", "b");
    await s.bash("pytest", { out: PYTEST_PASS });
    await s.edit("/work/proj/src/foo.py", "b", "c");
    await s.bash("pytest", { out: PYTEST_PASS });
    const h = s.hitsOf("T3");
    expect(h).toHaveLength(1);
    expect(h[0].message).toContain("tests/test_foo.py");
  });
});

describe("T4–T8 与预算", () => {
  const probe = (i: number) => `python -c 'import myapp; print(myapp.f(${i}))'`;
  test("T4 默认档 ≥6 次 L（无 message）；GPT 档 ≥4 次 advise", async () => {
    const s = new Sim();
    await s.prompt("x");
    for (let i = 0; i < 6; i++) await s.bash(probe(i), { out: "o" + i });
    const h = s.hitsOf("T4");
    expect(h).toHaveLength(1);
    expect(h[0].message).toBeUndefined();
    const g = new Sim(GPT);
    await g.prompt("x");
    for (let i = 0; i < 4; i++) await g.bash(probe(i), { out: "o" + i });
    expect(g.hitsOf("T4")[0]?.message).toContain("合并成一个测试");
  });
  test("T4：只读 JSON / 算路径的 python -c 不算 probe", async () => {
    const g = new Sim(GPT);
    await g.prompt("x");
    for (let i = 0; i < 8; i++) await g.bash(`python -c "import json; print(json.dumps({'a': ${i}}))"`, { out: "o" + i });
    expect(g.hitsOf("T4")).toHaveLength(0);
  });
  test("T5：修复之后新建的 smoke 脚本；repro 脚本豁免", async () => {
    const s = new Sim(GPT);
    await s.prompt("fix bug");
    // 修改源码之前新建并运行的复现脚本：豁免
    await s.write("/work/proj/repro.py", "print(1)", { created: true });
    await s.bash("python repro.py", { out: "bug" });
    await s.edit("/work/proj/src/a.py", "a", "b");
    // 修复之后：新建 smoke 脚本
    for (const n of ["smoke_a.py", "smoke_b.py"]) {
      await s.write(`/work/proj/${n}`, "print(1)", { created: true });
      await s.bash(`python ${n}`, { out: "ok " + n });
    }
    const h = s.hitsOf("T5");
    expect(h).toHaveLength(1);
    expect(h[0].detail?.scripts).toEqual(["smoke_a.py", "smoke_b.py"].map((x) => `${x}`));
  });
  test("T5：repro 脚本反复运行不触发", async () => {
    const s = new Sim(GPT);
    await s.prompt("fix bug");
    await s.write("/work/proj/smoke_repro.py", "print(1)", { created: true });
    for (let i = 0; i < 4; i++) await s.bash("python smoke_repro.py", { out: "bug " + i });
    expect(s.hitsOf("T5")).toHaveLength(0);
  });
  test("T6：没改动就重复 localhost curl", async () => {
    const s = new Sim(GPT);
    await s.prompt("x");
    await s.bash("curl -s localhost:3000/health", { out: "ok" });
    expect(s.hitsOf("T6")).toHaveLength(0);
    await s.bash("curl -s localhost:3000/health", { out: "ok" });
    expect(s.hitsOf("T6")).toHaveLength(1);
  });
  test("T6：中间有编辑则不算", async () => {
    const s = new Sim(GPT);
    await s.bash("curl -s localhost:3000/health", { out: "ok" });
    await s.edit("/work/proj/src/a.py", "a", "b");
    await s.bash("curl -s localhost:3000/health", { out: "ok" });
    expect(s.hitsOf("T6")).toHaveLength(0);
  });
  test("T7：花样运行", async () => {
    const s = new Sim();
    await s.prompt("x");
    await s.bash("pytest -p random --count=3", { out: PYTEST_PASS });
    expect(s.hitsOf("T7")).toHaveLength(1);
    const g = new Sim(GPT);
    await g.prompt("x");
    await g.bash("go test -count=5 ./...", { out: "ok  \ta\t0.1s" });
    expect(g.hitsOf("T7")[0]?.message).toBeTruthy();
  });
  test("T8：验证类调用占比过半且 ≥10", async () => {
    const s = new Sim(GPT);
    await s.prompt("x");
    await s.edit("/work/proj/src/a.py", "a", "b");
    for (let i = 0; i < 10; i++) await s.bash(`pytest tests/test_${i}.py`, { out: PYTEST_PASS + i });
    expect(s.hitsOf("T8")).toHaveLength(1);
    expect(s.hitsOf("T8")[0].sev).toBe("M");
  });
  test("GPT 档每轮预算：全量测试 ≤2 次，超出 → M", async () => {
    const s = new Sim(GPT);
    await s.prompt("x");
    for (let i = 0; i < 3; i++) {
      await s.edit("/work/proj/src/a.py", `v${i}`, `v${i + 1}`);
      await s.bash("pytest", { out: PYTEST_PASS });
    }
    expect(s.hitsOf("TB").map((h) => h.detail?.limit)).toEqual([2]);
  });
  test("预算以 origin=user 的消息为界；supervisor 回显不重置", async () => {
    const s = new Sim(GPT);
    await s.prompt("x");
    for (let i = 0; i < 2; i++) {
      await s.edit("/work/proj/src/a.py", `v${i}`, `v${i + 1}`);
      await s.bash("pytest", { out: PYTEST_PASS });
    }
    await s.prompt("工作区没有变化，请先确认。", "supervisor");
    await s.edit("/work/proj/src/a.py", "v9", "v10");
    await s.bash("pytest", { out: PYTEST_PASS });
    expect(s.hitsOf("TB")).toHaveLength(1);
    await s.prompt("好的，继续", "user");
    await s.edit("/work/proj/src/a.py", "v10", "v11");
    await s.bash("pytest", { out: PYTEST_PASS });
    expect(s.hitsOf("TB")).toHaveLength(1);
  });
  test("例外：任务是修 CI / 基准 → T 组降级（advise→L 无 message）", async () => {
    const s = new Sim(GPT);
    await s.prompt("fix the CI");
    for (let i = 0; i < 4; i++) await s.bash(probeCmd(i), { out: "o" + i });
    const h = s.hitsOf("T4");
    expect(h).toHaveLength(1);
    expect(h[0].message).toBeUndefined();
  });
});

const probeCmd = (i: number) => `python -c 'import myapp; print(myapp.f(${i}))'`;
void PYTEST_FAIL;
