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
});
