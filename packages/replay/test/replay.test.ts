import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, resolveConfig } from "@sv/core";
import { main } from "../../cli/src/sv.ts";
import { renderText, replayFile, replayPath } from "../src/index.ts";

const FX = join(import.meta.dir, "../../../test/fixtures");
const rules = (r: { timeline: { ruleId: string }[] }) => [...new Set(r.timeline.map((t) => t.ruleId))].sort();
const tmp = mkdtempSync(join(tmpdir(), "sv-replay-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("replay：命中时间线", () => {
  test("成功会话：没有命中", async () => {
    const r = await replayFile(join(FX, "claude/success.jsonl"));
    expect(r.timeline).toEqual([]);
    expect(r.steps).toBe(3);
  });
  test("fail-loop：L1/L3/T1，H 级在 pre、未核实指纹，--judge=off 时规则默认动作是拦截", async () => {
    const r = await replayFile(join(FX, "claude/fail-loop.jsonl"), { judge: "off" });
    expect(rules(r)).toEqual(["L1", "L3", "T1"]);
    const h = r.timeline.find((t) => t.ruleId === "L1" && t.sev === "H")!;
    expect(h.phase).toBe("pre");
    expect(h.action).toBe("block");
    expect(h.verified).toBe(false);
    expect(h.wouldBlockIfVerified).toBe(true);
    expect(h.applied).toBe(false); // 默认 shadow 模式：只记录
    // L1 M 在第 2 次失败处（相对时间 22 秒）
    const m = r.timeline.find((t) => t.ruleId === "L1" && t.sev === "M")!;
    expect(m.relMs).toBe(22_000);
    expect(r.summary.firstHitMs.L1).toBe(22_000);
    // M 级在 judge=off 时记为待 judge
    expect(m.action).toBe("judge_off");
  });
  test("fail-loop + mock judge：M 级变成 advise/skip，judge 调用被计数", async () => {
    const r = await replayFile(join(FX, "claude/fail-loop.jsonl"), { judge: "mock" });
    expect(r.judgeMode).toBe("mock");
    expect(r.summary.judgeCalls).toBeGreaterThan(0);
    expect(r.timeline.some((t) => t.action === "advise")).toBe(true);
  });
  test("cheat-danger：X1 / X2（含 ask）/ P3", async () => {
    const r = await replayFile(join(FX, "claude/cheat-danger.jsonl"));
    expect(rules(r)).toEqual(["P3", "X1", "X2"]);
    const x2 = r.timeline.filter((t) => t.ruleId === "X2");
    expect(x2.map((t) => t.action).sort()).toEqual(["ask", "block"]);
    expect(x2.every((t) => !t.applied)).toBe(true); // 默认 shadow：X2 只记录
    const enforced = await replayFile(join(FX, "claude/cheat-danger.jsonl"), { cfg: resolveConfig({ mode: "enforce" }, defaultConfig()) });
    expect(enforced.timeline.filter((t) => t.ruleId === "X2").every((t) => t.applied)).toBe(true);
  });
  test("readonly-stall：S1 为 M（已发生过编辑）；S2 仅观察", async () => {
    const r = await replayFile(join(FX, "claude/readonly-stall.jsonl"));
    expect(r.timeline.find((t) => t.ruleId === "S1")?.sev).toBe("M");
    expect(r.timeline.find((t) => t.ruleId === "S2")?.observeOnly).toBe(true);
  });
  test("misc：TodoWrite 计划 → P1 自动提取只给 M；sidechain 的危险命令不会误报 X2", async () => {
    const r = await replayFile(join(FX, "claude/misc.jsonl"));
    expect(r.plan?.source).toBe("auto");
    expect(r.timeline.find((t) => t.ruleId === "P1")?.sev).toBe("M");
    expect(r.timeline.some((t) => t.ruleId === "X2")).toBe(false);
  });
  test("plan.md 覆盖：显式 allow → P1 为 H", async () => {
    const r = await replayFile(join(FX, "claude/misc.jsonl"), { planMd: "# t\n- [ ] 改错误信息\nallow: src/errors.py\n" });
    const p1 = r.timeline.find((t) => t.ruleId === "P1")!;
    expect(p1.sev).toBe("H");
    expect(p1.action).toBe("block");
    expect(r.plan?.source).toBe("file");
  });
  test("Codex：编辑后同一条测试连续重跑 → T1 第 2 次 advise、之后 H；T2 advise 后 M", async () => {
    const r = await replayFile(join(FX, "codex/overtest.jsonl"));
    const t1 = r.timeline.filter((t) => t.ruleId === "T1");
    expect(t1.map((t) => t.sev)).toEqual(["L", "H", "H", "H"]);
    expect(t1[1].phase).toBe("pre");
    expect(r.timeline.filter((t) => t.ruleId === "T2").map((t) => t.sev)).toEqual(["L", "M"]);
    expect(r.timeline.some((t) => t.ruleId === "P2")).toBe(false);
  });
  test("模型名只记录、不参与判定：换成任何模型名，命中时间线完全一致", async () => {
    const orig = readFileSync(join(FX, "codex/overtest.jsonl"), "utf8");
    const a = await replayFile(join(FX, "codex/overtest.jsonl"));
    expect(a.model).toBe("gpt-5-codex");
    for (const model of ["claude-sonnet-5-5", "kimi-k2", "o3"]) {
      const f = join(tmp, `as-${model}.jsonl`);
      writeFileSync(f, orig.replace(/gpt-5-codex/g, model));
      const b = await replayFile(f);
      expect(b.model).toBe(model);
      const sig = (r: typeof a) => r.timeline.map((t) => `${t.seq}:${t.ruleId}:${t.sev}:${t.action}`);
      expect(sig(b)).toEqual(sig(a));
    }
  });
  test("Codex 退出码回填后，失败循环被 L1 识别", async () => {
    const r = await replayFile(join(FX, "codex/fail-loop.jsonl"));
    expect(rules(r)).toContain("L1");
    expect(r.timeline.some((t) => t.ruleId === "L1" && t.sev === "H" && t.phase === "pre")).toBe(true);
  });
  test("配置：mode=enforce 时 applied=true", async () => {
    const cfg = resolveConfig({ mode: "enforce" }, defaultConfig());
    const r = await replayFile(join(FX, "claude/fail-loop.jsonl"), { cfg, judge: "off" });
    expect(r.timeline.find((t) => t.ruleId === "L1" && t.sev === "H")?.applied).toBe(true);
  });
  test("目录回放 + 损坏文件不影响其他文件", async () => {
    writeFileSync(join(tmp, "bad.jsonl"), "garbage\n");
    writeFileSync(join(tmp, "ok.jsonl"), readFileSync(join(FX, "claude/success.jsonl")));
    const rs = await replayPath(tmp);
    expect(rs.length).toBe(rs.length);
    expect(rs.find((x) => x.file?.endsWith("bad.jsonl"))?.warnings[0]).toContain("读取失败");
    expect(rs.find((x) => x.file?.endsWith("ok.jsonl"))?.steps).toBe(3);
    const all = await replayPath(FX + "/claude");
    expect(all).toHaveLength(5);
  });
  test("文本报告可读", async () => {
    const r = await replayFile(join(FX, "claude/fail-loop.jsonl"));
    const t = renderText(r);
    expect(t).toContain("会话 claude-fail-loop");
    expect(t).toContain("L1");
    expect(t).toContain("按规则汇总");
    expect(t).toContain("+00:22");
  });
});

describe("落盘前脱敏（P0-7）", () => {
  const SECRET = "sk-abcdefghijklmnopqrstuvwxyz123456";
  const BEARER = "Bearer abcdef0123456789tokenvalue";
  function transcript(): string {
    const L: object[] = [{ type: "user", sessionId: "sec", timestamp: "2026-10-18T10:00:00Z", message: { role: "user", content: `use key ${SECRET} please` } }];
    for (let i = 0; i < 4; i++) {
      const cmd = `curl -s -H "Authorization: ${BEARER}" https://api.example.com/x`;
      L.push({ type: "assistant", sessionId: "sec", timestamp: `2026-10-18T10:00:${10 + i * 10}Z`, message: { role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { command: cmd } }] } });
      L.push({ type: "user", sessionId: "sec", timestamp: `2026-10-18T10:00:${12 + i * 10}Z`, message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: `ok ${SECRET}` }] } });
    }
    L.push({ type: "assistant", sessionId: "sec", timestamp: "2026-10-18T10:02:00Z", message: { role: "assistant", content: [{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: "/w/tests/test_a.py", old_string: "assert a == 1\nassert b == 2", new_string: `# ${SECRET}\npass` } }] } });
    L.push({ type: "user", sessionId: "sec", timestamp: "2026-10-18T10:02:02Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "e1", content: "updated" }] } });
    return L.map((l) => JSON.stringify(l)).join("\n") + "\n";
  }
  test("--out 的 JSON 与文本输出里都找不到密钥（命令参数、Edit 文本、消息、detail）", async () => {
    const f = join(tmp, "secret.jsonl");
    writeFileSync(f, transcript());
    const r = await replayFile(f, { judge: "mock" });
    expect(r.timeline.length).toBeGreaterThan(0);
    const json = JSON.stringify(r);
    const text = renderText(r, { verbose: true });
    for (const s of [json, text]) {
      expect(s).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
      expect(s).not.toContain("abcdef0123456789tokenvalue");
    }
    // CLI 写出的文件同样
    const out = join(tmp, "secret-out.json");
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      await main(["replay", f, "--out", out]);
    } finally {
      console.log = orig;
    }
    const written = readFileSync(out, "utf8");
    expect(written).not.toMatch(/abcdefghijklmnopqrstuvwxyz123456|abcdef0123456789tokenvalue/);
    expect(lines.join("\n")).not.toMatch(/abcdefghijklmnopqrstuvwxyz123456|abcdef0123456789tokenvalue/);
  });
});

describe("sv replay CLI", () => {
  async function run(args: string[]): Promise<{ code: number; out: string }> {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      const code = await main(args);
      return { code, out: lines.join("\n") };
    } finally {
      console.log = orig;
    }
  }
  test("--format=json 输出可解析的 JSON", async () => {
    const { code, out } = await run(["replay", join(FX, "claude/fail-loop.jsonl"), "--judge=mock", "--format=json"]);
    expect(code).toBe(0);
    const j = JSON.parse(out);
    expect(j.sessionId).toBe("claude-fail-loop");
    expect(j.timeline.length).toBeGreaterThan(0);
  });
  test("--out 写 JSON 文件，同时打印文本", async () => {
    const f = join(tmp, "out.json");
    const { code, out } = await run(["replay", join(FX, "claude/fail-loop.jsonl"), "--out", f]);
    expect(code).toBe(0);
    expect(out).toContain("按规则汇总");
    expect(JSON.parse(readFileSync(f, "utf8")).sessionId).toBe("claude-fail-loop");
  });
  test("目录输入输出数组；--plan 读取 plan.md", async () => {
    const { out } = await run(["replay", join(FX, "claude"), "--format=json"]);
    expect(Array.isArray(JSON.parse(out))).toBe(true);
    const plan = join(tmp, "plan.md");
    writeFileSync(plan, "- [ ] x\nallow: src/errors.py\n");
    const r = await run(["replay", join(FX, "claude/misc.jsonl"), "--plan", plan, "--format=json"]);
    expect(JSON.parse(r.out).plan.source).toBe("file");
  });
  test("无效的 --judge 值被拒绝；缺参数给出用法", async () => {
    const a = await run(["replay", join(FX, "claude/success.jsonl"), "--judge=bogus"]);
    expect(a.code).toBe(2);
    const b = await run(["replay"]);
    expect(b.code).toBe(2);
    const c = await run(["bogus"]);
    expect(c.code).toBe(2);
  });
});
