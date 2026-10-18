// 资源：R1–R3（design §5.6）。R4（定期抽查）在 engine 里做，因为它需要知道「没有其他触发」。
import { mkHit, ruleDisabled, type Detector } from "./types.ts";

export const R1: Detector = (e, ctx) => {
  if (e.phase !== "post" || !e.tool || ruleDisabled(ctx, "R1")) return [];
  const { s, cfg } = ctx;
  const n = s.turnSteps.filter((x) => !x.neutral).length;
  const need = Math.ceil(cfg.detect.r1_calls * s.scaleOf("R1"));
  if (n > 0 && n % need === 0) {
    return [mkHit(e, ctx, { ruleId: "R1", sev: "M", category: "stagnation", key: `R1:${s.turn}:${n}`, detail: { calls: n }, message: `自上次用户消息起已发起 ${n} 次工具调用。` })];
  }
  return [];
};

export const R2: Detector = (e, ctx) => {
  if (!e.usage || ruleDisabled(ctx, "R2")) return [];
  const { s, cfg, th } = ctx;
  const budget = cfg.detect.session_budget_usd;
  if (!budget || !s.usage.hasCost) return []; // 取不到就跳过
  const ratio = s.usage.costUsd / budget;
  const level = ratio >= th.R2_limit ? "M" : ratio >= th.R2_warn ? "L" : null;
  if (!level) return [];
  const flag = `R2:${level}`;
  if (s.fired.has(flag)) return [];
  s.fired.add(flag);
  return [mkHit(e, ctx, { ruleId: "R2", sev: level, category: "stagnation", key: flag, detail: { ratio: Math.round(ratio * 100) / 100, costUsd: s.usage.costUsd }, message: level === "M" ? `会话花费已达预算的 ${Math.round(ratio * 100)}%。` : undefined })];
};

export const R3: Detector = (e, ctx) => {
  if (!e.usage || ruleDisabled(ctx, "R3")) return [];
  const { s, cfg, th } = ctx;
  const ratio = s.usage.contextTokens / cfg.detect.context_window;
  if (ratio < th.R3_ratio || s.fired.has("R3")) return [];
  s.fired.add("R3");
  return [mkHit(e, ctx, { ruleId: "R3", sev: "L", category: "stagnation", key: "R3", detail: { ratio: Math.round(ratio * 100) / 100 } })];
};

export const resourceDetectors: Detector[] = [R1, R2, R3];
