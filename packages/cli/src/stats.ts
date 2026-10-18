// sv stats / mark / explain / override / export / prune —— 日志库的命令行入口（design §18）。
import { existsSync } from "node:fs";
import { compareRuns, expandHome, explainHit, judgeStats, listRuns, LogStore, modelRuleStats, resolveRuns, ruleStats, sessionStats, type Config, type Scope } from "@sv/core";

export interface Flags {
  [k: string]: string | true | string[] | undefined;
}

const str = (f: Flags, k: string): string | undefined => (typeof f[k] === "string" ? (f[k] as string) : undefined);

export function dbPath(flags: Flags, cfg: Config): string {
  return expandHome(str(flags, "db") ?? cfg.log.db);
}

export function openExisting(flags: Flags, cfg: Config): LogStore | null {
  const p = dbPath(flags, cfg);
  if (!existsSync(p)) {
    console.error(`日志库不存在：${p}\n先用 \`sv replay <path> --log\` 写入一次回放，或启动守护进程后再看。`);
    return null;
  }
  return new LogStore(p);
}

/** 7d / 24h / 30m / 2026-10-01 / epoch ms → epoch ms。 */
export function parseSince(s: string, now = Date.now()): number {
  const m = /^(\d+)([dhm])$/.exec(s);
  if (m) return now - Number(m[1]) * { d: 86_400_000, h: 3_600_000, m: 60_000 }[m[2] as "d"];
  if (/^\d{10,}$/.test(s)) return Number(s);
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`无法解析时间：${s}（用 7d / 24h / 2026-10-01）`);
  return t;
}

const pct = (n: number | null) => (n === null ? "n/a" : (n * 100).toFixed(1) + "%");
const num = (n: number | null) => (n === null ? "–" : String(n));
const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const csv = (rows: Record<string, unknown>[]) => (rows.length ? [Object.keys(rows[0]).join(","), ...rows.map((r) => Object.values(r).map(csvCell).join(","))].join("\n") : "");
const kv = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${k}×${v}`).join(" ") || "–";

function scopeOf(db: LogStore, flags: Flags): Scope {
  const runArg = str(flags, "run");
  const runIds = resolveRuns(db.db, { run: runArg ? runArg.split(",").map(Number).filter(Number.isFinite) : undefined, label: str(flags, "label"), kind: str(flags, "kind") });
  if (runIds && runIds.length === 0) throw new Error("没有匹配的运行（--run / --label / --kind）");
  return { runIds, since: str(flags, "since") ? parseSince(str(flags, "since")!) : undefined, until: str(flags, "until") ? parseSince(str(flags, "until")!) : undefined, sessionId: str(flags, "session") };
}

export function runStats(flags: Flags, cfg: Config): number {
  const store = openExisting(flags, cfg);
  if (!store) return 2;
  try {
    const format = str(flags, "format") ?? "text";
    const out = (rows: Record<string, unknown>[], text: () => string) => console.log(format === "json" ? JSON.stringify(rows, null, 2) : format === "csv" ? csv(rows) : text());

    const cmp = str(flags, "compare");
    if (cmp) {
      const [a, b] = cmp.split(",").map(Number);
      if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error("--compare 需要两个 run id，例如 --compare 3,4");
      const rows = compareRuns(store.db, a, b);
      out(rows as unknown as Record<string, unknown>[], () =>
        [`对比 run ${a} → run ${b}（thresholds 不同的两次回放，看每条规则的命中/报警/拦截变化）`, "规则    命中A 命中B   Δ   报警A 报警B   Δ   拦截A 拦截B", ...rows.map((r) => `${r.rule.padEnd(6)} ${String(r.hitsA).padStart(5)} ${String(r.hitsB).padStart(5)} ${String(r.deltaHits).padStart(4)}  ${String(r.alarmsA).padStart(5)} ${String(r.alarmsB).padStart(5)} ${String(r.deltaAlarms).padStart(4)}  ${String(r.blocksA).padStart(5)} ${String(r.blocksB).padStart(5)}`)].join("\n"),
      );
      return 0;
    }

    const by = str(flags, "by") ?? "rule";
    const scope = scopeOf(store, flags);
    if (by === "runs") {
      const rows = listRuns(store.db);
      out(rows, () => ["id  类型    标签            模式    judge  thresholds   会话  命中  覆盖", ...rows.map((r) => `${String(r.id).padEnd(3)} ${String(r.kind).padEnd(7)} ${String(r.label ?? "").padEnd(15)} ${String(r.mode ?? "").padEnd(7)} ${String(r.judge_mode ?? "").padEnd(6)} ${String(r.thresholds_hash ?? "").padEnd(12)} ${String(r.sessions).padStart(4)} ${String(r.hits).padStart(5)}  ${r.overrides_json ?? ""}`)].join("\n"));
    } else if (by === "rule") {
      const rows = ruleStats(store.db, scope);
      out(
        rows.map((r) => ({ rule: r.rule, hits: r.hits, sessions: r.sessions, hits_per_100_calls: r.hitsPer100Calls, session_rate: r.sessionRate, L: r.bySev.L ?? 0, M: r.bySev.M ?? 0, H: r.bySev.H ?? 0, applied: r.applied, labeled_fp: r.labeledFp, labeled_useful: r.labeledUseful, fp_rate: r.fpRate, delivered: r.delivered, complied: r.complied, not_complied: r.notComplied, compliance_rate: r.complianceRate, actions: kv(r.actions), suppressed: kv(r.suppressed) })),
        () =>
          [
            "规则   命中 会话 /100调用 会话占比  L/M/H      生效 标误报 标有用 误报率  遵从率  处置 · 被抑制",
            ...rows.map((r) => `${r.rule.padEnd(6)} ${String(r.hits).padStart(4)} ${String(r.sessions).padStart(4)} ${num(r.hitsPer100Calls).padStart(7)} ${pct(r.sessionRate).padStart(8)}  ${`${r.bySev.L ?? 0}/${r.bySev.M ?? 0}/${r.bySev.H ?? 0}`.padEnd(9)} ${String(r.applied).padStart(4)} ${String(r.labeledFp).padStart(5)} ${String(r.labeledUseful).padStart(5)} ${pct(r.fpRate).padStart(7)} ${pct(r.complianceRate).padStart(7)}  ${kv(r.actions)} · ${kv(r.suppressed)}`),
            "",
            "误报率 = 已标注命中里被标为误报的比例（sv mark <hit-id> fp|useful）；遵从率 = 被建议/拦截后 agent 没有继续同样做法的比例（只对 L1/L2/L3/T1/T2/T4/T5/T6 可判定）。",
          ].join("\n"),
      );
    } else if (by === "model") {
      const rows = modelRuleStats(store.db, scope);
      out(rows as unknown as Record<string, unknown>[], () => ["模型（只记录，不参与判定）       调用  规则   命中 /100调用", ...rows.map((r) => `${r.model.padEnd(30)} ${String(r.calls).padStart(5)}  ${r.rule.padEnd(5)} ${String(r.hits).padStart(4)} ${num(r.hitsPer100Calls).padStart(7)}`)].join("\n"));
    } else if (by === "judge") {
      const rows = judgeStats(store.db, scope);
      out(rows as unknown as Record<string, unknown>[], () =>
        ["模型               调用  ok  ignore率 parse_fail率 超时 出错  p50ms  p95ms  prompt/completion/cached tokens  成本$  重试 降级", ...rows.map((r) => `${r.model.padEnd(18)} ${String(r.calls).padStart(4)} ${String(r.ok).padStart(3)} ${pct(r.ignoreRate).padStart(7)} ${pct(r.parseFailRate).padStart(11)} ${String(r.timeouts).padStart(4)} ${String(r.errors).padStart(4)} ${num(r.latencyP50).padStart(6)} ${num(r.latencyP95).padStart(6)}  ${r.promptTokens}/${r.completionTokens}/${r.cachedTokens}  ${r.costUsd}  ${r.retries}  ${r.formatDowngrades}`)].join("\n"),
      );
    } else if (by === "session") {
      const rows = sessionStats(store.db, scope);
      out(rows, () => ["run 会话                  harness 模型                调用 L/M/H 报警 judge", ...rows.map((r) => `${String(r.run_id).padEnd(3)} ${String(r.session_id).slice(0, 22).padEnd(22)} ${String(r.harness ?? "").padEnd(7)} ${String(r.model ?? "").slice(0, 20).padEnd(20)} ${String(r.calls).padStart(4)} ${r.hits_L}/${r.hits_M}/${r.hits_H} ${String(r.alarms).padStart(4)} ${String(r.judge_calls).padStart(4)}`)].join("\n"));
    } else throw new Error(`--by 只支持 rule | model | judge | session | runs（收到 ${by}）`);
    return 0;
  } catch (e) {
    console.error(String((e as Error).message ?? e));
    return 2;
  } finally {
    store.close();
  }
}

export function runMark(pos: string[], flags: Flags, cfg: Config): number {
  const [id, label] = pos;
  const labels: Record<string, "false_positive" | "useful"> = { fp: "false_positive", false_positive: "false_positive", useful: "useful", ok: "useful" };
  if (!id || !labels[label ?? ""]) {
    console.error("用法：sv mark <hit-id> fp|useful [--note 说明] [--db path]");
    return 2;
  }
  const store = openExisting(flags, cfg);
  if (!store) return 2;
  try {
    const oid = store.mark(Number(id), labels[label], str(flags, "note"));
    console.log(`已标注命中 #${id} 为 ${label === "fp" || label === "false_positive" ? "误报" : "有用"}（override #${oid}）`);
    return 0;
  } catch (e) {
    console.error(String((e as Error).message));
    return 2;
  } finally {
    store.close();
  }
}

export function runOverride(pos: string[], flags: Flags, cfg: Config): number {
  const [id, what] = pos;
  if (!id || !["allow", "reject"].includes(what ?? "")) {
    console.error("用法：sv override <decision-id> allow|reject [--note 说明] [--db path]   （手动放行 / 驳回某次决策）");
    return 2;
  }
  const store = openExisting(flags, cfg);
  if (!store) return 2;
  try {
    const d = store.db.query("SELECT run_id, session_id FROM decisions WHERE id = ?").get(Number(id)) as { run_id: number; session_id: string } | null;
    if (!d) throw new Error(`没有 id=${id} 的决策`);
    const oid = store.insertOverride({ runId: d.run_id, sessionId: d.session_id, kind: what === "allow" ? "manual_allow" : "manual_reject", targetType: "decision", targetId: Number(id), note: str(flags, "note") });
    console.log(`已记录：决策 #${id} 被手动${what === "allow" ? "放行" : "驳回"}（override #${oid}）`);
    return 0;
  } catch (e) {
    console.error(String((e as Error).message));
    return 2;
  } finally {
    store.close();
  }
}

export function runExplain(pos: string[], flags: Flags, cfg: Config): number {
  const id = Number(pos[0]);
  if (!Number.isFinite(id)) {
    console.error("用法：sv explain <hit-id> [--db path] [--format json]");
    return 2;
  }
  const store = openExisting(flags, cfg);
  if (!store) return 2;
  try {
    const x = explainHit(store.db, id);
    if (!x) {
      console.error(`没有 id=${id} 的命中`);
      return 2;
    }
    if (str(flags, "format") === "json") console.log(JSON.stringify(x, null, 2));
    else {
      const h = x.hit;
      console.log(`命中 #${h.id}  规则 ${h.rule_id}  级别 ${h.sev}  阶段 ${h.phase}  调用 #${h.call_index}  模型 ${h.model ?? "–"}`);
      console.log(`  指纹 ${h.key}\n  阈值 ${h.threshold_json}\n  观测 ${h.observed_json}\n  消息 ${h.message ?? "–"}`);
      for (const e of x.events) console.log(`  证据 seq=${e.seq} ${e.phase} ${e.tool_name ?? ""} ${e.cmd_class ?? ""} ${e.norm_cmd ?? ""} → ${e.status ?? ""}${e.exit_code != null ? " exit " + e.exit_code : ""}`);
      for (const d of x.decisions) console.log(`  决策 #${d.id} ${d.action}（生效 ${d.applied ? "是" : "否"}，mode ${d.mode}）${d.suppressed_by ? " 抑制=" + d.suppressed_by : ""}：${d.reason}`);
      for (const j of x.judge) console.log(`  judge #${j.id} ${j.model} ${j.status} ${j.verdict ?? ""} conf=${j.confidence ?? "–"} ${j.latency_ms ?? "–"}ms tokens=${j.prompt_tokens ?? "–"}/${j.completion_tokens ?? "–"}`);
      for (const d of x.deliveries) console.log(`  投递 #${d.id} 通道 ${d.channel} 送达 ${d.delivered ? "是" : "否"}${d.expired_reason ? "（" + d.expired_reason + "）" : ""} 遵从 ${d.complied === null ? "未知" : d.complied ? "是" : "否"} ${d.compliance_note ?? ""}`);
      for (const l of x.labels) console.log(`  标注 ${l.kind} ${l.note ?? ""}`);
    }
    return 0;
  } finally {
    store.close();
  }
}

export function runExport(flags: Flags, cfg: Config): number {
  const out = str(flags, "out");
  if (!out) {
    console.error("用法：sv export --out <dir> [--db path]   （每张表导出为 <table>.jsonl）");
    return 2;
  }
  const store = openExisting(flags, cfg);
  if (!store) return 2;
  try {
    const counts = store.exportJsonl(out);
    console.log(Object.entries(counts).map(([t, n]) => `${t}: ${n}`).join("\n"));
    return 0;
  } finally {
    store.close();
  }
}

export function runPrune(flags: Flags, cfg: Config): number {
  const store = openExisting(flags, cfg);
  if (!store) return 2;
  try {
    const days = str(flags, "days") ? Number(str(flags, "days")) : cfg.log.retention_days;
    const r = store.prune(days);
    console.log(days > 0 ? `保留 ${days} 天，已清理：${Object.entries(r).map(([t, n]) => `${t} ${n}`).join("，")}（被人工标注过的命中不清理）` : "retention_days=0，不清理");
    return 0;
  } finally {
    store.close();
  }
}
