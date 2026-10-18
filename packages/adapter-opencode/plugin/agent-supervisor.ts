// agent-supervisor 的 OpenCode V2 插件（旁路监督；shadow 下只收事件，永不拦截）。
// 源文件只依赖 node:* 和 core 里两个纯函数（x2Check、redactDeep）；`sv install opencode` 用 Bun.build 把它们打进同一个文件再打印（自包含，由用户自己放进 OpenCode 的插件目录）。
// 约束（CLAUDE.md / design §3.3）：插件跑在 OpenCode 进程内，**任何异常都要 catch**，守护进程不可达/超时/响应坏掉一律 fail-open。
// V2 的 hook 对象字段形态【未核实】（@opencode/plugin 2.0.32 的类型文件本轮读不到，见 docs/opencode-verify.md），下面对工具名/参数/callID 的取值都做了宽松兜底；真机核对后按实际形态校准。
// Jack 的决定（decisions #88/#89）：本地 X2 在；但真机核对通过前**只观察不拦截**——deny 需要同时满足 守护进程 mode=enforce 且 SV_OPENCODE_ENFORCE=1（核对通过后才由 Jack 设置）。
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { redactDeep } from "../../core/src/redact.ts";
import { x2Check } from "../../core/src/x2.ts";

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

/** session.prompt 钩子里的 prompt（PromptInput.Prompt，形态未核实）：字符串 / {text} / {content} / 部件数组。取不到文本返回 undefined。 */
function promptText(p: Any): string | undefined {
  const fromParts = (parts: Any): string => (Array.isArray(parts) ? parts.map((x: Any) => (typeof x === "string" ? x : typeof x?.text === "string" ? x.text : "")).filter(Boolean).join("\n") : "");
  let t = "";
  if (typeof p === "string") t = p;
  else if (typeof p?.text === "string") t = p.text;
  else if (typeof p?.content === "string") t = p.content;
  else t = fromParts(p) || fromParts(p?.parts) || fromParts(p?.content);
  t = t.trim();
  return t ? cap(t, 4000) : undefined;
}

/**
 * 往 context 的 system（Array<SystemPart>）里追加一条建议。SystemPart 的真实形态没核实，所以只做两种有把握的：
 * 元素本来就是字符串 → 推字符串；元素是带字符串 text 的对象 → 复制最后一个元素的形状，只换 text。其他情况（空数组、未知形态）返回 false，不改。
 */
function injectSystem(system: Any, t: string): boolean {
  if (!Array.isArray(system) || !system.length) return false;
  const last = system[system.length - 1];
  if (typeof last === "string") {
    system.push(t);
    return true;
  }
  if (last && typeof last === "object" && typeof last.text === "string") {
    system.push({ ...last, text: t });
    return true;
  }
  return false;
}

// ---------- 真机核对用的载荷样本（SV_OPENCODE_DUMP=1，默认关；只写我们自己的目录，脱敏后落盘，0600/0700）----------

const SHAPE_DEPTH = 5;
/** 值的「形状」：键 → 类型（数组只看第一个元素）。不含任何值，所以即使正文被截断也能看出字段结构。 */
function shapeOf(v: Any, depth = 0): Any {
  if (v === null) return "null";
  if (Array.isArray(v)) return depth >= SHAPE_DEPTH ? "array" : [`array(${v.length})`, v.length ? shapeOf(v[0], depth + 1) : null];
  if (typeof v === "function") return "function";
  if (typeof v === "object") {
    if (depth >= SHAPE_DEPTH) return "object";
    const o: Record<string, Any> = {};
    for (const k of Object.keys(v).slice(0, 60)) o[k] = shapeOf(v[k], depth + 1);
    return o;
  }
  return typeof v;
}
/** 值的截断拷贝：字符串 ≤ 400 字符，数组 ≤ 6 项，深度 ≤ 5，函数只记名字。 */
function sample(v: Any, depth = 0): Any {
  if (typeof v === "string") return v.length > 400 ? v.slice(0, 400) + `…[+${v.length - 400}]` : v;
  if (typeof v === "function") return `[function ${v.name || "anonymous"}]`;
  if (v === null || typeof v !== "object") return v;
  if (depth >= SHAPE_DEPTH) return "[depth]";
  if (Array.isArray(v)) return [...v.slice(0, 6).map((x) => sample(x, depth + 1)), ...(v.length > 6 ? [`…[+${v.length - 6} items]`] : [])];
  const o: Record<string, Any> = {};
  for (const k of Object.keys(v).slice(0, 60)) o[k] = sample(v[k], depth + 1);
  return o;
}

let dumpN = 0;
function dump(hook: string, phase: "enter" | "exit" | "setup" | "note", e: Any, extra: Record<string, unknown> = {}): void {
  if (process.env.SV_OPENCODE_DUMP !== "1") return;
  try {
    const dir = join(home(), "dumps");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const ts = Date.now();
    const rec = { n: ++dumpN, ts, pid: process.pid, hook, phase, shape: shapeOf(e), sample: redactDeep(sample(e)), ...extra };
    appendFileSync(join(dir, `opencode-${new Date(ts).toISOString().slice(0, 10)}.jsonl`), JSON.stringify(rec) + "\n", { mode: 0o600 });
  } catch {
    /* 样本落盘失败不影响监督 */
  }
}

// ---------- 本地 X2（decisions #88）----------

/** 从 tool.before 的参数里取 shell 命令 / 被写的文件（字段名按 OpenCode 常见写法宽松取；V2 真实形态待核对）。 */
function x2Inputs(tool: string | undefined, args: Any): { command?: string; files?: string[] } {
  const t = (tool ?? "").toLowerCase();
  const a = args && typeof args === "object" ? args : {};
  if (t === "bash" || t === "shell") return { command: typeof a.command === "string" ? a.command : typeof a.cmd === "string" ? a.cmd : undefined };
  if (["edit", "write", "multiedit", "patch", "apply_patch"].includes(t)) {
    const f = a.filePath ?? a.file_path ?? a.path ?? a.file;
    return { files: typeof f === "string" ? [f] : undefined };
  }
  return {};
}

/** 拦截的最后一道闸：mode=enforce（hook.json）**并且** SV_OPENCODE_ENFORCE=1。核对通过前永远是 false（decisions #89）。 */
function enforceOpen(): boolean {
  if (process.env.SV_OPENCODE_ENFORCE !== "1") return false;
  try {
    return JSON.parse(readFileSync(join(home(), "hook.json"), "utf8"))?.mode === "enforce";
  } catch {
    return false;
  }
}

async function setup(ctx: Any): Promise<(() => Promise<void>) | void> {
  dump("setup", "setup", ctx, { registered: [] });
  const registrations: Any[] = [];
  let promptHooked = false;
  // 每个会话一份状态，全在内存里；重启即清空
  const preCall = new Map<string, { callId: string; deny?: string; done: boolean; ts: number }>(); // sessionID → 最近一次 tool.before（本地 X2 的拦截绑定到它）
  const lastUser = new Map<string, string>(); // sessionID → 上次上报的 user 消息 id/文本
  const repeat = new Map<string, { text: string; left: number }>(); // context 建议的重复注入（inject_repeat：连续 2 次请求，或到下一次工具调用结束）

  const guard = (label: string, f: (e: Any) => Promise<void>) => async (e: Any) => {
    dump(label, "enter", e);
    try {
      await f(e);
    } catch (err) {
      dump(label, "note", undefined, { error: String((err as Error)?.message ?? err).slice(0, 200) });
      /* 任何异常都不能影响 OpenCode */
    }
    dump(label, "exit", e); // exit 时的事件对象能看出我们有没有改到它（effect/message/system）
  };
  // V2 的 hook 注册返回 Promise<Registration>（@opencode/plugin 2.0.32 promise/registration.d.ts）：必须 await 并捕获拒绝，否则变成未处理的 rejection
  const hook = async (target: Any, name: string, f: (e: Any) => Promise<void>, label = name): Promise<boolean> => {
    try {
      if (typeof target?.hook !== "function") {
        dump(label, "note", undefined, { registered: false, reason: "no .hook function on target" });
        return false;
      }
      const reg = await target.hook(name, guard(label, f));
      if (reg && typeof reg.dispose === "function") registrations.push(reg);
      dump(label, "note", undefined, { registered: true });
      return true;
    } catch (err) {
      dump(label, "note", undefined, { registered: false, reason: String((err as Error)?.message ?? err).slice(0, 200) });
      return false; /* 这个 hook 注册不上就算了：fail-open */
    }
  };

  // 拦截（主）：deny 必须带 message，否则 plain rejection 会结束当前 step。
  // 来源有二：本地 X2（tool.before 时判好，绑定到那次调用）和守护进程 outbox 里的 block/ask；两者都要过 enforceOpen() 这道闸。
  await hook(ctx?.permission, "evaluate", async (e) => {
    const s = sid(e);
    let pc = s ? preCall.get(s) : undefined;
    // evaluate 的 source 是 {type:"tool", messageID, id}（permission.d.ts 的 AssertInput）：id 就是工具调用 id，能把这次评估精确绑到某次 tool.before；
    // 没有 source 时退回「该会话最近一次 tool.before」。两者对不上 = 不是我们判过的那次调用，放行。
    const srcId = e?.source?.type === "tool" && typeof e.source.id === "string" ? e.source.id : undefined;
    if (pc && srcId !== undefined && pc.callId !== srcId) pc = undefined;
    // 核对用的探针（SV_OPENCODE_PROBE=<子串>，默认关）：命中时拒绝，用来验证 deny/message/异步 hook 在真机上是否有效。只在 Jack 明确设置时才会拦。
    const probe = process.env.SV_OPENCODE_PROBE;
    if (probe && JSON.stringify(sample(e)).includes(probe)) {
      e.effect = "deny";
      e.message = `agent-supervisor 探针：命中 ${probe}，这是核对用的测试拒绝。`;
      dump("evaluate", "note", undefined, { probe: true });
      return;
    }
    const r = await post({ event: "permission.evaluate", sessionID: s, directory: dirOf(e, ctx) }, EVALUATE_TIMEOUT_MS);
    const local = pc && !pc.done && pc.deny && Date.now() - pc.ts < 30_000 ? pc.deny : undefined;
    const t = local ?? text(r?.delivery ?? null);
    const viaDaemon = !local && !!r && !!t && (r.delivery?.kind === "block" || r.delivery?.kind === "ask") && allowed(r.mode, r.delivery?.kind);
    if (!t || !(local || viaDaemon)) {
      if (local || (r?.delivery && (r.delivery.kind === "block" || r.delivery.kind === "ask"))) dump("evaluate", "note", undefined, { wouldDeny: true, source: local ? "local-x2" : "daemon", withheld: "observe-only" });
      return;
    }
    if (!enforceOpen()) {
      dump("evaluate", "note", undefined, { wouldDeny: true, source: local ? "local-x2" : "daemon", withheld: "enforce gate closed" });
      return; // 真机核对通过前只观察（decisions #89）
    }
    e.effect = "deny";
    e.message = t;
  });

  // 建议（主）：只作用于这一次请求，不写入历史
  // user 消息：V2 有专门的 session.hook("prompt")（SessionPrompt: sessionID/messageID/prompt/delivery），比从 messages 里翻靠谱；
  // 注册成功后 context 里就不再扫 messages（messages 的元素类型来自 @opencode/ai，没有 vendor，形态未核实）。
  promptHooked = await hook(ctx?.session, "prompt", async (e) => {
    const s = sid(e);
    const t = promptText(e?.prompt);
    if (!s || !t) return;
    const key = `${typeof e.messageID === "string" ? e.messageID : ""}\u0000${t}`;
    if (key === lastUser.get(s)) return;
    lastUser.set(s, key);
    await post({ event: "prompt", sessionID: s, directory: dirOf(e, ctx), userMessage: { id: typeof e.messageID === "string" ? e.messageID : undefined, text: t } }, EVENT_TIMEOUT_MS);
  });

  // 建议（主）：只作用于这一次请求，不写入历史。
  // e.system 是 Array<SystemPart>（不是字符串数组；SystemPart 的定义在 @opencode/ai，没有 vendor）：只在能确认元素形态时才注入（见 injectSystem），否则只记 dump、不改。
  await hook(ctx?.session, "context", async (e) => {
    const s = sid(e);
    if (!s) return;
    const rep = repeat.get(s);
    if (rep && rep.left > 0) {
      rep.left--;
      if (!injectSystem(e.system, rep.text)) dump("context", "note", undefined, { injected: false, reason: "system part shape unknown" });
      return;
    }
    const um = promptHooked ? undefined : lastUserMessage(e.messages);
    const key = um ? `${um.id ?? ""}\u0000${um.text}` : undefined;
    const fresh = um && key !== lastUser.get(s);
    if (um && key) lastUser.set(s, key);
    const r = await post({ event: "context", sessionID: s, directory: dirOf(e, ctx), model: plain(e.model), agent: plain(e.agent), ...(fresh ? { userMessage: { id: um!.id, text: um!.text } } : {}) }, EVENT_TIMEOUT_MS);
    const t = text(r?.delivery ?? null);
    if (!r || !t || r.delivery?.kind !== "advise" || !allowed(r.mode, "advise")) return;
    if (!injectSystem(e.system, t)) {
      dump("context", "note", undefined, { injected: false, reason: "system part shape unknown", wouldInject: true });
      return; // 形态没核实 = 不注入（宁可没有建议，也不让模型请求带上形态错误的 system）
    }
    repeat.set(s, { text: t, left: 1 });
  });

  // 观测：before 是 Pre 事件的来源（含完整参数），after 带明确的 completed/error 状态
  await hook(ctx?.tool, "execute.before", async (e) => {
    const s = sid(e);
    const args = plain(e?.args ?? e?.input ?? e?.params);
    const tool = toolName(e);
    if (s) {
      // 本地 X2：不依赖守护进程；结果先存着，等同一会话的 permission.evaluate 来取（是否真的拦由 enforceOpen 决定）
      let deny: string | undefined;
      try {
        const x = x2Check({ harness: "opencode", ...x2Inputs(tool, args), cwd: dirOf(e, ctx) });
        if (x) deny = text({ kind: "block", text: x.reason });
      } catch {
        /* X2 出错 = 放行 */
      }
      preCall.set(s, { callId: callId(e) ?? "", deny, done: false, ts: Date.now() });
    }
    await post({ event: "tool.before", sessionID: s, directory: dirOf(e, ctx), callID: callId(e), tool, args }, BEFORE_TIMEOUT_MS);
  });
  await hook(ctx?.tool, "execute.after", async (e) => {
    const s = sid(e);
    if (s) {
      repeat.delete(s); // 下一次工具调用结束，旧建议不再重复
      const pc = preCall.get(s);
      if (pc) pc.done = true; // 这次调用已经结束：绑定在它上面的本地拦截作废（宁可漏拦，不误拦）
    }
    const status = e?.status === "error" || e?.error ? "error" : "completed";
    await post({ event: "tool.after", sessionID: s, directory: dirOf(e, ctx), callID: callId(e), tool: toolName(e), args: plain(e?.args ?? e?.input ?? e?.params), status, result: plain(e?.result ?? e?.output), error: plain(e?.error) }, EVENT_TIMEOUT_MS);
  });

  // setup 可以返回清理函数（promise/plugin.d.ts 的 Cleanup）：卸载时注销我们注册的全部 hook
  return async () => {
    for (const r of registrations.splice(0)) {
      try {
        await r.dispose();
      } catch {
        /* 忽略 */
      }
    }
  };
}

// 形态依据 @opencode/plugin 2.0.32 的 promise API：`Plugin.define({ id, setup(context) })`，`import { Plugin } from "@opencode/plugin"`；
// define 只是类型层面的恒等函数，这里直接导出等价的对象，避免打包时依赖运行时解析 @opencode/plugin。
export default {
  id: "agent-supervisor",
  async setup(ctx: Any) {
    try {
      return await setup(ctx);
    } catch {
      /* fail-open */
    }
  },
};
