import { writeFileSync } from "node:fs";
import type { Config } from "@sv/core";
import { expandHome, LogStore, redactDeep } from "@sv/core";
import { defaultMockFactory, loadLabels, renderEvalText, renderSweepText, runEval, runPromptAb, runSweep } from "./run.ts";
import { LabelError } from "./labels.ts";

export async function runEvalCli(pos: string[], flags: Record<string, string | true | string[] | undefined>, cfg: Config, judge: string): Promise<number> {
  const path = pos[0];
  if (!path) {
    console.error("用法：sv eval <labels.yaml> [--judge=off|mock] [--window N] [--ab] [--set k=v ...] [--sweep path=v1,v2,…] [--log [db]] [--label name] [--format=text|json] [--out <path>]");
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
  const label = typeof flags.label === "string" ? flags.label : undefined;
  const overrides = ((flags.set as string[] | undefined) ?? []).slice();
  const judgeMode = judge === "mock" ? "mock" : "off";
  const logStore = flags.log ? new LogStore(expandHome(typeof flags.log === "string" ? flags.log : cfg.log.db), { jsonlDir: cfg.log.jsonl_dir, storeEventBodies: cfg.log.store_event_bodies, storeJudgeBodies: cfg.log.store_judge_bodies }) : undefined;
  const emit = (obj: unknown) => {
    const json = JSON.stringify(redactDeep(obj), null, 2);
    if (typeof flags.out === "string") writeFileSync(flags.out, json + "\n");
    return json;
  };
  try {
    if (typeof flags.sweep === "string") {
      const eq = flags.sweep.indexOf("=");
      const sweepPath = flags.sweep.slice(0, eq);
      const values = flags.sweep.slice(eq + 1).split(",").map((v) => v.trim()).filter(Boolean);
      if (eq <= 0 || values.length < 2) {
        console.error("--sweep 的格式是 path=v1,v2,…（至少两个取值），例如 --sweep thresholds.T1.H=3,4,5");
        return 2;
      }
      let points;
      try {
        points = await runSweep(labels, { path: sweepPath, values }, { cfg, window, judge: judgeMode, logStore, label, overrides });
      } catch (e) {
        console.error(`扫描有误：${(e as Error).message}`); // 键名写错时一个都不跑
        return 2;
      }
      const json = emit(points);
      console.log(flags.format === "json" ? json : renderSweepText(sweepPath, points));
      return 0;
    }
    if (flags.ab) {
      const ab = await runPromptAb(labels, { cfg, window, judgeFactory: defaultMockFactory });
      const json = emit(ab);
      console.log(flags.format === "json" ? json : ["提示写法 A（recall 优先）：", renderEvalText(ab.recall), "", "提示写法 B（默认 ignore）：", renderEvalText(ab.ignoreDefault), "", ab.note].join("\n"));
      return 0;
    }
    const { report, runId } = await runEval(labels, { cfg, window, judge: judgeMode, logStore, label, overrides });
    const json = emit(report);
    console.log(flags.format === "json" ? json : renderEvalText(report));
    if (logStore && runId !== undefined) console.error(`已写入日志：eval run ${runId} → ${logStore.db.filename}`);
    return 0;
  } finally {
    logStore?.close();
  }
}
