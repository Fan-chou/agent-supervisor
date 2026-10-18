// design §3.5 输出字段白名单——Claude Code 部分。每个 harness × 事件一个固定 fixture JSON，做深比较。
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { x2Check } from "../../packages/core/src/index.ts";
import { ALLOWED, MAX_TEXT, deliveryFromX2, render, sanitize, serialize, truncate, type Delivery, type HookPoint } from "../../packages/adapter-claude/src/index.ts";

const DIR = join(import.meta.dir, "claude");
interface Fixture {
  cell: string;
  at: HookPoint;
  delivery?: Delivery | null;
  x2?: Parameters<typeof deliveryFromX2>[0];
  context?: { stopHookActive?: boolean };
  expected: unknown;
}
const fixtures = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => ({ file: f, fx: JSON.parse(readFileSync(join(DIR, f), "utf8")) as Fixture }));

const FORBIDDEN_KEYS = ["continue", "stopReason", "suppressOutput", "updatedInput", "systemMessage", "updatedMCPToolOutput", "ruleId", "deliveryId", "createdAtSeq", "expires", "kind", "text"];
const keysDeep = (v: unknown, acc: string[] = []): string[] => {
  if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (acc.push(k), keysDeep(x, acc));
  return acc;
};

describe("契约：每一格一个固定 fixture（深比较）", () => {
  test("fixture 覆盖了 Claude 的每个事件", () => {
    const covered = new Set(fixtures.map((x) => x.fx.at));
    for (const at of Object.keys(ALLOWED) as HookPoint[]) expect(covered.has(at), at).toBe(true);
    expect(fixtures.length).toBeGreaterThanOrEqual(15);
  });
  for (const { file, fx } of fixtures) {
    test(`${file}：${fx.cell}`, () => {
      const delivery = fx.x2 ? deliveryFromX2(fx.x2) : (fx.delivery ?? null);
      const out = render(delivery, fx.at, fx.context);
      expect(out).toEqual(fx.expected as never);
      // 序列化：没有输出时是空串
      expect(serialize(out)).toBe(fx.expected === null ? "" : JSON.stringify(fx.expected));
    });
  }
});

describe("契约：不变量（对所有 fixture 和所有 kind × 事件组合）", () => {
  const KINDS: Delivery["kind"][] = ["block", "ask", "advise", "stop_continue"];
  const POINTS = Object.keys(ALLOWED) as HookPoint[];
  const DIRTY: Delivery = { kind: "advise", text: "一条建议。", deliveryId: "d-secret", ruleId: "L1", createdAtSeq: 99, expires: { errFp: "x" } };

  test("输出里只有白名单字段；绝不泄漏 Delivery 的内部字段", () => {
    for (const kind of KINDS) {
      for (const at of POINTS) {
        const out = render({ ...DIRTY, kind }, at, { stopHookActive: false });
        if (!out) continue;
        const allowed = ALLOWED[at];
        const top = Object.keys(out);
        expect(top.every((k) => allowed.top.includes(k)), `${kind}@${at} 顶层 ${top}`).toBe(true);
        const hso = (out as { hookSpecificOutput?: object }).hookSpecificOutput;
        if (hso) expect(Object.keys(hso).every((k) => allowed.hso.includes(k)), `${kind}@${at} hso`).toBe(true);
        const keys = keysDeep(out);
        for (const bad of FORBIDDEN_KEYS) expect(keys, `${kind}@${at}`).not.toContain(bad);
        const s = JSON.stringify(out);
        for (const leak of ["d-secret", "createdAtSeq", "errFp", '"L1"']) expect(s).not.toContain(leak);
      }
    }
  });
  test("Post/Failure/Batch 事件上无论请求什么 kind，都不输出 permissionDecision 或 decision", () => {
    for (const at of ["PostToolUse", "PostToolUseFailure", "PostToolBatch"] as HookPoint[]) {
      for (const kind of KINDS) {
        const out = render({ ...DIRTY, kind }, at);
        const s = JSON.stringify(out ?? {});
        expect(s, `${kind}@${at}`).not.toContain("permissionDecision");
        expect(s, `${kind}@${at}`).not.toContain('"decision"');
      }
    }
  });
  test("PreToolUse 的 deny / ask 绝不带 additionalContext", () => {
    for (const kind of ["block", "ask"] as const) {
      const out = render({ ...DIRTY, kind }, "PreToolUse") as { hookSpecificOutput: Record<string, unknown> };
      expect(out.hookSpecificOutput.additionalContext).toBeUndefined();
      expect(out.hookSpecificOutput.permissionDecision).toBe(kind === "block" ? "deny" : "ask");
    }
  });
  test("PreToolUse 的 advise 只有 additionalContext，没有 permissionDecision", () => {
    const out = render(DIRTY, "PreToolUse") as { hookSpecificOutput: Record<string, unknown> };
    expect(Object.keys(out.hookSpecificOutput).sort()).toEqual(["additionalContext", "hookEventName"]);
  });
  test("Stop：只有 decision + reason；stop_hook_active=true 时任何 kind 都不 block", () => {
    const out = render({ ...DIRTY, kind: "stop_continue" }, "Stop");
    expect(out).toEqual({ decision: "block", reason: "一条建议。" });
    for (const kind of KINDS) expect(render({ ...DIRTY, kind }, "Stop", { stopHookActive: true })).toBeNull();
    for (const kind of ["block", "ask", "advise"] as const) expect(render({ ...DIRTY, kind }, "Stop")).toBeNull();
  });
  test("消息截断到 ≤600 字符（含省略号），所有事件一致", () => {
    const long = "字".repeat(1500);
    expect(truncate(long).length).toBe(MAX_TEXT);
    expect(truncate("x".repeat(600))).toBe("x".repeat(600));
    expect(truncate("x".repeat(601)).endsWith("…")).toBe(true);
    for (const [at, kind] of [["PreToolUse", "block"], ["PreToolUse", "advise"], ["PostToolUse", "advise"], ["PostToolBatch", "advise"], ["Stop", "stop_continue"]] as const) {
      const out = render({ kind, text: long }, at) as Record<string, any>;
      const text = out.reason ?? out.hookSpecificOutput.permissionDecisionReason ?? out.hookSpecificOutput.additionalContext;
      expect(text.length, `${kind}@${at}`).toBeLessThanOrEqual(600);
    }
  });
  test("sanitize：任何不在白名单里的字段都被删掉（continue / stopReason / suppressOutput / updatedInput / systemMessage）", () => {
    const dirty = {
      continue: false,
      stopReason: "x",
      suppressOutput: true,
      systemMessage: "hi",
      updatedInput: { command: "rm -rf /" },
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "r", additionalContext: "c", updatedInput: { a: 1 }, updatedMCPToolOutput: "x" },
    };
    expect(sanitize(dirty, "PreToolUse")).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "r", additionalContext: "c" } });
    expect(sanitize(dirty, "PostToolUse")).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "c" } });
    expect(sanitize({ decision: "block", reason: "r", continue: false, hookSpecificOutput: {} }, "Stop")).toEqual({ decision: "block", reason: "r" });
  });
  test("渲染不修改输入", () => {
    const d = Object.freeze({ ...DIRTY });
    expect(() => render(d, "PreToolUse")).not.toThrow();
  });
});

describe("契约：X2 的真实输出与 fixture 文案一致", () => {
  const cwd = "/Users/jack/proj";
  const home = "/Users/jack";
  test("写 .env / 改 CI 配置 → ask；git reset --hard → deny", () => {
    const env = x2Check({ harness: "claude", files: ["/Users/jack/proj/.env"], cwd, home })!;
    const ci = x2Check({ harness: "claude", files: [".github/workflows/ci.yml"], cwd, home })!;
    const git = x2Check({ harness: "claude", command: "git reset --hard", cwd, home })!;
    const byFile = Object.fromEntries(fixtures.map((x) => [x.file, x.fx]));
    expect(render(deliveryFromX2(env), "PreToolUse")).toEqual(byFile["x2-env-ask.json"].expected as never);
    expect(render(deliveryFromX2(ci), "PreToolUse")).toEqual(byFile["x2-ci-ask.json"].expected as never);
    expect(render(deliveryFromX2(git), "PreToolUse")).toEqual(byFile["x2-git-deny.json"].expected as never);
  });
  test("Codex 上同样的 X2 一律 deny（Claude 的 ask 不会被带过去）", () => {
    expect(x2Check({ harness: "codex", files: ["/Users/jack/proj/.env"], cwd, home })?.action).toBe("deny");
    expect(x2Check({ harness: "opencode", files: [".github/workflows/ci.yml"], cwd, home })?.action).toBe("deny");
  });
});
