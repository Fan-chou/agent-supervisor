// Claude Code hook 载荷 → 统一 Event。
// 注意：载荷字段依据 Claude Code 官方 hooks 文档（design §3.1）手写合成样本测试，没有读取任何真实会话数据；
// 真实载荷的细节差异需要在 Jack 的机器上用真实 hook 输入校准（解析尽量宽松）。
import { postEvent, preEvent, type ClassifyOptions, type Event, type RawCall } from "@sv/core";
import type { HookPoint } from "./render.ts";

export interface ClaudeHookPayload {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  tool_use_id?: string;
  /** PostToolUseFailure：错误文本，第一行是 `Exit code N`。 */
  error?: string;
  is_interrupt?: boolean;
  prompt?: string;
  stop_hook_active?: boolean;
  model?: string;
  source?: string;
  [k: string]: unknown;
}

export interface Normalized {
  /** 可以向 Claude 输出的注入点；其他事件（UserPromptSubmit、SessionStart…）只记录，不输出。 */
  hookPoint: HookPoint | null;
  /** 原始事件名，日志用。 */
  eventName: string;
  events: Event[];
  stopHookActive: boolean;
  sessionId: string;
  cwd?: string;
  model?: string;
}

const INJECTABLE: Record<string, HookPoint> = {
  PreToolUse: "PreToolUse",
  PostToolUse: "PostToolUse",
  PostToolUseFailure: "PostToolUseFailure",
  PostToolBatch: "PostToolBatch",
  Stop: "Stop",
};

/** 工具返回值 → 文本。Bash 是 {stdout, stderr}，其他工具是字符串或结构体。 */
export function responseText(resp: unknown, toolName: string, input: unknown): string {
  if (resp === undefined || resp === null) return "";
  if (typeof resp === "string") return resp;
  if (typeof resp !== "object") return String(resp);
  const o = resp as Record<string, unknown>;
  if (typeof o.stdout === "string" || typeof o.stderr === "string") {
    return [o.stdout, o.stderr].filter((x): x is string => typeof x === "string" && x.length > 0).join("\n");
  }
  if (typeof o.output === "string") return o.output;
  if (typeof o.content === "string") return o.content;
  // Write 新建文件：沿用 transcript 里的措辞，editInfoOf 靠它识别 created
  if (/^write$/i.test(toolName) && o.type === "create") {
    const fp = (input as { file_path?: string } | undefined)?.file_path ?? (typeof o.filePath === "string" ? o.filePath : "");
    return `File created successfully at: ${fp}`;
  }
  if (typeof o.file === "object" && o.file && typeof (o.file as { content?: unknown }).content === "string") return (o.file as { content: string }).content;
  try {
    return JSON.stringify(o).slice(0, 4000);
  } catch {
    return "";
  }
}

export function normalizeClaudeHook(p: ClaudeHookPayload, o: { nextSeq: () => number; now: number; classify?: ClassifyOptions; model?: string }): Normalized {
  const name = String(p.hook_event_name ?? "");
  const sessionId = String(p.session_id ?? "unknown");
  const model = typeof p.model === "string" ? p.model : o.model;
  const base = { sessionId, harness: "claude" as const, model, ts: o.now, cwd: p.cwd };
  const out: Normalized = { hookPoint: INJECTABLE[name] ?? null, eventName: name, events: [], stopHookActive: p.stop_hook_active === true, sessionId, cwd: p.cwd, model };
  const call = (): RawCall => ({ harness: "claude", sessionId, toolUseId: typeof p.tool_use_id === "string" ? p.tool_use_id : undefined, name: String(p.tool_name ?? "unknown"), input: p.tool_input ?? {}, ts: o.now, model });
  switch (name) {
    case "SessionStart":
    case "PostModelSwitch":
      out.events.push({ ...base, seq: o.nextSeq(), origin: "agent", phase: "session" });
      break;
    case "UserPromptSubmit":
      // origin 先标 user；会话里登记过的注入文本回显时由 tracker 改判为 supervisor（P0-6）
      out.events.push({ ...base, seq: o.nextSeq(), origin: "user", phase: "prompt", text: typeof p.prompt === "string" ? p.prompt : "" });
      break;
    case "PreToolUse": {
      const e = preEvent(call(), o.nextSeq(), o.classify);
      e.cwd = p.cwd;
      out.events.push(e);
      break;
    }
    case "PostToolUse":
    case "PostToolUseFailure": {
      const c = call();
      const failed = name === "PostToolUseFailure";
      const text = failed ? String(p.error ?? responseText(p.tool_response, c.name, c.input)) : responseText(p.tool_response, c.name, c.input);
      const exit = /^Exit code:?\s*(\d+)/m.exec(text);
      const e = postEvent(c, { output: text, isError: failed, exitCode: failed && exit ? Number(exit[1]) : undefined, ts: o.now }, o.nextSeq(), o.classify);
      e.cwd = p.cwd;
      out.events.push(e);
      break;
    }
    case "Stop":
      out.events.push({ ...base, seq: o.nextSeq(), origin: "agent", phase: "stop" });
      break;
    case "PreCompact":
    case "PostCompact":
      out.events.push({ ...base, seq: o.nextSeq(), origin: "agent", phase: "compact" });
      break;
    default:
      break; // PostToolBatch、Notification 等：只是注入点或无关事件
  }
  return out;
}
