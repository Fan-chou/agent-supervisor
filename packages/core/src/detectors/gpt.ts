// GPT 过度测试 T1–T8 与每轮预算（design §6）。「两次之间没改动」一律走 SessionTracker.unchangedBetween。
import type { Event } from "../event.ts";
import { ladderLevel, type Ladder, type Level } from "../config.ts";
import { VERIFY_LIKE, isTestPath, type Step } from "../session.ts";
import { hasTestIntent } from "./cheat.ts";
import { mkHit, ruleDisabled, type DetectCtx, type Detector, type Hit } from "./types.ts";

const short = (s: string, n = 80) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** 例外：任务本身是写测试/修 flaky/基准/修 CI 时整体降一级。 */
function demote(level: Level): Level | null {
  return level === "H" ? "M" : level === "M" ? "advise" : level === "advise" ? "L" : null;
}

function emit(e: Event, ctx: DetectCtx, ruleId: string, level: Level, message: string, extra: Partial<Hit> & { key: string; detail?: Record<string, unknown> }): Hit[] {
  let lv: Level | null = level;
  const exempt = hasTestIntent(ctx.s);
  if (exempt) lv = demote(level);
  if (!lv) return [];
  const sev = lv === "H" ? "H" : lv === "M" ? "M" : "L";
  return [
    mkHit(e, ctx, {
      ruleId,
      sev,
      category: "over_testing",
      message: lv === "L" ? undefined : message,
      ...extra,
      detail: { ...extra.detail, level: lv, exempt },
    }),
  ];
}

/** 阶梯边沿：第 n 次比第 n-1 次升了级才触发。 */
function edge(ladder: Ladder, n: number, scale: number): Level | null {
  const now = ladderLevel(ladder, n, scale);
  const prev = ladderLevel(ladder, n - 1, scale);
  if (!now || now === prev) return null;
  return now;
}

function summaryOf(st: Step): string {
  const t = st.ev.result?.testSummary;
  if (t) {
    const parts = [t.failed !== undefined ? `${t.failed} 失败` : "", t.passed !== undefined ? `${t.passed} 通过` : ""].filter(Boolean);
    if (parts.length) return parts.join("，");
  }
  return st.status === "ok" ? "通过" : st.status === "fail" ? "失败" : "未知";
}

export const T1: Detector = (e, ctx) => {
  if (e.phase !== "pre" || !e.shell || ruleDisabled(ctx, "T1")) return [];
  const { s, profile } = ctx;
  const a = s.analyze(e.shell.cmd);
  if (a.cls !== "test_full" && a.cls !== "test_targeted") return [];
  const runs = s.testRuns.filter((r) => r.normCmd === a.normCmd && r.stepIdx >= s.loopFloor && r.status !== "pending");
  const last = runs[runs.length - 1];
  if (!last) return [];
  const lastStep = s.steps[last.stepIdx];
  const u0 = s.unchangedBetween(lastStep, { verBefore: s.version, ev: e });
  if (u0 === "changed") return [];
  let nPrev = 1;
  let verified = u0 === "verified";
  for (let i = runs.length - 2; i >= 0; i--) {
    const u = s.unchangedBetween(s.steps[runs[i].stepIdx], s.steps[runs[i + 1].stepIdx]);
    if (u === "changed") break;
    if (u !== "verified") verified = false;
    nPrev++;
  }
  const attempt = nPrev + 1;
  const level = ladderLevel(profile.T1, attempt, s.scaleOf("T1"));
  if (!level) return [];
  const msg = `工作区自上次运行 \`${short(a.normCmd)}\` 以来没有变化，上次结果：${summaryOf(lastStep)}。`;
  return emit(e, ctx, "T1", level, msg, {
    key: `T1:${a.normCmd}:${attempt}`,
    blockable: level === "H",
    verified,
    evidence: runs.slice(-nPrev).map((r) => s.steps[r.stepIdx].seq),
    detail: { attempt, cmd: a.normCmd },
  });
};

export const T2: Detector = (e, ctx) => {
  if (e.phase !== "post" || ruleDisabled(ctx, "T2")) return [];
  const { s, profile } = ctx;
  const cur = s.last();
  if (!cur || cur.seq !== e.seq || cur.cls !== "test_full") return [];
  const runs = s.testRuns.filter((r) => r.cls === "test_full" && r.turn === s.turn && r.stepIdx >= s.loopFloor);
  let n = 1;
  for (let i = runs.length - 2; i >= 0; i--) {
    if (s.unchangedBetween(s.steps[runs[i].stepIdx], s.steps[runs[i + 1].stepIdx]) === "changed") break;
    n++;
  }
  const lv = edge(profile.T2, n, s.scaleOf("T2"));
  if (!lv) return [];
  return emit(e, ctx, "T2", lv, `本轮在两次之间没有新编辑的情况下已运行 ${n} 次全量测试；改动相关的单个测试通常足够。`, {
    key: `T2:${s.turn}:${n}`,
    detail: { fullRunsWithoutEdit: n },
  });
};

function guessTests(file: string): string[] {
  const m = /^(.*?)([^/]+)\.(py|ts|tsx|js|jsx|go|rs)$/.exec(file);
  if (!m) return [];
  const [, dir, base, ext] = m;
  if (ext === "py") return [`tests/test_${base}.py`, `${dir}test_${base}.py`];
  if (ext === "go") return [`${dir}${base}_test.go`];
  if (ext === "rs") return [];
  return [`${dir}${base}.test.${ext}`, `${dir}__tests__/${base}.test.${ext}`];
}

export const T3: Detector = (e, ctx) => {
  if (e.phase !== "post" || ruleDisabled(ctx, "T3")) return [];
  const { s, profile } = ctx;
  const cur = s.last();
  if (!cur || cur.seq !== e.seq || cur.cls !== "test_full" || s.fired.has("T3")) return [];
  const edited = [...new Set(s.turnSteps.filter((x) => x.isEdit).flatMap((x) => x.editedFiles))];
  if (edited.length === 0) return [];
  const tests = edited.filter(isTestPath);
  const cands = tests.length ? tests : edited.flatMap(guessTests);
  if (cands.length === 0) return [];
  const lv = ladderLevel(profile.T3, 1, 1);
  if (!lv) return [];
  s.fired.add("T3");
  return emit(e, ctx, "T3", lv, `本轮改动了 ${edited.slice(0, 3).map((f) => s.rel(f)).join("、")}；可以只跑相关的测试，例如 ${cands.slice(0, 2).join("、")}。`, {
    key: "T3",
    detail: { edited: edited.slice(0, 5), candidates: cands.slice(0, 3) },
  });
};

export const T4: Detector = (e, ctx) => {
  if (e.phase !== "post" || ruleDisabled(ctx, "T4")) return [];
  const { s, profile } = ctx;
  const cur = s.last();
  if (!cur || cur.seq !== e.seq || cur.cls !== "probe") return [];
  const n = s.turnSteps.filter((x) => x.cls === "probe").length;
  const lv = edge(profile.T4, n, s.scaleOf("T4"));
  if (!lv) return [];
  return emit(e, ctx, "T4", lv, `本轮已运行 ${n} 次一次性探测脚本（python -c / node -e 等）；这些检查可以合并成一个测试。`, { key: `T4:${s.turn}:${n}`, detail: { probes: n } });
};

export const T5: Detector = (e, ctx) => {
  if (e.phase !== "post" || ruleDisabled(ctx, "T5")) return [];
  const { s, profile } = ctx;
  const cur = s.last();
  if (!cur || cur.seq !== e.seq || cur.cls !== "smoke_script") return [];
  const scripts = new Set(s.turnSteps.filter((x) => x.cls === "smoke_script").map((x) => x.ev.shell?.scriptPath ?? s.analyze(x.ev.shell?.cmd ?? "").scriptPath ?? x.argsHash));
  const n = scripts.size;
  const lv = edge(profile.T5, n, s.scaleOf("T5"));
  if (!lv) return [];
  return emit(e, ctx, "T5", lv, `修复之后已新建并运行 ${n} 个验证脚本；建议先把功能做完，不要继续搭验证基建。`, { key: `T5:${s.turn}:${n}`, detail: { scripts: [...scripts].slice(0, 5) } });
};

export const T6: Detector = (e, ctx) => {
  if (e.phase !== "post" || ruleDisabled(ctx, "T6")) return [];
  const { s, profile } = ctx;
  const cur = s.last();
  if (!cur || cur.seq !== e.seq || cur.cls !== "http_smoke") return [];
  const runs = s.turnSteps.filter((x) => x.cls === "http_smoke" && x.normCmd === cur.normCmd);
  let n = 1;
  for (let i = runs.length - 2; i >= 0; i--) {
    if (s.unchangedBetween(runs[i], runs[i + 1]) === "changed") break;
    n++;
  }
  const lv = edge(profile.T6, n, s.scaleOf("T6"));
  if (!lv) return [];
  return emit(e, ctx, "T6", lv, `工作区没有变化，同一个 localhost 请求（${short(cur.normCmd ?? "")}）已重复 ${n} 次。`, { key: `T6:${cur.normCmd}:${n}`, detail: { repeats: n } });
};

const FANCY_RE = /(-p\s+(random|randomly|no:randomly)|--random-order|--randomly-seed|--reverse|--count[= ]([2-9]|\d\d)|-count=([2-9]|\d\d)|--shuffle|-shuffle|--repeat|--rerun-each|--runs[= ]\d)/;

export const T7: Detector = (e, ctx) => {
  if (e.phase !== "post" || !e.shell || ruleDisabled(ctx, "T7")) return [];
  const { s, profile } = ctx;
  const cur = s.last();
  if (!cur || cur.seq !== e.seq || (cur.cls !== "test_full" && cur.cls !== "test_targeted") || !FANCY_RE.test(e.shell.cmd)) return [];
  const n = s.turnSteps.filter((x) => (x.cls === "test_full" || x.cls === "test_targeted") && FANCY_RE.test(x.ev.shell?.cmd ?? "")).length;
  const lv = edge(profile.T7, n, s.scaleOf("T7"));
  if (!lv) return [];
  return emit(e, ctx, "T7", lv, "测试命令带了随机顺序、反序或重复运行参数；这类花样运行通常不是当前任务需要的。", { key: `T7:${s.turn}:${n}`, detail: { runs: n } });
};

export const T8: Detector = (e, ctx) => {
  if (e.phase !== "post" || !e.tool || ruleDisabled(ctx, "T8")) return [];
  const { s, profile } = ctx;
  const cur = s.last();
  if (!cur || cur.seq !== e.seq || cur.neutral) return [];
  const turn = s.turnSteps.filter((x) => !x.neutral);
  const isV = (x: Step) => !!x.cls && VERIFY_LIKE.has(x.cls);
  const v = turn.filter(isV).length;
  const lvAt = (vv: number, nn: number) => (nn > 0 && vv / nn > 0.5 ? ladderLevel(profile.T8, vv, s.scaleOf("T8")) : null);
  const now = lvAt(v, turn.length);
  const prev = lvAt(v - (isV(cur) ? 1 : 0), turn.length - 1);
  if (!now || now === prev) return [];
  return emit(e, ctx, "T8", now, `本轮 ${turn.length} 次调用里有 ${v} 次是验证类（测试、探测、构建等），超过一半。`, { key: `T8:${s.turn}:${now}`, detail: { verify: v, total: turn.length } });
};

/** GPT 档每轮预算：全量测试 ≤2、验证类合计 ≤12；超出进入 M。 */
export const TB: Detector = (e, ctx) => {
  if (e.phase !== "post" || !e.tool || ruleDisabled(ctx, "T")) return [];
  const { s, profile } = ctx;
  const cur = s.last();
  if (!cur || cur.seq !== e.seq) return [];
  const out: Hit[] = [];
  const fullLimit = profile.full_tests_per_turn;
  if (fullLimit !== undefined && cur.cls === "test_full") {
    const n = s.turnSteps.filter((x) => x.cls === "test_full").length;
    if (n === fullLimit + 1) out.push(...emit(e, ctx, "TB", "M", `本轮全量测试已超过预算（${fullLimit} 次）。`, { key: `TB:full:${s.turn}`, detail: { fullTests: n, limit: fullLimit } }));
  }
  const vLimit = profile.verify_calls_per_turn;
  if (vLimit !== undefined && cur.cls && VERIFY_LIKE.has(cur.cls)) {
    const n = s.turnSteps.filter((x) => x.cls && VERIFY_LIKE.has(x.cls)).length;
    if (n === vLimit + 1) out.push(...emit(e, ctx, "TB", "M", `本轮验证类调用已超过预算（${vLimit} 次）。`, { key: `TB:verify:${s.turn}`, detail: { verifyCalls: n, limit: vLimit } }));
  }
  return out;
};

export const gptDetectors: Detector[] = [T1, T2, T3, T4, T5, T6, T7, T8, TB];
