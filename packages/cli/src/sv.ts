#!/usr/bin/env bun
// sv：第一阶段实现 replay / eval / stats / mark / explain / override / export / prune。
// 其余子命令（start/stop/status/install…）属于 M3+。
import { readFileSync, writeFileSync } from "node:fs";
import { applyOverride, beginRun, createJudgeClient, defaultConfig, expandHome, loadConfigFile, LogStore, type Config, type JudgeFn } from "@sv/core";
import { startDaemon, type Daemon } from "../../daemon/src/index.ts";
import { codexInstallSnippet, installSnippet, opencodeInstallSnippet } from "./install.ts";
import { analyze, formatReport, parseDump } from "./opencode-report.ts";
import { runOpencodeEnforce } from "./opencode-enforce.ts";
import { runRules } from "./rules-cmd.ts";
import { renderText, replayPath, type JudgeMode } from "../../replay/src/index.ts";
import { runExplain, runExport, runMark, runOverride, runPrune, runStats, type Flags } from "./stats.ts";

const USAGE = `用法：
  sv replay <file|dir> [--judge=off|mock|live] [--format=text|json|both] [--out <path>] [-v]
                        [--config <config.yaml>] [--plan <plan.md>] [--mode shadow|advise|enforce]
                        [--set thresholds.T1.H=4 ...]            覆盖配置（可重复），用于调阈值
                        [--log [db]] [--label <name>]            写结构化日志（默认库见 config 的 log.db）
  sv eval   <labels.yaml> [--judge=off|mock|live] [--window N] [--ab] [--set k=v ...] [--format=text|json] [--out <path>]
            [--sweep thresholds.T1.H=3,4,5]                      阈值扫描：每个取值各跑一遍并各写一条 eval 运行记录
            [--log [db]] [--label name]                          写结构化日志
  sv stats  [--by rule|model|judge|session|danger|runs] [--run N,M] [--label L] [--since 7d|2026-10-01] [--session ID]
            [--format text|json|csv] [--db path]
  sv stats  --by danger                                           危险操作（X2）：本应拦截 / 已拦截，按类别、按会话
  sv stats  --by session --sort-danger                            会话按危险数排序
  sv stats  --compare A,B                                         对比两次运行（thresholds 不同的回放）
  sv mark <hit-id> fp|useful [--note ...]                         把命中标为误报 / 有用
  sv override <decision-id> allow|reject [--note ...]             手动放行 / 驳回某次决策
  sv explain <hit-id> [--format json]                             一次命中的完整链路
  sv export --out <dir>                                           全部表导出为 JSONL
  sv prune [--days N]                                             按保留期清理

  sv start  [--home <dir>] [--port N] [--mode shadow|advise|enforce] [--judge=live] [--config <config.yaml>]   前台运行守护进程
  sv status [--home <dir>]                                        查询守护进程
  sv rules show|set|reset [ID] [--disable|--enable] [--threshold 键=数字]   规则编辑（写 rules.local.json，与 PUT /v1/rules/{id} 同一套校验）
  sv opencode-enforce status|on|off [--report <dump.jsonl>] [--approved-by <批准人>]   OpenCode 拦截开关（默认 OFF；on 需要核对报告通过 + 批准人署名；每次切换记日志）
  sv opencode-report <dump.jsonl> [--format json]                汇总 OpenCode 插件的核对样本（SV_OPENCODE_DUMP=1）
  sv install claude|codex|opencode [--launchd]                              只打印 Claude Code / Codex 的 hooks 配置片段、OpenCode V2 的插件内容（claude 可加 launchd plist），不改任何文件

replay/eval 默认只读本地 transcript、不发网络请求；--judge=live 才会调用 config 里 judge.base_url（默认本地 Magpie 路由组 http://127.0.0.1:3425/v1）。
key 只从 judge.api_key_env 指定的环境变量（或 ADVISOR_API_KEY）读取，不读任何文件。`;

const VALUE_FLAGS = new Set(["home", "port", "sweep", "config", "plan", "out", "mode", "format", "judge", "db", "run", "label", "kind", "since", "until", "session", "by", "compare", "days", "note", "window", "set", "log", "report", "approved-by", "threshold"]);

export function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const flags: Flags = {};
  const add = (k: string, v: string | true) => {
    if (k === "set") (flags.set = (flags.set as string[] | undefined) ?? []).push(String(v));
    else if (k === "threshold") (flags.threshold = (flags.threshold as string[] | undefined) ?? []).push(String(v));
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

async function runStart(flags: Flags, cfg0: Config): Promise<number> {
  let cfg = cfg0;
  if (flags.judge === "live") cfg = { ...cfg, judge: { ...cfg.judge, enabled: true } };
  let d: Daemon;
  try {
    d = await startDaemon({ cfg, home: typeof flags.home === "string" ? flags.home : undefined, port: typeof flags.port === "string" ? Number(flags.port) : undefined, dbPath: typeof flags.db === "string" ? flags.db : undefined });
  } catch (e) {
    console.error(`启动失败：${(e as Error).message}`);
    return 2;
  }
  console.error(`supervisord 已启动：mode=${cfg.mode} judge=${cfg.judge.enabled ? cfg.judge.base_url : "off"} socket=${d.socketPath ?? "-"}${d.port ? " port=" + d.port : ""} run=${d.runId}`);
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await d.stop(); // 优雅退出：关闭每个会话的引擎、结束 live run、移除 socket
  console.error("supervisord 已退出");
  return 0;
}

async function runStatus(flags: Flags): Promise<number> {
  const home = expandHome(typeof flags.home === "string" ? flags.home : "~/.agent-supervisor");
  try {
    const r = await fetch("http://localhost/v1/status", { unix: `${home}/sock`, headers: { "x-sv-protocol": "1" }, signal: AbortSignal.timeout(2000) });
    console.log(JSON.stringify(await r.json(), null, 2));
    return 0;
  } catch {
    console.error(`守护进程不可达（${home}/sock）。用 \`sv start\` 启动。`);
    return 1;
  }
}

async function runInstall(pos: string[], flags: Flags): Promise<number> {
  if (pos[0] === "codex") {
    console.log(codexInstallSnippet());
    return 0;
  }
  if (pos[0] === "opencode") {
    console.log(await opencodeInstallSnippet());
    return 0;
  }
  if (pos[0] !== "claude") {
    console.error("用法：sv install claude|codex|opencode [--launchd]   （只打印，不改任何文件）");
    return 2;
  }
  console.log(installSnippet({ launchd: flags.launchd === true }));
  return 0;
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

  // ---- 守护进程相关命令 ----
  if (cmd === "start") return runStart(flags, cfg);
  if (cmd === "status") return runStatus(flags);
  if (cmd === "install") return await runInstall(pos.slice(1), flags);
  if (cmd === "rules") {
    const r = runRules(pos.slice(1), flags, cfg);
    for (const l of r.lines) (r.code === 0 ? console.log : console.error)(l);
    return r.code;
  }
  if (cmd === "opencode-enforce") {
    const r = runOpencodeEnforce(pos.slice(1), flags);
    for (const l of r.lines) (r.code === 0 ? console.log : console.error)(l);
    return r.code;
  }
  if (cmd === "opencode-report") {
    if (!pos[1]) {
      console.error("用法：sv opencode-report <dump.jsonl> [--format json]   （汇总 SV_OPENCODE_DUMP=1 落下的样本，见 docs/opencode-verify.md）");
      return 2;
    }
    const rep = analyze(parseDump(readFileSync(pos[1], "utf8")));
    console.log(flags.format === "json" ? JSON.stringify(rep, null, 2) : formatReport(rep));
    return 0;
  }

  const judge = (typeof flags.judge === "string" ? flags.judge : "off") as string;
  if (judge !== "off" && judge !== "mock" && judge !== "live") {
    console.error(`不支持的 --judge=${judge}（只有 off|mock|live）`);
    return 2;
  }
  const liveClient = judge === "live" ? createJudgeClient({ cfg: cfg.judge }) : undefined;
  const judgeOpt: JudgeMode | JudgeFn = liveClient ? liveClient.judge : (judge as JudgeMode);

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
      const results = await replayPath(target, { judge: judgeOpt, judgeLabel: judge, cfg, planMd, log: store && runId !== undefined ? { store, runId } : undefined });
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
        if (liveClient) for (const [m, st] of liveClient.stats) console.error(`judge ${m}: 调用 ${st.calls} ok ${st.ok} parse_fail ${st.parseFail}（${(liveClient.parseFailRate(m) * 100).toFixed(1)}%）超时 ${st.timeouts} 出错 ${st.errors}`);
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
    return runEvalCli(pos.slice(1), flags, cfg, judge);
  }
  console.error(`未知子命令：${cmd}\n${USAGE}`);
  return 2;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
