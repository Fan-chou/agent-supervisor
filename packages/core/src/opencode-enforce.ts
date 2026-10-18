// OpenCode 拦截开关的状态与审计（decisions #107/#110）：默认关；打开需要通过 `sv opencode-enforce on` 的核对门槛；每次切换（含被拒绝的尝试）都追加一行日志。
// 状态文件放在守护进程的数据目录里（0600）；守护进程在新建 opencode 会话时读它，所以切换不需要重启，但只对之后新建的会话生效。
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface EnforceState {
  version: 1;
  enabled: boolean;
  ts: number;
  actor: string;
  /** 打开时依据的核对报告（路径 + 内容 sha256），关闭时为 null。 */
  report: { path: string; sha256: string } | null;
}

export interface EnforceLogEntry {
  ts: number;
  action: "on" | "off";
  /** 实际结果：applied = 状态已改；refused = 门槛没过，状态未变；noop = 已经是那个状态。 */
  result: "applied" | "refused" | "noop";
  actor: string;
  reasons: string[];
  report?: { path: string; sha256: string } | null;
  checks?: { id: string; ok: boolean; detail: string }[];
}

const stateFile = (home: string) => join(home, "opencode-enforce.json");
export const enforceLogFile = (home: string) => join(home, "opencode-enforce.log.jsonl");

/** 读取开关状态。文件不存在、损坏、格式不对 → 一律当作「关」（fail-safe：拦截只会少，不会多）。 */
export function readEnforceState(home: string): EnforceState {
  const off: EnforceState = { version: 1, enabled: false, ts: 0, actor: "default", report: null };
  try {
    const p = stateFile(home);
    if (!existsSync(p)) return off;
    const j = JSON.parse(readFileSync(p, "utf8")) as Partial<EnforceState>;
    if (j?.version !== 1 || typeof j.enabled !== "boolean") return off;
    return { version: 1, enabled: j.enabled, ts: Number(j.ts) || 0, actor: String(j.actor ?? "unknown").slice(0, 64), report: j.report && typeof j.report.path === "string" && typeof j.report.sha256 === "string" ? { path: j.report.path, sha256: j.report.sha256 } : null };
  } catch {
    return off;
  }
}

/** 原子写（临时文件 + rename，0600）。失败抛异常。 */
export function writeEnforceState(home: string, s: EnforceState): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const p = stateFile(home);
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, p);
}

/** 追加一行切换日志（0600）。写不进去时抛异常——调用方必须把它当作「切换失败」，不能悄悄打开。 */
export function appendEnforceLog(home: string, e: EnforceLogEntry): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  appendFileSync(enforceLogFile(home), JSON.stringify(e) + "\n", { mode: 0o600 });
}
