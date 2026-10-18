// sv-hook 的核心逻辑（Claude Code 先行）：读 hook 载荷 → 本地 X2 → 转发守护进程 → 按输出白名单渲染。
// 铁律：任何失败（守护进程不可达、超时、响应坏掉、自己抛异常）一律 fail-open——不输出、exit 0、记一条 spool。
// shadow 模式永不拦截（含 X2）；advise 模式只允许 advise；只有 enforce 才会输出 deny/ask/Stop block。
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { x2Check } from "../../core/src/x2.ts";
import { deliveryFromX2, normalizeClaudeHook, render, serialize, type ClaudeHookPayload, type Delivery } from "../../adapter-claude/src/index.ts";

export interface HookConfig {
  protocol?: number;
  mode?: "shadow" | "advise" | "enforce";
  socket?: string;
  port?: number;
}

export interface HookEnv {
  home?: string;
  /** 毫秒；不传时 PreToolUse 18 秒（design §3.1 硬超时），其他 4 秒。 */
  timeoutMs?: number;
  now?: () => number;
}

export interface HookResult {
  stdout: string;
  exitCode: 0;
  /** 调试用：为什么没有输出 / 走了哪条路径。 */
  note: string;
}

const PRE_TIMEOUT_MS = 18_000;
const OTHER_TIMEOUT_MS = 4_000;

export function resolveHome(env: Record<string, string | undefined> = process.env): string {
  return env.SV_HOME ?? join(homedir(), ".agent-supervisor");
}

function readHookConfig(home: string): HookConfig {
  try {
    return JSON.parse(readFileSync(join(home, "hook.json"), "utf8")) as HookConfig;
  } catch {
    return {}; // 没有配置 → 默认 shadow、默认 socket 位置；永远不会拦截
  }
}

function spool(home: string, harness: string, error: string, eventName: string, now: number): void {
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const p = join(home, "health-spool.jsonl");
    if (existsSync(p) && statSync(p).size > 1_000_000) return; // 守护进程长期不在时不让 spool 无限长
    appendFileSync(p, JSON.stringify({ ts: now, harness, error, event: eventName }) + "\n", { mode: 0o600 });
  } catch {
    /* 连 spool 都写不了：什么都不做 */
  }
}

/** 按 mode 过滤：shadow 永不输出任何 delivery；advise 只放行 advise；enforce 全放行。 */
export function allowedByMode(mode: HookConfig["mode"], d: Delivery | null): Delivery | null {
  if (!d) return null;
  if (mode === "enforce") return d;
  if (mode === "advise") return d.kind === "advise" ? d : null;
  return null;
}

async function forward(home: string, cfg: HookConfig, payload: ClaudeHookPayload, timeoutMs: number): Promise<{ delivery: Delivery | null }> {
  const body = JSON.stringify({ harness: "claude", payload });
  const headers: Record<string, string> = { "content-type": "application/json", "x-sv-protocol": "1" };
  const signal = AbortSignal.timeout(timeoutMs);
  let res: Response;
  if (cfg.socket || (!cfg.port && existsSync(join(home, "sock")))) {
    res = await fetch("http://localhost/v1/hook", { unix: cfg.socket ?? join(home, "sock"), method: "POST", headers, body, signal });
  } else if (cfg.port) {
    const token = readFileSync(join(home, "token"), "utf8").trim();
    res = await fetch(`http://127.0.0.1:${cfg.port}/v1/hook`, { method: "POST", headers: { ...headers, authorization: `Bearer ${token}` }, body, signal });
  } else throw new Error("no daemon socket configured");
  if (res.status !== 200) throw new Error(`daemon HTTP ${res.status}`);
  const j = (await res.json()) as { ok?: boolean; delivery?: Delivery | null };
  return { delivery: j && typeof j === "object" && j.delivery && typeof j.delivery === "object" ? j.delivery : null };
}

export async function runHook(stdin: string, env: HookEnv = {}): Promise<HookResult> {
  const now = env.now ?? Date.now;
  const home = env.home ?? resolveHome();
  let eventName = "unknown";
  try {
    let payload: ClaudeHookPayload;
    try {
      payload = JSON.parse(stdin) as ClaudeHookPayload;
    } catch {
      return { stdout: "", exitCode: 0, note: "bad-stdin" };
    }
    if (!payload || typeof payload !== "object") return { stdout: "", exitCode: 0, note: "bad-stdin" };
    eventName = String(payload.hook_event_name ?? "unknown");
    const cfg = readHookConfig(home);
    const mode = cfg.mode ?? "shadow";
    // 只用来取 hookPoint 与本地 X2 所需的字段，不产生副作用
    let seq = 0;
    const norm = normalizeClaudeHook(payload, { nextSeq: () => seq++, now: now() });
    const hookPoint = norm.hookPoint;
    const timeoutMs = env.timeoutMs ?? (hookPoint === "PreToolUse" ? PRE_TIMEOUT_MS : OTHER_TIMEOUT_MS);

    // ---- 本地 X2：不依赖守护进程；但 shadow/advise 下永不拦截（守护进程只记 would_have_*） ----
    let local: Delivery | null = null;
    if (hookPoint === "PreToolUse" && mode === "enforce") {
      const ev = norm.events[0];
      const hit = x2Check({ harness: "claude", command: ev?.shell?.cmd, files: ev?.edit?.files, cwd: payload.cwd });
      if (hit) local = deliveryFromX2(hit);
    }

    let delivery: Delivery | null = null;
    let note = "ok";
    try {
      // 本地 X2 已经决定要拦时，守护进程只用来记录：给它一个短超时，别拖慢拦截
      const r = await forward(home, cfg, payload, local ? Math.min(timeoutMs, 2000) : timeoutMs);
      delivery = r.delivery;
    } catch (err) {
      note = "daemon-unreachable";
      spool(home, "claude", String((err as Error)?.message ?? err).slice(0, 200), eventName, now());
    }
    delivery = local ?? delivery;
    const out = allowedByMode(mode, delivery);
    if (delivery && !out) note = `dropped-by-mode:${mode}`;
    const stdout = serialize(render(out, hookPoint ?? "PostToolUse", { stopHookActive: norm.stopHookActive }));
    // 没有注入点（UserPromptSubmit、SessionStart…）时 render 用的是 PostToolUse 的格式，所以这里必须丢掉
    return { stdout: hookPoint ? stdout : "", exitCode: 0, note };
  } catch (err) {
    spool(home, "claude", `hook-exception: ${String((err as Error)?.message ?? err).slice(0, 200)}`, eventName, now());
    return { stdout: "", exitCode: 0, note: "hook-exception" };
  }
}
