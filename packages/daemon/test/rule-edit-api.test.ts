// PUT /v1/rules/{id}：整个守护进程唯一的写接口（decisions #101）。
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogStore, defaultConfig, resolveConfig, saveRuleEdits } from "@sv/core";
import { Daemon, startDaemon } from "../src/index.ts";
import { schemaFor } from "../src/schemas.ts";
import { validate } from "./helpers/validate.ts";

const dirs: string[] = [];
const daemons: Daemon[] = [];
afterEach(async () => {
  while (daemons.length) await daemons.pop()!.stop();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const mkHome = () => {
  const h = mkdtempSync(join(tmpdir(), "sv-re-"));
  dirs.push(h);
  return h;
};
async function boot(home = mkHome(), over: Record<string, unknown> = {}, port?: number) {
  const d = await startDaemon({ cfg: resolveConfig(over, defaultConfig()), home, dbPath: join(home, "state.db"), socketPath: join(home, "sock"), port });
  daemons.push(d);
  return { d, home };
}
const JSONH = { "content-type": "application/json" };
const put = (d: Daemon, id: string, body: unknown, headers: Record<string, string> = JSONH) => fetch(`http://localhost/v1/rules/${id}`, { unix: d.socketPath!, method: "PUT", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
const get = async (d: Daemon, p: string) => (await fetch(`http://localhost${p}`, { unix: d.socketPath! })).json() as Promise<any>;
const post = (d: Daemon, sid: string, extra: Record<string, unknown>) => fetch("http://localhost/v1/hook", { unix: d.socketPath!, method: "POST", body: JSON.stringify({ harness: "claude", payload: { session_id: sid, cwd: "/tmp", ...extra } }) });
const ruleOf = async (d: Daemon, id: string) => (await get(d, "/v1/rules")).rules.find((r: any) => r.id === id);

describe("POST /v1/config/validate 与 /v1/config 的 sources", () => {
  const validateReq = (d: Daemon, body: string, ct = "text/yaml") => fetch("http://localhost/v1/config/validate", { unix: d.socketPath!, method: "POST", headers: { "content-type": ct }, body });
  test("YAML 文本 / {yaml} 两种请求；返回 valid、diff、enablesBlocking；符合 schema；不应用、不写任何东西", async () => {
    const { d, home } = await boot();
    const r = await validateReq(d, "mode: enforce\nthresholds:\n  L2_repeat: 5\n");
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(validate(schemaFor("ConfigValidation")!, j)).toEqual([]);
    expect(j).toMatchObject({ valid: true, enablesBlocking: true });
    expect(j.diff).toEqual([{ path: "mode", from: "shadow", to: "enforce" }, { path: "thresholds.L2_repeat", from: 4, to: 5 }]);
    const j2 = (await (await validateReq(d, JSON.stringify({ yaml: "thresholds:\n  L2_repeat: 5\n" }), "application/json")).json()) as any;
    expect(j2.valid).toBe(true);
    // 没有任何副作用
    expect(d.cfg.mode).toBe("shadow");
    expect(d.cfg.thresholds.L2_repeat).toBe(4);
    expect(existsSync(join(home, "rules.local.json"))).toBe(false);
    expect(existsSync(join(home, "rules-edits.jsonl"))).toBe(false);
  });
  test("无效草稿仍是 200（valid:false + errors）；请求形态错误才是 4xx", async () => {
    const { d } = await boot();
    expect(((await (await validateReq(d, "mode: yolo\n")).json()) as any)).toMatchObject({ valid: false });
    expect((await validateReq(d, "x", "application/octet-stream")).status).toBe(415);
    expect((await validateReq(d, "{oops", "application/json")).status).toBe(400);
    expect((await validateReq(d, JSON.stringify({ nope: 1 }), "application/json")).status).toBe(400);
    expect((await validateReq(d, "a: " + "b".repeat(80_000))).status).toBe(413);
  });
  test("/v1/config 带 sources：编辑规则后对应叶子变成 rules.local，其余 default / configured", async () => {
    const { d } = await boot(undefined, { thresholds: { L3_repeat: 5 } });
    let c = await get(d, "/v1/config");
    expect(validate(schemaFor("ConfigView")!, c)).toEqual([]);
    expect(c.sources["thresholds.L3_repeat"]).toBe("configured");
    expect(c.sources["thresholds.L2_repeat"]).toBe("default");
    await put(d, "L2", { thresholds: { repeat: 6 } });
    c = await get(d, "/v1/config");
    expect(c.sources["thresholds.L2_repeat"]).toBe("rules.local");
    expect(c.config.thresholds.L2_repeat).toBe(6);
    expect(c.config.mode).toBe("shadow");
  });
  test("HTTP 无 token → 401", async () => {
    const { d } = await boot(undefined, {}, 0);
    expect((await fetch(`http://127.0.0.1:${d.port}/v1/config/validate`, { method: "POST", headers: { "content-type": "text/yaml" }, body: "" })).status).toBe(401);
  });
});

describe("PUT /v1/rules/{id}", () => {
  test("改阈值：200，返回新的规则视图（符合 schema）、变更清单、appliesTo=new_sessions；GET /v1/rules 马上反映；写出 rules.local.json（0600）和审计行", async () => {
    const { d, home } = await boot();
    const r = await put(d, "L2", { thresholds: { repeat: 6 } });
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j).toMatchObject({ ok: true, appliesTo: "new_sessions", rule: { id: "L2", edited: true, thresholds: { repeat: 6 } } });
    expect(validate(schemaFor("Rule")!, j.rule)).toEqual([]);
    expect(j.changes).toEqual([{ what: "thresholds", from: { repeat: 4, window_steps: 12 }, to: { repeat: 6, window_steps: 12 } }]);
    expect((await ruleOf(d, "L2")).thresholds.repeat).toBe(6);
    expect((await ruleOf(d, "L3")).edited).toBe(false);
    const file = join(home, "rules.local.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, edits: { L2: { set: { "thresholds.L2_repeat": 6 } } } });
    const audit = readFileSync(join(home, "rules-edits.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ rule: "L2", via: "uds", actor: "api", request: { thresholds: { repeat: 6 } } });
    expect(statSync(join(home, "rules-edits.jsonl")).mode & 0o777).toBe(0o600);
  });
  test("停用 / 恢复默认；x-sv-actor 进审计（只保留安全字符）", async () => {
    const { d, home } = await boot();
    expect((await put(d, "S1", { disabled: true }, { ...JSONH, "x-sv-actor": "jack<script>" })).status).toBe(200);
    expect((await ruleOf(d, "S1")).disabled).toBe(true);
    expect((await put(d, "S1", { reset: true })).status).toBe(200);
    const s1 = await ruleOf(d, "S1");
    expect(s1).toMatchObject({ disabled: false, edited: false });
    const audit = readFileSync(join(home, "rules-edits.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit[0].actor).toBe("jackscript");
    expect(JSON.parse(readFileSync(join(home, "rules.local.json"), "utf8")).edits).toEqual({});
  });
  test("校验失败：未知规则 404；X2 403；未知字段 / 非法值 / 阶梯不单调 400，并给出原因；文件和内存都不变", async () => {
    const { d, home } = await boot();
    const cases: [string, unknown, number, string][] = [
      ["ZZ", { disabled: true }, 404, "unknown_rule"],
      ["X2", { disabled: true }, 403, "protected_rule"],
      ["L2", { mode: "enforce" }, 400, "unknown_field"],
      ["L2", { thresholds: { repeat: -1 } }, 400, "invalid_threshold"],
      ["L2", { thresholds: { repeat: "9" } }, 400, "invalid_threshold"],
      ["T2", { thresholds: { ladder: { advise: 99 } } }, 400, "inconsistent_thresholds"],
      ["L2", {}, 400, "empty_edit"],
    ];
    for (const [id, body, status, code] of cases) {
      const r = await put(d, id, body);
      expect(r.status, `${id} ${JSON.stringify(body)}`).toBe(status);
      const j = (await r.json()) as any;
      expect(j.error.code).toBe(code);
      expect(j.error.message.length).toBeGreaterThan(0);
    }
    expect(existsSync(join(home, "rules.local.json"))).toBe(false);
    expect(existsSync(join(home, "rules-edits.jsonl"))).toBe(false);
    expect((await ruleOf(d, "L2")).thresholds.repeat).toBe(4);
    expect(d.cfg.mode).toBe("shadow");
  });
  test("请求形态：非 JSON 内容类型 415；坏 JSON 400；带 Origin 403；过大 413；GET/POST/DELETE 不是编辑路径", async () => {
    const { d } = await boot();
    expect((await put(d, "L2", "{}", { "content-type": "text/plain" })).status).toBe(415);
    expect((await put(d, "L2", "{oops", JSONH)).status).toBe(400);
    expect((await put(d, "L2", { thresholds: { repeat: 5 } }, { ...JSONH, origin: "http://evil.example" })).status).toBe(403);
    expect((await put(d, "L2", JSON.stringify({ thresholds: { repeat: 5 }, pad: "x".repeat(20_000) }))).status).toBe(413);
    expect((await ruleOf(d, "L2")).thresholds.repeat).toBe(4); // 上面全部被拒，没有任何生效
    for (const method of ["POST", "DELETE", "PATCH"]) expect((await fetch("http://localhost/v1/rules/L2", { unix: d.socketPath!, method, headers: JSONH, body: "{}" })).status, method).toBe(404);
  });
  test("HTTP：没有 token 401；有 token 可以编辑", async () => {
    const { d, home } = await boot(undefined, {}, 0);
    const url = `http://127.0.0.1:${d.port}/v1/rules/L3`;
    expect((await fetch(url, { method: "PUT", headers: JSONH, body: JSON.stringify({ disabled: true }) })).status).toBe(401);
    const token = readFileSync(join(home, "token"), "utf8").trim();
    const r = await fetch(url, { method: "PUT", headers: { ...JSONH, authorization: `Bearer ${token}` }, body: JSON.stringify({ disabled: true }) });
    expect(r.status).toBe(200);
    expect(JSON.parse(readFileSync(join(home, "rules-edits.jsonl"), "utf8").trim()).via).toBe("http");
  });
  test("重启后覆盖仍在（启动时叠在启动配置之上）；损坏的文件被忽略，守护进程照常启动", async () => {
    const { d, home } = await boot();
    await put(d, "L2", { thresholds: { repeat: 7 } });
    await put(d, "S1", { disabled: true });
    await d.stop();
    daemons.pop();
    const { d: d2 } = await boot(home);
    expect(await ruleOf(d2, "L2")).toMatchObject({ edited: true, thresholds: { repeat: 7 } });
    expect((await ruleOf(d2, "S1")).disabled).toBe(true);
    await d2.stop();
    daemons.pop();
    writeFileSync(join(home, "rules.local.json"), "{not json");
    const { d: d3 } = await boot(home);
    expect((await ruleOf(d3, "L2")).thresholds.repeat).toBe(4);
  });
  test("只对之后新建的会话生效：已有会话用旧阈值，新会话用新阈值", async () => {
    const { d } = await boot();
    const seq = async (sid: string, n: number) => {
      const results: any[] = [];
      for (let i = 0; i < n; i++) {
        await post(d, sid, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo same" }, tool_use_id: `${sid}-${i}` });
        await post(d, sid, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "echo same" }, tool_response: { stdout: "same" }, tool_use_id: `${sid}-${i}` });
      }
      return results;
    };
    const countL2 = (sid: string) => (d.store.db.query("SELECT COUNT(*) AS n FROM hits WHERE rule_id = 'L2' AND session_id = ?").get(sid) as { n: number }).n;
    await post(d, "old", { hook_event_name: "UserPromptSubmit", prompt: "go" }); // 先建会话（此时 L2 阈值 = 4）
    expect((await put(d, "L2", { thresholds: { repeat: 2 } })).status).toBe(200);
    await post(d, "new", { hook_event_name: "UserPromptSubmit", prompt: "go" }); // 编辑之后新建（L2 阈值 = 2）
    await seq("old", 3);
    await seq("new", 3);
    expect(countL2("old")).toBe(0); // 旧会话仍按 4：3 次不触发
    expect(countL2("new")).toBeGreaterThan(0); // 新会话按 2：触发
    // 每条命中记录当时用的阈值（日志里的事实来源）
    const th = d.store.db.query("SELECT threshold_json FROM hits WHERE rule_id = 'L2' AND session_id = 'new' LIMIT 1").get() as { threshold_json: string };
    expect(JSON.parse(th.threshold_json)).toMatchObject({ repeat: 2 });
  });
  test("命令行（sv rules）改了 rules.local.json：守护进程在下一个新会话前重新读取，不用重启；API 编辑不会覆盖掉它", async () => {
    const { d, home } = await boot();
    const file = join(home, "rules.local.json");
    expect((await ruleOf(d, "L3")).thresholds.repeat).toBe(3);
    saveRuleEdits(file, { L3: { set: { "thresholds.L3_repeat": 9 } } }); // 模拟 sv rules set L3 --threshold repeat=9
    expect((await ruleOf(d, "L3")).thresholds.repeat).toBe(3); // 还没有新会话触发重新读取
    await post(d, "fresh-1", { hook_event_name: "UserPromptSubmit", prompt: "hi" });
    expect(d.cfg.thresholds.L3_repeat).toBe(9);
    expect((await ruleOf(d, "L3"))).toMatchObject({ edited: true, thresholds: { repeat: 9 } });
    // API 编辑另一条规则：文件里命令行写的那条保留
    expect((await put(d, "S1", { disabled: true })).status).toBe(200);
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8")).edits).sort()).toEqual(["L3", "S1"]);
    // 命令行再改一次（含删除），API 编辑前同样以文件为准
    saveRuleEdits(file, { S1: { disabled: true } });
    expect((await put(d, "L2", { thresholds: { repeat: 7 } })).status).toBe(200);
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8")).edits).sort()).toEqual(["L2", "S1"]);
    expect(d.cfg.thresholds.L3_repeat).toBe(3);
    // 文件被写坏：保持内存里的配置，不崩
    writeFileSync(file, "{oops");
    await post(d, "fresh-2", { hook_event_name: "UserPromptSubmit", prompt: "hi" });
    expect(d.cfg.thresholds.L2_repeat).toBe(7);
  });
  test("写文件失败 → 500，内存配置不变（把 home 变成只读）", async () => {
    const { d, home } = await boot();
    chmodSync(home, 0o500);
    try {
      const r = await put(d, "L2", { thresholds: { repeat: 6 } });
      if (r.status === 500) {
        expect(((await r.json()) as any).error.code).toBe("write_failed");
        expect((await ruleOf(d, "L2")).thresholds.repeat).toBe(4);
      } else {
        expect(r.status).toBe(200); // 以 root 运行时目录权限不起作用，则这条用例退化为成功路径
      }
    } finally {
      chmodSync(home, 0o700);
    }
  });
  test("并发编辑被串行化：同时对不同规则的 20 次编辑全部落盘，文件里一条不少", async () => {
    const { d, home } = await boot();
    const ids = ["L2", "L3", "L4", "L6", "S1", "S2", "S3", "S4", "P4", "P6"];
    const rs = await Promise.all([...ids, ...ids].map((id, i) => put(d, id, { disabled: i < 10 })));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    const edits = JSON.parse(readFileSync(join(home, "rules.local.json"), "utf8")).edits;
    expect(Object.keys(edits).sort()).toEqual([...ids].sort());
    expect(readFileSync(join(home, "rules-edits.jsonl"), "utf8").trim().split("\n")).toHaveLength(20);
  });
  test("规则编辑不影响 hook 路径与 mode：编辑后 hook 仍 200、shadow 仍不拦截（X2 危险命令只记 would_have_blocked）", async () => {
    const { d, home } = await boot();
    await put(d, "L2", { thresholds: { repeat: 2 } });
    const r = await post(d, "s", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git reset --hard HEAD~1" }, tool_use_id: "x" });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).delivery).toBeNull();
    await d.stop();
    daemons.pop();
    const s = new LogStore(join(home, "state.db"));
    expect(s.db.query("SELECT d.outcome FROM decisions d JOIN hits h ON h.id = d.hit_id WHERE h.rule_id = 'X2'").all()).toEqual([{ outcome: "would_have_blocked" }]);
  });
});
