// 工作区指纹（design §4.3，P0-4）：git status + git diff 的哈希 + 未跟踪文件的 (path, mtime, size)。
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";

export type WsKind = "git" | "non-git" | "timeout" | "error";

export interface WsFingerprint {
  kind: WsKind;
  /** kind === "git" 时才有。 */
  fp?: string;
  ms: number;
}

export interface WsOptions {
  timeoutMs?: number; // 默认 2000
  maxUntracked?: number; // 默认 2000
}

interface RunResult {
  ok: boolean;
  out: Uint8Array;
  code: number | null;
}

async function git(cwd: string, args: string[], signal: AbortSignal): Promise<RunResult> {
  const proc = Bun.spawn(["git", "-c", "core.quotepath=off", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    signal,
  });
  const out = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  const code = await proc.exited;
  return { ok: code === 0, out, code };
}

/** 计算工作区指纹。超时返回 kind="timeout"（调用方应视为「可能有改动」）。 */
export async function computeWsFingerprint(cwd: string, opts: WsOptions = {}): Promise<WsFingerprint> {
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 2000);
  const done = (kind: WsKind, fp?: string): WsFingerprint => ({ kind, fp, ms: Date.now() - t0 });
  try {
    const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"], ac.signal);
    if (ac.signal.aborted) return done("timeout");
    if (!inside.ok || new TextDecoder().decode(inside.out).trim() !== "true") return done("non-git");
    const top = new TextDecoder().decode((await git(cwd, ["rev-parse", "--show-toplevel"], ac.signal)).out).trim();
    const [status, diff, cached] = await Promise.all([
      git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], ac.signal),
      git(cwd, ["diff", "--no-ext-diff", "--no-color"], ac.signal),
      git(cwd, ["diff", "--cached", "--no-ext-diff", "--no-color"], ac.signal),
    ]);
    if (ac.signal.aborted) return done("timeout");
    if (!status.ok) return done("error");
    const h = createHash("sha1");
    h.update(status.out);
    h.update("\0diff\0");
    h.update(createHash("sha1").update(diff.out).digest());
    h.update("\0cached\0");
    h.update(createHash("sha1").update(cached.out).digest());
    // 未跟踪文件：status 里以 "?? " 开头的条目
    const entries = new TextDecoder().decode(status.out).split("\0").filter(Boolean);
    const untracked = entries.filter((e) => e.startsWith("?? ")).map((e) => e.slice(3)).sort();
    const max = opts.maxUntracked ?? 2000;
    h.update(`\0untracked:${untracked.length}\0`);
    for (const p of untracked.slice(0, max)) {
      try {
        const st = statSync(join(top || cwd, p));
        h.update(`${p}\t${Math.floor(st.mtimeMs)}\t${st.size}\n`);
      } catch {
        h.update(`${p}\tgone\n`);
      }
    }
    return done("git", h.digest("hex").slice(0, 20));
  } catch (e) {
    if (ac.signal.aborted) return done("timeout");
    return done("error");
  } finally {
    clearTimeout(timer);
  }
}

/** 两次指纹之间能否断定「没有改动」。非 git / 超时 / 出错一律返回 false（保守）。 */
export function definitelyUnchanged(a: WsFingerprint | undefined, b: WsFingerprint | undefined): boolean {
  if (!a || !b) return false;
  if (a.kind !== "git" || b.kind !== "git") return false;
  return a.fp !== undefined && a.fp === b.fp;
}

/** 字符串形式（存进 Event.wsFingerprint）。 */
export function wsToString(w: WsFingerprint): string {
  return w.kind === "git" ? (w.fp as string) : w.kind;
}

/** 字符串形式的比较：两边都是真实 git 指纹且相同才算没变。 */
export function wsStringUnchanged(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  if (a === "non-git" || a === "timeout" || a === "error") return false;
  return a === b;
}
