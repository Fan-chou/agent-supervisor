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

export type JudgeResult =
  | { kind: "ok"; out: JudgeOutput; model?: string; parseFail?: false }
  | { kind: "parse_fail"; model?: string; raw?: string }
  | { kind: "timeout"; model?: string }
  | { kind: "error"; error: string; model?: string };

export type JudgeFn = (req: JudgeRequest) => Promise<JudgeResult>;
