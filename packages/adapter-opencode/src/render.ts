// OpenCode V2 的 render()：Delivery → 对 hook 事件对象允许做的改动。design §3.5：只改 e.effect、e.message、e.system，不碰其他字段。
// - permission.evaluate：{ effect:"deny", message }（deny 必须带 message，否则 plain rejection 会结束当前 step）。
// - context：{ system:[text] }（只作用于这一次模型请求，不写入历史）。
// 其他注入点（tool.before / tool.after / session…）永远返回 null：那些点只用来收事件。
import { MAX_TEXT, truncate, type Delivery, type DeliveryKind, type X2Result } from "@sv/core";

export { MAX_TEXT, truncate };
export type { Delivery, DeliveryKind };

/** 我们会输出的两个注入点。 */
export type OpenCodeHookPoint = "permission.evaluate" | "context";

/** 守护进程能识别的全部 OpenCode 事件名（含只记录不输出的）。 */
export type OpenCodeEventName = OpenCodeHookPoint | "tool.before" | "tool.after" | "session.created" | "interrupt" | "prompt";

export type OpenCodeOutput = { effect: "deny"; message: string } | { system: string[] };

/** 每个注入点允许改的字段（§3.5 表）。 */
export const ALLOWED: Record<OpenCodeHookPoint, readonly string[]> = {
  "permission.evaluate": ["effect", "message"],
  context: ["system"],
};

export function isOpenCodeHookPoint(x: unknown): x is OpenCodeHookPoint {
  return x === "permission.evaluate" || x === "context";
}

/** 兜底：把任何不在白名单里的字段删掉。 */
export function sanitize(out: Record<string, unknown>, at: OpenCodeHookPoint): Record<string, unknown> {
  const res: Record<string, unknown> = {};
  for (const k of ALLOWED[at]) if (k in out && out[k] !== undefined) res[k] = out[k];
  return res;
}

/**
 * 渲染一个 Delivery；null = 不改任何东西。
 * - permission.evaluate：block 和 ask 都 → deny（V2 的 evaluate 我们只用 deny；原因文字里已写明需要用户确认）；advise 在这里没有位置，留给 context。
 * - context：只有 advise → system 追加一条；block/ask/stop_continue 在这里无意义，返回 null。
 * - OpenCode 没有 Stop 注入点（第一阶段不用 session.prompt 收尾）：stop_continue 永远 null。
 */
export function render(d: Delivery | null | undefined, at: OpenCodeHookPoint | string): OpenCodeOutput | null {
  if (!d || !isOpenCodeHookPoint(at)) return null;
  const text = truncate(d.text ?? "");
  if (!text) return null;
  let out: Record<string, unknown>;
  if (at === "permission.evaluate") {
    if (d.kind !== "block" && d.kind !== "ask") return null;
    out = { effect: "deny", message: text };
  } else {
    if (d.kind !== "advise") return null;
    out = { system: [text] };
  }
  return sanitize(out, at) as unknown as OpenCodeOutput;
}

/** 渲染出的最终文本（截断后）——登记 origin 哈希时必须用这个。 */
export function emittedText(out: OpenCodeOutput | null): string | undefined {
  if (!out) return undefined;
  return "effect" in out ? out.message : out.system[0];
}

export function serialize(out: OpenCodeOutput | null): string {
  return out ? JSON.stringify(out) : "";
}

/** X2 的本地决定 → Delivery（OpenCode 上一律 deny，见 x2Check）。 */
export function deliveryFromX2(r: X2Result): Delivery {
  return { kind: "block", text: r.reason, ruleId: "X2" };
}
