// design §3.5 输出字段白名单——Codex 部分。每个 harness × 事件 × kind 一个手写 fixture JSON（不是从 render 生成的），做深比较。
// Codex 最危险的坑：ask / continue / stopReason / suppressOutput 会让钩子被判失败（工具照常执行），updatedInput 只能和 allow 一起用。
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { x2Check } from "../../packages/core/src/index.ts";
import { ALLOWED, MAX_TEXT, deliveryFromX2, emittedText, render, sanitize, serialize, truncate, type Delivery } from "../../packages/adapter-codex/src/index.ts";

const DIR = join(import.meta.dir, "codex");
interface Fixture {
  cell: string;
  at: string;
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
const POINTS = Object.keys(ALLOWED) as ("PreToolUse" | "PostToolUse" | "Stop")[];
const UNSUPPORTED = ["PostToolUseFailure", "PostToolBatch", "UserPromptSubmit", "SessionStart", "PermissionRequest", ""];
const KINDS: Delivery["kind"][] = ["block", "ask", "advise", "stop_continue"];

describe("契约（Codex）：每一格一个固定 fixture（深比较）", () => {
  test("fixture 覆盖了 Codex 的每个注入点和每种 kind", () => {
    const covered = new Set(fixtures.map((x) => x.fx.at));
    for (const at of POINTS) expect(covered.has(at), at).toBe(true);
    expect(covered.has("PostToolUseFailure")).toBe(true);
    expect(covered.has("PostToolBatch")).toBe(true);
    for (const at of POINTS) for (const kind of KINDS) expect(fixtures.some((x) => x.fx.at === at && x.fx.delivery?.kind === kind), `${at} × ${kind}`).toBe(true);
    expect(fixtures.length).toBeGreaterThanOrEqual(15);
  });
  for (const { file, fx } of fixtures) {
    test(`${file}：${fx.cell}`, () => {
      const delivery = fx.x2 ? deliveryFromX2(fx.x2) : (fx.delivery ?? null);
      const out = render(delivery, fx.at, fx.context);
      expect(out).toEqual(fx.expected as never);
      expect(serialize(out)).toBe(fx.expected === null ? "" : JSON.stringify(fx.expected));
    });
  }
});

describe("契约（Codex）：不变量（所有 kind × 注入点组合）", () => {
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
  test("任何输出里都不会出现 ask（permissionDecision 只会是 deny）", () => {
    for (const kind of KINDS) {
      for (const at of POINTS) {
        const s = JSON.stringify(render({ ...DIRTY, kind }, at) ?? {});
        expect(s, `${kind}@${at}`).not.toMatch(/"ask"/);
        expect(s, `${kind}@${at}`).not.toMatch(/"continue"|"stopReason"|"suppressOutput"|"updatedInput"|"updatedMCPToolOutput"|"systemMessage"/);
      }
    }
  });
  test("PostToolUse 无论请求什么 kind，都不输出 permissionDecision 或 decision", () => {
    for (const kind of KINDS) {
      const s = JSON.stringify(render({ ...DIRTY, kind }, "PostToolUse") ?? {});
      expect(s, kind).not.toContain("permissionDecision");
      expect(s, kind).not.toContain('"decision"');
    }
  });
  test("PreToolUse：block 和 ask 都输出 deny，且绝不带 additionalContext", () => {
    for (const kind of ["block", "ask"] as const) {
      const out = render({ ...DIRTY, kind }, "PreToolUse") as { hookSpecificOutput: Record<string, unknown> };
      expect(out.hookSpecificOutput.additionalContext).toBeUndefined();
      expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(Object.keys(out.hookSpecificOutput).sort()).toEqual(["hookEventName", "permissionDecision", "permissionDecisionReason"]);
    }
  });
  test("PreToolUse 的 advise 只有 additionalContext，没有 permissionDecision", () => {
    const out = render(DIRTY, "PreToolUse") as { hookSpecificOutput: Record<string, unknown> };
    expect(Object.keys(out.hookSpecificOutput).sort()).toEqual(["additionalContext", "hookEventName"]);
  });
  test("Stop：只有 decision + reason；stop_hook_active=true 时任何 kind 都不 block", () => {
    expect(render({ ...DIRTY, kind: "stop_continue" }, "Stop")).toEqual({ decision: "block", reason: "一条建议。" });
    for (const kind of KINDS) expect(render({ ...DIRTY, kind }, "Stop", { stopHookActive: true })).toBeNull();
    for (const kind of ["block", "ask", "advise"] as const) expect(render({ ...DIRTY, kind }, "Stop")).toBeNull();
  });
  test("Codex 没有的注入点（PostToolUseFailure / PostToolBatch / 其他事件名）：任何 kind 都返回 null", () => {
    for (const at of UNSUPPORTED) for (const kind of KINDS) expect(render({ ...DIRTY, kind }, at), `${kind}@${at}`).toBeNull();
  });
  test("消息截断到 ≤600 字符（含省略号）；emittedText 返回的就是实际输出的字符串", () => {
    const long = "字".repeat(1500);
    expect(truncate(long).length).toBe(MAX_TEXT);
    for (const [at, kind] of [["PreToolUse", "block"], ["PreToolUse", "ask"], ["PreToolUse", "advise"], ["PostToolUse", "advise"], ["Stop", "stop_continue"]] as const) {
      const out = render({ kind, text: long }, at);
      const text = emittedText(out)!;
      expect(text.length, `${kind}@${at}`).toBeLessThanOrEqual(600);
      expect(text.endsWith("…")).toBe(true);
      expect(JSON.stringify(out)).toContain(text);
    }
    expect(emittedText(null)).toBeUndefined();
  });
  test("sanitize：任何不在白名单里的字段都被删掉（含 ask 之外的 continue / stopReason / suppressOutput / updatedInput / systemMessage）", () => {
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

describe("契约（Codex）：X2 的真实输出与 fixture 文案一致", () => {
  const cwd = "/Users/jack/proj";
  const home = "/Users/jack";
  test("写 .env / 改 CI 配置 / git reset --hard → 一律 deny，文案与 fixture 相同", () => {
    const env = x2Check({ harness: "codex", files: ["/Users/jack/proj/.env"], cwd, home })!;
    const git = x2Check({ harness: "codex", command: "git reset --hard", cwd, home })!;
    const ci = x2Check({ harness: "codex", files: [".github/workflows/ci.yml"], cwd, home })!;
    expect(env.action).toBe("deny");
    expect(ci.action).toBe("deny");
    const byFile = Object.fromEntries(fixtures.map((x) => [x.file, x.fx]));
    expect(render(deliveryFromX2(env), "PreToolUse")).toEqual(byFile["x2-env-deny.json"].expected as never);
    expect(render(deliveryFromX2(git), "PreToolUse")).toEqual(byFile["x2-git-deny.json"].expected as never);
    const out = render(deliveryFromX2(ci), "PreToolUse") as { hookSpecificOutput: { permissionDecision: string } };
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });
});
