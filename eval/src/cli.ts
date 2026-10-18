import { writeFileSync } from "node:fs";
import type { Config } from "@sv/core";
import { redactDeep } from "@sv/core";
import { defaultMockFactory, loadLabels, renderEvalText, runEval, runPromptAb } from "./run.ts";
import { LabelError } from "./labels.ts";

export async function runEvalCli(pos: string[], flags: Record<string, string | true>, cfg: Config, judge: string): Promise<number> {
  const path = pos[0];
  if (!path) {
    console.error("用法：sv eval <labels.yaml> [--judge=off|mock] [--window N] [--ab] [--format=text|json] [--out <path>]");
    return 2;
  }
  let labels;
  try {
    labels = loadLabels(path);
  } catch (e) {
    console.error(e instanceof LabelError ? `标注文件有误：${e.message}` : `读取失败：${String(e)}`);
    return 2;
  }
  const window = typeof flags.window === "string" ? Number(flags.window) : undefined;
  if (flags.ab) {
    const ab = await runPromptAb(labels, { cfg, window, judgeFactory: defaultMockFactory });
    const json = JSON.stringify(redactDeep(ab), null, 2);
    if (typeof flags.out === "string") writeFileSync(flags.out, json + "\n");
    console.log(flags.format === "json" ? json : ["提示写法 A（recall 优先）：", renderEvalText(ab.recall), "", "提示写法 B（默认 ignore）：", renderEvalText(ab.ignoreDefault), "", ab.note].join("\n"));
    return 0;
  }
  const { report } = await runEval(labels, { cfg, window, judge: judge === "mock" ? "mock" : "off" });
  const json = JSON.stringify(redactDeep(report), null, 2);
  if (typeof flags.out === "string") writeFileSync(flags.out, json + "\n");
  console.log(flags.format === "json" ? json : renderEvalText(report));
  return 0;
}
