import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogStore, Outbox, checkPrecondition, hasInjection, loadInjectionHashes, loadPlan, saveInjection, savePlan, parsePlanMd } from "../src/index.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "sv-outbox-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function fill(ob: Outbox, n: number, session = "s1") {
  for (let i = 0; i < n; i++) ob.enqueue({ sessionId: session, kind: "advise", text: `message ${i}`, deliveryId: `${session}-d${i}`, ruleId: "L1", category: "loop" });
}

describe("outbox 基本语义", () => {
  test("入队去重（deliveryId 唯一）、文本脱敏", () => {
    const store = new LogStore(":memory:");
    const ob = new Outbox(store);
    const id = ob.enqueue({ sessionId: "s", kind: "advise", text: "key sk-abcdefghijklmnopqrstuvwxyz123456 leaked", deliveryId: "d1" });
    expect(id).toBeGreaterThan(0);
    expect(ob.enqueue({ sessionId: "s", kind: "advise", text: "same", deliveryId: "d1" })).toBeNull();
    expect(ob.get(id!)!.text).not.toContain("abcdefghijklmnop");
    expect(store.count("outbox")).toBe(1);
  });
  test("claim 按 id 顺序、按会话隔离、按 kind 过滤；领取后不会被再次领取", () => {
    const store = new LogStore(":memory:");
    const ob = new Outbox(store);
    ob.enqueue({ sessionId: "a", kind: "advise", text: "1", deliveryId: "a1" });
    ob.enqueue({ sessionId: "a", kind: "block", text: "2", deliveryId: "a2" });
    ob.enqueue({ sessionId: "b", kind: "advise", text: "3", deliveryId: "b1" });
    expect(ob.claim({ sessionId: "a", claimer: "x", leaseMs: 1000, kinds: ["block"] })!.text).toBe("2");
    expect(ob.claim({ sessionId: "a", claimer: "y", leaseMs: 1000, kinds: ["block"] })).toBeNull();
    const r = ob.claim({ sessionId: "a", claimer: "x", leaseMs: 1000 })!;
    expect(r).toMatchObject({ text: "1", state: "claimed", claimed_by: "x", attempts: 1 });
    expect(ob.claim({ sessionId: "a", claimer: "x", leaseMs: 1000 })).toBeNull();
    expect(ob.claim({ sessionId: "b", claimer: "x", leaseMs: 1000 })!.text).toBe("3");
  });
  test("markDelivered：只有持有租约的领取者能确认，且只能确认一次", () => {
    const store = new LogStore(":memory:");
    const ob = new Outbox(store);
    fill(ob, 1);
    const r = ob.claim({ sessionId: "s1", claimer: "A", leaseMs: 1000 })!;
    expect(ob.markDelivered(r.id, "B", "PreToolUse")).toBe(false);
    expect(ob.markDelivered(r.id, "A", "PreToolUse")).toBe(true);
    expect(ob.markDelivered(r.id, "A", "PreToolUse")).toBe(false);
    expect(ob.get(r.id)).toMatchObject({ state: "delivered", delivered_channel: "PreToolUse" });
    expect(ob.claim({ sessionId: "s1", claimer: "C", leaseMs: 1000 })).toBeNull();
  });
  test("租约过期回收：旧领取者的确认无效，新领取者确认有效（不会重复确认投递）", () => {
    const store = new LogStore(":memory:");
    let now = 1_000_000;
    const ob = new Outbox(store, () => now);
    fill(ob, 1);
    const a = ob.claim({ sessionId: "s1", claimer: "A", leaseMs: 100 })!;
    now += 50;
    expect(ob.claim({ sessionId: "s1", claimer: "B", leaseMs: 100 })).toBeNull(); // 租约还没过期
    now += 100;
    const b = ob.claim({ sessionId: "s1", claimer: "B", leaseMs: 100 })!;
    expect(b.id).toBe(a.id);
    expect(b).toMatchObject({ claimed_by: "B", attempts: 2 });
    expect(ob.markDelivered(a.id, "A", "x")).toBe(false); // A 的租约已被回收
    expect(ob.markDelivered(b.id, "B", "x")).toBe(true);
    expect(ob.get(a.id)!.state).toBe("delivered");
  });
  test("过期丢弃：超过有效期的消息不会被领取，expireOld 标为 expired", () => {
    const store = new LogStore(":memory:");
    let now = 1_000_000;
    const ob = new Outbox(store, () => now);
    ob.enqueue({ sessionId: "s", kind: "advise", text: "old", deliveryId: "d1", ttlMs: 1000 });
    ob.enqueue({ sessionId: "s", kind: "advise", text: "fresh", deliveryId: "d2", ttlMs: 60_000 });
    now += 5000;
    expect(ob.claim({ sessionId: "s", claimer: "A", leaseMs: 1000 })!.text).toBe("fresh");
    expect(ob.expireOld()).toBe(1);
    expect(ob.counts()).toMatchObject({ expired: 1, claimed: 1 });
  });
  test("复核前置条件：不成立 → stale 并记原因；release 放回队列", () => {
    const store = new LogStore(":memory:");
    const ob = new Outbox(store);
    ob.enqueue({ sessionId: "s", kind: "advise", text: "t", deliveryId: "d1", precondition: { errFp: "abc", ws: "w1", maxSteps: 3, createdStep: 10 } });
    const r = ob.claim({ sessionId: "s", claimer: "A", leaseMs: 1000 })!;
    const pre = JSON.parse(r.precondition_json!);
    expect(checkPrecondition(pre, { steps: 11, lastErrFp: "abc", lastWs: "w1" })).toBeNull();
    expect(checkPrecondition(pre, { steps: 11, lastErrFp: "zzz", lastWs: "w1" })).toContain("错误指纹");
    expect(checkPrecondition(pre, { steps: 11, lastErrFp: "abc", lastWs: "w2" })).toContain("工作区指纹");
    expect(checkPrecondition(pre, { steps: 20, lastErrFp: "abc", lastWs: "w1" })).toContain("步数");
    expect(checkPrecondition(undefined, { steps: 0 })).toBeNull();
    expect(ob.markStale(r.id, "B", "x")).toBe(false);
    expect(ob.markStale(r.id, "A", "最近一次结果的错误指纹已变化")).toBe(true);
    expect(ob.get(r.id)).toMatchObject({ state: "stale", stale_reason: "最近一次结果的错误指纹已变化" });
    ob.enqueue({ sessionId: "s", kind: "advise", text: "t2", deliveryId: "d2" });
    const r2 = ob.claim({ sessionId: "s", claimer: "A", leaseMs: 1000 })!;
    expect(ob.release(r2.id, "A")).toBe(true);
    expect(ob.claim({ sessionId: "s", claimer: "C", leaseMs: 1000 })!.id).toBe(r2.id);
  });
  test("prune 只删终态", () => {
    const store = new LogStore(":memory:");
    const ob = new Outbox(store);
    fill(ob, 3);
    const a = ob.claim({ sessionId: "s1", claimer: "A", leaseMs: 1000 })!;
    ob.markDelivered(a.id, "A", "x");
    expect(ob.prune(Date.now() + 10_000)).toBe(1);
    expect(store.count("outbox")).toBe(2);
  });
});

describe("outbox 并发：不会重复投递", () => {
  test("同一进程里多个连接交错领取：每条恰好被一个领取者确认", () => {
    const d = tmp();
    const path = join(d, "state.db");
    const seed = new LogStore(path);
    fill(new Outbox(seed), 60);
    const conns = Array.from({ length: 5 }, () => new Outbox(new LogStore(path)));
    const got = new Map<number, string>();
    let progressed = true;
    while (progressed) {
      progressed = false;
      conns.forEach((c, i) => {
        const r = c.claim({ sessionId: "s1", claimer: `w${i}`, leaseMs: 60_000 });
        if (r) {
          progressed = true;
          expect(got.has(r.id)).toBe(false);
          expect(c.markDelivered(r.id, `w${i}`, "t")).toBe(true);
          got.set(r.id, `w${i}`);
        }
      });
    }
    expect(got.size).toBe(60);
    expect(new Outbox(seed).counts()).toEqual({ delivered: 60 });
  });
  test("多个进程同时领取（真正并发写同一个 SQLite 文件）：每条恰好投递一次、没有遗漏", async () => {
    const d = tmp();
    const path = join(d, "state.db");
    const seed = new LogStore(path);
    const N = 240;
    fill(new Outbox(seed), N);
    seed.close();
    const worker = join(import.meta.dir, "helpers/claim-worker.ts");
    const procs = Array.from({ length: 6 }, (_, i) => Bun.spawn(["bun", worker, path, `proc${i}`, "s1"], { stdout: "pipe", stderr: "pipe" }));
    const outs = await Promise.all(procs.map(async (p) => ({ text: await new Response(p.stdout).text(), err: await new Response(p.stderr).text(), code: await p.exited })));
    const results = outs.map((o) => {
      expect(o.code, o.err).toBe(0);
      return JSON.parse(o.text.trim().split("\n").pop()!) as { claimer: string; got: number[]; rejected: number[] };
    });
    const all = results.flatMap((r) => r.got);
    expect(all.length).toBe(N);
    expect(new Set(all).size).toBe(N); // 没有重复
    expect(results.every((r) => r.rejected.length === 0)).toBe(true);
    expect(results.filter((r) => r.got.length > 0).length).toBeGreaterThan(1); // 确实有多个进程分到了活
    const check = new LogStore(path);
    expect(new Outbox(check).counts()).toEqual({ delivered: N });
  }, 60_000);
  test("租约很短、领取者不确认就退出：消息被别的领取者回收，最终仍然只确认一次", () => {
    const d = tmp();
    const path = join(d, "state.db");
    let now = 5_000_000;
    const a = new Outbox(new LogStore(path), () => now);
    const b = new Outbox(new LogStore(path), () => now);
    fill(a, 10);
    const crashed = [];
    for (let i = 0; i < 4; i++) crashed.push(a.claim({ sessionId: "s1", claimer: "crash", leaseMs: 100 })!.id); // 领了不确认
    now += 500;
    const done = new Set<number>();
    for (;;) {
      const r = b.claim({ sessionId: "s1", claimer: "B", leaseMs: 1000 });
      if (!r) break;
      expect(b.markDelivered(r.id, "B", "t")).toBe(true);
      done.add(r.id);
    }
    expect(done.size).toBe(10);
    for (const id of crashed) expect(a.markDelivered(id, "crash", "t")).toBe(false);
  });
});

describe("injections / plans 持久化", () => {
  test("injections：哈希按归一化文本，重启后可读回", () => {
    const d = tmp();
    const s = new LogStore(join(d, "x.db"));
    saveInjection(s, "s1", "工作区没有变化，  请先确认。");
    saveInjection(s, "s1", "工作区没有变化， 请先确认。"); // 空白归一后相同 → 去重
    expect(loadInjectionHashes(s, "s1")).toHaveLength(1);
    expect(hasInjection(s, "s1", "工作区没有变化，请先确认。".replace("，", "， "))).toBe(true);
    expect(hasInjection(s, "s2", "工作区没有变化， 请先确认。")).toBe(false);
    s.close();
    expect(loadInjectionHashes(new LogStore(join(d, "x.db")), "s1")).toHaveLength(1);
  });
  test("plans：保存 / 覆盖 / 读回", () => {
    const s = new LogStore(":memory:");
    expect(loadPlan(s, "s1")).toBeNull();
    savePlan(s, "s1", parsePlanMd("# t\n- [ ] 改 src/a.ts\nallow: src/**\n"));
    const p = loadPlan(s, "s1")!;
    expect(p.source).toBe("file");
    expect(p.explicitAllow).toEqual(["src/**"]);
    expect(p.items[0].text).toContain("src/a.ts");
    savePlan(s, "s1", { source: "auto", items: [{ text: "x", status: "pending" }], explicitAllow: [], text: "x" });
    expect(loadPlan(s, "s1")!.source).toBe("auto");
    expect(s.count("plans")).toBe(1);
  });
});
