// sv opencode-enforce：默认 OFF；on 需要核对报告通过 + 批准人署名；每次切换（含拒绝、noop）都记日志。decisions #107/#110。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enforceLogFile, readEnforceState } from "@sv/core";
import plugin from "../../adapter-opencode/plugin/agent-supervisor.ts";
import { analyze, parseDump } from "../src/opencode-report.ts";
import { runOpencodeEnforce } from "../src/opencode-enforce.ts";
import { main } from "../src/sv.ts";

type H = (e: any) => unknown;
let home: string;
const saved = { h: process.env.SV_HOME, d: process.env.SV_OPENCODE_DUMP, p: process.env.SV_OPENCODE_PROBE };
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sv-oce-"));
  process.env.SV_HOME = home;
  process.env.SV_OPENCODE_DUMP = "1";
});
afterEach(() => {
  for (const [k, v] of [["SV_HOME", saved.h], ["SV_OPENCODE_DUMP", saved.d], ["SV_OPENCODE_PROBE", saved.p]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

/** 用真实插件源码 + 假 ctx 产生一份 dump。order 例如 ["B","E","A"]；tools 是每次调用用的工具名。 */
async function makeDump(o: { order?: string[]; calls?: number; tool?: string; probe?: boolean; skipRegister?: string } = {}) {
  const hooks = new Map<string, H>();
  const mk = (ns: string) => ({
    hook: async (name: string, f: H) => {
      if (o.skipRegister === `${ns}.${name}`) throw new Error("no such hook");
      hooks.set(`${ns}.${name}`, f);
      return { dispose: async () => {} };
    },
  });
  await (plugin as any).setup({ permission: mk("permission"), session: mk("session"), tool: mk("tool"), location: { directory: "/work/proj" } });
  const order = o.order ?? ["B", "E", "A"];
  const run = async (n: number, cmd: string) => {
    for (let i = 0; i < n; i++) {
      for (const step of order) {
        if (step === "B") await hooks.get("tool.execute.before")?.({ sessionID: "s1", id: `c${cmd}${i}`, tool: o.tool ?? "bash", input: { command: cmd } });
        if (step === "E") await hooks.get("permission.evaluate")?.({ sessionID: "s1", action: o.tool ?? "bash", resources: [cmd], source: { type: "tool", messageID: "m", id: `c${cmd}${i}` } });
        if (step === "A") await hooks.get("tool.execute.after")?.({ sessionID: "s1", id: `c${cmd}${i}`, tool: o.tool ?? "bash", input: { command: cmd }, status: "completed", result: "ok" });
      }
    }
  };
  await hooks.get("session.prompt")?.({ sessionID: "s1", messageID: "m0", prompt: "go", delivery: "queue" });
  await hooks.get("session.context")?.({ sessionID: "s1", system: ["base"], messages: [] });
  await run(o.calls ?? 6, "ls");
  if (o.probe !== false) {
    process.env.SV_OPENCODE_PROBE = "sv-probe-deny";
    await run(1, "touch /tmp/sv-probe-deny");
    delete process.env.SV_OPENCODE_PROBE;
  }
  const dir = join(home, "dumps");
  return join(dir, readdirSync(dir)[0]);
}
const logLines = () => (existsSync(enforceLogFile(home)) ? readFileSync(enforceLogFile(home), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
const on = (flags: Record<string, string | true> = {}, now?: number) => runOpencodeEnforce(["on"], { home, ...flags } as never, now);
const off = (flags: Record<string, string | true> = {}) => runOpencodeEnforce(["off"], { home, ...flags } as never);

describe("门槛（analyze → gate）", () => {
  test("完整的好样本：全部检查通过", async () => {
    const rep = analyze(parseDump(readFileSync(await makeDump(), "utf8")));
    expect(rep.gate.checks.filter((c) => !c.ok)).toEqual([]);
    expect(rep.gate.passed).toBe(true);
    expect(rep.gate.checks.map((c) => c.id).sort()).toEqual(["before_precedes_evaluate", "enough_calls", "hooks_registered", "mutating_calls_have_evaluate", "no_handler_errors", "probe_deny_worked", "recent"]);
  });
  test("每一项都能单独让门槛失败", async () => {
    const failed = async (o: Parameters<typeof makeDump>[0], now?: number) => {
      const dump = await makeDump(o);
      const rep = analyze(parseDump(readFileSync(dump, "utf8")), now);
      rmSync(join(home, "dumps"), { recursive: true, force: true });
      return rep.gate.checks.filter((c) => !c.ok).map((c) => c.id);
    };
    expect(await failed({ calls: 2, probe: false })).toContain("enough_calls");
    expect(await failed({ probe: false })).toEqual(["probe_deny_worked"]);
    expect(await failed({ skipRegister: "session.prompt" })).toEqual(["hooks_registered"]);
    expect(await failed({ order: ["E", "B", "A"] })).toContain("before_precedes_evaluate");
    expect(await failed({ order: ["B", "A"], probe: false })).toEqual(expect.arrayContaining(["mutating_calls_have_evaluate", "before_precedes_evaluate"]));
    expect(await failed({}, Date.now() + 30 * 86_400_000)).toEqual(["recent"]);
  });
  test("读类工具没有触发 evaluate 不算失败（只有写类工具才要求）", async () => {
    const rep = analyze(parseDump(readFileSync(await makeDump({ order: ["B", "A"], tool: "read", probe: false }), "utf8")));
    expect(rep.gate.checks.find((c) => c.id === "mutating_calls_have_evaluate")!.ok).toBe(true);
  });
});

describe("sv opencode-enforce", () => {
  test("默认 OFF：没有状态文件 / 文件损坏 / 格式不对 都是关", () => {
    expect(readEnforceState(home).enabled).toBe(false);
    writeFileSync(join(home, "opencode-enforce.json"), "{oops");
    expect(readEnforceState(home).enabled).toBe(false);
    writeFileSync(join(home, "opencode-enforce.json"), JSON.stringify({ version: 1, enabled: "yes" }));
    expect(readEnforceState(home).enabled).toBe(false);
    const s = runOpencodeEnforce(["status"], { home } as never);
    expect(s.code).toBe(0);
    expect(s.lines[0]).toContain("OFF");
  });
  test("on：没有样本 → 拒绝，状态不变，日志记 refused", () => {
    const r = on({ "approved-by": "jack" });
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toContain("没有找到核对样本");
    expect(readEnforceState(home).enabled).toBe(false);
    expect(logLines()).toMatchObject([{ action: "on", result: "refused", actor: "jack" }]);
  });
  test("on：门槛没过 → 拒绝并列出每个失败项；没有 --approved-by → 拒绝（即使门槛过了）", async () => {
    await makeDump({ probe: false });
    const r = on({ "approved-by": "jack" });
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toContain("probe_deny_worked");
    expect(readEnforceState(home).enabled).toBe(false);
    rmSync(join(home, "dumps"), { recursive: true, force: true });
    await makeDump();
    const r2 = on();
    expect(r2.code).toBe(1);
    expect(r2.lines.join("\n")).toContain("--approved-by");
    expect(on({ "approved-by": "bad name!" }).code).toBe(1); // 署名只允许安全字符
    expect(readEnforceState(home).enabled).toBe(false);
    expect(logLines().map((l) => l.result)).toEqual(["refused", "refused", "refused"]);
  });
  test("on：门槛通过 + 批准人 → 打开；状态文件 0600 并记录批准人和报告 sha256；日志记 applied 且带各项检查；再 on 是 noop", async () => {
    const dump = await makeDump();
    const r = on({ "approved-by": "jack", report: dump });
    expect(r.code).toBe(0);
    const s = readEnforceState(home);
    expect(s).toMatchObject({ enabled: true, actor: "jack" });
    expect(s.report!.path).toBe(dump);
    expect(s.report!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(join(home, "opencode-enforce.json")).mode & 0o777).toBe(0o600);
    const log = logLines();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ action: "on", result: "applied", actor: "jack" });
    expect(log[0].checks.every((c: any) => c.ok)).toBe(true);
    expect(on({ "approved-by": "jack", report: dump }).code).toBe(0);
    expect(logLines().map((l) => l.result)).toEqual(["applied", "noop"]);
    expect(runOpencodeEnforce(["status"], { home } as never).lines[0]).toContain("ON");
  });
  test("不指定 --report 时用数据目录里最新的 dump；样本过期（>14 天）→ 拒绝", async () => {
    await makeDump();
    expect(on({ "approved-by": "jack" }, Date.now() + 30 * 86_400_000).code).toBe(1);
    expect(readEnforceState(home).enabled).toBe(false);
    expect(on({ "approved-by": "jack" }).code).toBe(0);
  });
  test("off 永远允许（不需要批准人、不需要报告）；写日志；已经是 OFF → noop 也记", async () => {
    await makeDump();
    expect(on({ "approved-by": "jack" }).code).toBe(0);
    expect(off().code).toBe(0);
    expect(readEnforceState(home).enabled).toBe(false);
    expect(off().code).toBe(0);
    expect(logLines().map((l) => [l.action, l.result])).toEqual([["on", "applied"], ["off", "applied"], ["off", "noop"]]);
  });
  test("日志写不进去 → 不改状态：on 失败（仍 OFF），off 失败（仍 ON）", async () => {
    await makeDump();
    mkdirSync(enforceLogFile(home)); // 日志路径被占成目录，追加必然失败
    const r = on({ "approved-by": "jack" });
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toContain("日志写入失败");
    expect(readEnforceState(home).enabled).toBe(false);
    rmSync(enforceLogFile(home), { recursive: true });
    expect(on({ "approved-by": "jack" }).code).toBe(0);
    rmSync(enforceLogFile(home));
    mkdirSync(enforceLogFile(home));
    expect(off().code).toBe(1);
    expect(readEnforceState(home).enabled).toBe(true);
  });
  test("CLI 接线：main(['opencode-enforce', …])；缺子命令 → 2；status 退出码 0", async () => {
    const orig = { log: console.log, err: console.error };
    const out: string[] = [];
    console.log = (...a: unknown[]) => void out.push(a.join(" "));
    console.error = (...a: unknown[]) => void out.push(a.join(" "));
    try {
      expect(await main(["opencode-enforce", "status", "--home", home])).toBe(0);
      expect(await main(["opencode-enforce", "on", "--home", home, "--approved-by", "jack"])).toBe(1);
      expect(await main(["opencode-enforce", "bogus", "--home", home])).toBe(2);
      expect(out.join("\n")).toContain("拒绝打开");
    } finally {
      console.log = orig.log;
      console.error = orig.err;
    }
  });
});
