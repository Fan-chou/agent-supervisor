// Claude Code 的 render()：Delivery → 钩子输出 JSON。只按 design §3.5 的白名单输出字段，其他字段一律删掉。
// 放在 adapter 包里，以后 sv-hook（bun --compile）直接复用；纯函数，不依赖守护进程，不读环境。
import { MAX_TEXT, truncate, type Delivery, type DeliveryKind, type X2Result } from "@sv/core";

export { MAX_TEXT, truncate };
export type { Delivery, DeliveryKind };

export type HookPoint = "PreToolUse" | "PostToolUse" | "PostToolUseFailure" | "PostToolBatch" | "Stop";

export interface RenderContext {
  /** Stop 钩子输入里的 stop_hook_active：为 true 时不再 block，避免死循环（Claude 内置续跑上限 8 次）。 */
  stopHookActive?: boolean;
}

export type ClaudeOutput =
  | { hookSpecificOutput: { hookEventName: "PreToolUse"; permissionDecision: "deny" | "ask"; permissionDecisionReason: string } }
  | { hookSpecificOutput: { hookEventName: "PreToolUse" | "PostToolUse" | "PostToolUseFailure" | "PostToolBatch"; additionalContext: string } }
  | { decision: "block"; reason: string };

/** 每个事件允许的字段（§3.5 表）。顶层和 hookSpecificOutput 内部分开列。 */
export const ALLOWED: Record<HookPoint, { top: readonly string[]; hso: readonly string[] }> = {
  PreToolUse: { top: ["hookSpecificOutput"], hso: ["hookEventName", "permissionDecision", "permissionDecisionReason", "additionalContext"] },
  PostToolUse: { top: ["hookSpecificOutput"], hso: ["hookEventName", "additionalContext"] },
  PostToolUseFailure: { top: ["hookSpecificOutput"], hso: ["hookEventName", "additionalContext"] },
  PostToolBatch: { top: ["hookSpecificOutput"], hso: ["hookEventName", "additionalContext"] },
  Stop: { top: ["decision", "reason"], hso: [] },
};

/** 兜底：把任何不在白名单里的字段删掉（包括 continue、stopReason、suppressOutput、updatedInput、systemMessage 等）。 */
export function sanitize(out: Record<string, unknown>, at: HookPoint): Record<string, unknown> {
  const allowed = ALLOWED[at];
  const res: Record<string, unknown> = {};
  for (const k of allowed.top) if (k in out && out[k] !== undefined) res[k] = out[k];
  if (res.hookSpecificOutput && typeof res.hookSpecificOutput === "object") {
    const src = res.hookSpecificOutput as Record<string, unknown>;
    const h: Record<string, unknown> = {};
    for (const k of allowed.hso) if (k in src && src[k] !== undefined) h[k] = src[k];
    res.hookSpecificOutput = h;
  }
  return res;
}

/**
 * 渲染一个 Delivery。返回 null 表示「没有要说的」——钩子应当 exit 0 且不输出任何内容。
 *
 * - PreToolUse：block→deny、ask→ask（都不带 additionalContext）；advise→只有 additionalContext。
 * - PostToolUse / PostToolUseFailure / PostToolBatch：只有 additionalContext。在这些事件上请求 block/ask 时降级为
 *   additionalContext（工具已经执行，拦不住），绝不输出 permissionDecision 或 decision:"block"。
 * - Stop：stop_continue→decision:"block"+reason；stop_hook_active=true 时不 block；其他 kind 在 Stop 上没有合法的输出字段，返回 null。
 */
export function render(d: Delivery | null | undefined, at: HookPoint, ctx: RenderContext = {}): ClaudeOutput | null {
  if (!d) return null;
  const text = truncate(d.text ?? "");
  if (!text) return null;
  let out: Record<string, unknown>;
  switch (at) {
    case "PreToolUse":
      if (d.kind === "block" || d.kind === "ask") {
        out = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: d.kind === "block" ? "deny" : "ask", permissionDecisionReason: text } };
      } else if (d.kind === "advise") {
        out = { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text } };
      } else return null; // stop_continue 在 PreToolUse 上没有意义
      break;
    case "PostToolUse":
    case "PostToolUseFailure":
    case "PostToolBatch":
      if (d.kind === "stop_continue") return null;
      out = { hookSpecificOutput: { hookEventName: at, additionalContext: text } };
      break;
    case "Stop":
      if (d.kind !== "stop_continue" || ctx.stopHookActive) return null;
      out = { decision: "block", reason: text };
      break;
    default:
      return null;
  }
  return sanitize(out, at) as unknown as ClaudeOutput;
}

/** 钩子的 stdout：没有内容时是空串。 */
export function serialize(out: ClaudeOutput | null): string {
  return out ? JSON.stringify(out) : "";
}

/** X2 的本地决定 → Delivery（Claude 上 CI/.env 是 ask，其余 deny）。 */
export function deliveryFromX2(r: X2Result): Delivery {
  return { kind: r.action === "ask" ? "ask" : "block", text: r.reason, ruleId: "X2" };
}
