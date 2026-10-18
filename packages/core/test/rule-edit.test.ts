import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTECTED_RULES, RULE_IDS, RULE_THRESHOLD_PATHS, applyRuleEdits, defaultConfig, loadRuleEdits, ruleViews, saveRuleEdits, thresholdsForRule, validateRuleEdit, type RuleEdits } from "../src/index.ts";

const base = () => defaultConfig();
const ok = (r: ReturnType<typeof validateRuleEdit>) => {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r;
};
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("规则编辑：映射表与目录一致", () => {
  test("每个可编辑键都在 thresholdsForRule 的输出里，且路径在默认配置里真实存在（不会写出不存在的路径）", () => {
    const cfg = base();
    for (const [id, keys] of Object.entries(RULE_THRESHOLD_PATHS)) {
      expect(RULE_IDS, id).toContain(id);
      const shown = thresholdsForRule(id, cfg);
      for (const [k, spec] of Object.entries(keys)) {
        expect(Object.keys(shown), `${id}.${k}`).toContain(k);
        const v = spec.path.split(".").reduce<any>((o, p) => o?.[p], cfg);
        expect(typeof v, `${id}.${k} → ${spec.path}`).toBe("number");
      }
    }
  });
});

describe("validateRuleEdit", () => {
  test("改一条规则的阈值：生效配置变了，别的规则不变，原配置对象不被修改", () => {
    const b = base();
    const before = JSON.stringify(b);
    const r = ok(validateRuleEdit(b, {}, "L2", { thresholds: { repeat: 6 } }));
    expect(r.cfg.thresholds.L2_repeat).toBe(6);
    expect(r.cfg.thresholds.L3_repeat).toBe(b.thresholds.L3_repeat);
    expect(r.edits).toEqual({ L2: { set: { "thresholds.L2_repeat": 6 } } });
    expect(r.changes).toEqual([{ what: "thresholds", from: { repeat: 4, window_steps: 12 }, to: { repeat: 6, window_steps: 12 } }]);
    expect(JSON.stringify(b)).toBe(before);
  });
  test("停用 / 启用；停用后规则视图 disabled=true；规则键沿用配置里已有的 id_ 前缀键", () => {
    const b = base();
    b.rules = { ...b.rules, S2_phase_stall: { mode: "replay_only" } };
    const r = ok(validateRuleEdit(b, {}, "S2", { disabled: true }));
    expect(r.cfg.rules.S2_phase_stall).toEqual({ mode: "replay_only", disabled: true });
    expect(r.cfg.rules.S2).toBeUndefined();
    expect(ruleViews(r.cfg).find((x) => x.id === "S2")!.disabled).toBe(true);
    const r2 = ok(validateRuleEdit(b, r.edits, "S2", { disabled: false }));
    expect(ruleViews(r2.cfg).find((x) => x.id === "S2")!.disabled).toBe(false);
  });
  test("启动配置里 action: off 的规则不能从界面重新启用（409）", () => {
    const b = base();
    b.rules = { ...b.rules, S1_x: { action: "off" } };
    const r = validateRuleEdit(b, {}, "S1", { disabled: false });
    expect(r).toMatchObject({ ok: false, status: 409, code: "disabled_by_config" });
  });
  test("reset：删除该规则的覆盖，回到启动配置；其他规则的覆盖保留", () => {
    const b = base();
    let edits: RuleEdits = ok(validateRuleEdit(b, {}, "L2", { thresholds: { repeat: 6 } })).edits;
    edits = ok(validateRuleEdit(b, edits, "L3", { disabled: true })).edits;
    const r = ok(validateRuleEdit(b, edits, "L2", { reset: true }));
    expect(Object.keys(r.edits)).toEqual(["L3"]);
    expect(r.cfg.thresholds.L2_repeat).toBe(b.thresholds.L2_repeat);
    expect(ruleViews(r.cfg).find((x) => x.id === "L3")!.disabled).toBe(true);
  });
  test("T 阶梯：写成 {ladder:{…}}；只能改已有级别；必须单调", () => {
    const b = base();
    const r = ok(validateRuleEdit(b, {}, "T2", { thresholds: { ladder: { advise: 4, M: 8 } } }));
    expect(r.cfg.thresholds.T2).toEqual({ advise: 4, M: 8 });
    expect(validateRuleEdit(b, {}, "T2", { thresholds: { ladder: { H: 9 } } })).toMatchObject({ ok: false, code: "invalid_threshold" }); // T2 没有 H 级，不能新增
    expect(validateRuleEdit(b, {}, "T2", { thresholds: { ladder: { advise: 9 } } })).toMatchObject({ ok: false, code: "inconsistent_thresholds" }); // advise 9 > M 5
    expect(validateRuleEdit(b, {}, "T2", { thresholds: { advise: 4 } })).toMatchObject({ ok: false, code: "bad_request" }); // 缺 ladder 包装
    expect(validateRuleEdit(b, {}, "T2", { thresholds: { ladder: { bogus: 1 } } })).toMatchObject({ ok: false, code: "invalid_threshold" });
  });
  test("取值校验：非数字 / NaN / 字符串 / 小数计数 / 0 / 负数 / 比例越界都拒绝，并说明原因", () => {
    const b = base();
    for (const v of ["5", null, Number.NaN, Infinity, 2.5, 0, -1, 2_000_000, true, [1]]) {
      const r = validateRuleEdit(b, {}, "L2", { thresholds: { repeat: v } });
      expect(r, String(v)).toMatchObject({ ok: false, status: 400, code: "invalid_threshold" });
    }
    expect(validateRuleEdit(b, {}, "R3", { thresholds: { ratio: 1.5 } })).toMatchObject({ ok: false, code: "invalid_threshold" });
    expect(validateRuleEdit(b, {}, "R3", { thresholds: { ratio: 0 } })).toMatchObject({ ok: false });
    expect(ok(validateRuleEdit(b, {}, "R3", { thresholds: { ratio: 0.9 } })).cfg.thresholds.R3_ratio).toBe(0.9);
    const bad = validateRuleEdit(b, {}, "L2", { thresholds: { repeat: 0 } });
    expect(bad.ok === false && bad.errors[0]).toContain("repeat");
  });
  test("未知键 / 只读键（L2a 的 window_steps 与 L2 共用）/ 没有可编辑阈值的规则 / 未知字段 / 空编辑 / 错误类型 → 400；未知规则 404", () => {
    const b = base();
    expect(validateRuleEdit(b, {}, "L2", { thresholds: { nope: 1 } })).toMatchObject({ ok: false, code: "invalid_threshold" });
    expect(validateRuleEdit(b, {}, "L2a", { thresholds: { window_steps: 3 } })).toMatchObject({ ok: false, code: "invalid_threshold" });
    expect(validateRuleEdit(b, {}, "P1", { thresholds: { x: 1 } })).toMatchObject({ ok: false, code: "no_editable_thresholds" });
    expect(validateRuleEdit(b, {}, "L2", { mode: "enforce" })).toMatchObject({ ok: false, code: "unknown_field" });
    expect(validateRuleEdit(b, {}, "L2", { action: "block" })).toMatchObject({ ok: false, code: "unknown_field" });
    expect(validateRuleEdit(b, {}, "L2", {})).toMatchObject({ ok: false, code: "empty_edit" });
    expect(validateRuleEdit(b, {}, "L2", { disabled: "yes" })).toMatchObject({ ok: false, code: "bad_request" });
    expect(validateRuleEdit(b, {}, "L2", { thresholds: [1] })).toMatchObject({ ok: false, code: "bad_request" });
    expect(validateRuleEdit(b, {}, "L2", { reset: true, disabled: true })).toMatchObject({ ok: false, code: "bad_request" });
    expect(validateRuleEdit(b, {}, "L2", "x")).toMatchObject({ ok: false, code: "bad_request" });
    expect(validateRuleEdit(b, {}, "ZZ", { disabled: true })).toMatchObject({ ok: false, status: 404, code: "unknown_rule" });
  });
  test("X2 受保护：不能停用、不能改阈值、不能 reset（403）；就算覆盖文件里有 X2 的记录也不会生效", () => {
    const b = base();
    expect(PROTECTED_RULES.has("X2")).toBe(true);
    for (const body of [{ disabled: true }, { thresholds: { x: 1 } }, { reset: true }]) expect(validateRuleEdit(b, {}, "X2", body)).toMatchObject({ ok: false, status: 403, code: "protected_rule" });
    const cfg = applyRuleEdits(b, { X2: { disabled: true } });
    expect(cfg.rules.X2_dangerous).toEqual(b.rules.X2_dangerous);
    expect(JSON.stringify(cfg.rules)).not.toContain("disabled");
  });
  test("跨字段一致：L5 的 segments_L 不能超过 segments_M；R2 的 L 必须小于 M", () => {
    const b = base();
    expect(validateRuleEdit(b, {}, "L5", { thresholds: { segments_L: 99 } })).toMatchObject({ ok: false, code: "inconsistent_thresholds" });
    expect(ok(validateRuleEdit(b, {}, "L5", { thresholds: { segments_L: 3, segments_M: 9 } })).cfg.detect.l5_segments_M).toBe(9);
    expect(validateRuleEdit(b, {}, "R2", { thresholds: { L: 1 } })).toMatchObject({ ok: false, code: "inconsistent_thresholds" });
  });
  test("不能借规则编辑改 mode / judge / 预算 / 日志：任何编辑后这些段与启动配置完全相同", () => {
    const b = base();
    let edits: RuleEdits = {};
    for (const [id, body] of [["L2", { thresholds: { repeat: 9 } }], ["S1", { disabled: true }], ["T1", { thresholds: { ladder: { advise: 5, H: 9 } } }], ["R3", { thresholds: { ratio: 0.5, context_window: 1000 } }]] as const) edits = ok(validateRuleEdit(b, edits, id, body)).edits;
    const cfg = applyRuleEdits(b, edits);
    for (const k of ["mode", "judge", "budgets", "log", "harness", "runtime", "plan", "test"] as const) expect(cfg[k], k).toEqual(b[k]);
  });
  test("规则不分模型：目录和可编辑键里没有模型相关的东西", () => {
    expect(JSON.stringify(RULE_THRESHOLD_PATHS)).not.toMatch(/model/i);
  });
});

describe("落盘", () => {
  test("saveRuleEdits：原子写、0600；loadRuleEdits 读回相同；不存在 → 空；损坏 → 空 + warning；脏数据被清洗", () => {
    const dir = mkdtempSync(join(tmpdir(), "sv-re-"));
    dirs.push(dir);
    const p = join(dir, "rules.local.json");
    expect(loadRuleEdits(p)).toEqual({ edits: {} });
    const edits: RuleEdits = { L2: { set: { "thresholds.L2_repeat": 6 } }, S1: { disabled: true } };
    saveRuleEdits(p, edits);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["rules.local.json"]); // 没有残留临时文件
    expect(loadRuleEdits(p)).toEqual({ edits });
    writeFileSync(p, "{not json");
    expect(loadRuleEdits(p).warning).toContain("已忽略");
    writeFileSync(p, JSON.stringify({ version: 2, edits: {} }));
    expect(loadRuleEdits(p).warning).toContain("格式不对");
    writeFileSync(p, JSON.stringify({ version: 1, edits: { X2: { disabled: true }, ZZ: { disabled: true }, L2: { set: { "thresholds.L2_repeat": "x", a: 3 }, disabled: "no" } } }));
    expect(loadRuleEdits(p).edits).toEqual({ L2: { set: { a: 3 } } });
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, "utf8")).toContain("version");
  });
  test("applyRuleEdits：过期路径被跳过，不抛异常", () => {
    const cfg = applyRuleEdits(base(), { L2: { set: { "thresholds.gone": 3, "thresholds.L2_repeat": 7 } } });
    expect(cfg.thresholds.L2_repeat).toBe(7);
  });
});
