// 停滞 / 迷路：S1–S4（design §5.2）。
import { VERIFY_LIKE, type Step } from "../session.ts";
import { mkHit, ruleDisabled, type Detector } from "./types.ts";

function trailingReadOnly(steps: Step[]): { n: number; seqs: number[] } {
  let n = 0;
  const seqs: number[] = [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const st = steps[i];
    if (st.neutral) continue;
    if (!st.readOnly) break;
    n++;
    seqs.push(st.seq);
  }
  return { n, seqs: seqs.reverse() };
}

export const S1: Detector = (e, ctx) => {
  if (e.phase !== "post" || !e.tool || ruleDisabled(ctx, "S1")) return [];
  const { s, th } = ctx;
  const cur = s.last();
  if (!cur || cur.seq !== e.seq || !cur.readOnly) return [];
  const { n, seqs } = trailingReadOnly(s.turnSteps);
  const need = Math.ceil(th.S1_readonly * s.scaleOf("S1"));
  if (n > 0 && n % need === 0) {
    const beforeFirstEdit = s.firstEditStepIdx < 0;
    return [
      mkHit(e, ctx, {
        ruleId: "S1",
        sev: beforeFirstEdit ? "L" : "M", // 会话里第一次编辑之前只记 L
        category: "stagnation",
        key: `S1:${seqs[0]}:${n}`,
        evidence: seqs.slice(-need),
        detail: { streak: n, beforeFirstEdit },
        message: beforeFirstEdit ? undefined : `已连续 ${n} 步只读取或搜索，没有编辑、构建或测试。`,
      }),
    ];
  }
  return [];
};

type Phase = "explore" | "edit" | "verify" | "other";
const phaseOf = (st: Step): Phase => (st.isEdit ? "edit" : st.readOnly ? "explore" : st.cls && VERIFY_LIKE.has(st.cls) ? "verify" : "other");

/** S2 第一阶段只在回放中观察，不上线。 */
export const S2: Detector = (e, ctx) => {
  if (e.phase !== "post" || !e.tool || ruleDisabled(ctx, "S2")) return [];
  const { s } = ctx;
  const cur = s.last();
  if (!cur || cur.seq !== e.seq || cur.neutral) return [];
  const ph = phaseOf(cur);
  let n = 0;
  for (let i = s.steps.length - 1; i >= 0; i--) {
    const st = s.steps[i];
    if (st.neutral) continue;
    if (phaseOf(st) !== ph) break;
    n++;
  }
  if (n === 7) {
    return [mkHit(e, ctx, { ruleId: "S2", sev: "L", category: "stagnation", key: `S2:${ph}:${cur.seq}`, observeOnly: true, detail: { phase: ph, streak: n } })];
  }
  return [];
};

export const S3: Detector = (e, ctx) => {
  if (e.phase !== "post" || !e.tool || ruleDisabled(ctx, "S3")) return [];
  const { s, cfg } = ctx;
  const cur = s.last();
  if (!cur || cur.seq !== e.seq || s.lastEditStepIdx < 0 || cur.isEdit) return [];
  const calls = s.steps.slice(s.lastEditStepIdx + 1).filter((x) => x.status !== "pending" && !x.neutral).length;
  const elapsedMin = (e.ts - s.lastOkEditTs) / 60000;
  const needMin = cfg.detect.s3_minutes * s.scaleOf("S3");
  const needCalls = Math.ceil(cfg.detect.s3_calls * s.scaleOf("S3"));
  if (elapsedMin < needMin || calls < needCalls) return [];
  // 边沿触发：上一步时条件还不成立
  const prev = s.steps[cur.idx - 1];
  const prevCalls = calls - 1;
  const prevElapsed = prev ? (prev.ts - s.lastOkEditTs) / 60000 : 0;
  if (prev && prev.idx > s.lastEditStepIdx && prevElapsed >= needMin && prevCalls >= needCalls) return [];
  return [
    mkHit(e, ctx, {
      ruleId: "S3",
      sev: "M",
      category: "stagnation",
      key: `S3:${s.lastEditStepIdx}`,
      detail: { minutes: Math.round(elapsedMin), calls },
      message: `距上次成功编辑已过 ${Math.round(elapsedMin)} 分钟、${calls} 次调用，没有新的编辑。`,
    }),
  ];
};

export const S4: Detector = (e, ctx) => {
  if (e.phase !== "post" || !e.tool || e.tool.kind !== "agent" || ruleDisabled(ctx, "S4")) return [];
  const { s } = ctx;
  const turnAgents = s.turnSteps.filter((x) => x.kind === "agent");
  const out = [];
  if (turnAgents.length === Math.ceil(15 * s.scaleOf("S4"))) {
    out.push(mkHit(e, ctx, { ruleId: "S4", sev: "M", category: "stagnation", key: `S4:count:${s.turn}`, detail: { subagents: turnAgents.length }, message: `自上次用户消息起已启动 ${turnAgents.length} 个子 agent。` }));
  }
  const empty = (x: Step) => (x.ev.result?.outputHead.length ?? 0) + (x.ev.result?.outputTail.length ?? 0) < 20;
  let run = 0;
  for (let i = turnAgents.length - 1; i >= 0 && empty(turnAgents[i]); i--) run++;
  if (run === 3) {
    out.push(mkHit(e, ctx, { ruleId: "S4", sev: "M", category: "stagnation", key: `S4:empty:${s.turn}:${turnAgents.length}`, detail: { emptyRun: run }, message: "连续 3 个子 agent 没有产出内容。" }));
  }
  return out;
};

export const stallDetectors: Detector[] = [S1, S2, S3, S4];
