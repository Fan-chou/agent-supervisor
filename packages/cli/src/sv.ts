#!/usr/bin/env bun
// sv：第一阶段实现 replay / eval / stats / mark / explain / override / export / prune。
// 其余子命令（start/stop/status/install…）属于 M3+。
import { readFileSync, writeFileSync } from "node:fs";
import { applyOverride, beginRun, defaultConfig, expandHome, loadConfigFile, LogStore, type Config } from "@sv/core";
import { renderText, replayPath, type JudgeMode } from "../../replay/src/index.ts";
import { runExplain, runExport, runMark, runOverride, runPrune, runStats, type Flags } from "./stats.ts";

const USAGE = `用法：
  sv replay <file|dir> [--judge=off|mock] [--format=text|json|both] [--out <path>] [-v]
                        [--config <config.yaml>] [--plan <plan.md>] [--mode shadow|advise|enforce]
                        [--set thresholds.T1.H=4 ...]            覆盖配置（可重复），用于调阈值
                        [--log [db]] [--label <name>]            写结构化日志（默认库见 config 的 log.db）
  sv eval   <labels.yaml> [--judge=off|mock] [--window N] [--ab] [--set k=v ...] [--format=text|json] [--out <path>]
  sv stats  [--by rule|model|judge|session|runs] [--run N,M] [--label L] [--since 7d|2026-10-01] [--session ID]
            [--format text|json|csv] [--db path]
  sv stats  --compare A,B                                         对比两次运行（thresholds 不同的回放）
  sv mark <hit-id> fp|useful [--note ...]                         把命中标为误报 / 有用
  sv override <decision-id> allow|reject [--note ...]             手动放行 / 驳回某次决策
  sv explain <hit-id> [--format json]                             一次命中的完整链路
  sv export --out <dir>                                           全部表导出为 JSONL
  sv prune [--days N]                                             按保留期清理

replay 只读本地 transcript，不发任何网络请求；--judge=live 不在第一阶段范围内。`;

const VALUE_FLAGS = new Set(["config", "plan", "out", "mode", "format", "judge", "db", "run", "label", "kind", "since", "until", "session", "by", "compare", "days", "note", "window", "set", "log"]);

export function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const flags: Flags = {};
  const add = (k: string, v: string | true) => {
    if (k === "set") (flags.set = (flags.set as string[] | undefined) ?? []).push(String(v));
    else flags[k] = v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const k = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) add(k, a.slice(eq + 1));
      // --log 的值是可选的：后面跟的是路径（含 / 或以 .db 结尾）才当作值
      else if (k === "log") add(k, argv[i + 1] && !argv[i + 1].startsWith("-") && /[/.]/.test(argv[i + 1]) && /\.(db|sqlite)$|^[~/.]/.test(argv[i + 1]) ? argv[++i] : true);
      else if (VALUE_FLAGS.has(k) && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) add(k, argv[++i]);
      else add(k, true);
    } else if (a === "-v") flags.verbose = true;
    else pos.push(a);
  }
  return { pos, flags };
}

function buildConfig(flags: Flags): { cfg: Config; overrides: string[] } {
  let cfg = typeof flags.config === "string" ? loadConfigFile(flags.config) : defaultConfig();
  if (typeof flags.mode === "string") cfg = { ...cfg, mode: flags.mode as Config["mode"] };
  const overrides = ((flags.set as string[] | undefined) ?? []).slice();
  for (const o of overrides) cfg = applyOverride(cfg, o);
  return { cfg, overrides };
}

export async function main(argv: string[]): Promise<number> {
  const { pos, flags } = parseArgs(argv);
  const cmd = pos[0];
  if (!cmd || cmd === "help" || flags.help) {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }
  let built: { cfg: Config; overrides: string[] };
  try {
    built = buildConfig(flags);
  } catch (e) {
    console.error(`配置有误：${(e as Error).message}`);
    return 2;
  }
  const { cfg, overrides } = built;

  // ---- 日志库相关命令 ----
  if (cmd === "stats") return runStats(flags, cfg);
  if (cmd === "mark") return runMark(pos.slice(1), flags, cfg);
  if (cmd === "override") return runOverride(pos.slice(1), flags, cfg);
  if (cmd === "explain") return runExplain(pos.slice(1), flags, cfg);
  if (cmd === "export") return runExport(flags, cfg);
  if (cmd === "prune") return runPrune(flags, cfg);

  const judge = (typeof flags.judge === "string" ? flags.judge : "off") as string;
  if (judge !== "off" && judge !== "mock") {
    console.error(`不支持的 --judge=${judge}（第一阶段只有 off|mock；live 要等 M3）`);
    return 2;
  }

  if (cmd === "replay") {
    const target = pos[1];
    if (!target) {
      console.error(USAGE);
      return 2;
    }
    const planMd = typeof flags.plan === "string" ? readFileSync(flags.plan, "utf8") : undefined;
    let store: LogStore | undefined;
    let runId: number | undefined;
    if (flags.log) {
      const path = expandHome(typeof flags.log === "string" ? flags.log : cfg.log.db);
      store = new LogStore(path, { jsonlDir: cfg.log.jsonl_dir, storeEventBodies: cfg.log.store_event_bodies, storeJudgeBodies: cfg.log.store_judge_bodies });
      runId = beginRun(store, cfg, { kind: "replay", label: typeof flags.label === "string" ? flags.label : undefined, source: target, judgeMode: judge, overrides });
    }
    try {
      const results = await replayPath(target, { judge: judge as JudgeMode, cfg, planMd, log: store && runId !== undefined ? { store, runId } : undefined });
      const format = typeof flags.format === "string" ? flags.format : "text";
      const json = JSON.stringify(results.length === 1 ? results[0] : results, null, 2);
      if (typeof flags.out === "string") writeFileSync(flags.out, json + "\n");
      if (format === "json") console.log(json);
      else {
        console.log(results.map((r) => renderText(r, { verbose: flags.verbose === true })).join("\n\n" + "─".repeat(60) + "\n\n"));
        if (format === "both") console.log("\n" + json);
      }
      if (store && runId !== undefined) {
        store.endRun(runId);
        console.error(`已写入日志：run ${runId}${typeof flags.label === "string" ? "（" + flags.label + "）" : ""} → ${store.db.filename}`);
        const days = cfg.log.retention_days;
        if (days > 0) store.prune(days);
      }
      return 0;
    } finally {
      store?.close();
    }
  }
  if (cmd === "eval") {
    const { runEvalCli } = await import("../../../eval/src/cli.ts");
    return runEvalCli(pos.slice(1), flags as Record<string, string | true>, cfg, judge as JudgeMode);
  }
  console.error(`未知子命令：${cmd}\n${USAGE}`);
  return 2;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
