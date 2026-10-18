# agent-supervisor

一个给编程 agent（Claude Code、Codex、OpenCode V2）用的自建监督器：便宜的规则检测器负责发现苗头，命中后交给一个可配置的强模型（默认是本地 Magpie 网关里的意图路由组，OpenAI 兼容接口）判断「放行 / 建议 / 拦截」。默认偏向给建议，故障时放行（危险命令规则除外），不会把 agent 困死。

- 调研：[docs/research.md](docs/research.md)
- 第一阶段设计 v2：[docs/design.md](docs/design.md)（文末有对照 Opus 评审的变更记录）
- Opus 评审：[docs/review-opus.md](docs/review-opus.md)
- 配置示例：[config.example.yaml](config.example.yaml)

状态：设计阶段，尚无代码。计划先做回放和评测，再以只记录模式（shadow）上线。计划来源的规则还是暂定，等确认。
