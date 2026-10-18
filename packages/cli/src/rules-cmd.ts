// `sv rules show|set|reset`：规则编辑的命令行入口（decisions #101）。和 PUT /v1/rules/{id} 用同一套校验（validateRuleEdit）、同一个文件（<home>/rules.local.json）。
// 守护进程在**下一次 hook**时发现文件变了就重新读取（不用重启），立即作用于在跑的会话（decisions #114）。
import { join } from "node:path";
import { applyRuleEdits, expandHome, loadRuleEdits, ruleViews, saveRuleEdits, validateRuleEdit, type Config } from "@sv/core";
import type { Flags } from "./stats.ts";

export interface RulesResult {
  code: 0 | 1 | 2;
  lines: string[];
}

const USAGE = [
  "用法：",
  "  sv rules show [--home <dir>]                              列出规则、生效阈值、是否被 rules.local.json 覆盖",
  "  sv rules set <ID> [--disable|--enable] [--threshold 键=数字]…    例：sv rules set L2 --threshold repeat=6；T 阶梯：--threshold ladder.advise=4",
  "  sv rules reset <ID>                                       删除该规则的覆盖，回到启动配置",
  "校验规则与 PUT /v1/rules/{id} 完全相同（X2 受保护；不能改 mode、judge 等）。",
].join("\n");

export function runRules(pos: string[], flags: Flags, base: Config): RulesResult {
  const home = expandHome(typeof flags.home === "string" ? flags.home : (process.env.SV_HOME ?? "~/.agent-supervisor"));
  const file = join(home, "rules.local.json");
  const sub = pos[0];
  const loaded = loadRuleEdits(file);
  const warn = loaded.warning ? [`警告：${loaded.warning}`] : [];
  if (sub === "show") {
    const eff = applyRuleEdits(base, loaded.edits);
    const lines = ruleViews(eff, new Set(Object.keys(loaded.edits))).map((r) => `${r.id.padEnd(4)} ${r.protected ? "[受保护] " : r.disabled ? "[已停用] " : r.edited ? "[已编辑] " : "         "}${JSON.stringify(r.thresholds)}  ${r.title}`);
    return { code: 0, lines: [...warn, `覆盖文件：${file}`, ...lines] };
  }
  if (sub !== "set" && sub !== "reset") return { code: 2, lines: [USAGE] };
  const id = pos[1];
  if (!id) return { code: 2, lines: [USAGE] };

  const body: Record<string, unknown> = {};
  if (sub === "reset") body.reset = true;
  else {
    if (flags.disable === true && flags.enable === true) return { code: 2, lines: ["--disable 和 --enable 不能一起用"] };
    if (flags.disable === true) body.disabled = true;
    if (flags.enable === true) body.disabled = false;
    const sets = (flags.threshold as string[] | undefined) ?? [];
    if (sets.length) {
      const th: Record<string, unknown> = {};
      for (const s of sets) {
        const eq = s.indexOf("=");
        if (eq <= 0) return { code: 2, lines: [`--threshold 需要 键=数字，收到 ${s}`] };
        const key = s.slice(0, eq);
        const raw = s.slice(eq + 1);
        const val = raw.trim() === "" ? raw : Number(raw);
        const v = typeof val === "number" && Number.isNaN(val) ? raw : val;
        if (key.startsWith("ladder.")) ((th.ladder as Record<string, unknown>) ??= {})[key.slice(7)] = v;
        else th[key] = v;
      }
      body.thresholds = th;
    }
  }
  const r = validateRuleEdit(base, loaded.edits, id, body);
  if (!r.ok) return { code: 1, lines: [...warn, `拒绝（${r.code}）：`, ...r.errors.map((e) => `  - ${e}`)] };
  try {
    saveRuleEdits(file, r.edits);
  } catch (err) {
    return { code: 1, lines: [`写 ${file} 失败：${String((err as Error)?.message ?? err).slice(0, 120)}（未改变）`] };
  }
  const ch = r.changes.length ? r.changes.map((c) => `  ${c.what}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`) : ["  （没有变化）"];
  return { code: 0, lines: [...warn, `已写入 ${file}：`, ...ch, "守护进程会在下一次 hook 时读取，立即作用于在跑的会话。"] };
}
