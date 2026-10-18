// 回放：Event 流 → Engine → 命中时间线（JSON + 可读文本）。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { defaultConfig, Engine, mockJudge, redact, redactDeep, StoreSink, type LogStore, type Config, type Decision, type Event, type Hit, type JudgeFn, type MockOptions } from "@sv/core";
import { readClaudeTranscript } from "./claude.ts";
import { readCodexRollout } from "./codex.ts";

export type JudgeMode = "off" | "mock";

export interface ReplayOptions {
  judge?: JudgeMode | JudgeFn;
  mock?: MockOptions;
  cfg?: Config;
  planMd?: string;
  /** 回放没有真实工作区指纹，默认把「由事件推断的未改动」当作已核实，结果里仍标注 verified=false。 */
  trustInferredUnchanged?: boolean;
  /** 只读取、不跑检测（测试读取器用）。 */
  format?: "claude" | "codex";
  /** 写结构化日志：调用方先 beginRun 得到 runId（多个文件可以共用一个 run）。 */
  log?: { store: LogStore; runId: number };
}

export interface TimelineEntry {
  /** 事件序号。 */
  seq: number;
  ts: number;
  /** 距会话第一条事件的毫秒数。 */
  relMs: number;
  /** 命中时已完成的工具调用步数。 */
  step: number;
  /** 命中所指的工具调用序号（从 1 开始）。eval 的步骤单位用它：pre 阶段命中 = step+1。 */
  callIndex: number;
  ruleId: string;
  sev: Hit["sev"];
  category: Hit["category"];
  phase: Hit["phase"];
  action: Decision["action"];
  applied: boolean;
  reason: string;
  message?: string;
  evidence: number[];
  verified?: boolean;
  wouldBlockIfVerified?: boolean;
  observeOnly?: boolean;
  atNextPre?: boolean;
  judge?: Decision["judge"];
  detail?: Record<string, unknown>;
}

export interface ReplayResult {
  file?: string;
  sessionId: string;
  harness: string;
  model?: string;
  judgeMode: string;
  events: number;
  steps: number;
  durationMs: number;
  plan: { source: string; current?: string; items: number; explicitAllow: string[] } | null;
  timeline: TimelineEntry[];
  summary: {
    hits: number;
    byRule: Record<string, { hits: number; actions: Record<string, number> }>;
    judgeCalls: number;
    firstHitMs: Record<string, number>;
    /** 按 judge 实际使用的 model 统计（ignore 率、解析失败率、超时、出错）。 */
    judge: { calls: number; byModel: Record<string, { calls: number; ignores: number; parseFail: number; timeouts: number; errors: number }> };
  };
  warnings: string[];
}

export function detectFormat(text: string): "claude" | "codex" | "unknown" {
  for (const raw of text.split("\n").slice(0, 40)) {
    const l = raw.trim();
    if (!l) continue;
    try {
      const j = JSON.parse(l) as Record<string, unknown>;
      if (j.payload && typeof j.type === "string" && ["session_meta", "response_item", "event_msg", "turn_context"].includes(j.type)) return "codex";
      if (j.message && (j.type === "user" || j.type === "assistant")) return "claude";
      if (j.sessionId && typeof j.type === "string") return "claude";
    } catch {
      /* 继续看下一行 */
    }
  }
  return "unknown";
}

export function readEvents(text: string, format?: "claude" | "codex", sessionIdFallback?: string): Event[] {
  const f = format ?? detectFormat(text);
  if (f === "claude") return readClaudeTranscript(text, { sessionIdFallback });
  if (f === "codex") return readCodexRollout(text, { sessionIdFallback });
  throw new Error("无法识别的 transcript 格式（既不是 Claude Code 也不是 Codex rollout）");
}

export async function replayEvents(events: Event[], opts: ReplayOptions = {}, file?: string): Promise<ReplayResult> {
  const cfg = opts.cfg ?? defaultConfig();
  let judge: JudgeFn | undefined;
  let judgeMode = "off";
  if (typeof opts.judge === "function") {
    judge = opts.judge;
    judgeMode = "custom";
  } else if (opts.judge === "mock") {
    judge = mockJudge(opts.mock);
    judgeMode = "mock";
  }
  const sink = opts.log ? new StoreSink(opts.log.store, { runId: opts.log.runId, channelPrefix: "replay", sourceFile: file }) : undefined;
  const engine = new Engine({ cfg, judge, planMd: opts.planMd, sink, policy: { trustInferredUnchanged: opts.trustInferredUnchanged ?? true } });
  const t0 = events[0]?.ts ?? 0;
  const timeline: TimelineEntry[] = [];
  for (const e of events) {
    const rec = await engine.feed(e);
    const step = engine.tracker.steps.length;
    for (const h of rec.hits) {
      const ds = rec.decisions.filter((d) => d.hit === h);
      const d: Decision = ds[0] ?? { hit: h, action: "log", reason: "无决策记录", applied: false };
      timeline.push({
        seq: h.seq,
        ts: h.ts,
        relMs: h.ts - t0,
        step,
        // pre 阶段命中时这次调用还没完成：它是第 step+1 次调用；其余阶段命中时指向刚完成的第 step 次调用
        callIndex: h.phase === "pre" ? step + 1 : Math.max(step, 1),
        ruleId: h.ruleId,
        sev: h.sev,
        category: h.category,
        phase: h.phase,
        action: d.action,
        applied: d.applied,
        reason: d.reason,
        message: d.message ?? h.message,
        evidence: h.evidence,
        verified: h.verified,
        wouldBlockIfVerified: d.wouldBlockIfVerified,
        observeOnly: h.observeOnly,
        atNextPre: d.atNextPre,
        judge: d.judge,
        detail: h.detail,
      });
    }
  }
  const byRule: ReplayResult["summary"]["byRule"] = {};
  const firstHitMs: Record<string, number> = {};
  for (const t of timeline) {
    const r = (byRule[t.ruleId] ??= { hits: 0, actions: {} });
    r.hits++;
    r.actions[t.action] = (r.actions[t.action] ?? 0) + 1;
    if (!(t.ruleId in firstHitMs)) firstHitMs[t.ruleId] = t.relMs;
  }
  const plan = engine.plan;
  const warnings: string[] = [];
  if (!plan && cfg.plan.source !== "off") warnings.push("没有计划（agent 待办和 plan.md 都没有）：P1、P4 自动停用");
  if (events.some((e) => e.phase === "post" && e.result?.status === "pending")) warnings.push("存在未结束（pending）的调用，未计入 S3 等规则");
  const judgeStats: ReplayResult["summary"]["judge"] = { calls: engine.policy.judgeCallCount, byModel: {} };
  for (const j of engine.policy.judgeLog) {
    const m = (judgeStats.byModel[j.model ?? "unknown"] ??= { calls: 0, ignores: 0, parseFail: 0, timeouts: 0, errors: 0 });
    m.calls++;
    if (j.result === "parse_fail") m.parseFail++;
    else if (j.result === "timeout") m.timeouts++;
    else if (j.result === "error") m.errors++;
    else if (j.verdict === "ignore") m.ignores++;
  }
  engine.close();
  // 输出边界统一脱敏（P0-7、design §10）：命令、消息、detail 里可能带密钥
  return redactDeep({
    file,
    sessionId: events[0]?.sessionId ?? "unknown",
    harness: events[0]?.harness ?? "unknown",
    model: engine.tracker.model,
    judgeMode,
    events: events.length,
    steps: engine.tracker.steps.length,
    durationMs: (events[events.length - 1]?.ts ?? t0) - t0,
    plan: plan ? { source: plan.source, current: plan.items.find((i) => i.status === "in_progress")?.text, items: plan.items.length, explicitAllow: plan.explicitAllow } : null,
    timeline,
    summary: { hits: timeline.length, byRule, judgeCalls: engine.policy.judgeCallCount, firstHitMs, judge: judgeStats },
    warnings,
  });
}

export async function replayFile(path: string, opts: ReplayOptions = {}): Promise<ReplayResult> {
  const text = readFileSync(path, "utf8");
  const events = readEvents(text, opts.format, basename(path).replace(/\.jsonl?$/, ""));
  return replayEvents(events, opts, path);
}

export function listTranscripts(path: string): string[] {
  const st = statSync(path);
  if (st.isFile()) return [path];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else if (/\.jsonl$/.test(name)) out.push(p);
    }
  };
  walk(path);
  return out;
}

export async function replayPath(path: string, opts: ReplayOptions = {}): Promise<ReplayResult[]> {
  const out: ReplayResult[] = [];
  for (const f of listTranscripts(path)) {
    try {
      out.push(await replayFile(f, opts));
    } catch (err) {
      out.push({
        file: f,
        sessionId: basename(f),
        harness: "unknown",
        judgeMode: "off",
        events: 0,
        steps: 0,
        durationMs: 0,
        plan: null,
        timeline: [],
        summary: { hits: 0, byRule: {}, judgeCalls: 0, firstHitMs: {}, judge: { calls: 0, byModel: {} } },
        warnings: [`读取失败：${String(err)}`],
      });
    }
  }
  return out;
}

// ---------- 文本报告 ----------

const fmtRel = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `+${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

const ACTION_LABEL: Record<string, string> = {
  log: "记录",
  advise: "建议",
  block: "拦截",
  ask: "确认",
  stop_continue: "Stop续跑",
  ignore: "judge放行",
  judge_off: "待judge",
  skip: "跳过",
};

export function renderText(r: ReplayResult, opts: { verbose?: boolean } = {}): string {
  const out: string[] = [];
  out.push(`会话 ${r.sessionId}  [${r.harness}${r.model ? " / " + r.model : ""}]  judge=${r.judgeMode}`);
  if (r.file) out.push(`文件 ${r.file}`);
  out.push(`事件 ${r.events}，工具调用 ${r.steps}，时长 ${fmtRel(r.durationMs).slice(1)}，命中 ${r.summary.hits}，judge 调用 ${r.summary.judgeCalls}`);
  if (r.plan) out.push(`计划 来源=${r.plan.source}  当前步骤=${r.plan.current ?? "（无）"}${r.plan.explicitAllow.length ? "  allow=" + r.plan.explicitAllow.join(",") : ""}`);
  for (const w of r.warnings) out.push(`! ${w}`);
  if (r.timeline.length === 0) out.push("（没有命中）");
  else {
    out.push("");
    out.push("时间    步   规则   级  阶段  动作        说明");
    for (const t of r.timeline) {
      const flags = [t.observeOnly ? "仅观察" : "", !t.applied && ["block", "advise", "ask", "stop_continue"].includes(t.action) ? "shadow:不生效" : "", t.verified === false && t.sev === "H" ? "指纹未核实" : "", t.wouldBlockIfVerified ? "核实后会拦" : "", t.atNextPre ? "下个注入点" : ""].filter(Boolean).join(",");
      const act = (ACTION_LABEL[t.action] ?? t.action).padEnd(8);
      const msg = (t.message ?? t.reason).replace(/\s+/g, " ").slice(0, 70);
      out.push(`${fmtRel(t.relMs)}  ${String(t.step).padStart(3)}  ${t.ruleId.padEnd(5)}  ${t.sev}  ${t.phase.padEnd(5)} ${act}  ${msg}${flags ? "  [" + flags + "]" : ""}`);
      if (opts.verbose) out.push(`        原因：${t.reason}；证据 seq=${t.evidence.join(",")}`);
    }
    out.push("");
    out.push("按规则汇总：");
    for (const [id, v] of Object.entries(r.summary.byRule).sort()) {
      out.push(`  ${id.padEnd(5)} ${String(v.hits).padStart(3)} 次  首次 ${fmtRel(r.summary.firstHitMs[id])}  ` + Object.entries(v.actions).map(([a, n]) => `${ACTION_LABEL[a] ?? a}×${n}`).join(" "));
    }
  }
  return redact(out.join("\n"));
}
