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
- X2 跟随 mode（shadow 只记录，enforce 才拦）（#20）——请确认。
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
- §3.5 契约测试（Claude 部分）：`packages/adapter-claude/src/render.ts`（白名单 + `sanitize` 兜底，PreToolUse/PostToolUse/PostToolUseFailure/PostToolBatch/Stop 各一格）；`test/contract/claude/*.json` 共 18 个手写 fixture（不是从 render 生成的）+ 不变量测试（只有白名单字段、不泄漏 ruleId/deliveryId/expires、Post 类事件绝不出现 permissionDecision/decision、deny/ask 不带 additionalContext、Stop 遵守 `stop_hook_active`、600 字符截断、空输出）。X2 的真实输出与 fixture 文案做交叉校验。
- 复盘修复（advisor 复核后）：vitest watch 判定改看命令自己的 `CI=` 赋值；回放输出（JSON 与文本）整体脱敏；X2 改为跟随 mode；时间线新增 `callIndex`。

**测试结果**：`bun test` 636 通过 / 0 失败（16 个文件）；`tsc --noEmit` 无错误。全部测试不发网络请求（judge 测试里 `fetch` 被陷阱）。

**偏离 / 需要 Jack 确认**
- 误报率口径取 per-alarm（FDR），见 decisions #31。
- X2 跟随 mode（#20）。
- **这一阶段没有做 outbox 原子领取**（属于 M3 的 store/outbox，design §3.4/P0-8），也没有做守护进程、`--judge=live`、sv-hook、Codex/OpenCode 的 render 契约测试。
- 合成样本与真实 transcript 的差异、30 个会话的人工标注与阈值校准都还没做（需要 Jack 的数据）。

## 前端设计文档（完成，仅文档）
`docs/frontend-design.md`：按更新后的 CLAUDE.md，框架已定为 **MyGo native UI**，因此没有做 native / Naive UI 的方案对比，也没有「请 Jack 确认」那一句。内容：信息架构；5 个页面（实时会话、事件与事故时间线、Judge 裁决、规则与配置、回放结果）的 ASCII 线框与每页的空/错误状态；守护进程要提供的 API 表（UDS / HTTP+token，协议版本头，v1 唯一的写接口是会话静音）；以 JSON Schema 为唯一来源、Go 结构体生成、共享黄金样例的类型复用方案；SSE（HTTP）/ NDJSON（UDS）实时推送，`since` 断线续传与 `reset`；UI 状态机与重连退避、Go 侧 Store 与 10 Hz 合并；可访问性（并把「GPU 自绘界面可能没有系统无障碍树」写成风险项）；隐私展示规则；以及**需在 MyGo 上验证的清单**（表格虚拟化、自绘图形、文本选择复制、输入法、系统无障碍、焦点管理、缩放与深浅色、线程模型、通知、体积与内存、打包）。**没有编造 MyGo 的组件名或 API，也没有给出体积/内存数字**（本阶段不联网、未实测）。
