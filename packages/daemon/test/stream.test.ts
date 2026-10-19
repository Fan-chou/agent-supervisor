// GET /v1/stream：NDJSON（UDS）/ SSE（HTTP+token）、过滤、游标续传、reset、心跳、慢订阅者、故障不影响 hook 路径。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, resolveConfig } from "@sv/core";
import { Daemon, startDaemon } from "../src/index.ts";
import { StreamHub } from "../src/stream.ts";
import { schemaFor } from "../src/schemas.ts";
import { validate } from "./helpers/validate.ts";

const dirs: string[] = [];
const daemons: Daemon[] = [];
afterEach(async () => {
  while (daemons.length) await daemons.pop()!.stop();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
async function boot(opts: { hb?: number; mode?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), "sv-st-"));
  dirs.push(home);
  const d = await startDaemon({ cfg: resolveConfig({ mode: opts.mode ?? "shadow" }, defaultConfig()), home, dbPath: join(home, "state.db"), socketPath: join(home, "sock"), port: 0, streamHeartbeatMs: opts.hb });
  daemons.push(d);
  return { d, home };
}
const post = (d: Daemon, payload: unknown, harness = "claude") => fetch("http://localhost/v1/hook", { unix: d.socketPath!, method: "POST", body: JSON.stringify({ harness, payload }) });
const cc = (extra: Record<string, unknown>, sid = "cc-1") => ({ session_id: sid, cwd: "/tmp", model: "m", ...extra });

/** 按行读取流；超时即停。 */
async function readLines(res: Response, n: number, timeoutMs = 2000): Promise<any[]> {
  const out: any[] = [];
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  while (out.length < n && Date.now() < deadline) {
    const r = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), Math.max(1, deadline - Date.now())))]);
    if (!r || r.done) break;
    buf += dec.decode(r.value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) out.push(line);
    }
  }
  reader.releaseLock();
  return out.map((l) => (typeof l === "string" && l.startsWith("{") ? JSON.parse(l) : l));
}
const open = (d: Daemon, qs = "") => fetch(`http://localhost/v1/stream${qs}`, { unix: d.socketPath! });
const tool = async (d: Daemon, cmd: string, id: string, sid = "cc-1") => {
  await post(d, cc({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: cmd }, tool_use_id: id }, sid));
  await post(d, cc({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: cmd }, tool_response: { stdout: "ok" }, tool_use_id: id }, sid));
};

describe("StreamHub（单元）", () => {
  test("streamId 单调；replayFrom：游标之后的消息 / 被挤出 → null / 别的 epoch → null / 游标在未来 → null / 刚好最新 → 空", () => {
    let t = 1000;
    const hub = new StreamHub(() => t++, { bufferCap: 3 }, 1);
    for (let i = 0; i < 5; i++) hub.publish("event", { sessionId: "s", seq: i });
    expect(hub.lastId).toBe("1.5");
    expect(hub.replayFrom("1.3")!.map((m) => m.seq)).toEqual([3, 4]);
    expect(hub.replayFrom("1.5")).toEqual([]);
    expect(hub.replayFrom("1.1")).toBeNull(); // 缓冲只剩 3..5
    expect(hub.replayFrom("1.2")!.length).toBe(3);
    expect(hub.replayFrom("9.3")).toBeNull();
    expect(hub.replayFrom("1.99")).toBeNull();
    expect(hub.replayFrom("garbage")).toBeNull();
  });
  test("过滤：types / sessions；没有 sessionId 的消息在按会话订阅时不发（status 除外）", () => {
    const m = { streamId: "1.1", type: "event", ts: 1, sessionId: "a" } as const;
    expect(StreamHub.match(m, {})).toBe(true);
    expect(StreamHub.match(m, { types: new Set(["hit"]) })).toBe(false);
    expect(StreamHub.match(m, { sessions: new Set(["b"]) })).toBe(false);
    expect(StreamHub.match({ ...m, sessionId: undefined } as never, { sessions: new Set(["a"]) })).toBe(false);
    expect(StreamHub.match({ streamId: "1.1", type: "status", ts: 1 } as never, { sessions: new Set(["a"]) })).toBe(true);
  });
  test("publish 永不抛异常（订阅者回调抛了也不影响其他订阅者）", () => {
    const hub = new StreamHub();
    expect(() => hub.publish("event", { sessionId: "s", circular: (() => { const o: any = {}; o.o = o; return o; })() })).not.toThrow();
  });
});

describe("/v1/stream", () => {
  test("UDS 默认 NDJSON：先 status 快照，然后 session / event / hit / decision 增量；每条符合 StreamMessage schema；不含命令正文", async () => {
    const { d } = await boot();
    const res = await open(d);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const p = readLines(res, 8);
    await tool(d, "git reset --hard HEAD~1", "t1");
    const msgs = await p;
    expect(msgs[0].type).toBe("status");
    const types = msgs.map((m: any) => m.type);
    expect(types).toContain("session");
    expect(types).toContain("event");
    expect(types).toContain("hit");
    expect(types).toContain("decision");
    for (const m of msgs) expect(validate(schemaFor("StreamMessage")!, m), JSON.stringify(m)).toEqual([]);
    const hit = msgs.find((m: any) => m.type === "hit");
    expect(hit).toMatchObject({ ruleId: "X2", dangerous: true, sessionId: "cc-1" });
    const dec = msgs.find((m: any) => m.type === "decision");
    expect(dec).toMatchObject({ ruleId: "X2", applied: false, outcome: "would_have_blocked", dangerous: true });
    expect(JSON.stringify(msgs)).not.toContain("reset --hard");
    const ids = msgs.filter((m: any) => m.type !== "status").map((m: any) => Number(m.streamId.split(".")[1]));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });
  test("过滤：?sessions= 与 ?types=；未知 type → 400", async () => {
    const { d } = await boot();
    const res = await open(d, "?sessions=cc-2&types=event");
    const p = readLines(res, 3, 600);
    await tool(d, "ls", "a1", "cc-1");
    await tool(d, "ls", "b1", "cc-2");
    const msgs = await p;
    const ev = msgs.filter((m: any) => m.type !== "status");
    expect(ev.length).toBe(2);
    expect(ev.every((m: any) => m.type === "event" && m.sessionId === "cc-2")).toBe(true);
    expect((await open(d, "?types=bogus")).status).toBe(400);
  });
  test("断线重连：?since=<最后收到的 streamId> 补上缺失的消息，不重复", async () => {
    const { d } = await boot();
    const first = readLines(await open(d), 3, 800);
    await tool(d, "ls", "a1");
    const got = await first;
    const last = got[got.length - 1].streamId;
    await tool(d, "pwd", "a2"); // 断线期间发生
    const res = await open(d, `?since=${last}`);
    const back = await readLines(res, 20, 400);
    const ev = back.filter((m: any) => m.type !== "status" && m.type !== "heartbeat");
    expect(ev.length).toBeGreaterThan(0);
    const n = (m: any) => Number(m.streamId.split(".")[1]);
    expect(ev.every((m: any) => n(m) > Number(last.split(".")[1]))).toBe(true);
    expect(ev.some((m: any) => m.type === "event" && m.tool === "Bash")).toBe(true);
    expect(new Set(ev.map((m: any) => m.streamId)).size).toBe(ev.length);
  });
  test("游标无效 / 来自别的守护进程（epoch 不同）/ 在未来 → 先发 reset，然后继续实时推送", async () => {
    const { d } = await boot();
    await tool(d, "ls", "a1");
    for (const since of ["zzz.5", "garbage", `${d.stream.epoch}.99999`]) {
      const p = readLines(await open(d, `?since=${since}`), 3, 600);
      await tool(d, "ls", `x-${since}`);
      const msgs = await p;
      expect(msgs.map((m: any) => m.type).slice(0, 2), since).toEqual(["status", "reset"]);
      expect(msgs[1].reason).toBe("cursor_expired");
      expect(msgs.length).toBeGreaterThan(2); // reset 之后仍然有增量
    }
  });
  test("SSE：HTTP + token 默认 SSE（id/event/data 帧），Last-Event-ID 续传；没有 token → 401", async () => {
    const { d, home } = await boot();
    expect((await fetch(`http://127.0.0.1:${d.port}/v1/stream`)).status).toBe(401);
    const token = (await Bun.file(join(home, "token")).text()).trim();
    const res = await fetch(`http://127.0.0.1:${d.port}/v1/stream`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const p = readLines(res, 12, 1500);
    await tool(d, "ls", "s1");
    const lines = (await p) as string[];
    expect(lines.some((l) => typeof l === "string" && l.startsWith("event: event"))).toBe(true);
    const idLine = lines.find((l) => typeof l === "string" && l.startsWith("id: "))!;
    const dataLine = lines.find((l) => typeof l === "string" && l.startsWith("data: "))!;
    expect(JSON.parse(dataLine.slice(6)).streamId).toBeTruthy();
    // 续传
    const lastId = idLine.slice(4);
    await tool(d, "pwd", "s2");
    const res2 = await fetch(`http://127.0.0.1:${d.port}/v1/stream`, { headers: { authorization: `Bearer ${token}`, "last-event-id": lastId } });
    const again = (await readLines(res2, 30, 400)) as string[];
    expect(again.some((l) => typeof l === "string" && l.startsWith("event: event"))).toBe(true);
    expect(again.every((l) => !(typeof l === "string" && l.startsWith("event: reset")))).toBe(true);
  });
  test("心跳：空闲时按间隔推送 heartbeat", async () => {
    const { d } = await boot({ hb: 40 });
    const msgs = await readLines(await open(d), 3, 1500);
    expect(msgs.map((m: any) => m.type)).toEqual(["status", "heartbeat", "heartbeat"]);
  });
  test("慢订阅者被断开而不是拖垮守护进程：hook 路径照常返回", async () => {
    const { d } = await boot();
    const res = await open(d); // 不读取
    for (let i = 0; i < 1100; i++) d.stream.publish("event", { sessionId: "x", seq: i });
    const r = await post(d, cc({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "z" }));
    expect(r.status).toBe(200);
    expect(d.stream.subscribers).toBe(0);
    await res.body!.cancel();
  });
  test("订阅者取消后会被清理；daemon.stop 能干净退出", async () => {
    const { d } = await boot();
    const ac = new AbortController();
    const res = await fetch("http://localhost/v1/stream", { unix: d.socketPath!, signal: ac.signal });
    await readLines(res, 1, 500);
    ac.abort();
    // 服务端未必立刻感知断开；最迟在下一次推送写失败时被清理
    for (let i = 0; i < 20 && d.stream.subscribers > 0; i++) {
      d.stream.publish("event", { sessionId: "x", seq: i });
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(d.stream.subscribers).toBe(0);
  });
  test("流的故障不影响 hook 路径：publish 抛异常的极端情况下 hook 仍然 200 且日志照写", async () => {
    const { d } = await boot();
    (d.stream as any).buf = null; // 破坏内部状态，让 publish 内部抛异常
    const r = await post(d, cc({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "q" }));
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).ok).toBe(true);
    expect((d.store.db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n).toBeGreaterThan(0);
  });
});

describe("长连接不被空闲超时掐断", () => {
  // 回归：Bun.serve 默认 10 秒空闲超时，而心跳曾是 15 秒，Windows 上流每 10 秒被断（日志 "request timed out after 10 seconds"）。
  test("无任何业务事件时，流在 22 秒内保持打开并持续收到心跳（unix 与 HTTP 两个入口）", async () => {
    const { d } = await boot(); // 默认心跳间隔
    const ac = new AbortController();
    const targets: Array<[string, RequestInit]> = [
      ["http://localhost/v1/stream", { unix: d.socketPath!, signal: ac.signal } as RequestInit],
      [`http://127.0.0.1:${d.port}/v1/stream?format=ndjson`, { signal: ac.signal, headers: { authorization: `Bearer ${d.token}` } }],
    ];
    const results = await Promise.all(
      targets.map(async ([u, init]) => {
        const res = await fetch(u, init);
        expect(res.status).toBe(200);
        const reader = res.body!.getReader();
        const dec = new TextDecoder();
        let heartbeats = 0;
        let ended = false;
        const deadline = Date.now() + 22_000;
        while (Date.now() < deadline) {
          const r = await Promise.race([reader.read(), new Promise<null>((ok) => setTimeout(() => ok(null), Math.max(1, deadline - Date.now())))]);
          if (r === null) break;
          if (r.done) {
            ended = true;
            break;
          }
          heartbeats += (dec.decode(r.value).match(/"type":"heartbeat"/g) ?? []).length;
        }
        return { heartbeats, ended };
      }),
    );
    ac.abort();
    for (const r of results) {
      expect(r.ended).toBe(false);
      expect(r.heartbeats).toBeGreaterThanOrEqual(3);
    }
  }, 40_000);
});
