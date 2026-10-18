// errFingerprint / argsHash（design §4.1）。normCmd 在 cmdclass.ts。
import { analyzeShell } from "./cmdclass.ts";
import { canonicalJson, shortHash } from "./hash.ts";

const ERROR_LINE_PATTERNS: RegExp[] = [
  /^E\s{2,}\S/, // pytest 的 "E   AssertionError"
  /^\s*E\s+\S/,
  /\b[A-Za-z_][\w.]*(?:Error|Exception|Exit|Warning):\s/, // TypeError: ...
  /^\s*(?:Error|ERROR|error|Fatal|fatal|FATAL):/,
  /^FAILED\b/,
  /^FAIL\b/,
  /^--- FAIL/,
  /panicked at/,
  /error\[E\d+\]/,
  /\berror TS\d+/,
  /✗|✖/,
  /^npm ERR!/,
  /command not found/,
  /No such file or directory/,
  /Cannot find module/,
  /ModuleNotFoundError|ImportError/,
];

/** 最后一个 Traceback 的最后一帧（File "..." 行及其下一行），加上异常行。 */
function lastTracebackFrame(lines: string[]): string[] {
  let tb = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith("Traceback (most recent call last)")) {
      tb = i;
      break;
    }
  }
  if (tb < 0) return [];
  let lastFile = -1;
  let end = lines.length;
  for (let i = tb + 1; i < lines.length; i++) {
    if (/^\s+File ".*", line \d+/.test(lines[i])) lastFile = i;
    else if (!/^\s/.test(lines[i])) {
      end = i + 1; // 异常行（没有缩进）
      break;
    }
  }
  const out: string[] = [];
  if (lastFile >= 0) out.push(lines[lastFile]);
  if (lastFile >= 0 && lines[lastFile + 1] && /^\s{4}/.test(lines[lastFile + 1])) out.push(lines[lastFile + 1]);
  if (end > tb + 1 && lines[end - 1] && !/^\s/.test(lines[end - 1])) out.push(lines[end - 1]);
  return out;
}

export function extractErrorLines(output: string): string[] {
  const lines = output.split(/\r?\n/);
  const found: string[] = [];
  for (const l of lines) {
    if (ERROR_LINE_PATTERNS.some((re) => re.test(l))) found.push(l);
  }
  found.push(...lastTracebackFrame(lines));
  return found;
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/** 去掉数字、十六进制、路径、行号、uuid、时间戳。 */
export function normalizeErrorLine(line: string): string {
  return line
    .replace(ANSI, "")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "")
    .replace(/0x[0-9a-fA-F]+/g, "")
    .replace(/\b[0-9a-fA-F]{7,}\b/g, "")
    .replace(/(?:[A-Za-z]:)?(?:\.{0,2}\/|~\/)?(?:[\w@.+-]+\/)+[\w@.+-]*/g, "") // 带目录的路径
    .replace(/\b[\w.-]+\.(?:py|ts|tsx|js|jsx|mjs|go|rs|rb|java|json|yaml|yml|toml|md)\b/g, "") // 孤立文件名
    .replace(/\bline\s+\d+/gi, "line")
    .replace(/:\d+(?::\d+)?/g, ":")
    .replace(/\d+(?:\.\d+)?/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 先抽错误行再归一化；抽不到错误行就用尾部 300 字符（不用开头——那里是测试工具的固定样板）。
 * 输出为空时返回 undefined。
 */
export function errFingerprint(output: string): string | undefined {
  if (!output || !output.trim()) return undefined;
  const errLines = extractErrorLines(output);
  let basis: string;
  if (errLines.length > 0) {
    const seen = new Set<string>();
    for (const l of errLines) {
      const n = normalizeErrorLine(l);
      if (n) seen.add(n);
      if (seen.size >= 8) break;
    }
    basis = [...seen].join("\n");
    if (!basis) basis = normalizeErrorLine(output.slice(-300));
  } else {
    basis = normalizeErrorLine(output.slice(-300));
  }
  return shortHash("err:" + basis);
}

/** Claude/Codex 的 shell 工具入参里取出命令字符串。 */
export function shellCommandOf(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  for (const k of ["command", "cmd", "script"]) {
    const v = o[k];
    if (typeof v === "string") return v;
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
      const arr = v as string[];
      // ["bash","-lc","pytest -q"] → 取最后一个
      if (arr.length >= 3 && /^-[a-z]*c$/.test(arr[arr.length - 2])) return arr[arr.length - 1];
      return arr.join(" ");
    }
  }
  return undefined;
}

/** 同一调用的哈希：shell 工具用 normCmd，其他工具用稳定 JSON。 */
export function argsHash(toolName: string, input: unknown): string {
  const cmd = shellCommandOf(input);
  if (cmd !== undefined) return shortHash(`${toolName}\u0000sh\u0000${analyzeShell(cmd).normCmd || cmd.trim()}`);
  return shortHash(`${toolName}\u0000${canonicalJson(input)}`);
}

export function outputHash(output: string): string {
  return shortHash(output.replace(ANSI, "").replace(/\s+$/gm, ""));
}
