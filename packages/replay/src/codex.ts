// Codex rollout（jsonl）→ Event 流。
// 依据 design §3.2 的源码核查：rollout 里没有 ExecCommandEnd 的退出码，
// 但 function_call_output 的文本头里有 `Process exited with code N`——这里解析它来回填退出码。
// 样本全部是手写合成的（test/fixtures/codex/），没有读过任何真实的 ~/.codex 数据。
import { cwdOf, parseExitCode, postEvent, preEvent, shellCommandOf, type ClassifyOptions, type Event, type RawCall, type RawResult } from "@sv/core";
import { parseJsonl, type ReadOptions } from "./claude.ts";

interface Rec {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

const ENV_CONTEXT = /^\s*<(environment_context|user_instructions|user_action|turn_aborted)\b|^# AGENTS\.md instructions/;

function ms(ts: string | undefined, fallback: number): number {
  if (!ts) return fallback;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? fallback : t;
}

function msgText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : ""))
    .join("\n");
}

/** function_call_output 的 output 有两种形态：纯文本，或 JSON 字符串 {"output": "...", "metadata": {"exit_code": N}}。 */
export function unpackOutput(raw: unknown): { text: string; exitCode?: number } {
  let s: string;
  if (typeof raw === "string") s = raw;
  else if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    s = typeof o.content === "string" ? o.content : typeof o.output === "string" ? o.output : JSON.stringify(raw);
  } else s = "";
  const t = s.trim();
  if (t.startsWith("{") && t.endsWith("}")) {
    try {
      const j = JSON.parse(t) as { output?: unknown; metadata?: { exit_code?: number } };
      if (typeof j.output === "string") return { text: j.output, exitCode: typeof j.metadata?.exit_code === "number" ? j.metadata.exit_code : undefined };
    } catch {
      /* 不是 JSON，按原文处理 */
    }
  }
  return { text: s };
}

interface Pending {
  call: RawCall;
  preSeq: number;
}

export function readCodexRollout(text: string, opts: ReadOptions = {}): Event[] {
  const recs = parseJsonl(text) as unknown as Rec[];
  const events: Event[] = [];
  let seq = 0;
  let sessionId = opts.sessionIdFallback ?? "unknown";
  let model: string | undefined;
  let cwd: string | undefined;
  let clock = 0;
  const firstTs = ms(recs.find((r) => r.timestamp)?.timestamp, 0);
  const calls = new Map<string, Pending>();
  /** 仍在运行的 unified_exec 会话：session id → 原始调用。 */
  const running = new Map<string, { callId: string; postIdx: number }>();
  const classify: ClassifyOptions | undefined = opts.classify;

  const meta = recs.find((r) => r.type === "session_meta")?.payload;
  if (meta) {
    if (typeof meta.id === "string") sessionId = meta.id;
    if (typeof meta.cwd === "string") cwd = meta.cwd;
    if (typeof meta.model === "string") model = meta.model;
  }
  const tc = recs.find((r) => r.type === "turn_context")?.payload;
  if (tc) {
    if (typeof tc.model === "string") model = tc.model;
    if (typeof tc.cwd === "string" && !cwd) cwd = tc.cwd;
  }
  events.push({ sessionId, harness: "codex", model, seq: seq++, ts: firstTs, origin: "agent", phase: "session", cwd });

  for (const r of recs) {
    clock++;
    const ts = ms(r.timestamp, firstTs + clock);
    const p = r.payload ?? {};
    if (r.type === "turn_context") {
      if (typeof p.model === "string") model = p.model;
      if (typeof p.cwd === "string") cwd = p.cwd;
      continue;
    }
    if (r.type === "event_msg") {
      const t = p.type;
      if (t === "task_complete" || t === "turn_complete") events.push({ sessionId, harness: "codex", model, seq: seq++, ts, origin: "agent", phase: "stop", cwd });
      else if (t === "turn_aborted") events.push({ sessionId, harness: "codex", model, seq: seq++, ts, origin: "user", phase: "interrupt", cwd });
      else if (t === "token_count") {
        const info = p.info as { last_token_usage?: { total_tokens?: number; input_tokens?: number } } | null | undefined;
        const n = info?.last_token_usage?.input_tokens ?? info?.last_token_usage?.total_tokens;
        if (typeof n === "number" && events.length) events[events.length - 1].usage = { ...(events[events.length - 1].usage ?? {}), contextTokens: n };
      }
      continue;
    }
    if (r.type !== "response_item") continue;
    const pt = p.type;
    if (pt === "message") {
      if (p.role === "user") {
        const text = msgText(p.content);
        if (!text.trim() || ENV_CONTEXT.test(text)) continue;
        events.push({ sessionId, harness: "codex", model, seq: seq++, ts, origin: "user", phase: "prompt", text, cwd });
      }
      continue;
    }
    if (pt === "function_call" || pt === "custom_tool_call" || pt === "local_shell_call") {
      const callId = String(p.call_id ?? p.id ?? `call_${seq}`);
      const name = String(p.name ?? (pt === "local_shell_call" ? "local_shell" : "unknown"));
      let input: unknown;
      if (pt === "function_call") {
        try {
          input = typeof p.arguments === "string" ? JSON.parse(p.arguments) : (p.arguments ?? {});
        } catch {
          input = { raw: p.arguments };
        }
      } else if (pt === "custom_tool_call") input = p.input;
      else input = { command: (p.action as { command?: string[] } | undefined)?.command ?? [] };
      const wd = cwdOf(input);
      if (wd) cwd = wd;
      const call: RawCall = { harness: "codex", sessionId, toolUseId: callId, name, input, ts, model };
      calls.set(callId, { call, preSeq: seq });
      const e = preEvent(call, seq++, classify);
      e.cwd = cwd;
      events.push(e);
      continue;
    }
    if (pt === "function_call_output" || pt === "custom_tool_call_output") {
      const callId = String(p.call_id ?? "");
      const pend = calls.get(callId);
      if (!pend) continue;
      calls.delete(callId);
      const { text: out, exitCode: metaExit } = unpackOutput(p.output);
      const header = parseExitCode(out);
      const exitCode = header ?? metaExit;
      const stillRunning = /Process running with session ID\s+(\S+)/.exec(out);
      const res: RawResult = { output: out, exitCode, pending: header === undefined && metaExit === undefined && !!stillRunning, ts };
      const e = postEvent(pend.call, res, seq++, classify);
      e.cwd = cwd;
      events.push(e);
      if (res.pending && stillRunning) running.set(stillRunning[1].replace(/[^\w-]/g, ""), { callId, postIdx: events.length - 1 });
      // write_stdin 轮询：拿到最终退出码时，回填最初那次调用的结果
      if (pend.call.name === "write_stdin") {
        const sid = String((pend.call.input as { session_id?: unknown } | null)?.session_id ?? "");
        const orig = running.get(sid);
        if (orig && exitCode !== undefined) {
          const origEv = events[orig.postIdx];
          // 以最终输出为准（头部含 Process exited with code N）；沿用原事件的 seq/ts，使后续检测器看到的是已完成的结果
          const final = postEvent(rawFrom(origEv), { output: out, exitCode, ts: origEv.ts }, origEv.seq, classify);
          events[orig.postIdx] = { ...origEv, result: final.result };
          running.delete(sid);
        }
      }
    }
  }
  return events;
}

function rawFrom(e: Event): RawCall {
  return { harness: "codex", sessionId: e.sessionId, toolUseId: e.toolUseId, name: e.tool!.name, input: e.tool!.input, ts: e.ts, model: e.model };
}

void shellCommandOf;
