import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogStore } from "@sv/core";
import { main, parseArgs } from "../src/sv.ts";
import { parseSince } from "../src/stats.ts";

const ROOT = join(import.meta.dir, "../../..");
const FX = join(ROOT, "test/fixtures");
const dir = mkdtempSync(join(tmpdir(), "sv-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const DB = join(dir, "state.db");

async function run(args: string[]) {
  const out: string[] = [];
  const o1 = console.log;
  const o2 = console.error;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void out.push(a.join(" "));
  try {
    return { code: await main(args), out: out.join("\n") };
  } finally {
    console.log = o1;
    console.error = o2;
  }
}

describe("参数解析", () => {
  test("--set 可重复；--log 的值可选", () => {
    const a = parseArgs(["replay", "x", "--set", "thresholds.T1.H=4", "--set=budgets.judge_cooldown_s=30", "--log", "--label", "foo"]);
    expect(a.flags.set).toEqual(["thresholds.T1.H=4", "budgets.judge_cooldown_s=30"]);
    expect(a.flags.log).toBe(true);
    expect(a.flags.label).toBe("foo");
    expect(parseArgs(["replay", "x", "--log", "/tmp/a.db"]).flags.log).toBe("/tmp/a.db");
    expect(parseArgs(["replay", "dir/sub", "--log"]).pos).toEqual(["replay", "dir/sub"]);
  });
  test("parseSince", () => {
    const now = 1_000_000_000_000;
    expect(parseSince("7d", now)).toBe(now - 7 * 86_400_000);
    expect(parseSince("2h", now)).toBe(now - 2 * 3_600_000);
    expect(parseSince("2026-10-01")).toBe(Date.parse("2026-10-01"));
    expect(() => parseSince("yesterday")).toThrow();
  });
});

describe("replay --log / --label / --set → sv stats", () => {
  test("两次回放（不同阈值）写入同一个库，stats 能看到、能对比", async () => {
    const a = await run(["replay", FX, "--judge=mock", "--log", DB, "--label", "base"]);
    expect(a.code).toBe(0);
    expect(a.out).toContain("已写入日志：run 1（base）");
    const b = await run(["replay", FX, "--judge=mock", "--log", DB, "--label", "t1h5", "--set", "thresholds.T1.H=5", "--set", "thresholds.full_tests_per_turn=2"]);
    expect(b.out).toContain("run 2（t1h5）");
    expect(existsSync(DB)).toBe(true);

    const runs = await run(["stats", "--db", DB, "--by", "runs"]);
    expect(runs.out).toContain("base");
    expect(runs.out).toContain("thresholds.T1.H=5");

    const rules = await run(["stats", "--db", DB, "--run", "1", "--format", "json"]);
    const rows = JSON.parse(rules.out) as { rule: string; hits: number }[];
    expect(rows.find((r) => r.rule === "L1")?.hits).toBeGreaterThan(0);
    const byLabel = await run(["stats", "--db", DB, "--label", "t1h5", "--format", "csv"]);
    expect(byLabel.out.split("\n")[0]).toContain("rule,hits,sessions");

    const cmp = await run(["stats", "--db", DB, "--compare", "1,2"]);
    expect(cmp.out).toContain("对比 run 1 → run 2");
    expect(cmp.out).toMatch(/TB\s+\d+\s+\d+/);

    for (const by of ["model", "judge", "session"]) {
      const r = await run(["stats", "--db", DB, "--by", by]);
      expect(r.code).toBe(0);
    }
    expect((await run(["stats", "--db", DB, "--by", "nope"])).code).toBe(2);
    expect((await run(["stats", "--db", DB, "--label", "no-such"])).code).toBe(2);
    expect((await run(["stats", "--db", join(dir, "missing.db")])).code).toBe(2);
  });
  test("sv mark / explain / override：标注后误报率出现在 stats 里", async () => {
    const store = new LogStore(DB);
    const l1 = store.db.query("SELECT id FROM hits WHERE rule_id='L1' AND run_id=1 ORDER BY id").all() as { id: number }[];
    const dec = store.db.query("SELECT id FROM decisions WHERE rule_id='L1' AND run_id=1 LIMIT 1").get() as { id: number };
    store.close();
    expect((await run(["mark", String(l1[0].id), "fp", "--note", "正常重试", "--db", DB])).out).toContain("误报");
    expect((await run(["mark", String(l1[1].id), "useful", "--db", DB])).code).toBe(0);
    expect((await run(["mark", "999999", "fp", "--db", DB])).code).toBe(2);
    expect((await run(["mark", "x", "maybe", "--db", DB])).code).toBe(2);
    const s = await run(["stats", "--db", DB, "--run", "1", "--format", "json"]);
    const l1row = (JSON.parse(s.out) as { rule: string; labeled_fp: number; labeled_useful: number; fp_rate: number }[]).find((r) => r.rule === "L1")!;
    expect(l1row).toMatchObject({ labeled_fp: 1, labeled_useful: 1, fp_rate: 0.5 });
    const ex = await run(["explain", String(l1[0].id), "--db", DB]);
    expect(ex.out).toContain("规则 L1");
    expect(ex.out).toContain("阈值");
    expect(ex.out).toContain("标注 mark_false_positive");
    expect(JSON.parse((await run(["explain", String(l1[0].id), "--db", DB, "--format", "json"])).out).hit.rule_id).toBe("L1");
    expect((await run(["explain", "999999", "--db", DB])).code).toBe(2);
    expect((await run(["override", String(dec.id), "reject", "--note", "不该提醒", "--db", DB])).code).toBe(0);
    expect((await run(["override", String(dec.id), "maybe", "--db", DB])).code).toBe(2);
  });
  test("sv export / sv prune", async () => {
    const out = join(dir, "export");
    const r = await run(["export", "--out", out, "--db", DB]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("hits:");
    expect(existsSync(join(out, "hits.jsonl"))).toBe(true);
    expect(readFileSync(join(out, "runs.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
    const p = await run(["prune", "--days", "0", "--db", DB]);
    expect(p.out).toContain("不清理");
    expect((await run(["prune", "--days", "3650", "--db", DB])).code).toBe(0);
    expect((await run(["export", "--db", DB])).code).toBe(2);
  });
  test("回放结果（--format json）不受日志影响；没有 --log 时不创建库", async () => {
    const before = existsSync(join(dir, "never.db"));
    const r = await run(["replay", join(FX, "claude/success.jsonl"), "--format=json"]);
    expect(JSON.parse(r.out).sessionId).toBe("claude-success");
    expect(before).toBe(false);
    expect(existsSync(join(dir, "never.db"))).toBe(false);
  });
  test("--set 写错 → 明确报错而不是悄悄忽略", async () => {
    const r = await run(["replay", FX, "--set", "nope.x=1"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("配置有误");
  });
});
