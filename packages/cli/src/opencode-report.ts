// `sv opencode-report <dump.jsonl>`：把 SV_OPENCODE_DUMP=1 落下的样本汇总成「真机核对」要的结论（docs/opencode-verify.md）。
// 只读我们自己写的 dump 文件；不联网、不碰 OpenCode 的任何目录。

export interface DumpRecord {
  n: number;
  ts: number;
  pid?: number;
  hook: string;
  phase: "enter" | "exit" | "setup" | "note";
  shape?: unknown;
  sample?: any;
  registered?: boolean;
  reason?: string;
  probe?: boolean;
  wouldDeny?: boolean;
  source?: string;
  withheld?: string;
  error?: string;
}

export interface Report {
  records: number;
  /** setup 时 ctx 的形状（名字和类型，不含值）。 */
  ctxShape: unknown;
  /** 每个 hook 是否注册成功（以及失败原因）。 */
  registered: Record<string, { ok: boolean; reason?: string }>;
  /** 每个 hook 被调用的次数、enter→exit 的平均耗时、顶层字段出现情况。 */
  hooks: Record<string, { calls: number; avgMs: number | null; fields: Record<string, number>; errors: number }>;
  /** 每次工具调用里 execute.before / permission.evaluate / execute.after 的先后次序（按会话内 n 排）及出现次数。 */
  orderings: Record<string, number>;
  /** evaluate 是否比同一会话的 execute.before 先触发（"E before B"）等结论。 */
  verdicts: string[];
  /** 探针 / 闸门相关的记录（deny 是否生效要看 exit 时的事件对象有没有 effect/message）。 */
  denyObserved: { hook: string; effect?: unknown; message?: unknown }[];
  wouldDeny: number;
  /** 打开 OpenCode 拦截的机器可检查门槛（decisions #110）；人工条件（观察一周、Jack 批准）不在其中。 */
  gate: Gate;
}

export interface GateCheck {
  id: string;
  ok: boolean;
  detail: string;
}
export interface Gate {
  passed: boolean;
  checks: GateCheck[];
}

/** 适配器依赖的五个钩子（docs/opencode-verify.md §1）。 */
export const REQUIRED_HOOKS = ["evaluate", "context", "prompt", "execute.before", "execute.after"];
/** 会改东西的工具：这些调用必须触发 evaluate，否则 deny 覆盖不到。 */
const MUTATING_TOOLS = new Set(["bash", "shell", "edit", "write", "multiedit", "patch", "apply_patch"]);
export const MAX_REPORT_AGE_MS = 14 * 86_400_000;

const SESSION_KEYS =["sessionID", "sessionId", "session"];
function sessionOf(r: DumpRecord): string {
  const s = r.sample;
  if (!s || typeof s !== "object") return "?";
  for (const k of SESSION_KEYS) {
    const v = s[k];
    if (typeof v === "string") return v;
    if (v && typeof v === "object" && typeof v.id === "string") return v.id;
  }
  return "?";
}

export function parseDump(text: string): DumpRecord[] {
  const out: DumpRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as DumpRecord);
    } catch {
      /* 跳过坏行 */
    }
  }
  return out.sort((a, b) => a.n - b.n);
}

export function analyze(recs: DumpRecord[], now: number = Date.now()): Report {
  const rep: Report = { records: recs.length, ctxShape: undefined, registered: {}, hooks: {}, orderings: {}, verdicts: [], denyObserved: [], wouldDeny: 0, gate: { passed: false, checks: [] } };
  const setup = recs.find((r) => r.phase === "setup");
  rep.ctxShape = setup?.shape;
  const enterAt = new Map<string, DumpRecord[]>();
  for (const r of recs) {
    if (r.phase === "note" && r.registered !== undefined) rep.registered[r.hook] = { ok: r.registered, reason: r.reason };
    if (r.phase === "note" && r.wouldDeny) rep.wouldDeny++;
    if (r.phase === "note" && r.error) (rep.hooks[r.hook] ??= { calls: 0, avgMs: null, fields: {}, errors: 0 }).errors++;
    if (r.phase === "enter") {
      const h = (rep.hooks[r.hook] ??= { calls: 0, avgMs: null, fields: {}, errors: 0 });
      h.calls++;
      if (r.shape && typeof r.shape === "object") for (const k of Object.keys(r.shape as object)) h.fields[k] = (h.fields[k] ?? 0) + 1;
      const q = enterAt.get(r.hook) ?? [];
      q.push(r);
      enterAt.set(r.hook, q);
    }
    if (r.phase === "exit") {
      const q = enterAt.get(r.hook);
      const e = q?.shift();
      const h = rep.hooks[r.hook];
      if (e && h) {
        const d = r.ts - e.ts;
        h.avgMs = h.avgMs === null ? d : (h.avgMs * (h.calls - 1 - (q?.length ?? 0)) + d) / Math.max(1, h.calls - (q?.length ?? 0));
      }
      const s = r.sample;
      if (s && typeof s === "object" && ("effect" in s || "message" in s) && (s.effect === "deny" || s.message)) rep.denyObserved.push({ hook: r.hook, effect: s.effect, message: s.message });
    }
  }

  // 次序：同一会话里，按 enter 顺序把 B(execute.before) / E(evaluate) / A(execute.after) 连成串，再按「一次调用」切段（以 B 或 E 开头，到 A 结束）
  const bySession = new Map<string, { tag: string; tool?: string }[]>();
  for (const r of recs) {
    if (r.phase !== "enter") continue;
    const tag = r.hook === "execute.before" ? "B" : r.hook === "evaluate" ? "E" : r.hook === "execute.after" ? "A" : "";
    if (!tag) continue;
    const s = sessionOf(r);
    bySession.set(s, [...(bySession.get(s) ?? []), { tag, tool: typeof r.sample?.tool === "string" ? r.sample.tool : undefined }]);
  }
  const noEvaluateTools: string[] = []; // 没有触发 evaluate 的调用用的工具名（B→A）
  for (const seq of bySession.values()) {
    let cur = "";
    let tool: string | undefined;
    for (const t of seq) {
      cur += t.tag;
      if (t.tag === "B") tool = t.tool;
      if (t.tag === "A") {
        rep.orderings[cur] = (rep.orderings[cur] ?? 0) + 1;
        if (cur === "BA" && tool) noEvaluateTools.push(tool);
        cur = "";
        tool = undefined;
      }
    }
    if (cur) rep.orderings[cur + "…"] = (rep.orderings[cur + "…"] ?? 0) + 1;
  }
  const o = rep.orderings;
  const n = (re: RegExp) => Object.entries(o).filter(([k]) => re.test(k)).reduce((a, [, v]) => a + v, 0);
  const total = Object.values(o).reduce((a, b) => a + b, 0);
  if (!total) rep.verdicts.push("没有记录到完整的工具调用（需要 execute.before / execute.after 都被调用）。");
  else {
    if (n(/^B(E)?A$/) === total) rep.verdicts.push("✓ 每次调用都是 execute.before 先于 permission.evaluate（或没有 evaluate）。当前适配器的假设成立。");
    if (n(/^EB/) > 0) rep.verdicts.push(`✗ 有 ${n(/^EB/)} 次 permission.evaluate 先于 execute.before：本地 X2 / daemon 的 block 绑定会漏拦（目前是安全的漏拦，不是误拦），需要改设计。`);
    if (n(/^BA$/) > 0) rep.verdicts.push(`ℹ ${n(/^BA$/)} 次调用没有触发 permission.evaluate（工具无权限闸门或被配置放行）——这些调用上 deny 无从下手。`);
    if (n(/^BEA$/) > 0) rep.verdicts.push(`✓ ${n(/^BEA$/)} 次调用是 B→E→A。`);
  }
  for (const [name, h] of Object.entries(rep.hooks)) if (h.calls === 0) rep.verdicts.push(`✗ ${name} 一次都没被调用。`);
  for (const [name, r] of Object.entries(rep.registered)) if (!r.ok) rep.verdicts.push(`✗ ${name} 注册失败：${r.reason ?? "?"}（设计里依赖它，需要改）。`);

  // ---- 打开拦截的机器可检查门槛 ----
  const checks: GateCheck[] = [];
  const check = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail });
  const missing = REQUIRED_HOOKS.filter((h) => rep.registered[h]?.ok !== true);
  check("hooks_registered", missing.length === 0, missing.length ? `这些钩子没有注册成功或没有记录：${missing.join("、")}` : `${REQUIRED_HOOKS.length} 个钩子都注册成功`);
  const complete = Object.entries(o).filter(([k]) => !k.endsWith("…")).reduce((a, [, v]) => a + v, 0);
  check("enough_calls", complete >= 5, `完整工具调用 ${complete} 次（至少 5 次）`);
  const evaluates = Object.entries(o).reduce((a, [k, v]) => a + (k.match(/E/g)?.length ?? 0) * v, 0);
  const eFirst = n(/^E/);
  check("before_precedes_evaluate", evaluates >= 1 && eFirst === 0, evaluates === 0 ? "没有观察到任何 permission.evaluate" : eFirst ? `${eFirst} 次 evaluate 先于 execute.before` : `${evaluates} 次 evaluate，全部在 execute.before 之后`);
  const mutNoE = noEvaluateTools.filter((t) => MUTATING_TOOLS.has(t.toLowerCase()));
  check("mutating_calls_have_evaluate", mutNoE.length === 0, mutNoE.length ? `写类工具的调用没有触发 evaluate（deny 覆盖不到）：${[...new Set(mutNoE)].join("、")}` : "写类工具的调用都触发了 evaluate");
  const probe = rep.denyObserved.filter((d) => d.effect === "deny" && typeof d.message === "string" && d.message.includes("探针"));
  check("probe_deny_worked", probe.length >= 1, probe.length ? `探针 deny 生效 ${probe.length} 次（exit 时事件上看到 effect=deny 和 message）` : "没有看到探针 deny 生效的记录（先按清单步骤 4 做一次）");
  const errors = Object.values(rep.hooks).reduce((a, h) => a + h.errors, 0);
  check("no_handler_errors", errors === 0, errors ? `钩子处理函数里有 ${errors} 次异常` : "没有异常");
  const lastTs = recs.reduce((m, r) => Math.max(m, r.ts ?? 0), 0);
  check("recent", lastTs > 0 && now - lastTs <= MAX_REPORT_AGE_MS, lastTs ? `最近一条记录是 ${Math.round((now - lastTs) / 3_600_000)} 小时前（上限 ${MAX_REPORT_AGE_MS / 86_400_000} 天）` : "报告里没有记录");
  rep.gate = { passed: checks.every((c) => c.ok), checks };
  return rep;
}

export function formatReport(rep: Report): string {
  const L: string[] = [];
  L.push(`记录数：${rep.records}`);
  L.push("", "## ctx 形状（setup）", JSON.stringify(rep.ctxShape ?? null, null, 1));
  L.push("", "## 钩子注册");
  for (const [k, v] of Object.entries(rep.registered)) L.push(`- ${k}: ${v.ok ? "已注册" : "失败 — " + (v.reason ?? "")}`);
  L.push("", "## 各钩子被调用情况（顶层字段 → 出现次数）");
  for (const [k, v] of Object.entries(rep.hooks)) L.push(`- ${k}: 调用 ${v.calls} 次，平均耗时 ${v.avgMs === null ? "?" : v.avgMs.toFixed(1)} ms，异常 ${v.errors}；字段 ${JSON.stringify(v.fields)}`);
  L.push("", "## 一次调用里的触发顺序（B=execute.before E=permission.evaluate A=execute.after）");
  for (const [k, v] of Object.entries(rep.orderings)) L.push(`- ${k}: ${v} 次`);
  L.push("", "## 结论");
  for (const v of rep.verdicts) L.push(`- ${v}`);
  L.push("", `## deny 观察：本应拦（被闸门/观察模式压住）${rep.wouldDeny} 次；exit 时事件上看到 effect/message ${rep.denyObserved.length} 次`);
  for (const d of rep.denyObserved) L.push(`- ${d.hook}: effect=${JSON.stringify(d.effect)} message=${JSON.stringify(d.message)}`);
  L.push("", `## 打开拦截的机器门槛：${rep.gate.passed ? "通过" : "未通过"}（还需要 Jack 的批准和 shadow 观察期，见 docs/opencode-verify.md §5）`);
  for (const c of rep.gate.checks) L.push(`- ${c.ok ? "✓" : "✗"} ${c.id}：${c.detail}`);
  return L.join("\n");
}
