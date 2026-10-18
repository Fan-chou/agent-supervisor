import type { Category, Hit } from "../detectors/types.ts";
import type { SessionTracker } from "../session.ts";

export type Verdict = "ignore" | "advise" | "block";

export interface JudgeWatch {
  rule: string;
  text_contains: string | null;
  tool: string | null;
  ttl_steps: number;
}

/** design §8.4 的输出 schema。 */
export interface JudgeOutput {
  verdict: Verdict;
  confidence: number;
  category: Category;
  message_to_agent: string | null;
  reason: string;
  evidence_steps: number[];
  watch: JudgeWatch[];
  done: boolean;
}

export interface JudgeRequest {
  hits: Hit[];
  /** 同步调用（H 级 pre 阶段）用快超时。 */
  sync: boolean;
  session: SessionTracker;
  /** 提示写法 A/B（M2）。 */
  promptStyle?: "recall" | "ignore_default";
}

/** 一次 judge 调用的可观测信息（日志 judge_calls 表用）；请求/响应正文均已脱敏。 */
export interface JudgeMeta {
  latencyMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  costUsd?: number;
  /** 解析失败后的重试次数（0/1）。 */
  retries?: number;
  /** 最终使用的 response_format 等级（json_schema / json_object / none）。 */
  formatLevel?: string;
  /** 因为上游拒绝 response_format 而降过级。 */
  formatDowngraded?: boolean;
  repairs?: string[];
  /** 路由选中的 model（=model，除非以后有回退）。 */
  routeModel?: string;
  requestBody?: string;
  responseBody?: string;
  httpRequests?: number;
}

export type JudgeResult =
  | { kind: "ok"; out: JudgeOutput; model?: string; parseFail?: false; meta?: JudgeMeta }
  | { kind: "parse_fail"; model?: string; raw?: string; meta?: JudgeMeta }
  | { kind: "timeout"; model?: string; meta?: JudgeMeta }
  | { kind: "error"; error: string; model?: string; meta?: JudgeMeta };

export type JudgeFn = (req: JudgeRequest) => Promise<JudgeResult>;
