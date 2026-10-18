// FailureClassifier：从输出文本推断 failed / passed / unknown（Codex 没有可靠退出码时用，design §3.2）。
// Claude 一侧不需要，PostToolUseFailure 已经给出 `Exit code N`。
import type { CmdClass, ResultStatus, TestSummary } from "./event.ts";

export interface FailureVerdict {
  status: ResultStatus; // ok | fail | unknown | pending
  exitCode?: number;
  /** 判定依据，便于调试和回放对账。 */
  reason: string;
}

const HEADER_EXIT = [
  /Process exited with code (-?\d+)/,
  /^\s*Exit code:?\s*(-?\d+)\s*$/m,
  /^\s*\[?exit(?:ed)?(?: with)? code[:\s]+(-?\d+)\]?\s*$/im,
  /Command exited with (?:non-zero )?(?:status|code)[:\s]+(-?\d+)/i,
];

/** Codex 的 function_call_output 头部（Output: 之前）才可信，正文里出现的同名字样不算。 */
export function headerOf(text: string): string {
  const m = /^Output:\s*$/m.exec(text);
  const cut = m ? m.index : Math.min(text.length, 600);
  return text.slice(0, cut);
}

export function parseExitCode(text: string): number | undefined {
  const head = headerOf(text);
  for (const re of HEADER_EXIT) {
    const m = re.exec(head);
    if (m) return Number(m[1]);
  }
  return undefined;
}

const STILL_RUNNING = /Process running with session ID\s+\S+/;

const FAIL_STRONG: [RegExp, string][] = [
  [/^=+\s.*\b[1-9]\d* (failed|error)s?\b/im, "pytest-summary-failed"],
  [/^FAILED\s+\S+/m, "pytest-FAILED-line"],
  [/\b[1-9]\d* failed\b/i, "n-failed"],
  [/Tests?:\s+.*\b[1-9]\d* failed\b/, "jest-failed"],
  [/Test Suites?:\s+.*\b[1-9]\d* failed\b/, "jest-suites-failed"],
  [/^--- FAIL:/m, "go-test-FAIL"],
  [/^FAIL\s+\S+/m, "FAIL-line"],
  [/test result: FAILED\./, "cargo-test-FAILED"],
  [/error\[E\d{4}\]/, "rustc-error"],
  [/\berror TS\d+:/, "tsc-error"],
  [/panicked at /, "panic"],
  [/command not found|: not found$/m, "command-not-found"],
  [/No such file or directory/, "enoent"],
  [/Permission denied/, "eacces"],
  [/^npm ERR!/m, "npm-err"],
  [/Traceback \(most recent call last\)/, "python-traceback"],
  [/\bAssertionError\b/, "assertion-error"],
  [/Found [1-9]\d* errors?\b/, "type-errors"],
  [/\bBUILD FAILED\b|\bCompilation failed\b|\bcompilation terminated\b/i, "build-failed"],
  [/Segmentation fault|core dumped/, "crash"],
];

const PASS_STRONG: [RegExp, string][] = [
  [/test result: ok\./, "cargo-test-ok"],
  [/^ok\s+\S+\s+[\d.]+s/m, "go-test-ok"],
  [/^=+\s.*\b\d+ passed\b(?!.*\b(failed|error))/im, "pytest-passed"],
  [/Tests?:\s+(?:\d+ skipped, )?\d+ passed, \d+ total/, "jest-passed"],
  [/\b\d+ passing\b(?!.*\bfailing)/, "mocha-passing"],
  [/^\s*0 errors?\b/m, "zero-errors"],
  [/All checks passed!|no issues found|Found 0 errors|✔ No issues found/i, "lint-clean"],
  [/Tests\s+\d+ passed/, "vitest-passed"],
  [/BUILD SUCCESSFUL|Compiled successfully|Build succeeded/i, "build-ok"],
];

/** 弱信号：普通脚本里也常出现，只在命令类别为测试/构建类时才采信。 */
const FAIL_WEAK: [RegExp, string][] = [
  [/^\s*(Error|ERROR|error):/m, "Error-line"],
  [/\bFAILED\b/, "FAILED-word"],
  [/\bfailed\b/i, "failed-word"],
  [/✗|✖|×\s/, "cross-mark"],
  [/Exception\b/, "exception"],
];

const VERIFY_CLASSES = new Set<CmdClass>(["test_full", "test_targeted", "build", "lint", "typecheck", "smoke_script", "repro_script"]);

export interface ClassifyInput {
  output: string;
  exitCode?: number;
  cls?: CmdClass;
}

export function classifyFailure(input: ClassifyInput): FailureVerdict {
  const { output, cls } = input;
  if (input.exitCode !== undefined) {
    return { status: input.exitCode === 0 ? "ok" : "fail", exitCode: input.exitCode, reason: "exit-code" };
  }
  const code = parseExitCode(output);
  if (code !== undefined) return { status: code === 0 ? "ok" : "fail", exitCode: code, reason: "header-exit-code" };
  if (STILL_RUNNING.test(headerOf(output))) return { status: "pending", reason: "still-running" };

  for (const [re, name] of FAIL_STRONG) if (re.test(output)) return { status: "fail", reason: name };
  for (const [re, name] of PASS_STRONG) if (re.test(output)) return { status: "ok", reason: name };
  if (cls && VERIFY_CLASSES.has(cls)) {
    for (const [re, name] of FAIL_WEAK) if (re.test(output)) return { status: "fail", reason: name };
  }
  return { status: "unknown", reason: "no-signal" };
}

/** 抽取测试摘要（passed/failed/skipped/errors）。取不到返回 undefined。 */
export function extractTestSummary(output: string): TestSummary | undefined {
  const s: TestSummary = {};
  let raw: string | undefined;
  const num = (re: RegExp) => {
    const m = re.exec(output);
    return m ? Number(m[1]) : undefined;
  };
  // pytest / vitest / jest 风格： "3 failed, 10 passed, 2 skipped"
  const py = /^=*\s*((?:\d+ (?:failed|passed|skipped|error|errors|xfailed|xpassed|warnings?|deselected)(?:, | and )?)+)\s*(?:in [\d.]+s.*)?=*$/im.exec(output);
  if (py) {
    raw = py[0].replace(/=/g, "").trim();
    s.passed = num(/(\d+) passed/);
    s.failed = num(/(\d+) failed/);
    s.skipped = num(/(\d+) skipped/);
    s.errors = num(/(\d+) errors?\b/);
  } else {
    const jest = /Tests:\s+(.*\btotal)/.exec(output);
    if (jest) {
      raw = jest[0];
      s.passed = num(/(\d+) passed/);
      s.failed = num(/(\d+) failed/);
      s.skipped = num(/(\d+) skipped/);
    } else {
      const cargo = /test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/.exec(output);
      if (cargo) {
        raw = cargo[0];
        s.passed = Number(cargo[2]);
        s.failed = Number(cargo[3]);
        s.skipped = Number(cargo[4]);
      } else {
        const mocha = /(\d+) passing/.exec(output);
        if (mocha) {
          raw = mocha[0];
          s.passed = Number(mocha[1]);
          s.failed = num(/(\d+) failing/);
        } else {
          const go = /^(ok|FAIL)\s+\S+/m.exec(output);
          if (go) {
            raw = go[0];
            const okN = (output.match(/^ok\s/gm) ?? []).length;
            const failN = (output.match(/^FAIL\s/gm) ?? []).length;
            s.passed = okN;
            s.failed = failN;
          }
        }
      }
    }
  }
  if (raw === undefined) return undefined;
  s.raw = raw.slice(0, 200);
  return s;
}
