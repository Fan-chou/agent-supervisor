// sv-hook 的核心逻辑（Claude Code 与 Codex 共用一个二进制）：读 hook 载荷 → 本地 X2 → 转发守护进程 → 按输出白名单渲染。
// 铁律：任何失败（守护进程不可达、超时、响应坏掉、自己抛异常）一律 fail-open——不输出、exit 0、记一条 spool。
// shadow 模式永不拦截（含 X2）；advise 模式只允许 advise；只有 enforce 才会输出 deny/ask/Stop block。
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { redactDeep } from "@sv/core";
import { x2Check } from "../../core/src/x2.ts";
import * as claude from "../../adapter-claude/src/index.ts";
import * as codex from "../../adapter-codex/src/index.ts";
import type { Delivery } from "../../adapter-claude/src/index.ts";

export type HookHarness = "claude" | "codex";

export interface HookConfig {
  protocol?: number;
  mode?: "shadow" | "advise" | "enforce";
  socket?: string;
  port?: number;
}

export interface HookEnv {
  home?: string;
  /** 哪个 harness 的载荷。不传时按 SV_HARNESS、载荷特征判断，最后默认 claude；命令行参数（main.ts）优先于这一切。 */
  harness?: HookHarness;
  /** 毫秒；不传时 PreToolUse 18 秒（design §3.1 硬超时），其他 4 秒。 */
  timeoutMs?: number;
  now?: () => number;
  /** 把（脱敏后的）载荷写到 <home>/dumps/（0600）。默认关；main.ts 在 SV_HOOK_DUMP=1 时打开。design §3.2 对策 3。 */
  dump?: boolean;
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

/**
 * 判断是哪个 harness：命令行参数（`sv-hook codex` / `--harness=codex`）> SV_HARNESS 环境变量 > 载荷特征 > claude。
 * 两边的载荷都有 hook_event_name，所以载荷特征只是兜底（Codex 的通用输入里有 turn_id，Claude 没有），不能当主依据。
 */
export function resolveHarness(argv: readonly string[], env: Record<string, string | undefined> = process.env, payload?: unknown): HookHarness {
  for (const a of argv) {
    if (a === "codex" || a === "--harness=codex") return "codex";
    if (a === "claude" || a === "--harness=claude") return "claude";
  }
  if (env.SV_HARNESS === "codex" || env.SV_HARNESS === "claude") return env.SV_HARNESS;
  if (payload && typeof payload === "object" && typeof (payload as { turn_id?: unknown }).turn_id === "string") return "codex";
  return "claude";
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

const MAX_DUMP_STRING = 4000;
function capStrings(v: unknown): unknown {
  if (typeof v === "string") return v.length > MAX_DUMP_STRING ? v.slice(0, MAX_DUMP_STRING) + `…[+${v.length - MAX_DUMP_STRING}]` : v;
  if (Array.isArray(v)) return v.map(capStrings);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, capStrings(x)]));
  return v;
}

/** 载荷样本（design §3.2 对策 3：第一次在真机上跑，把真实 payload 存下来校准适配器）。先脱敏再落盘，文件 0600、目录 0700；任何失败静默。 */
function dumpPayload(home: string, harness: string, payload: unknown, now: number): void {
  try {
    const dir = join(home, "dumps");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const day = new Date(now).toISOString().slice(0, 10);
    appendFileSync(join(dir, `${harness}-${day}.jsonl`), JSON.stringify({ ts: now, harness, payload: redactDeep(capStrings(payload)) }) + "\n", { mode: 0o600 });
  } catch {
    /* 样本落盘失败不影响监督 */
  }
}

/** 按 mode 过滤：shadow 永不输出任何 delivery；advise 只放行 advise；enforce 全放行。 */
export function allowedByMode(mode: HookConfig["mode"], d: Delivery | null): Delivery | null {
  if (!d) return null;
  if (mode === "enforce") return d;
  if (mode === "advise") return d.kind === "advise" ? d : null;
  return null;
}

async function forward(home: string, cfg: HookConfig, harness: HookHarness, payload: unknown, timeoutMs: number): Promise<{ delivery: Delivery | null }> {
  const body = JSON.stringify({ harness, payload });
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

/** harness 差异收在这里：归一化（只为取注入点和本地 X2 所需字段）、本地 X2、白名单渲染。 */
function adapterFor(harness: HookHarness, payload: Record<string, unknown>, now: number) {
  let seq = 0;
  const o = { nextSeq: () => seq++, now };
  if (harness === "codex") {
    const norm = codex.normalizeCodexHook(payload as codex.CodexHookPayload, o);
    return {
      hookPoint: norm.hookPoint as string | null,
      stopHookActive: norm.stopHookActive,
      events: norm.events,
      x2Delivery: (r: Parameters<typeof codex.deliveryFromX2>[0]) => codex.deliveryFromX2(r),
      render: (d: Delivery | null, at: string, stopHookActive: boolean) => codex.serialize(codex.render(d, at, { stopHookActive })),
    };
  }
  const norm = claude.normalizeClaudeHook(payload as claude.ClaudeHookPayload, o);
  return {
    hookPoint: norm.hookPoint as string | null,
    stopHookActive: norm.stopHookActive,
    events: norm.events,
    x2Delivery: (r: Parameters<typeof claude.deliveryFromX2>[0]) => claude.deliveryFromX2(r),
    render: (d: Delivery | null, at: string, stopHookActive: boolean) => claude.serialize(claude.render(d, at as claude.HookPoint, { stopHookActive })),
  };
}

export async function runHook(stdin: string, env: HookEnv = {}): Promise<HookResult> {
  const now = env.now ?? Date.now;
  const home = env.home ?? resolveHome();
  let eventName = "unknown";
  let harness: HookHarness = env.harness ?? "claude";
  try {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(stdin) as Record<string, unknown>;
    } catch {
      return { stdout: "", exitCode: 0, note: "bad-stdin" };
    }
    if (!payload || typeof payload !== "object") return { stdout: "", exitCode: 0, note: "bad-stdin" };
    if (!env.harness) harness = resolveHarness([], process.env, payload);
    eventName = String(payload.hook_event_name ?? "unknown");
    if (env.dump) dumpPayload(home, harness, payload, now());
    const cfg = readHookConfig(home);
    const mode = cfg.mode ?? "shadow";
    const ad = adapterFor(harness, payload, now());
    const hookPoint = ad.hookPoint;
    const timeoutMs = env.timeoutMs ?? (hookPoint === "PreToolUse" ? PRE_TIMEOUT_MS : OTHER_TIMEOUT_MS);

    // ---- 本地 X2：不依赖守护进程；但 shadow/advise 下永不拦截（守护进程只记 would_have_*） ----
    let local: Delivery | null = null;
    if (hookPoint === "PreToolUse" && mode === "enforce") {
      const ev = ad.events[0];
      const hit = x2Check({ harness, command: ev?.shell?.cmd, files: ev?.edit?.files, cwd: typeof payload.cwd === "string" ? payload.cwd : undefined });
      if (hit) local = ad.x2Delivery(hit);
    }

    let delivery: Delivery | null = null;
    let note = "ok";
    try {
      // 本地 X2 已经决定要拦时，守护进程只用来记录：给它一个短超时，别拖慢拦截
      const r = await forward(home, cfg, harness, payload, local ? Math.min(timeoutMs, 2000) : timeoutMs);
      delivery = r.delivery;
    } catch (err) {
      note = "daemon-unreachable";
      spool(home, harness, String((err as Error)?.message ?? err).slice(0, 200), eventName, now());
    }
    delivery = local ?? delivery;
    const out = allowedByMode(mode, delivery);
    if (delivery && !out) note = `dropped-by-mode:${mode}`;
    // 没有（本 harness 的）注入点——UserPromptSubmit、SessionStart、Codex 的 PostToolUseFailure…——永远不输出
    const stdout = hookPoint ? ad.render(out, hookPoint, ad.stopHookActive) : "";
    return { stdout, exitCode: 0, note };
  } catch (err) {
    spool(home, harness, `hook-exception: ${String((err as Error)?.message ?? err).slice(0, 200)}`, eventName, now());
    return { stdout: "", exitCode: 0, note: "hook-exception" };
  }
}
