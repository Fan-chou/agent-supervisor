import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeWsFingerprint, definitelyUnchanged, wsStringUnchanged, wsToString } from "../src/wsfp.ts";

let repo: string;
let plain: string;

function sh(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(args.join(" ") + ": " + r.stderr.toString());
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "sv-wsfp-git-"));
  plain = mkdtempSync(join(tmpdir(), "sv-wsfp-plain-"));
  sh(repo, "git", "init", "-q");
  sh(repo, "git", "config", "user.email", "t@example.com");
  sh(repo, "git", "config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "one\n");
  sh(repo, "git", "add", "a.txt");
  sh(repo, "git", "commit", "-q", "-m", "init");
});
afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(plain, { recursive: true, force: true });
});

describe("工作区指纹", () => {
  test("非 git 目录被识别", async () => {
    const w = await computeWsFingerprint(plain);
    expect(w.kind).toBe("non-git");
    expect(definitelyUnchanged(w, w)).toBe(false); // 非 git 永远不能断言「没改动」
    expect(wsToString(w)).toBe("non-git");
  });
  test("git 目录无改动：两次相同", async () => {
    const a = await computeWsFingerprint(repo);
    const b = await computeWsFingerprint(repo);
    expect(a.kind).toBe("git");
    expect(a.fp).toBe(b.fp);
    expect(definitelyUnchanged(a, b)).toBe(true);
  });
  test("修改已跟踪文件 → 变化；还原后回到原值", async () => {
    const a = await computeWsFingerprint(repo);
    writeFileSync(join(repo, "a.txt"), "two\n");
    const b = await computeWsFingerprint(repo);
    expect(b.fp).not.toBe(a.fp);
    expect(definitelyUnchanged(a, b)).toBe(false);
    writeFileSync(join(repo, "a.txt"), "one\n");
    const c = await computeWsFingerprint(repo);
    expect(c.fp).toBe(a.fp);
  });
  test("未跟踪文件：新增 / 改内容（mtime、size）都被感知", async () => {
    const a = await computeWsFingerprint(repo);
    const f = join(repo, "new.txt");
    writeFileSync(f, "x");
    const b = await computeWsFingerprint(repo);
    expect(b.fp).not.toBe(a.fp);
    writeFileSync(f, "xy");
    const c = await computeWsFingerprint(repo);
    expect(c.fp).not.toBe(b.fp);
    const t = new Date(Date.now() + 5000);
    utimesSync(f, t, t);
    const d = await computeWsFingerprint(repo);
    expect(d.fp).not.toBe(c.fp);
    rmSync(f);
    const e = await computeWsFingerprint(repo);
    expect(e.fp).toBe(a.fp);
  });
  test("暂存区变化也算改动", async () => {
    const a = await computeWsFingerprint(repo);
    writeFileSync(join(repo, "a.txt"), "staged\n");
    sh(repo, "git", "add", "a.txt");
    const b = await computeWsFingerprint(repo);
    expect(b.fp).not.toBe(a.fp);
    sh(repo, "git", "reset", "-q", "--hard");
  });
  test("超时 → kind=timeout，不能断言没改动", async () => {
    const w = await computeWsFingerprint(repo, { timeoutMs: 0 });
    expect(["timeout", "git"]).toContain(w.kind); // 0ms 几乎必然超时；极端情况下可能已完成
    if (w.kind === "timeout") expect(definitelyUnchanged(w, w)).toBe(false);
  });
  test("不存在的目录 → 不抛异常", async () => {
    const w = await computeWsFingerprint(join(plain, "nope"));
    expect(["non-git", "error", "timeout"]).toContain(w.kind);
  });
  test("字符串比较", () => {
    expect(wsStringUnchanged("abc", "abc")).toBe(true);
    expect(wsStringUnchanged("abc", "abd")).toBe(false);
    expect(wsStringUnchanged("non-git", "non-git")).toBe(false);
    expect(wsStringUnchanged("timeout", "timeout")).toBe(false);
    expect(wsStringUnchanged(undefined, "abc")).toBe(false);
  });
});
