// live judge 客户端对着「本机 mock server」的真实 HTTP 测试（127.0.0.1，不碰任何外部服务）。
import { afterEach, describe, expect, test } from "bun:test";
import { createJudgeClient, defaultConfig, resolveConfig } from "../src/index.ts";
import { PYTEST_FAIL, Sim } from "./sim.ts";

interface Seen {
  path: string;
  headers: Record<string, string>;
  body: Record<string, any>;
}
type Handler = (seen: Seen, n: number) => Response | Promise<Response>;

const servers: { stop(force?: boolean): void }[] = [];
afterEach(() => {
  while (servers.length) servers.pop()!.stop(true);
});

function mockServer(handler: Handler) {
  const seen: Seen[] = [];
  const s = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = req.method === "POST" ? await req.json() : {};
      const rec = { path: new URL(req.url).pathname, headers: Object.fromEntries(req.headers), body } as Seen;
      seen.push(rec);
      return handler(rec, seen.length);
    },
  });
  servers.push(s);
  return { seen, baseUrl: `http://127.0.0.1:${s.port}/v1` };
}

const GOOD = { verdict: "advise", confidence: 0.82, category: "loop", message_to_agent: "同一错误已重复三次，建议先阅读报错再改。", reason: "r", evidence_steps: [3], watch: [], done: false };
const chat = (content: string, extra: object = {}) => Response.json({ choices: [{ message: { content } }], ...extra });

async function request(sync = false) {
  const s = new Sim();
  await s.prompt("fix it");
  for (let i = 0; i < 3; i++) await s.bash("pytest tests/a.py", { fail: true, out: PYTEST_FAIL(i) });
  return { hits: [s.hitsOf("L1")[0]], sync, session: s.engine.tracker };
}

const cfgFor = (baseUrl: string, over: object = {}) => ({ ...defaultConfig().judge, base_url: baseUrl, model: "supervisor-judge", ...over });

describe("默认值：可配置、默认指向本地 Magpie 路由组", () => {
  test("endpoint / model / key 变量名 / response_format / 超时 全部来自配置", () => {
    const j = defaultConfig().judge;
    expect(j).toMatchObject({ enabled: false, base_url: "http://127.0.0.1:3425/v1", model: "supervisor-judge", api_key_env: "SUPERVISOR_API_KEY", response_format: "auto", timeout_sync_s: 15, timeout_async_s: 30 });
    const c = resolveConfig({ judge: { enabled: true, base_url: "http://127.0.0.1:9/v1", model: "other", api_key_env: "MY_KEY", response_format: "json_object", routes: [{ when: { sync: true }, model: "fast" }] } });
    expect(c.judge).toMatchObject({ enabled: true, base_url: "http://127.0.0.1:9/v1", model: "other", api_key_env: "MY_KEY", response_format: "json_object" });
  });
});

describe("对着本机 mock server 的真实 HTTP", () => {
  test("正常：POST {base}/chat/completions，json_schema(strict)，key 只来自环境变量（api_key_env / ADVISOR_API_KEY）", async () => {
    const m = mockServer(() => chat(JSON.stringify(GOOD), { usage: { prompt_tokens: 900, completion_tokens: 60 } }));
    const c = createJudgeClient({ cfg: cfgFor(m.baseUrl, { api_key_env: "MY_KEY" }), env: { MY_KEY: "k-123" } });
    const r = await c.judge(await request());
    expect(r.kind).toBe("ok");
    expect(m.seen).toHaveLength(1);
    expect(m.seen[0].path).toBe("/v1/chat/completions");
    expect(m.seen[0].headers.authorization).toBe("Bearer k-123");
    expect(m.seen[0].body.response_format).toMatchObject({ type: "json_schema", json_schema: { strict: true } });
    expect(m.seen[0].body.model).toBe("supervisor-judge");
    if (r.kind === "ok") expect(r.meta).toMatchObject({ promptTokens: 900, completionTokens: 60, formatLevel: "json_schema" });
    // 没有 key：不发 Authorization（本地网关不一定需要）
    const m2 = mockServer(() => chat(JSON.stringify(GOOD)));
    await createJudgeClient({ cfg: cfgFor(m2.baseUrl), env: {} }).judge(await request());
    expect(m2.seen[0].headers.authorization).toBeUndefined();
    // ADVISOR_API_KEY 兜底
    const m3 = mockServer(() => chat(JSON.stringify(GOOD)));
    await createJudgeClient({ cfg: cfgFor(m3.baseUrl), env: { ADVISOR_API_KEY: "adv" } }).judge(await request());
    expect(m3.seen[0].headers.authorization).toBe("Bearer adv");
  });
  test("优先 json_schema；上游 400 说不支持 → 回退 json_object，并缓存（后续调用直接用 json_object）", async () => {
    const m = mockServer((s) => (s.body.response_format?.type === "json_schema" ? Response.json({ error: { message: "response_format type json_schema is not supported by this route" } }, { status: 400 }) : chat(JSON.stringify(GOOD))));
    const c = createJudgeClient({ cfg: cfgFor(m.baseUrl), env: {} });
    expect((await c.judge(await request())).kind).toBe("ok");
    expect(m.seen.map((x) => x.body.response_format?.type)).toEqual(["json_schema", "json_object"]);
    expect((await c.judge(await request())).kind).toBe("ok");
    expect(m.seen.map((x) => x.body.response_format?.type)).toEqual(["json_schema", "json_object", "json_object"]);
    expect(c.formatCache.get("supervisor-judge")).toBe("json_object");
  });
  test("稳健解析：think 块 + 代码块 + 百分数 confidence + 同义词，仍然 ok", async () => {
    const m = mockServer(() => chat("<think>先想想</think>\n```json\n" + JSON.stringify({ ...GOOD, verdict: "warn", confidence: "85%" }) + "\n```"));
    const r = await createJudgeClient({ cfg: cfgFor(m.baseUrl), env: {} }).judge(await request());
    expect(r.kind === "ok" && [r.out.verdict, r.out.confidence]).toEqual(["advise", 0.85]);
  });
  test("超时：服务端挂住 → timeout（AbortController），在预算内返回", async () => {
    const m = mockServer(() => new Promise<Response>(() => {}));
    const c = createJudgeClient({ cfg: cfgFor(m.baseUrl), env: {}, timeoutMs: { sync: 150, async: 150 } });
    const t0 = Date.now();
    const r = await c.judge(await request(true));
    expect(r.kind).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(c.stats.get("supervisor-judge")!.timeouts).toBe(1);
  });
  test("HTTP 500 / 429 → error；连不上（端口没人监听）→ error；都不抛异常", async () => {
    const m = mockServer(() => new Response("upstream exploded", { status: 500 }));
    expect((await createJudgeClient({ cfg: cfgFor(m.baseUrl), env: {} }).judge(await request())).kind).toBe("error");
    const m2 = mockServer(() => new Response("slow down", { status: 429 }));
    expect((await createJudgeClient({ cfg: cfgFor(m2.baseUrl), env: {} }).judge(await request())).kind).toBe("error");
    const dead = createJudgeClient({ cfg: cfgFor("http://127.0.0.1:1/v1"), env: {} });
    const r = await dead.judge(await request());
    expect(r.kind).toBe("error");
  });
  test("解析失败：异步重试 1 次后记 parse_fail；同步不重试；失败率可统计", async () => {
    const m = mockServer(() => chat("抱歉，我没法输出 JSON。"));
    const c = createJudgeClient({ cfg: cfgFor(m.baseUrl), env: {} });
    expect((await c.judge(await request(false))).kind).toBe("parse_fail");
    expect(m.seen).toHaveLength(2);
    expect((await c.judge(await request(true))).kind).toBe("parse_fail");
    expect(m.seen).toHaveLength(3);
    expect(c.stats.get("supervisor-judge")).toMatchObject({ calls: 2, parseFail: 2 });
    expect(c.parseFailRate("supervisor-judge")).toBe(1);
  });
  test("路由：按 sync / 规则选模型（请求体里的 model 随之变化）", async () => {
    const m = mockServer(() => chat(JSON.stringify(GOOD)));
    const c = createJudgeClient({ cfg: cfgFor(m.baseUrl, { routes: [{ when: { sync: true }, model: "fast-judge" }] }), env: {} });
    await c.judge(await request(true));
    await c.judge(await request(false));
    expect(m.seen.map((x) => x.body.model)).toEqual(["fast-judge", "supervisor-judge"]);
  });
  test("请求里不含 key；提示里的不可信内容都在 <untrusted> 内且已脱敏", async () => {
    const SECRET = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const m = mockServer(() => chat(JSON.stringify(GOOD)));
    const s = new Sim();
    await s.prompt(`use ${SECRET}`);
    for (let i = 0; i < 3; i++) await s.bash(`curl -H "Authorization: Bearer abcdef0123456789tokenvalue" https://x.test ${SECRET}`, { fail: true, out: `denied ${SECRET} ${PYTEST_FAIL(i)}` });
    const c = createJudgeClient({ cfg: cfgFor(m.baseUrl, { api_key_env: "K" }), env: { K: "sk-live-REALKEY1234567890abcdef" } });
    await c.judge({ hits: [s.hitsOf("L1")[0]], sync: false, session: s.engine.tracker });
    const raw = JSON.stringify(m.seen[0].body);
    expect(raw).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(raw).not.toContain("abcdef0123456789tokenvalue");
    expect(raw).not.toContain("REALKEY");
    expect(m.seen[0].headers.authorization).toBe("Bearer sk-live-REALKEY1234567890abcdef"); // key 只在头里，且来自环境变量
  });
});

describe("Engine 集成：任何 judge 故障都 fail-open", () => {
  for (const [name, handler, expectAction] of [
    ["超时", () => new Promise<Response>(() => {}), "skip"],
    ["HTTP 500", () => new Response("x", { status: 500 }), "skip"],
    ["解析失败", () => chat("not json"), "ignore"],
  ] as const) {
    test(name, async () => {
      const m = mockServer(handler);
      const c = createJudgeClient({ cfg: cfgFor(m.baseUrl), env: {}, timeoutMs: { sync: 100, async: 100 } });
      const s = new Sim({ judge: c.judge, cfg: resolveConfig({ mode: "enforce" }) });
      await s.prompt("x");
      for (let i = 0; i < 4; i++) await s.bash("cat x.log", { out: "same" });
      const d = s.decisionsOf("L2")[0];
      expect(d.action).toBe(expectAction);
      expect(d.applied).toBe(false); // 没有 advise / block 被送出去
    });
  }
});
