import { describe, expect, test } from "bun:test";
import { normalizeClaudeHook, responseText } from "../src/normalize.ts";

let seq = 0;
const ctx = { nextSeq: () => seq++, now: 1_700_000_000_000 };
const n = (p: Record<string, unknown>) => normalizeClaudeHook(p, ctx);
const base = { session_id: "s1", cwd: "/work/proj", transcript_path: "/x/s1.jsonl" };

describe("Claude hook 载荷 → Event（合成载荷）", () => {
  test("PreToolUse(Bash)：pre 事件，带分类、argsHash、cwd；hookPoint=PreToolUse", () => {
    const r = n({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "uv run pytest tests/a.py -q 2>&1 | tail -5" }, tool_use_id: "toolu_1" });
    expect(r.hookPoint).toBe("PreToolUse");
    expect(r.events).toHaveLength(1);
    const e = r.events[0];
    expect(e).toMatchObject({ phase: "pre", harness: "claude", sessionId: "s1", toolUseId: "toolu_1", cwd: "/work/proj", origin: "agent" });
    expect(e.shell).toMatchObject({ cls: "test_targeted", normCmd: "pytest tests/a.py -q" });
    expect(e.tool?.argsHash).toBeTruthy();
  });
  test("PostToolUse(Bash)：stdout+stderr 拼成输出；与 Pre 的 argsHash 相同", () => {
    const input = { command: "pytest -q" };
    const pre = n({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: input, tool_use_id: "t2" }).events[0];
    const post = n({ ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: input, tool_response: { stdout: "=== 3 passed in 0.1s ===", stderr: "", interrupted: false }, tool_use_id: "t2" }).events[0];
    expect(post.phase).toBe("post");
    expect(post.result).toMatchObject({ status: "ok" });
    expect(post.result?.testSummary?.passed).toBe(3);
    expect(post.tool?.argsHash).toBe(pre.tool?.argsHash);
    expect(post.toolUseId).toBe(pre.toolUseId);
  });
  test("PostToolUseFailure：error 第一行 `Exit code N` → fail + 退出码；输出里的密钥被脱敏", () => {
    const r = n({ ...base, hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "pytest" }, error: "Exit code 2\nE   KeyError: 'x'\nAPI_KEY=abc12345secret", tool_use_id: "t3" });
    expect(r.hookPoint).toBe("PostToolUseFailure");
    const e = r.events[0];
    expect(e.result).toMatchObject({ status: "fail", exitCode: 2 });
    expect(e.result?.errFingerprint).toBeTruthy();
    expect(e.result?.outputHead).not.toContain("abc12345secret");
  });
  test("Edit / Write：EditInfo；Write 新建（tool_response.type=create）→ created", () => {
    const edit = n({ ...base, hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "/work/proj/src/a.py", old_string: "a", new_string: "b" }, tool_response: { filePath: "/work/proj/src/a.py", structuredPatch: [] } }).events[0];
    expect(edit.edit?.files).toEqual(["/work/proj/src/a.py"]);
    expect(edit.tool?.kind).toBe("edit");
    const w = n({ ...base, hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: "/work/proj/new.py", content: "x" }, tool_response: { type: "create", filePath: "/work/proj/new.py" } }).events[0];
    expect(w.edit?.created).toBe(true);
  });
  test("TodoWrite 是 plan 工具", () => {
    const e = n({ ...base, hook_event_name: "PostToolUse", tool_name: "TodoWrite", tool_input: { todos: [{ content: "改 src/a.py", status: "in_progress", activeForm: "x" }] }, tool_response: "ok" }).events[0];
    expect(e.tool?.kind).toBe("plan");
  });
  test("UserPromptSubmit → prompt(user)；SessionStart/PostModelSwitch → session，带 model", () => {
    expect(n({ ...base, hook_event_name: "UserPromptSubmit", prompt: "fix it" }).events[0]).toMatchObject({ phase: "prompt", origin: "user", text: "fix it" });
    const ss = n({ ...base, hook_event_name: "SessionStart", model: "claude-sonnet-5-5", source: "startup" });
    expect(ss.events[0]).toMatchObject({ phase: "session", model: "claude-sonnet-5-5" });
    expect(ss.model).toBe("claude-sonnet-5-5");
    expect(n({ ...base, hook_event_name: "PostModelSwitch", model: "claude-opus-5-5" }).events[0].model).toBe("claude-opus-5-5");
    expect(ss.hookPoint).toBeNull();
  });
  test("Stop：stop 事件，读 stop_hook_active", () => {
    const a = n({ ...base, hook_event_name: "Stop", stop_hook_active: false });
    expect(a).toMatchObject({ hookPoint: "Stop", stopHookActive: false });
    expect(a.events[0].phase).toBe("stop");
    expect(n({ ...base, hook_event_name: "Stop", stop_hook_active: true }).stopHookActive).toBe(true);
  });
  test("PostToolBatch 只是注入点（没有事件）；PreCompact/PostCompact → compact；未知事件不抛异常", () => {
    const b = n({ ...base, hook_event_name: "PostToolBatch" });
    expect(b.hookPoint).toBe("PostToolBatch");
    expect(b.events).toEqual([]);
    expect(n({ ...base, hook_event_name: "PreCompact" }).events[0].phase).toBe("compact");
    expect(n({ ...base, hook_event_name: "SomethingNew" })).toMatchObject({ hookPoint: null, events: [] });
    expect(n({}).sessionId).toBe("unknown");
  });
  test("seq 单调递增", () => {
    const a = n({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }).events[0].seq;
    const b = n({ ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: "x" }).events[0].seq;
    expect(b).toBeGreaterThan(a);
  });
  test("responseText 各种形态", () => {
    expect(responseText("plain", "Read", {})).toBe("plain");
    expect(responseText({ stdout: "o", stderr: "e" }, "Bash", {})).toBe("o\ne");
    expect(responseText({ output: "x" }, "Task", {})).toBe("x");
    expect(responseText({ file: { content: "file body" } }, "Read", {})).toBe("file body");
    expect(responseText(undefined, "Bash", {})).toBe("");
    expect(responseText({ a: 1 }, "Glob", {})).toBe('{"a":1}');
  });
});
