// `sv opencode-enforce status|on|off`：OpenCode 拦截开关（decisions #107/#110，Jack 委托）。
// 默认关。`on` 必须同时满足：①最新的 opencode-report 通过机器可检查的门槛（opencode-report.ts 的 gate）；②带 --approved-by（人工批准的署名）。
// 任何切换（含被拒绝的尝试、已是该状态的 noop）都追加一行日志；日志写不进去就不改状态。`off` 永远允许。
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { appendEnforceLog, enforceLogFile, expandHome, readEnforceState, writeEnforceState, type EnforceLogEntry } from "@sv/core";
import { analyze, parseDump, type GateCheck } from "./opencode-report.ts";
import type { Flags } from "./stats.ts";

export interface EnforceResult {
  code: 0 | 1 | 2;
  lines: string[];
}

const ACTOR_RE = /^[\w.@-]{1,64}$/;

/** 数据目录下最新的 opencode-*.jsonl（按修改时间）。 */
function latestDump(home: string): string | undefined {
  const dir = join(home, "dumps");
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir).filter((f) => /^opencode-.*\.jsonl$/.test(f)).map((f) => join(dir, f));
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

export function runOpencodeEnforce(pos: string[], flags: Flags, now: number = Date.now()): EnforceResult {
  const home = expandHome(typeof flags.home === "string" ? flags.home : (process.env.SV_HOME ?? "~/.agent-supervisor"));
  const action = pos[0];
  const L: string[] = [];
  if (action === "status") {
    const s = readEnforceState(home);
    L.push(`OpenCode 拦截开关：${s.enabled ? "ON" : "OFF（默认）"}${s.ts ? `，最近切换 ${new Date(s.ts).toISOString()} 由 ${s.actor}` : ""}`);
    if (s.report) L.push(`依据的核对报告：${s.report.path}（sha256 ${s.report.sha256.slice(0, 12)}…）`);
    L.push("提示：真正拦截还需要 全局 mode=enforce，并且插件进程里 SV_OPENCODE_ENFORCE=1（三者缺一不拦）。");
    const log = enforceLogFile(home);
    if (existsSync(log)) {
      const tail = readFileSync(log, "utf8").trim().split("\n").slice(-5);
      L.push("最近的切换日志：", ...tail.map((l) => `  ${l}`));
    }
    return { code: 0, lines: L };
  }
  if (action !== "on" && action !== "off") return { code: 2, lines: ["用法：sv opencode-enforce status|on|off [--report <dump.jsonl>] [--approved-by <批准人>] [--home <dir>]"] };

  const actorRaw = typeof flags["approved-by"] === "string" ? flags["approved-by"] : undefined;
  const actor = actorRaw && ACTOR_RE.test(actorRaw) ? actorRaw : action === "off" ? "cli" : undefined;
  const cur = readEnforceState(home);

  const finish = (entry: EnforceLogEntry, lines: string[], code: 0 | 1): EnforceResult => {
    try {
      appendEnforceLog(home, entry);
    } catch (err) {
      return { code: 1, lines: [...lines, `切换日志写入失败（${String((err as Error)?.message ?? err).slice(0, 100)}）——状态未改变`] };
    }
    return { code, lines };
  };

  if (action === "off") {
    if (!cur.enabled) return finish({ ts: now, action, result: "noop", actor: actor!, reasons: ["本来就是关"] }, ["OpenCode 拦截开关本来就是 OFF。"], 0);
    // 先写日志再改状态：日志写不进去就保持原状（对 off 来说意味着仍是 ON，调用方会看到失败码）
    const logged = finish({ ts: now, action, result: "applied", actor: actor!, reasons: [] }, [], 0);
    if (logged.code !== 0) return logged;
    try {
      writeEnforceState(home, { version: 1, enabled: false, ts: now, actor: actor!, report: null });
    } catch (err) {
      return { code: 1, lines: [`状态文件写入失败：${String((err as Error)?.message ?? err).slice(0, 100)}`] };
    }
    return { code: 0, lines: ["OpenCode 拦截开关已关闭（OFF）。只对之后新建的会话生效。"] };
  }

  // ---- on：门槛 ----
  const reasons: string[] = [];
  if (!actor) reasons.push("需要 --approved-by <批准人>（人工批准的署名，只允许字母数字和 ._@-，≤64 字符）");
  const reportPath = typeof flags.report === "string" ? resolve(expandHome(flags.report)) : latestDump(home);
  let sha = "";
  let checks: GateCheck[] | undefined;
  if (!reportPath || !existsSync(reportPath)) reasons.push(reportPath ? `核对报告不存在：${reportPath}` : `没有找到核对样本（${join(home, "dumps")} 下没有 opencode-*.jsonl）；先按 docs/opencode-verify.md 在真机上跑一遍`);
  else {
    const raw = readFileSync(reportPath, "utf8");
    sha = createHash("sha256").update(raw).digest("hex");
    const rep = analyze(parseDump(raw), now);
    checks = rep.gate.checks;
    for (const c of rep.gate.checks) if (!c.ok) reasons.push(`核对未通过：${c.id} — ${c.detail}`);
  }
  const report = reportPath && sha ? { path: reportPath, sha256: sha } : null;
  if (reasons.length) {
    const r = finish({ ts: now, action, result: "refused", actor: actor ?? "unknown", reasons, report, checks }, ["拒绝打开 OpenCode 拦截开关：", ...reasons.map((x) => `  - ${x}`), "状态未改变（仍是 " + (cur.enabled ? "ON" : "OFF") + "）。"], 1);
    return { ...r, code: 1 };
  }
  if (cur.enabled) return finish({ ts: now, action, result: "noop", actor: actor!, reasons: ["本来就是开"], report, checks }, ["OpenCode 拦截开关本来就是 ON。"], 0);
  const logged = finish({ ts: now, action, result: "applied", actor: actor!, reasons: [], report, checks }, [], 0);
  if (logged.code !== 0) return logged;
  try {
    writeEnforceState(home, { version: 1, enabled: true, ts: now, actor: actor!, report });
  } catch (err) {
    return { code: 1, lines: [`状态文件写入失败：${String((err as Error)?.message ?? err).slice(0, 100)}（日志里已有一条 applied，请以 sv opencode-enforce status 为准）`] };
  }
  return { code: 0, lines: [`OpenCode 拦截开关已打开（ON），批准人 ${actor}，依据 ${reportPath}。只对之后新建的 opencode 会话生效；真正拦截还需要全局 mode=enforce 和插件进程里 SV_OPENCODE_ENFORCE=1。`] };
}
