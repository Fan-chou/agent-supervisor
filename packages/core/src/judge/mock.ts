// 确定性 mock judge：回放 --judge=mock 和测试用。不发网络请求。
import type { Hit } from "../detectors/types.ts";
import type { JudgeFn, JudgeOutput, JudgeRequest, JudgeResult, Verdict } from "./types.ts";

export interface MockRule {
  verdict: Verdict;
  confidence?: number;
  done?: boolean;
}

export interface MockOptions {
  /** 按规则 ID 覆盖结果；未覆盖的走默认表。 */
  rules?: Record<string, MockRule>;
  /** 强制返回非 ok 结果，测试 fail-open 用。 */
  failWith?: "timeout" | "error" | "parse_fail";
  /** 记录收到的请求，供断言。 */
  calls?: JudgeRequest[];
}

/** 默认表：多数规则 advise；噪声大的 ignore；同步 H 级且指纹核实过的 block。 */
const DEFAULTS: Record<string, MockRule> = {
  L2a: { verdict: "ignore" },
  R3: { verdict: "ignore" },
  R4: { verdict: "ignore", done: true },
  P4: { verdict: "ignore" },
  S3: { verdict: "advise", confidence: 0.6 },
  L4: { verdict: "advise", confidence: 0.7 },
};

export function mockJudge(opts: MockOptions = {}): JudgeFn {
  return async (req: JudgeRequest): Promise<JudgeResult> => {
    opts.calls?.push(req);
    if (opts.failWith === "timeout") return { kind: "timeout", model: "mock" };
    if (opts.failWith === "error") return { kind: "error", error: "mock error", model: "mock" };
    if (opts.failWith === "parse_fail") return { kind: "parse_fail", model: "mock", raw: "not json" };
    // 取最严重的命中作为主要依据
    const order = { H: 0, M: 1, L: 2 } as const;
    const hit: Hit = [...req.hits].sort((a, b) => order[a.sev] - order[b.sev])[0];
    const rule = opts.rules?.[hit.ruleId] ?? DEFAULTS[hit.ruleId];
    let verdict: Verdict;
    let confidence: number;
    let done = false;
    if (rule) {
      verdict = rule.verdict;
      confidence = rule.confidence ?? 0.9;
      done = rule.done ?? false;
    } else if (hit.sev === "H" && req.sync) {
      verdict = hit.verified ? "block" : "advise";
      confidence = 0.9;
    } else {
      verdict = "advise";
      confidence = 0.75;
    }
    const out: JudgeOutput = {
      verdict,
      confidence,
      category: hit.category,
      message_to_agent: verdict === "ignore" ? null : (hit.message ?? `规则 ${hit.ruleId} 命中，请先确认当前做法是否仍在推进任务。`),
      reason: `mock:${hit.ruleId}`,
      evidence_steps: hit.evidence,
      watch: [],
      done,
    };
    return { kind: "ok", out, model: "mock" };
  };
}
