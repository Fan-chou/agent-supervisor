// design §3.4 的统一注入抽象：各 harness 的 render() 共用。除 kind/text 之外的字段是内部簿记，绝不能出现在任何 harness 的输出里。
export type DeliveryKind = "block" | "ask" | "advise" | "stop_continue";

export interface Delivery {
  kind: DeliveryKind;
  text: string;
  deliveryId?: string;
  ruleId?: string;
  createdAtSeq?: number;
  expires?: unknown;
}

/** additionalContext 超过 10k 字符 Claude 会转存文件、Codex 约 2,500 token 上限，所以统一 ≤600 字符。 */
export const MAX_TEXT = 600;

export function truncate(text: string, max = MAX_TEXT): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + "…";
}
