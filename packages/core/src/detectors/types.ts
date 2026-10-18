import type { Config, Profile } from "../config.ts";
import type { Event } from "../event.ts";
import type { SessionTracker } from "../session.ts";

export type Sev = "L" | "M" | "H";
export type Category = "loop" | "stagnation" | "over_testing" | "scope" | "premature_done" | "test_gaming" | "drift" | "unsafe" | "other";

export interface Hit {
  ruleId: string;
  sev: Sev;
  category: Category;
  seq: number;
  ts: number;
  sessionId: string;
  /** 命中时事件的 phase；H 级只有 pre 才能拦截。 */
  phase: Event["phase"];
  /** 本地预设的建议（事实陈述口吻，≤600 字符）。L 级带 message 即「本地 advise」。 */
  message?: string;
  evidence: number[];
  detail?: Record<string, unknown>;
  /** 去重/冷却用的键：规则 + 指纹。 */
  key: string;
  /** 在 pre 阶段可以拦截。 */
  blockable?: boolean;
  /** 显式规则（X2、plan.md 里写了 allow 的 P1）：本地直接拦，不问 judge，不受连续拦截上限约束。 */
  explicit?: boolean;
  /** 工作区「没改动」是否经指纹核实（回放里通常是 false，只是由事件推断）。 */
  verified?: boolean;
  /** 只在回放里观察，不上线（S2）。 */
  observeOnly?: boolean;
  /** X2 的 ask/deny 以及原因。 */
  x2?: { action: "deny" | "ask"; category: string };
}

export interface DetectCtx {
  s: SessionTracker;
  cfg: Config;
  profile: Profile;
}

export type Detector = (e: Event, ctx: DetectCtx) => Hit[];

export function mkHit(e: Event, ctx: DetectCtx, h: Omit<Hit, "seq" | "ts" | "sessionId" | "phase" | "key" | "evidence"> & { key?: string; evidence?: number[] }): Hit {
  return {
    seq: e.seq,
    ts: e.ts,
    sessionId: e.sessionId,
    phase: e.phase,
    evidence: h.evidence ?? [e.seq],
    key: h.key ?? h.ruleId,
    ...h,
  };
}

export function ruleDisabled(ctx: DetectCtx, id: string): boolean {
  const r = Object.entries(ctx.cfg.rules).find(([k]) => k === id || k.startsWith(id + "_"));
  return !!r && (r[1].disabled === true || r[1].action === "off");
}
