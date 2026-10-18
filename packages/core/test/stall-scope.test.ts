import { describe, expect, test } from "bun:test";
import { PYTEST_FAIL, PYTEST_PASS, Sim } from "./sim.ts";

describe("S1 连续只读", () => {
  test("会话里第一次编辑之前只记 L", async () => {
    const s = new Sim();
    await s.prompt("fix bug");
    for (let i = 0; i < 12; i++) await s.read(`/work/proj/src/f${i}.py`);
    const h = s.hitsOf("S1");
    expect(h).toHaveLength(1);
    expect(h[0].sev).toBe("L");
  });
  test("编辑之后连续 12 步只读 → M", async () => {
    const s = new Sim();
    await s.prompt("fix bug");
    await s.edit("/work/proj/src/a.py", "a", "b");
    for (let i = 0; i < 12; i++) await s.grep(`pat${i}`);
    const h = s.hitsOf("S1");
    expect(h).toHaveLength(1);
    expect(h[0].sev).toBe("M");
  });
  test("中间有测试运行 → 重置", async () => {
    const s = new Sim();
    await s.prompt("x");
    for (let i = 0; i < 8; i++) await s.read(`/work/proj/f${i}.py`);
    await s.bash("pytest", { out: PYTEST_PASS });
    for (let i = 0; i < 8; i++) await s.read(`/work/proj/g${i}.py`);
    expect(s.hitsOf("S1")).toHaveLength(0);
  });
  test("只读 shell（ls/git status）也算只读；TodoWrite 不打断", async () => {
    const s = new Sim();
    await s.prompt("x");
    for (let i = 0; i < 6; i++) await s.bash(`ls dir${i}`, { out: "a" });
    await s.todo([["a", "in_progress"]]);
    for (let i = 0; i < 6; i++) await s.bash(`git log -${i + 1}`, { out: "c" + i });
    expect(s.hitsOf("S1")).toHaveLength(1);
  });
});

describe("S2 观察 / S3 / S4", () => {
  test("S2 observeOnly", async () => {
    const s = new Sim();
    await s.prompt("x");
    for (let i = 0; i < 7; i++) await s.read(`/work/proj/f${i}.py`);
    const h = s.hitsOf("S2");
    expect(h).toHaveLength(1);
    expect(h[0].observeOnly).toBe(true);
    expect(s.decisionsOf("S2")[0].action).toBe("log");
  });
  test("S3：距上次成功编辑 ≥8 分钟且 ≥10 次调用", async () => {
    const s = new Sim({ dt: 1000 });
    await s.prompt("x");
    await s.edit("/work/proj/a.py", "a", "b");
    for (let i = 0; i < 10; i++) await s.bash(`echo ${i} > /tmp/x${i}`, { out: "", dt: 60_000 });
    expect(s.hitsOf("S3").length).toBeGreaterThanOrEqual(1);
    // 边沿触发：不会每一步都报
    expect(s.hitsOf("S3").length).toBe(1);
  });
  test("S3：时间不够 → 不报", async () => {
    const s = new Sim({ dt: 1000 });
    await s.edit("/work/proj/a.py", "a", "b");
    for (let i = 0; i < 12; i++) await s.bash(`ls ${i}`, { out: "x" });
    expect(s.hitsOf("S3")).toHaveLength(0);
  });
  test("S3：pending 的调用不算", async () => {
    const s = new Sim({ dt: 1000 });
    await s.edit("/work/proj/a.py", "a", "b");
    for (let i = 0; i < 12; i++) await s.bash(`sleep 100 ${i}`, { pending: true, dt: 60_000 });
    expect(s.hitsOf("S3")).toHaveLength(0);
  });
  test("S4：自上次真实用户消息起 ≥15 个子 agent", async () => {
    const s = new Sim();
    await s.prompt("big task");
    for (let i = 0; i < 15; i++) await s.call("Task", { description: `t${i}` }, { out: "result text that is long enough" });
    expect(s.hitsOf("S4")).toHaveLength(1);
  });
  test("S4：supervisor 回显的 prompt 不重置本轮", async () => {
    const s = new Sim();
    await s.prompt("big task");
    for (let i = 0; i < 10; i++) await s.call("Task", { description: `t${i}` }, { out: "result text that is long enough" });
    await s.prompt("请先确认当前做法是否仍在推进任务。", "supervisor");
    for (let i = 10; i < 15; i++) await s.call("Task", { description: `t${i}` }, { out: "result text that is long enough" });
    expect(s.hitsOf("S4")).toHaveLength(1);
  });
  test("S4：3 个连续没有产出的子 agent", async () => {
    const s = new Sim();
    await s.prompt("x");
    for (let i = 0; i < 3; i++) await s.call("Task", { description: `t${i}` }, { out: "" });
    expect(s.hitsOf("S4")).toHaveLength(1);
  });
});

describe("P1 范围（计划来源）", () => {
  test("plan.md 写了 allow → H、blockable、explicit，不问 judge", async () => {
    const s = new Sim({ planMd: "# 修复登录\n- [ ] 修登录 allow: src/auth/**\n" });
    const [pre] = await s.edit("/work/proj/src/billing/x.py", "a", "b");
    const h = pre.hits.find((x) => x.ruleId === "P1");
    expect(h?.sev).toBe("H");
    expect(h?.explicit).toBe(true);
    expect(h?.blockable).toBe(true);
    const d = pre.decisions.find((x) => x.hit.ruleId === "P1");
    expect(d?.action).toBe("block");
    expect(d?.reason).toContain("不受连续拦截上限约束");
  });
  test("在 allow 范围内 → 不报；不做子串匹配", async () => {
    const s = new Sim({ planMd: "- [ ] 修登录\nallow: src/auth/**, tests/auth\n" });
    await s.edit("/work/proj/src/auth/login.py", "a", "b");
    await s.edit("/work/proj/tests/auth/test_login.py", "a", "b");
    expect(s.hitsOf("P1")).toHaveLength(0);
    await s.edit("/work/proj/src/authz/other.py", "a", "b"); // "auth" 是子串，但不在 glob 里
    expect(s.hitsOf("P1")).toHaveLength(1);
  });
  test("自动提取的计划：只 M、不拦截", async () => {
    const s = new Sim();
    await s.todo([["修改 src/auth/login.py 里的校验", "in_progress"], ["补测试", "pending"]]);
    const [pre] = await s.edit("/work/proj/src/billing/x.py", "a", "b");
    const h = pre.hits.find((x) => x.ruleId === "P1");
    expect(h?.sev).toBe("M");
    expect(h?.blockable).toBeFalsy();
    expect(h?.explicit).toBe(false);
  });
  test("自动计划：这一步读过的文件也允许", async () => {
    const s = new Sim();
    await s.todo([["修改 src/auth/login.py 里的校验", "in_progress"]]);
    await s.read("/work/proj/src/auth/helpers.py");
    await s.edit("/work/proj/src/auth/helpers.py", "a", "b");
    expect(s.hitsOf("P1")).toHaveLength(0);
  });
  test("两样都没有 → P1/P4 自动停用", async () => {
    const s = new Sim();
    await s.edit("/work/proj/anything.py", "a", "b");
    expect(s.hitsOf("P1")).toHaveLength(0);
    expect(s.hitsOf("P4")).toHaveLength(0);
  });
  test("步骤文本里没有路径 → 自动提取不可靠，不报", async () => {
    const s = new Sim();
    await s.todo([["让登录更稳", "in_progress"]]);
    await s.edit("/work/proj/anything.py", "a", "b");
    expect(s.hitsOf("P1")).toHaveLength(0);
  });
  test("plan.md 优先于自动提取", async () => {
    const s = new Sim({ planMd: "- [ ] x\nallow: src/only/**\n" });
    await s.todo([["改 src/other/a.py", "in_progress"]]);
    await s.edit("/work/proj/src/other/a.py", "a", "b");
    expect(s.hitsOf("P1")[0].explicit).toBe(true);
  });
});

describe("P2–P6", () => {
  test("P2：Codex 没读就改 → L；Claude 不生效；新建文件豁免", async () => {
    const c = new Sim({ harness: "codex" });
    await c.edit("/work/proj/src/a.py", "a", "b");
    expect(c.hitsOf("P2")).toHaveLength(1);
    const c2 = new Sim({ harness: "codex" });
    await c2.read("/work/proj/src/a.py");
    await c2.edit("/work/proj/src/a.py", "a", "b");
    expect(c2.hitsOf("P2")).toHaveLength(0);
    const cl = new Sim({ harness: "claude" });
    await cl.edit("/work/proj/src/a.py", "a", "b");
    expect(cl.hitsOf("P2")).toHaveLength(0);
  });
  test("P3：声称完成但最后一次编辑之后没跑过测试 → M，Stop 可拦", async () => {
    const s = new Sim();
    await s.prompt("fix");
    await s.edit("/work/proj/src/a.py", "a", "b");
    const r = await s.stop();
    const h = r.hits.find((x) => x.ruleId === "P3");
    expect(h?.sev).toBe("M");
    expect(h?.blockable).toBe(true);
  });
  test("P3：编辑后跑过 targeted 测试 → 不报；只改文档 → 不报", async () => {
    const s = new Sim();
    await s.edit("/work/proj/src/a.py", "a", "b");
    await s.bash("pytest tests/test_a.py", { out: PYTEST_PASS });
    expect((await s.stop()).hits.some((x) => x.ruleId === "P3")).toBe(false);
    const d = new Sim();
    await d.edit("/work/proj/README.md", "a", "b");
    expect((await d.stop()).hits.some((x) => x.ruleId === "P3")).toBe(false);
  });
  test("P3：测试失败了也算「跑过」", async () => {
    const s = new Sim();
    await s.edit("/work/proj/src/a.py", "a", "b");
    await s.bash("pytest", { fail: true, out: PYTEST_FAIL() });
    expect((await s.stop()).hits.some((x) => x.ruleId === "P3")).toBe(false);
  });
  test("P4：有计划时每 8 次编辑抽查", async () => {
    const s = new Sim();
    await s.todo([["改 src/a.py", "in_progress"]]);
    for (let i = 0; i < 8; i++) await s.edit("/work/proj/src/a.py", `v${i}`, `v${i + 1}`);
    expect(s.hitsOf("P4")).toHaveLength(1);
  });
  test("P5：新增依赖，计划没提 → M；计划提了 → L", async () => {
    const s = new Sim();
    await s.todo([["改 src/a.py", "in_progress"]]);
    await s.bash("npm install left-pad", { out: "added 1 package" });
    expect(s.hitsOf("P5")[0].sev).toBe("M");
    const s2 = new Sim();
    await s2.todo([["安装依赖 left-pad 并改 src/a.py", "in_progress"]]);
    await s2.bash("npm install left-pad", { out: "added 1 package" });
    expect(s2.hitsOf("P5")[0].sev).toBe("L");
    const s3 = new Sim();
    await s3.edit("/work/proj/package.json", "a", "b");
    expect(s3.hitsOf("P5")[0].sev).toBe("L"); // 没有计划：只记 L
  });
  test("P5：lockfile 自己的改动不报", async () => {
    const s = new Sim();
    await s.edit("/work/proj/pnpm-lock.yaml", "a", "b");
    expect(s.hitsOf("P5")).toHaveLength(0);
  });
  test("P6：净删除 ≥200 行 / 删除整个文件", async () => {
    const s = new Sim();
    const big = Array.from({ length: 250 }, (_, i) => `line ${i}`).join("\n");
    await s.edit("/work/proj/src/a.py", big, "x");
    expect(s.hitsOf("P6")).toHaveLength(1);
    const s2 = new Sim();
    await s2.bash("rm src/old.py", { out: "" });
    expect(s2.hitsOf("P6")).toHaveLength(1);
    const s3 = new Sim();
    await s3.bash("rm -rf dist", { out: "" });
    expect(s3.hitsOf("P6")).toHaveLength(0);
  });
});

describe("R", () => {
  test("R1：自上次用户消息起 ≥50 次调用", async () => {
    const s = new Sim();
    await s.prompt("go");
    for (let i = 0; i < 50; i++) await s.bash(`echo ${i}`, { out: String(i) });
    expect(s.hitsOf("R1")).toHaveLength(1);
  });
  test("R1：新的用户消息重置", async () => {
    const s = new Sim();
    await s.prompt("go");
    for (let i = 0; i < 30; i++) await s.bash(`echo ${i}`, { out: String(i) });
    await s.prompt("go on");
    for (let i = 0; i < 30; i++) await s.bash(`echo b${i}`, { out: "b" + i });
    expect(s.hitsOf("R1")).toHaveLength(0);
  });
  test("R4：连续 20 步没有其他触发 → 抽查", async () => {
    const s = new Sim();
    await s.prompt("go");
    for (let i = 0; i < 20; i++) await s.bash(`echo ${i}`, { out: "o" + i });
    expect(s.hitsOf("R4")).toHaveLength(1);
  });
});
