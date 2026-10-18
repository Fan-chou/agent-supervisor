// OpenCode 上「收尾续跑」（Stop 的替代）的研究实现——**实验性，没有接进插件和守护进程，核实前不对外宣称可用**（decisions #90）。
// OpenCode V2 没有 Stop 钩子。设计里的候选做法：在「assistant 这一轮结束」的信号上，用 `session.prompt({ sessionID, text, delivery:"queue" })`
// 把 outbox 里的 stop_continue 作为一条 user 消息排进去（P0-6：这条消息会回显成 user 消息，必须按「实际输出的字符串」登记 origin）。
// 这里只放「该不该发、发什么」的纯函数和防循环护栏，方便在真机核实 session.prompt 的语义之前先把行为用测试钉住。
// 类型已核实（@opencode/client 2.0.32，decisions #115）：①「这一轮结束」= 事件 session.execution.succeeded | failed | interrupted（经 context.event.subscribe 拿到，插件尚未订阅 succeeded）
// ②session.prompt 的入参是平铺的 {sessionID, text, files?, metadata?, delivery?: "steer"|"queue", resume?}，与下面的 prompt 一致。
// 仍未核实（只能真机）：③排队消息会不会被当成新的 user turn（重置「本轮」计数）、session.prompt 何时 resolve。
import { truncate, type Delivery } from "@sv/core";

export interface StopPlanState {
  /** 当前「用户轮次」的编号（真实用户消息才 +1；supervisor 回显不算）。 */
  turn: number;
  /** 已经在哪些轮次续跑过（每轮最多续跑一次，防止 supervisor 和 agent 互相拉扯）。 */
  continuedTurns: Set<number>;
  /** 最近一条 user 消息是不是我们自己注入的（是就不再叠加）。 */
  lastUserIsSupervisor: boolean;
  /** 同一会话内累计续跑次数上限（默认 3）。 */
  totalContinues: number;
  maxTotal?: number;
  /** 守护进程/插件的拦截闸门（核实前恒为 false）：为 false 时只返回 wouldContinue，不返回要发的 prompt。 */
  gateOpen: boolean;
}

export type StopPlan =
  | { action: "none"; reason: string }
  | { action: "would_continue"; text: string }
  | { action: "continue"; text: string; prompt: { sessionID: string; text: string; delivery: "queue" } };

export function planStopContinue(d: Delivery | null | undefined, sessionID: string, st: StopPlanState): StopPlan {
  if (!d || d.kind !== "stop_continue") return { action: "none", reason: "没有 stop_continue" };
  const text = truncate(d.text ?? "");
  if (!text) return { action: "none", reason: "空文本" };
  if (st.lastUserIsSupervisor) return { action: "none", reason: "最近一条 user 消息已经是 supervisor 注入的" };
  if (st.continuedTurns.has(st.turn)) return { action: "none", reason: "这一轮已经续跑过" };
  if (st.totalContinues >= (st.maxTotal ?? 3)) return { action: "none", reason: "会话内续跑次数已达上限" };
  if (!st.gateOpen) return { action: "would_continue", text };
  return { action: "continue", text, prompt: { sessionID, text, delivery: "queue" } };
}

/** 发出 prompt 并更新状态；任何异常（含 prompt 抛错/返回 reject）都吞掉，返回是否发出。调用方要用 `text`（截断后的）登记 origin。 */
export async function runStopContinue(plan: StopPlan, session: { prompt?: (a: unknown) => unknown } | undefined, st: StopPlanState): Promise<boolean> {
  if (plan.action !== "continue") return false;
  try {
    if (typeof session?.prompt !== "function") return false;
    st.continuedTurns.add(st.turn);
    st.totalContinues++;
    await session.prompt(plan.prompt);
    return true;
  } catch {
    return false; // fail-open：发不出去就算了
  }
}
