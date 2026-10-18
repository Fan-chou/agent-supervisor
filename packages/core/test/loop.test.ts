import { describe, expect, test } from "bun:test";
import { oscillationReturns } from "../src/detectors/loop.ts";
import { PYTEST_FAIL, PYTEST_PASS, Sim } from "./sim.ts";

describe("L1 同一调用连续失败 + 期间无改动", () => {
  test("第 2 次失败 → M；第 3 次尝试在 pre 上 → H（blockable）", async () => {
    const s = new Sim();
    await s.prompt("fix it");
    await s.bash("pytest tests/test_a.py", { fail: true, out: PYTEST_FAIL(1) });
    expect(s.hitsOf("L1")).toHaveLength(0);
    await s.bash("pytest tests/test_a.py", { fail: true, out: PYTEST_FAIL(2) }); // 数字不同，指纹相同
    const m = s.hitsOf("L1").filter((h) => h.sev === "M");
    expect(m).toHaveLength(1);
    expect(m[0].detail?.count).toBe(2);
    // 第 3 次尝试
    const [pre] = await s.bash("pytest tests/test_a.py", { fail: true, out: PYTEST_FAIL(3) });
    const h = pre.hits.find((x) => x.ruleId === "L1");
    expect(h?.sev).toBe("H");
    expect(h?.blockable).toBe(true);
    expect(h?.phase).toBe("pre");
  });
  test("两次之间有编辑 → 不算", async () => {
    const s = new Sim();
    await s.prompt("fix it");
    await s.bash("pytest", { fail: true, out: PYTEST_FAIL(1) });
    await s.edit("/work/proj/src/a.py", "x", "y");
    await s.bash("pytest", { fail: true, out: PYTEST_FAIL(1) });
    expect(s.hitsOf("L1")).toHaveLength(0);
  });
  test("两次之间有 mutating 命令（pip install）→ 不算", async () => {
    const s = new Sim();
    await s.bash("pytest", { fail: true, out: PYTEST_FAIL(1) });
    await s.bash("pip install requests", { out: "ok" });
    await s.bash("pytest", { fail: true, out: PYTEST_FAIL(1) });
    expect(s.hitsOf("L1")).toHaveLength(0);
  });
  test("非 mutating 的其他命令不打断链", async () => {
    const s = new Sim();
    await s.bash("pytest", { fail: true, out: PYTEST_FAIL(1) });
    await s.bash("ls", { out: "a" });
    await s.bash("pytest", { fail: true, out: PYTEST_FAIL(1) });
    expect(s.hitsOf("L1").filter((h) => h.sev === "M")).toHaveLength(1);
  });
  test("错误指纹不同 → 不算", async () => {
    const s = new Sim();
    await s.bash("pytest", { fail: true, out: "E   KeyError: 'a'" });
    await s.bash("pytest", { fail: true, out: "E   TypeError: nope" });
    expect(s.hitsOf("L1")).toHaveLength(0);
  });
  test("中间成功过 → 链断开", async () => {
    const s = new Sim();
    await s.bash("pytest", { fail: true, out: PYTEST_FAIL(1) });
    await s.bash("pytest", { out: PYTEST_PASS });
    await s.bash("pytest", { fail: true, out: PYTEST_FAIL(1) });
    expect(s.hitsOf("L1")).toHaveLength(0);
  });
  test("指纹核实：两边 wsFingerprint 相同才 verified；不同 → changed", async () => {
    const s = new Sim();
    await s.bash("pytest", { fail: true, out: PYTEST_FAIL(1), ws: "fp1" });
    await s.bash("pytest", { fail: true, out: PYTEST_FAIL(1), ws: "fp1" });
    expect(s.hitsOf("L1")[0].verified).toBe(true);
    const s2 = new Sim();
    await s2.bash("pytest", { fail: true, out: PYTEST_FAIL(1), ws: "fp1" });
    await s2.bash("pytest", { fail: true, out: PYTEST_FAIL(1), ws: "fp2" }); // shell 之外的改动（外部进程）
    expect(s2.hitsOf("L1")).toHaveLength(0);
  });
  test("无指纹（非 git）→ 推断，verified=false", async () => {
    const s = new Sim();
    await s.bash("pytest", { fail: true, out: PYTEST_FAIL(1), ws: "non-git" });
    await s.bash("pytest", { fail: true, out: PYTEST_FAIL(1), ws: "non-git" });
    expect(s.hitsOf("L1")[0].verified).toBe(false);
  });
  test("中断后重复类计数清零", async () => {
    const s = new Sim();
    await s.bash("pytest", { fail: true, out: PYTEST_FAIL(1) });
    await s.interrupt();
    await s.bash("pytest", { fail: true, out: PYTEST_FAIL(1) });
    expect(s.hitsOf("L1")).toHaveLength(0);
  });
});

describe("L2 / L2a", () => {
  test("同一调用且输出相同 ≥4 次 → M", async () => {
    const s = new Sim();
    for (let i = 0; i < 4; i++) await s.bash("cat build.log", { out: "same" });
    expect(s.hitsOf("L2")).toHaveLength(1);
  });
  test("输出在变（轮询）→ 不报", async () => {
    const s = new Sim();
    for (let i = 0; i < 6; i++) await s.bash("cat build.log", { out: "progress " + i });
    expect(s.hitsOf("L2")).toHaveLength(0);
  });
  test("轮询类白名单 ≥8 次才记 L2a（L 级）", async () => {
    const s = new Sim();
    for (let i = 0; i < 7; i++) await s.bash("git status", { out: "clean" });
    expect(s.hitsOf("L2")).toHaveLength(0);
    expect(s.hitsOf("L2a")).toHaveLength(0);
    await s.bash("git status", { out: "clean" });
    expect(s.hitsOf("L2a")).toHaveLength(1);
    expect(s.hitsOf("L2a")[0].sev).toBe("L");
  });
  test("自适应：judge 连续 ignore 后阈值 ×2", async () => {
    const s = new Sim();
    s.engine.tracker.scale.set("L2", 2);
    for (let i = 0; i < 4; i++) await s.bash("cat x.log", { out: "same" });
    expect(s.hitsOf("L2")).toHaveLength(0);
    for (let i = 0; i < 4; i++) await s.bash("cat x.log", { out: "same" });
    expect(s.hitsOf("L2")).toHaveLength(1);
  });
});

describe("L3 同一错误指纹（不同命令也算）", () => {
  test("10 步内 3 次", async () => {
    const s = new Sim();
    await s.bash("python a.py", { fail: true, out: "Traceback (most recent call last):\n  File \"a.py\", line 3, in f\nKeyError: 'x'" });
    await s.bash("python b.py", { fail: true, out: "Traceback (most recent call last):\n  File \"b.py\", line 9, in f\nKeyError: 'x'" });
    expect(s.hitsOf("L3")).toHaveLength(0);
    await s.bash("python c.py", { fail: true, out: "Traceback (most recent call last):\n  File \"c.py\", line 1, in f\nKeyError: 'x'" });
    expect(s.hitsOf("L3")).toHaveLength(1);
  });
  test("测试工具固定样板相同、错误不同 → 不误报", async () => {
    const s = new Sim();
    for (const err of ["KeyError: 'a'", "TypeError: b", "ValueError: c"]) {
      await s.bash("pytest", { fail: true, out: `=== test session starts ===\nplatform darwin\nrootdir: /x\nE   ${err}\n=== 1 failed ===` });
    }
    expect(s.hitsOf("L3")).toHaveLength(0);
  });
});

describe("L4 振荡", () => {
  test("oscillationReturns", () => {
    expect(oscillationReturns(["a", "b", "a"])).toBe(1);
    expect(oscillationReturns(["a", "b", "a", "b"])).toBe(2);
    expect(oscillationReturns(["a", "a", "a"])).toBe(0);
    expect(oscillationReturns(["a", "b", "c"])).toBe(0);
  });
  test("A→B→A→B：改回去两次 → M", async () => {
    const s = new Sim();
    const f = "/work/proj/src/a.py";
    await s.edit(f, "A", "B");
    await s.edit(f, "B", "A");
    await s.edit(f, "A", "B");
    expect(s.hitsOf("L4")).toHaveLength(1);
    expect(s.hitsOf("L4")[0].sev).toBe("M");
    expect(s.hitsOf("L4")[0].blockable).toBeFalsy(); // 不直接拦截
  });
  test("一直往前改 → 不报", async () => {
    const s = new Sim();
    const f = "/work/proj/src/a.py";
    await s.edit(f, "A", "B");
    await s.edit(f, "B", "C");
    await s.edit(f, "C", "D");
    expect(s.hitsOf("L4")).toHaveLength(0);
  });
});

describe("L5 / L6", () => {
  test("L5：同一文件 4 段编辑、期间没有成功验证 → L；6 段 → M", async () => {
    const s = new Sim();
    const f = "/work/proj/src/a.py";
    for (let i = 0; i < 4; i++) {
      await s.edit(f, `v${i}`, `v${i + 1}`);
      await s.bash("ls", { out: "x" }); // 非编辑动作隔开
    }
    expect(s.hitsOf("L5").map((h) => h.sev)).toEqual(["L"]);
    for (let i = 4; i < 6; i++) {
      await s.edit(f, `v${i}`, `v${i + 1}`);
      await s.bash("ls", { out: "x" });
    }
    expect(s.hitsOf("L5").map((h) => h.sev)).toEqual(["L", "M"]);
  });
  test("L5：连续小 Edit 算同一段，不误报", async () => {
    const s = new Sim();
    const f = "/work/proj/src/a.py";
    for (let i = 0; i < 8; i++) await s.edit(f, `v${i}`, `v${i + 1}`);
    expect(s.hitsOf("L5")).toHaveLength(0);
  });
  test("L5：成功验证后重新计数", async () => {
    const s = new Sim();
    const f = "/work/proj/src/a.py";
    for (let i = 0; i < 3; i++) {
      await s.edit(f, `v${i}`, `v${i + 1}`);
      await s.bash("ls", { out: "x" });
    }
    await s.bash("pytest", { out: PYTEST_PASS });
    for (let i = 3; i < 6; i++) {
      await s.edit(f, `v${i}`, `v${i + 1}`);
      await s.bash("ls", { out: "x" });
    }
    expect(s.hitsOf("L5")).toHaveLength(0);
  });
  test("L6：同一文件读取 ≥3 次且期间没改 → L", async () => {
    const s = new Sim();
    for (let i = 0; i < 3; i++) await s.read("/work/proj/src/a.py");
    expect(s.hitsOf("L6")).toHaveLength(1);
  });
  test("L6：中间改过就重新计数", async () => {
    const s = new Sim();
    await s.read("/work/proj/src/a.py");
    await s.read("/work/proj/src/a.py");
    await s.edit("/work/proj/src/a.py", "a", "b");
    await s.read("/work/proj/src/a.py");
    expect(s.hitsOf("L6")).toHaveLength(0);
  });
});
