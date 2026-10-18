# agent-supervisor：给 Claude Code 的任务说明

依据文件：`docs/design.md`（v2，权威）、`docs/review-opus.md`、`docs/research.md`。两者冲突时以 design.md §17 之后的内容为准。

## 本轮任务（第一阶段 M0–M2）
1. **M0** `packages/core`（TypeScript，Bun 运行，用 `bun:sqlite`）：
   - Event 类型，包括 `origin`、`toolUseId`、`pending`；
   - 命令分类器 CmdClass：要剥壳（去掉 `uv run`、`npx`、`timeout`、管道、`&&` 等包装），要识别 watch 模式，probe 要按收紧后的定义判断；
   - FailureClassifier；
   - errFingerprint：先抽取错误行，再做归一化；
   - argsHash 和 normCmd；
   - 工作区指纹（git status + diff + 未跟踪文件的 mtime，带 2 秒超时；非 git 目录要能识别）；
   - mutating 命令识别；
   - 脱敏模块。
   
   每个都要有单测，分类器至少 100 条测试用例。
2. **M1**：
   - Claude Code 回放读取器：把 transcript jsonl 转成 Event 流；只用 `test/fixtures/` 里**你自己构造的**合成样本；
   - Codex 回放读取器：同样用合成样本，包括从 function_call_output 里的 `Process exited with code N` 回填退出码；
   - 计划提取（TodoWrite、update_plan、`.supervisor/plan.md`）；
   - 检测器：§5 的 L、S、T、P、X、R 组，按 design 里的阈值和 profile；
   - policy：升级、冷却、连续拦截上限，X2 不受上限约束；
   - `sv replay <file|dir> --judge=off|mock`：输出命中时间线（JSON + 可读文本）。
3. **M2 的工程部分**：
   - `eval/` 框架：读 `eval/labels.yaml`，算每条规则的 precision/recall 和首次报警延迟；
   - judge 客户端：可配置的 OpenAI 兼容接口，加稳健解析与修复（§8.5），先用 mock 测试；**不要真的调用网络**；
   - §3.5 输出白名单的契约测试（Claude Code 部分）。
   
   人工标注不归你做。
4. **前端设计文档** `docs/frontend-design.md`（这一阶段只写文档，不写前端代码）：
   - 页面：实时会话、事件和事故时间线、judge 裁决、规则配置、回放结果；
   - 框架（Jack 已确定）：**MyGo native UI**（egoist/mygo，https://mygo.egoist.dev ，纯 Go、GPU 绘制、无 webview）。不用 Naive UI，也不做方案对比。UI 通过守护进程（TS core）的本地鉴权 API（UDS 0600 或 HTTP+token）和它通信。
   文档内容包括：信息架构、每页的线框（文字或 ASCII）、数据接口（守护进程要提供哪些 API）、状态和实时推送、空状态和错误状态、可访问性。

## 规则
- **测试必须通过**：`bun test`。每完成一小块就提交一次（小提交，信息写清楚），**不要 push**，不要改 git remote。
- **只在本项目目录内工作**：不要全局安装，不要改动 `~` 下的任何配置。依赖用项目内的 `bun add`，并且要克制：优先用 Bun 自带能力，YAML 解析可以引入一个依赖。
- **不要读** `~/.claude/`、`~/.codex/`、`~/.config/magpie/` 和任何 `.env`；回放读取器只用你自己写的合成样本。
- **不要发网络请求**，测试里一律用 mock。
- **必须落实** design §17 列出的 P0 必修项（相关的部分）：
  - 工作区指纹，L1 的「期间无改动」条件；
  - origin 字段；
  - render 输出白名单；
  - errFingerprint 先抽错误行；
  - X2 不受连续拦截上限约束；
  - judge 超时规则；
  - 发给 judge 前脱敏，`<untrusted>` 块，judge 输出后过滤；
  - outbox 原子领取（如果这一阶段做到了）。
- 遇到 design 里没写清楚的地方，自己做合理的选择，记在 `docs/decisions.md`。
- 完成 M0、M1、M2 各自之后，在 `docs/progress.md` 追加一段：做了什么、测试结果、偏离 design 的地方。
