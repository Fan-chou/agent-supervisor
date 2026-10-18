// Codex 载荷/rollout 共用的解析逻辑。replay 读取器和 hook 适配器都从这里取，避免两套实现（依赖方向：replay → adapter-codex）。

/** function_call_output 的 output 有两种形态：纯文本，或 JSON 字符串 {"output": "...", "metadata": {"exit_code": N}}。 */
export function unpackOutput(raw: unknown): { text: string; exitCode?: number } {
  let s: string;
  if (typeof raw === "string") s = raw;
  else if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    s = typeof o.content === "string" ? o.content : typeof o.output === "string" ? o.output : JSON.stringify(raw);
  } else s = "";
  const t = s.trim();
  if (t.startsWith("{") && t.endsWith("}")) {
    try {
      const j = JSON.parse(t) as { output?: unknown; metadata?: { exit_code?: number } };
      if (typeof j.output === "string") return { text: j.output, exitCode: typeof j.metadata?.exit_code === "number" ? j.metadata.exit_code : undefined };
    } catch {
      /* 不是 JSON，按原文处理 */
    }
  }
  return { text: s };
}

/** function_call 的 arguments 是 JSON 字符串；解析失败时保留原文，调用方照常处理。 */
export function parseFunctionArgs(args: unknown): unknown {
  if (typeof args !== "string") return args ?? {};
  try {
    return JSON.parse(args);
  } catch {
    return { raw: args };
  }
}

/** local_shell_call 的 action.command（argv 数组）→ 工具输入。 */
export function localShellInput(action: unknown): { command: string[] } {
  return { command: (action as { command?: string[] } | undefined)?.command ?? [] };
}
