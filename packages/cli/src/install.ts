// sv install：只打印配置片段，不改任何文件（design §1：不自动执行）。
// Claude Code 的 hooks 配置格式依据官方文档（design §3.1），安装前请对照 Claude Code 当前文档核对。

const HOOK = "~/.agent-supervisor/bin/sv-hook"; // 固定路径，不是 npx（design §2）

export function claudeHooksJson(): string {
  const entry = (timeout: number, matcher?: string) => [{ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: HOOK, timeout }] }];
  return JSON.stringify(
    {
      hooks: {
        SessionStart: entry(5),
        UserPromptSubmit: entry(5),
        PreToolUse: entry(20, "*"), // 拦截点：command 钩子，硬超时 18 秒由 sv-hook 内部保证
        PostToolUse: entry(5, "*"),
        PostToolUseFailure: entry(5, "*"),
        PostToolBatch: entry(5),
        Stop: entry(5),
      },
    },
    null,
    2,
  );
}

export function launchdPlist(home = "~/.agent-supervisor"): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.agent-supervisor.supervisord</string>
  <key>ProgramArguments</key>
  <array><string>sv</string><string>start</string><string>--home</string><string>${home}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>${home}/logs/supervisord.err</string>
</dict>
</plist>`;
}

/** Codex 的 hook 命令：同一个二进制，用参数区分 harness。命令串必须固定（Codex 的钩子信任按哈希绑定，改了就要重新审核）。 */
export const CODEX_HOOK = `${HOOK} codex`;

/**
 * Codex 0.163.x 的 hooks 配置片段（~/.codex/hooks.json）。
 * 只覆盖我们会输出的三个注入点（PreToolUse / PostToolUse / Stop）加上用来记录的 SessionStart / UserPromptSubmit。
 * 没有 PostToolUseFailure、PostToolBatch（Codex 没有这两个事件）；不写 matcher = 匹配所有工具。
 * 注意：格式依据 docs/research.md 对 Codex 官方 hooks 文档的摘录，没有在 0.163 上实测（不联网、不读 ~/.codex）。
 */
export function codexHooksJson(): string {
  const entry = (timeout: number) => [{ hooks: [{ type: "command", command: CODEX_HOOK, timeout }] }];
  return JSON.stringify(
    {
      hooks: {
        SessionStart: entry(5),
        UserPromptSubmit: entry(5),
        PreToolUse: entry(20), // 拦截点；硬超时 18 秒由 sv-hook 内部保证
        PostToolUse: entry(5),
        Stop: entry(5),
      },
    },
    null,
    2,
  );
}

export function codexInstallSnippet(): string {
  return [
    "# Codex 0.163.x 接入（只打印，不改任何文件；本命令不会读取 ~/.codex 下的任何内容，包括 auth.json）",
    "# 0) 下面的格式没有在 0.163 上实测：安装前请对照 Codex 当前的 hooks 文档核对（字段名、timeout 的单位、是否需要打开 hooks 功能开关）。",
    "# 1) 编译 hook 二进制并放到固定路径（Claude Code 与 Codex 共用同一个二进制）：",
    "#    bun run build:hook && mkdir -p ~/.agent-supervisor/bin && cp bin/sv-hook ~/.agent-supervisor/bin/sv-hook",
    "# 2) 把下面的 hooks 合并进 ~/.codex/hooks.json（或 config.toml 里等价的 [hooks] 表）。",
    `#    command 必须保持为固定字符串 \`${CODEX_HOOK}\`：Codex 的非托管钩子按哈希绑定信任，命令串一变就要重新审核；升级二进制不改命令串。`,
    "#    如果 Codex 不展开 `~`，把它换成绝对路径（换完同样要重新审核）。",
    codexHooksJson(),
    "# 3) 在 Codex 里打开 /hooks，逐条审核并信任这些钩子；未信任的钩子不会运行。项目级钩子需要先信任项目。",
    "# 4) 启动守护进程：sv start   （默认 mode=shadow：只记录，永不拦截）",
    "# 5) 想先看真实载荷：以 SV_HOOK_DUMP=1 启动 Codex（环境变量要能传到钩子进程；如果 Codex 过滤了环境变量就不会生效），",
    "#    脱敏后的载荷样本写到 ~/.agent-supervisor/dumps/codex-<日期>.jsonl（0600）。看里面有没有 update_plan（design §16.2）。",
  ].join("\n");
}

export function installSnippet(o: { launchd?: boolean }): string {
  const parts = [
    "# 1) 编译 hook 二进制并放到固定路径：",
    "#    bun run build:hook && mkdir -p ~/.agent-supervisor/bin && cp bin/sv-hook ~/.agent-supervisor/bin/sv-hook",
    "# 2) 把下面的 hooks 合并进 Claude Code 的 settings（~/.claude/settings.json 或项目的 .claude/settings.json）：",
    claudeHooksJson(),
    "# 3) 启动守护进程：sv start   （默认 mode=shadow：只记录，不拦截）",
  ];
  if (o.launchd) parts.push("# 4) launchd 用户代理（保存为 ~/Library/LaunchAgents/dev.agent-supervisor.supervisord.plist 后 launchctl load）：", launchdPlist());
  return parts.join("\n");
}
