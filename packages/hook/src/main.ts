#!/usr/bin/env bun
// sv-hook 入口：bun build --compile 之后固定放在 ~/.agent-supervisor/bin/sv-hook，hook 命令永远指向这个固定路径。
import { runHook } from "./hook.ts";

const stdin = await Bun.stdin.text();
const timeout = process.env.SV_HOOK_TIMEOUT_MS ? Number(process.env.SV_HOOK_TIMEOUT_MS) : undefined;
const r = await runHook(stdin, { timeoutMs: Number.isFinite(timeout) ? timeout : undefined });
if (r.stdout) process.stdout.write(r.stdout + "\n");
process.exit(0); // 任何情况下都是 0：永远不因为监督自己的问题阻断 agent
