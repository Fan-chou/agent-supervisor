// 评测入口：读 labels → 回放每个会话 → 计算每条规则的 precision/recall 与首次报警延迟。
import { readFileSync } from "node:fs";
import { applyOverride, beginRun, defaultConfig, mockJudge, type Config, type JudgeFn, type LogStore } from "@sv/core";
import { replayFile, type ReplayResult } from "../../packages/replay/src/index.ts";
import type { PromptStyle } from "@sv/core";
import { loadLabels, type Labels } from "./labels.ts";
import { computeReport, type EvalReport, type SessionInput } from "./metrics.ts";

export interface EvalOptions {
  cfg?: Config;
  judge?: "off" | "mock" | JudgeFn;
  window?: number;
  /** 提示 A/B：按写法生成 judge。 */
  judgeFactory?: (style: PromptStyle) => JudgeFn;
  /** 写日志：每次评测记一条 kind=eval 的运行（含当时的阈值与覆盖项），各会话的回放写在这个 run 下。 */
  logStore?: LogStore;
  label?: string;
  /** 命令行覆盖项（只用于记录；cfg 里应当已经应用）。 */
  overrides?: string[];
}

export interface EvalRun {
  report: EvalReport;
  results: ReplayResult[];
  runId?: number;
}

export async function runEval(labels: Labels, opts: EvalOptions = {}): Promise<EvalRun> {
  const cfg = opts.cfg ?? defaultConfig();
  const inputs: SessionInput[] = [];
  const results: ReplayResult[] = [];
  const warnings: string[] = [];
  const judgeMode = typeof opts.judge === "function" ? "custom" : (opts.judge ?? "off");
  const runId = opts.logStore ? beginRun(opts.logStore, cfg, { kind: "eval", label: opts.label, source: labels.path, judgeMode, overrides: opts.overrides }) : undefined;
  for (const label of labels.sessions) {
    try {
      const planMd = label.plan ? readFileSync(label.plan, "utf8") : undefined;
      const result = await replayFile(label.file, { cfg, judge: opts.judge ?? "off", planMd, log: opts.logStore && runId !== undefined ? { store: opts.logStore, runId } : undefined });
      inputs.push({ label, result });
      results.push(result);
    } catch (err) {
      warnings.push(`${label.id}: 回放失败（${String(err)}）——该会话不计入统计`);
    }
  }
  const report = computeReport(inputs, { window: opts.window });
  report.warnings.push(...warnings);
  if (opts.logStore && runId !== undefined) opts.logStore.endRun(runId);
  return { report, results, runId };
}

export interface SweepPoint {
  value: string;
  overrides: string[];
  runId?: number;
  report: EvalReport;
}

/**
 * 阈值扫描：对 path 的每个取值各跑一遍评测（每个取值写一条 kind=eval 的运行记录）。
 * path 必须是已存在的配置路径（applyOverride 会拒绝写错的键），所以扫到的一定是真正生效的阈值。
 */
export async function runSweep(labels: Labels, sweep: { path: string; values: string[] }, opts: EvalOptions = {}): Promise<SweepPoint[]> {
  const base = opts.cfg ?? defaultConfig();
  const planned = sweep.values.map((v) => {
    const assignment = `${sweep.path}=${v}`;
    return { value: v, assignment, cfg: applyOverride(base, assignment) }; // 先全部校验，写错时一个都不跑
  });
  const out: SweepPoint[] = [];
  for (const p of planned) {
    const run = await runEval(labels, { ...opts, cfg: p.cfg, label: `${opts.label ?? "sweep"}:${p.assignment}`, overrides: [...(opts.overrides ?? []), p.assignment] });
    out.push({ value: p.value, overrides: [...(opts.overrides ?? []), p.assignment], runId: run.runId, report: run.report });
  }
  return out;
}

export function renderSweepText(path: string, points: SweepPoint[]): string {
  const L: string[] = [];
  L.push(`阈值扫描 ${path} = ${points.map((p) => p.value).join(" | ")}`);
  for (const p of points) if (p.runId !== undefined) L.push(`  ${path}=${p.value} → run ${p.runId}`);
  L.push("");
  const rules = [...new Set(points.flatMap((p) => Object.keys(p.report.rules)))].sort();
  const cell = (r: EvalReport["rules"][string] | undefined) => (r ? `${r.hits}命中 P ${pct(r.precision)} R ${pct(r.recall)} 延迟${r.firstAlarmLatency.median ?? "–"}` : "–");
  L.push(["规则".padEnd(6), ...points.map((p) => `${path.split(".").slice(-2).join(".")}=${p.value}`.padEnd(34))].join(" "));
  for (const id of rules) L.push([id.padEnd(6), ...points.map((p) => cell(p.report.rules[id]).padEnd(34))].join(" "));
  L.push("");
  L.push(["总体".padEnd(6), ...points.map((p) => `recall ${pct(p.report.overall.recall)} · 漏报 ${p.report.latency.missed}`.padEnd(34))].join(" "));
  L.push(["拦截类".padEnd(6), ...points.map((p) => `报警 ${p.report.classes.blocking.alarms} FDR ${pct(p.report.classes.blocking.fdr)} ${p.report.gates[0].pass === null ? "n/a" : p.report.gates[0].pass ? "通过" : "未通过"}`.padEnd(34))].join(" "));
  L.push(["建议类".padEnd(6), ...points.map((p) => `报警 ${p.report.classes.advisory.alarms} FDR ${pct(p.report.classes.advisory.fdr)} ${p.report.gates[1].pass === null ? "n/a" : p.report.gates[1].pass ? "通过" : "未通过"}`.padEnd(34))].join(" "));
  return L.join("\n");
}

export interface AbReport {
  recall: EvalReport;
  ignoreDefault: EvalReport;
  diff: { rule: string; precisionRecall: number | null; precisionIgnoreDefault: number | null }[];
  note: string;
}

/** 两种提示写法各跑一遍并对比（mock 下两者相同，只验证管道；真实比较要 live）。 */
export async function runPromptAb(labels: Labels, opts: EvalOptions & { judgeFactory: (style: PromptStyle) => JudgeFn }): Promise<AbReport> {
  const a = await runEval(labels, { ...opts, judge: opts.judgeFactory("recall") });
  const b = await runEval(labels, { ...opts, judge: opts.judgeFactory("ignore_default") });
  const ids = [...new Set([...Object.keys(a.report.rules), ...Object.keys(b.report.rules)])].sort();
  return {
    recall: a.report,
    ignoreDefault: b.report,
    diff: ids.map((rule) => ({ rule, precisionRecall: a.report.rules[rule]?.precision ?? null, precisionIgnoreDefault: b.report.rules[rule]?.precision ?? null })),
    note: "mock judge 不读提示，所以两种写法结果相同；这里只验证 A/B 管道，真实比较需要 --judge=live（M3）。",
  };
}

export const defaultMockFactory = (_style: PromptStyle): JudgeFn => mockJudge();

// ---------- 文本报告 ----------

const pct = (n: number | null) => (n === null ? "n/a" : (n * 100).toFixed(1) + "%");
const num = (n: number | null) => (n === null ? "–" : String(n));
const lat = (d: { n: number; min: number | null; median: number | null; max: number | null }) => (d.n ? `n=${d.n} min=${num(d.min)} 中位=${num(d.median)} max=${num(d.max)}` : "–");

export function renderEvalText(r: EvalReport): string {
  const L: string[] = [];
  L.push(`评测会话 ${r.counts.total}（正常 ${r.counts.ok} / 跑偏 ${r.counts.derailed}），提前窗口 ${r.window} 步，步骤单位 = 工具调用序号（从 1 起）`);
  for (const w of r.warnings) L.push(`! ${w}`);
  L.push("");
  L.push("规则        命中  触发会话  TP  FP  precision  recall  首次报警延迟（相对跑偏点）");
  for (const s of Object.values(r.rules)) {
    L.push(`${s.ruleId.padEnd(10)} ${String(s.hits).padStart(5)} ${String(s.sessionsFired).padStart(8)} ${String(s.tpSessions).padStart(3)} ${String(s.fpSessions).padStart(3)}  ${pct(s.precision).padStart(8)}  ${pct(s.recall).padStart(6)}  ${lat(s.firstAlarmLatency)}`);
  }
  L.push("");
  L.push(`总体：跑偏会话检出 ${r.overall.derailedDetected}/${r.overall.derailedTotal}（recall ${pct(r.overall.recall)}）；正常会话有命中 ${r.overall.firedOkSessions}/${r.overall.okTotal}`);
  L.push(`首次报警延迟：${lat(r.latency.firstAlarm)}；漏报 ${r.latency.missed}`);
  L.push("");
  L.push("报警分类（按决策）：");
  for (const k of ["blocking", "advisory", "candidate"] as const) {
    const c = r.classes[k];
    const name = k === "blocking" ? "拦截类" : k === "advisory" ? "建议类" : "待judge候选";
    L.push(`  ${name.padEnd(8)} 报警 ${String(c.alarms).padStart(3)}  TP ${c.tp}  FP ${c.fp}  FDR ${pct(c.fdr)}  有此类误报的正常会话 ${c.okSessionsWithAlarm}/${c.okSessions}`);
  }
  L.push("");
  L.push("门槛（§12.7）：");
  for (const g of r.gates) L.push(`  ${g.name} < ${(g.threshold * 100).toFixed(0)}%：${pct(g.value)}  ${g.pass === null ? "n/a（没有报警）" : g.pass ? "通过" : "未通过"}`);
  L.push("");
  L.push(`judge：调用 ${r.judge.calls}（每会话 ${num(r.judge.perSessionMean)}）`);
  for (const [m, s] of Object.entries(r.judge.byModel)) L.push(`  ${m}: 调用 ${s.calls}  ignore 率 ${pct(s.ignoreRate)}  judge_parse_fail 率 ${pct(s.parseFailRate)}  超时 ${s.timeouts}  出错 ${s.errors}`);
  L.push("");
  L.push("会话：");
  for (const s of r.sessions) L.push(`  ${s.id.padEnd(24)} ${s.outcome === "derailed" ? `跑偏@${s.derailStep}` : "正常   "}  调用 ${String(s.calls).padStart(3)}  命中 ${String(s.hits).padStart(2)}  规则 ${s.firedRules.join(",") || "-"}${s.outcome === "derailed" ? `  首次报警 ${s.firstAlarmLatency === null ? "漏报" : (s.firstAlarmLatency >= 0 ? "+" : "") + s.firstAlarmLatency}` : ""}`);
  return L.join("\n");
}

export { loadLabels };
