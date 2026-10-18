import { describe, expect, test } from "bun:test";
import { planFromEvent } from "@sv/core";
import { modelName, normalizeOpenCodeEvent } from "../src/normalize.ts";

let seq = 0;
const ctx = { nextSeq: () => seq++, now: 1_700_000_000_000 };
const n = (p: Record<string, unknown>, model?: string) => normalizeOpenCodeEvent(p, { ...ctx, model });
const base = { sessionID: "oc1", directory: "/work/proj", model: { providerID: "p", modelID: "any-model" } };

describe("OpenCode V2 插件事件 → Event（合成载荷）", () => {
  test("tool.before(bash)：pre 事件，带分类、argsHash；harness=opencode；model 只记录", () => {
    const r = n({ ...base, event: "tool.before", callID: "c1", tool: "bash", args: { command: "uv run pytest tests/a.py -q 2>&1 | tail -5" } });
    expect(r.hookPoint).toBeNull();
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ phase: "pre", harness: "opencode", sessionId: "oc1", toolUseId: "c1", cwd: "/work/proj", origin: "agent", model: "p/any-model" });
    expect(r.events[0].shell).toMatchObject({ cls: "test_targeted", normCmd: "pytest tests/a.py -q" });
    expect(r.events[0].tool?.argsHash).toBeTruthy();
  });
  test("tool.after：status=error 明确判失败（不需要 FailureClassifier）；completed 无信号时不默认成功以外的猜测；argsHash 与 pre 相同", () => {
    const args = { command: "pytest -q" };
    const pre = n({ ...base, event: "tool.before", callID: "c2", tool: "bash", args }).events[0];
    const bad = n({ ...base, event: "tool.after", callID: "c2", tool: "bash", args, status: "error", error: { message: "Command exited with code 1\nFAILED tests/a.py::t - KeyError: 'x'" } }).events[0];
    expect(bad.phase).toBe("post");
    expect(bad.result?.status).toBe("fail");
    expect(bad.result?.errFingerprint).toBeTruthy();
    expect(bad.tool?.argsHash).toBe(pre.tool?.argsHash);
    expect(bad.toolUseId).toBe("c2");
    const ok = n({ ...base, event: "tool.after", callID: "c2", tool: "bash", args, status: "completed", result: { output: "=== 3 passed in 0.1s ===", metadata: { exit: 0 } } }).events[0];
    expect(ok.result).toMatchObject({ status: "ok", exitCode: 0 });
  });
  test("edit / write / read / grep / todowrite 沿用 core 的工具分类；edit 解析出文件", () => {
    const k = (tool: string, args: unknown) => n({ ...base, event: "tool.before", callID: "x", tool, args }).events[0];
    expect(k("edit", { filePath: "/work/proj/src/a.ts", oldString: "a", newString: "b" }).tool?.kind).toBe("edit");
    expect(k("write", { filePath: "/work/proj/src/b.ts", content: "x" }).tool?.kind).toBe("edit");
    expect(k("read", { filePath: "/work/proj/src/a.ts" }).tool?.kind).toBe("read");
    expect(k("grep", { pattern: "x" }).tool?.kind).toBe("search");
    expect(k("task", { prompt: "x" }).tool?.kind).toBe("agent");
    expect(k("edit", { filePath: "/work/proj/src/a.ts", oldString: "a", newString: "b" }).edit?.files).toEqual(["/work/proj/src/a.ts"]);
  });
  test("todowrite → plan 事件，tracker 能取到计划", () => {
    const todos = [{ content: "写测试", status: "in_progress" }, { content: "改实现", status: "pending" }];
    const e = n({ ...base, event: "tool.before", callID: "t1", tool: "todowrite", args: { todos } }).events[0];
    expect(e.tool?.kind).toBe("plan");
    expect(planFromEvent(e)).toBeTruthy();
  });
  test("permission.evaluate：是注入点，但不产生事件（pre 事件来自 tool.before，避免重复计数）", () => {
    const r = n({ ...base, event: "permission.evaluate" });
    expect(r.hookPoint).toBe("permission.evaluate");
    expect(r.events).toEqual([]);
  });
  test("context：注入点；带 userMessage 时产生 origin=user 的 prompt 事件，不带则不产生；模型名取自对象/字符串", () => {
    const a = n({ ...base, event: "context" });
    expect(a.hookPoint).toBe("context");
    expect(a.events).toEqual([]);
    expect(a.model).toBe("p/any-model");
    const b = n({ ...base, event: "context", model: "m-str", userMessage: { id: "u1", text: "请修复它" } });
    expect(b.events[0]).toMatchObject({ phase: "prompt", origin: "user", text: "请修复它", harness: "opencode", model: "m-str" });
  });
  test("session.created / interrupt → session / interrupt 事件；未知事件和缺字段不抛异常也不产生事件", () => {
    expect(n({ ...base, event: "session.created" }).events[0].phase).toBe("session");
    expect(n({ ...base, event: "interrupt" }).events[0]).toMatchObject({ phase: "interrupt", origin: "user" });
    expect(n({ event: "something.else" }).events).toEqual([]);
    expect(n({}).sessionId).toBe("unknown");
    expect(() => n({ event: "tool.before" })).not.toThrow();
    expect(() => n({ event: "tool.after", status: "error" })).not.toThrow();
  });
  test("规则通用：换任意模型名，事件除 model 字段外完全一致", () => {
    const a = n({ ...base, model: "model-a", event: "tool.before", callID: "m", tool: "bash", args: { command: "npm test" } }).events[0];
    const b = n({ ...base, model: "gpt-9", event: "tool.before", callID: "m", tool: "bash", args: { command: "npm test" } }).events[0];
    const strip = (e: Record<string, unknown>) => ({ ...e, model: undefined, seq: 0 });
    expect(strip(a as never)).toEqual(strip(b as never));
  });
  test("modelName：字符串 / {providerID, modelID} / {id} / 其他", () => {
    expect(modelName("x")).toBe("x");
    expect(modelName({ providerID: "a", modelID: "b" })).toBe("a/b");
    expect(modelName({ id: "z" })).toBe("z");
    expect(modelName(42)).toBeUndefined();
  });
});
