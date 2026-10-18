// 插件源码本身的测试：用假的 V2 ctx（只记录注册的 hook）和假的守护进程（Bun.serve）真实执行 `sv install opencode` 打印的那份代码。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../plugin/agent-supervisor.ts";

type Handler = (e: any) => unknown;
function fakeCtx(opts: { broken?: boolean } = {}) {
  const hooks = new Map<string, Handler>();
  const mk = (ns: string) => ({
    hook: (name: string, f: Handler) => {
      if (opts.broken) throw new Error("hook api changed");
      hooks.set(`${ns}.${name}`, f);
    },
  });
  return { ctx: { permission: mk("permission"), session: mk("session"), tool: mk("tool"), location: { directory: "/work/proj" } }, hooks };
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
  if (prevHome === undefined) delete process.env.SV_HOME;
  else process.env.SV_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

const setup = (ctx: any) => (plugin as any).setup(ctx);
const deliver = (kind: string, text: string, mode: string) => ({ ok: true, mode, delivery: { kind, text, deliveryId: "d1", ruleId: "L1" } });

describe("OpenCode 插件（真实执行打印出来的源码）", () => {
  test("导出 id 与 setup；注册四个 V2 hook", () => {
    expect((plugin as any).id).toBe("agent-supervisor");
    const { ctx, hooks } = fakeCtx();
    setup(ctx);
    expect([...hooks.keys()].sort()).toEqual(["permission.evaluate", "session.context", "tool.execute.after", "tool.execute.before"]);
  });
  test("enforce：evaluate 收到 block → e.effect=deny 且带 message；其他字段不碰", async () => {
    startFake(() => deliver("block", "同一个失败命令已重复 3 次。", "enforce"));
    const { ctx, hooks } = fakeCtx();
    setup(ctx);
    const e: any = { sessionID: "s1", action: "bash", resources: ["git reset --hard"], metadata: { a: 1 } };
    await hooks.get("permission.evaluate")!(e);
    expect(e).toEqual({ sessionID: "s1", action: "bash", resources: ["git reset --hard"], metadata: { a: 1 }, effect: "deny", message: "同一个失败命令已重复 3 次。" });
    expect(seen[0]).toMatchObject({ harness: "opencode", payload: { event: "permission.evaluate", sessionID: "s1" } });
  });
  test("shadow / advise：守护进程即使（出 bug）返回 block，插件也不会 deny；advise 模式只放行 advise", async () => {
    for (const mode of ["shadow", "advise"]) {
      startFake(() => deliver("block", "拦截", mode));
      const { ctx, hooks } = fakeCtx();
      setup(ctx);
      const e: any = { sessionID: "s1", action: "bash", resources: [] };
      await hooks.get("permission.evaluate")!(e);
      expect(e.effect, mode).toBeUndefined();
      expect(e.message, mode).toBeUndefined();
      server!.stop(true);
    }
    startFake(() => deliver("advise", "建议一条", "shadow"));
    const { ctx, hooks } = fakeCtx();
    setup(ctx);
    const c: any = { sessionID: "s1", system: ["base"], messages: [] };
    await hooks.get("session.context")!(c);
    expect(c.system).toEqual(["base"]); // shadow 下 advise 也不注入
  });
  test("context：advise 追加到 system；同一条再重复注入 1 次（共 2 次请求），之后不再；tool.after 会提前结束重复", async () => {
    let calls = 0;
    startFake(() => (calls++ === 0 ? deliver("advise", "先看第一条报错。", "advise") : { ok: true, delivery: null, mode: "advise" }));
    const { ctx, hooks } = fakeCtx();
    setup(ctx);
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
    const c4: any = { sessionID: "s1", system: [], messages: [] };
    await ctxHook(c4);
    await hooks.get("tool.execute.after")!({ sessionID: "s1", tool: "bash", status: "completed" });
    const c5: any = { sessionID: "s1", system: [], messages: [] };
    await ctxHook(c5);
    expect(c4.system.length).toBe(1);
    expect(c5.system).toEqual([]);
  });
  test("context：只在 user 消息变化时带 userMessage；多种消息形态都能取到文本", async () => {
    startFake();
    const { ctx, hooks } = fakeCtx();
    setup(ctx);
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
    setup(ctx);
    await hooks.get("tool.execute.before")!({ sessionID: "s1", callID: "c1", tool: "bash", args: { command: "ls" } });
    await hooks.get("tool.execute.after")!({ sessionID: "s1", callID: "c1", tool: "bash", args: { command: "ls" }, status: "error", error: { message: "boom" } });
    expect(seen[0].payload).toMatchObject({ event: "tool.before", sessionID: "s1", callID: "c1", tool: "bash", args: { command: "ls" }, directory: "/work/proj" });
    expect(seen[1].payload).toMatchObject({ event: "tool.after", status: "error", error: { message: "boom" } });
  });
  test("fail-open：守护进程不可达 / 超时 / HTTP 500 / 非 JSON / 没有 hook.json——任何 hook 都不抛异常、不改事件", async () => {
    const { ctx, hooks } = fakeCtx();
    setup(ctx);
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
    expect(() => setup(fakeCtx({ broken: true }).ctx)).not.toThrow();
    expect(() => setup({})).not.toThrow();
    expect(() => setup(undefined)).not.toThrow();
    startFake();
    const { ctx, hooks } = fakeCtx();
    setup(ctx);
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
    setup(ctx);
    await hooks.get("tool.execute.before")!({ sessionID: "s1", tool: "bash", args: {} });
    expect(auth).toBe("Bearer tok123");
  });
});
