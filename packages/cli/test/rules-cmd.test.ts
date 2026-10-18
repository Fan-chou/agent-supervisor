import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, loadRuleEdits } from "@sv/core";
import { runRules } from "../src/rules-cmd.ts";
import { main } from "../src/sv.ts";

const dirs: string[] = [];
const mk = () => {
  const d = mkdtempSync(join(tmpdir(), "sv-rc-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const run = (home: string, pos: string[], flags: Record<string, unknown> = {}) => runRules(pos, { home, ...flags } as never, defaultConfig());

describe("sv rules", () => {
  test("set：写 rules.local.json（0600），输出变更；show 反映；reset 删除", () => {
    const home = mk();
    const r = run(home, ["set", "L2"], { threshold: ["repeat=6"] });
    expect(r.code).toBe(0);
    expect(r.lines.join("\n")).toContain('"repeat":6');
    expect(statSync(join(home, "rules.local.json")).mode & 0o777).toBe(0o600);
    expect(loadRuleEdits(join(home, "rules.local.json")).edits).toEqual({ L2: { set: { "thresholds.L2_repeat": 6 } } });
    expect(run(home, ["show"]).lines.join("\n")).toMatch(/L2\s+\[已编辑\] \{"repeat":6/);
    expect(run(home, ["set", "S1"], { disable: true }).code).toBe(0);
    expect(run(home, ["show"]).lines.join("\n")).toMatch(/S1\s+\[已停用\]/);
    expect(run(home, ["reset", "L2"]).code).toBe(0);
    expect(Object.keys(loadRuleEdits(join(home, "rules.local.json")).edits)).toEqual(["S1"]);
    expect(run(home, ["set", "S1"], { enable: true }).code).toBe(0);
  });
  test("T 阶梯：--set ladder.advise=4；非单调 / 新增级别 / 非数字 都被拒绝，文件不变", () => {
    const home = mk();
    expect(run(home, ["set", "T2"], { threshold: ["ladder.advise=4", "ladder.M=8"] }).code).toBe(0);
    const before = readFileSync(join(home, "rules.local.json"), "utf8");
    for (const sets of [["ladder.advise=99"], ["ladder.H=9"], ["ladder.advise=abc"], ["repeat=1"]]) {
      const r = run(home, ["set", "T2"], { threshold: sets });
      expect(r.code, sets.join()).toBe(1);
      expect(r.lines.join("\n")).toContain("拒绝");
    }
    expect(readFileSync(join(home, "rules.local.json"), "utf8")).toBe(before);
  });
  test("与 API 同一套校验：X2 受保护；未知规则；未知键；--disable 与 --enable 冲突；用法错误 → 2", () => {
    const home = mk();
    expect(run(home, ["set", "X2"], { disable: true })).toMatchObject({ code: 1 });
    expect(run(home, ["set", "ZZ"], { disable: true }).lines.join("")).toContain("unknown_rule");
    expect(run(home, ["set", "L2"], { threshold: ["nope=1"] }).code).toBe(1);
    expect(run(home, ["set", "L2"], { disable: true, enable: true }).code).toBe(2);
    expect(run(home, ["set", "L2"], { threshold: ["no-equals"] }).code).toBe(2);
    expect(run(home, ["bogus"]).code).toBe(2);
    expect(run(home, ["set"]).code).toBe(2);
    expect(existsSync(join(home, "rules.local.json"))).toBe(false);
  });
  test("损坏的覆盖文件：show/set 带警告继续（把它当成空）", () => {
    const home = mk();
    Bun.write(join(home, "rules.local.json"), "{oops");
    const r = run(home, ["show"]);
    expect(r.code).toBe(0);
    expect(r.lines[0]).toContain("警告");
  });
  test("CLI 接线：main(['rules', …])", async () => {
    const home = mk();
    const logs: string[] = [];
    const orig = { log: console.log, err: console.error };
    console.log = (...a: unknown[]) => void logs.push(a.join(" "));
    console.error = (...a: unknown[]) => void logs.push(a.join(" "));
    try {
      expect(await main(["rules", "set", "L3", "--threshold", "repeat=5", "--home", home])).toBe(0);
      expect(await main(["rules", "set", "X2", "--disable", "--home", home])).toBe(1);
      expect(await main(["rules", "show", "--home", home])).toBe(0);
    } finally {
      console.log = orig.log;
      console.error = orig.err;
    }
    expect(loadRuleEdits(join(home, "rules.local.json")).edits).toEqual({ L3: { set: { "thresholds.L3_repeat": 5 } } });
  });
});
