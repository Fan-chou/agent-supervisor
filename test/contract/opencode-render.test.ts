// design §3.5 输出字段白名单——OpenCode V2 部分。每格一个手写 fixture JSON（不是从 render 生成的），做深比较。
// OpenCode 的契约：只允许改 e.effect / e.message / e.system；deny 必须带 message；system 只能追加（render 只给出要追加的内容）。
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { x2Check } from "../../packages/core/src/index.ts";
import { ALLOWED, MAX_TEXT, deliveryFromX2, emittedText, render, sanitize, serialize, truncate, type Delivery } from "../../packages/adapter-opencode/src/index.ts";

const DIR = join(import.meta.dir, "opencode");
interface Fixture {
  cell: string;
  at: string;
  delivery?: Delivery | null;
  x2?: Parameters<typeof deliveryFromX2>[0];
  expected: unknown;
}
const fixtures = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => ({ file: f, fx: JSON.parse(readFileSync(join(DIR, f), "utf8")) as Fixture }));

const POINTS = Object.keys(ALLOWED) as ("permission.evaluate" | "context")[];
const UNSUPPORTED = ["tool.before", "tool.after", "session.created", "interrupt", "Stop", "PreToolUse", ""];
const KINDS: Delivery["kind"][] = ["block", "ask", "advise", "stop_continue"];
const FORBIDDEN_KEYS = ["ruleId", "deliveryId", "createdAtSeq", "expires", "kind", "text", "decision", "permissionDecision", "hookSpecificOutput", "additionalContext", "continue", "stopReason", "updatedInput", "reason"];
const keysDeep = (v: unknown, acc: string[] = []): string[] => {
  if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (acc.push(k), keysDeep(x, acc));
  return acc;
};

describe("契约（OpenCode）：每一格一个固定 fixture（深比较）", () => {
  test("fixture 覆盖了两个注入点 × 四种 kind，以及只收事件的注入点", () => {
    for (const at of POINTS) for (const kind of KINDS) expect(fixtures.some((x) => x.fx.at === at && x.fx.delivery?.kind === kind), `${at} × ${kind}`).toBe(true);
    const covered = new Set(fixtures.map((x) => x.fx.at));
    expect(covered.has("tool.before")).toBe(true);
    expect(covered.has("tool.after")).toBe(true);
    expect(fixtures.length).toBeGreaterThanOrEqual(12);
  });
  for (const { file, fx } of fixtures) {
    test(`${file}：${fx.cell}`, () => {
      const delivery = fx.x2 ? deliveryFromX2(fx.x2) : (fx.delivery ?? null);
      const out = render(delivery, fx.at);
      expect(out).toEqual(fx.expected as never);
      expect(serialize(out)).toBe(fx.expected === null ? "" : JSON.stringify(fx.expected));
    });
  }
});

describe("契约（OpenCode）：不变量（所有 kind × 注入点组合）", () => {
  const DIRTY: Delivery = { kind: "advise", text: "一条建议。", deliveryId: "d-secret", ruleId: "L1", createdAtSeq: 99, expires: { errFp: "x" } };

  test("输出里只有白名单字段（effect/message/system），不泄漏 Delivery 内部字段，也没有其他 harness 的字段", () => {
    for (const kind of KINDS) {
      for (const at of POINTS) {
        const out = render({ ...DIRTY, kind }, at);
        if (!out) continue;
        expect(Object.keys(out).every((k) => ALLOWED[at].includes(k)), `${kind}@${at}`).toBe(true);
        const keys = keysDeep(out);
        for (const bad of FORBIDDEN_KEYS) expect(keys, `${kind}@${at}`).not.toContain(bad);
        const s = JSON.stringify(out);
        for (const leak of ["d-secret", "createdAtSeq", "errFp", '"L1"']) expect(s).not.toContain(leak);
      }
    }
  });
  test("effect 只会是 deny（绝不 allow、不 ask）；deny 一定带非空 message", () => {
    for (const kind of KINDS) {
      const out = render({ ...DIRTY, kind }, "permission.evaluate") as { effect?: string; message?: string } | null;
      if (!out) continue;
      expect(out.effect).toBe("deny");
      expect(typeof out.message).toBe("string");
      expect(out.message!.length).toBeGreaterThan(0);
      expect(Object.keys(out).sort()).toEqual(["effect", "message"]);
    }
    for (const kind of KINDS) for (const at of POINTS) expect(JSON.stringify(render({ ...DIRTY, kind }, at) ?? {})).not.toMatch(/"allow"|"ask"/);
  });
  test("context：只有 advise 才输出，且是 system 数组（一条）；不动 effect/message", () => {
    for (const kind of KINDS) {
      const out = render({ ...DIRTY, kind }, "context");
      if (kind === "advise") expect(out).toEqual({ system: ["一条建议。"] });
      else expect(out).toBeNull();
    }
  });
  test("block / ask 只在 permission.evaluate 输出；advise / stop_continue 在 evaluate 上永远不输出", () => {
    for (const kind of ["block", "ask"] as const) expect(render({ ...DIRTY, kind }, "permission.evaluate")).not.toBeNull();
    for (const kind of ["advise", "stop_continue"] as const) expect(render({ ...DIRTY, kind }, "permission.evaluate")).toBeNull();
  });
  test("不支持的注入点（tool.before / tool.after / 其他 harness 的钩子名）：任何 kind 都返回 null", () => {
    for (const at of UNSUPPORTED) for (const kind of KINDS) expect(render({ ...DIRTY, kind }, at), `${kind}@${at}`).toBeNull();
  });
  test("消息截断到 ≤600 字符（含省略号）；emittedText 返回的就是实际输出的字符串", () => {
    const long = "字".repeat(1500);
    expect(truncate(long).length).toBe(MAX_TEXT);
    for (const [at, kind] of [["permission.evaluate", "block"], ["permission.evaluate", "ask"], ["context", "advise"]] as const) {
      const out = render({ kind, text: long }, at);
      const text = emittedText(out)!;
      expect(text.length, `${kind}@${at}`).toBeLessThanOrEqual(600);
      expect(text.endsWith("…")).toBe(true);
      expect(JSON.stringify(out)).toContain(text);
    }
    expect(emittedText(null)).toBeUndefined();
  });
  test("sanitize：任何不在白名单里的字段都被删掉", () => {
    const dirty = { effect: "deny", message: "m", system: ["s"], parts: [1], messages: [2], options: {}, tools: {}, model: "x" };
    expect(sanitize(dirty, "permission.evaluate")).toEqual({ effect: "deny", message: "m" });
    expect(sanitize(dirty, "context")).toEqual({ system: ["s"] });
  });
  test("渲染不修改输入", () => {
    const d = Object.freeze({ ...DIRTY });
    expect(() => render(d, "context")).not.toThrow();
  });
});

describe("契约（OpenCode）：X2 的真实输出与 fixture 文案一致", () => {
  const cwd = "/Users/jack/proj";
  const home = "/Users/jack";
  test("写 .env / 改 CI / git reset --hard → 一律 deny（OpenCode 没有 ask）", () => {
    const env = x2Check({ harness: "opencode", files: ["/Users/jack/proj/.env"], cwd, home })!;
    const git = x2Check({ harness: "opencode", command: "git reset --hard", cwd, home })!;
    const ci = x2Check({ harness: "opencode", files: [".github/workflows/ci.yml"], cwd, home })!;
    for (const r of [env, git, ci]) expect(r.action).toBe("deny");
    const byFile = Object.fromEntries(fixtures.map((x) => [x.file, x.fx]));
    expect(render(deliveryFromX2(env), "permission.evaluate")).toEqual(byFile["x2-env-deny.json"].expected as never);
    for (const r of [git, ci]) expect(render(deliveryFromX2(r), "permission.evaluate")).toEqual({ effect: "deny", message: r.reason });
  });
});
