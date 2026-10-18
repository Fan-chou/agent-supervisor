import { describe, expect, test } from "bun:test";
import { coerceOutput, extractContent, findJsonObject, normalizeConfidence, normalizeVerdict, parseJudgeContent, parseJudgeResponse, repairJson, stripWrappers } from "../src/judge/parse.ts";

const GOOD = { verdict: "advise", confidence: 0.82, category: "loop", message_to_agent: "同一错误已重复三次，建议先阅读报错再改。", reason: "r", evidence_steps: [3, 4], watch: [], done: false };
const j = (o: object) => JSON.stringify(o);

describe("§8.5 稳健解析：每种修复各一个用例", () => {
  test("干净的 JSON", () => {
    const r = parseJudgeContent(j(GOOD));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.out.verdict).toBe("advise");
      expect(r.out.confidence).toBe(0.82);
      expect(r.repairs).toEqual([]);
    }
  });
  test("1. content 是数组：把 text 部分拼起来", () => {
    const half = j(GOOD);
    const resp = { choices: [{ message: { content: [{ type: "text", text: half.slice(0, 30) }, { type: "text", text: half.slice(30) }] } }] };
    expect(extractContent(resp)).toBe(half);
    expect(parseJudgeResponse(resp).ok).toBe(true);
    expect(extractContent({ choices: [] })).toBeNull();
    expect(extractContent({ choices: [{ message: { content: null } }] })).toBeNull();
  });
  test("2a. 去掉 <think> 推理块", () => {
    const r = parseJudgeContent(`<think>let me think {"verdict":"block"} maybe</think>\n${j(GOOD)}`);
    expect(r.ok && r.out.verdict).toBe("advise");
    expect(r.repairs).toContain("strip-think");
  });
  test("2a'. 只有结尾标签（开头被截掉）的推理块", () => {
    const r = parseJudgeContent(`reasoning about {stuff}...</think>${j(GOOD)}`);
    expect(r.ok && r.out.verdict).toBe("advise");
  });
  test("2b. 代码块包裹", () => {
    const r = parseJudgeContent("```json\n" + j(GOOD) + "\n```");
    expect(r.ok).toBe(true);
    expect(r.repairs).toContain("strip-fence");
    expect(parseJudgeContent("```\n" + j(GOOD) + "\n```").ok).toBe(true);
  });
  test("3a. JSON 前后有散文", () => {
    const r = parseJudgeContent(`Sure! Here is my verdict:\n\n${j(GOOD)}\n\nLet me know if you need more.`);
    expect(r.ok && r.out.category).toBe("loop");
  });
  test("3b. 字符串里含 } 和 { 时括号配平按字符串状态走", () => {
    const o = { ...GOOD, message_to_agent: "对象 {a: 1} 的 } 括号出现在文本里，不要在这里截断。" };
    const r = parseJudgeContent(`prefix ${j(o)} suffix {not json}`);
    expect(r.ok && r.out.message_to_agent).toBe(o.message_to_agent);
    const f = findJsonObject('{"a": "x}y", "b": {"c": 1}} tail');
    expect(f).toEqual({ text: '{"a": "x}y", "b": {"c": 1}}', balanced: true });
  });
  test("3c. 转义引号不影响配平", () => {
    const o = { ...GOOD, message_to_agent: 'agent 写了 "}" 这样的字符串 \\ 和引号 \\"，没有问题吧。' };
    const r = parseJudgeContent(j(o));
    expect(r.ok && r.out.message_to_agent).toBe(o.message_to_agent);
  });
  test("4a. 尾随逗号", () => {
    const r = parseJudgeContent('{"verdict":"advise","confidence":0.9,"category":"loop","message_to_agent":"这是一条足够长的建议信息。","reason":"r","evidence_steps":[1,2,],"watch":[],"done":false,}');
    expect(r.ok).toBe(true);
    expect(r.repairs).toContain("trailing-commas");
  });
  test("4b. 单引号键名和值", () => {
    const r = parseJudgeContent("{'verdict': 'advise', 'confidence': 0.7, 'category': 'loop', 'message_to_agent': '这是一条足够长的建议信息。', 'reason': 'r', 'evidence_steps': [1], 'watch': [], 'done': false}");
    expect(r.ok && r.out.verdict).toBe("advise");
    expect(r.repairs).toContain("single-quote-keys");
  });
  test("4c. 中文引号", () => {
    const r = parseJudgeContent("{“verdict”: “advise”, “confidence”: 0.7, “category”: “loop”, “message_to_agent”: “这是一条足够长的建议信息。”, “reason”: “r”, “evidence_steps”: [1], “watch”: [], “done”: false}");
    expect(r.ok && r.out.message_to_agent).toBe("这是一条足够长的建议信息。");
    expect(r.repairs).toContain("curly-quotes");
  });
  test("4d. 末尾被截断：补全括号", () => {
    const cut = j(GOOD).slice(0, -1); // 缺最后的 }
    const r = parseJudgeContent(cut);
    expect(r.ok).toBe(true);
    expect(r.repairs).toContain("close-truncated");
    const cut2 = '{"verdict":"advise","confidence":0.9,"category":"loop","message_to_agent":"这是一条足够长的建议信息。","reason":"r","evidence_steps":[1,2';
    const r2 = parseJudgeContent(cut2);
    expect(r2.ok && r2.out.evidence_steps).toEqual([1, 2]);
  });
  test("4e. 截断在字符串中间", () => {
    const r = parseJudgeContent('{"verdict":"advise","confidence":0.9,"category":"loop","message_to_agent":"这是一条足够长的建议信息，后面被截');
    expect(r.ok && r.out.message_to_agent).toContain("被截");
  });
  test("4f. Python 风格 True/False/None 和无引号键名", () => {
    const r = parseJudgeContent("{verdict: 'advise', confidence: 0.8, category: 'loop', message_to_agent: '这是一条足够长的建议信息。', reason: 'r', evidence_steps: [], watch: [], done: True}");
    expect(r.ok && r.out.done).toBe(true);
  });
  test("5a. verdict 同义词", () => {
    for (const [s, v] of [["allow", "ignore"], ["PASS", "ignore"], ["Warn", "advise"], ["suggest", "advise"], ["deny", "block"], ["stop", "block"], [" Block ", "block"]] as const) {
      expect(normalizeVerdict(s)).toBe(v);
    }
    expect(normalizeVerdict("maybe")).toBeNull();
    const r = parseJudgeContent(j({ ...GOOD, verdict: "warn" }));
    expect(r.ok && r.out.verdict).toBe("advise");
    expect(r.repairs).toContain("verdict-synonym");
  });
  test("5b. confidence 是字符串/百分数", () => {
    expect(normalizeConfidence("85%")).toBe(0.85);
    expect(normalizeConfidence("0.7")).toBe(0.7);
    expect(normalizeConfidence(" 90 ")).toBe(0.9);
    expect(normalizeConfidence("high")).toBe(0.9);
    expect(normalizeConfidence(85)).toBe(0.85);
    expect(normalizeConfidence(1.5)).toBeCloseTo(0.015); // (1,100] 一律按百分数理解
    expect(normalizeConfidence(-3)).toBe(0);
    expect(normalizeConfidence("n/a")).toBeNull();
    const r = parseJudgeContent(j({ ...GOOD, confidence: "85%" }));
    expect(r.ok && r.out.confidence).toBe(0.85);
  });
});

describe("最终失败 → parse_fail 的各种原因", () => {
  test("没有 JSON / 不是对象 / 无法修复", () => {
    expect(parseJudgeContent("I think the agent is fine.").ok).toBe(false);
    expect(parseJudgeContent("[1,2,3]").ok).toBe(false);
    const bad = parseJudgeContent("{ this is : not [ valid json at all ");
    expect(bad.ok).toBe(false);
  });
  test("verdict 无法识别", () => {
    const r = parseJudgeContent(j({ ...GOOD, verdict: "maybe" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad-verdict");
  });
  test("响应没有 content", () => {
    expect(parseJudgeResponse({ error: "x" }).ok).toBe(false);
  });
});

describe("§8.4 本地语义校验", () => {
  test("confidence 限制在 0–1", () => {
    const r = coerceOutput({ ...GOOD, confidence: 7 });
    expect(r.ok && r.out.confidence).toBeLessThanOrEqual(1);
    expect(coerceOutput({ ...GOOD, confidence: -1 }).ok).toBe(true);
    const missing = coerceOutput({ ...GOOD, confidence: undefined });
    expect(missing.ok && missing.out.confidence).toBe(0.5); // 缺失给中间值，低于拦截门槛，不会因此拦截
  });
  test("verdict 不是 ignore 时 message 必须非空，且 ≤600", () => {
    expect(coerceOutput({ ...GOOD, message_to_agent: null }).ok).toBe(false);
    expect(coerceOutput({ ...GOOD, message_to_agent: "   " }).ok).toBe(false);
    expect(coerceOutput({ ...GOOD, verdict: "ignore", message_to_agent: null }).ok).toBe(true);
    const long = coerceOutput({ ...GOOD, message_to_agent: "长".repeat(900) });
    expect(long.ok && long.out.message_to_agent!.length).toBeLessThanOrEqual(600);
    expect(long.repairs).toContain("message-truncated");
  });
  test("watch：最多 3 条", () => {
    const w = (i: number) => ({ rule: "L1", text_contains: "error " + i, tool: null, ttl_steps: 5 });
    const r = coerceOutput({ ...GOOD, watch: [w(1), w(2), w(3), w(4), w(5)] });
    expect(r.ok && r.out.watch).toHaveLength(3);
  });
  test("watch：text_contains 为 null 或长度 ≥3，否则丢弃", () => {
    const r = coerceOutput({ ...GOOD, watch: [{ rule: "L1", text_contains: "ab", tool: null, ttl_steps: 5 }, { rule: "L1", text_contains: "abc", tool: null, ttl_steps: 5 }, { rule: "L1", text_contains: null, tool: "Bash", ttl_steps: 5 }] });
    expect(r.ok && r.out.watch.map((x) => x.text_contains)).toEqual(["abc", null]);
  });
  test("watch：ttl_steps 取 1–50", () => {
    const r = coerceOutput({ ...GOOD, watch: [{ rule: "L1", text_contains: "xyz", tool: null, ttl_steps: 500 }, { rule: "L2", text_contains: "xyz", tool: null, ttl_steps: 0 }, { rule: "L3", text_contains: "xyz", tool: null, ttl_steps: "7" }] });
    expect(r.ok && r.out.watch.map((x) => x.ttl_steps)).toEqual([50, 1, 7]);
  });
  test("watch：通配监视器（rule 为 *，且 text 和 tool 都为空）直接丢弃", () => {
    const r = coerceOutput({ ...GOOD, watch: [{ rule: "*", text_contains: null, tool: null, ttl_steps: 10 }, { rule: "*", text_contains: "boom", tool: null, ttl_steps: 10 }] });
    expect(r.ok && r.out.watch).toHaveLength(1);
    expect(r.repairs).toContain("drop-wildcard-watch");
  });
  test("未知 category → other", () => {
    const r = coerceOutput({ ...GOOD, category: "weird-stuff" });
    expect(r.ok && r.out.category).toBe("other");
    expect(coerceOutput({ ...GOOD, category: "Over-Testing" }).ok && (coerceOutput({ ...GOOD, category: "Over-Testing" }) as { out: { category: string } }).out.category).toBe("over_testing");
  });
  test("done 与 evidence_steps 的宽松映射", () => {
    const r = coerceOutput({ ...GOOD, done: "true", evidence_steps: ["#3", "4", "x", 5.5] });
    expect(r.ok && r.out.done).toBe(true);
    expect(r.ok && r.out.evidence_steps).toEqual([3, 4]);
  });
});

describe("辅助函数", () => {
  test("stripWrappers / repairJson 单独可用", () => {
    expect(stripWrappers("<think>x</think>{}").text).toBe("{}");
    expect(repairJson("{'a': 1,}").text).toBe('{"a": 1}');
  });
});
