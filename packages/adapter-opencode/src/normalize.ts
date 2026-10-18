// OpenCode V2 插件事件 → 统一 Event（与 adapter-claude / adapter-codex 同构）。
// 插件在 OpenCode 进程内，用一份很薄的线格式把 V2 hook 对象转给守护进程（插件源码见 packages/cli/src/opencode-plugin.ts）：
//   { event, sessionID, directory?, model?, agent?, callID?, tool?, args?, status?, result?, error?, userMessage? }
// V2 的真实对象形态【未实测】（design §3.3 只核实了接口名），所以这里解析尽量宽松；真实载荷需要在 Jack 的机器上校准（decisions 里记为缺口）。
// 工具名沿用 OpenCode 的小写名（bash/edit/write/read/grep/glob/list/todowrite/task/webfetch），core 的 toolKind 已经认识。
import { cwdOf, parseExitCode, postEvent, preEvent, type ClassifyOptions, type Event, type RawCall } from "@sv/core";
import { unpackOutput } from "../../adapter-codex/src/parse.ts";
import { isOpenCodeHookPoint, type OpenCodeEventName, type OpenCodeHookPoint } from "./render.ts";

export interface OpenCodePayload {
  event?: string;
  sessionID?: string;
  directory?: string;
  /** 字符串，或 {providerID, modelID} / {id}：只记录到日志，不参与判定。 */
  model?: unknown;
  agent?: unknown;
  callID?: string;
  tool?: string;
  args?: unknown;
  /** execute.after：completed | error（失败状态是明确的，不需要 FailureClassifier 判成败）。 */
  status?: string;
  result?: unknown;
  error?: unknown;
  /** context 钩子里插件看到的最新一条 user 消息（插件只在它变化时带上）。 */
  userMessage?: { id?: string; text?: string };
  [k: string]: unknown;
}

export interface Normalized {
  /** 可以向 OpenCode 输出的注入点；其他事件只记录，不输出。 */
  hookPoint: OpenCodeHookPoint | null;
  eventName: string;
  events: Event[];
  /** OpenCode 没有 stop_hook_active；保持与另外两家同构，恒为 false。 */
  stopHookActive: false;
  sessionId: string;
  cwd?: string;
  model?: string;
}

/** model 可能是字符串或对象；只取一个可读的名字，仅用于日志。 */
export function modelName(m: unknown): string | undefined {
  if (typeof m === "string") return m || undefined;
  if (m && typeof m === "object") {
    const o = m as Record<string, unknown>;
    const id = o.modelID ?? o.id ?? o.name;
    if (typeof id === "string" && id) return typeof o.providerID === "string" && o.providerID ? `${o.providerID}/${id}` : id;
  }
  return undefined;
}

function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const o = e as Record<string, unknown>;
    if (typeof o.message === "string") return o.message;
    try {
      return JSON.stringify(e).slice(0, 4000);
    } catch {
      return "";
    }
  }
  return e == null ? "" : String(e);
}

/** execute.after 的 result：字符串、{output, metadata:{exit|exit_code|exitCode}} 或其他对象。 */
function resultOf(raw: unknown): { text: string; exitCode?: number } {
  const u = unpackOutput(raw);
  let exitCode = u.exitCode;
  if (exitCode === undefined && raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const m = (o.metadata && typeof o.metadata === "object" ? o.metadata : o) as Record<string, unknown>;
    for (const k of ["exit", "exit_code", "exitCode"]) if (typeof m[k] === "number") exitCode = m[k] as number;
  }
  return { text: u.text, exitCode };
}

export function normalizeOpenCodeEvent(p: OpenCodePayload, o: { nextSeq: () => number; now: number; classify?: ClassifyOptions; model?: string }): Normalized {
  const name = String(p.event ?? "");
  const sessionId = typeof p.sessionID === "string" && p.sessionID ? p.sessionID : "unknown";
  const model = modelName(p.model) ?? o.model;
  const input = p.args ?? {};
  const cwd = typeof p.directory === "string" ? p.directory : cwdOf(input);
  const base = { sessionId, harness: "opencode" as const, model, ts: o.now, cwd };
  const out: Normalized = { hookPoint: isOpenCodeHookPoint(name) ? name : null, eventName: name as OpenCodeEventName, events: [], stopHookActive: false, sessionId, cwd, model };
  const call = (): RawCall => ({ harness: "opencode", sessionId, toolUseId: typeof p.callID === "string" ? p.callID : undefined, name: String(p.tool ?? "unknown"), input, ts: o.now, model });
  switch (name) {
    case "session.created":
      out.events.push({ ...base, seq: o.nextSeq(), origin: "agent", phase: "session" });
      break;
    case "tool.before": {
      const e = preEvent(call(), o.nextSeq(), o.classify);
      e.cwd = cwd;
      out.events.push(e);
      break;
    }
    case "tool.after": {
      const c = call();
      const failed = p.status === "error";
      const r = failed ? { text: errorText(p.error ?? p.result), exitCode: undefined as number | undefined } : resultOf(p.result);
      const exitCode = r.exitCode ?? parseExitCode(r.text);
      const e = postEvent(c, { output: r.text, isError: failed, exitCode, ts: o.now }, o.nextSeq(), o.classify);
      e.cwd = cwd;
      out.events.push(e);
      break;
    }
    case "prompt": // session.hook("prompt")：真正的 user 消息入口（V2 有这个钩子）；context 里扫 messages 只是它注册不上时的退路
    case "context": {
      // 每次请求模型前触发：本身不产生事件（只带模型名、作为注入点）；插件发现新的 user 消息时顺带带上，产生 prompt 事件。
      // origin 先标 user；我们自己注入的文本回显成 user 消息时由 tracker 改判为 supervisor（P0-6）。
      const t = p.userMessage?.text;
      if (typeof t === "string" && t) out.events.push({ ...base, seq: o.nextSeq(), origin: "user", phase: "prompt", text: t });
      break;
    }
    case "interrupt":
      out.events.push({ ...base, seq: o.nextSeq(), origin: "user", phase: "interrupt" });
      break;
    default:
      break; // permission.evaluate 与未知事件：不产生事件（pre 事件来自 tool.before）
  }
  return out;
}
