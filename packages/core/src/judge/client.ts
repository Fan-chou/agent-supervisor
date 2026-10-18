// judge 客户端：可配置的 OpenAI 兼容接口（design §8）。
// - 传输层可注入（测试里一律用 fake transport，不发网络请求；没注入时才在调用时取 globalThis.fetch）。
// - 超时用 AbortController；同步 15 秒、异步 30 秒，来自 config。
// - response_format 被上游拒绝时降一级重试一次，并按 model 缓存。
// - 解析失败：只对异步调用重试一次；最终失败返回 parse_fail，并按 model 统计。
// - key 只按 api_key_env 给的变量名读取（也读 ADVISOR_API_KEY），不进日志、不进错误信息。
import type { Config } from "../config.ts";
import { redact } from "../redact.ts";
import { parseJudgeResponse } from "./parse.ts";
import { buildJudgeMessages, type PromptStyle } from "./prompt.ts";
import { JUDGE_SCHEMA } from "./parse.ts";
import type { JudgeFn, JudgeMeta, JudgeRequest, JudgeResult } from "./types.ts";

export type ResponseFormatLevel = "json_schema" | "json_object" | "none";

export interface TransportInit {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}
export interface TransportResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}
export type JudgeTransport = (url: string, init: TransportInit) => Promise<TransportResponse>;

export interface JudgeClientOptions {
  cfg: Config["judge"];
  env?: Record<string, string | undefined>;
  transport?: JudgeTransport;
  /** 覆盖超时（毫秒），测试用；默认取 config 的 timeout_sync_s / timeout_async_s。 */
  timeoutMs?: { sync?: number; async?: number };
  promptStyle?: PromptStyle;
}

export interface ModelStats {
  calls: number;
  ok: number;
  ignores: number;
  parseFail: number;
  timeouts: number;
  errors: number;
  httpRequests: number;
}

const NEXT_LEVEL: Record<ResponseFormatLevel, ResponseFormatLevel | null> = { json_schema: "json_object", json_object: "none", none: null };
const UNSUPPORTED_HINT = /response_format|json_schema|json_object|structured|schema|not support|unsupported|invalid.*format/i;

/** 错误信息只允许短、脱敏、且不含任何 Authorization 头的痕迹。 */
function scrubError(s: string): string {
  return redact(s)
    .replace(/authorization\s*[:=]\s*(bearer\s+)?\S+/gi, "[header removed]")
    .replace(/\bbearer\s+\S+/gi, "[credential removed]")
    .slice(0, 200);
}

/** 响应正文落盘前：脱敏、去 Authorization 痕迹、限长。 */
function scrubBody(s: string): string {
  return redact(s).replace(/authorization\s*[:=]\s*(bearer\s+)?\S+/gi, "[header removed]").slice(0, 20_000);
}

const globToRe = (g: string) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");

export class JudgeClient {
  readonly stats = new Map<string, ModelStats>();
  /** 按 model 缓存降级后的 response_format。 */
  readonly formatCache = new Map<string, ResponseFormatLevel>();
  private readonly cfg: Config["judge"];
  private readonly env: Record<string, string | undefined>;
  private readonly transport?: JudgeTransport;

  constructor(private readonly opts: JudgeClientOptions) {
    this.cfg = opts.cfg;
    this.env = opts.env ?? process.env;
    this.transport = opts.transport;
  }

  /** 绑定好的 JudgeFn，可以直接交给 Engine / Policy。 */
  readonly judge: JudgeFn = (req) => this.call(req);

  private apiKey(): string | undefined {
    return this.env[this.cfg.api_key_env] || this.env.ADVISOR_API_KEY || undefined;
  }

  routeModel(req: JudgeRequest): string {
    for (const r of this.cfg.routes ?? []) {
      const w = r.when ?? {};
      if (w.sync !== undefined && w.sync !== req.sync) continue;
      if (w.rule !== undefined && !req.hits.some((h) => globToRe(w.rule!).test(h.ruleId))) continue;
      return r.model;
    }
    return this.cfg.model;
  }

  private stat(model: string): ModelStats {
    let s = this.stats.get(model);
    if (!s) {
      s = { calls: 0, ok: 0, ignores: 0, parseFail: 0, timeouts: 0, errors: 0, httpRequests: 0 };
      this.stats.set(model, s);
    }
    return s;
  }

  parseFailRate(model: string): number {
    const s = this.stats.get(model);
    return s && s.calls ? s.parseFail / s.calls : 0;
  }

  private startLevel(model: string): ResponseFormatLevel {
    const cached = this.formatCache.get(model);
    if (cached) return cached;
    const cfg = this.cfg.response_format;
    return cfg === "auto" ? "json_schema" : cfg === "json_schema" || cfg === "json_object" ? cfg : "none";
  }

  private body(model: string, messages: { role: string; content: string }[], level: ResponseFormatLevel): string {
    const { extra_body, headers: _h, ...req } = (this.cfg.request ?? {}) as Record<string, unknown>;
    void _h;
    const body: Record<string, unknown> = { model, messages, stream: false, ...req, ...((extra_body as Record<string, unknown>) ?? {}) };
    if (level === "json_schema") body.response_format = { type: "json_schema", json_schema: { name: "supervisor_verdict", strict: true, schema: JUDGE_SCHEMA } };
    else if (level === "json_object") body.response_format = { type: "json_object" };
    return JSON.stringify(body);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    const extra = (this.cfg.request as { headers?: Record<string, string> } | undefined)?.headers;
    if (extra) for (const [k, v] of Object.entries(extra)) h[k.toLowerCase()] = String(v);
    const key = this.apiKey();
    if (key) h.authorization = `Bearer ${key}`;
    return h;
  }

  async call(req: JudgeRequest): Promise<JudgeResult> {
    const t0 = Date.now();
    const meta: JudgeMeta = { httpRequests: 0, retries: 0 };
    const r = await this.callInner(req, meta);
    meta.latencyMs = Date.now() - t0;
    return { ...r, meta };
  }

  private async callInner(req: JudgeRequest, meta: JudgeMeta): Promise<JudgeResult> {
    const model = this.routeModel(req);
    const st = this.stat(model);
    st.calls++;
    const budgetMs = req.sync ? (this.opts.timeoutMs?.sync ?? this.cfg.timeout_sync_s * 1000) : (this.opts.timeoutMs?.async ?? this.cfg.timeout_async_s * 1000);
    const deadline = Date.now() + budgetMs;
    const built = buildJudgeMessages(req, { style: this.opts.promptStyle });
    const messages: { role: string; content: string }[] = [
      { role: "system", content: built.system },
      { role: "user", content: built.user },
    ];
    meta.routeModel = model;
    meta.requestBody = JSON.stringify({ model, messages, truncated: built.truncated });
    let level = this.startLevel(model);
    let downgraded = false;
    let parseRetried = false;
    let lastRaw: string | undefined;
    // 最多：1 次正常请求 + 1 次降级重试 + 1 次解析失败重试
    for (let guard = 0; guard < 4; guard++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        st.timeouts++;
        return { kind: "timeout", model };
      }
      const res = await this.http(model, messages, level, remaining);
      st.httpRequests++;
      meta.httpRequests = (meta.httpRequests ?? 0) + 1;
      meta.formatLevel = level;
      if (res.kind === "timeout") {
        st.timeouts++;
        return { kind: "timeout", model };
      }
      if (res.kind === "error") {
        st.errors++;
        return { kind: "error", error: res.error, model };
      }
      if (res.status >= 400) {
        if (res.status < 500 && res.status !== 429 && !downgraded && NEXT_LEVEL[level] && UNSUPPORTED_HINT.test(res.text)) {
          level = NEXT_LEVEL[level]!;
          this.formatCache.set(model, level);
          downgraded = true;
          meta.formatDowngraded = true;
          continue;
        }
        st.errors++;
        return { kind: "error", error: scrubError(`HTTP ${res.status}: ${res.text}`), model };
      }
      let json: unknown;
      try {
        json = JSON.parse(res.text);
      } catch {
        json = null;
      }
      const parsed = json === null ? ({ ok: false, reason: "response-not-json", repairs: [] } as const) : parseJudgeResponse(json);
      meta.repairs = [...parsed.repairs];
      meta.responseBody = scrubBody(res.text);
      const usage = (json as { usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } } | null)?.usage;
      if (usage) {
        meta.promptTokens = usage.prompt_tokens;
        meta.completionTokens = usage.completion_tokens;
        meta.cachedTokens = usage.prompt_tokens_details?.cached_tokens;
      }
      if (parsed.ok) {
        st.ok++;
        if (parsed.out.verdict === "ignore") st.ignores++;
        return { kind: "ok", out: parsed.out, model };
      }
      lastRaw = res.text;
      // 只有异步调用才重试解析（同步调用在等 agent，等不起）
      if (!req.sync && !parseRetried) {
        parseRetried = true;
        meta.retries = 1;
        messages.push({ role: "assistant", content: redact(res.text).slice(0, 2000) });
        messages.push({ role: "user", content: "The previous output was not valid JSON for the required schema. Reply with ONLY one JSON object matching the schema." });
        continue;
      }
      break;
    }
    st.parseFail++;
    return { kind: "parse_fail", model, raw: lastRaw ? scrubError(lastRaw) : undefined };
  }

  private async http(model: string, messages: { role: string; content: string }[], level: ResponseFormatLevel, timeoutMs: number): Promise<{ kind: "ok"; status: number; text: string } | { kind: "timeout" } | { kind: "error"; error: string }> {
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, timeoutMs);
    try {
      const url = this.cfg.base_url.replace(/\/+$/, "") + "/chat/completions";
      const transport = this.transport ?? ((u, i) => (globalThis.fetch as unknown as JudgeTransport)(u, i));
      const racing = new Promise<never>((_, rej) => ac.signal.addEventListener("abort", () => rej(new Error("aborted"))));
      const resp = await Promise.race([transport(url, { method: "POST", headers: this.headers(), body: this.body(model, messages, level), signal: ac.signal }), racing]);
      const text = await Promise.race([resp.text(), racing]);
      return { kind: "ok", status: resp.status, text };
    } catch (e) {
      if (timedOut || ac.signal.aborted) return { kind: "timeout" };
      // 错误信息只带异常消息（不含请求头/URL 查询串），再过一遍脱敏
      return { kind: "error", error: scrubError(String((e as Error)?.message ?? e)) };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createJudgeClient(opts: JudgeClientOptions): JudgeClient {
  return new JudgeClient(opts);
}
