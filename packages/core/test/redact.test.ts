import { describe, expect, test } from "bun:test";
import { headTail, redact, redactDeep } from "../src/redact.ts";

const secrets: [string, string][] = [
  ["openai", "key is sk-proj-abcdEFGH1234567890abcdEFGH"],
  ["anthropic", "ANTHROPIC sk-ant-api03-AbCdEfGhIjKlMnOp"],
  ["ghp", "token ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
  ["gh pat", "github_pat_11ABCDEFG0abcdefghijklmnop_xyz"],
  ["aws", "AKIAIOSFODNN7EXAMPLE"],
  ["slack", "xoxb-1234567890-abcdefghij"],
  ["bearer", "Authorization: Bearer abcdef1234567890xyz"],
  ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123456"],
  ["google", "AIzaSyA-1234567890abcdefghijklmnopqrstuv"],
];

describe("redact", () => {
  for (const [name, s] of secrets) {
    test(name, () => {
      const out = redact(s);
      expect(out).toContain("[REDACTED");
      expect(out).not.toMatch(/sk-proj-abcd|ghp_abcdef|AKIAIOSFODNN7|1234567890-abcdefghij|abcdef1234567890xyz|AbCdEfGhIjKl|eyJzdWIi|AIzaSyA-12345|github_pat_11AB/);
    });
  }
  test("PEM 私钥块", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----\nafter";
    const out = redact(pem);
    expect(out).not.toContain("MIIEow");
    expect(out).toContain("after");
  });
  test("未闭合的 PEM 块吞到末尾", () => {
    expect(redact("-----BEGIN PRIVATE KEY-----\nMIIEvQ")).not.toContain("MIIEvQ");
  });
  test("*_KEY= / *_TOKEN= / password= 保留变量名", () => {
    expect(redact("STRIPE_SECRET_KEY=whsec_abc123def")).toBe("STRIPE_SECRET_KEY=[REDACTED:secret-assignment]");
    expect(redact("export GITHUB_TOKEN=abcd1234")).toContain("GITHUB_TOKEN=[REDACTED");
    expect(redact("password=hunter2 user=bob")).toBe("password=[REDACTED:password] user=bob");
    expect(redact('{"api_key": "abc12345"}')).not.toContain("abc12345");
  });
  test("纯数字的值不当作密钥（token 用量等统计字段保持原样）", () => {
    expect(redact(JSON.stringify({ usage: { prompt_tokens: 1200, completion_tokens: 80 } }))).toBe(JSON.stringify({ usage: { prompt_tokens: 1200, completion_tokens: 80 } }));
    expect(redact("max_tokens=800 API_KEY=abc12345")).toBe("max_tokens=800 API_KEY=[REDACTED:secret-assignment]");
  });
  test("URL 里的口令", () => {
    const out = redact("postgres://admin:s3cretpw@db.local:5432/app");
    expect(out).not.toContain("s3cretpw");
    expect(out).toContain("admin:");
    expect(out).toContain("@db.local");
  });
  test("普通文本不变", () => {
    const t = "pytest tests/test_a.py::test_x passed in 1.2s; token count: n/a";
    expect(redact(t)).toBe(t);
  });
  test("幂等", () => {
    const once = redact("API_KEY=abcdef123 and Bearer xyzxyzxyzxyz");
    expect(redact(once)).toBe(once);
  });
  test("redactDeep：嵌套对象与敏感键名", () => {
    const o = redactDeep({ cmd: "echo sk-abcdefghijklmnopqrstuvwx", env: { OPENAI_API_KEY: "zzz", PATH: "/bin" }, list: ["Bearer abcdefghijkl"] });
    expect(JSON.stringify(o)).not.toMatch(/abcdefghijkl|zzz/);
    expect(o.env.PATH).toBe("/bin");
  });
});

describe("headTail", () => {
  test("短文本原样", () => {
    expect(headTail("abc", 1000)).toEqual({ head: "abc", tail: "", truncated: false });
  });
  test("长文本保留头尾各 n", () => {
    const t = "a".repeat(1000) + "m".repeat(5000) + "z".repeat(1000);
    const r = headTail(t, 1000);
    expect(r.head).toBe("a".repeat(1000));
    expect(r.tail).toBe("z".repeat(1000));
    expect(r.truncated).toBe(true);
  });
});
