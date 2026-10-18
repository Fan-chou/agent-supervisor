# 编程 Agent 监督器（便宜规则 + 强模型判断）调研报告

> 第二轮更新（2026-10-18 下午，UTC+8）见文末「第二轮」各节；其中的结论覆盖前文相冲突的地方。

日期：2026-10-18（UTC+8）。范围：只做调研，没在 Jack 的 Mac 上装任何东西，也没对外发送任何内容。
标注说明：【已核实】= 本轮读过官方文档或源码；【前轮】= 前几轮读过代码或说明（histori 的代码已读，包装脚本用假模型测过 8 种情况）；【未核实】= 只看到二手描述，或凭已有知识，需要再查。

## 0. 结论先行
1. 现成项目都只做了一半：规则层（histori、Squawk、LoopGuard、KEEL）只用规则，不调模型；模型层（iterion、Viper）没有计数类规则。「规则报警 → 强模型判断 → 放行/建议/拦截」整套，目前只有 LivePlan 论文的研究代码。
2. 自己实现完全可行，主要成本在评测，不在代码。Claude Code 的钩子已经够用：PreToolUse 可以拒绝，PostToolUse 和 Stop 可以把话塞给模型，还有 asyncRewake 后台唤醒。Codex 的钩子现在也能做 deny、additionalContext 和 Stop 续跑。
3. 推荐分工照 LivePlan：什么时候介入交给规则，介入时说什么交给强模型。默认只给建议，只有高置信度时才拦截。要有预算和冷却，出错一律放行（fail-open），还要有防困死机制。

## 1. 现有实现
| 项目 | 检测器 | 触发 / 注入 | 误报处理 | 成熟度 |
|---|---|---|---|---|
| [histori](https://github.com/histori-dev/histori)【前轮】 | 6 条写死的规则：同一动作重复、同一调用连续失败、多步没成功改动、单轮工具调用过多或耗时过长、token 超预算、一轮几乎全在思考 | Claude Code / Codex 钩子；默认只警告，刹车模式拒绝下一步 | 只有阈值；警告文本模型可能看不到（未验证） | MIT，约 1000 行，0 星，7 月下旬后没更新 |
| [Squawk](https://github.com/Jack-Lin-DS-AI/squawk)【前轮，只读了说明和规则】 | YAML 规则 DSL：操作类型、文件匹配、时间窗口内次数、「没先做 X」；自带原地打转、来回改同一处、没读源码先改测试 | 常驻 Go 程序 + Claude Code 钩子；拦截或塞一句纠正，带冷却 | 冷却 | 4 星，3 月后没更新；没看到 Codex 支持（未核实） |
| [LoopGuard](https://github.com/loop-eng/loopguard)【未核实细节】 | 死循环、超预算 | 支持 Claude Code、Codex、Gemini CLI；检测到就暂停 | 未知 | 未知 |
| [KEEL](https://github.com/vzwjustin/KEEL)【未核实细节】 | 要改的文件不在当前计划步骤里 | PreToolUse 拦截 | 未知 | 未知 |
| [iterion supervisor](https://socialgouv.github.io/iterion/supervisors)【前轮，读了文档】 | 事件触发：每轮结束、命令失败、改动关键路径、花费超标 | 读 `~/.claude/projects` 下的会话记录；监督模型自己决定介不介入、说什么、接下来盯什么 | 调用次数上限，用完自动停止 | 设计最完整；能不能指向 Magpie 未确认 |
| [Viper 2.0](https://github.com/postgigg/viper-2.0)【前轮】 | Claude 每改一次代码，Codex 打 0–10 分跑偏分，对照 `.viper/intent.md` | 后台打分不卡 Claude；≥6 分（可调）时把警告塞进下一轮 | 阈值可调 | 小项目 |
| [thin-supervisor](https://github.com/fakechris/thin-supervisor)【前轮】 | 每 2 秒读一次终端；到检查点决定继续、重试、换路还是上报 | 往终端输入框打字 | 主要靠规则 | 小项目 |

主流工具（Codex、OpenCode、Goose、OpenHands、Cline、Devin、Amp、Factory）都没有内置常驻监督【前轮】。Goose 的 lead/worker 失败回退是计数器触发的，算最接近的内置功能。
**本轮没做到**：没在 HN、Reddit、X 上补搜 watchdog、overseer 类项目，也没 clone 读 LoopGuard 和 KEEL 的源码。这是下一步最该补的。

## 2. 论文与信号
- **[LivePlan](https://arxiv.org/html/2608.06701)**【前轮】：规则发现跑偏后才请强模型给建议。SWE-bench 平均多解 9.9%，每个任务多花约 0.08 美元。作者认为让模型自己决定何时介入容易误报。
- **[Cadence](https://arxiv.org/html/2610.12269)**【前轮】：自适应检查频率，出严重错误就看得勤，顺利时放松；能给建议，也能把一步作废重来。SWE-bench Lite +25.33 个百分点（绝对值，基线 17%，见第二轮 §B）。
- **[Can AI Models Direct Each Other?](https://arxiv.org/html/2603.26458v1)**【前轮】：强模型指挥弱模型 62%，强模型单干 60%，弱指挥弱 42%。说明强模型介入的价值主要在纠偏，不在全程代劳。
- **MAST**（Cemri 等，2025，"Why Do Multi-Agent LLM Systems Fail?"）【未核实细节，凭已有知识】：14 种失败模式分 3 大类：规格/设计问题、agent 间不对齐、任务验证和终止问题。和监督器最相关的是：不遵守任务要求、重复步骤、不知道何时停止、过早终止、验证不完整或不正确。
- **AI Control / trusted monitoring**（Greenblatt 等，2023）【未核实细节】：用可信模型给每一步打可疑分，只把分数最高的约 2% 交给人审，或改成 defer-to-trusted。可借鉴的思路是「按分数分位数分配审计预算」，不用固定阈值。
- **HiSentinel**：已找到原文，见第二轮 §B。
- **SWE-agent 失败分析**（Yang 等，2024）【未核实细节】：常见失败有反复编辑失败（语法错误循环）、在定位阶段迷路、没复现就提交。
- 能预测失败的信号（综合以上，**多数没有定量误报率**）：
  - 重复动作或重复报错（最强、最便宜）
  - 编辑后语法或测试反复失败
  - 长时间没成功改动
  - 改动超出计划范围
  - 绕过测试（改测试、跳过测试、硬编码预期值）
  - 上下文接近压缩
  
  公开数据里几乎没有 precision/recall 型的误报率数字，需要自己用回放来测。

## 3. 钩子机制
### Claude Code【已核实，[官方 hooks 文档](https://code.claude.com/docs/en/hooks)】
- **exit 2**：PreToolUse 拦下工具调用，stderr 作为工具错误给 Claude 看。PostToolUse、PostToolUseFailure 不能拦，但 stderr 会给 Claude 看。Stop 用 exit 2 会让它继续干活。PostToolBatch 用 exit 2 会在下一次模型调用前停住 loop。
- **exit 0 时的 stderr Claude 永远看不到**；其他退出码算非阻塞错误，只给用户一行提示。
- **PreToolUse**：`hookSpecificOutput.permissionDecision`（allow/deny/ask/defer）加 `permissionDecisionReason`；`updatedInput` 可以改参数；`additionalContext` 放在工具结果旁边。
- **PostToolUse / Stop / UserPromptSubmit**：顶层 `decision:"block"` 加 `reason`。Stop 还能用 `additionalContext` 做非错误反馈并继续对话。
- **additionalContext** 以 system reminder 的形式进入下一次请求，界面上不显示。上限 10,000 字符，超出转存文件。文档提醒：要写成事实陈述，写成系统命令式的口吻可能触发提示注入防御，被当成可疑内容报告给用户。**这对监督器的措辞很关键。**
- **systemMessage** 只给用户看。`continue:false` 加 `stopReason` 会让 Claude 整个停下。
- **async: true**：后台跑，不阻塞，timeout 不生效。**asyncRewake: true**：后台跑，退出码 2 时唤醒 Claude，stderr（为空就用 stdout）作为 system reminder 给它。这是「强模型异步判断、不卡 agent」的官方通道。
- **timeout** 默认 600 秒（UserPromptSubmit 30 秒）。超时不拦截，除非设 `onFailure:"block"`（v2.1.295+）。所以默认就是 fail-open。
- 还有 `type:"prompt"` 和 `type:"agent"` 钩子，可以直接调 Claude 模型判断（只能用 Claude 模型，接不了 Magpie 上的 GPT；能否走 Magpie 未核实）。`type:"http"` 可以把事件 POST 给本地常驻服务，适合做有状态的监督守护进程。
- **transcript_path** 写入有延迟，可能还没有当前这一步；Stop 时用 `last_assistant_message`。
- 子 agent 的工具调用也会触发钩子，输入里带 `agent_id`。

### Codex【已核实，[官方文档](https://developers.openai.com/codex/hooks)】
- 事件：PreToolUse、PermissionRequest、PostToolUse、PreCompact、PostCompact、UserPromptSubmit、SubagentStart/Stop、Stop、Interrupt、SessionStart/End。配置在 `~/.codex/hooks.json` 或 `config.toml [hooks]`；项目级钩子要先信任项目。
- **PreToolUse**：deny（或旧格式 `decision:block`、exit 2 加 stderr）、`additionalContext`（作为开发者上下文）、`allow` 加 `updatedInput`。`continue` 和 `stopReason` 不支持，返回这些字段会被判为钩子失败，并放行。
- **PostToolUse**：覆盖 Bash、apply_patch、MCP 和本地函数工具；**文档写明 Bash 非零退出后也会触发**。这和前轮 histori 那条「Codex 失败命令传不到钩子」的结论冲突，可能是版本差异，需要在 0.163.0 上实测。`decision:block` 会把工具结果替换成反馈；也支持 `additionalContext` 和 `continue:false`。
- 模型可见的钩子输出上限约 2,500 token，超出转存文件。
- `async` 已支持；prompt/agent 类型的钩子会被解析但跳过。有 mcp_tool 钩子（同步执行，出错不拦）。
- PreToolUse 回调出错、超时或格式错误时**不拦截**（fail-open）。

### OpenCode【已核实，[插件文档](https://opencode.ai/docs/plugins/)；[issue #50133](https://github.com/anomalyco/opencode/issues/50133)】
- `tool.execute.before` 里抛异常就能拦截，也可以改参数；`tool.execute.after` 看结果；事件里有 `session.idle`（≈Stop）、`session.error`、`file.edited` 等。
- `event` 处理器是 fire-and-forget（[#16879](https://github.com/anomalyco/opencode/issues/16879)），不能拦住 idle。要往模型里塞话，得用 SDK 的 `client.session.prompt()` 追加消息（未实测）。
- 缺口：失败结果没有明确的 status、工具钩子不带 cwd、没有按 agent 区分的钩子。

### 哪条注入路径最可靠（建议）
1. 拦截：Claude Code 用 PreToolUse 的 deny 加 reason；Codex 同理；OpenCode 用 throw。
2. 建议：PostToolUse 的 additionalContext（Claude Code、Codex 都支持）。需要强制让模型看到时，用 PostToolUse exit 2 加 stderr。
3. 异步：Claude Code 用 asyncRewake；其他工具在下一次 PreToolUse 时取出排队的建议再注入。
4. 收尾审查：Stop 用 decision:block，必须带次数上限。

## 4. 设计建议
### 4.1 检测器目录（建议阈值，需要回放校准）
| ID | 信号 | 初始阈值 | 严重度 |
|---|---|---|---|
| R1 | 同一命令或同一参数哈希重复 | 最近 8 步内 ≥3 次 | 中 |
| R2 | 同一报错指纹（去掉数字和路径后取哈希） | 连续 ≥2 次 | 中 |
| R3 | 没有成功编辑或测试进展 | ≥10 步，或 ≥8 分钟 | 中 |
| R4 | 同一文件区域来回改（A→B→A） | diff 回滚 ≥2 次 | 中 |
| R5 | 改动超出计划或白名单路径 | 1 次 | 高（PreToolUse） |
| R6 | 动测试文件、加 skip、改断言、硬编码 | 1 次 | 高 |
| R7 | 危险命令（rm -rf、force push、改 CI/密钥文件） | 1 次 | 直接用规则拦，不问模型 |
| R8 | 花费或 token 超预算、上下文快满 | 80% | 低→中 |
| R9 | 声称完成但最近没跑过测试（在 Stop 时检查） | 1 次 | 中 |
| R10 | 定期抽查 | 每 15–20 步 | 低 |

### 4.2 升级策略
- 规则命中后先算分（严重度 × 次数），过了阈值才叫强模型；低分只记日志。
- 强模型给出 ignore/advise/block。block 只在 PreToolUse 上生效，而且要 confidence ≥0.8；其余一律降级为 advise。
- 防困死：同一会话连续拦截 ≤2 次，第 3 次强制改为 advise；同一规则同一指纹冷却 5 分钟；每个会话最多叫强模型 5–8 次；Stop 续跑最多 2 次。
- 强模型连续 3 次判 ignore 的规则，在本会话里阈值翻倍（自适应，参考 Cadence）。

### 4.3 强模型提示与输出 schema
系统提示要点：你是监督者，只在明显跑偏时介入；不要替 agent 写代码；建议写成事实陈述（照 Claude Code 文档的建议，避免触发注入防御）。
```json
{"verdict":"ignore|advise|block","confidence":0.0,"category":"loop|wrong_direction|scope_creep|test_gaming|unsafe|premature_done|other",
 "message_to_agent":"≤600 字，事实陈述 + 一个具体下一步","evidence_steps":[12,15],"watch_next":"可选：接下来要盯什么"}
```
用 response_format（json_schema）加解析校验，解析失败就当 ignore。

### 4.4 上下文打包（目标 6–12k token）
任务目标（第一条用户消息 + 计划/TODO）→ 触发规则和证据 → 最近 20–30 步，每步含工具名、参数摘要、结果头尾各约 300 字符、退出码 → `git diff --stat` 和最近一次 diff 片段 → 已发过的监督消息，避免重复。

### 4.5 同步还是异步
- PreToolUse 高严重度（R5、R6）：同步调用，超时 15–20 秒，超时就放行。
- 其他：异步执行。Claude Code 用 asyncRewake；Codex 和 OpenCode 写入队列，下一次 PreToolUse 或 PostToolUse 时取出注入。
- 结构上建议用一个常驻 HTTP 守护进程（Claude Code 的 http 钩子可以直接 POST 给它）保存会话状态，钩子脚本本身保持很薄。

### 4.6 fail-open
所有异常、超时和 schema 错误都放行，并写本地日志。不设 `onFailure:block`（危险命令 R7 除外，那条用纯规则）。

### 4.7 评测方法
1. **离线回放**：收集 `~/.claude/projects/*.jsonl` 和 Codex 的会话记录，人工把每个会话标成成功或失败，并标出跑偏点。把规则逐步跑一遍，算每条规则的 precision/recall、首次报警距跑偏点的步数。强模型在报警点上判一遍，算 advise/block 的一致率。这一步不改变 agent 行为，最便宜。
2. **在线 A/B**：选 SWE-bench Verified 或 Lite 的 30–50 题子集（或 Jack 自己仓库的历史 issue），同一个便宜主模型分「有监督 / 无监督」两组各跑 2–3 遍。看解决率、步数、花费、墙钟时间、被拦次数和误拦率（人工复核）。
3. 判断标准：解决率显著提升，且每题增加的花费不超过约 0.1 美元，误拦率低于 10%。

### 4.8 成本估算（粗算，按公开标价量级，未核实 Magpie 实际计费）
每次强模型调用约 10k 输入 + 0.5k 输出。Opus 级按每百万输入 15 美元、输出 75 美元计，约 0.19 美元/次；GPT 级更便宜。每个会话 3–5 次，约 0.5–1 美元。如果走订阅额度，换算成额度消耗即可。LivePlan 实测每题约 0.08 美元，可作参考下限。

## 5. 关键不确定点
- （第二轮已补：LoopGuard、KEEL、iterion、Viper 的源码已读；HiSentinel 已找到。）
- 「Codex 失败命令传不传得到 PostToolUse」：第二轮已用 0.163.0 源码查清，见 §D。
- Claude Code 的 additionalContext 措辞会不会被当成注入：文档有提醒，要实测。
- OpenCode 往会话里追加消息的方式没实测。
- MAST、AI Control、SWE-agent 失败分析的具体数字没逐一核对原文；Cadence 的 +25% 口径未核实。
- 公开文献里几乎没有监督器误报率数据，只能靠自己回放来测。

---
# 第二轮（源码、原文 PDF、社区补查）

## A. 源码精读（本机 clone，路径 /workspace/supervisor-research/src-*）【已核实】

### LoopGuard（[loop-eng/loopguard](https://github.com/loop-eng/loopguard)，Go，最后提交 2026-10-05）
- **形态**：常驻 daemon，**不走钩子**。它通过 `internal/discovery/{claude,codex,gemini}.go` 发现会话，再解析会话日志文件。
- **检测器**（`internal/analyzer/spin.go`、`config.go` 的默认值）：
  - `repeated_tool_calls`：50 步滑动窗口里，同一（工具+输入）指纹出现 ≥3 次。
  - `error_echo`：同一报错出现 ≥3 次。报错的归一化只做 trim、取前 200 字符、转小写，**不去掉数字和路径**，所以时间戳不同就算两条不同的报错。
  - `stall`：10 分钟没有编辑文件。只作为原因附上，**不单独判定在打转**。
  - `cost_velocity`：5 分钟窗口内每分钟花费 ≥2 美元。
  - `context_bloat`：上下文填充 ≥85%。
  - 预算：每会话 20 美元、每小时 50 美元、每天 200 美元，到 80% 时预警。
- **执行**（`internal/enforcer`）：对 agent 进程发 **SIGSTOP 暂停**，或 SIGTERM/SIGKILL；暂停失败时退回到写 sentinel 文件。**没有任何话传给模型**，人工 `loopguard resume` 发 SIGCONT 恢复。
- **结论**：适合做「烧钱熔断」的参考实现，不是纠偏器。它的 50 步窗口内重复 3 次这个阈值偏敏感，因为正常开发里 `npm test` 跑 3 次很常见。

### KEEL（[vzwjustin/KEEL](https://github.com/vzwjustin/KEEL)，Python，最后提交 2026-03-25）
- **范围守卫** `.claude/hooks/keel_scope_guard.py`：PreToolUse，只看 Write/Edit，timeout 3 秒。
  - 允许范围来自当前计划步骤的 `related_paths`，加上目标的 `scope` 关键词。关键词是模糊子串匹配：去掉 `-`、`_` 和空格后，只要出现在路径里就放行。
  - 有 delta 文件覆盖的改动也放行。
  - 在范围外就输出 `{"decision":"block","reason":...}`。
- **问题**：
  1. 用的是旧版顶层 `decision:block` 格式，当前 Claude Code 文档里 PreToolUse 的正式写法是 `hookSpecificOutput.permissionDecision`。旧格式还生不生效【未实测】。
  2. 判断范围时有一句 `allowed.startswith(rel.split("/")[0])`：只要允许路径和文件的顶层目录一样，就整片放行，误放会很多。
  3. 各种异常和缺状态的情况都放行（fail-open，做法正确）。
- `keel_notify.py` 在 PostToolUse 时读取伴随进程写下的 drift 状态，再注入一句 "drifting"。

### Viper 2.0 漂移钩子（[postgigg/viper-2.0](https://github.com/postgigg/viper-2.0) `edit_drift.py`，最后提交 2026-05-27）
- **注册方式**：PostToolUse，matcher 为 `Edit|Write|MultiEdit`，**`asyncRewake: true`**。这是现有项目里唯一用上官方异步唤醒通道的。
- **打分**：把意图（`.viper/intent_<sid>.md`，没有就用 `intent.md`）加上本次编辑摘要（截断到约 400 字符），喂给 `codex exec -s read-only -C cwd -`，超时 30 秒。解析回复里的 `DRIFT: n`，限制在 0–10。
- **注入**：分数 ≥ `REWAKE_THRESHOLD=6` 时以 exit 2 退出，理由写在 stdout，作为 system reminder 进入下一轮；否则只写 `.viper/edit_drift.jsonl`。
- **防死循环**：跳过 `.viper/` 下的文件。没有冷却、预算和次数上限，**每次编辑都调一次 Codex**，比较贵。
- `intent_inject.py` 在 UserPromptSubmit 时用 additionalContext 重新注入意图。

### iterion supervisor（[socialgouv/iterion](https://github.com/socialgouv/iterion) `pkg/supervise`，非常活跃，最后提交 2026-10-18）
- **决策结构**（`bot.go`）：`{intervene, message, reason, watch:[Monitor], done}`。监督模型可以**自己登记新的监视器**，也可以宣布「满意，暂停评估」（done）。
- **Monitor 字段**：event_type（如 tool_error、node_finished、budget_warning）、node_id、tool_name、text_contains（大小写不敏感的子串）、cost_gt。命中就**立即唤醒，绕过冷却**。
- **默认值**：普通轮次边界的冷却 `DefaultCooldown = 30s`，`DefaultMaxEvals = 20`，用完就降级成什么都不做。代码里还专门防止 NaN 或负数阈值把监视器变成匹配一切的通配符，否则会一下子耗光评估次数。
- **注入**（`cmd/iterion/claude_hook_drain.go`）：消息先进收件箱队列，由钩子取出：
  - Stop 时用 `{"decision":"block","reason":msg}`；
  - PostToolUse 时用 `hookSpecificOutput.additionalContext`；
  - 队列为空时什么都不输出，「绝不在没有新内容时挡住停止」；
  - 用 delivery ID 保证每条只投递一次（幂等）。
- **结论**：这是目前**最值得照抄的架构**：事件驱动唤醒、冷却、评估预算、模型自己登记监视器、队列加钩子取出的注入方式。缺的只是计数类规则。

## B. 论文数字（直接从 arXiv PDF 核对）【已核实】
| 论文 | 设置 | 关键数字 | 口径 |
|---|---|---|---|
| [LivePlan 2608.06701](https://arxiv.org/abs/2608.06701) | SWE-agent，3 个执行模型 × 2 个顾问模型；SWE-bench Verified 和 Pro；每题上限 2 美元 | 最高 +15.2、平均 +9.9；分项：Pro 上 DeepSeek-V3 +12.33、Gemini-2.5-Flash +15.24、MiniMax-M2.5 +5.45；Verified 上分别 +11.20、+10.60、+5.00 | **百分点（绝对值）**；摘要写的是 "%"，正文写明是 points |
| 同上 | 成本 | 每题多花约 0.08 美元（顾问部分 0.01–0.06）；规则监控只需几毫秒 | 对强执行模型 MiniMax 反而省钱 |
| 同上 | 规则和参数 | 漂移分类：计划违规（没定位就打补丁、不出补丁就结束、不验证就提交）= **阻断型**；振荡（思路或动作循环）= 阻断型；长期停滞（同一阶段 ≥7 步，θp=7）和重复动作（回访同一位置）= 非阻断型。顾问冷却 θc=5 步，连续阻断上限 θi=5 | θp=7 的依据：成功实例同一阶段最长平均 5.64 步，失败实例 7.61 步 |
| [Cadence 2610.12269](https://arxiv.org/abs/2610.12269) | SWE-bench Lite 300 题；mini-swe-agent 和 Moatless | mini-swe-agent：基线 17.00% → 42.33%（**+25.33 个百分点**）；Moatless +15.67 个百分点。同一张表里：固定间隔 k=3 为 33.33%、k=5 为 34.00%、k=7 为 26.33%；静态规则 24.00%；LivePlan 26.67% | 绝对值。**代价是每题 token 从 0.12M 涨到 0.41M（+243%）**；基线很弱，增幅可能被放大 |
| [HiSentinel 2609.39957](https://arxiv.org/abs/2609.39957)（2026-09-30） | 用 0.6B/1.7B 小模型做执行前哨兵，三选一：Allow / Redirect / Hard-Pause；用事后结果蒸馏训练 | SWE-bench Verified Mini 上 Qwen3-Coder 从 30% 到 44%；最高 +14、Ask-or-Assume +10；SWE-Intervene 上 macro-F1 81.77、介入 F1 78.97 | 绝对值。**消融实验：误报更少的变体，解决率反而从 44% 降到 34–36%，因为漏掉了必要的介入**。作者结论：执行中 agent 常能自己识别并跳过低风险误报，所以**召回比精确更重要** |
| [MAST 2503.13657](https://arxiv.org/abs/2503.13657) | 1642 条多 agent 轨迹，7 个框架；14 种失败模式 | 人工标注一致性 κ=0.88，LLM 标注器 κ=0.77。占比：步骤重复 FM-1.3 15.7%，不知道任务已完成 FM-1.5 12.4%，不遵守任务要求 FM-1.1 11.8%，没验证或验证不完整 FM-3.2 8.2%，任务偏离 FM-2.3 7.4%，提前终止 FM-3.1 6.2%，错误假设不求证 FM-2.2 6.8% | 对象是多 agent 系统，不是单个编程 agent，只能作参考 |
| [AI Control 2312.06942](https://arxiv.org/abs/2312.06942) | APPS 编程题；强但不可信的 GPT-4 + 弱但可信的 GPT-3.5 监控 | 审计预算是 **2% 的误报率**；可信监控 + 「可疑分数前 X% 改用可信模型的解」：0%→安全 62%、可用性 97%；5%→74%、95%；10%→83%、93%；20%→92%、83%；50%→100%、51% | 讲的是对抗安全，不是跑偏；但「按分数分位数分配介入预算」可以直接借用 |
| [Can AI Models Direct Each Other? 2603.26458](https://arxiv.org/abs/2603.26458) | SWE-bench Lite 200 题 | 强模型指挥弱模型 62%，强模型单干 60%，弱指挥弱 42%（低于弱模型单干的 44%）；去掉结构化阶段只有 53% | 绝对值 |
- **SWE-agent 失败分析**：本轮没有逐篇核对原文，仍是【未核实】。LivePlan 正文引用的 [8, 19] 也是这类工作。
- **综合起来能预测失败的信号**：
  - 有定量依据的只有 LivePlan 的「同一阶段停滞步数」，成功和失败实例的分界在 6–7 步；
  - 其次是计划违规（没验证就提交）和振荡；
  - MAST 显示，步骤重复和不知道何时停止是最常见的两类失败。
  - **几篇论文都没给出 precision/recall 型的线上误报率**；HiSentinel 有离线 F1，而且其结论是宁可多报。

## C. 社区补查（GitHub / Reddit / X）
- [claude-code-self-critic](https://github.com/nadimtuhin/claude-code-self-critic)【只读了 README】：**跟 Jack 的设计最像**。
  - Stop 钩子先从记录里抽证据（有没有跑测试、有没有读过声称验证过的文件），用确定性规则判断，再让 Haiku **只投否决票**来压误报，Haiku 不写批评。
  - PreToolUse 卡点检测：参数归一化后的同一命令或同一文件 ≥3 次，就推一句提醒，每轮重置。
  - 其他设置：每段最多 1 轮批评、处处 fail-open、Haiku 超时 60 秒、触发时同步多 7–10 秒。
  - 作者承认的误报：同一轮里改同一个文件 3 次，也会被提醒。
- [claude-focus](https://github.com/assafkip/claude-focus)【只读了 README】：三个钩子，不调模型。阈值表很有参考价值：
  - **拦截**：同工具同输入 3 次、自上次用户消息起 50 次工具调用、25 个子 agent、60 秒内 30 次 MCP 调用、同一文件编辑 3 次、动 .env/.pem/.key；
  - **警告**：连续 15 次读取没有写、同一文件读 3 次、上次写入后 5 次 grep、距上次写入 2 分钟且 10 次调用；
  - 每个阈值都能用环境变量调；
  - 另有 echo-of-prompt：在 UserPromptSubmit 时重新注入原始任务，防止跑偏。
- [loop-guard（claude-code-mods）](https://claude-mods.com/loop-guard/)【读了页面】：同一调用（同工具、同参数、同 agent，忽略 description 字段）**连续 2 次失败，而且报错文本完全相同**，才附一条只有模型能看到的提示。**从不拒绝调用**；调用成功就清零；`/clear` 或 Esc 也会清零。页面说明，同系列的 Loop Breaker 会拦第 3 次。
- [Hook Detection Rule Grammar 手册](https://gist.github.com/waitdeadai/1716b66cb510a3f386be7ebf41006c51)：分词法、结构、语义三层；警告说宽泛的词法触发（比如 "done"）误报多，会让人习惯性忽略钩子。
- **误报和副作用实例**：
  - [claude-code #58637](https://github.com/anthropics/claude-code/issues/58637)：Stop 钩子在后台子 agent 状态不同步时无限 block，烧了 154 轮。v2.1.143 加了连续 Stop block 上限 `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`（报告者称默认 8）。反过来，正常的长时间任务也可能被这个上限提前终止。**自己写的 Stop 审查必须计入这个上限。**
  - [claude-code-kit #47](https://github.com/tansuasici/claude-code-kit/issues/47)：维护者的原则是「误报比漏报更糟」，先只做同文件编辑检测。
  - [r/ClaudeAI 讨论](https://www.reddit.com/r/ClaudeAI/comments/1u8dp82/)：评论认为「同参数连续调用」比「调用总数」更可靠，突发的大量调用常常是正常的。
  - 安全分类器误报「一次命中毒化整个会话」（[#64405](https://github.com/anthropics/claude-code/issues/64405)）：这是官方安全功能的问题，不是监督器，但说明「拦截后无法恢复」是用户最痛恨的情况。
- **X 搜索**：用 x 工具搜了一次，结果基本是无关内容和泛泛的「drift」讨论，没有发现新项目。HN 没有找到相关讨论帖。社区的声音主要在 GitHub 和 Reddit。【覆盖面有限】

## D. Codex「失败命令进不进 PostToolUse」：已用 0.163.0 源码查清【已核实】
来源：`openai/codex` 标签 `rust-v0.163.0`。
- `core/src/tools/registry.rs` 约 799–818 行：只有 `success_for_logging()` 为 true 时，才构造 PostToolUse 的 payload 并运行钩子。
- `core/src/tools/context.rs` 409 行：shell 命令的输出类型 `ExecCommandToolOutput` 的 `success_for_logging()` **恒为 true**。所以 **Bash 非零退出也会触发 PostToolUse**，和官方文档一致。
- 但有三点限制：
  1. `post_tool_use_response()`（438 行）只返回**截断后的原始输出字符串**，**不带退出码**。退出码只在给模型看的响应头里。钩子只能从文本猜测失败，比如找 "error"、"FAILED"、Traceback。
  2. 命令还在运行（`process_id` 不为空，也就是长时间运行或交互式会话）时**不触发**，等 write_stdin 完成后才补发。
  3. 工具在执行前就报错（返回 `Err`，比如被拒绝或参数错误）时**不触发**。
- 所以前轮 histori 的「失败命令传不到钩子」不准确，更准确的说法是「钩子拿不到退出码，所以 histori 的失败计数规则基本失效」。自己实现时，**Codex 这一侧要从输出文本识别失败，或者在 PreToolUse 时把命令包一层，把退出码写进文件**（后者未验证）。

## E. 对设计建议的修订（覆盖 §4 中相冲突的地方）
1. **重复类规则改成「重复且失败」**：同一调用连续 2 次失败并且报错指纹相同才提醒，第 3 次才考虑拦截。报错指纹要去掉数字、路径、时间戳和十六进制。只看重复不看失败的，阈值放宽到窗口内 ≥4 次，而且只发建议。依据：loop-guard 的做法、Reddit 的意见，以及 LoopGuard 归一化太粗的教训。
2. **停滞阈值用 7 步左右**（LivePlan 的经验分界），但在 Jack 自己的会话记录上回放复核。
3. **阻断型只留三类**：计划违规（没验证就宣布完成，在 Stop 时检查）、振荡（A→B→A 来回改）、越界或危险操作。其余一律只发建议。这和 LivePlan 的阻断/非阻断划分一致。
4. **强模型只做否决和措辞，不直接下结论**：规则先下初判，强模型可以否决（判误报）或改写消息（参照 self-critic 的 Haiku 否决票）。和 HiSentinel「召回更重要」合起来看：规则宁可多报，由强模型来过滤。
5. **架构照 iterion**：队列加钩子取出，带 delivery ID 保证幂等；监督模型可以登记 watch 监视器；冷却约 30 秒；每会话最多评估约 20 次（可以先设小一点）。Claude Code 上的异步通道用 asyncRewake（Viper 已经在生产里用了）。
6. **Stop 审查**每会话最多 2 次，并且要注意 Claude Code 内置的连续 block 上限 `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`。
7. **成本**：Cadence 的经验是检查频率一高，token 能翻到 3 倍以上。要坚持「规则触发才调用」，周期性抽查间隔 ≥15 步。
8. **评测时同时看召回和误报**，用成对重复运行估计「介入后解决率的变化」（LivePlan 结尾的建议）。

## F. 仍未核实或未做
- self-critic、claude-focus、Loop Breaker 只读了 README 或页面，没读源码。
- KEEL 的旧版 `decision:block` 格式在当前 Claude Code 的 PreToolUse 上是否生效，未实测。
- `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` 默认是 8，只有 issue 里的说法，没在官方文档里查到。
- SWE-agent 系列失败分析没逐篇核对原文。
- HN 基本没有结果，X 只搜了一次，覆盖面有限。
- 没有在 Jack 的 Mac 上做任何实测，按要求也没装任何东西。
