import { describe, expect, test } from "bun:test";
import { applyRuleEdits, configView, defaultConfig, validateConfigDraft, type RuleEdits } from "../src/index.ts";

const cur = () => defaultConfig();

describe("validateConfigDraft", () => {
  test("合法草稿：valid、diff 只列会变的叶子、不修改当前配置", () => {
    const c = cur();
    const before = JSON.stringify(c);
    const r = validateConfigDraft("thresholds:\n  L2_repeat: 5\nbudgets:\n  judge_cooldown_s: 90\n", c);
    expect(r).toMatchObject({ valid: true, errors: [], enablesBlocking: false });
    expect(r.diff).toEqual([
      { path: "budgets.judge_cooldown_s", from: 60, to: 90 },
      { path: "thresholds.L2_repeat", from: 4, to: 5 },
    ]);
    expect(JSON.stringify(c)).toBe(before);
  });
  test("空草稿 = 没有变化；只有注释也一样", () => {
    expect(validateConfigDraft("", cur())).toMatchObject({ valid: true, diff: [] });
    expect(validateConfigDraft("# 只有注释\n", cur())).toMatchObject({ valid: true, diff: [] });
  });
  test("mode=enforce：enablesBlocking=true 并有警告；当前已经是 enforce 则不再提示", () => {
    const r = validateConfigDraft("mode: enforce\n", cur());
    expect(r).toMatchObject({ valid: true, enablesBlocking: true });
    expect(r.warnings.join("")).toContain("enforce");
    expect(r.diff).toEqual([{ path: "mode", from: "shadow", to: "enforce" }]);
    const enforced = { ...cur(), mode: "enforce" as const };
    expect(validateConfigDraft("mode: enforce\n", enforced).enablesBlocking).toBe(false);
  });
  test("错误：YAML 语法、顶层不是对象、mode 取值、类型不符、负数、base_url 非法、数字写成字符串", () => {
    expect(validateConfigDraft("a: [unclosed", cur())).toMatchObject({ valid: false });
    expect(validateConfigDraft("- 1\n- 2\n", cur()).errors[0]).toContain("顶层");
    expect(validateConfigDraft("mode: yolo\n", cur()).errors.join()).toContain("mode");
    expect(validateConfigDraft("thresholds:\n  L2_repeat: many\n", cur()).errors.join()).toContain("thresholds.L2_repeat");
    expect(validateConfigDraft("budgets:\n  judge_cooldown_s: -5\n", cur()).errors.join()).toContain("负数");
    expect(validateConfigDraft("judge:\n  base_url: not a url\n", cur()).errors.join()).toContain("judge.base_url");
    expect(validateConfigDraft("judge:\n  base_url: ftp://x.example/\n", cur()).errors.join()).toContain("http");
    expect(validateConfigDraft("log:\n  retention_days: \"14\"\n", cur()).valid).toBe(false);
    expect(validateConfigDraft("judge:\n  enabled: yes-please\n", cur()).errors.join()).toContain("true 或 false");
    for (const bad of ["a: [unclosed", "mode: yolo\n"]) expect(validateConfigDraft(bad, cur()).diff).toEqual([]); // 无效时不给 diff
  });
  test("警告（不阻止 valid）：未知顶层段、未知嵌套键、judge 指向非本机、关闭 X2", () => {
    const r = validateConfigDraft("bogus: 1\nthresholds:\n  L2_repeet: 3\njudge:\n  base_url: https://api.example.com/v1\nrules:\n  X2_dangerous: { action: off }\n", cur());
    expect(r.valid).toBe(true);
    const w = r.warnings.join("\n");
    expect(w).toContain("未知配置段 bogus");
    expect(w).toContain("thresholds.L2_repeet");
    expect(w).toContain("api.example.com");
    expect(w).toContain("关闭 X2");
  });
  test("规则覆盖、judge.request、harness 这类开放映射里的键不报未知；T 阶梯可以新增级别", () => {
    const r = validateConfigDraft("rules:\n  S2_phase_stall: { mode: replay_only }\njudge:\n  request: { temperature: 0.2, top_p: 1 }\nharness:\n  opencode: { enabled: false }\nthresholds:\n  T3: { advise: 1, H: 4 }\n", cur());
    expect(r).toMatchObject({ valid: true, warnings: [] });
  });
  test("diff 里的凭据被遮掉；草稿太大被拒", () => {
    const r = validateConfigDraft("judge:\n  request:\n    api_key: sk-leak-1234567890\n", cur());
    expect(JSON.stringify(r)).not.toContain("sk-leak");
    expect(r.diff.some((d) => d.path === "judge.request.api_key" && d.to === "••••")).toBe(true);
    expect(validateConfigDraft("x: " + "a".repeat(70_000), cur())).toMatchObject({ valid: false });
  });
  test("别名：rules.T1_rerun_unchanged.block_on 会改 thresholds.T1.H，diff 里能看到", () => {
    const r = validateConfigDraft("rules:\n  T1_rerun_unchanged: { block_on: 4 }\n", cur());
    expect(r.diff.map((d) => d.path)).toContain("thresholds.T1.H");
  });
});

describe("configView.sources", () => {
  test("default / configured / rules.local 三种来源；凭据值遮掉但来源可见", () => {
    const def = defaultConfig();
    const base = defaultConfig();
    base.thresholds.L3_repeat = 5; // 启动配置改过
    base.judge.request = { headers: { Authorization: "Bearer sk-zzzzzzzzzzzzzzzz" } };
    const edits: RuleEdits = { L2: { set: { "thresholds.L2_repeat": 6 } } };
    const eff = applyRuleEdits(base, edits);
    const v = configView(eff, {}, base);
    expect(v.sources["mode"]).toBe("default");
    expect(v.sources["thresholds.L3_repeat"]).toBe("configured");
    expect(v.sources["thresholds.L2_repeat"]).toBe("rules.local");
    expect(v.sources["judge.request.headers.Authorization"]).toBe("configured");
    expect(JSON.stringify(v)).not.toContain("sk-zzzz");
    expect(def.thresholds.L3_repeat).toBe(3);
  });
  test("没有传 base 时：与默认不同的算 configured，其余 default", () => {
    const c = defaultConfig();
    c.mode = "advise";
    const v = configView(c, {});
    expect(v.sources["mode"]).toBe("configured");
    expect(v.sources["budgets.judge_cooldown_s"]).toBe("default");
  });
});
