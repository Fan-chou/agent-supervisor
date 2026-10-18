// Claude Code transcript（jsonl）→ Event 流。
// 注意：格式依据 Claude Code 公开的 transcript 结构手写合成样本（test/fixtures/claude/），没有读取过任何真实的 ~/.claude 数据。
// 真实 transcript 的细节差异需要在 Jack 的机器上用真实文件校准。
import { postEvent, preEvent, type ClassifyOptions, type Event, type RawCall } from "@sv/core";

interface Line {
  type?: string;
  sessionId?: string;
  uuid?: string;
  timestamp?: string;
  cwd?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  agentId?: string;
  message?: {
    role?: string;
    model?: string;
    content?: string | Block[];
    stop_reason?: string | null;
    usage?: Record<string, number>;
  };
}
interface Block {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | { type: string; text?: string }[];
  is_error?: boolean;
}

export interface ReadOptions {
  /** 把子 agent（isSidechain）的事件也放进流里；默认丢弃，只保留主链。 */
  includeSidechains?: boolean;
  classify?: ClassifyOptions;
  sessionIdFallback?: string;
}

const INTERRUPT_RE = /^\[Request interrupted by user/;
const NOT_A_PROMPT = /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-caveat|system-reminder|bash-input|bash-stdout|bash-stderr)\b/;

function ms(ts: string | undefined, fallback: number): number {
  if (!ts) return fallback;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? fallback : t;
}

function textOf(content: Block["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");
  return "";
}

export function parseJsonl(text: string): Line[] {
  const out: Line[] = [];
  for (const raw of text.split("\n")) {
    const l = raw.trim();
    if (!l) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      /* 跳过损坏的行（真实 transcript 末尾可能被截断） */
    }
  }
  return out;
}

export function readClaudeTranscript(text: string, opts: ReadOptions = {}): Event[] {
  const lines = parseJsonl(text);
  const events: Event[] = [];
  let seq = 0;
  let sessionId = opts.sessionIdFallback ?? "unknown";
  let model: string | undefined;
  let cwd: string | undefined;
  let clock = 0;
  const calls = new Map<string, RawCall>();
  let lastUsageContext: number | undefined;

  const first = lines.find((l) => l.sessionId);
  if (first?.sessionId) sessionId = first.sessionId;
  const firstTs = ms(lines.find((l) => l.timestamp)?.timestamp, 0);
  events.push({ sessionId, harness: "claude", seq: seq++, ts: firstTs, origin: "agent", phase: "session", cwd: lines.find((l) => l.cwd)?.cwd });

  for (const ln of lines) {
    if (ln.isSidechain && !opts.includeSidechains) continue;
    if (ln.cwd) cwd = ln.cwd;
    clock += 1;
    const ts = ms(ln.timestamp, firstTs + clock);
    const msg = ln.message;
    if (ln.type === "assistant" && msg) {
      if (msg.model) model = msg.model;
      const u = msg.usage;
      if (u) lastUsageContext = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      const uses = blocks.filter((b) => b.type === "tool_use");
      for (const b of uses) {
        const call: RawCall = { harness: "claude", sessionId, toolUseId: b.id, name: b.name ?? "unknown", input: b.input ?? {}, ts, model, agentId: ln.isSidechain ? (ln.agentId ?? "sidechain") : undefined };
        if (b.id) calls.set(b.id, call);
        const e = preEvent(call, seq++, opts.classify);
        e.cwd = cwd;
        if (lastUsageContext !== undefined) e.usage = { contextTokens: lastUsageContext };
        events.push(e);
      }
      // 没有工具调用的 assistant 消息 = 本轮收尾（等价于 Stop）
      if (uses.length === 0 && (msg.stop_reason === "end_turn" || msg.stop_reason === "stop_sequence" || msg.stop_reason === undefined || msg.stop_reason === null) && blocks.some((b) => b.type === "text" && (b.text ?? "").trim())) {
        events.push({ sessionId, harness: "claude", model, seq: seq++, ts, origin: "agent", phase: "stop", cwd, usage: lastUsageContext !== undefined ? { contextTokens: lastUsageContext } : undefined });
      }
      continue;
    }
    if (ln.type === "user" && msg) {
      const content = msg.content;
      if (typeof content === "string") {
        pushPrompt(content, ts, ln);
        continue;
      }
      if (Array.isArray(content)) {
        const results = content.filter((b) => b.type === "tool_result");
        for (const r of results) {
          const call = r.tool_use_id ? calls.get(r.tool_use_id) : undefined;
          if (!call) continue;
          const output = textOf(r.content);
          const e = postEvent(call, { output, isError: Boolean(r.is_error), ts }, seq++, opts.classify);
          e.cwd = cwd;
          events.push(e);
          calls.delete(r.tool_use_id!);
        }
        const texts = content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
        if (results.length === 0 && texts) pushPrompt(texts, ts, ln);
      }
    }
  }
  return events;

  function pushPrompt(text: string, ts: number, ln: Line): void {
    if (ln.isCompactSummary) {
      events.push({ sessionId, harness: "claude", model, seq: seq++, ts, origin: "agent", phase: "compact", text: text.slice(0, 500), cwd });
      return;
    }
    if (ln.isMeta || NOT_A_PROMPT.test(text)) return;
    if (INTERRUPT_RE.test(text.trim())) {
      events.push({ sessionId, harness: "claude", model, seq: seq++, ts, origin: "user", phase: "interrupt", cwd });
      return;
    }
    events.push({ sessionId, harness: "claude", model, seq: seq++, ts, origin: "user", phase: "prompt", text, cwd });
  }
}
