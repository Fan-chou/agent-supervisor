import { describe, expect, test } from "bun:test";
import { planFromEvent, SessionTracker } from "@sv/core";
import { normalizeCodexHook } from "../src/normalize.ts";
import { localShellInput, parseFunctionArgs, unpackOutput } from "../src/parse.ts";

let seq = 0;
const ctx = { nextSeq: () => seq++, now: 1_700_000_000_000 };
const n = (p: Record<string, unknown>, model?: string) => normalizeCodexHook(p, { ...ctx, model });
const base = { session_id: "cx1", cwd: "/work/proj", transcript_path: "/x/rollout.jsonl", model: "any-model" };

const PATCH = "*** Begin Patch\n*** Update File: src/a.py\n@@\n-x = 1\n+x = 2\n*** Add File: src/new.py\n+print('hi')\n*** End Patch";

describe("Codex hook 载荷 → Event（合成载荷）", () => {
  test("PreToolUse(Bash)：pre 事件，带分类、argsHash；hookPoint=PreToolUse；harness=codex", () => {
    const r = n({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "uv run pytest tests/a.py -q 2>&1 | tail -5" }, tool_use_id: "call_1", turn_id: "t1" });
    expect(r.hookPoint).toBe("PreToolUse");
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ phase: "pre", harness: "codex", sessionId: "cx1", toolUseId: "call_1", cwd: "/work/proj", origin: "agent" });
    expect(r.events[0].shell).toMatchObject({ cls: "test_targeted", normCmd: "pytest tests/a.py -q" });
    expect(r.events[0].tool?.argsHash).toBeTruthy();
  });
  test("exec_command（cmd 字段 + workdir）与 shell（argv 数组）都识别成 shell；缺少 cwd 时退回 workdir", () => {
    const a = n({ session_id: "cx1", hook_event_name: "PreToolUse", tool_name: "exec_command", tool_input: { cmd: "npm test", workdir: "/work/other" }, tool_use_id: "c2" });
    expect(a.events[0].tool?.kind).toBe("shell");
    expect(a.events[0].shell?.cls).toBe("test_full");
    expect(a.cwd).toBe("/work/other");
    expect(a.events[0].cwd).toBe("/work/other");
    const b = n({ ...base, hook_event_name: "PreToolUse", tool_name: "shell", tool_input: { command: ["bash", "-lc", "pytest -q"] }, tool_use_id: "c3" });
    expect(b.events[0].tool?.kind).toBe("shell");
    expect(b.events[0].shell?.normCmd).toBe("pytest -q");
  });
  test("tool_input 是 JSON 字符串也能解析；id 取 tool_use_id，缺失时取 call_id", () => {
    const r = n({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: '{"command":"ls -la"}', call_id: "call_x" });
    expect(r.events[0].shell?.cmd).toBe("ls -la");
    expect(r.events[0].toolUseId).toBe("call_x");
  });
  test("PostToolUse：输出头 `Process exited with code N` → 退出码与 fail；与 Pre 的 argsHash 相同", () => {
    const input = { cmd: "pytest -q" };
    const pre = n({ ...base, hook_event_name: "PreToolUse", tool_name: "exec_command", tool_input: input, tool_use_id: "c4" }).events[0];
    const post = n({ ...base, hook_event_name: "PostToolUse", tool_name: "exec_command", tool_input: input, tool_use_id: "c4", tool_response: "Chunk ID: 1\nWall time: 0.2 seconds\nProcess exited with code 1\nOutput:\nFAILED tests/a.py::t - KeyError: 'x'\n=== 1 failed in 0.1s ===" }).events[0];
    expect(post.phase).toBe("post");
    expect(post.result).toMatchObject({ status: "fail", exitCode: 1 });
    expect(post.result?.errFingerprint).toBeTruthy();
    expect(post.tool?.argsHash).toBe(pre.tool?.argsHash);
    expect(post.toolUseId).toBe("c4");
    const ok = n({ ...base, hook_event_name: "PostToolUse", tool_name: "exec_command", tool_input: input, tool_response: "Process exited with code 0\nOutput:\n=== 3 passed in 0.1s ===" }).events[0];
    expect(ok.result).toMatchObject({ status: "ok", exitCode: 0 });
  });
  test("PostToolUse：JSON 字符串形态 {output, metadata.exit_code} 也能回填退出码", () => {
    const e = n({ ...base, hook_event_name: "PostToolUse", tool_name: "shell", tool_input: { command: ["bash", "-lc", "make"] }, tool_response: JSON.stringify({ output: "boom", metadata: { exit_code: 2, duration_seconds: 0.1 } }) }).events[0];
    expect(e.result).toMatchObject({ status: "fail", exitCode: 2 });
  });
  test("PostToolUse：没有退出码头 → 交给 FailureClassifier（强失败信号判 fail；无信号是 unknown，不默认成功）", () => {
    const fail = n({ ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "pytest" }, tool_response: "FAILED tests/a.py::t\n=== 2 failed, 1 passed in 0.3s ===" }).events[0];
    expect(fail.result?.status).toBe("fail");
    expect(fail.result?.exitCode).toBeUndefined();
    const none = n({ ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: "a.txt\nb.txt" }).events[0];
    expect(none.result?.status).toBe("unknown");
    const empty = n({ ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" } }).events[0];
    expect(empty.result?.status).toBe("unknown");
  });
  test("PostToolUse：命令仍在运行（Process running with session ID）→ pending，不当成功也不当失败", () => {
    const e = n({ ...base, hook_event_name: "PostToolUse", tool_name: "exec_command", tool_input: { cmd: "npm run build" }, tool_response: "Chunk ID: 1\nWall time: 1.0 seconds\nProcess running with session ID 7\nOutput:\nbuilding..." }).events[0];
    expect(e.result?.status).toBe("pending");
  });
  test("apply_patch：字符串形态与 {command:['apply_patch', patch]} 形态都识别成 edit 并解析出文件", () => {
    const a = n({ ...base, hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_input: PATCH, tool_response: "Success. Updated the following files:\nM src/a.py\nA src/new.py" }).events[0];
    expect(a.tool?.kind).toBe("edit");
    expect(a.edit?.files).toEqual(["src/a.py", "src/new.py"]);
    const b = n({ ...base, hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: ["apply_patch", PATCH] } }).events[0];
    expect(b.tool?.kind).toBe("edit");
    expect(b.edit?.files ?? b.tool?.input).toBeTruthy();
    const post = n({ ...base, hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_input: { command: ["apply_patch", PATCH] }, tool_response: "Success" }).events[0];
    expect(post.edit?.files).toEqual(["src/a.py", "src/new.py"]);
    expect(post.edit?.addedLines).toBeGreaterThan(0);
  });
  test("通过 shell 调 apply_patch（heredoc）也识别成 edit", () => {
    const e = n({ ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: `apply_patch <<'EOF'\n${PATCH}\nEOF` }, tool_response: "Success" }).events[0];
    expect(e.tool?.kind).toBe("edit");
    expect(e.edit?.files).toContain("src/a.py");
  });
  test("update_plan：kind=plan，tracker 的计划被更新（如果钩子收得到它——§16.2 仍待真机确认）", () => {
    const plan = { plan: [{ step: "改 src/a.py", status: "in_progress" }, { step: "跑测试", status: "pending" }] };
    const e = n({ ...base, hook_event_name: "PostToolUse", tool_name: "update_plan", tool_input: plan, tool_response: "Plan updated" }).events[0];
    expect(e.tool?.kind).toBe("plan");
    expect(planFromEvent(e)?.items.map((i) => i.text)).toEqual(["改 src/a.py", "跑测试"]);
    const tr = new SessionTracker();
    tr.ingest(n({ ...base, hook_event_name: "PreToolUse", tool_name: "update_plan", tool_input: plan }).events[0]);
    tr.ingest(e);
    expect(tr.plan?.items[0].status).toBe("in_progress");
  });
  test("输出里的密钥被脱敏", () => {
    const e = n({ ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "env" }, tool_response: "Process exited with code 1\nAPI_KEY=abc12345secretvalue\nboom" }).events[0];
    expect(e.result?.outputHead).not.toContain("abc12345secretvalue");
  });
  test("UserPromptSubmit → prompt(user)；SessionStart → session 带 model；Interrupt → interrupt；PreCompact → compact", () => {
    expect(n({ ...base, hook_event_name: "UserPromptSubmit", prompt: "fix it" }).events[0]).toMatchObject({ phase: "prompt", origin: "user", text: "fix it", harness: "codex" });
    expect(n({ ...base, hook_event_name: "SessionStart", source: "startup" }).events[0]).toMatchObject({ phase: "session", model: "any-model" });
    expect(n({ ...base, hook_event_name: "Interrupt" }).events[0].phase).toBe("interrupt");
    expect(n({ ...base, hook_event_name: "PreCompact" }).events[0].phase).toBe("compact");
  });
  test("Stop：stop 事件 + stop_hook_active 透传", () => {
    const r = n({ ...base, hook_event_name: "Stop", stop_hook_active: true, last_assistant_message: "done" });
    expect(r.hookPoint).toBe("Stop");
    expect(r.events[0].phase).toBe("stop");
    expect(r.stopHookActive).toBe(true);
    expect(n({ ...base, hook_event_name: "Stop" }).stopHookActive).toBe(false);
  });
  test("Codex 没有的注入点（PostToolUseFailure / PostToolBatch）与其他事件：hookPoint=null，不产生事件，不抛异常", () => {
    for (const name of ["PostToolUseFailure", "PostToolBatch", "PermissionRequest", "SubagentStart", "SessionEnd", "SomethingNew"]) {
      expect(n({ ...base, hook_event_name: name, tool_name: "Bash", tool_input: { command: "ls" } }), name).toMatchObject({ hookPoint: null, events: [] });
    }
    expect(n({}).sessionId).toBe("unknown");
    expect(() => n({ hook_event_name: "PreToolUse" })).not.toThrow();
  });
  test("模型名只进日志：换任意模型名，除 model 字段外事件完全一致", () => {
    const mk = (model: string) => {
      let s = 0;
      return normalizeCodexHook({ ...base, model, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "pytest -q" }, tool_use_id: "z", tool_response: "Process exited with code 1\n1 failed" }, { nextSeq: () => s++, now: 5 }).events[0];
    };
    const strip = (e: ReturnType<typeof mk>) => ({ ...e, model: undefined });
    expect(strip(mk("gpt-x"))).toEqual(strip(mk("some-other-model")));
    expect(mk("gpt-x").model).toBe("gpt-x");
  });
  test("seq 单调递增", () => {
    const a = n({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }).events[0].seq;
    const b = n({ ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: "x" }).events[0].seq;
    expect(b).toBeGreaterThan(a);
  });
});

describe("共享解析（replay 与 hook 共用）", () => {
  test("unpackOutput / parseFunctionArgs / localShellInput", () => {
    expect(unpackOutput('{"output":"hi","metadata":{"exit_code":2}}')).toEqual({ text: "hi", exitCode: 2 });
    expect(unpackOutput("plain")).toEqual({ text: "plain" });
    expect(unpackOutput(undefined)).toEqual({ text: "" });
    expect(parseFunctionArgs('{"cmd":"ls"}')).toEqual({ cmd: "ls" });
    expect(parseFunctionArgs("not json")).toEqual({ raw: "not json" });
    expect(parseFunctionArgs({ a: 1 })).toEqual({ a: 1 });
    expect(localShellInput({ command: ["bash", "-lc", "ls"] })).toEqual({ command: ["bash", "-lc", "ls"] });
    expect(localShellInput(undefined)).toEqual({ command: [] });
  });
});
