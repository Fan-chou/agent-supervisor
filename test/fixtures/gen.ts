#!/usr/bin/env bun
// 合成 transcript 生成器。所有样本都是手工构造的，不含任何真实会话数据。
// 运行：bun test/fixtures/gen.ts   （输出到 test/fixtures/claude/ 和 test/fixtures/codex/）
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = dirname(new URL(import.meta.url).pathname);
const T0 = Date.parse("2026-10-18T10:00:00.000Z");
const iso = (sec: number) => new Date(T0 + sec * 1000).toISOString();

const PYFAIL = (n: number) => `============================= test session starts ==============================
collected 3 items

tests/test_parser.py F                                                   [ 33%]

=================================== FAILURES ===================================
E       AssertionError: assert parse('a,b') == ['a', 'b']
E        +  where ['a,b'] = parse('a,b')
tests/test_parser.py:${10 + n}: AssertionError
=========================== short test summary info ============================
FAILED tests/test_parser.py::test_split - AssertionError: assert parse('a,b') == ...
========================= 1 failed, 2 passed in 0.0${n}s =========================`;
const PYPASS = "============================= 3 passed in 0.04s =============================";

// ---------------- Claude Code ----------------
class Claude {
  lines: object[] = [];
  n = 0;
  constructor(private sessionId: string, private cwd = "/work/proj", private model = "claude-sonnet-5-5") {}
  private base(t: number, extra: object = {}) {
    return { sessionId: this.sessionId, uuid: `u${this.n++}`, timestamp: iso(t), cwd: this.cwd, ...extra };
  }
  prompt(t: number, text: string) {
    this.lines.push({ type: "user", ...this.base(t), message: { role: "user", content: text } });
  }
  raw(o: object) {
    this.lines.push(o);
  }
  call(t: number, id: string, name: string, input: object, result: string, opts: { err?: boolean; dt?: number; arrayContent?: boolean } = {}) {
    this.lines.push({
      type: "assistant",
      ...this.base(t),
      message: { role: "assistant", model: this.model, content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use", usage: { input_tokens: 1000 + this.n * 50, output_tokens: 80, cache_read_input_tokens: 4000 } },
    });
    const content = opts.arrayContent ? [{ type: "text", text: result }] : result;
    this.lines.push({ type: "user", ...this.base(t + (opts.dt ?? 2)), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, ...(opts.err ? { is_error: true } : {}) }] } });
  }
  final(t: number, text: string) {
    this.lines.push({ type: "assistant", ...this.base(t), message: { role: "assistant", model: this.model, content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 2000, output_tokens: 60 } } });
  }
  dump(name: string) {
    const p = join(ROOT, "claude", name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, this.lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }
}

{
  // 1) 修复后一次通过：不应该有任何 M/H 命中
  const c = new Claude("claude-success");
  c.prompt(0, "修复 parser 里按逗号切分的 bug");
  c.call(5, "t1", "Read", { file_path: "/work/proj/src/parser.py" }, "def parse(s): return [s]");
  c.call(12, "t2", "Edit", { file_path: "/work/proj/src/parser.py", old_string: "return [s]", new_string: "return s.split(',')" }, "The file /work/proj/src/parser.py has been updated.");
  c.call(20, "t3", "Bash", { command: "uv run pytest tests/test_parser.py -q 2>&1 | tail -20" }, PYPASS);
  c.final(25, "已修复，测试通过。");
  c.dump("success.jsonl");
}
{
  // 2) 同一失败命令在工作区没变的情况下重复 3 次 → L1（M），第 3 次尝试 → H
  const c = new Claude("claude-fail-loop");
  c.prompt(0, "fix the failing test in tests/test_parser.py");
  c.call(5, "t1", "Read", { file_path: "/work/proj/src/parser.py" }, "def parse(s): return [s]");
  c.call(10, "t2", "Bash", { command: "pytest tests/test_parser.py" }, "Exit code 1\n" + PYFAIL(1), { err: true });
  c.call(20, "t3", "Bash", { command: "pytest tests/test_parser.py" }, "Exit code 1\n" + PYFAIL(2), { err: true });
  c.call(30, "t4", "Bash", { command: "pytest tests/test_parser.py" }, "Exit code 1\n" + PYFAIL(3), { err: true });
  c.call(40, "t5", "Bash", { command: "pytest tests/test_parser.py -x" }, "Exit code 1\n" + PYFAIL(4), { err: true });
  c.final(50, "测试仍然失败。");
  c.dump("fail-loop.jsonl");
}
{
  // 3) X1 + X2 + P3：加 skip、改 .env、reset --hard，最后没跑测试就宣布完成
  const c = new Claude("claude-cheat-danger", "/Users/jack/proj");
  c.prompt(0, "fix the failing test");
  c.call(5, "t1", "Bash", { command: "pytest" }, "Exit code 1\n" + PYFAIL(1), { err: true });
  c.call(15, "t2", "Edit", { file_path: "/Users/jack/proj/tests/test_parser.py", old_string: "def test_split():\n    assert parse('a,b') == ['a', 'b']", new_string: "@pytest.mark.skip\ndef test_split():\n    assert parse('a,b') == ['a', 'b']" }, "The file has been updated.");
  c.call(25, "t3", "Write", { file_path: "/Users/jack/proj/.env", content: "API_KEY=abc" }, "File created successfully at: /Users/jack/proj/.env");
  c.call(35, "t4", "Bash", { command: "git reset --hard HEAD~1" }, "HEAD is now at abc123 previous");
  c.final(45, "完成。");
  c.dump("cheat-danger.jsonl");
}
{
  // 4) 编辑之后连续 14 步只读（S1 M）
  const c = new Claude("claude-readonly-stall");
  c.prompt(0, "implement the retry logic in src/client.py");
  c.call(5, "t0", "Edit", { file_path: "/work/proj/src/client.py", old_string: "pass", new_string: "retry()" }, "ok");
  for (let i = 1; i <= 14; i++) c.call(5 + i * 8, `g${i}`, "Grep", { pattern: `retry${i}` }, `src/x${i}.py:1: retry`);
  c.final(200, "还在看。");
  c.dump("readonly-stall.jsonl");
}
{
  // 5) 杂项：TodoWrite 计划、被忽略的 meta 行、中断、压缩摘要、sidechain、损坏行、数组形式 content
  const c = new Claude("claude-misc");
  c.raw({ type: "summary", summary: "earlier work", leafUuid: "x" });
  c.raw({ type: "user", ...{ sessionId: "claude-misc", uuid: "m1", timestamp: iso(0), cwd: "/work/proj" }, isMeta: true, message: { role: "user", content: "<local-command-caveat>ignored</local-command-caveat>" } });
  c.prompt(1, "improve error messages in src/errors.py");
  c.call(3, "p1", "TodoWrite", { todos: [{ content: "修改 src/errors.py 里的消息", status: "in_progress", activeForm: "修改中" }, { content: "跑测试", status: "pending", activeForm: "跑测试" }] }, "Todos have been modified successfully");
  c.call(6, "e1", "Edit", { file_path: "/work/proj/src/billing.py", old_string: "a", new_string: "b" }, "ok");
  c.raw({ type: "assistant", sessionId: "claude-misc", uuid: "sc1", timestamp: iso(8), isSidechain: true, message: { role: "assistant", model: "claude-haiku-5-5", content: [{ type: "tool_use", id: "sc_t", name: "Bash", input: { command: "rm -rf ~" } }], stop_reason: "tool_use" } });
  c.call(10, "r1", "Read", { file_path: "/work/proj/src/errors.py" }, "class E(Exception): pass", { arrayContent: true });
  c.prompt(14, "[Request interrupted by user]");
  c.raw({ type: "user", sessionId: "claude-misc", uuid: "cs", timestamp: iso(16), cwd: "/work/proj", isCompactSummary: true, message: { role: "user", content: "This session is being continued from a previous conversation..." } });
  c.lines.push("{this is not json" as unknown as object); // 故意写一行损坏的 JSON
  c.final(20, "好了。");
  const p = join(ROOT, "claude", "misc.jsonl");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, c.lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
}

// ---------------- Codex ----------------
class Codex {
  lines: object[] = [];
  constructor(sessionId: string, cwd = "/work/proj", model = "gpt-5-codex") {
    this.lines.push({ timestamp: iso(0), type: "session_meta", payload: { id: sessionId, cwd, originator: "codex_cli", cli_version: "0.163.0" } });
    this.lines.push({ timestamp: iso(0), type: "turn_context", payload: { cwd, model } });
  }
  private rec(t: number, type: string, payload: object) {
    this.lines.push({ timestamp: iso(t), type, payload });
  }
  prompt(t: number, text: string) {
    this.rec(t, "response_item", { type: "message", role: "user", content: [{ type: "input_text", text }] });
  }
  env(t: number) {
    this.rec(t, "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n<cwd>/work/proj</cwd>\n</environment_context>" }] });
  }
  shell(t: number, id: string, cmd: string, out: string, code: number | null, wall = "0.4") {
    this.rec(t, "response_item", { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", cmd], workdir: "/work/proj" }), call_id: id });
    const head = code === null ? `Process running with session ID 7` : `Process exited with code ${code}`;
    this.rec(t + 1, "response_item", { type: "function_call_output", call_id: id, output: `Chunk ID: ${id}\nWall time: ${wall} seconds\n${head}\nOriginal token count: 30\nOutput:\n${out}` });
  }
  execCommand(t: number, id: string, cmd: string, out: string, code: number | null) {
    this.rec(t, "response_item", { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd, workdir: "/work/proj", yield_time_ms: 1000 }), call_id: id });
    const head = code === null ? `Process running with session ID 7` : `Process exited with code ${code}`;
    this.rec(t + 1, "response_item", { type: "function_call_output", call_id: id, output: `Chunk ID: ${id}\nWall time: 1.0 seconds\n${head}\nOriginal token count: 10\nOutput:\n${out}` });
  }
  writeStdin(t: number, id: string, sid: number, out: string, code: number) {
    this.rec(t, "response_item", { type: "function_call", name: "write_stdin", arguments: JSON.stringify({ session_id: sid, chars: "" }), call_id: id });
    this.rec(t + 1, "response_item", { type: "function_call_output", call_id: id, output: `Chunk ID: ${id}\nWall time: 9.0 seconds\nProcess exited with code ${code}\nOriginal token count: 30\nOutput:\n${out}` });
  }
  legacyShell(t: number, id: string, cmd: string, out: string, code: number) {
    this.rec(t, "response_item", { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", cmd] }), call_id: id });
    this.rec(t + 1, "response_item", { type: "function_call_output", call_id: id, output: JSON.stringify({ output: out, metadata: { exit_code: code, duration_seconds: 0.2 } }) });
  }
  patch(t: number, id: string, patch: string) {
    this.rec(t, "response_item", { type: "custom_tool_call", name: "apply_patch", input: patch, call_id: id });
    this.rec(t + 1, "response_item", { type: "custom_tool_call_output", call_id: id, output: JSON.stringify({ output: "Success. Updated the following files:\nM src/parser.py", metadata: { exit_code: 0 } }) });
  }
  plan(t: number, id: string, items: [string, string][]) {
    this.rec(t, "response_item", { type: "function_call", name: "update_plan", arguments: JSON.stringify({ plan: items.map(([step, status]) => ({ step, status })) }), call_id: id });
    this.rec(t + 1, "response_item", { type: "function_call_output", call_id: id, output: "Plan updated" });
  }
  done(t: number) {
    this.rec(t, "event_msg", { type: "task_complete" });
  }
  abort(t: number) {
    this.rec(t, "event_msg", { type: "turn_aborted" });
  }
  dump(name: string) {
    const p = join(ROOT, "codex", name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, this.lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }
}

{
  // GPT 过度测试：改了一次，然后反复跑同一条全量测试
  const c = new Codex("codex-overtest");
  c.env(0);
  c.prompt(1, "fix the bug in the parser");
  c.plan(3, "c0", [["修改 src/parser.py 里的切分逻辑", "in_progress"], ["验证", "pending"]]);
  c.shell(6, "c1", "sed -n '1,40p' src/parser.py", "def parse(s): return [s]", 0);
  c.patch(10, "c2", "*** Begin Patch\n*** Update File: src/parser.py\n@@\n-def parse(s): return [s]\n+def parse(s): return s.split(',')\n*** End Patch");
  for (let i = 0; i < 5; i++) c.shell(20 + i * 15, `c${3 + i}`, "pytest -q", "3 passed in 0.04s", 0);
  c.shell(110, "c8", "python -c \"import parser; print(parser.parse('a,b'))\"", "['a', 'b']", 0);
  c.done(120);
  c.dump("overtest-gpt.jsonl");
}
{
  // 退出码回填：exec_command 先返回 "Process running with session ID 7"，write_stdin 轮询拿到最终退出码 1
  const c = new Codex("codex-backfill");
  c.env(0);
  c.prompt(1, "run the build");
  c.execCommand(5, "b1", "npm run build", "building...", null);
  c.writeStdin(20, "b2", 7, "error TS2322: Type 'string' is not assignable to type 'number'.", 1);
  c.legacyShell(30, "b3", "ls src", "a.ts\nb.ts", 0);
  c.legacyShell(35, "b4", "pytest -q", "FAILED tests/test_a.py::test_x - assert 1 == 2\n1 failed in 0.1s", 1);
  c.done(40);
  c.dump("backfill.jsonl");
}
{
  // Codex 失败循环：同一命令退出码 1、错误相同、期间没有改动
  const c = new Codex("codex-fail-loop");
  c.env(0);
  c.prompt(1, "make the tests pass");
  for (let i = 0; i < 4; i++) c.shell(10 + i * 20, `f${i}`, "cargo test", `thread 'parse::tests::split' panicked at src/lib.rs:${40 + i}:5:\nassertion failed: left == right\ntest result: FAILED. 2 passed; 1 failed; 0 ignored`, 101);
  c.abort(95);
  c.done(100);
  c.dump("fail-loop.jsonl");
}

console.log("fixtures written to", ROOT);
