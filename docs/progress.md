# 进度记录

## M0 — core 基础（完成）
**做了什么**（`packages/core`，TypeScript + Bun）
- `event.ts`：Event 类型（含 `origin`、`toolUseId`、`result.status="pending"`）、CmdClass 等。
- `shell.ts`：轻量 shell 切分器（引号、`$()`、heredoc、重定向、`&&`/`||`/`;`/`|`/`&`）。
- `cmdclass.ts`：命令分类器。剥壳（`uv run`/`poetry run`/`npx`/`bunx`/`timeout`/`env`/`python -m`/`pnpm -F`/`sh -c`/管道尾巴/`&&`、`;`），识别 watch 与后台，按收紧后的定义识别 probe、smoke/repro 脚本、http_smoke，识别 mutating 命令与写入目标，输出 `normCmd`。支持 `test.full/fast/extra_patterns` 覆盖。
- `failure.ts`：FailureClassifier（Codex 头部 `Process exited with code N`、仍在运行、强/弱信号），测试摘要抽取。
- `fingerprint.ts`：`errFingerprint`（先抽错误行再归一化，无错误行用尾部 300 字符）、`argsHash`、`outputHash`、`shellCommandOf`。
- `wsfp.ts`：工作区指纹（git status + diff + 暂存 diff + 未跟踪文件 mtime/size，2 秒超时，非 git 识别）。
- `redact.ts`：密钥脱敏、`redactDeep`、`headTail`。

**测试结果**：`bun test` 360 通过 / 0 失败；`tsc --noEmit` 无错误。分类器 CmdClass 用例约 185 条（要求 ≥100，测试里有断言），另有 mutating 用例 78 条。

**偏离 / 取舍**：见 `docs/decisions.md` 的 M0 部分。要点：构建命令一律 mutating（偏保守）；`tee` 到仓库文件算 mutating；分类器无状态，smoke/repro 需调用方传入上下文。
**未做**：design M0 完成标准写的「100 条*真实*命令准确率 ≥95%」——真实命令需要 Jack 机器上的数据，目前是我手写的 150 条代表性用例，需要在真实回放上再校准。

## M1 — 回放、计划提取、检测器、policy、`sv replay`（完成）
**做了什么**
- `packages/replay`：Claude Code 读取器（prompt / 工具调用 / tool_result / 中断 / 压缩 / sidechain / meta 行 / 损坏行 / 数组形式 content）、Codex 读取器（session_meta、turn_context、function_call、custom_tool_call（apply_patch）、update_plan、**从 function_call_output 头部 `Process exited with code N` 回填退出码**，也支持 JSON 字符串形式的 `metadata.exit_code` 和 `write_stdin` 轮询回填）。样本全部由 `test/fixtures/gen.ts` 合成，没有读取任何真实 transcript。
- `packages/core`：`plan.ts`（TodoWrite / update_plan / todowrite / `.supervisor/plan.md`，含 allow 解析与 glob 匹配）、`session.ts`（SessionTracker：turn 边界以 origin=user 为准、supervisor 回显不重置、工作区版本号与「期间无改动」三态判断、编辑段/内容哈希序列、测试运行记录）、`normalize.ts`（原始调用 → pre/post Event，含 apply_patch 解析、输出脱敏、head/tail）、`origin.ts`（注入文本哈希登记）、`x2.ts`。
- 检测器（`detectors/`）：L1–L6、S1–S4（S2 仅观察）、P1–P6、X1、X2、R1–R3（R4 在 engine）、T1–T8 + 每轮预算 TB；GPT 档/默认档阶梯阈值；任务是写测试/修 flaky/基准/修 CI 时 T 组与 X1 降级。
- `policy.ts`：L/M/H 升级；5 秒同类合并、60 秒 judge 冷却、每会话 12 次上限、同规则同指纹冷却、同 category 10 步不重复；**连续拦截上限 ≤2（只管 L1/T1/judge 拦截，X2 与显式 plan 的 P1 不受限；同一次调用上多个规则同拦只计 1 次）**；L1/T1 第 3 次先要求指纹核实，再同步问 judge，judge 关闭/超时/出错时按规则默认动作拦截（P0-3）；其余 H 候选 judge 失败降级为 advise；fail-open；Stop 续跑 ≤2；`#sv off|quiet`；自适应阈值（连续 3 次 ignore ×2）、R4 间隔减半、`done` 暂停；judge 输出后过滤（标签/URL/代码块/shell 行/600 字符/不足 20 字符回退到本地预设）；judge 不能产生 X 类拦截。
- `sv replay <file|dir> --judge=off|mock [--format=text|json|both] [--out] [--config] [--plan] [--mode]`：输出命中时间线（JSON + 可读文本，含 shadow/指纹未核实/核实后会拦等标注）。`--judge=live` 被拒绝（第一阶段不碰网络）。
- `config.example.yaml` 可以被 `loadConfigFile` 直接加载，扁平的 `profiles` 键映射到阶梯阈值。

**测试结果**：`bun test` 528 通过 / 0 失败（12 个文件）；`tsc --noEmit` 无错误。

**偏离 / 需要 Jack 确认**（详见 `docs/decisions.md` 14–27）
- X2 跟随 mode（shadow 只记录，enforce 才拦）（#20，Jack 已确认）。
- `rm -rf` 的判定范围比 design 字面更窄（#21）。
- 默认档 T1 没有 H（#16）。
- 合成样本与真实 transcript 的差异未验证（#25）；P0-2（command 钩子）、outbox 原子领取属于 M3/M4，这一阶段未做。

## M2（工程部分）— eval 框架、judge 客户端、§3.5 契约测试（完成；人工标注不归我做）
**做了什么**
- `eval/`：读 `eval/labels.yaml`（schema 与校验见 `eval/src/labels.ts`；`eval/labels.example.yaml` 只放 schema，**没有往 labels.yaml 写任何合成标注**；测试用 `test/fixtures/labels.yaml`）。输出每条规则的 precision / recall、命中数、首次报警延迟，总体 recall，拦截类/建议类/待 judge 候选三类报警的 FDR 以及 §12.7 的两个门槛（<3% / <25%），按 model 的 judge 统计（ignore 率、`judge_parse_fail` 率、超时、出错），以及两种提示写法的 A/B 管道。口径写在 `docs/decisions.md` 28–34（步骤单位 = 工具调用序号、窗口、TP/FP 定义、FDR 口径）。`sv eval <labels.yaml> [--judge=off|mock] [--window N] [--ab] [--format=text|json] [--out]`。
- judge 客户端（`packages/core/src/judge/`）：
  - `client.ts`：OpenAI 兼容接口；**传输层可注入**，测试里 `globalThis.fetch` 被换成直接 throw，证明没碰网络；AbortController 超时（同步 15s / 异步 30s 取自 config，测试里 10–50ms）；`routes`（先匹配先用，`rule` 通配 + `sync`）；response_format `json_schema → json_object → none` 降级，被拒时降一级重试一次并按 model 缓存；解析失败只对异步调用重试 1 次；key 只按 `api_key_env`（及 `ADVISOR_API_KEY`）读取，错误信息/统计里不出现 key 和 Authorization 头；按 model 统计 calls/ok/ignores/parseFail/timeouts/errors。
  - `parse.ts`：§8.5 全部修复步骤（content 数组、`<think>`、代码块、前后散文、字符串感知的括号配平、尾随逗号、单引号键名、中文引号、截断补全、Python 字面量、verdict 同义词、confidence 字符串/百分数），每种一个用例；§8.4 本地语义校验（confidence 0–1、非 ignore 必须有 ≤600 字符的 message、watch ≤3 / `text_contains` null 或 ≥3 / `ttl_steps` 1–50 / 丢弃通配监视器、未知 category→other）。
  - `prompt.ts`：与模型无关的 system + user 两条消息；`recall`（默认）与 `ignore_default` 两种写法；**命令、输出、计划、本地提示都放进 `<untrusted>`，块内自带的 `<untrusted>` 标签被转义**；所有字段发出前过 `redact()`；≤约 10k token 的字符预算，按优先级截断。
  - `filter.ts`：judge 输出后过滤（P0-7）；`mock.ts`：确定性 mock。
  - policy 的 judge 调用/决策现在记录 verdict，供 ignore 率统计；Engine 把真正生效的监督消息登记到 origin 注册表并记入「已发消息」。
- §3.5 契约测试（Claude 部分）：`packages/adapter-claude/src/render.ts`（白名单 + `sanitize` 兜底，PreToolUse/PostToolUse/PostToolUseFailure/PostToolBatch/Stop 各一格）；`test/contract/claude/*.json` 共 19 个手写 fixture（不是从 render 生成的）+ 不变量测试（只有白名单字段、不泄漏 ruleId/deliveryId/expires、Post 类事件绝不出现 permissionDecision/decision、deny/ask 不带 additionalContext、Stop 遵守 `stop_hook_active`、600 字符截断、空输出）。X2 的真实输出与 fixture 文案做交叉校验。
- 复盘修复（advisor 复核后）：vitest watch 判定改看命令自己的 `CI=` 赋值；回放输出（JSON 与文本）整体脱敏；X2 改为跟随 mode；时间线新增 `callIndex`。

**测试结果**：`bun test` 639 通过 / 0 失败（16 个文件）；`tsc --noEmit` 无错误。全部测试不发网络请求（judge 测试里 `fetch` 被陷阱）。

**偏离 / 需要 Jack 确认**
- 误报率口径取 per-alarm（FDR），见 decisions #31。
- X2 跟随 mode（#20）。
- **这一阶段没有做 outbox 原子领取**（属于 M3 的 store/outbox，design §3.4/P0-8），也没有做守护进程、`--judge=live`、sv-hook、Codex/OpenCode 的 render 契约测试。
- 合成样本与真实 transcript 的差异、30 个会话的人工标注与阈值校准都还没做（需要 Jack 的数据）。

### 复核后的修正（M2 收尾前）
- **冷却不再把重复拦截放行**（decisions #38–40）：L1/T1 被拦的调用重试时不再落进冷却；默认 5 秒间隔下 L1/T1 依次是 block、block、advise、skip；重复拦截沿用此前的判断，不重复问 judge；T1 的 advise 遵守「10 步或 5 分钟」冷却。两个连续拦截上限测试不再靠 `dt: 700_000` 绕开冷却。
- **首次报警延迟只取窗口内的报警**（decisions #32）：早于窗口的噪声报警不再让延迟变小。
- 最终：`bun test` 639 通过 / 0 失败；`tsc --noEmit` 无错误。

## 前端设计文档（完成，仅文档）
`docs/frontend-design.md`：按更新后的 CLAUDE.md，框架已定为 **MyGo native UI**，因此没有做 native / Naive UI 的方案对比，也没有「请 Jack 确认」那一句。内容：信息架构；5 个页面（实时会话、事件与事故时间线、Judge 裁决、规则与配置、回放结果）的 ASCII 线框与每页的空/错误状态；守护进程要提供的 API 表（UDS / HTTP+token，协议版本头，v1 唯一的写接口是会话静音）；以 JSON Schema 为唯一来源、Go 结构体生成、共享黄金样例的类型复用方案；SSE（HTTP）/ NDJSON（UDS）实时推送，`since` 断线续传与 `reset`；UI 状态机与重连退避、Go 侧 Store 与 10 Hz 合并；可访问性（并把「GPU 自绘界面可能没有系统无障碍树」写成风险项）；隐私展示规则；以及**需在 MyGo 上验证的清单**（表格虚拟化、自绘图形、文本选择复制、输入法、系统无障碍、焦点管理、缩放与深浅色、线程模型、通知、体积与内存、打包）。**没有编造 MyGo 的组件名或 API，也没有给出体积/内存数字**（本阶段不联网、未实测）。

## 监督者（Jack）的追加决定（M2 收尾后处理）
1. **前端只用 MyGo native UI**：CLAUDE.md 的改动已单独提交（`docs: frontend is MyGo native UI only`）。
2. **`rm -rf` 口径**：Jack 同意窄化规则，decisions #21 标为已确认，design §5.5 同步。
3. **不要任何模型特定规则**：删除 GPT/默认 profile 与 `model_profiles`（代码、`config.example.yaml`、design §6、测试），所有规则只有一套 `thresholds`；模型名只记录到日志，测试断言「换任意模型名，命中时间线完全一致」；decisions #16 作废，新增 #41（统一后的初值）；design 增加 v2.1 changelog。
4. **日志与可观测性**（design §18，decisions #42–45）：`packages/core/src/store/`——schema（runs / sessions / events / hits / judge_calls / decisions / deliveries / overrides / adapter_health，schema 版本号）、写入（`LogSink` 在一个事务里写事件、命中（含规则、指纹 key、证据、观测值与当时阈值）、judge 调用（模型、延迟、token、重试、response_format 降级、修复、脱敏后的请求/响应）、决策（含结构化的抑制/降级代码）、投递（通道、是否送达、遵从）、用户覆盖（`#sv off/quiet`、手动放行/驳回、标误报/有用））、保留期（按写入时间清理，人工标注过的命中不清理）、可选 JSONL 镜像与导出、fail-open。命令：`sv replay --log --label --set`（回放写库并记录当时的阈值集合）、`sv stats`（`--by rule|model|judge|session|runs`、`--compare A,B`、text/json/csv）、`sv mark`、`sv override`、`sv explain`、`sv export`、`sv prune`。可以产出按规则的命中率/误报率/遵从率统计，并通过 replay + `--set` 对比调阈值。测试里发现并修了两个泄漏/误伤：事件 `body_json` 与命中 `detail_json` 最初没有脱敏；`redact` 会把 `prompt_tokens: 1200` 当密钥抹掉。
5. **前端文档第二版**（`docs/frontend-design.md`）：MyGo native；7 个视图与日志表一一对应——实时会话（按项目目录分组、可展开子 agent、多选批量）、事件与事故时间线、Judge 裁决（Magpie Usage 风格：顶部筛选 + 日期区间 + 搜索 + CSV 导出 + 含/不含缓存合计；点行进请求详情页：状态、错误类型、上游返回、数据来源、关联会话文件、可复制命令）、Judge 路由（Magpie Routing 风格：每个用途当前路由状态与「为什么改道」）、规则配置（只读 + 校验）、规则统计与误报标注、回放结果；每个视图写明调用的 API 端点；已去掉所有「待确认」注记，MyGo 相关假设集中在「需在 MyGo 上验证的清单」（含恢复会话命令模板需在 Jack 机器上核对）。

**测试结果**：`bun test` 671 通过 / 0 失败（19 个文件）；`tsc --noEmit` 无错误。所有测试不发网络请求。

**仍未做**：outbox 原子领取、守护进程、`--judge=live`、sv-hook、Codex/OpenCode 的 render 契约测试、用真实 transcript 校准、30 个会话的人工标注（需要 Jack 的数据）。新增日志只有「写入 + 查询 + CLI」的最小版；`adapter_health` 与 `live` 类型的 run 要等 M3 的守护进程来写。

## 交接（2026-10-18 14:10 UTC+8，run3 因 Claude 会话额度用尽中断，额度约 18:00 UTC+8 重置）
- 已提交：CLAUDE.md 前端段落；单一阈值（去掉 GPT/默认 profile）；SQLite 结构化日志 + sv stats/mark/explain/override/export/prune；design §18 + changelog v2.1；frontend-design v2。rm -rf 窄化规则在 decisions #21 已标为 Jack 确认。
- 本提交为 WIP（监督者代提交）：eval 写日志、阈值扫描（sweep）、redact/检测器/config 调整；bun test 679/0，tsc 通过。eval logging/sweep 的测试尚未补完（中断时正在写）。
- 待办（.supervisor-run/msg4.txt）：#20 标为 Jack 已确认（X2 跟随 mode，shadow 不拦截）；shadow 下 X2 记录 severity=dangerous、outcome=would_have_blocked，sv stats 按危险统计；frontend 加危险徽标/筛选/会话危险计数/"本应拦截"指示器。之后继续 M3。

## shadow 下的危险标记（Jack 确认 #20 之后）
- 确认：上一条的 5 项（前端 CLAUDE.md 单独提交、rm -rf 口径确认并同步 design、删除模型分档、日志与可观测性、前端文档第二版）均已完成并提交；advisor 复核后的修复也已完成（`--set` 严格校验、写死阈值进 `thresholds`、脱敏例外收窄、`sv eval --sweep/--log`、design §18.6 可执行 SQL 与 §18.7 数据缺口）。
- #20 标记为 Jack 已确认，X2 行为不变。
- 日志 schema v2：X2 命中 `severity='dangerous'` + 类别/对象/原因，决策 `outcome`（`would_have_blocked` ≠ `blocked`），旧库自动补列；`sv stats --by danger`、`--by session`（⚠危险 / 本应拦截 / 已拦截三列，`--sort-danger`）、`--by rule` 带结局分布；回放文本 `⚠` + `◌ 本应拦截·未生效`，`summary.dangerous`。
- design.md：v2.1 changelog 新增一条，§18.5–18.7；frontend-design.md：各视图的危险徽标/筛选、会话危险数与排序、「本应拦截」指示器及视觉规范（§7.5）、API 字段（§9.1）。
- 测试：`bun test` 687+ 通过 / 0 失败；`tsc --noEmit` 无错误。

## M3 — 守护进程、outbox、sv-hook、live judge（完成；Claude Code 先行）
**做了什么**（decisions #48–54）
- **store**：schema v3 新增运行状态表 `outbox` / `injections` / `plans`；`Outbox`（`packages/core/src/store/runtime.ts`）单条 `UPDATE…RETURNING` 原子领取 + 租约 + 过期回收 + 过期丢弃 + 投递前复核前置条件；并发测试（同进程多连接、**6 个进程同时领取 240 条**、租约回收）证明不会重复确认投递。
- **守护进程** `packages/daemon`：UDS（socket 0600、目录 0700）或 `127.0.0.1` + Bearer token（常量时间比较）；协议版本头（不一致 426）；`POST /v1/hook` → `normalizeClaudeHook` → 每会话一个 Engine → `LogSink` 一个事务写入；outbox 在注入点原子送出；后台 judge 不挡 hook；`adapter_health`（含 hook 的失败 spool）、`kind='live'` 的 run、优雅退出（`Engine.close()`、结束 run、移除 socket）；重启恢复 injections/plans；`.supervisor/plan.md` 读取；工作区指纹同步复核。
- **sv-hook** `packages/hook`：本地 X2（仅 enforce）、转发守护进程、`adapter-claude` 白名单输出；**shadow 永不拦截（含 X2，只记 would_have_*）**；任何故障 fail-open；`bun run build:hook` 编出单文件；`sv install claude [--launchd]` 只打印。
- **live judge**：端点/模型/路由/response_format/超时全部可配（默认 Magpie 路由组 `http://127.0.0.1:3425/v1`，`judge.enabled` 默认 false）；`json_schema` 优先，上游拒绝则回退 `json_object` 并缓存；稳健解析/修复；任何错误 fail-open；`sv replay|eval --judge=live`、`sv start --judge=live`；解析失败率经 `sv stats --by judge`、`/v1/status` 可见；请求/响应脱敏后入日志。测试一律对着本机 `127.0.0.1` mock server，没有调用任何外部服务，没有读任何密钥文件（key 只来自注入的环境变量）。
- **CLI**：`sv start | status | install`；`.sv-tmp/` 与 `bin/` 已 gitignore 且未被跟踪。
- 所有规则仍通用、只有一套阈值，模型名只记日志（守护进程测试：换三个模型名，命中序列一致）。

**测试结果**：`bun test` 783 通过 / 0 失败（26 个文件）；`tsc --noEmit` 无错误。

**偏离 / 未完成**：见 decisions #54——hook 不会自动拉起守护进程；Codex/OpenCode 适配器、asyncRewake、`parent_session_id`、前端文档里的查询 API（sessions/hits/judge-calls/rules/danger…）都还没做；Claude hook 载荷格式未经真实输入校准；改 mode 需重启守护进程。

## M4（代码部分）— Codex 0.163.x 适配器（完成；shadow 一周与真机校准不归我做）
**做了什么**（decisions #55–66）
- `packages/adapter-codex`：`parse.ts`（与 replay 共用的解析，replay 反过来依赖它）、`normalize.ts`（`normalizeCodexHook`，与 adapter-claude 同构：`Normalized{hookPoint, events, stopHookActive…}`；PostToolUse 的退出码来自输出头 / `metadata.exit_code`，否则交给 FailureClassifier，不默认成功；`apply_patch` 两种形态、`exec_command`/`shell`/`Bash`、`update_plan`、`cwd` 回退到 `workdir`、`tool_input` 为 JSON 字符串）、`render.ts`（白名单 render：Pre = deny 三字段或仅 additionalContext，Post = additionalContext，Stop = decision:block+reason；**`ask → deny`**；PostToolUseFailure/PostToolBatch 等返回 null）。
- §3.5 契约测试（Codex 部分）：`test/contract/codex/*.json` 共 19 个手写 fixture（不是从 render 生成的，每个注入点 × 每种 kind 都有）+ 不变量（任何输出都不含 `"ask"`、`continue`、`stopReason`、`suppressOutput`、`updatedInput`、`updatedMCPToolOutput`、`systemMessage` 和 Delivery 内部字段；Post 不出现 permissionDecision/decision；`stop_hook_active` 遵守；≤600 字符；`emittedText` 与实际输出一致）+ X2 文案交叉校验。
- 守护进程：`/v1/hook` 按 `harness ∈ {claude, codex}` 选归一化器（未知 400）；会话运行时按 `(harness, session_id)`；`adapter_health`/`adapterFailures15m` 按真实 harness 记；**origin 登记改用实际输出（截断后）的字符串**（P0-6，Claude 一并修复）。
- sv-hook：同一个二进制，`sv-hook codex`（参数优先）；forward 体、spool 标签、本地 X2（`harness:"codex"`）、render 全部按 harness；shadow 永不拦截，advise 只放行 advise，守护进程不可达/超时/坏响应/自己抛异常一律 exit 0 不输出并写 spool；`SV_HOOK_DUMP=1` 写脱敏载荷样本（默认关）。
- `sv install codex`：只打印 hooks.json 片段与步骤（固定命令串 `…/sv-hook codex`、`/hooks` 里按哈希信任、未实测提示），不读也不写 `~/.codex`（测试用假 HOME 验证）。 `sv install claude` 的命令串也改成显式的 `sv-hook claude`，不再依赖兜底判断。

**测试结果**：`bun test` 864 通过 / 0 失败（31 个文件；含 `main-argv.test.ts`，真的拉起 `main.ts` 进程验证 argv 路由：同一输入写 `.env`，无参数/`claude` 是 ask，`codex`/`--harness=codex` 是 deny）；`tsc --noEmit` 无错误。所有测试不发网络请求，没有读 `~/.codex`、`.env` 或任何密钥文件；`bun run build:hook` 仍能编出单文件。

**§16 第 2 条的结论：仍未决，这一轮无法回答**（两个子问题都需要真实的 Codex 运行）：
1. *钩子能不能收到 `update_plan`*：适配器**如果**收到会正确处理（kind=plan、tracker 计划更新，有测试），但合成样本不能证明 Codex 真的会触发。回答它只需要 Jack 以 `SV_HOOK_DUMP=1` 跑一次带计划的 Codex 会话，看 `~/.agent-supervisor/dumps/codex-<日期>.jsonl` 里有没有 `tool_name: update_plan`。
2. *rollout 里 function_call_output 的写入延迟*：取决于 rollout 跟读（对策 2），那要读 `~/.codex/sessions`，被 CLAUDE.md 禁止，没有做（#60）。

**偏离 / 需要 Jack 确认**
- 【已决定：Jack 批准，保持现状】`ask → deny`（#57）。原备选：如果希望 Codex 上的 ask 类降级为 additionalContext 而不是拦截，改 `adapter-codex/src/render.ts` 一处即可（fixture 同步）。
- 【已决定：Jack 不批准】读 `~/.codex/sessions` 做退出码回填与延迟测量（#60）：继续禁止，不做 rollout 跟读与长命令回填；§16 第 2 条后半（rollout 写入延迟）因此不做。

**未完成 / 已知缺口**
- Codex 真实载荷校准（tool_name 取值、tool_response 形态、cwd 字段、`turn_id`）、hooks 配置格式（timeout 单位、功能开关、`~` 展开）全部未在 0.163 上验证。
- 长命令在钩子路径上无法回填退出码（#59）；Codex async 钩子输出（design §3.2「异步建议」）未用。
- Stop reason 的措辞（design §3.2「用户口吻的事实陈述」）：**判定为基本满足**。本地预设 P3 文案是「最后一次编辑之后没有运行过相关测试、targeted 测试或构建。」——事实陈述，没有规则 ID、没有 supervisor 的元口吻；judge 提示要求 `message_to_agent` 是事实加一个具体的下一步、不含代码/命令/URL/系统式指令，输出后过滤再去掉标签/URL/代码块/shell 行并限 600 字符。保留的缺口：文案只做了人工审读，没有在真实 Codex 上看过模型对「reason 变成 user prompt」的反应；P3 预设只有观察、没有下一步。
- M3 遗留不变：hook 不会自动拉起守护进程、改 mode 需重启、前端查询 API、asyncRewake、`parent_session_id`。（OpenCode 适配器已在 M6 完成，见下文「M6」一节。）
- M4 的「shadow 跑一周、零阻塞事故」需要 Jack 的机器与时间，不是代码问题。

## M6（代码部分）— OpenCode V2 适配器（完成；未在 OpenCode 2 上实测；shadow 观察不归我做）
**做了什么**（decisions #68–77）
- `packages/adapter-opencode`：`normalize.ts`（`normalizeOpenCodeEvent`，与另两家同构：`Normalized{hookPoint, events, …}`；tool.before→pre，tool.after→post（`status:"error"` 直接判失败），context→注入点（带 `userMessage` 时产生 prompt 事件），permission.evaluate→只是领取点，interrupt/session.created）、`render.ts`（白名单：evaluate→`{effect:"deny",message}`，context→`{system:[text]}`，其余 null）、`plugin/agent-supervisor.ts`（自包含插件，fail-open，按返回的 mode 再过滤一道，inject_repeat）。
- 契约测试（OpenCode 部分）：`test/contract/opencode/*.json` 13 个手写 fixture + 不变量（只允许 effect/message/system；effect 只会是 deny 且一定带 message；context 只有 advise；其他注入点恒 null；≤600；X2 文案交叉校验）。
- daemon：`harness=opencode`，block/ask 经 outbox 在 `permission.evaluate` 领取，advise 在 `context` 领取；shadow 下全程无输出，只记 `would_have_blocked`（有测试）；origin 回显判 `supervisor`（有测试）；换模型名命中序列一致（有测试）。
- `sv install opencode`：只打印插件源码与步骤（假 HOME 验证不碰用户目录）。
- 复用：core 的 `preEvent/postEvent/toolKind/x2Check`（x2 对非 Claude 本来就是 deny）、`adapter-codex/parse.unpackOutput`；daemon 的 outbox/租约/前置条件/injections 一行没改。

**测试结果**：`bun test` 917 通过 / 0 失败（35 个文件）；`tsc --noEmit` 无错误。不发网络请求（插件测试只连本机 `Bun.serve`），没有读 `~/.config/opencode`、`~/.codex`、`~/.claude`、`.env`。

**偏离 design**：OpenCode 无本地 X2（#74）；Pre 事件取自 execute.before 而非 evaluate（#69）；拦截全部经 outbox（#70）。

**需要 Jack 决定 / 真机才能回答**
- OpenCode 2 的真实插件接口：`Plugin.define` 的导入路径与插件加载方式；hook 对象字段（`tool/args/callID/status/result`、`messages` 的形态、`sessionID`）；`execute.before` 与 `permission.evaluate` 的顺序；hook 处理函数能否是 async（插件按 async 写的，同步-only 的话 evaluate 的 deny 写不进去）。全部未实测，形态对不上时插件 fail-open。
- OpenCode 是否需要本地 X2（#74）？
- 在顺序核实之前 OpenCode 不要开 enforce（#70/#78：拦截已绑定到调用，错序时是漏拦而非误拦，但漏拦率未知）。
- **OpenCode 本地 X2（#74）是 enforce 的阻塞项**：X2 是唯一应当在守护进程故障时仍生效的规则，目前 OpenCode 上守护进程不可达就放行。单文件不是障碍（可用 bun build 把 `x2Check` 打进插件），真正的障碍是 evaluate 不带参数，要靠 tool.before 的参数。需要 Jack 决定是否做，以及真机确认顺序。

## 前端查询 API 第一批（只读；完成）
- `packages/daemon/src/query-api.ts` + 路由接入（decisions #79）：sessions / sessions/{id} / hits/{id} / runs / runs/compare / rules/stats / judge-calls/stats / danger/stats / danger/events。全部调用已有的 queries.ts 函数，没有新增 SQL。
- 测试 `packages/daemon/test/query-api.test.ts`（7 个）：对着真实 daemon 日志查询；shadow 下危险是 would_have_blocked 而非 blocked；参数校验；故意破坏表证明 500 不计入 adapter_health 且恢复后正常；HTTP 无 token 401。
- **测试结果**：`bun test` 927 通过 / 0 失败（36 个文件），`tsc --noEmit` 无错误。
- **没做**：见 #79 的清单（timeline/hits 列表需要新查询，是下一步；`/v1/stream`、写入类、schema）。

## 前端只读查询 API 第二批（完成）
- 新查询 `core/store/queries-ui.ts`（`sessionTimeline / sessionEvents / listHits / sessionChildren / sessionRun`）+ 测试 `core/test/queries-ui.test.ts`（10 个：合并/pending/分页/过滤/标注/危险 outcome）。
- 端点（`daemon/src/query-api.ts`）：`/v1/sessions/{id}/timeline|events|children`、`/v1/hits`（游标分页+过滤）、各 `.csv` 导出（公式注入防护）、`/v1/schema/{name}`（`daemon/src/schemas.ts`）；测试 `query-api2.test.ts`（真实响应按 Schema 校验）。
- `GET /v1/stream`（`daemon/src/stream.ts`）：NDJSON/SSE、过滤、游标续传、reset、心跳、慢订阅者断开；daemon 在 hook 处理处 publish（session/event/hit/decision/delivery，轻量字段）。测试 `stream.test.ts`（12 个，含 publish 内部损坏时 hook 仍 200）。
- 决定见 decisions #80–87；写入类接口只出了设计（#87），没有实现。
- **测试结果**：`bun test` 957 通过 / 0 失败（39 个文件）；`tsc --noEmit` 无错误。不联网，不读 `~/.codex`、`~/.claude`、`.env`。
- **没做**：见 #86（incidents、judge-calls 明细、rules/config/replays/eval/overrides、children 实际数据）、Schema 的 Go 生成与黄金样例。（其中 judge-calls、rules、config、黄金样例已在下面两节补完。）

## OpenCode 2：本地 X2 / 观察模式 / 核对工具（代码完成；**钩子核对本身没完成**）
**做了什么**（decisions #88–95，Jack 的决定已先记入）
- 插件里加了本地 X2（`execute.before` 的参数 → `x2Check`，绑定到那次调用，`execute.after` 后作废）；`sv install opencode` 用 `Bun.build` 把 `x2Check`/`redactDeep` 内联成单文件再打印。
- **观察模式闸门**：deny 需要 `hook.json` mode=enforce 且 `SV_OPENCODE_ENFORCE=1`；守护进程侧 `opencodeEnforce`（默认 false）为 false 时 opencode 会话按 advise 运行，block/ask 只记 `would_have_blocked`（同 daemon 里 claude 会话不受影响）。
- 真机核对工具：`SV_OPENCODE_DUMP=1` 落样本、`SV_OPENCODE_PROBE` 探针、`sv opencode-report` 汇总（字段、B/E/A 触发顺序、耗时、deny 观察、结论）、`docs/opencode-verify.md` 清单（12 条假设 + 步骤 + 通过标准）。
- 收尾续跑研究：`adapter-opencode/src/stop.ts`（纯函数 + 护栏 + 测试，未接线，不宣称可用）。

**核对结论（重要）**：**没能对照 `@opencode/plugin` 2.0.32 的类型/文档核实。** 包不在可读位置（全局只装了 `@opencode/cli` 2.0.32，是二进制），项目里不联网装不了；文档站抓取（WebFetch）的权限被拒绝两次。所以「实际存在的钩子清单」「与现有适配器的差异」**给不出来，也没有改设计**；12 条假设全部仍是未核实，逐条写在 `docs/opencode-verify.md` §1。要继续需要 Jack 二选一：把 `@opencode/plugin` 的 `.d.ts` 拷到 `docs/vendor/opencode-plugin-2.0.32/`，或放行文档站抓取。

## 前端只读查询 API 第三批（完成）
- judge-calls 列表/详情/CSV、`/v1/rules`、`/v1/config`（只读、凭据遮掉）、sessions 的 recent 排序与 q/state 过滤、黄金样例（decisions #96–99）。新查询在 `core/store/queries-ui.ts`，目录在 `core/src/rules.ts`，视图在 `core/src/config-view.ts`。
- **测试结果**：`bun test` 1009 通过 / 0 失败；`tsc --noEmit` 无错误。不联网（除两次被拒的文档站请求），不读 `~/.codex`、`~/.claude`、`.env`、`~/.config/opencode`。
- **（已过时，见下一节）** 原「仍没做」清单里的 incidents、写入类接口、/v1/overrides、/v1/replays*、/v1/eval* 已被 Jack 的 23:41 决定否掉；config/validate 与来源标注已在下一节完成。

## Jack 23:41 的决定落地：前端只读，只有规则可编辑（完成）
**决定**（decisions #100–104，design §19，frontend-design v3）：前端完全只读；唯一可改的是规则；`manual_*` 只记录、永不影响策略；不做 incidents。被否掉的设计（override/标注/批量/回放触发的写接口、`/v1/overrides`、incidents）已从 decisions #86/#87 和 frontend-design 里删除，没有留兼容层（这些接口本来就没实现过；CLI 的 `sv mark`/`sv override` 保留，纯记录）。

**做了什么**
- **规则编辑路径**（唯一的写接口）`PUT /v1/rules/{id}`：body 只能是 `{disabled}` / `{thresholds}`（T1–T8 写成 `{ladder:{…}}`）/ `{reset:true}`；纯函数校验 `validateRuleEdit`（`core/src/rule-edit.ts`）：未知规则 404、X2 受保护 403、未知字段/键 400、数值范围、阶梯单调且不能新增级别、L5/R2 跨字段一致、`action: off` 的规则不能从界面启用（409）；不能改 mode/judge/预算/日志。通过后原子写 `<home>/rules.local.json`（0600），**只对之后新建的会话生效**，审计追加到 `<home>/rules-edits.jsonl`；额外要求 JSON 内容类型且不能带 `Origin` 头；写失败 500 且内存配置不变；编辑串行化；重启后覆盖仍在，文件损坏则忽略。`GET /v1/rules` 每条多 `edited`/`protected`，并修了「配置里 `id_xxx` 前缀键读不到」的老问题（`ruleConfigKey`）。
- **`POST /v1/config/validate`**（不改任何状态）：YAML 文本或 `{yaml}`；返回 `valid/errors/warnings/diff/enablesBlocking`（`core/src/config-validate.ts`）。
- **`GET /v1/config` 增加 `sources`**（default / configured / rules.local；不区分全局/项目文件，因为守护进程不知道）。
- **`manual_*` 记录而已**：测试①扫描源码，只有 store 类型和 CLI 提到；②同一段会话里记录若干 manual_*，命中/决策序列与不记录时逐条相同。
- 黄金样例补了 ConfigValidation、ConfigView.sources、Rule.edited/protected；schema 同步。

**测试结果**：`bun test` 1050 通过 / 0 失败；`tsc --noEmit` 无错误。不联网，不读 `~/.codex`、`~/.claude`、`.env`、`~/.config/opencode`。

**还剩什么（不依赖 Jack）**：`/v1/replays*`、`/v1/eval*` 的只读结果接口（回放/评测仍由命令行发起）；`/v1/runs/{id}`；Go 侧结构体生成与对应的黄金样例测试（MyGo 项目）；hook 自动拉起守护进程、mode 热加载（一直按判断不做）；`rules.local.json` 目前只有 API 能写，没有命令行入口。
**等 Jack**：OpenCode 三项（取类型还是放行文档站、探针是否启用、`opencodeEnforce` 开关方式）——OpenCode 继续只观察、钩子仍未核实；规则编辑的生效范围是否接受「只对新会话生效」（也可以改成对在跑会话立即生效，但会话中途阈值会跳变）；是否要 X2 之外的规则也设为不可停用（例如 P1 显式计划拦截）。（上面三项里 OpenCode 的部分已被 Jack 23:57/23:58 的决定取代，见下一节。）

## run11：OpenCode 类型核对 + opencodeEnforce 开关 + 剩余只读接口（完成；真机验证未做）
**决定**（decisions #105–111）：类型已 vendor 到 `docs/vendor/opencode-plugin-2.0.32/`，不再抓文档站；探针获批；`opencodeEnforce` 开关委托实现；规则编辑是否作用于在跑会话、P1 是否 protected 记为「等 Jack」（#108），未擅自改。

**1. 类型核对（`docs/opencode-verify.md` 已重写，#109）**：12 条假设里，钩子名和事件字段大体成立，但发现并修了 5 处与假设不符：①hook 注册返回 `Promise<Registration>`（原先同步忽略）→ `setup` async、await 注册、返回清理函数；②`context.system` 是 `Array<SystemPart>` 不是字符串数组 → 只在形态可确认时才注入；③工具事件字段是 `id`/`input`、没有 `directory`；④有专门的 `session.hook("prompt")` → 新增 `event=prompt`，作为 user 消息入口；⑤`PermissionEvaluation.source.id` 是工具调用 id → 本地 X2 按它精确绑定调用。**发现**：`execute.before` 可以以 `Tool.Error` 失败（官方拒绝通道，不依赖 evaluate 顺序），暂未使用。**仍未核实**：`Permission.Effect` 取值、`SystemPart`/`Message`/`Location`/`PromptInput` 形态、触发顺序、是否每次调用都触发 evaluate、interrupt 事件、`session.prompt` 参数、插件在 OpenCode 里怎么登记——引用的类型包（`@opencode/schema`、`@opencode/ai`、`@opencode/client`）没有 vendor，清单 §4 列了需要补哪些。
**2. `opencodeEnforce` 开关（#110）**：`sv opencode-enforce status|on|off`；默认 OFF；`on` 要求最新 opencode-report 的机器门槛全过（五个钩子注册、≥5 次完整调用、evaluate 全在 before 之后、写类工具都触发 evaluate、探针 deny 生效、无异常、样本 ≤14 天）**并且** `--approved-by`；每次切换（含拒绝、noop）写 `opencode-enforce.log.jsonl`，日志写不进去就不改状态；守护进程新建 opencode 会话时读 `opencode-enforce.json`（损坏/缺失=关），不用重启。真正拦截要三个条件：全局 `mode=enforce` + 开关 ON + 插件进程 `SV_OPENCODE_ENFORCE=1`。`sv opencode-report` 输出新增「机器门槛」一节。
**3. 探针（#106）**：代码和清单已就绪（`SV_OPENCODE_PROBE`，清单 §3 步骤 4）。**我没有在真机上跑**：需要 Jack 决定插件放哪、怎么登记（会碰 `~/.config/opencode`，按约束必须先问 Jack）。
**4. 剩余只读接口（#111）**：`/v1/runs/{id}`、`/v1/replays[/{id}]`、`/v1/eval/reports`（均只读，无 POST/DELETE）；`sv rules show|set|reset` 命令行入口（与 API 同一套校验和文件），守护进程在新会话前自动重读 `rules.local.json`。
**测试结果**：`bun test` 1076 通过 / 0 失败；`tsc --noEmit` 无错误。不联网，不读 `~/.codex`、`~/.claude`、`.env`、`~/.config/opencode`，没碰 session ab4727f2。

**还剩什么（不依赖 Jack）**：Go 侧结构体生成和对应测试（MyGo 项目）；`Tool.Error` 拒绝通道（等类型补齐再评估）；interrupt 事件订阅（等 `@opencode/client` 的事件模型）；hook 自动拉起守护进程、mode 热加载（一直按判断不做）。
**等 Jack**：①真机核对：把 `@opencode/schema`/`@opencode/ai`/`@opencode/client`（同为 2.0.32）的 `.d.ts` 拷到 `docs/vendor/`，可以不用真机就定下大部分标 ? 的项；②插件放哪、怎么登记到 OpenCode（我不碰 `~/.config/opencode`），然后一起按清单 §3 跑（含探针）；③规则编辑是否立即作用于在跑会话（现在只新会话）；④P1 是否也 protected（现在只有 X2）。

## run12：类型补齐核对 + 规则编辑立即生效 + 真机测试项目（完成；真机验证未做）
**决定**（decisions #112–116）：Jack 00:24 补齐了 `@opencode/schema|ai|client` 2.0.32 的类型（已提交到 `docs/vendor/`）；00:26 对 #108 的回答：①真机核对用专门测试项目、只项目级配置、绝不碰全局配置、跑之前先列步骤；②规则编辑改成立即作用于在跑的会话；③P1 不设 protected（只有 X2 锁定）。

**1. 类型核对第二轮（#115，`docs/opencode-verify.md` 重写）**：`Permission.Effect="allow"|"deny"|"ask"` ✓；`SystemPart={type:"text",text,…}` ✓ → `injectSystem` 改为追加干净部件（空数组也能注入，不复制 cache 提示）；`Location.Info.directory`、`Model.Ref`、`session.prompt` 入参（平铺 `{sessionID,text,delivery:"steer"|"queue"}`）✓；**中断**：`session.execution.interrupted`（data.reason）经 `context.event.subscribe` 拿到 → 插件订阅，只有 `reason=user` 才上报 `event=interrupt`，清理时 abort，失败 fail-open；「一轮结束」= `session.execution.succeeded|failed|interrupted`（stop.ts 仍未接线）。`Tool.Error` 是运行时类，不 import 运行时包就用不了，暂不用。**仍只能真机**：触发顺序、是否每次调用都有 evaluate、工具名/参数形态、Esc 是否产生 reason=user、`opencode.json` 文件名/`plugins` 登记是否生效、`Tool.Error` throw 是否被当成拒绝、排队 prompt 语义。
**2. 规则编辑立即生效（#114）**：`Engine.setCfg`/`Policy.setCfg`；`PUT /v1/rules/{id}` 成功后和每次 hook 发现 `rules.local.json` 变了（`sv rules` 写的，一次 stat）都把新配置推给所有在跑的会话；会话保留自己的 mode（opencode 观察模式降级不被冲掉）；`appliesTo:"all_sessions"`；design §19 / frontend-design / `sv rules` 提示同步。会话中途阈值会跳变（Jack 已知情），命中的 `threshold_json` 记当时的值。
**3. 真机测试项目（#116）**：`sv opencode-probe-project <目录> [--apply]`，默认 dry-run 只打印计划；`--apply` 创建 `opencode.json` + `.opencode/plugins/agent-supervisor.ts` + 4 个脚本（start-daemon / run-observe / run-probe / report）+ `git init`；数据目录 `<项目>/.sv-home`；脚本 `unset SV_OPENCODE_ENFORCE`；目录检查拒绝 `~/.config` 等。**我没有 `--apply` 过，也没有启动 OpenCode 或守护进程**；步骤见 opencode-verify.md §3，等 Jack 同意。
**测试结果**：`bun test` 1084 通过 / 0 失败；`tsc --noEmit` 无错误。不联网，不读 `~/.codex`、`~/.claude`、`.env`、`~/.config/opencode`，没碰 session ab4727f2。生成的脚本有测试用桩 `opencode` 真的执行过（外层残留的 `SV_OPENCODE_ENFORCE`/`PROBE` 不会继承）。

**还剩什么（不依赖 Jack）**：Go 侧结构体生成和黄金样例测试（MyGo 项目，不在本仓库）；`Tool.Error` 拒绝通道与收尾续跑接线（都要真机证据后再做）；hook 自动拉起守护进程、mode 热加载（一直按判断不做）。本阶段不依赖 Jack 的实质工作基本做完。
**等 Jack**：①同意后按 opencode-verify.md §3 跑真机：先 `sv opencode-probe-project <目录>` 看计划，同意再 `--apply`，然后一起跑（含探针）；②测试项目放哪个目录（建议仓库外，例如 `~/Documents/dev/opencode-sv-probe`）；③Claude hook 真实载荷校准与 30 个会话标注（需要 Jack 的数据，见前文）。

## run13：Jack 07:18 批准真机核对与数据请求（decisions #117–118）
- **测试项目已创建**：`sv opencode-probe-project ~/Documents/dev/opencode-sv-probe --apply`（8 个文件 + git init/一次提交；只项目级配置，没碰任何全局配置）。
- **真机流程我没能跑**：本会话里运行 `opencode`、启动守护进程脚本都需要审批而被拒（包括 `opencode --version`），所以没有任何真机结果，也没有编造。**留给 Jack 的整套步骤**：见 `docs/opencode-verify.md` §3（`./start-daemon.sh` → `./run-observe.sh` → `./report.sh` → `./run-probe.sh` → X2 → 把 `./report.sh` 输出和 `opencode --version` 发回）。其中 Esc 中断、开第二个会话本来就需要交互。结果回来后我据此更新 verify 表的 ? 项并决定要不要改适配器；`opencodeEnforce` 仍默认关。
- **数据请求已写**：`docs/data-request.md`（A. Claude hook 真实载荷样本，用 `SV_HOOK_DUMP=1`；B. 30 个会话标注，用 `sv export` + `sv mark`/`eval/labels.yaml`）。只用本项目自己记录的数据，不读 `~/.claude`、`~/.codex/sessions` 等；等 Jack 自己采集并检查后交给我。
- **等 Jack**：①跑真机清单并回传报告；②按 data-request.md 采集 A/B 两类数据；③（可选）如果希望我直接在本会话里跑 `opencode`/守护进程，需要放行这些命令。
- 本轮只改文档，未改代码；最近一次全量 `bun test` 1084 通过 / 0 失败、`tsc` 干净（run12 末尾）。

## run14：按 OpenCode 真机 run1 修适配器 + 收尾（decisions #119–122）
**真机结论**（`.supervisor-run/opencode-real-run1.txt`，OpenCode 2.0.32）：五个钩子 + event.subscribe 注册成功；探针 deny 生效；X2 `git reset --hard` 记 would_have_blocked；唯一没过的机器门槛是 `before_precedes_evaluate`（出现 BBBEEA、EA、A、BE…）；Esc 未测。
**改了什么**
- 插件：本地 X2 绑定按 (会话, 调用 id) 存（批量调用里危险调用不是最后一个 before 也能对上；evaluate 无对应 before 则放行）。
- `sv opencode-report`：`before_precedes_evaluate` 按调用 id 对账（写类/未知工具的 evaluate 必须有 before 在前；只读工具孤立 evaluate 无害）。**注意：这是门槛语义的调整，不是放松拦截**——拦截仍要 mode=enforce + `opencodeEnforce` 开 + 环境变量，三道闸都没动。用 run1 的原始 dump 重新出报告还没做（dump 在测试项目 `.sv-home/dumps/`，本会话读不了）。
- 登记：`opencode.json` 改空配置；`sv install opencode` / 测试项目说明改为 `.opencode/plugins/` 自动加载。工具名/参数形态 core 早已兼容，无需改。
- 文档：新增 `docs/usage.md`（安装/启用/停用/数据收集/未完成项）；README 指向它。
**测试**：`bun test` 1085 通过 / 0 失败；`tsc --noEmit` 干净。只新增 1 个测试（decisions #120）。
**需要 Jack 决定 / 做的**
1. 在测试项目重跑 `./report.sh`（或把 `.sv-home/dumps/opencode-*.jsonl` 里不敏感的部分给我）确认新的 `before_precedes_evaluate` 通过；若 EA 里有 shell/write/edit 的孤立 evaluate，门槛仍会不过——那说明这些调用的 X2 绑不上，需要再讨论。
2. 日常使用时顺带按一次 Esc 看 `reason=user`。
3. 按 `docs/usage.md` §6 开始收集数据（Claude/Codex dump、shadow 记录、标注）。
4. 是否要把 `opencode-sv-probe` 里的插件更新成新版（重新 `sv install opencode` 覆盖 `.opencode/plugins/agent-supervisor.ts`）。

## run15：run2 复测后收尾（decisions #124；后端 + 命令行阶段结束）
**run2 结果**（f7d7e2d 的插件）：放行检查 7 项过 6 项（`before_precedes_evaluate` 已过、探针 deny 成功、X2 记录正常、路径警告消失）；唯一不过的 `mutating_calls_have_evaluate` 是报告按先后分组造成的误判（并行批次 `before(shell) → 3×read → evaluate(shell) → after(shell)`，同 id 齐全）。
**改了什么**：该项改为按调用 id 对账；加 1 个最小测试（run2 形状通过 + 写类调用缺 evaluate 仍被抓）。write 的 evaluate 动作报 `edit` 已记（#124）。拦截的三道闸没动，`opencodeEnforce` 仍关。
**测试**：`bun test` 1086 通过 / 0 失败；`tsc` 干净。
**后端 + 命令行状态**：Claude/Codex/OpenCode 适配器、守护进程、只读查询 API、`sv` 命令行齐全；使用说明 `docs/usage.md`（已核对完整，README 已链接）。未完成项见 usage.md §7。
**给前端阶段的入口**（#123：前端延后到此之后）
- 设计：`docs/frontend-design.md`（§9 是 API 总表，§11 是要在 MyGo 上先验证的清单，§13 里程碑，§14 已定取舍）；冲突时以 `docs/design.md` §17/§19 为准。
- 可用 API：守护进程只读查询接口（sessions、events、hits、judge-calls[/csv]、rules、config[/validate]、danger/events、runs[/{id}]、replays[/{id}]、eval/reports、实时流 stream）；唯一可写 `PUT /v1/rules/{id}`。契约在 `packages/daemon/src/schemas.ts`。
- 黄金样例：`test/fixtures/api/`（由 `test/fixtures/gen.ts` 生成，`packages/daemon/test/golden.test.ts` 校验）；Go 侧结构体生成与对应黄金测试要在 MyGo 仓库做。
- 前端先用 `sv start` + 回放（`sv replay test/fixtures/claude --judge=mock --log`）灌数据即可开发，不需要真实 agent。

## 前端 run1：MyGo UI0–UI6（decisions #125–136）
**做了什么**（`ui/`，独立 Go module，未 push）
- UI0：MyGo v0.5.5 在本机编译、离屏渲染、10 万行表格 57ms、中日文与 ⚠◌■ 符号显示正常；结论写进 `frontend-design.md` §11.1（实测/文档分开标注）。
- 契约：`bun run gen:ui` 由 schemas.ts 生成 `ui/api/types_gen.go`；`ui/api` 客户端（UDS/HTTP+token、错误分类、NDJSON 流、`PutRule`）；黄金样例契约测试通过。
- 界面（`ui/app`）：顶栏状态 + 连接状态机 → 回放结果 → 实时会话 → 事件时间线 → 规则统计 → judge 裁决/路由 → 规则配置（唯一可写，X2 不可停用）。三态视觉区分，深浅色截图逐页检查过。
- `ui/cmd/sv-ui`：真实窗口入口（`-sock/-url/-token-file/-demo/-quit-after`）；`go build` 产物 17 MB（`ui/bin/`，已 gitignore）。
- `ui/fake`：合成数据假守护进程，供测试/截图/`-demo`。
**测试**：`go -C ui test ./...` 通过（契约、关键逻辑、阈值往返、runner 断线重连、各页截图断言）；`bun test` 1086 通过 / 0 失败。截图：`go -C ui test ./app -shots=<dir>`（`-shots` 只对 app 包有效）。
**偏离设计**：无日期选择器（#134）；CSV 导出、子 agent 展开延后（#132、#135）；路由页是推断（#128）。
**未验证**：没有开过真实窗口（运行 GUI 需 Jack 批准）；VoiceOver、IME、文本选择复制、系统深浅色切换、空窗口内存均未验证。
**需要 Jack 决定 / 做的**
1. 在本机运行 `go -C ui build -o bin/sv-ui ./cmd/sv-ui && ui/bin/sv-ui -demo` 看真实窗口效果、中文输入、VoiceOver；再 `sv start` 后直接 `ui/bin/sv-ui` 连真守护进程。
2. 是否让后端补 `/v1/judge/routes` 与 Status 的 judge 健康/日志大小字段（#128）。
3. 是否要 CSV 导出入口、子 agent 展开（#132、#135）。
4. 打包形式（签名/公证/与 Bun 守护进程的安装方式）尚未做。
5. 确认无日期选择器的取舍（#134）。

## 前端 run2：`/v1/judge/routes` + Status judge 健康/日志库大小（decisions #137–139）
**做了什么**
- 后端：`GET /v1/judge/routes`（`core/src/store/queries-ui.ts` 的 `judgeRoutes`/`judgeHealthOf`，路由匹配抽成 `matchRoute` 与 `JudgeClient` 共用）；`/v1/status` 加 `dbBytes` 与 `judge.health/recent_calls/recent_failures/last_error`。schemas.ts 加 `JudgeRoutes`/`JudgeRouteRow`，`bun run gen:ui` 重新生成 `ui/api/types_gen.go`，黄金样例新增 `JudgeRoutes.json`、更新 `Status.json`。
- 前端：路由页（`ui/app/routing.go`，从 judge.go 拆出）改用真实接口，「推断」标注已去掉；顶栏 judge 芯片按健康显示「▲ judge 降级 / ✕ judge 不可用」，并显示「日志库 N MB」。假守护进程同步（`/v1/judge/routes`、Status 新字段）。
- 删除 `ui/cmd/uismoke`。其余（CSV、子 agent、日期选择器、打包）按 Jack 决定不做。
**测试结果**：`bun test` 1088 通过 / 0 失败（新增 1 个 core 逻辑测试 + golden 里对 `/v1/judge/routes` 的字段对齐）；`tsc --noEmit` 干净；`go -C ui test -count=1 ./...` 通过；深浅色截图看过（`-shots`）。不联网，不读禁区目录。
**偏离 design**：状态阈值（连续 3 次失败、15%/≥10 样本、15 分钟窗口、近 7 天）是实现选的通用常量，frontend-design §5 只给了 15%。路由页没有时间范围控件（固定近 7 天）。
**没做 / 注意**：判断归属依赖调用当时的 `rule_ids`/`sync`；配置改过路由后，历史调用会按**当前**路由重新归类。没有在真窗口里看新的路由页与顶栏（截图只是离屏渲染）。
**等 Jack**：HEAD 在 904728a 之上有未提交改动（见 git status），需要监督者代提交；不 push。

## 前端重设计「值班台」（decisions #140–145，设计见 docs/ui-design.md）
**做了什么**
- 按 Jack 要求从零重新设计并实现桌面前端，不沿用旧布局/视觉：左侧导航轨 + 页头常驻三态计数；6 页——总览（模式结论、三态大磁贴、进行中会话、最近危险事件、规则命中堆叠柱、危险类别环、Judge/系统健康）、会话（项目分组列表 + 心跳条 + 时间线轨道 + 命中检视器，每次命中单独成卡）、危险（逐条事件账本 + 三态筛选 + 分布）、规则（统计、结局构成、开关、阈值编辑，X2 上锁不可停用）、Judge（裁决记录 + 路由链与健康）、回放（运行列表 A/B 对比、运行详情、评测报告）。
- 三态按形状区分（危险=三角浅底、会拦=虚线空心斜体、已拦截=实心墨块），灰度下仍可分；浅色「暖纸」/深色「石墨」两套主题；动效：页面进入、导航软底滑动（Match）、活跃会话与连接灯呼吸、悬停颜色过渡。
- 保留：`ui/api`、`ui/fake`、`ui/cmd/sv-ui`（加了 `TitleBarHidden`）、连接状态机（`conn*.go`）、`logic.go`（把阈值展平/还原函数从旧 rules.go 挪进来）。删除旧视图/样式文件。
**测试**：`go -C ui vet ./...`、`go -C ui test ./...` 通过（logic/契约/runner + 各页截图断言，含 X2 的 PUT 被服务端拒绝时原样显示错误、规则停用只发 `disabled`）；`bun test` 1088 通过 / 0 失败。
**截图**（`.supervisor-run/shots/`，未入库）：`wd-overview-{light,dark,gray}.png`、`wd-sessions-{light,dark,gray}.png`、`wd-sessions-inspector-{light,dark}.png`、`wd-sessions-enforced-{light,dark,gray}.png`、`wd-danger-{light,dark,gray}.png`、`wd-rules-{light,dark}.png`、`wd-rules-x2-{light,dark,gray}.png`、`wd-judge-{light,dark,gray}.png`、`wd-judge-routes-{light,dark}.png`、`wd-replay-{light,dark}.png`、`wd-titlebar-light.png`（模拟 macOS 红绿灯占位）。
**偏离 / 注意**：旧的「事件时间线」「规则统计」「Judge 路由」不再是独立页（合并，decisions #141）；没有保留旧页面的会话过滤器里的「按 harness / 仅危险」下拉（会话页只有搜索 + 进行中/全部；危险请去危险页）。
**未完成 / 未验证**
- 没有开过真实窗口：`TitleBarHidden` 下的拖动区域与红绿灯避让、vibrancy（未用）、系统深浅色切换、VoiceOver、IME 均未实机验证；请 Jack 运行 `go -C ui build -o bin/sv-ui ./cmd/sv-ui && ui/bin/sv-ui -demo` 看一眼。
- 搜索框占位符是 MyGo 内置英文「Search」，未本地化。
- 回放页对比只支持两个运行；评测报告只列规则行，没有图表；危险页没有按类别/会话的点击筛选；会话页时间线不支持「加载更早的记录」按钮（只显示最近 500 条并提示）。
- 数字没有计数动画（为保证截图稳定先不做）。

## 前端 Linear 式改版（Jack 反馈第一版「花哨」；见 docs/ui-design.md §9）
**做了什么**：信息架构与数据层不变，只重做视觉：灰阶底与文字层级、1px 细线描边、小圆角（8）、无阴影/渐变/大块彩色；导航轨与页头改成细线分隔；环形图删除（类别分布改灰色横条）；规则命中柱仅灰阶；胶囊标签改为细线描边灰字；级别 H/M/L 只用灰度+符号。颜色只留给三态：危险=朱红三角（无底色）、会拦=赭金虚线空心斜体、已拦截=实心墨块反白；灰度截图里三者仍可分。同时修了此前的草稿被后台刷新覆盖、回放默认 A/B 反复补回、窄窗口（960）收起次要信息。
**截图**（`.supervisor-run/shots/`，前缀 `ln-`，浅/深各一，关键页另有 `-gray`）：`ln-overview`、`ln-overview-tall`、`ln-overview-min`、`ln-sessions`、`ln-sessions-min`、`ln-sessions-inspector`、`ln-sessions-enforced`、`ln-danger`、`ln-rules`、`ln-rules-x2`、`ln-judge`、`ln-judge-routes`、`ln-replay`、`ln-titlebar-light`。
**测试**：`go -C ui vet/test ./...` 通过，`bun test` 通过。旧的 `wd-` 截图是上一版风格，已作废。
**未验证**：真实窗口（TitleBarHidden、拖动区）仍未实机看过。

## 前端交互打磨（Cmd+K / J-K / 右侧面板 / 新事件动效 / 只读右键；见 docs/ui-design.md §10，decisions #146–151）
**做了什么**
- `⌘K` 命令面板（`palette.go`）：页面/会话/规则，90ms 防抖，Up/Down/Enter/Esc；打开时补载规则与会话。
- 键盘导航（`nav.go`）：J/K/↑↓/Enter/Esc 各页统一；面板打开时页面键位暂停；输入框打字不触发（有测试）。
- 右侧滑出面板（危险/会话命中检视/Judge）：浮层不推挤列表，位移+透明度 200ms 缓出。规则页详情仍常驻（要编辑阈值）。
- 新事件滑入 + 高亮淡出（`motion.go`）：首屏不算新；高亮窗口 1.6s；减弱动态效果时无位移、固定强度、到点重画一次。
- 悬停提示（导航 ⌘N、页头 ⌘K、关闭 Esc）；右键菜单（危险事件/命中/会话/规则/裁决）只含查看、复制、跳转，无任何写操作。
- 性能：时间线 rows/stats/心跳格按（数据版本，筛选）缓存；危险页筛选结果缓存；去掉所有 `Loop` 常驻动画（空闲不请求帧，`TestIdleNoFrames` 六页覆盖）。
- 演示：`sv-ui -demo -demo-events 5000`（会话 A 灌 5000 步）、`-demo-live`（每 8 秒推一条新危险事件，看滑入高亮）。
- 顺手：`TestRunnerReconnects` 的 post 加互斥（真实环境 post 在主线程串行，测试里原先是多协程并发写 App 状态）。

**性能检查**（`TestPerfFlood5000`，Tester 离屏、只含 CPU 侧布局/绘制，不含 GPU 栅格；`go -C ui test ./app -run Perf -v` 复现；本机 Apple 芯片一次实测）
| 项 | 耗时 |
|---|---|
| 灌 5000 步（≈6000+ 行含命中）后首帧（含建缓存） | ≈6.5 ms |
| 稳态帧 | ≈0.7 ms |
| 滚动一帧 | ≈2 ms |
| 切页（含同步拉数据到本地 fake） | 危险 23 ms · 总览 20 ms · 会话/规则/Judge 9–11 ms |
| 空闲 3 秒后是否还有待处理帧 | 否（CPU≈0 靠「不请求帧」，不是靠测得的 CPU 百分比） |
结论：5000 条下滚动与切页帧耗时远低于 16.7 ms 预算（切页首帧含数据加载，可能略超，但属一次性）。**未测**：真实窗口里的 GPU 帧时间与 `top` 的 CPU 占用（本环境不开真实窗口）；请 Jack 用 `sv-ui -demo -demo-events 5000 -demo-live` 实机看一眼。
**截图**（`.supervisor-run/shots/`，前缀 `ux-`，浅/深各一）：`ux-palette`、`ux-panel`（危险页右侧检视）、`ux-tooltip`（导航「危险 · ⌘3」）、`ux-tooltip-k`（页头 ⌘K）、`ux-context-menu`。**注意**：右键菜单是系统原生菜单，离屏 Tester 渲染不出来，所以 `ux-context-menu-*` 只能显示被右键的那张卡片，菜单内容由 `TestContextMenusReadOnly` 断言（`查看详情 / 复制命令·对象 / 复制会话 ID / 复制命中 ID / 跳到该会话`，且不含任何写操作字样）。
**测试**：`go -C ui vet ./...`、`go -C ui test ./...`、`bun test`、`bun run typecheck` 通过（见提交时的实际输出）。
**偏离/遗留**：回放页没有 J/K（只有两列对比，没有长列表）；`SearchField` 占位符仍是英文 Search；缺少的工具：无（未安装任何东西）。
