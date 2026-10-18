import { describe, expect, test } from "bun:test";
import { applyOverride, defaultConfig } from "../src/config.ts";
import { PYTEST_FAIL, PYTEST_PASS, Sim } from "./sim.ts";

describe("T2 / T3", () => {
  test("T2：本轮无编辑的第 3 次 full → advise；第 5 次 → M", async () => {
    const s = new Sim();
    await s.prompt("fix");
    await s.bash("pytest", { out: PYTEST_PASS });
    await s.bash("pytest -x", { out: PYTEST_PASS });
    expect(s.hitsOf("T2")).toHaveLength(0);
    await s.bash("pytest -q", { out: PYTEST_PASS });
    expect(s.hitsOf("T2").map((h) => h.sev)).toEqual(["L"]);
    expect(s.hitsOf("T2")[0].message).toContain("3 次全量测试");
    await s.bash("pytest -p no:cacheprovider", { out: PYTEST_PASS });
    await s.bash("pytest -p no:cacheprovider -x", { out: PYTEST_PASS });
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
  test("T4：第 4 次 L（无 message），第 6 次 advise（有 message）", async () => {
    const s = new Sim();
    await s.prompt("x");
    for (let i = 0; i < 6; i++) await s.bash(probe(i), { out: "o" + i });
    const h = s.hitsOf("T4");
    expect(h).toHaveLength(2);
    expect(h[0].message).toBeUndefined();
    expect(h[1].message).toContain("合并成一个测试");
  });
  test("T4：只读 JSON / 算路径的 python -c 不算 probe", async () => {
    const g = new Sim();
    await g.prompt("x");
    for (let i = 0; i < 8; i++) await g.bash(`python -c "import json; print(json.dumps({'a': ${i}}))"`, { out: "o" + i });
    expect(g.hitsOf("T4")).toHaveLength(0);
  });
  test("T5：修复之后新建的 smoke 脚本；repro 脚本豁免", async () => {
    const s = new Sim();
    await s.prompt("fix bug");
    // 修改源码之前新建并运行的复现脚本：豁免
    await s.write("/work/proj/repro.py", "print(1)", { created: true });
    await s.bash("python repro.py", { out: "bug" });
    await s.edit("/work/proj/src/a.py", "a", "b");
    // 修复之后：新建 smoke 脚本，第 2 个 L（无 message），第 3 个 advise（有 message）
    for (const n of ["smoke_a.py", "smoke_b.py", "smoke_c.py"]) {
      await s.write(`/work/proj/${n}`, "print(1)", { created: true });
      await s.bash(`python ${n}`, { out: "ok " + n });
    }
    const h = s.hitsOf("T5");
    expect(h).toHaveLength(2);
    expect(h[0].message).toBeUndefined();
    expect(h[1].message).toBeTruthy();
    expect(h[1].detail?.scripts).toEqual(["smoke_a.py", "smoke_b.py", "smoke_c.py"]);
  });
  test("T5：repro 脚本反复运行不触发", async () => {
    const s = new Sim();
    await s.prompt("fix bug");
    await s.write("/work/proj/smoke_repro.py", "print(1)", { created: true });
    for (let i = 0; i < 4; i++) await s.bash("python smoke_repro.py", { out: "bug " + i });
    expect(s.hitsOf("T5")).toHaveLength(0);
  });
  test("T6：没改动就重复 localhost curl，第 3 次 advise", async () => {
    const s = new Sim();
    await s.prompt("x");
    for (let i = 0; i < 2; i++) await s.bash("curl -s localhost:3000/health", { out: "ok" });
    expect(s.hitsOf("T6")).toHaveLength(0);
    await s.bash("curl -s localhost:3000/health", { out: "ok" });
    expect(s.hitsOf("T6")).toHaveLength(1);
  });
  test("T6：中间有编辑则不算", async () => {
    const s = new Sim();
    await s.bash("curl -s localhost:3000/health", { out: "ok" });
    await s.edit("/work/proj/src/a.py", "a", "b");
    await s.bash("curl -s localhost:3000/health", { out: "ok" });
    await s.edit("/work/proj/src/a.py", "b", "c");
    await s.bash("curl -s localhost:3000/health", { out: "ok" });
    expect(s.hitsOf("T6")).toHaveLength(0);
  });
  test("T7：花样运行 advise", async () => {
    const s = new Sim();
    await s.prompt("x");
    await s.bash("pytest -p random --count=3", { out: PYTEST_PASS });
    expect(s.hitsOf("T7")).toHaveLength(1);
    expect(s.hitsOf("T7")[0].message).toBeTruthy();
    const g = new Sim();
    await g.prompt("x");
    await g.bash("go test -count=5 ./...", { out: "ok  \ta\t0.1s" });
    expect(g.hitsOf("T7")[0]?.message).toBeTruthy();
  });
  test("T8：验证类调用占比过半且 ≥10 → L；≥14 → M", async () => {
    const s = new Sim();
    await s.prompt("x");
    await s.edit("/work/proj/src/a.py", "a", "b");
    for (let i = 0; i < 14; i++) await s.bash(`pytest tests/test_${i}.py`, { out: PYTEST_PASS + i });
    expect(s.hitsOf("T8").map((h) => h.sev)).toEqual(["L", "M"]);
  });
  test("每轮预算：全量测试 ≤3 次，超出 → M", async () => {
    const s = new Sim();
    await s.prompt("x");
    for (let i = 0; i < 4; i++) {
      await s.edit("/work/proj/src/a.py", `v${i}`, `v${i + 1}`);
      await s.bash("pytest", { out: PYTEST_PASS });
    }
    expect(s.hitsOf("TB").map((h) => h.detail?.limit)).toEqual([3]);
  });
  test("预算阈值可以通过 thresholds 覆盖（replay 调参）", async () => {
    const s = new Sim({ cfg: applyOverride(defaultConfig(), "thresholds.full_tests_per_turn=1") });
    await s.prompt("x");
    for (let i = 0; i < 2; i++) {
      await s.edit("/work/proj/src/a.py", `v${i}`, `v${i + 1}`);
      await s.bash("pytest", { out: PYTEST_PASS });
    }
    expect(s.hitsOf("TB").map((h) => h.detail?.limit)).toEqual([1]);
  });
  test("预算以 origin=user 的消息为界；supervisor 回显不重置", async () => {
    const s = new Sim();
    await s.prompt("x");
    for (let i = 0; i < 3; i++) {
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
    const s = new Sim();
    await s.prompt("fix the CI");
    for (let i = 0; i < 6; i++) await s.bash(probe(i), { out: "o" + i });
    const h = s.hitsOf("T4");
    expect(h.length).toBeGreaterThan(0);
    expect(h.every((x) => x.message === undefined)).toBe(true);
  });
});
void PYTEST_FAIL;
