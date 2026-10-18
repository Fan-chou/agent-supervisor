import { describe, expect, test } from "bun:test";
import { LogStore, StoreSink, beginRun, preEvent, defaultConfig, listHits, sessionChildren, sessionEvents, sessionRun, sessionTimeline } from "../src/index.ts";
import { PYTEST_PASS, Sim } from "./sim.ts";

async function build(mode: "shadow" | "enforce" = "shadow") {
  const store = new LogStore(":memory:");
  const cfg = { ...defaultConfig(), mode };
  const runId = beginRun(store, cfg, { kind: "replay", label: "t" });
  const sink = new StoreSink(store, { runId });
  const sim = new Sim({ cfg, sink });
  await sim.start();
  await sim.prompt("请修一下");
  await sim.bash("ls");
  await sim.bash("git reset --hard HEAD~1"); // X2
  for (let i = 0; i < 3; i++) await sim.bash("pytest -q", { out: PYTEST_PASS }); // T1
  await sim.bash("ls -la");
  sink.close();
  const sessionId = (sim as unknown as { sessionId: string }).sessionId;
  return { store, runId, sessionId };
}

describe("sessionTimeline", () => {
  test("调用（pre+post 合并）、事件、命中（带处置）按 seq 升序；危险命中带 outcome", async () => {
    const { store, sessionId, runId } = await build();
    const t = sessionTimeline(store.db, sessionId)!;
    expect(t.runId).toBe(runId);
    expect(t.entries.map((e) => e.seq)).toEqual([...t.entries.map((e) => e.seq)].sort((a, b) => a - b));
    const calls = t.entries.filter((e) => e.type === "call");
    expect(calls.length).toBe(6);
    expect(calls.every((c) => c.type === "call" && c.status !== "pending" && c.postSeq !== null)).toBe(true);
    expect(t.entries.some((e) => e.type === "event" && e.phase === "prompt")).toBe(true);
    const x2 = t.entries.find((e) => e.type === "hit" && e.ruleId === "X2");
    expect(x2).toMatchObject({ dangerous: true, dangerCategory: "git", outcome: "would_have_blocked", applied: false });
    expect(t.hasMore).toBe(false);
  });
  test("limit / since_seq / before_seq：向下取增量、向上翻页；hasMore", async () => {
    const { store, sessionId } = await build();
    const all = sessionTimeline(store.db, sessionId)!.entries;
    const last = all[all.length - 1].seq;
    const head = sessionTimeline(store.db, sessionId, { limit: 5 })!;
    expect(head.entries.length).toBe(5);
    expect(head.hasMore).toBe(true);
    expect(head.entries.map((e) => e.seq)).toEqual(all.slice(0, 5).map((e) => e.seq));
    const tail = sessionTimeline(store.db, sessionId, { beforeSeq: last + 1, limit: 4 })!;
    expect(tail.entries.map((e) => e.seq)).toEqual(all.slice(-4).map((e) => e.seq));
    expect(tail.hasMore).toBe(true);
    const inc = sessionTimeline(store.db, sessionId, { sinceSeq: last - 1 })!;
    expect(inc.entries.every((e) => e.seq > last - 1)).toBe(true);
    expect(sessionTimeline(store.db, sessionId, { sinceSeq: last + 100 })!.entries).toEqual([]);
  });
  test("severity=dangerous / outcome 过滤：只返回命中", async () => {
    const { store, sessionId } = await build();
    const d = sessionTimeline(store.db, sessionId, { severity: "dangerous" })!;
    expect(d.entries.length).toBe(1);
    expect(d.entries[0]).toMatchObject({ type: "hit", ruleId: "X2" });
    expect(sessionTimeline(store.db, sessionId, { outcome: "would_have_blocked" })!.entries.length).toBe(1);
    expect(sessionTimeline(store.db, sessionId, { outcome: "blocked" })!.entries).toEqual([]);
  });
  test("enforce：同一条危险命中的 outcome 是 blocked 且 applied", async () => {
    const { store, sessionId } = await build("enforce");
    const x2 = sessionTimeline(store.db, sessionId)!.entries.find((e) => e.type === "hit" && e.ruleId === "X2");
    expect(x2).toMatchObject({ outcome: "blocked", applied: true });
  });
  test("没有 post 的调用是 pending；不存在的会话 → null", async () => {
    const store = new LogStore(":memory:");
    const runId = beginRun(store, defaultConfig(), { kind: "live" });
    const sink = new StoreSink(store, { runId });
    const sim = new Sim({ cfg: defaultConfig(), sink });
    await sim.start();
    const raw = { harness: "claude" as const, sessionId: "sess-1", toolUseId: "pend-1", name: "Bash", input: { command: "sleep 100" }, ts: 1_700_000_000_000 };
    await sim.engine.feed(preEvent(raw, 99, sim.engine.tracker.opts));
    sink.close();
    const t = sessionTimeline(store.db, "sess-1")!;
    expect(t.entries.find((e) => e.type === "call")).toMatchObject({ status: "pending", postSeq: null, toolUseId: "pend-1" });
    expect(sessionTimeline(store.db, "nope")).toBeNull();
    expect(sessionEvents(store.db, "nope")).toBeNull();
    expect(sessionRun(store.db, "nope")).toBeNull();
  });
});

describe("sessionEvents", () => {
  test("phase / q 过滤、分页；q 里的 % 和 _ 按字面匹配", async () => {
    const { store, sessionId } = await build();
    const pre = sessionEvents(store.db, sessionId, { phase: "pre" })!;
    expect(pre.events.length).toBe(6);
    expect(pre.events.every((e) => e.phase === "pre")).toBe(true);
    expect(sessionEvents(store.db, sessionId, { q: "pytest" })!.events.length).toBeGreaterThan(0);
    expect(sessionEvents(store.db, sessionId, { q: "%" })!.events).toEqual([]);
    const page = sessionEvents(store.db, sessionId, { limit: 3 })!;
    expect(page.events.length).toBe(3);
    expect(page.hasMore).toBe(true);
    expect(sessionEvents(store.db, sessionId, { sinceSeq: page.events[2].seq, limit: 1000 })!.events[0].seq).toBeGreaterThan(page.events[2].seq);
  });
});

describe("listHits", () => {
  test("最新在前、id 游标分页；按规则 / 级别 / severity / 会话 / 结局过滤", async () => {
    const { store, sessionId } = await build();
    const all = listHits(store.db, {}, { limit: 100 });
    expect(all.hits.length).toBeGreaterThan(2);
    expect(all.hits.map((h) => h.id)).toEqual([...all.hits.map((h) => h.id)].sort((a, b) => b - a));
    expect(all.nextCursor).toBeNull();
    const p1 = listHits(store.db, {}, { limit: 2 });
    expect(p1.hits.length).toBe(2);
    expect(p1.nextCursor).toBe(p1.hits[1].id);
    const p2 = listHits(store.db, {}, { limit: 2, cursor: p1.nextCursor! });
    expect(p2.hits[0].id).toBeLessThan(p1.hits[1].id);
    expect(listHits(store.db, {}, { rule: "X2" }).hits.map((h) => h.ruleId)).toEqual(["X2"]);
    expect(listHits(store.db, {}, { severity: "dangerous" }).hits[0]).toMatchObject({ dangerous: true, outcome: "would_have_blocked", applied: false, label: null });
    expect(listHits(store.db, {}, { sev: "H" }).hits.every((h) => h.sev === "H")).toBe(true);
    expect(listHits(store.db, { sessionId: "other" }).hits).toEqual([]);
    expect(listHits(store.db, { sessionId }, { outcome: "would_have_blocked" }).hits.length).toBe(1);
  });
  test("按标注过滤：unlabeled / false_positive / useful", async () => {
    const { store } = await build();
    const hits = listHits(store.db, {}).hits;
    const [a, b] = [hits[0], hits[1]];
    store.mark(a.id, "false_positive");
    store.mark(b.id, "useful");
    expect(listHits(store.db, {}, { label: "false_positive" }).hits.map((h) => h.id)).toEqual([a.id]);
    expect(listHits(store.db, {}, { label: "useful" }).hits.map((h) => h.id)).toEqual([b.id]);
    const un = listHits(store.db, {}, { label: "unlabeled" }).hits;
    expect(un.length).toBe(hits.length - 2);
    expect(listHits(store.db, {}).hits.find((h) => h.id === a.id)!.label).toBe("false_positive");
  });
  test("limit 被夹在 1..500", async () => {
    const { store } = await build();
    expect(listHits(store.db, {}, { limit: 0 }).hits.length).toBe(1);
    expect(listHits(store.db, {}, { limit: 99999 }).hits.length).toBeGreaterThan(0);
  });
});

describe("sessionChildren", () => {
  test("按 parent_session_id 找子会话；没有则空", async () => {
    const { store, sessionId, runId } = await build();
    expect(sessionChildren(store.db, sessionId)).toEqual([]);
    store.db.run("INSERT INTO sessions (run_id, session_id, harness, parent_session_id, started_ts, logged_ts) VALUES (?, 'child-1', 'claude', ?, 1, 1)", [runId, sessionId]);
    expect(sessionChildren(store.db, sessionId).map((r) => r.session_id)).toEqual(["child-1"]);
    expect(sessionChildren(store.db, "nope")).toEqual([]);
  });
});
