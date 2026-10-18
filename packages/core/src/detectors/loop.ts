// 循环 / 重复：L1–L6（design §5.1）。
import type { Event } from "../event.ts";
import type { Step } from "../session.ts";
import { mkHit, ruleDisabled, type Detector, type Hit } from "./types.ts";

const POLL_RE = /^(git (status|log|diff)\b|gh run (view|watch)\b|ls\b|ps\b|sleep \d+ && tail\b|curl .*(health|ping|status|ready)|tail -f\b)/;

const short = (s: string, n = 80) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function sameCallSteps(ctx: Parameters<Detector>[1], argsHash: string): Step[] {
  const { s } = ctx;
  return s.steps.filter((x) => x.argsHash === argsHash && x.idx >= s.loopFloor && x.status !== "pending");
}

/** 从后往前数「连续失败、指纹相同、期间无改动」的链长（不含 current）。 */
function failChain(ctx: Parameters<Detector>[1], list: Step[], errFp: string | undefined): { n: number; verified: boolean } {
  let n = 0;
  let verified = true;
  for (let i = list.length - 1; i >= 0; i--) {
    const cur = list[i];
    if (cur.status !== "fail" || !cur.errFp || cur.errFp !== errFp) break;
    if (i < list.length - 1) {
      const u = ctx.s.unchangedBetween(cur, list[i + 1]);
      if (u === "changed") break;
      if (u !== "verified") verified = false;
    }
    n++;
  }
  return { n, verified };
}

export const L1: Detector = (e: Event, ctx) => {
  if (ruleDisabled(ctx, "L1") || !e.tool) return [];
  const { s, th } = ctx;
  if (e.phase === "post") {
    const cur = s.last();
    if (!cur || cur.seq !== e.seq || cur.status !== "fail" || !cur.errFp) return [];
    const list = sameCallSteps(ctx, cur.argsHash);
    const { n, verified } = failChain(ctx, list, cur.errFp);
    const need = Math.ceil(th.L1_advise * s.scaleOf("L1"));
    if (n >= need) {
      return [
        mkHit(e, ctx, {
          ruleId: "L1",
          sev: "M",
          category: "loop",
          key: `L1:${cur.argsHash}:${cur.errFp}`,
          evidence: list.slice(-n).map((x) => x.seq),
          verified,
          detail: { count: n, cmd: cur.normCmd ?? cur.name },
          message: `同一调用已连续失败 ${n} 次，错误指纹相同，且两次之间工作区没有变化（${short(cur.normCmd ?? cur.name)}）。`,
        }),
      ];
    }
    return [];
  }
  if (e.phase === "pre") {
    const list = sameCallSteps(ctx, e.tool.argsHash);
    const last = list[list.length - 1];
    if (!last || last.status !== "fail" || !last.errFp) return [];
    const { n, verified } = failChain(ctx, list, last.errFp);
    const u = s.unchangedBetween(last, { verBefore: s.version, ev: e });
    if (u === "changed") return [];
    const need = Math.ceil(th.L1_block_after * s.scaleOf("L1"));
    if (n >= need) {
      return [
        mkHit(e, ctx, {
          ruleId: "L1",
          sev: "H",
          category: "loop",
          blockable: true,
          verified: verified && u === "verified",
          key: `L1H:${e.tool.argsHash}:${last.errFp}`,
          evidence: list.slice(-n).map((x) => x.seq),
          detail: { count: n + 1, cmd: last.normCmd ?? last.name },
          message: `这条调用（${short(last.normCmd ?? last.name)}）已连续失败 ${n} 次，错误相同，工作区自上次运行以来没有变化。`,
        }),
      ];
    }
  }
  return [];
};

export const L2: Detector = (e, ctx) => {
  if (e.phase !== "post" || !e.tool || ruleDisabled(ctx, "L2")) return [];
  const { s, th } = ctx;
  const cur = s.last();
  if (!cur || cur.seq !== e.seq || !cur.outHash || cur.status === "pending" || cur.neutral) return [];
  const lo = Math.max(s.loopFloor, cur.idx - (th.L2_window - 1));
  const same = s.steps.filter((x) => x.idx >= lo && x.argsHash === cur.argsHash && x.outHash === cur.outHash);
  const poll = cur.normCmd ? POLL_RE.test(cur.normCmd) : false;
  const n = same.length;
  if (poll) {
    // L2a：轮询类白名单，≥8 次才记 L
    return n === Math.ceil(th.L2a_repeat * s.scaleOf("L2")) ? [mkHit(e, ctx, { ruleId: "L2a", sev: "L", category: "loop", key: `L2a:${cur.argsHash}`, evidence: same.map((x) => x.seq), detail: { count: n } })] : [];
  }
  const need = Math.ceil(th.L2_repeat * s.scaleOf("L2"));
  if (n === need) {
    return [
      mkHit(e, ctx, {
        ruleId: "L2",
        sev: "M",
        category: "loop",
        key: `L2:${cur.argsHash}:${cur.outHash}`,
        evidence: same.map((x) => x.seq),
        detail: { count: n, cmd: cur.normCmd ?? cur.name },
        message: `最近 ${th.L2_window} 步内同一调用（${short(cur.normCmd ?? cur.name)}）已执行 ${n} 次，输出完全相同。`,
      }),
    ];
  }
  return [];
};

export const L3: Detector = (e, ctx) => {
  if (e.phase !== "post" || !e.tool || ruleDisabled(ctx, "L3")) return [];
  const { s, th } = ctx;
  const cur = s.last();
  if (!cur || cur.seq !== e.seq || cur.status !== "fail" || !cur.errFp) return [];
  const lo = Math.max(s.loopFloor, cur.idx - (th.L3_window - 1));
  const same = s.steps.filter((x) => x.idx >= lo && x.status === "fail" && x.errFp === cur.errFp);
  const need = Math.ceil(th.L3_repeat * s.scaleOf("L3"));
  if (same.length === need) {
    return [
      mkHit(e, ctx, {
        ruleId: "L3",
        sev: "M",
        category: "loop",
        key: `L3:${cur.errFp}`,
        evidence: same.map((x) => x.seq),
        detail: { count: same.length },
        message: `最近 ${th.L3_window} 步内同一个错误已出现 ${same.length} 次（命令不一定相同）。`,
      }),
    ];
  }
  return [];
};

/** 内容哈希序列里「回到之前出现过的值」的次数。 */
export function oscillationReturns(hashes: string[]): number {
  let returns = 0;
  for (let k = 2; k < hashes.length; k++) {
    if (hashes[k] === hashes[k - 1]) continue;
    if (hashes.slice(0, k - 1).includes(hashes[k])) returns++;
  }
  return returns;
}

export const L4: Detector = (e, ctx) => {
  if (e.phase !== "post" || ruleDisabled(ctx, "L4")) return [];
  const { s, th } = ctx;
  const cur = s.last();
  if (!cur || cur.seq !== e.seq || !cur.isEdit) return [];
  const out: Hit[] = [];
  for (const f of cur.editedFiles) {
    const st = s.edits.get(f);
    if (!st) continue;
    const r = oscillationReturns(st.hashes);
    if (r === Math.ceil(th.L4_returns * s.scaleOf("L4"))) {
      out.push(
        mkHit(e, ctx, {
          ruleId: "L4",
          sev: "M",
          category: "loop",
          key: `L4:${f}`,
          detail: { file: f, returns: r },
          message: `${s.rel(f)} 的内容已 ${r} 次回到之前出现过的版本（来回修改）。`,
        }),
      );
    }
  }
  return out;
};

export const L5: Detector = (e, ctx) => {
  if (e.phase !== "post" || ruleDisabled(ctx, "L5")) return [];
  const { s, cfg } = ctx;
  const cur = s.last();
  if (!cur || cur.seq !== e.seq || !cur.isEdit) return [];
  const out: Hit[] = [];
  for (const f of cur.editedFiles) {
    const st = s.edits.get(f);
    if (!st || st.lastEditStepIdx !== cur.idx) continue;
    const n = st.segmentsSinceVerify;
    const lo = Math.ceil(cfg.detect.l5_segments_L * s.scaleOf("L5"));
    const mid = Math.ceil(cfg.detect.l5_segments_M * s.scaleOf("L5"));
    if (n === lo || n === mid) {
      out.push(
        mkHit(e, ctx, {
          ruleId: "L5",
          sev: n >= mid ? "M" : "L",
          category: "loop",
          key: `L5:${f}:${n >= mid ? "M" : "L"}`,
          detail: { file: f, segments: n },
          message: n >= mid ? `${s.rel(f)} 已分 ${n} 段反复修改，期间没有一次成功的测试/构建。` : undefined,
        }),
      );
    }
  }
  return out;
};

export const L6: Detector = (e, ctx) => {
  if (e.phase !== "post" || ruleDisabled(ctx, "L6")) return [];
  const { s, th } = ctx;
  const cur = s.last();
  if (!cur || cur.seq !== e.seq || cur.readFiles.length === 0) return [];
  const out: Hit[] = [];
  for (const f of new Set(cur.readFiles)) {
    if ((s.readsSinceEdit.get(f) ?? 0) === Math.ceil(th.L6_reads * s.scaleOf("L6"))) {
      out.push(mkHit(e, ctx, { ruleId: "L6", sev: "L", category: "loop", key: `L6:${f}`, detail: { file: f } }));
    }
  }
  return out;
};

export const loopDetectors: Detector[] = [L1, L2, L3, L4, L5, L6];
