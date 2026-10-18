#!/usr/bin/env bun
// sv-hook 入口：bun build --compile 之后固定放在 ~/.agent-supervisor/bin/sv-hook，hook 命令永远指向这个固定路径。
// 同一个二进制服务两个工具：`sv-hook`（或 `sv-hook claude`）给 Claude Code，`sv-hook codex` 给 Codex。
import { resolveHarness, runHook } from "./hook.ts";

const stdin = await Bun.stdin.text();
const timeout = process.env.SV_HOOK_TIMEOUT_MS ? Number(process.env.SV_HOOK_TIMEOUT_MS) : undefined;
let harness: ReturnType<typeof resolveHarness> | undefined;
const argv = process.argv.slice(2);
if (argv.some((a) => a === "codex" || a === "claude" || a.startsWith("--harness="))) harness = resolveHarness(argv, {});
const r = await runHook(stdin, { harness, timeoutMs: Number.isFinite(timeout) ? timeout : undefined, dump: process.env.SV_HOOK_DUMP === "1" });
if (r.stdout) process.stdout.write(r.stdout + "\n");
process.exit(0); // 任何情况下都是 0：永远不因为监督自己的问题阻断 agent
