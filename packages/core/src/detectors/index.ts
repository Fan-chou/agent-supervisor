import type { Event } from "../event.ts";
import { cheatDetectors } from "./cheat.ts";
import { gptDetectors } from "./gpt.ts";
import { loopDetectors } from "./loop.ts";
import { resourceDetectors } from "./resource.ts";
import { scopeDetectors } from "./scope.ts";
import { stallDetectors } from "./stall.ts";
import type { DetectCtx, Detector, Hit } from "./types.ts";

export * from "./types.ts";
export * from "./loop.ts";
export * from "./stall.ts";
export * from "./scope.ts";
export * from "./cheat.ts";
export * from "./resource.ts";
export * from "./gpt.ts";

export const ALL_DETECTORS: Detector[] = [...cheatDetectors, ...loopDetectors, ...stallDetectors, ...scopeDetectors, ...gptDetectors, ...resourceDetectors];

/** 对一条事件运行全部检测器（事件已经 ingest 进 tracker）。 */
export function detectAll(e: Event, ctx: DetectCtx, detectors: Detector[] = ALL_DETECTORS): Hit[] {
  const out: Hit[] = [];
  for (const d of detectors) {
    try {
      out.push(...d(e, ctx));
    } catch (err) {
      // 检测器出错不能影响 agent：记成一条 L 级内部错误
      out.push({
        ruleId: "INTERNAL",
        sev: "L",
        category: "other",
        seq: e.seq,
        ts: e.ts,
        sessionId: e.sessionId,
        phase: e.phase,
        evidence: [e.seq],
        key: `INTERNAL:${d.name}`,
        detail: { detector: d.name, error: String(err) },
      });
    }
  }
  return out;
}
