import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Event } from "@sv/core";
import { detectFormat, readClaudeTranscript, readCodexRollout, readEvents, unpackOutput } from "../src/index.ts";

const FX = join(import.meta.dir, "../../../test/fixtures");
const load = (p: string) => readFileSync(join(FX, p), "utf8");
const posts = (es: Event[]) => es.filter((e) => e.phase === "post");
const pres = (es: Event[]) => es.filter((e) => e.phase === "pre");

describe("Claude Code 读取器", () => {
  test("格式识别", () => {
    expect(detectFormat(load("claude/success.jsonl"))).toBe("claude");
    expect(detectFormat(load("codex/overtest-gpt.jsonl"))).toBe("codex");
    expect(detectFormat("hello\nworld")).toBe("unknown");
    expect(() => readEvents("hello")).toThrow();
  });
  test("success：事件序列 session → prompt → (pre,post)×3 → stop", () => {
    const es = readClaudeTranscript(load("claude/success.jsonl"));
    expect(es.map((e) => e.phase)).toEqual(["session", "prompt", "pre", "post", "pre", "post", "pre", "post", "stop"]);
    expect(es[0].sessionId).toBe("claude-success");
    expect(es[0].cwd).toBe("/work/proj");
    expect(es[1].origin).toBe("user");
    expect(es[1].text).toContain("parser");
    // seq 单调递增
    expect(es.map((e) => e.seq)).toEqual(es.map((_, i) => i));
    expect(es.every((e, i) => i === 0 || e.ts >= es[i - 1].ts)).toBe(true);
  });
  test("pre/post 用 toolUseId 配对；model 来自 assistant 消息", () => {
    const es = readClaudeTranscript(load("claude/success.jsonl"));
    const ids = pres(es).map((e) => e.toolUseId);
    expect(posts(es).map((e) => e.toolUseId)).toEqual(ids);
    expect(pres(es)[0].model).toBe("claude-sonnet-5-5");
  });
  test("Bash：命令分类、normCmd 剥壳、测试摘要", () => {
    const es = readClaudeTranscript(load("claude/success.jsonl"));
    const bash = posts(es).find((e) => e.tool?.name === "Bash")!;
    expect(bash.shell?.cls).toBe("test_targeted");
    expect(bash.shell?.normCmd).toBe("pytest tests/test_parser.py -q");
    expect(bash.result?.status).toBe("ok");
    expect(bash.result?.testSummary?.passed).toBe(3);
  });
  test("is_error → fail，退出码取自 'Exit code N'，errFingerprint 稳定", () => {
    const es = readClaudeTranscript(load("claude/fail-loop.jsonl"));
    const fails = posts(es).filter((e) => e.result?.status === "fail");
    expect(fails).toHaveLength(4);
    expect(fails[0].result?.exitCode).toBe(1);
    // 三次完全相同的失败（只有行号/耗时数字不同）→ 同一指纹
    expect(new Set(fails.slice(0, 3).map((e) => e.result?.errFingerprint)).size).toBe(1);
    expect(fails[3].result?.errFingerprint).toBe(fails[0].result?.errFingerprint);
    expect(fails[0].tool?.argsHash).toBe(fails[1].tool?.argsHash);
  });
  test("Edit / Write 的 EditInfo", () => {
    const es = readClaudeTranscript(load("claude/cheat-danger.jsonl"));
    const edit = posts(es).find((e) => e.tool?.name === "Edit")!;
    expect(edit.edit?.files).toEqual(["/Users/jack/proj/tests/test_parser.py"]);
    expect(edit.edit?.newText).toContain("pytest.mark.skip");
    expect(edit.edit?.contentHashes).toBeTruthy();
    const write = posts(es).find((e) => e.tool?.name === "Write")!;
    expect(write.edit?.created).toBe(true); // 来自 "File created successfully"
  });
  test("misc：meta 行/压缩摘要/中断/sidechain/损坏行/数组 content", () => {
    const es = readClaudeTranscript(load("claude/misc.jsonl"));
    const phases = es.map((e) => e.phase);
    expect(phases.filter((p) => p === "prompt")).toHaveLength(1); // meta 行和中断文本不算 prompt
    expect(phases).toContain("interrupt");
    expect(phases).toContain("compact");
    expect(es.some((e) => e.tool?.name === "Bash")).toBe(false); // sidechain 的 rm -rf ~ 被丢弃
    const read = posts(es).find((e) => e.tool?.name === "Read")!;
    expect(read.result?.outputHead).toContain("class E");
    expect(es.at(-1)?.phase).toBe("stop");
    // 可以选择保留 sidechain
    const all = readClaudeTranscript(load("claude/misc.jsonl"), { includeSidechains: true });
    expect(all.some((e) => e.tool?.name === "Bash" && e.agentId)).toBe(true);
  });
  test("TodoWrite 被识别为 plan 工具", () => {
    const es = readClaudeTranscript(load("claude/misc.jsonl"));
    expect(posts(es).find((e) => e.tool?.name === "TodoWrite")?.tool?.kind).toBe("plan");
  });
  test("输出落盘前已脱敏", () => {
    const text = JSON.stringify({ type: "assistant", sessionId: "s", timestamp: "2026-10-18T10:00:00Z", message: { role: "assistant", content: [{ type: "tool_use", id: "x", name: "Bash", input: { command: "env" } }] } }) + "\n" +
      JSON.stringify({ type: "user", sessionId: "s", timestamp: "2026-10-18T10:00:01Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456\nok" }] } });
    const es = readClaudeTranscript(text);
    const post = posts(es)[0];
    expect(post.result?.outputHead).not.toContain("sk-abcdefghij");
    expect(post.result?.outputHead).toContain("REDACTED");
  });
  test("空文件/只有损坏行不抛异常", () => {
    expect(readClaudeTranscript("").length).toBe(1);
    expect(readClaudeTranscript("{oops\n{also bad").length).toBe(1);
  });
});

describe("Codex 读取器", () => {
  test("session_meta / environment_context / task_complete", () => {
    const es = readCodexRollout(load("codex/overtest-gpt.jsonl"));
    expect(es[0].phase).toBe("session");
    expect(es[0].sessionId).toBe("codex-overtest");
    expect(es[0].model).toBe("gpt-5-codex");
    expect(es.filter((e) => e.phase === "prompt")).toHaveLength(1); // <environment_context> 不算 prompt
    expect(es.at(-1)?.phase).toBe("stop");
  });
  test("从 function_call_output 头部回填退出码", () => {
    const es = readCodexRollout(load("codex/fail-loop.jsonl"));
    const bash = posts(es).filter((e) => e.shell);
    expect(bash).toHaveLength(4);
    expect(bash[0].result?.exitCode).toBe(101);
    expect(bash[0].result?.status).toBe("fail");
    expect(bash[0].shell?.cmd).toBe("cargo test");
    expect(bash[0].shell?.cls).toBe("test_full");
    expect(new Set(bash.map((e) => e.result?.errFingerprint)).size).toBe(1);
    expect(es.some((e) => e.phase === "interrupt")).toBe(true);
  });
  test("exit code 0 → ok；shell 的 command 数组形式取最后一个元素", () => {
    const es = readCodexRollout(load("codex/overtest-gpt.jsonl"));
    const run = posts(es).filter((e) => e.shell?.normCmd === "pytest -q");
    expect(run).toHaveLength(5);
    expect(run.every((e) => e.result?.status === "ok" && e.result.exitCode === 0)).toBe(true);
  });
  test("apply_patch（custom_tool_call）→ edit 事件，含内容哈希", () => {
    const es = readCodexRollout(load("codex/overtest-gpt.jsonl"));
    const patch = posts(es).find((e) => e.tool?.name === "apply_patch")!;
    expect(patch.tool?.kind).toBe("edit");
    expect(patch.edit?.files).toEqual(["src/parser.py"]);
    expect(patch.edit?.contentHashes?.["src/parser.py"]).toBeTruthy();
  });
  test("update_plan → plan 工具", () => {
    const es = readCodexRollout(load("codex/overtest-gpt.jsonl"));
    expect(posts(es).find((e) => e.tool?.name === "update_plan")?.tool?.kind).toBe("plan");
  });
  test("长时间运行的命令：先 pending，再由 write_stdin 的 Process exited with code 回填", () => {
    const es = readCodexRollout(load("codex/backfill.jsonl"));
    const build = posts(es).find((e) => e.shell?.cmd === "npm run build")!;
    expect(build.result?.status).toBe("fail");
    expect(build.result?.exitCode).toBe(1);
    expect(build.result?.outputHead).toContain("TS2322");
    expect(build.shell?.cls).toBe("build");
    // write_stdin 本身也是一条调用
    expect(posts(es).some((e) => e.tool?.name === "write_stdin")).toBe(true);
  });
  test("旧格式：output 是 JSON 字符串，退出码在 metadata.exit_code", () => {
    const es = readCodexRollout(load("codex/backfill.jsonl"));
    const t = posts(es).find((e) => e.shell?.cmd === "pytest -q")!;
    expect(t.result?.exitCode).toBe(1);
    expect(t.result?.status).toBe("fail");
    expect(posts(es).find((e) => e.shell?.cmd === "ls src")?.result?.status).toBe("ok");
    expect(unpackOutput('{"output":"hi","metadata":{"exit_code":2}}')).toEqual({ text: "hi", exitCode: 2 });
    expect(unpackOutput("plain")).toEqual({ text: "plain" });
    expect(unpackOutput({ content: "x" }).text).toBe("x");
  });
  test("没有 post 的 pre（输出缺失）不会崩", () => {
    const text = JSON.stringify({ timestamp: "2026-10-18T10:00:00Z", type: "response_item", payload: { type: "function_call", name: "shell", arguments: '{"command":["bash","-lc","ls"]}', call_id: "z" } });
    const es = readCodexRollout(text);
    expect(pres(es)).toHaveLength(1);
    expect(posts(es)).toHaveLength(0);
  });
});
