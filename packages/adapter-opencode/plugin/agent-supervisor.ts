// agent-supervisor 的 OpenCode V2 插件（旁路监督；shadow 下只收事件，永不拦截）。
// 这个文件自包含（只用 node:*，不 import 本仓库任何东西）：`sv install opencode` 会把它原样打印出来，由用户自己放进 OpenCode 的插件目录。
// 约束（CLAUDE.md / design §3.3）：插件跑在 OpenCode 进程内，**任何异常都要 catch**，守护进程不可达/超时/响应坏掉一律 fail-open。
// V2 的 hook 对象字段形态【未实测】，下面对工具名/参数/callID 的取值都做了宽松兜底；接入真机后按实际形态校准。
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Any = any; // 故意宽松：V2 的真实类型未核实
type Mode = "shadow" | "advise" | "enforce";
interface Delivery {
  kind?: string;
  text?: string;
}
interface Reply {
  delivery: Delivery | null;
  mode: Mode;
}

const EVENT_TIMEOUT_MS = 4_000;
const BEFORE_TIMEOUT_MS = 18_000; // tool.before 可能同步等 H 级 judge（design §3.1 的硬超时）
const EVALUATE_TIMEOUT_MS = 5_000;
const MAX_TEXT = 600;
const MAX_FIELD = 20_000;

const home = () => process.env.SV_HOME ?? join(homedir(), ".agent-supervisor");

function cap(v: Any, n = MAX_FIELD): Any {
  if (typeof v === "string") return v.length > n ? v.slice(0, n) : v;
  return v;
}

/** 把任意值压成可 JSON 序列化的小对象（字符串截断；循环/不可序列化 → 丢弃）。 */
function plain(v: Any): Any {
  try {
    return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "string" ? cap(x) : x)));
  } catch {
    return undefined;
  }
}

async function post(body: Record<string, unknown>, timeoutMs: number): Promise<Reply | null> {
  try {
    const h = home();
    let cfg: Any = {};
    try {
      cfg = JSON.parse(readFileSync(join(h, "hook.json"), "utf8"));
    } catch {
      /* 没有 hook.json：按默认 socket 位置试一次 */
    }
    const payload = JSON.stringify({ harness: "opencode", payload: body });
    const headers: Record<string, string> = { "content-type": "application/json", "x-sv-protocol": "1" };
    const signal = AbortSignal.timeout(timeoutMs);
    let res: Response;
    if (cfg.socket || (!cfg.port && existsSync(join(h, "sock")))) {
      res = await fetch("http://localhost/v1/hook", { unix: cfg.socket ?? join(h, "sock"), method: "POST", headers, body: payload, signal } as Any);
    } else if (cfg.port) {
      const token = readFileSync(join(h, "token"), "utf8").trim();
      res = await fetch(`http://127.0.0.1:${cfg.port}/v1/hook`, { method: "POST", headers: { ...headers, authorization: `Bearer ${token}` }, body: payload, signal });
    } else return null;
    if (res.status !== 200) return null;
    const j: Any = await res.json();
    const d = j && typeof j === "object" && j.delivery && typeof j.delivery === "object" ? (j.delivery as Delivery) : null;
    const mode: Mode = j?.mode === "enforce" || j?.mode === "advise" ? j.mode : "shadow";
    return { delivery: d, mode };
  } catch {
    return null; // fail-open
  }
}

/** 铁律在插件里再保一道：shadow 永不输出；advise 只放行 advise；enforce 才允许 deny。 */
function allowed(mode: Mode, kind: string | undefined): boolean {
  if (mode === "enforce") return true;
  if (mode === "advise") return kind === "advise";
  return false;
}

function text(d: Delivery | null): string {
  const t = typeof d?.text === "string" ? d.text.trim() : "";
  return t.length <= MAX_TEXT ? t : t.slice(0, MAX_TEXT - 1) + "…";
}

const sid = (e: Any): string | undefined => (typeof e?.sessionID === "string" ? e.sessionID : typeof e?.session?.id === "string" ? e.session.id : undefined);
const callId = (e: Any): string | undefined => {
  const v = e?.callID ?? e?.toolCallID ?? e?.toolCallId ?? e?.id;
  return typeof v === "string" ? v : undefined;
};
const toolName = (e: Any): string | undefined => {
  const v = e?.tool ?? e?.toolName ?? e?.name;
  return typeof v === "string" ? v : typeof v?.id === "string" ? v.id : typeof v?.name === "string" ? v.name : undefined;
};
const dirOf = (e: Any, ctx: Any): string | undefined => {
  const v = e?.directory ?? e?.location?.directory ?? ctx?.location?.directory;
  return typeof v === "string" ? v : undefined;
};

/** context 里最新一条 user 消息的文本（形态未核实：content 字符串 / parts[].text / text）。 */
function lastUserMessage(messages: Any): { id?: string; text: string } | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const role = m?.role ?? m?.info?.role;
    if (role !== "user") continue;
    let t = "";
    if (typeof m.content === "string") t = m.content;
    else if (typeof m.text === "string") t = m.text;
    else if (Array.isArray(m.parts ?? m.content)) t = (m.parts ?? m.content).map((p: Any) => (typeof p?.text === "string" ? p.text : "")).join("\n");
    return { id: typeof m.id === "string" ? m.id : typeof m.info?.id === "string" ? m.info.id : undefined, text: cap(t.trim(), 4000) };
  }
  return undefined;
}

function setup(ctx: Any): void {
  // 每个会话一份状态，全在内存里；重启即清空
  const lastUser = new Map<string, string>(); // sessionID → 上次上报的 user 消息 id/文本
  const repeat = new Map<string, { text: string; left: number }>(); // context 建议的重复注入（inject_repeat：连续 2 次请求，或到下一次工具调用结束）

  const guard = <F extends (e: Any) => Promise<void>>(f: F) => async (e: Any) => {
    try {
      await f(e);
    } catch {
      /* 任何异常都不能影响 OpenCode */
    }
  };
  const hook = (target: Any, name: string, f: (e: Any) => Promise<void>) => {
    try {
      target?.hook?.(name, guard(f));
    } catch {
      /* 这个 hook 注册不上就算了：fail-open */
    }
  };

  // 拦截（主）：deny 必须带 message，否则 plain rejection 会结束当前 step
  hook(ctx?.permission, "evaluate", async (e) => {
    const r = await post({ event: "permission.evaluate", sessionID: sid(e), directory: dirOf(e, ctx) }, EVALUATE_TIMEOUT_MS);
    const t = text(r?.delivery ?? null);
    if (!r || !t || (r.delivery?.kind !== "block" && r.delivery?.kind !== "ask") || !allowed(r.mode, r.delivery?.kind)) return;
    e.effect = "deny";
    e.message = t;
  });

  // 建议（主）：只作用于这一次请求，不写入历史
  hook(ctx?.session, "context", async (e) => {
    const s = sid(e);
    if (!s) return;
    const rep = repeat.get(s);
    if (rep && rep.left > 0 && Array.isArray(e.system)) {
      rep.left--;
      e.system.push(rep.text);
      return;
    }
    const um = lastUserMessage(e.messages);
    const key = um ? `${um.id ?? ""}\u0000${um.text}` : undefined;
    const fresh = um && key !== lastUser.get(s);
    if (um && key) lastUser.set(s, key);
    const r = await post({ event: "context", sessionID: s, directory: dirOf(e, ctx), model: plain(e.model), agent: plain(e.agent), ...(fresh ? { userMessage: { id: um!.id, text: um!.text } } : {}) }, EVENT_TIMEOUT_MS);
    const t = text(r?.delivery ?? null);
    if (!r || !t || r.delivery?.kind !== "advise" || !allowed(r.mode, "advise") || !Array.isArray(e.system)) return;
    e.system.push(t);
    repeat.set(s, { text: t, left: 1 });
  });

  // 观测：before 是 Pre 事件的来源（含完整参数），after 带明确的 completed/error 状态
  hook(ctx?.tool, "execute.before", async (e) => {
    await post({ event: "tool.before", sessionID: sid(e), directory: dirOf(e, ctx), callID: callId(e), tool: toolName(e), args: plain(e?.args ?? e?.input ?? e?.params) }, BEFORE_TIMEOUT_MS);
  });
  hook(ctx?.tool, "execute.after", async (e) => {
    const s = sid(e);
    if (s) repeat.delete(s); // 下一次工具调用结束，旧建议不再重复
    const status = e?.status === "error" || e?.error ? "error" : "completed";
    await post({ event: "tool.after", sessionID: s, directory: dirOf(e, ctx), callID: callId(e), tool: toolName(e), args: plain(e?.args ?? e?.input ?? e?.params), status, result: plain(e?.result ?? e?.output), error: plain(e?.error) }, EVENT_TIMEOUT_MS);
  });
}

// 注意：V2 要求写成 Plugin.define({ id, setup(ctx) })；导入路径以 OpenCode 当前文档为准，这里不猜包名，直接导出等价的对象。
export default {
  id: "agent-supervisor",
  setup(ctx: Any) {
    try {
      setup(ctx);
    } catch {
      /* fail-open */
    }
  },
};
