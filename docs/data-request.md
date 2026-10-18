# 数据请求：Claude hook 真实载荷校准 + 30 个会话标注（decisions #118）

原则：**只用本项目 hook/守护进程自己记录的数据**。我不读 `~/.claude`、`~/.codex/sessions`、`~/.codex/auth.json`、`~/.config/magpie`、任何 `.env`，也不会自己去找 Jack 的私人会话记录。下面所有数据都由 Jack 在自己机器上开关、自己检查后再交给我（贴出来或放进 `test/fixtures/real/`，由 Jack 决定）。

## A. Claude hook 真实载荷样本（校准适配器）
**要什么**：每种 hook 事件各几条真实载荷：`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`UserPromptSubmit`、`Stop`、`PostToolBatch`（如果有）；工具覆盖 Bash、Read、Edit/Write、Grep/Glob、TodoWrite、Task（子 agent）、一次失败的命令、一次 Esc 中断、一次被拒的权限。每类 ≥3 条，来自 ≥2 个会话。
**怎么采**（全是本项目的开关，不碰 Claude 的目录）：
1. `sv install claude` 打印 hooks 配置片段，按它写进**测试项目**的 `.claude/settings.json`（项目级；不要改全局设置）。
2. `sv start`（默认 shadow，不拦截），hook 用环境变量 `SV_HOOK_DUMP=1` 启动 Claude Code。
3. 在测试项目里让 agent 做上面那些事，用一两个会话即可。
4. 样本落在 `~/.agent-supervisor/dumps/claude-<日期>.jsonl`（0600，已做密钥脱敏、字符串截断 4000，**但 prompt、命令、文件内容不会被抹掉**）。Jack 先自己过一遍，删掉不想给的行，再交给我。
**我拿到后做什么**：对比 `adapter-claude` 的解析假设（字段名、`tool_response` 形态、`tool_use_id` 配对、子 agent 标记、中断信号），修差异，样本脱敏后做成 `test/fixtures/real/` 的契约测试。

## B. 30 个会话的标注（阈值校准）
**要什么**：≥30 个真实会话的监督记录（shadow 模式下跑，覆盖不同任务类型；最好含你自己觉得「agent 在原地打转/做偏了」的几个）和你对命中的判断。
**怎么采**：
1. shadow 下正常用 Claude Code 一段时间（hook 已按 A 装好，**不需要** `SV_HOOK_DUMP`）；日志在 `~/.agent-supervisor/state.db`。
2. 导出：`sv export --out <目录>`（JSONL，事件正文已脱敏）。导出前后都可以用 `sv stats --by session` 看哪些会话该包含/排除。
3. 标注两种之一：
   - 命中级：`sv mark <hit-id> fp|useful`（只记录，不影响策略）；
   - 会话级：照 `eval/labels.example.yaml` 写 `eval/labels.yaml`（哪些步骤本该报警、哪些不该）。
4. 把导出目录和标注文件交给我（私人项目的会话可以排除，或在导出后自己删行）。
**我拿到后做什么**：`sv eval` 出每条规则的 precision/recall 与 FDR 门槛（§12.7），`sv replay --set` 扫阈值，提出阈值调整建议（通用，不按模型名分支）；调整本身仍是 Jack 通过规则编辑决定。

## 不需要、也不会读的东西
Claude/Codex 的原始 transcript 目录、auth 文件、`.env`、Magpie 配置、任何密钥。如果某个会话里有敏感内容，直接排除即可。
