import { describe, expect, test } from "bun:test";
import { planStopContinue, runStopContinue, type StopPlanState } from "../src/stop.ts";

const st = (o: Partial<StopPlanState> = {}): StopPlanState => ({ turn: 1, continuedTurns: new Set(), lastUserIsSupervisor: false, totalContinues: 0, gateOpen: true, ...o });
const d = { kind: "stop_continue" as const, text: "最后一次编辑之后没有运行过相关测试。" };

describe("OpenCode 收尾续跑（实验性，未接线）", () => {
  test("闸门开：给出 session.prompt 的参数（queue）；闸门关（核实前的默认）：只返回 would_continue，不给 prompt", () => {
    expect(planStopContinue(d, "s1", st())).toEqual({ action: "continue", text: d.text, prompt: { sessionID: "s1", text: d.text, delivery: "queue" } });
    expect(planStopContinue(d, "s1", st({ gateOpen: false }))).toEqual({ action: "would_continue", text: d.text });
  });
  test("只处理 stop_continue；空文本、没有 delivery 都不动", () => {
    for (const kind of ["block", "ask", "advise"] as const) expect(planStopContinue({ kind, text: "x" }, "s1", st()).action).toBe("none");
    expect(planStopContinue(null, "s1", st()).action).toBe("none");
    expect(planStopContinue({ kind: "stop_continue", text: "  " }, "s1", st()).action).toBe("none");
  });
  test("护栏：每轮最多续跑一次；最近一条 user 消息是 supervisor 注入的不再叠加；会话内总数有上限", async () => {
    const s = st();
    const calls: unknown[] = [];
    const session = { prompt: (a: unknown) => void calls.push(a) };
    expect(await runStopContinue(planStopContinue(d, "s1", s), session, s)).toBe(true);
    expect(planStopContinue(d, "s1", s)).toMatchObject({ action: "none", reason: "这一轮已经续跑过" });
    s.turn = 2;
    expect(planStopContinue(d, "s1", { ...s, lastUserIsSupervisor: true })).toMatchObject({ action: "none" });
    expect(await runStopContinue(planStopContinue(d, "s1", s), session, s)).toBe(true);
    s.turn = 3;
    expect(await runStopContinue(planStopContinue(d, "s1", s), session, s)).toBe(true);
    s.turn = 4;
    expect(planStopContinue(d, "s1", s)).toMatchObject({ action: "none", reason: "会话内续跑次数已达上限" });
    expect(calls.length).toBe(3);
  });
  test("消息截断到 ≤600 字符，prompt 里的就是截断后的（登记 origin 用同一个字符串）", () => {
    const p = planStopContinue({ kind: "stop_continue", text: "字".repeat(900) }, "s1", st());
    expect(p.action).toBe("continue");
    if (p.action === "continue") {
      expect(p.text.length).toBe(600);
      expect(p.prompt.text).toBe(p.text);
    }
  });
  test("fail-open：session.prompt 不存在 / 抛异常 / 返回 rejected promise → 不抛、返回 false", async () => {
    const boom = () => {
      throw new Error("boom");
    };
    for (const session of [undefined, {}, { prompt: boom }, { prompt: () => Promise.reject(new Error("x")) }]) {
      const s = st();
      await expect(runStopContinue(planStopContinue(d, "s1", s), session as never, s)).resolves.toBe(false);
    }
  });
  test("闸门关时 runStopContinue 什么都不发", async () => {
    const calls: unknown[] = [];
    const s = st({ gateOpen: false });
    expect(await runStopContinue(planStopContinue(d, "s1", s), { prompt: (a) => void calls.push(a) }, s)).toBe(false);
    expect(calls).toEqual([]);
    expect(s.totalContinues).toBe(0);
  });
});
