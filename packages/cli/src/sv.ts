#!/usr/bin/env bun
// sv：第一阶段只实现 replay 与 eval。其余子命令（start/stop/status/install…）属于 M3+。
import { readFileSync, writeFileSync } from "node:fs";
import { defaultConfig, loadConfigFile } from "@sv/core";
import { renderText, replayPath, type JudgeMode } from "../../replay/src/index.ts";

const USAGE = `用法：
  sv replay <file|dir> [--judge=off|mock] [--format=text|json|both] [--out <path>]
                        [--config <config.yaml>] [--plan <plan.md>] [--mode shadow|advise|enforce] [-v]
  sv eval   <labels.yaml> [--judge=off|mock] [--config <config.yaml>] [--format=text|json] [--out <path>]

replay 只读本地 transcript，不发任何网络请求；--judge=live 不在第一阶段范围内。`;

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (["config", "plan", "out", "mode", "format", "judge"].includes(a.slice(2)) && argv[i + 1] && !argv[i + 1].startsWith("-")) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    } else if (a === "-v") flags.verbose = true;
    else pos.push(a);
  }
  return { pos, flags };
}

export async function main(argv: string[]): Promise<number> {
  const { pos, flags } = parseArgs(argv);
  const cmd = pos[0];
  if (!cmd || cmd === "help" || flags.help) {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }
  const judge = (flags.judge ?? "off") as string;
  if (judge !== "off" && judge !== "mock") {
    console.error(`不支持的 --judge=${judge}（第一阶段只有 off|mock；live 要等 M3）`);
    return 2;
  }
  let cfg = typeof flags.config === "string" ? loadConfigFile(flags.config) : defaultConfig();
  if (typeof flags.mode === "string") cfg = { ...cfg, mode: flags.mode as typeof cfg.mode };

  if (cmd === "replay") {
    const target = pos[1];
    if (!target) {
      console.error(USAGE);
      return 2;
    }
    const planMd = typeof flags.plan === "string" ? readFileSync(flags.plan, "utf8") : undefined;
    const results = await replayPath(target, { judge: judge as JudgeMode, cfg, planMd });
    const format = (flags.format as string) ?? "text";
    const json = JSON.stringify(results.length === 1 ? results[0] : results, null, 2);
    if (typeof flags.out === "string") writeFileSync(flags.out, json + "\n");
    if (format === "json") console.log(json);
    else {
      console.log(results.map((r) => renderText(r, { verbose: flags.verbose === true })).join("\n\n" + "─".repeat(60) + "\n\n"));
      if (format === "both") console.log("\n" + json);
    }
    return 0;
  }
  if (cmd === "eval") {
    const { runEvalCli } = await import("../../../eval/src/cli.ts");
    return runEvalCli(pos.slice(1), flags, cfg, judge as JudgeMode);
  }
  console.error(`未知子命令：${cmd}\n${USAGE}`);
  return 2;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
