// judge 输出后过滤（design §8.6，P0-7）：judge 的文字会进入 agent 的上下文，必须当作不可信输出处理。
export const MAX_MESSAGE_CHARS = 600;
export const MIN_MESSAGE_CHARS = 20;

// 以 `$ ` / `#!` 开头，或「命令词开头 + 带有选项/管道/重定向/路径」的行才算疑似 shell 命令；
// 单纯以 make/go/cat 开头的英文句子（"make sure the test passes"）保留。
const SHELL_LINE = new RegExp(
  "^\\s*(\\$\\s|#!|(sudo|rm|curl|wget|chmod|chown|git|npm|pnpm|yarn|bun|pip3?|python3?|node|bash|sh|cat|echo|cd|mv|cp|kill|docker|make|cargo|go|ssh|scp|eval|export)\\s+.*(\\s-{1,2}\\w|\\||&&|;|>|\\./|~/|/\\w))",
);

/**
 * 清洗 message_to_agent：去掉标签、URL、代码块、疑似 shell 命令的行，截断到 600 字符。
 * 清洗后少于 20 个字符就改用 fallback（这条规则的本地预设提示）。
 */
export function filterJudgeMessage(text: string | null | undefined, fallback: string): { text: string; usedFallback: boolean; changed: boolean } {
  if (!text) return { text: fallback, usedFallback: true, changed: true };
  let t = text;
  t = t.replace(/```[\s\S]*?(```|$)/g, " "); // 围栏代码块（含未闭合）
  t = t.replace(/<\/?[A-Za-z][A-Za-z0-9_:-]*(\s[^<>]*)?>/g, " "); // 标签：<system-reminder> 等
  t = t.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, " "); // URL
  t = t.replace(/\bwww\.\S+/gi, " ");
  t = t
    .split(/\r?\n/)
    .filter((l) => !SHELL_LINE.test(l))
    .join("\n");
  t = t.replace(/`[^`\n]{0,200}`/g, (m) => (SHELL_LINE.test(m.slice(1, -1)) ? " " : m)); // 行内代码里的命令
  t = t.replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
  if (t.length > MAX_MESSAGE_CHARS) t = t.slice(0, MAX_MESSAGE_CHARS - 1) + "…";
  if (t.length < MIN_MESSAGE_CHARS) return { text: fallback, usedFallback: true, changed: true };
  return { text: t, usedFallback: false, changed: t !== text };
}
