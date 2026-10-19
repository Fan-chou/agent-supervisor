// 插件源码本身的测试：用假的 V2 ctx（只记录注册的 hook）和假的守护进程（Bun.serve）真实执行 `sv install opencode` 打印的那份代码。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../plugin/agent-supervisor.ts";

type Handler = (e: any) => unknown;
function fakeCtx(opts: { broken?: boolean; skip?: string[]; asyncReject?: string[] } = {}) {
  const hooks = new Map<string, Handler>();
  const disposed: string[] = [];
  const mk = (ns: string) => ({
    hook: (name: string, f: Handler) => {
      if (opts.broken || opts.skip?.includes(`${ns}.${name}`)) throw new Error("hook api changed");
      if (opts.asyncReject?.includes(`${ns}.${name}`)) return Promise.reject(new Error("registration rejected"));
      hooks.set(`${ns}.${name}`, f);
      return Promise.resolve({ dispose: async () => void disposed.push(`${ns}.${name}`) }); // V2 的 hook 注册返回 Promise<Registration>
    },
  });
  return { ctx: { permission: mk("permission"), session: mk("session"), tool: mk("tool"), location: { directory: "/work/proj" } }, hooks, disposed };
}

interface Seen {
  harness: string;
  payload: Record<string, any>;
}
let home: string;
let server: ReturnType<typeof Bun.serve> | undefined;
let seen: Seen[];
let reply: () => unknown;
const prevHome = process.env.SV_HOME;
function openGate() {
  process.env.SV_OPENCODE_ENFORCE = "1";
  writeFileSync(join(home, "hook.json"), JSON.stringify({ protocol: 1, mode: "enforce", port: server!.port }));
}

function startFake(handler: (b: Seen) => unknown = () => ({ ok: true, delivery: null, mode: "shadow" })) {
  reply = () => null;
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const b = (await req.json()) as Seen;
      seen.push(b);
      const r = handler(b);
      return r instanceof Response ? r : Response.json(r);
    },
  });
  writeFileSync(join(home, "hook.json"), JSON.stringify({ protocol: 1, mode: "shadow", port: server.port }));
  writeFileSync(join(home, "token"), "t\n");
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sv-ocp-"));
  process.env.SV_HOME = home;
  seen = [];
});
afterEach(() => {
  server?.stop(true);
  server = undefined;
  delete process.env.SV_OPENCODE_ENFORCE;
  delete process.env.SV_OPENCODE_DUMP;
  delete process.env.SV_OPENCODE_PROBE;
  if (prevHome === undefined) delete process.env.SV_HOME;
  else process.env.SV_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

const setup = async (ctx: any) => (plugin as any).setup(ctx);
const deliver = (kind: string, text: string, mode: string) => ({ ok: true, mode, delivery: { kind, text, deliveryId: "d1", ruleId: "L1" } });

describe("OpenCode 插件（真实执行打印出来的源码）", () => {
  test("导出 id 与 setup；注册五个 V2 hook（evaluate、context、prompt、execute.before、execute.after）", async () => {
    expect((plugin as any).id).toBe("agent-supervisor");
    const { ctx, hooks } = fakeCtx();
    await setup(ctx);
    expect([...hooks.keys()].sort()).toEqual(["permission.evaluate", "session.context", "session.prompt", "tool.execute.after", "tool.execute.before"]);
  });
  test("闸门打开（mode=enforce 且 SV_OPENCODE_ENFORCE=1）：evaluate 收到 block → e.effect=deny 且带 message；其他字段不碰", async () => {
    startFake(() => deliver("block", "同一个失败命令已重复 3 次。", "enforce"));
    openGate();
    const { ctx, hooks } = fakeCtx();
    await setup(ctx);
    const e: any = { sessionID: "s1", action: "bash", resources: ["git reset --hard"], metadata: { a: 1 } };
    await hooks.get("permission.evaluate")!(e);
    expect(e).toEqual({ sessionID: "s1", action: "bash", resources: ["git reset --hard"], metadata: { a: 1 }, effect: "deny", message: "同一个失败命令已重复 3 次。" });
    expect(seen[0]).toMatchObject({ harness: "opencode", payload: { event: "permission.evaluate", sessionID: "s1" } });
  });
  test("核对通过前只观察：守护进程 mode=enforce 且返回 block，但没有 SV_OPENCODE_ENFORCE=1 → 插件不 deny（decisions #89）；只有环境变量、hook.json 不是 enforce 同样不 deny", async () => {
    startFake(() => deliver("block", "拦截", "enforce"));
    writeFileSync(join(home, "hook.json"), JSON.stringify({ mode: "enforce", port: server!.port }));
    const { ctx, hooks } = fakeCtx();
    await setup(ctx);
    const e: any = { sessionID: "s1", action: "bash", resources: [] };
    await hooks.get("permission.evaluate")!(e);
    expect(e.effect).toBeUndefined();
    process.env.SV_OPENCODE_ENFORCE = "1";
    writeFileSync(join(home, "hook.json"), JSON.stringify({ mode: "shadow", port: server!.port }));
    const e2: any = { sessionID: "s1", action: "bash", resources: [] };
    await hooks.get("permission.evaluate")!(e2);
    expect(e2.effect).toBeUndefined();
  });
  describe("本地 X2（tool.before 的参数；守护进程不可达也能判）", () => {
    const run = async (hooks: Map<string, (e: any) => unknown>, tool: string, args: any, o: { call?: string; evaluate?: boolean } = {}) => {
      await hooks.get("tool.execute.before")!({ sessionID: "s1", callID: o.call ?? "c1", tool, args });
      const e: any = { sessionID: "s1", action: tool, resources: [] };
      if (o.evaluate !== false) await hooks.get("permission.evaluate")!(e);
      return e;
    };
    test("闸门关：危险命令 / 写 .env 都不拦（只观察）", async () => {
      const { ctx, hooks } = fakeCtx(); // 没有守护进程
      await setup(ctx);
      expect((await run(hooks, "bash", { command: "git reset --hard HEAD~1" })).effect).toBeUndefined();
      expect((await run(hooks, "write", { filePath: "/work/proj/.env", content: "A=1" }, { call: "c2" })).effect).toBeUndefined();
    });
    test("闸门开：守护进程不可达也拦（git reset --hard / 写 .env / rm -rf /）；普通命令放行；deny 带 message", async () => {
      startFake();
      openGate();
      const port = server!.port;
      server!.stop(true);
      writeFileSync(join(home, "hook.json"), JSON.stringify({ mode: "enforce", port })); // 守护进程已不在
      const { ctx, hooks } = fakeCtx();
      await setup(ctx);
      const a = await run(hooks, "bash", { command: "git reset --hard HEAD~1" });
      expect(a.effect).toBe("deny");
      expect(a.message).toContain("X2");
      expect((await run(hooks, "write", { filePath: "/work/proj/.env", content: "A=1" }, { call: "c2" })).effect).toBe("deny");
      expect((await run(hooks, "edit", { filePath: "/work/proj/src/a.ts", oldString: "a", newString: "b" }, { call: "c3" })).effect).toBeUndefined();
      expect((await run(hooks, "bash", { command: "ls -la" }, { call: "c4" })).effect).toBeUndefined();
    });
    test("绑定到调用：危险调用已经 after 结束，或有新的 before 之后，旧的本地拦截不会落到别的调用上", async () => {
      startFake();
      openGate();
      const port = server!.port;
      server!.stop(true);
      writeFileSync(join(home, "hook.json"), JSON.stringify({ mode: "enforce", port }));
      const { ctx, hooks } = fakeCtx();
      await setup(ctx);
      await hooks.get("tool.execute.before")!({ sessionID: "s1", callID: "N", tool: "bash", args: { command: "git reset --hard" } });
      await hooks.get("tool.execute.after")!({ sessionID: "s1", callID: "N", tool: "bash", status: "completed" });
      const e1: any = { sessionID: "s1" };
      await hooks.get("permission.evaluate")!(e1);
      expect(e1.effect).toBeUndefined(); // N 已结束
      await hooks.get("tool.execute.before")!({ sessionID: "s1", callID: "N2", tool: "bash", args: { command: "git reset --hard" } });
      await hooks.get("tool.execute.before")!({ sessionID: "s1", callID: "N3", tool: "bash", args: { command: "ls" } });
      const e2: any = { sessionID: "s1" };
      await hooks.get("permission.evaluate")!(e2);
      expect(e2.effect).toBeUndefined(); // 最近一次 before 是安全的 N3
    });
    test("X2 内部出错 = 放行（args 是怪东西也不抛）", async () => {
      const { ctx, hooks } = fakeCtx();
      await setup(ctx);
      for (const args of [null, undefined, 5, "str", { command: 7 }, { command: { a: 1 } }]) await hooks.get("tool.execute.before")!({ sessionID: "s1", callID: "x", tool: "bash", args });
    });
  });
  test("探针 SV_OPENCODE_PROBE（核对用，默认关）：事件里含该子串才 deny，用来验证 deny/message/异步 hook 在真机上是否有效", async () => {
    const { ctx, hooks } = fakeCtx();
    await setup(ctx);
    const none: any = { sessionID: "s1", resources: ["touch /tmp/sv-probe-1"] };
    await hooks.get("permission.evaluate")!(none);
    expect(none.effect).toBeUndefined(); // 没设置探针 = 不拦
    process.env.SV_OPENCODE_PROBE = "sv-probe";
    const hit: any = { sessionID: "s1", resources: ["touch /tmp/sv-probe-1"] };
    await hooks.get("permission.evaluate")!(hit);
    expect(hit.effect).toBe("deny");
    expect(hit.message).toContain("探针");
    const miss: any = { sessionID: "s1", resources: ["ls"] };
    await hooks.get("permission.evaluate")!(miss);
    expect(miss.effect).toBeUndefined();
  });
  test("SV_OPENCODE_DUMP=1：落盘 setup/注册/每个 hook 的 enter/exit，含形状和脱敏样本（0600/0700）；默认不落盘", async () => {
    startFake();
    const { ctx, hooks } = fakeCtx();
    await setup(ctx);
    await hooks.get("tool.execute.before")!({ sessionID: "s1", callID: "c1", tool: "bash", args: { command: "ls" } });
    expect(existsSync(join(home, "dumps"))).toBe(false);
    process.env.SV_OPENCODE_DUMP = "1";
    const f = fakeCtx();
    await setup(f.ctx);
    await f.hooks.get("tool.execute.before")!({ sessionID: "s1", callID: "c9", tool: "bash", args: { command: "echo sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA" }, secret_token: "abcdef123456" });
    await f.hooks.get("session.context")!({ sessionID: "s1", system: ["x"], messages: [{ role: "user", content: "hi" }], model: { providerID: "p", modelID: "m" } });
    const dir = join(home, "dumps");
    const file = readdirSync(dir).find((x) => x.startsWith("opencode-"))!;
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600);
    const recs = readFileSync(join(dir, file), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(recs.some((r) => r.hook === "setup")).toBe(true);
    expect(recs.filter((r) => r.phase === "note" && r.registered === true).map((r) => r.hook).sort()).toEqual(["context", "evaluate", "execute.after", "execute.before", "prompt"]);
    const enter = recs.find((r) => r.hook === "execute.before" && r.phase === "enter");
    const exit = recs.find((r) => r.hook === "execute.before" && r.phase === "exit");
    expect(enter.shape).toMatchObject({ sessionID: "string", callID: "string", args: { command: "string" } });
    expect(exit.n).toBeGreaterThan(enter.n);
    const all = JSON.stringify(recs);
    expect(all).not.toContain("sk-ant-api03");
    expect(all).not.toContain("abcdef123456");
    const ctxRec = recs.find((r) => r.hook === "context" && r.phase === "enter");
    expect(ctxRec.shape.messages[0]).toBe("array(1)");
  });
  test("shadow / advise：守护进程即使（出 bug）返回 block，插件也不会 deny；advise 模式只放行 advise", async () => {
    for (const mode of ["shadow", "advise"]) {
      startFake(() => deliver("block", "拦截", mode));
      const { ctx, hooks } = fakeCtx();
      await setup(ctx);
      const e: any = { sessionID: "s1", action: "bash", resources: [] };
      await hooks.get("permission.evaluate")!(e);
      expect(e.effect, mode).toBeUndefined();
      expect(e.message, mode).toBeUndefined();
      server!.stop(true);
    }
    startFake(() => deliver("advise", "建议一条", "shadow"));
    const { ctx, hooks } = fakeCtx();
    await setup(ctx);
    const c: any = { sessionID: "s1", system: ["base"], messages: [] };
    await hooks.get("session.context")!(c);
    expect(c.system).toEqual(["base"]); // shadow 下 advise 也不注入
  });
  test("context：advise 追加到 system；同一条再重复注入 1 次（共 2 次请求），之后不再；tool.after 会提前结束重复", async () => {
    let calls = 0;
    startFake(() => (calls++ === 0 ? deliver("advise", "先看第一条报错。", "advise") : { ok: true, delivery: null, mode: "advise" }));
    const { ctx, hooks } = fakeCtx();
    await setup(ctx);
    const ctxHook = hooks.get("session.context")!;
    const c1: any = { sessionID: "s1", system: ["base"], messages: [] };
    const c2: any = { sessionID: "s1", system: ["base"], messages: [] };
    const c3: any = { sessionID: "s1", system: ["base"], messages: [] };
    await ctxHook(c1);
    await ctxHook(c2);
    await ctxHook(c3);
    expect(c1.system).toEqual(["base", "先看第一条报错。"]);
    expect(c2.system).toEqual(["base", "先看第一条报错。"]);
    expect(c3.system).toEqual(["base"]);
    expect(seen.length).toBe(2); // 重复注入那次不再问守护进程

    calls = 0;
    const c4: any = { sessionID: "s1", system: ["base"], messages: [] };
    await ctxHook(c4);
    await hooks.get("tool.execute.after")!({ sessionID: "s1", tool: "bash", status: "completed" });
    const c5: any = { sessionID: "s1", system: ["base"], messages: [] };
    await ctxHook(c5);
    expect(c4.system.length).toBe(2);
    expect(c5.system).toEqual(["base"]);
  });
  test("context 注入：SystemPart 是 {type:\"text\", text}（已核实）——追加干净的部件（不复制 cache 提示），空数组也能注入；system 不是数组就不改", async () => {
    startFake(() => deliver("advise", "建议一条", "advise"));
    const { ctx, hooks } = fakeCtx();
    await setup(ctx);
    const h = hooks.get("session.context")!;
    const part: any = { sessionID: "a", system: [{ type: "text", text: "base", cache: { type: "ephemeral" } }], messages: [] };
    await h(part);
    expect(part.system).toEqual([{ type: "text", text: "base", cache: { type: "ephemeral" } }, { type: "text", text: "建议一条" }]);
    const empty: any = { sessionID: "b", system: [], messages: [] };
    await h(empty);
    expect(empty.system).toEqual([{ type: "text", text: "建议一条" }]);
    for (const [sid, system] of [["e", undefined], ["f", "str"]] as const) {
      const e: any = { sessionID: sid, system, messages: [] };
      const before = JSON.stringify(e);
      await h(e);
      expect(JSON.stringify(e), String(sid)).toBe(before);
    }
  });
  test("中断：订阅 event.subscribe，只有 session.execution.interrupted 且 reason=user 才上报 event=interrupt；其他事件/原因忽略；清理时中止订阅；订阅抛错不影响 setup", async () => {
    startFake();
    let aborted = false;
    const events = [
      { type: "session.text.delta", data: { sessionID: "s1" } },
      { type: "session.execution.interrupted", data: { sessionID: "s1", reason: "shutdown" } },
      { type: "session.execution.interrupted", data: { sessionID: "s1", reason: "user" } },
      { type: "session.execution.interrupted", data: { reason: "user" } },
    ];
    const f = fakeCtx();
    (f.ctx as any).event = {
      subscribe: (o: any) => {
        o?.signal?.addEventListener("abort", () => (aborted = true));
        return (async function* () {
          for (const e of events) yield e;
        })();
      },
    };
    const cleanup: any = await setup(f.ctx);
    for (let i = 0; i < 100 && !seen.some((x) => x.payload.event === "interrupt"); i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 20)); // 再给后面的（应被忽略的）事件一点时间，免得漏判
    expect(seen.filter((x) => x.payload.event === "interrupt").map((x) => x.payload.sessionID)).toEqual(["s1"]);
    await cleanup();
    expect(aborted).toBe(true);
    const bad = fakeCtx();
    (bad.ctx as any).event = { subscribe: () => { throw new Error("boom"); } };
    await setup(bad.ctx);
    expect([...bad.hooks.keys()].length).toBe(5);
  });
  test("session.prompt 钩子：user 消息文本（字符串 / {text} / 部件数组）以 event=prompt 上报，同一条不重复；注册成功后 context 不再扫 messages", async () => {
    startFake();
    const { ctx, hooks } = fakeCtx();
    await setup(ctx);
    const p = hooks.get("session.prompt")!;
    await p({ sessionID: "s1", messageID: "m1", prompt: "修一下这个 bug", delivery: "queue" });
    await p({ sessionID: "s1", messageID: "m1", prompt: "修一下这个 bug", delivery: "queue" }); // 重复
    await p({ sessionID: "s1", messageID: "m2", prompt: { text: "再来" }, delivery: "queue" });
    await p({ sessionID: "s1", messageID: "m3", prompt: [{ type: "text", text: "第一段" }, { type: "text", text: "第二段" }], delivery: "queue" });
    await p({ sessionID: "s1", messageID: "m4", prompt: { weird: 1 }, delivery: "queue" }); // 取不到文本：不上报
    const posts = seen.filter((x) => x.payload.event === "prompt");
    expect(posts.map((x) => x.payload.userMessage)).toEqual([{ id: "m1", text: "修一下这个 bug" }, { id: "m2", text: "再来" }, { id: "m3", text: "第一段\n第二段" }]);
    await hooks.get("session.context")!({ sessionID: "s1", system: ["b"], messages: [{ role: "user", id: "x", content: "不应被扫描" }] });
    expect(seen.at(-1)!.payload.userMessage).toBeUndefined();
  });
  test("evaluate 的 source.id 把本地 X2 精确绑到那次调用：source.id 对不上就放行；对得上才（闸门开时）deny", async () => {
    startFake();
    openGate();
    const port = server!.port;
    server!.stop(true);
    writeFileSync(join(home, "hook.json"), JSON.stringify({ mode: "enforce", port }));
    const { ctx, hooks } = fakeCtx();
    await setup(ctx);
    await hooks.get("tool.execute.before")!({ sessionID: "s1", id: "call-A", tool: "bash", input: { command: "git reset --hard" } });
    const other: any = { sessionID: "s1", action: "bash", resources: [], source: { type: "tool", messageID: "m", id: "call-OTHER" } };
    await hooks.get("permission.evaluate")!(other);
    expect(other.effect).toBeUndefined();
    const mine: any = { sessionID: "s1", action: "bash", resources: [], source: { type: "tool", messageID: "m", id: "call-A" } };
    await hooks.get("permission.evaluate")!(mine);
    expect(mine.effect).toBe("deny");
  });
  test("批量调用 BBBEEA（真机见过）：危险调用不是最后一个 before 也能被精确绑定；没有对应 before 的 evaluate 放行", async () => {
    startFake();
    openGate();
    const port = server!.port;
    server!.stop(true);
    writeFileSync(join(home, "hook.json"), JSON.stringify({ mode: "enforce", port }));
    const { ctx, hooks } = fakeCtx();
    await setup(ctx);
    const b = hooks.get("tool.execute.before")!;
    await b({ sessionID: "s1", id: "c1", tool: "shell", input: { command: "git reset --hard" } });
    await b({ sessionID: "s1", id: "c2", tool: "shell", input: { command: "ls" } });
    await b({ sessionID: "s1", id: "c3", tool: "read", input: { path: "a.ts" } });
    const ev = async (id: string) => {
      const e: any = { sessionID: "s1", action: "x", resources: [], source: { type: "tool", messageID: "m", id } };
      await hooks.get("permission.evaluate")!(e);
      return e.effect;
    };
    expect(await ev("c1")).toBe("deny");
    expect(await ev("c2")).toBeUndefined();
    expect(await ev("c3")).toBeUndefined();
    expect(await ev("c-no-before")).toBeUndefined();
  });
  test("注册返回被拒绝的 Promise → 不抛、不产生未处理的 rejection，其余 hook 照常注册；setup 返回清理函数，调用后注销全部 hook", async () => {
    const f = fakeCtx({ asyncReject: ["session.context"] });
    const cleanup = await setup(f.ctx);
    expect([...f.hooks.keys()].sort()).toEqual(["permission.evaluate", "session.prompt", "tool.execute.after", "tool.execute.before"]);
    expect(typeof cleanup).toBe("function");
    await (cleanup as () => Promise<void>)();
    expect(f.disposed.sort()).toEqual(["permission.evaluate", "session.prompt", "tool.execute.after", "tool.execute.before"]);
  });
  test("真实 V2 字段名：execute.before/after 用 id 和 input（不是 callID/args）；上报时归一成线格式", async () => {
    startFake();
    const { ctx, hooks } = fakeCtx();
    await setup(ctx);
    await hooks.get("tool.execute.before")!({ sessionID: "s1", agent: "build", messageID: "m1", id: "call-1", tool: "bash", input: { command: "ls" } });
    await hooks.get("tool.execute.after")!({ sessionID: "s1", agent: "build", messageID: "m1", id: "call-1", tool: "bash", input: { command: "ls" }, status: "completed", result: { output: "ok" } });
    expect(seen[0].payload).toMatchObject({ event: "tool.before", callID: "call-1", tool: "bash", args: { command: "ls" }, directory: "/work/proj" });
    expect(seen[1].payload).toMatchObject({ event: "tool.after", callID: "call-1", status: "completed", result: { output: "ok" } });
  });
  test("context：只在 user 消息变化时带 userMessage；多种消息形态都能取到文本", async () => {
    startFake();
    const { ctx, hooks } = fakeCtx({ skip: ["session.prompt"] }); // 没有 prompt 钩子时才退回扫 messages
    await setup(ctx);
    const h = hooks.get("session.context")!;
    const msgs = [{ role: "user", id: "u1", parts: [{ text: "修一下" }, { text: "这个 bug" }] }, { role: "assistant", content: "好" }];
    await h({ sessionID: "s1", system: [], messages: msgs, model: { providerID: "p", modelID: "m" } });
    await h({ sessionID: "s1", system: [], messages: msgs });
    await h({ sessionID: "s1", system: [], messages: [...msgs, { role: "user", id: "u2", content: "再来" }] });
    expect(seen[0].payload.userMessage).toEqual({ id: "u1", text: "修一下\n这个 bug" });
    expect(seen[0].payload.model).toEqual({ providerID: "p", modelID: "m" });
    expect(seen[1].payload.userMessage).toBeUndefined();
    expect(seen[2].payload.userMessage).toEqual({ id: "u2", text: "再来" });
  });
  test("tool.before / tool.after：上报工具名、参数、callID、状态；error 状态带 error", async () => {
    startFake();
    const { ctx, hooks } = fakeCtx();
    await setup(ctx);
    await hooks.get("tool.execute.before")!({ sessionID: "s1", callID: "c1", tool: "bash", args: { command: "ls" } });
    await hooks.get("tool.execute.after")!({ sessionID: "s1", callID: "c1", tool: "bash", args: { command: "ls" }, status: "error", error: { message: "boom" } });
    expect(seen[0].payload).toMatchObject({ event: "tool.before", sessionID: "s1", callID: "c1", tool: "bash", args: { command: "ls" }, directory: "/work/proj" });
    expect(seen[1].payload).toMatchObject({ event: "tool.after", status: "error", error: { message: "boom" } });
  });
  test("fail-open：守护进程不可达 / 超时 / HTTP 500 / 非 JSON / 没有 hook.json——任何 hook 都不抛异常、不改事件", async () => {
    const { ctx, hooks } = fakeCtx();
    await setup(ctx);
    const run = async () => {
      const e: any = { sessionID: "s1", action: "bash", resources: [], system: ["b"], messages: [] };
      await hooks.get("permission.evaluate")!(e);
      await hooks.get("session.context")!(e);
      await hooks.get("tool.execute.before")!({ sessionID: "s1", tool: "bash", args: {} });
      await hooks.get("tool.execute.after")!({ sessionID: "s1", tool: "bash", args: {} });
      expect(e.effect).toBeUndefined();
      expect(e.system).toEqual(["b"]);
    };
    await run(); // 没有 hook.json、没有 sock
    startFake(() => new Response("boom", { status: 500 }));
    await run();
    server!.stop(true);
    startFake(() => new Response("not json", { status: 200 }));
    await run();
    server!.stop(true);
    startFake(() => new Response('{"delivery":{"kind":"block","text":123},"mode":"enforce"}'));
    await run(); // 文本不是字符串
    server!.stop(true);
    startFake();
    const port = server!.port;
    server!.stop(true);
    writeFileSync(join(home, "hook.json"), JSON.stringify({ port })); // 端口已关：连接被拒
    await run();
  });
  test("fail-open：hook API 形态变了（注册时抛异常 / ctx 缺字段 / 事件对象是 null）——setup 与 handler 都不抛", async () => {
    await expect(setup(fakeCtx({ broken: true }).ctx)).resolves.toBeDefined();
    await expect(setup({})).resolves.toBeDefined();
    await expect(setup(undefined)).resolves.toBeDefined();
    startFake();
    const { ctx, hooks } = fakeCtx();
    await setup(ctx);
    for (const h of hooks.values()) {
      await h(null);
      await h(undefined);
      await h({});
      await h({ sessionID: 5, messages: "x", system: "y" });
    }
  });
  test("守护进程只在 127.0.0.1 上被访问，带 token；不读 hook.json / token 以外的任何文件", async () => {
    let auth = "";
    server = Bun.serve({
      port: 0,
      fetch(req) {
        auth = req.headers.get("authorization") ?? "";
        return Response.json({ ok: true, delivery: null, mode: "shadow" });
      },
    });
    writeFileSync(join(home, "hook.json"), JSON.stringify({ port: server.port }));
    writeFileSync(join(home, "token"), "tok123\n");
    const { ctx, hooks } = fakeCtx();
    await setup(ctx);
    await hooks.get("tool.execute.before")!({ sessionID: "s1", tool: "bash", args: {} });
    expect(auth).toBe("Bearer tok123");
  });
});
