# agent-supervisor

给 coding agent（Claude Code / Codex / OpenCode）加旁路监督：廉价规则检测 + 可配置强模型 judge（ignore/advise/block）。TS + Bun（`bun:sqlite`），前端是 MyGo（Go）。

## 命令
- 测试：`bun test`；类型检查：`bun run typecheck`；hook 二进制：`bun run build:hook`
- 回放：`sv replay <file|dir> --judge=off|mock`

## 文档（按需读，不要整篇加载）
- `docs/design.md`：权威设计；冲突时以 §17 之后为准
- `docs/decisions.md`：已定决策；design 没写清的地方自己选，追加到这里
- `docs/progress.md`：进度与遗留；每完成一个里程碑追加：做了什么、测试结果、偏离 design 处
- `docs/frontend-design.md`：前端设计

## 硬规则
- 不 push、不改 git remote；每完成一小块就小提交，提交前 `bun test` 必须通过。
- 不打印任何密钥/token。
- 不读 `~/.claude/`、`~/.codex/auth.json`、`~/.codex/sessions/`、`~/.config/magpie/`、任何 `.env`。
- 只在本项目内安装依赖（`bun add`，克制）；不全局安装，不改 `~` 下配置。
- 测试不发网络请求，一律 mock；回放样本只用自己构造的合成数据（`test/fixtures/`）。
- 所有规则和阈值都是通用的：不按模型名分支，模型名只记日志。
- shadow 模式永不拦截（含危险命令）：只记录，危险操作标 `severity=dangerous`、`outcome=would_have_blocked`。
- 出错一律 fail-open，不卡住被监督的 agent。
