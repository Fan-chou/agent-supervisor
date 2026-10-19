// sv opencode-report：用插件自己落下的 dump（假 ctx 驱动）验证汇总结论，包括触发顺序的两种情形。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../../adapter-opencode/plugin/agent-supervisor.ts";
import { analyze, formatReport, parseDump } from "../src/opencode-report.ts";
import { main } from "../src/sv.ts";

type H = (e: any) => unknown;
let home: string;
const prev = { h: process.env.SV_HOME, d: process.env.SV_OPENCODE_DUMP };
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sv-ocr-"));
  process.env.SV_HOME = home;
  process.env.SV_OPENCODE_DUMP = "1";
});
afterEach(() => {
  if (prev.h === undefined) delete process.env.SV_HOME;
  else process.env.SV_HOME = prev.h;
  if (prev.d === undefined) delete process.env.SV_OPENCODE_DUMP;
  else process.env.SV_OPENCODE_DUMP = prev.d;
  rmSync(home, { recursive: true, force: true });
});

async function drive(order: string[], opts: { skipRegister?: string } = {}) {
  const hooks = new Map<string, H>();
  const mk = (ns: string) => ({
    hook: (name: string, f: H) => {
      if (opts.skipRegister === `${ns}.${name}`) throw new Error("no such hook");
      hooks.set(`${ns}.${name}`, f);
    },
  });
  await (plugin as any).setup({ permission: mk("permission"), session: mk("session"), tool: mk("tool") });
  return { hooks, run: async (calls: number) => {
    for (let i = 0; i < calls; i++) {
      for (const step of order) {
        if (step === "B") await hooks.get("tool.execute.before")?.({ sessionID: "s1", callID: `c${i}`, tool: "bash", args: { command: "ls" } });
        if (step === "E") await hooks.get("permission.evaluate")?.({ sessionID: "s1", action: "bash", resources: ["ls"] });
        if (step === "A") await hooks.get("tool.execute.after")?.({ sessionID: "s1", callID: `c${i}`, tool: "bash", status: "completed", result: "ok" });
      }
    }
  } };
}
const dumpText = () => {
  const dir = join(home, "dumps");
  return readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("");
};

describe("opencode-report", () => {
  test("B→E→A：结论是当前假设成立；统计各钩子调用次数与字段", async () => {
    const d = await drive(["B", "E", "A"]);
    await d.run(3);
    const rep = analyze(parseDump(dumpText()));
    expect(rep.orderings).toEqual({ BEA: 3 });
    expect(rep.verdicts.join("\n")).toContain("当前适配器的假设成立");
    expect(rep.hooks["execute.before"].calls).toBe(3);
    expect(rep.hooks["evaluate"].fields).toMatchObject({ sessionID: 3, action: 3, resources: 3 });
    expect(rep.registered["evaluate"]).toEqual({ ok: true, reason: undefined });
    expect(formatReport(rep)).toContain("B→E→A");
  });
  test("E→B→A：报告明确指出 evaluate 先于 before，需要改设计", async () => {
    const d = await drive(["E", "B", "A"]);
    await d.run(2);
    const rep = analyze(parseDump(dumpText()));
    expect(rep.orderings).toEqual({ EBA: 2 });
    expect(rep.verdicts.join("\n")).toMatch(/先于 execute\.before/);
  });
  test("没有 evaluate 的调用、注册失败的钩子、从未被调用的钩子都会在结论里出现", async () => {
    const d = await drive(["B", "A"], { skipRegister: "permission.evaluate" });
    await d.run(2);
    const rep = analyze(parseDump(dumpText()));
    expect(rep.orderings).toEqual({ BA: 2 });
    expect(rep.registered["evaluate"].ok).toBe(false);
    const v = rep.verdicts.join("\n");
    expect(v).toContain("没有触发 permission.evaluate");
    expect(v).toContain("evaluate 注册失败");
  });
  test("并行批次（run2 形状）：shell 的 before → 三个 read 完成 → shell 的 evaluate → after，按调用 id 对账，两项写类检查都通过；写类调用缺 evaluate 仍会被抓", async () => {
    const d = await drive([]);
    const h = (n: string) => d.hooks.get(n)!;
    const ev = (id: string) => h("permission.evaluate")({ sessionID: "s1", action: "edit", resources: [], source: { type: "tool", messageID: "m", id } });
    await h("tool.execute.before")({ sessionID: "s1", id: "sh", tool: "shell", input: { command: "ls -la" } });
    for (const id of ["r1", "r2", "r3"]) {
      await h("tool.execute.before")({ sessionID: "s1", id, tool: "read", input: { path: "a" } });
      await ev(id);
      await h("tool.execute.after")({ sessionID: "s1", id, tool: "read", status: "completed", result: "x" });
    }
    await ev("sh");
    await h("tool.execute.after")({ sessionID: "s1", id: "sh", tool: "shell", status: "completed", result: "x" });
    let rep = analyze(parseDump(dumpText()));
    const ok = (id: string) => rep.gate.checks.find((c) => c.id === id)!.ok;
    expect(ok("before_precedes_evaluate")).toBe(true);
    expect(ok("mutating_calls_have_evaluate")).toBe(true);
    await h("tool.execute.before")({ sessionID: "s1", id: "w", tool: "write", input: { path: "n" } });
    await h("tool.execute.after")({ sessionID: "s1", id: "w", tool: "write", status: "completed", result: "x" });
    rep = analyze(parseDump(dumpText()));
    expect(ok("mutating_calls_have_evaluate")).toBe(false);
  });
  test("探针 deny 生效时能在 exit 记录里看到 effect/message；闸门关时记 wouldDeny", async () => {
    const d = await drive(["B", "E", "A"]);
    process.env.SV_OPENCODE_PROBE = "ls";
    await d.run(1);
    delete process.env.SV_OPENCODE_PROBE;
    const rep = analyze(parseDump(dumpText()));
    expect(rep.denyObserved.length).toBe(1);
    expect(rep.denyObserved[0]).toMatchObject({ hook: "evaluate", effect: "deny" });
  });
  test("CLI：sv opencode-report <文件> 能跑（文本 / json）；缺参数 → 2；坏行被跳过", async () => {
    const d = await drive(["B", "E", "A"]);
    await d.run(1);
    const dir = join(home, "dumps");
    const file = join(dir, readdirSync(dir)[0]);
    const orig = console.log;
    const lines: string[] = [];
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      expect(await main(["opencode-report", file])).toBe(0);
      expect(lines.join("\n")).toContain("## 结论");
      lines.length = 0;
      expect(await main(["opencode-report", file, "--format", "json"])).toBe(0);
      expect(JSON.parse(lines.join("\n")).orderings).toEqual({ BEA: 1 });
    } finally {
      console.log = orig;
    }
    expect(await main(["opencode-report"])).toBe(2);
    expect(parseDump("not json\n{\"n\":1,\"ts\":1,\"hook\":\"x\",\"phase\":\"enter\"}\n").length).toBe(1);
  });
  test("中断订阅：registered 要拿到可迭代对象才记；每个 interrupted 事件（任何原因）记一笔并按原因计数；订阅抛错记 registered=false；不影响五个钩子的门槛检查", async () => {
    const hooks = new Map<string, H>();
    const mk = (ns: string) => ({ hook: (name: string, f: H) => void hooks.set(`${ns}.${name}`, f) });
    const evs = [{ type: "session.execution.interrupted", data: { sessionID: "s1", reason: "user" } }, { type: "session.execution.interrupted", data: { sessionID: "s1", reason: "shutdown" } }, { type: "session.text.delta", data: {} }];
    await (plugin as any).setup({ permission: mk("permission"), session: mk("session"), tool: mk("tool"), event: { subscribe: () => (async function* () { for (const e of evs) yield e; })() } });
    const dir = join(home, "dumps");
    const file = join(dir, readdirSync(dir)[0]);
    for (let i = 0; i < 100 && !/shutdown/.test(readFileSync(file, "utf8")); i++) await new Promise((r) => setTimeout(r, 10));
    const rep = analyze(parseDump(readFileSync(file, "utf8")));
    expect(rep.interrupts).toEqual({ user: 1, shutdown: 1 });
    expect(rep.registered["event.subscribe"]).toEqual({ ok: true, reason: undefined });
    expect(formatReport(rep)).toContain("reason=user × 1");
    expect(rep.gate.checks.find((c) => c.id === "hooks_registered")?.ok).toBe(true); // 额外的 event.subscribe 记录不改变「五个钩子」的检查
    // 订阅抛错：registered=false 并带原因，且仍不影响五个钩子的门槛检查
    await (plugin as any).setup({ permission: mk("permission"), session: mk("session"), tool: mk("tool"), event: { subscribe: () => { throw new Error("boom"); } } });
    const rep2 = analyze(parseDump(readFileSync(file, "utf8")));
    expect(rep2.registered["event.subscribe"]).toEqual({ ok: false, reason: "boom" });
    expect(rep2.gate.checks.find((c) => c.id === "hooks_registered")?.ok).toBe(true);
  });
});
