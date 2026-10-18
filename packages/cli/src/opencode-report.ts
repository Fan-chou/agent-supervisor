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
}

const SESSION_KEYS = ["sessionID", "sessionId", "session"];
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

export function analyze(recs: DumpRecord[]): Report {
  const rep: Report = { records: recs.length, ctxShape: undefined, registered: {}, hooks: {}, orderings: {}, verdicts: [], denyObserved: [], wouldDeny: 0 };
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
  const bySession = new Map<string, string[]>();
  for (const r of recs) {
    if (r.phase !== "enter") continue;
    const tag = r.hook === "execute.before" ? "B" : r.hook === "evaluate" ? "E" : r.hook === "execute.after" ? "A" : "";
    if (!tag) continue;
    const s = sessionOf(r);
    bySession.set(s, [...(bySession.get(s) ?? []), tag]);
  }
  for (const seq of bySession.values()) {
    let cur = "";
    for (const t of seq) {
      cur += t;
      if (t === "A") {
        rep.orderings[cur] = (rep.orderings[cur] ?? 0) + 1;
        cur = "";
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
  return L.join("\n");
}
