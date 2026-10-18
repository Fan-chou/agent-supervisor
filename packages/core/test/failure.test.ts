import { describe, expect, test } from "bun:test";
import { classifyFailure, extractTestSummary, parseExitCode } from "../src/failure.ts";

const codex = (code: number | null, body: string) =>
  `Chunk ID: abc123\nWall time: 1.2 seconds\n${code === null ? "Process running with session ID 4" : `Process exited with code ${code}`}\nOriginal token count: 40\nOutput:\n${body}`;

describe("退出码解析（Codex function_call_output 头部）", () => {
  test("Process exited with code N", () => {
    expect(parseExitCode(codex(0, "ok"))).toBe(0);
    expect(parseExitCode(codex(1, "boom"))).toBe(1);
    expect(parseExitCode(codex(127, "x"))).toBe(127);
  });
  test("正文里伪造的字样不算", () => {
    expect(parseExitCode(codex(0, "Process exited with code 9"))).toBe(0);
  });
  test("没有头部时只看开头 600 字符", () => {
    expect(parseExitCode("Exit code: 2\nstuff")).toBe(2);
    expect(parseExitCode("x".repeat(700) + "\nProcess exited with code 3")).toBeUndefined();
  });
});

describe("classifyFailure", () => {
  test("显式 exitCode 优先", () => {
    expect(classifyFailure({ output: "all passed", exitCode: 1 }).status).toBe("fail");
    expect(classifyFailure({ output: "FAILED", exitCode: 0 }).status).toBe("ok");
  });
  test("头部退出码", () => {
    expect(classifyFailure({ output: codex(1, "") })).toMatchObject({ status: "fail", exitCode: 1 });
    expect(classifyFailure({ output: codex(0, "") })).toMatchObject({ status: "ok", exitCode: 0 });
  });
  test("仍在运行 → pending", () => {
    expect(classifyFailure({ output: codex(null, "partial") }).status).toBe("pending");
  });
  const fails = [
    "=== 2 failed, 10 passed in 3.2s ===",
    "FAILED tests/test_a.py::test_x - AssertionError",
    "Tests: 1 failed, 4 passed, 5 total",
    "--- FAIL: TestFoo (0.00s)",
    "FAIL\tgithub.com/x/y\t0.01s",
    "test result: FAILED. 3 passed; 1 failed; 0 ignored",
    "error[E0308]: mismatched types",
    "src/a.ts(3,1): error TS2322: Type 'x'",
    "thread 'main' panicked at src/main.rs:3",
    "bash: foo: command not found",
    "cat: x: No such file or directory",
    "npm ERR! code ELIFECYCLE",
    "Traceback (most recent call last):\n  File \"a.py\", line 1\nValueError: x",
    "Found 3 errors in 2 files",
    "BUILD FAILED in 3s",
  ];
  for (const f of fails) {
    test(`失败: ${f.split("\n")[0].slice(0, 50)}`, () => {
      expect(classifyFailure({ output: f }).status).toBe("fail");
    });
  }
  const passes = [
    "=== 12 passed in 1.1s ===",
    "test result: ok. 12 passed; 0 failed; 0 ignored",
    "ok  \tgithub.com/x/y\t0.012s",
    "Tests: 5 passed, 5 total",
    "  12 passing (30ms)",
    "All checks passed!",
    "Found 0 errors.",
    "BUILD SUCCESSFUL in 2s",
  ];
  for (const p of passes) {
    test(`通过: ${p.slice(0, 50)}`, () => {
      expect(classifyFailure({ output: p }).status).toBe("ok");
    });
  }
  test("失败信号优先于通过信号", () => {
    expect(classifyFailure({ output: "=== 1 failed, 5 passed in 1s ===" }).status).toBe("fail");
  });
  test("弱信号只在测试类命令上采信", () => {
    expect(classifyFailure({ output: "Error: something odd" }).status).toBe("unknown");
    expect(classifyFailure({ output: "Error: something odd", cls: "test_full" }).status).toBe("fail");
    expect(classifyFailure({ output: "Error: something odd", cls: "other" }).status).toBe("unknown");
  });
  test("无信号 → unknown", () => {
    expect(classifyFailure({ output: "hello world" }).status).toBe("unknown");
    expect(classifyFailure({ output: "" }).status).toBe("unknown");
  });
});

describe("extractTestSummary", () => {
  test("pytest", () => {
    expect(extractTestSummary("=== 2 failed, 10 passed, 1 skipped in 3.20s ===")).toMatchObject({ failed: 2, passed: 10, skipped: 1 });
  });
  test("jest", () => {
    expect(extractTestSummary("Tests:       1 failed, 4 passed, 5 total")).toMatchObject({ failed: 1, passed: 4 });
  });
  test("cargo", () => {
    expect(extractTestSummary("test result: ok. 12 passed; 0 failed; 1 ignored; 0 measured")).toMatchObject({ passed: 12, failed: 0, skipped: 1 });
  });
  test("mocha", () => {
    expect(extractTestSummary("  12 passing (30ms)\n  2 failing")).toMatchObject({ passed: 12, failed: 2 });
  });
  test("go", () => {
    expect(extractTestSummary("ok  \ta/b\t0.1s\nFAIL\ta/c\t0.2s")).toMatchObject({ passed: 1, failed: 1 });
  });
  test("无摘要", () => {
    expect(extractTestSummary("nothing")).toBeUndefined();
  });
});
