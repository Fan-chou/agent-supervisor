// origin 登记（P0-6）：我们注入的文本会被 harness 回显成 user 消息（UserPromptSubmit、Codex 的 Stop reason、
// OpenCode 的 user 消息）。按文本哈希登记，回显时标成 supervisor，不重置「本轮」计数，也不触发 §6 的关键词例外。
import { shortHash } from "./hash.ts";
import type { Origin } from "./event.ts";

function norm(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export class OriginRegistry {
  private hashes = new Set<string>();
  private texts: string[] = []; // 用于「回显时被包了一层前缀/后缀」的包含匹配
  constructor(private readonly maxTexts = 200) {}

  register(text: string): string {
    const n = norm(text);
    const h = shortHash(n);
    this.hashes.add(h);
    this.texts.push(n);
    if (this.texts.length > this.maxTexts) this.texts.shift();
    return h;
  }

  isSupervisor(text: string): boolean {
    const n = norm(text);
    if (!n) return false;
    if (this.hashes.has(shortHash(n))) return true;
    // harness 可能给回显文本加前缀（如 "Stop hook feedback:"），所以做包含匹配（登记文本至少 20 字符才参与）
    return this.texts.some((t) => t.length >= 20 && n.includes(t));
  }

  /** 给定 harness 上看到的 user 消息，返回应标记的 origin。 */
  classify(text: string, fallback: Origin = "user"): Origin {
    return this.isSupervisor(text) ? "supervisor" : fallback;
  }
}
