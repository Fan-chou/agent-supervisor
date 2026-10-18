// 把各 harness 的原始工具调用 / 结果规整成 Event（pre + post）。读取器和以后的适配器共用。
import { analyzeShell, type ClassifyOptions } from "./cmdclass.ts";
import type { EditInfo, Event, Harness, Origin, ResultInfo, ShellInfo, ToolInfo, ToolKind } from "./event.ts";
import { classifyFailure, extractTestSummary } from "./failure.ts";
import { argsHash, errFingerprint, outputHash, shellCommandOf } from "./fingerprint.ts";
import { shortHash } from "./hash.ts";
import { headTail, redact } from "./redact.ts";

export interface RawCall {
  harness: Harness;
  sessionId: string;
  toolUseId?: string;
  name: string;
  input: unknown;
  ts: number;
  model?: string;
  agentId?: string;
  turnId?: string;
  origin?: Origin;
}

export interface RawResult {
  output: string;
  isError?: boolean;
  exitCode?: number;
  /** 结果是 pending（长时间运行的命令还没结束）。 */
  pending?: boolean;
  ts?: number;
}

const SHELL_NAMES = new Set(["bash", "shell", "exec_command", "local_shell", "run_shell_command", "container.exec", "shell_command"]);
const READ_NAMES = new Set(["read", "view", "notebookread", "read_file", "cat"]);
const SEARCH_NAMES = new Set(["grep", "glob", "ls", "list_dir", "search", "find", "codesearch", "list"]);
const EDIT_NAMES = new Set(["edit", "multiedit", "write", "notebookedit", "apply_patch", "str_replace_editor", "str_replace_based_edit_tool", "patch", "create_file", "write_file", "replace"]);
const PLAN_NAMES = new Set(["todowrite", "todo_write", "update_plan", "todoread"]);
const AGENT_NAMES = new Set(["task", "agent", "spawn_agent"]);
const WEB_NAMES = new Set(["webfetch", "websearch", "web_search", "fetch"]);

function looksLikePatch(input: unknown): boolean {
  const cmd = shellCommandOf(input);
  if (cmd && /apply_patch/.test(cmd) && /\*\*\* Begin Patch/.test(cmd)) return true;
  if (typeof input === "string") return /\*\*\* Begin Patch/.test(input);
  if (input && typeof input === "object") {
    const v = (input as Record<string, unknown>).input;
    if (typeof v === "string" && /\*\*\* Begin Patch/.test(v)) return true;
  }
  return false;
}

export function toolKind(name: string, input: unknown): ToolKind {
  const n = name.toLowerCase();
  if (looksLikePatch(input)) return "edit";
  if (SHELL_NAMES.has(n)) return "shell";
  if (EDIT_NAMES.has(n)) {
    if (n === "str_replace_editor" || n === "str_replace_based_edit_tool") {
      const c = (input as Record<string, unknown> | null)?.command;
      return c === "view" ? "read" : "edit";
    }
    return "edit";
  }
  if (READ_NAMES.has(n)) return "read";
  if (SEARCH_NAMES.has(n)) return "search";
  if (PLAN_NAMES.has(n)) return "plan";
  if (AGENT_NAMES.has(n)) return "agent";
  if (WEB_NAMES.has(n)) return "web";
  return "other";
}

const cap = (s: string, n = 4000) => (s.length > n ? s.slice(0, n) : s);
const lineCount = (s: string) => (s ? s.split("\n").length : 0);

function parsePatch(text: string): EditInfo {
  const files: string[] = [];
  const created: string[] = [];
  const deleted: string[] = [];
  const removed: string[] = [];
  const added: string[] = [];
  const before: Record<string, string[]> = {};
  const after: Record<string, string[]> = {};
  let cur: string | undefined;
  for (const line of text.split("\n")) {
    let m: RegExpExecArray | null;
    if ((m = /^\*\*\* (Add|Update|Delete) File:\s*(.+?)\s*$/.exec(line))) {
      cur = m[2];
      files.push(cur);
      if (m[1] === "Add") created.push(cur);
      if (m[1] === "Delete") deleted.push(cur);
      before[cur] = [];
      after[cur] = [];
    } else if ((m = /^\*\*\* Move to:\s*(.+?)\s*$/.exec(line))) {
      files.push(m[1]);
    } else if (cur && line.startsWith("+") && !line.startsWith("+++")) {
      added.push(line.slice(1));
      after[cur].push(line.slice(1));
    } else if (cur && line.startsWith("-") && !line.startsWith("---")) {
      removed.push(line.slice(1));
      before[cur].push(line.slice(1));
    }
  }
  const info: EditInfo = {
    files: [...new Set(files)],
    oldText: cap(removed.join("\n")),
    newText: cap(added.join("\n")),
    deletedLines: removed.length,
    addedLines: added.length,
    contentHashes: {},
    beforeHashes: {},
  };
  for (const f of info.files) {
    if (after[f]?.length) info.contentHashes![f] = shortHash(after[f].join("\n"));
    if (before[f]?.length) info.beforeHashes![f] = shortHash(before[f].join("\n"));
  }
  if (created.length && created.length === info.files.length) info.created = true;
  if (deleted.length) info.deletedFile = true;
  return info;
}

export function editInfoOf(name: string, input: unknown, resultText?: string): EditInfo | undefined {
  if (toolKind(name, input) !== "edit") return undefined;
  const patchText =
    shellCommandOf(input) && /\*\*\* Begin Patch/.test(shellCommandOf(input)!)
      ? shellCommandOf(input)!
      : typeof input === "string"
        ? input
        : typeof (input as Record<string, unknown> | null)?.input === "string"
          ? ((input as Record<string, unknown>).input as string)
          : undefined;
  if (patchText && /\*\*\* Begin Patch/.test(patchText)) return parsePatch(patchText);
  const o = (input ?? {}) as Record<string, unknown>;
  const file = [o.file_path, o.path, o.notebook_path, o.filePath, o.file].find((x): x is string => typeof x === "string");
  if (!file) return undefined;
  const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : undefined);
  const oldS = str("old_string") ?? str("oldString") ?? str("old_str");
  const newS = str("new_string") ?? str("newString") ?? str("new_str") ?? str("content") ?? str("file_text") ?? str("new_source");
  const info: EditInfo = { files: [file] };
  if (Array.isArray(o.edits)) {
    const edits = o.edits as Record<string, unknown>[];
    const olds = edits.map((x) => String(x.old_string ?? x.oldString ?? "")).join("\n");
    const news = edits.map((x) => String(x.new_string ?? x.newString ?? "")).join("\n");
    info.oldText = cap(olds);
    info.newText = cap(news);
    info.deletedLines = lineCount(olds);
    info.addedLines = lineCount(news);
    info.contentHashes = { [file]: shortHash(news) };
    if (olds) info.beforeHashes = { [file]: shortHash(olds) };
    return info;
  }
  if (newS !== undefined) {
    info.newText = cap(newS);
    info.addedLines = lineCount(newS);
    info.contentHashes = { [file]: shortHash(newS) };
  }
  if (oldS !== undefined) {
    info.oldText = cap(oldS);
    info.deletedLines = lineCount(oldS);
    info.beforeHashes = { [file]: shortHash(oldS) };
  }
  const isWrite = /^(write|create_file|write_file)$/i.test(name) || o.command === "create";
  if (isWrite && resultText && /created successfully|File created/i.test(resultText)) info.created = true;
  return info;
}

function toolInfoOf(call: RawCall): ToolInfo {
  return { name: call.name, kind: toolKind(call.name, call.input), input: call.input, argsHash: argsHash(call.name, call.input) };
}

function shellInfoOf(call: RawCall, tool: ToolInfo, opts: ClassifyOptions): ShellInfo | undefined {
  if (tool.kind !== "shell") return undefined;
  const cmd = shellCommandOf(call.input);
  if (cmd === undefined) return undefined;
  const a = analyzeShell(cmd, opts);
  return { cmd, normCmd: a.normCmd, cls: a.cls, mutating: a.mutating, targets: a.targets, background: a.background || undefined, scriptPath: a.scriptPath };
}

export function cwdOf(input: unknown): string | undefined {
  const o = input as Record<string, unknown> | null;
  const v = o?.workdir ?? o?.cwd;
  return typeof v === "string" ? v : undefined;
}

export function preEvent(call: RawCall, seq: number, opts: ClassifyOptions = {}): Event {
  const tool = toolInfoOf(call);
  return {
    sessionId: call.sessionId,
    harness: call.harness,
    agentId: call.agentId,
    model: call.model,
    turnId: call.turnId,
    seq,
    ts: call.ts,
    origin: call.origin ?? "agent",
    toolUseId: call.toolUseId,
    phase: "pre",
    tool,
    shell: shellInfoOf(call, tool, opts),
    edit: editInfoOf(call.name, call.input),
  };
}

export function resultInfoOf(res: RawResult, ctx: { cls?: ResultInfoClass; isShell: boolean }): ResultInfo {
  const redacted = redact(res.output);
  const { head, tail } = headTail(redacted, 1000);
  let status: ResultInfo["status"];
  let exitCode = res.exitCode;
  if (res.pending) status = "pending";
  else if (ctx.isShell) {
    const v = classifyFailure({ output: res.output, exitCode: res.exitCode, cls: ctx.cls });
    exitCode = v.exitCode ?? exitCode;
    // Claude 的 PostToolUseFailure / is_error 是权威信号；Codex 没有，才靠退出码头部和文本推断
    status = res.isError !== undefined && res.exitCode === undefined ? (res.isError ? "fail" : "ok") : v.status;
    if (res.isError === true) {
      const m = /^Exit code:?\s*(\d+)/m.exec(res.output);
      if (m) exitCode = Number(m[1]);
    }
  } else {
    status = res.isError ? "fail" : "ok";
  }
  const info: ResultInfo = { status, outHash: outputHash(res.output), outputHead: head, outputTail: tail };
  if (exitCode !== undefined) info.exitCode = exitCode;
  if (status === "fail") info.errFingerprint = errFingerprint(res.output);
  const ts = extractTestSummary(res.output);
  if (ts) info.testSummary = ts;
  return info;
}
type ResultInfoClass = import("./event.ts").CmdClass;

export function postEvent(call: RawCall, res: RawResult, seq: number, opts: ClassifyOptions = {}): Event {
  const tool = toolInfoOf(call);
  const shell = shellInfoOf(call, tool, opts);
  const edit = editInfoOf(call.name, call.input, res.output);
  return {
    sessionId: call.sessionId,
    harness: call.harness,
    agentId: call.agentId,
    model: call.model,
    turnId: call.turnId,
    seq,
    ts: res.ts ?? call.ts,
    origin: call.origin ?? "agent",
    toolUseId: call.toolUseId,
    phase: "post",
    tool,
    shell,
    edit,
    result: resultInfoOf(res, { cls: shell?.cls, isShell: tool.kind === "shell" }),
  };
}
