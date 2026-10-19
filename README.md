# agent-supervisor

一个给编程 agent（Claude Code、Codex、OpenCode V2）用的自建监督器：便宜的规则检测器负责发现苗头，命中后交给一个可配置的强模型（默认是本地 Magpie 网关里的意图路由组，OpenAI 兼容接口）判断「放行 / 建议 / 拦截」。默认偏向给建议，故障时放行（危险命令规则除外），不会把 agent 困死。

- **安装 / 启用 / 停用 / 数据收集 / 未完成项：[docs/usage.md](docs/usage.md)**
- 调研：[docs/research.md](docs/research.md)
- 第一阶段设计 v2：[docs/design.md](docs/design.md)（文末有对照 Opus 评审的变更记录）
- Opus 评审：[docs/review-opus.md](docs/review-opus.md)
- 配置示例：[config.example.yaml](config.example.yaml)

状态：M0–M3 已完成（M4 见下）（core、回放、检测器、policy、eval、judge 客户端、日志库、outbox、守护进程 `sv start`、Claude Code 的 `sv-hook`、live judge）；M4 代码部分已完成（Codex 适配器、`sv-hook codex`、`sv install codex`、Codex 输出白名单契约测试）；M6 代码部分已完成（OpenCode V2 适配器、插件、`sv install opencode`、OpenCode 输出白名单契约测试；未在 OpenCode 2 上实测）；前端查询 API、真实载荷校准、shadow 一周尚未做。详见 [docs/progress.md](docs/progress.md)、[docs/decisions.md](docs/decisions.md)、[docs/frontend-design.md](docs/frontend-design.md)。

```
bun test                                              # 全部测试，不发网络请求
bun packages/cli/src/sv.ts replay test/fixtures/claude --judge=mock
bun packages/cli/src/sv.ts eval test/fixtures/labels.yaml
```
