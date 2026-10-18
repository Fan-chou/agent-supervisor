// Codex hook 载荷 → 统一 Event（与 adapter-claude 同构）。
// 载荷字段依据 Codex 官方 hooks 文档与 design §3.2（源码核查）手写合成样本测试，没有读取任何真实会话数据；
// 真实载荷的细节差异（tool_name 的取值、tool_response 的形态、update_plan 是否触发钩子）需要在 Jack 的机器上用
// 真实 hook 输入校准（SV_HOOK_DUMP，见 docs/decisions.md）。解析尽量宽松。
import { cwdOf, parseExitCode, postEvent, preEvent, type ClassifyOptions, type Event, type RawCall } from "@sv/core";
import { parseFunctionArgs, unpackOutput } from "./parse.ts";
import { isCodexHookPoint, type CodexHookPoint } from "./render.ts";

export interface CodexHookPayload {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
  /** 通用输入里的模型名：只记录到日志，不参与判定。 */
  model?: string;
  turn_id?: string;
  tool_name?: string;
  /** 通常是对象；兼容 JSON 字符串。 */
  tool_input?: unknown;
  /** 截断后的原始输出（可能是字符串、{output,metadata} 的 JSON 字符串或对象），**不带退出码字段**（design §3.2）。 */
  tool_response?: unknown;
  tool_use_id?: string;
  call_id?: string;
  prompt?: string;
  stop_hook_active?: boolean;
  last_assistant_message?: string;
  source?: string;
  [k: string]: unknown;
}

export interface Normalized {
  /** 可以向 Codex 输出的注入点；其他事件只记录，不输出。 */
  hookPoint: CodexHookPoint | null;
  eventName: string;
  events: Event[];
  stopHookActive: boolean;
  sessionId: string;
  cwd?: string;
  model?: string;
}

/** tool_input 可能是 JSON 字符串。 */
function inputOf(raw: unknown): unknown {
  if (typeof raw === "string") {
    const t = raw.trim();
    // 裸字符串可能是 apply_patch 的补丁正文——只有看起来像 JSON 对象时才解析
    if (t.startsWith("{")) return parseFunctionArgs(t);
    return raw;
  }
  return raw ?? {};
}

export function normalizeCodexHook(p: CodexHookPayload, o: { nextSeq: () => number; now: number; classify?: ClassifyOptions; model?: string }): Normalized {
  const name = String(p.hook_event_name ?? "");
  const sessionId = String(p.session_id ?? "unknown");
  const model = typeof p.model === "string" ? p.model : o.model;
  const input = inputOf(p.tool_input);
  // cwd：通用输入里有；缺失时退回工具参数里的 workdir
  const cwd = typeof p.cwd === "string" ? p.cwd : cwdOf(input);
  const base = { sessionId, harness: "codex" as const, model, ts: o.now, cwd };
  const out: Normalized = { hookPoint: isCodexHookPoint(name) ? name : null, eventName: name, events: [], stopHookActive: p.stop_hook_active === true, sessionId, cwd, model };
  const call = (): RawCall => ({
    harness: "codex",
    sessionId,
    toolUseId: typeof p.tool_use_id === "string" ? p.tool_use_id : typeof p.call_id === "string" ? p.call_id : undefined,
    name: String(p.tool_name ?? "unknown"),
    input,
    ts: o.now,
    model,
    turnId: typeof p.turn_id === "string" ? p.turn_id : undefined,
  });
  switch (name) {
    case "SessionStart":
      out.events.push({ ...base, seq: o.nextSeq(), origin: "agent", phase: "session" });
      break;
    case "UserPromptSubmit":
      // origin 先标 user；会话里登记过的注入文本（Stop 的 reason 会成为新的 user prompt）回显时由 tracker 改判为 supervisor（P0-6）
      out.events.push({ ...base, seq: o.nextSeq(), origin: "user", phase: "prompt", text: typeof p.prompt === "string" ? p.prompt : "" });
      break;
    case "PreToolUse": {
      const e = preEvent(call(), o.nextSeq(), o.classify);
      e.cwd = cwd;
      out.events.push(e);
      break;
    }
    case "PostToolUse": {
      const c = call();
      // Codex 的 PostToolUse 对失败的命令也会触发，但 tool_response 不带退出码：
      // 先从输出头 `Process exited with code N` 或 {metadata:{exit_code}} 取；都没有就交给 FailureClassifier，不默认成功。
      const { text, exitCode: metaExit } = unpackOutput(p.tool_response);
      const exitCode = parseExitCode(text) ?? metaExit;
      const e = postEvent(c, { output: text, exitCode, ts: o.now }, o.nextSeq(), o.classify);
      e.cwd = cwd;
      out.events.push(e);
      break;
    }
    case "Stop":
      out.events.push({ ...base, seq: o.nextSeq(), origin: "agent", phase: "stop" });
      break;
    case "Interrupt":
      out.events.push({ ...base, seq: o.nextSeq(), origin: "user", phase: "interrupt" });
      break;
    case "PreCompact":
    case "PostCompact":
      out.events.push({ ...base, seq: o.nextSeq(), origin: "agent", phase: "compact" });
      break;
    default:
      break; // PermissionRequest、SubagentStart/Stop、SessionEnd 等：只记录到 adapter 层，不产生事件
  }
  return out;
}
