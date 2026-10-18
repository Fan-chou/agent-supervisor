// 脱敏：落盘和发给 judge 之前都要过（design §10、P0-7）。

interface Rule {
  kind: string;
  re: RegExp;
  /** 只替换捕获组 1（保留变量名等前缀）。 */
  keepPrefix?: boolean;
}

const RULES: Rule[] = [
  // 多行 PEM 块放最前面；没有结尾标记时吞到文本结束
  {
    kind: "private-key",
    re: /-----BEGIN [A-Z0-9 ]*(?:PRIVATE )?KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*KEY-----|$)/g,
  },
  { kind: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{10,}/g },
  { kind: "openai-key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/g },
  { kind: "github-pat", re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { kind: "github-token", re: /\bgh[opsur]_[A-Za-z0-9]{20,}/g },
  { kind: "aws-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "slack-token", re: /\bxox[bpas]-[A-Za-z0-9-]{8,}/g },
  { kind: "google-key", re: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: "bearer", re: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, keepPrefix: true },
  // URL 里的 user:pass@
  { kind: "url-credentials", re: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+(?=@)/gi, keepPrefix: true },
  // FOO_KEY=xxx、API_TOKEN: xxx、"secret": "xxx"
  {
    kind: "secret-assignment",
    re: /(\b[A-Za-z0-9_.-]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)S?["']?\s*[=:]\s*["']?)[^\s"'&,;}]{3,}/gi,
    keepPrefix: true,
  },
  { kind: "password", re: /(\b(?:password|passwd|pwd)["']?\s*[=:]\s*["']?)[^\s"'&,;}]{1,}/gi, keepPrefix: true },
];

export function redact(text: string): string {
  let out = text;
  for (const r of RULES) {
    out = out.replace(r.re, (...args) => {
      if (r.keepPrefix) return `${args[1]}[REDACTED:${r.kind}]`;
      return `[REDACTED:${r.kind}]`;
    });
  }
  return out;
}

/** 对任意 JSON 值里的字符串逐个脱敏；键名里带 secret 类字眼的值整体抹掉。 */
export function redactDeep<T>(v: T): T {
  if (typeof v === "string") return redact(v) as unknown as T;
  if (Array.isArray(v)) return v.map(redactDeep) as unknown as T;
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (/(?:key|token|secret|password|passwd|credential)s?$/i.test(k) && typeof val === "string" && val.length > 0) {
        o[k] = "[REDACTED:field]";
      } else o[k] = redactDeep(val);
    }
    return o as T;
  }
  return v;
}

/** 输出只保留头尾各 n 字符（默认 1000）。返回 [head, tail]；文本较短时 tail 为空串。 */
export function headTail(text: string, n = 1000): { head: string; tail: string; truncated: boolean } {
  if (text.length <= n * 2) return { head: text, tail: "", truncated: false };
  return { head: text.slice(0, n), tail: text.slice(-n), truncated: true };
}
