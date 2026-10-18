// judge 响应的稳健解析与修复（design §8.5）+ 本地语义校验（§8.4）。
// 不假设上游一定遵守 schema：Magpie 会在不同模型之间路由，最终回复不保证符合 schema。
import type { Category } from "../detectors/types.ts";
import type { JudgeOutput, JudgeWatch, Verdict } from "./types.ts";

export const CATEGORIES: readonly Category[] = ["loop", "stagnation", "over_testing", "scope", "premature_done", "test_gaming", "drift", "unsafe", "other"];

/** design §8.4：strict 兼容（全部属性都在 required 里，可以为 null，嵌套对象禁止额外字段）。 */
export const JUDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "confidence", "category", "message_to_agent", "reason", "evidence_steps", "watch", "done"],
  properties: {
    verdict: { type: "string", enum: ["ignore", "advise", "block"] },
    confidence: { type: "number" },
    category: { type: "string", enum: [...CATEGORIES] },
    message_to_agent: { type: ["string", "null"] },
    reason: { type: "string" },
    evidence_steps: { type: "array", items: { type: "integer" } },
    watch: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["rule", "text_contains", "tool", "ttl_steps"],
        properties: {
          rule: { type: "string" },
          text_contains: { type: ["string", "null"] },
          tool: { type: ["string", "null"] },
          ttl_steps: { type: "integer" },
        },
      },
    },
    done: { type: "boolean" },
  },
} as const;

export type ParseResult = { ok: true; out: JudgeOutput; repairs: string[] } | { ok: false; reason: string; repairs: string[] };

// ---------- 1. 取内容 ----------

/** 取 choices[0].message.content；content 是数组时把 text 部分拼起来。 */
export function extractContent(resp: unknown): string | null {
  const r = resp as { choices?: { message?: { content?: unknown }; text?: unknown }[] } | null;
  const c = r?.choices?.[0];
  if (!c) return null;
  const content = c.message?.content ?? c.text;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
      .join("");
  }
  return null;
}

// ---------- 2. 去推理块和代码块 ----------

export function stripWrappers(s: string): { text: string; repairs: string[] } {
  const repairs: string[] = [];
  let t = s;
  const noThink = t.replace(/<(think|thinking|reasoning|thought)>[\s\S]*?<\/\1>/gi, "");
  if (noThink !== t) repairs.push("strip-think");
  t = noThink.replace(/^[\s\S]*?<\/(think|thinking|reasoning)>/i, (m) => (/<(think|thinking|reasoning)>/i.test(m) ? m : (repairs.push("strip-unopened-think"), "")));
  // 代码块包裹：取第一个包含 { 的围栏内容
  const fence = /```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)(```|$)/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(t))) {
    if (m[1].includes("{")) {
      t = m[1];
      repairs.push("strip-fence");
      break;
    }
  }
  return { text: t, repairs };
}

// ---------- 3. 第一个配平的 {...}（按字符串和转义状态做括号匹配） ----------

export function findJsonObject(s: string): { text: string; balanced: boolean } | null {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr: string | null = null;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "“" || c === "”") {
      // 单引号只在作为 JSON 字符串界定符时才有意义；这里宽松处理，仅 " 和中文引号视为字符串
      if (c === "'") continue;
      inStr = c === "“" ? "”" : c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return { text: s.slice(start, i + 1), balanced: true };
    }
  }
  return { text: s.slice(start), balanced: false };
}

// ---------- 4. 轻量修复 ----------

export function repairJson(s: string): { text: string; repairs: string[] } {
  const repairs: string[] = [];
  let t = s;
  const sub = (re: RegExp, to: string | ((...a: string[]) => string), name: string) => {
    const n = t.replace(re, to as never);
    if (n !== t) repairs.push(name);
    t = n;
  };
  // 中文引号 → 英文引号
  sub(/[“”„‟]/g, '"', "curly-quotes");
  sub(/[‘’]/g, "'", "curly-single-quotes");
  // Python 风格字面量
  sub(/:\s*True\b/g, ": true", "py-true");
  sub(/:\s*False\b/g, ": false", "py-false");
  sub(/:\s*None\b/g, ": null", "py-none");
  // 单引号键名 / 单引号字符串值 → 双引号（不处理内部含 " 的复杂情况）
  sub(/([{,]\s*)'([^'"\n]+?)'\s*:/g, '$1"$2":', "single-quote-keys");
  sub(/:\s*'([^'"\n]*?)'(\s*[,}\]])/g, ': "$1"$2', "single-quote-values");
  // 无引号键名
  sub(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":', "bare-keys");
  // 注释
  sub(/^\s*\/\/.*$/gm, "", "line-comments");
  // 尾随逗号
  sub(/,(\s*[}\]])/g, "$1", "trailing-commas");
  // 补全被截断的末尾：未闭合的字符串、数组、对象
  const closed = closeTruncated(t);
  if (closed !== t) {
    repairs.push("close-truncated");
    t = closed;
    sub(/,(\s*[}\]])/g, "$1", "trailing-commas");
  }
  return { text: t, repairs };
}

function closeTruncated(s: string): string {
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (const c of s) {
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") stack.push("}");
    else if (c === "[") stack.push("]");
    else if ((c === "}" || c === "]") && stack.length) stack.pop();
  }
  if (!inStr && stack.length === 0) return s;
  let out = s;
  if (inStr) out += '"';
  // 截断在 "key": 之后（缺值）时补 null
  if (/:\s*$/.test(out)) out += "null";
  out = out.replace(/,\s*$/, "");
  return out + stack.reverse().join("");
}

// ---------- 5. 宽松字段映射 ----------

const VERDICT_SYNONYMS: Record<string, Verdict> = {
  ignore: "ignore",
  allow: "ignore",
  pass: "ignore",
  ok: "ignore",
  none: "ignore",
  skip: "ignore",
  advise: "advise",
  warn: "advise",
  warning: "advise",
  suggest: "advise",
  suggestion: "advise",
  advice: "advise",
  hint: "advise",
  block: "block",
  deny: "block",
  stop: "block",
  reject: "block",
  halt: "block",
};

export function normalizeVerdict(v: unknown): Verdict | null {
  if (typeof v !== "string") return null;
  return VERDICT_SYNONYMS[v.trim().toLowerCase().replace(/[^a-z]/g, "")] ?? null;
}

export function normalizeConfidence(v: unknown): number | null {
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "string") {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*(%?)\s*$/.exec(v);
    if (!m) {
      const w = { high: 0.9, medium: 0.6, low: 0.3 }[v.trim().toLowerCase() as "high"];
      return w ?? null;
    }
    n = Number(m[1]);
    if (m[2] === "%") n /= 100;
  } else return null;
  if (!Number.isFinite(n)) return null;
  if (n > 1 && n <= 100) n /= 100; // 85 → 0.85
  return Math.min(1, Math.max(0, n));
}

function toBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return /^(true|yes|1)$/i.test(v.trim());
  return v === 1;
}

function normalizeWatch(v: unknown, repairs: string[]): JudgeWatch[] {
  if (!Array.isArray(v)) return [];
  const out: JudgeWatch[] = [];
  for (const w of v) {
    if (!w || typeof w !== "object") continue;
    const o = w as Record<string, unknown>;
    const rule = typeof o.rule === "string" ? o.rule : "";
    const text = typeof o.text_contains === "string" && o.text_contains !== "" ? o.text_contains : null;
    const tool = typeof o.tool === "string" && o.tool !== "" ? o.tool : null;
    let ttl = typeof o.ttl_steps === "number" ? Math.round(o.ttl_steps) : typeof o.ttl_steps === "string" ? Number.parseInt(o.ttl_steps, 10) : 10;
    if (!Number.isFinite(ttl)) ttl = 10;
    ttl = Math.min(50, Math.max(1, ttl));
    // 通配监视器（iterion 的防护）：rule 为 * 且 text 和 tool 都为空 → 丢弃
    if ((rule === "*" || rule === "") && !text && !tool) {
      repairs.push("drop-wildcard-watch");
      continue;
    }
    if (typeof o.text_contains === "string" && o.text_contains !== "" && o.text_contains.length < 3) {
      repairs.push("drop-short-watch");
      continue;
    }
    out.push({ rule: rule || "*", text_contains: text, tool, ttl_steps: ttl });
  }
  if (out.length > 3) repairs.push("watch-capped");
  return out.slice(0, 3);
}

export const MAX_MESSAGE = 600;

/** 把任意解析出来的对象映射并校验成 JudgeOutput。 */
export function coerceOutput(raw: unknown, repairs: string[] = []): ParseResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "not-an-object", repairs };
  const o = raw as Record<string, unknown>;
  const verdict = normalizeVerdict(o.verdict ?? o.decision ?? o.action);
  if (!verdict) return { ok: false, reason: "bad-verdict", repairs };
  if (typeof o.verdict === "string" && o.verdict !== verdict) repairs.push("verdict-synonym");
  const confRaw = o.confidence;
  let confidence = normalizeConfidence(confRaw);
  if (confidence === null) {
    if (confRaw === undefined || confRaw === null) {
      confidence = 0.5; // 缺失：给中间值，低于默认拦截门槛 0.8，所以不会因此拦截
      repairs.push("confidence-missing");
    } else return { ok: false, reason: "bad-confidence", repairs };
  } else if (typeof confRaw !== "number" || confRaw > 1 || confRaw < 0) repairs.push("confidence-normalized");
  const catRaw = typeof o.category === "string" ? o.category.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  const category = (CATEGORIES as readonly string[]).includes(catRaw) ? (catRaw as Category) : "other";
  if (category !== catRaw) repairs.push("category-unknown→other");
  let message: string | null = typeof o.message_to_agent === "string" ? o.message_to_agent.trim() : o.message_to_agent == null ? null : String(o.message_to_agent);
  if (message === "") message = null;
  if (verdict !== "ignore") {
    if (!message) return { ok: false, reason: "message-required", repairs };
    if (message.length > MAX_MESSAGE) {
      message = message.slice(0, MAX_MESSAGE - 1) + "…";
      repairs.push("message-truncated");
    }
  }
  const ev = Array.isArray(o.evidence_steps) ? o.evidence_steps.map((x) => (typeof x === "string" ? Number.parseInt(x.replace(/^#/, ""), 10) : x)).filter((x): x is number => typeof x === "number" && Number.isInteger(x)) : [];
  const out: JudgeOutput = {
    verdict,
    confidence,
    category,
    message_to_agent: message,
    reason: typeof o.reason === "string" ? o.reason : "",
    evidence_steps: ev,
    watch: normalizeWatch(o.watch, repairs),
    done: toBool(o.done),
  };
  return { ok: true, out, repairs };
}

/** 完整流水线：content → JudgeOutput。 */
export function parseJudgeContent(content: string): ParseResult {
  const stripped = stripWrappers(content);
  const repairs = [...stripped.repairs];
  const found = findJsonObject(stripped.text);
  if (!found) return { ok: false, reason: "no-json-object", repairs };
  if (!found.balanced) repairs.push("unbalanced");
  let parsed: unknown;
  try {
    parsed = JSON.parse(found.text);
  } catch {
    const fixed = repairJson(found.text);
    repairs.push(...fixed.repairs);
    try {
      parsed = JSON.parse(fixed.text);
    } catch {
      return { ok: false, reason: "json-parse-failed", repairs };
    }
  }
  return coerceOutput(parsed, repairs);
}

/** 从整个 HTTP 响应体（已 JSON.parse）解析。 */
export function parseJudgeResponse(resp: unknown): ParseResult {
  const content = extractContent(resp);
  if (content === null) return { ok: false, reason: "no-content", repairs: [] };
  return parseJudgeContent(content);
}
