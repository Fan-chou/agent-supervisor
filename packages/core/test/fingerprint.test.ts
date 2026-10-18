import { describe, expect, test } from "bun:test";
import { argsHash, errFingerprint, extractErrorLines, normalizeErrorLine, outputHash, shellCommandOf } from "../src/fingerprint.ts";

const pytestOut = (n: number, line: number, extra = "") => `============================= test session starts ==============================
platform darwin -- Python 3.11.${n}, pytest-8.1.1, pluggy-1.4.0
rootdir: /Users/x/proj
collected ${n} items

tests/test_a.py F                                                        [100%]

=================================== FAILURES ===================================
___________________________________ test_x _____________________________________

    def test_x():
>       assert compute(${n}) == 4
E       assert ${n + 1} == 4
E        +  where ${n + 1} = compute(${n})

tests/test_a.py:${line}: AssertionError
${extra}=========================== short test summary info ============================
FAILED tests/test_a.py::test_x - assert ${n + 1} == 4
============================== 1 failed in 0.0${n}s ===============================
`;

describe("errFingerprint", () => {
  test("同一错误、不同数字/行号/耗时 → 相同指纹", () => {
    expect(errFingerprint(pytestOut(3, 10))).toBe(errFingerprint(pytestOut(5, 42)));
  });
  test("不同的错误 → 不同指纹", () => {
    const a = "E   KeyError: 'name'\n";
    const b = "E   ValueError: bad input\n";
    expect(errFingerprint(a)).not.toBe(errFingerprint(b));
  });
  test("固定样板相同但错误不同 → 不同指纹（L3 误报修复）", () => {
    const head = "x".repeat(10) + "\n" + "=".repeat(30) + " test session starts " + "=".repeat(30) + "\nplatform darwin\nrootdir: /a\n";
    const a = head + "E   KeyError: 'a'\n";
    const b = head + "E   TypeError: unsupported operand\n";
    expect(errFingerprint(a)).not.toBe(errFingerprint(b));
  });
  test("路径和十六进制被归一", () => {
    const a = "Error: ENOENT: no such file or directory, open '/Users/a/proj/x.json' at 0x7f12ab";
    const b = "Error: ENOENT: no such file or directory, open '/home/b/other/x.json' at 0x99aa11";
    expect(errFingerprint(a)).toBe(errFingerprint(b));
  });
  test("只取最后一个 Traceback 的最后一帧", () => {
    const tb = (f: string) => `Traceback (most recent call last):
  File "/x/main.py", line 1, in <module>
    run()
  File "/x/${f}.py", line 7, in run
    raise ValueError("boom 12")
ValueError: boom 12
`;
    // 外层帧不同（main.py 与 cli.py）、最后一帧与异常相同 → 指纹相同
    const other = tb("lib").replace("/x/main.py", "/y/cli.py").replace("run()", "go()");
    expect(errFingerprint(other)).toBe(errFingerprint(tb("lib")));
    expect(errFingerprint(tb("other"))).toBe(errFingerprint(tb("lib"))); // 文件名属于路径，被归一
    expect(errFingerprint(tb("lib").replace("boom 12", "different"))).not.toBe(errFingerprint(tb("lib")));
  });
  test("抽不到错误行 → 用尾部 300 字符，不看开头", () => {
    const tail = "progress output line\n".repeat(20) + "done tail one\n";
    const a = "BOILERPLATE LINE\n".repeat(50) + tail;
    const b = "OTHER HEADER\n".repeat(50) + tail;
    expect(errFingerprint(a)).toBe(errFingerprint(b));
    expect(errFingerprint("BOILERPLATE LINE\n".repeat(50) + tail.replace("done tail one", "done tail two"))).not.toBe(errFingerprint(a));
  });
  test("空输出 → undefined", () => {
    expect(errFingerprint("")).toBeUndefined();
    expect(errFingerprint("  \n")).toBeUndefined();
  });
  test("rustc / panic / tsc", () => {
    expect(extractErrorLines("error[E0308]: mismatched types\n --> src/a.rs:3:1")).toContain("error[E0308]: mismatched types");
    expect(extractErrorLines("thread 'main' panicked at src/main.rs:3:5:\nboom").length).toBe(1);
    expect(extractErrorLines("src/a.ts(3,1): error TS2322: bad").length).toBe(1);
  });
  test("normalizeErrorLine 去掉 ANSI 与数字", () => {
    expect(normalizeErrorLine("\x1b[31mE   assert 3 == 4\x1b[0m")).toBe("E assert ==");
  });
});

describe("argsHash", () => {
  test("shell：包装不同、归一化后相同", () => {
    const a = argsHash("Bash", { command: "uv run pytest -q 2>&1 | tail -20" });
    const b = argsHash("Bash", { command: "timeout 60 pytest -q" });
    expect(a).toBe(b);
  });
  test("shell：参数不同 → 不同", () => {
    expect(argsHash("Bash", { command: "pytest -k a" })).not.toBe(argsHash("Bash", { command: "pytest -k b" }));
  });
  test("非 shell：键顺序无关", () => {
    expect(argsHash("Edit", { file_path: "a", old_string: "x", new_string: "y" })).toBe(argsHash("Edit", { new_string: "y", old_string: "x", file_path: "a" }));
  });
  test("工具名参与哈希", () => {
    expect(argsHash("Read", { file_path: "a" })).not.toBe(argsHash("Write", { file_path: "a" }));
  });
  test("Codex 数组形式的 command", () => {
    expect(shellCommandOf({ command: ["bash", "-lc", "pytest -q"] })).toBe("pytest -q");
    expect(argsHash("shell", { command: ["bash", "-lc", "pytest -q"] })).toBe(argsHash("Bash", { command: "pytest -q" }) && argsHash("shell", { command: "pytest -q" }));
  });
  test("outputHash 忽略 ANSI 和行尾空白", () => {
    expect(outputHash("a  \nb\n")).toBe(outputHash("a\nb\n"));
    expect(outputHash("\x1b[31ma\x1b[0m")).toBe(outputHash("a"));
  });
});
