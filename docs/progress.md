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

**测试结果**：`bun test` 360 通过 / 0 失败；`tsc --noEmit` 无错误。分类器 CmdClass 用例 ≥150 条（要求 ≥100），另有 mutating 用例约 75 条。

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
