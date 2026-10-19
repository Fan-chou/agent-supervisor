import { expect, test } from "bun:test";
import { hookCommandPrefix } from "../src/install";

test("Windows：反斜杠转正斜杠并加引号（含空格与否都加）", () => {
  expect(hookCommandPrefix("C:\\Users\\a b\\AppData\\Local\\agent-supervisor\\bin\\sv-hook.exe", "win32")).toBe('"C:/Users/a b/AppData/Local/agent-supervisor/bin/sv-hook.exe"');
  expect(hookCommandPrefix("C:\\sv\\sv-hook.exe", "win32")).toBe('"C:/sv/sv-hook.exe"');
  expect(hookCommandPrefix("C:/sv/sv-hook.exe", "win32")).toBe('"C:/sv/sv-hook.exe"');
});

test("非 Windows：只在含空格时加引号，反斜杠不动", () => {
  expect(hookCommandPrefix("~/.agent-supervisor/bin/sv-hook", "darwin")).toBe("~/.agent-supervisor/bin/sv-hook");
  expect(hookCommandPrefix("/Users/x/Library/Application Support/a/sv-hook", "darwin")).toBe('"/Users/x/Library/Application Support/a/sv-hook"');
  expect(hookCommandPrefix("/a\\b/sv-hook", "linux")).toBe("/a\\b/sv-hook");
});

test("拼成的命令串经 JSON 往返不变", () => {
  const cmd = `${hookCommandPrefix("C:\\a b\\sv-hook.exe", "win32")} claude`;
  expect(JSON.parse(JSON.stringify({ command: cmd })).command).toBe('"C:/a b/sv-hook.exe" claude');
});
