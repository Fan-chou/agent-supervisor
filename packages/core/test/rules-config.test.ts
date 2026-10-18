import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { RULES, RULE_IDS, applyOverride, configView, defaultConfig, ruleViews, thresholdsForRule } from "../src/index.ts";

describe("规则目录", () => {
  test("检测器源码里出现的每个 ruleId 都在目录里（目录不会悄悄落后）", () => {
    const dirs = [join(import.meta.dir, "../src/detectors"), join(import.meta.dir, "../src")];
    const ids = new Set<string>();
    for (const dir of dirs) {
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
        const src = readFileSync(join(dir, f), "utf8");
        for (const m of src.matchAll(/ruleId: "([A-Z][A-Za-z0-9]*)"/g)) ids.add(m[1]);
      }
    }
    ids.delete("INTERNAL");
    expect(ids.size).toBeGreaterThan(20);
    for (const id of ids) expect(RULE_IDS, id).toContain(id);
  });
  test("id 唯一；S2 只在回放观察；P2 只对 codex/opencode；X2 是 unsafe / H", () => {
    expect(new Set(RULE_IDS).size).toBe(RULE_IDS.length);
    expect(RULES.find((r) => r.id === "S2")).toMatchObject({ observeOnly: true, level: "observe" });
    expect(RULES.find((r) => r.id === "P2")!.harness).toEqual(["codex", "opencode"]);
    expect(RULES.find((r) => r.id === "X2")).toMatchObject({ category: "unsafe", level: "H" });
  });
  test("阈值来自生效配置：改配置，目录里的阈值跟着变；rules.<ID>.disabled 反映出来；不按模型分档", () => {
    const base = ruleViews(defaultConfig());
    expect(base.find((r) => r.id === "L2")!.thresholds).toEqual(thresholdsForRule("L2", defaultConfig()));
    const cfg = applyOverride(defaultConfig(), "thresholds.L2_repeat=9");
    expect(ruleViews(cfg).find((r) => r.id === "L2")!.thresholds).toMatchObject({ repeat: 9 });
    const cfg2 = { ...defaultConfig(), rules: { S1: { disabled: true } } };
    const s1 = ruleViews(cfg2).find((r) => r.id === "S1")!;
    expect(s1.disabled).toBe(true);
    expect(s1.override).toEqual({ disabled: true });
    expect(base.every((r) => !("model" in r) && !JSON.stringify(r.thresholds).includes("model"))).toBe(true);
  });
});

describe("configView", () => {
  test("api key 只给环境变量名和是否已设置；请求头里的凭据被遮掉；不泄漏密钥值", () => {
    const cfg = defaultConfig();
    cfg.judge.api_key_env = "MY_JUDGE_KEY";
    cfg.judge.request = { headers: { Authorization: "Bearer sk-live-SECRETVALUE1234567890", "x-trace": "abc" }, temperature: 0, api_key: "sk-direct-1234567890" };
    const unset = configView(cfg, {});
    expect(unset.judge).toEqual({ api_key_env: "MY_JUDGE_KEY", api_key_set: false });
    const set = configView(cfg, { MY_JUDGE_KEY: "sk-real-VALUE-should-never-appear" });
    expect(set.judge.api_key_set).toBe(true);
    const s = JSON.stringify(set);
    expect(s).not.toContain("SECRETVALUE");
    expect(s).not.toContain("sk-direct");
    expect(s).not.toContain("sk-real");
    expect(s).toContain("MY_JUDGE_KEY"); // 变量名保留
    const req = (set.config.judge as { request: { headers: Record<string, string>; temperature: number } }).request;
    expect(req.headers.Authorization).toBe("••••");
    expect(req.headers["x-trace"]).toBe("abc");
    expect(req.temperature).toBe(0);
  });
  test("ADVISOR_API_KEY 也算已设置；不修改传入的配置对象", () => {
    const cfg = defaultConfig();
    const before = JSON.stringify(cfg);
    expect(configView(cfg, { ADVISOR_API_KEY: "x" }).judge.api_key_set).toBe(true);
    expect(JSON.stringify(cfg)).toBe(before);
  });
});
