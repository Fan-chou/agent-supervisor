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
