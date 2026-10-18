// Codex 0.163.x 的 render()：Delivery → 钩子输出 JSON。只按 design §3.5 的白名单输出字段，其他字段一律删掉。
// Codex 对输出非常挑剔：`ask`、`continue`、`stopReason`、`suppressOutput` 都会让钩子被判失败（工具照常执行），
// `updatedInput` 只能和 allow 一起用——所以这些字段永远不输出（白名单兜底 + 契约测试逐格断言）。
import { MAX_TEXT, truncate, type Delivery, type DeliveryKind, type X2Result } from "@sv/core";

export { MAX_TEXT, truncate };
export type { Delivery, DeliveryKind };

/** Codex 只有这三个我们会输出的注入点（没有 PostToolUseFailure / PostToolBatch）。 */
export type CodexHookPoint = "PreToolUse" | "PostToolUse" | "Stop";

export interface RenderContext {
  /** Stop 钩子输入里的 stop_hook_active：为 true 时不再 block。 */
  stopHookActive?: boolean;
}

export type CodexOutput =
  | { hookSpecificOutput: { hookEventName: "PreToolUse"; permissionDecision: "deny"; permissionDecisionReason: string } }
  | { hookSpecificOutput: { hookEventName: "PreToolUse" | "PostToolUse"; additionalContext: string } }
  | { decision: "block"; reason: string };

/** 每个事件允许的字段（§3.5 表）。注意没有 `ask`：permissionDecision 只会是 "deny"。 */
export const ALLOWED: Record<CodexHookPoint, { top: readonly string[]; hso: readonly string[] }> = {
  PreToolUse: { top: ["hookSpecificOutput"], hso: ["hookEventName", "permissionDecision", "permissionDecisionReason", "additionalContext"] },
  PostToolUse: { top: ["hookSpecificOutput"], hso: ["hookEventName", "additionalContext"] },
  Stop: { top: ["decision", "reason"], hso: [] },
};

export function isCodexHookPoint(x: unknown): x is CodexHookPoint {
  return x === "PreToolUse" || x === "PostToolUse" || x === "Stop";
}

/** 兜底：把任何不在白名单里的字段删掉。 */
export function sanitize(out: Record<string, unknown>, at: CodexHookPoint): Record<string, unknown> {
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
 * - PreToolUse：block→deny；**ask→deny**（Codex 不支持 ask，输出 ask 会让钩子失败、工具照常执行；
 *   保守起见按 deny 处理，原因文字里已经说明需要用户确认）；advise→只有 additionalContext。deny 绝不带 additionalContext。
 * - PostToolUse：只有 additionalContext。工具已经执行，block/ask 在这里拦不住，降级成 additionalContext
 *   （第一阶段不用 decision:block），绝不输出 permissionDecision 或 decision。
 * - Stop：stop_continue→decision:"block"+reason（reason 会成为一条新的 user prompt，由调用方登记 origin=supervisor）；
 *   stop_hook_active=true 时不 block；其他 kind 在 Stop 上没有合法的输出字段，返回 null。
 * - 传入 Codex 没有的注入点（PostToolUseFailure、PostToolBatch…）一律返回 null。
 */
export function render(d: Delivery | null | undefined, at: CodexHookPoint | string, ctx: RenderContext = {}): CodexOutput | null {
  if (!d || !isCodexHookPoint(at)) return null;
  const text = truncate(d.text ?? "");
  if (!text) return null;
  let out: Record<string, unknown>;
  switch (at) {
    case "PreToolUse":
      if (d.kind === "block" || d.kind === "ask") {
        out = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: text } };
      } else if (d.kind === "advise") {
        out = { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text } };
      } else return null;
      break;
    case "PostToolUse":
      if (d.kind === "stop_continue") return null;
      out = { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } };
      break;
    case "Stop":
      if (d.kind !== "stop_continue" || ctx.stopHookActive) return null;
      out = { decision: "block", reason: text };
      break;
  }
  return sanitize(out, at) as unknown as CodexOutput;
}

/** 渲染出的最终文本（截断后）——登记 origin 哈希时必须用这个，而不是原始 text。 */
export function emittedText(out: CodexOutput | null): string | undefined {
  if (!out) return undefined;
  if ("decision" in out) return out.reason;
  const h = out.hookSpecificOutput;
  return "permissionDecisionReason" in h ? h.permissionDecisionReason : h.additionalContext;
}

export function serialize(out: CodexOutput | null): string {
  return out ? JSON.stringify(out) : "";
}

/** X2 的本地决定 → Delivery。Codex 上一律 deny（x2Check 对非 Claude harness 已经全部返回 deny）。 */
export function deliveryFromX2(r: X2Result): Delivery {
  return { kind: "block", text: r.reason, ruleId: "X2" };
}
