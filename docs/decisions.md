# 设计决策记录（design 未写清楚、实现时自行选择的地方）

## M0
1. **目录与导入**：不用 bun workspaces，用 `tsconfig.json` 的 `paths`（`@sv/core`）引用 core；包内部用相对路径。减少 `bun install` 链接步骤。依赖只有 devDependencies：`@types/bun`、`typescript`。
2. **`mutating` 的语义**：指「可能改变工作区、而 git 指纹看不到或不一定看得到」的命令（安装依赖、构建、迁移、docker、`git add/commit`、写文件的重定向等）。写到 `/tmp`、`/dev/null`、`$TMPDIR` 的重定向和 `tee` 不算 mutating，但目标仍记录在 `targets` 里（检测 smoke 脚本新建要用）。普通脚本（`python x.py`）不标 mutating——它们对仓库文件的改动由 git 指纹捕获。
3. **构建命令一律 mutating**（design §4.3 写了「构建命令」）。所以 `npm run build` 夹在两次测试之间，会让 T1/L1 的「期间无改动」条件不成立，偏保守（少拦）。
4. **`pytest | tee out.log`**：`tee` 到仓库内文件算 mutating（符合 design），所以这种写法下 T1 不会因「没改动」触发。已知取舍。
5. **normCmd 保留 `cd <dir>`** 和 `pnpm -F <pkg>`/`--filter` 等范围参数：不同目录/包的同名命令不应被当作同一调用。剥掉的是 env 赋值、`timeout`、`uv run`、`npx`、`python -m`、管道尾巴、重定向。
6. **管道尾巴**：`| tail/head/grep/tee/wc/sort/cat/awk/sed/jq/rg/…` 视为尾巴，不参与分类和 normCmd；但其 mutating 效果（如 `tee file`）仍计入。分类只看上游命令。
7. **测试类别判定的边界**：
   - `pytest tests/`、`pytest .`、`pytest src` 这类宽目录仍算 `test_full`；两层以上路径、具体文件、`::name`、`:行号` 才算 targeted。
   - `go test`（无包参数）算 targeted（只测当前包）；只有 `./...` 才算 full。
   - `cargo test -- <name>` 的 `--` 之后出现非选项参数算 targeted。
   - `pnpm -F pkg test`、`--filter` 视为限定了单个包 → targeted。
   - `make test-fast`/`quick`/`single` 之类算 targeted；`make test TEST=…`/`FILE=…` 变量也算。
   - `vitest` 不带 `run`/`--run`，且**命令自己没有** `CI=1/true`（含 `env CI=1 …`）时为 watch。看的是命令里的赋值，不是 supervisor 进程的环境变量（后者与 agent 那条命令无关，且会让测试依赖运行环境）。
8. **probe 的「项目包」判定**：分类器不知道项目包名，用「不在常见标准库/常见第三方白名单里的 import」近似；相对导入、`require('./…')`、`assert` 一律算。`import numpy` 这类常见第三方包放进白名单（不算 probe）。heredoc 里有写文件调用 → `other` + mutating。
9. **smoke/repro 判定需要上下文**：分类器是无状态的，调用方通过 `ClassifyOptions.newScripts`（本会话新建过的脚本）和 `sourceEdited`（是否已改过源码）传入。新建脚本在改源码前运行 → `repro_script`；改源码后且文件名符合 `smoke*/check_*/verify*/try_*`、`/tmp/*.py` → `smoke_script`。
10. **FailureClassifier**：退出码只认头部（`Output:` 之前，或无 `Output:` 时的前 600 字符），防止输出正文伪造。强失败信号优先于强成功信号；弱信号（`Error:`、`failed` 单词）只对测试/构建/lint/typecheck/脚本类命令采信。带计数的失败模式要求非零（`0 failed`、`Found 0 errors` 不算失败）。
11. **errFingerprint**：错误行最多取 8 条不同的归一化行；归一化会去掉带目录的路径与孤立文件名、行号、数字、十六进制（≥7 位）、UUID、ANSI。只取最后一个 Traceback 的最后一帧。无错误行 → 尾部 300 字符。返回 16 位十六进制；空输出返回 `undefined`。
12. **工作区指纹**：`kind` ∈ `git | non-git | timeout | error`。只有两边都是 `git` 且指纹相同才算「确定没改动」；其余一律按「可能有改动」。指纹包含 `status`（含未跟踪文件逐个列出）、未暂存 diff 哈希、暂存区 diff 哈希、未跟踪文件 `(path, mtime, size)`（最多 2000 个）。`git` 调用设 `GIT_OPTIONAL_LOCKS=0`，避免 `status` 去写 index 锁。
13. **脱敏**：`redact()` 对 `*_KEY=`/`*_TOKEN=`/`password=` 保留变量名只抹值；`redactDeep` 对键名以 key/token/secret/password 结尾的字段整体抹掉。输出头尾各 1k 字符的截断是独立函数 `headTail`，由调用方决定何时用。

## M1
14. **包结构**：`packages/core`（类型、分类器、tracker、检测器、policy、engine、mock judge）、`packages/replay`（读取器、回放、报告）、`packages/cli`（`sv`）。读取器放在 replay 而不是 core，因为 core 以后要被守护进程/hook 复用，不该带 transcript 解析。
15. **Event 流约定**：每次工具调用产生 `pre` + `post` 两条事件（同一 `toolUseId`）。H 级拦截类规则（X2、P1 显式、L1/T1 第 3 次）只在 `pre` 上命中；计数类和 M 级规则在 `post` 上命中；P3 在 `stop` 上命中。回放读取器把 Claude 的「没有 tool_use 的 assistant 文本消息」当作 `stop`，Codex 用 `event_msg.task_complete`。
16. **L1 的次数定义**：同一 argsHash 连续失败（errFingerprint 相同、两次之间无改动）——第 2 次失败的 `post` 上记 M（advise）；第 3 次*尝试*的 `pre` 上记 H。T1 在 `pre` 上评估：第 2 次无改动重跑 advise，第 3 次 H（对所有 agent 一套阈值；**原先「默认档没有 H、GPT 档第 3 次 H」的分档已作废**，见 #41）。`rules.T1_rerun_unchanged.block_on` 是 `thresholds.T1.H` 的别名。
17. **「advise」的表示**：L 级 + `message` = 本地预设建议（不经 judge）；L 且无 message = 只记录。T 组的 advise 因此是「L + 事实陈述 message」；M 进 judge。L 级本地建议：非 T 组每规则每会话最多 1 次，T 组靠冷却（10 步 / 5 分钟，两个条件同时满足才算冷却中）。
18. **阶梯阈值**：`thresholds` 里每条 T 规则是 `{L?, advise?, M?, H?}` 次数阶梯，取满足的最高级，且只在「升级的那一次」触发（边沿触发），避免每一步都重复报。
19. **没有真实指纹时（回放）**：`SessionTracker.unchangedBetween` 返回 `verified | inferred | changed`。`inferred` = 事件流里没有编辑也没有 mutating 命令，但没有真实 `wsFingerprint`。policy 默认（线上）对 `inferred` 不拦，只 advise；回放用 `trustInferredUnchanged=true`，并在时间线里标注 `verified=false` / `wouldBlockIfVerified`。
20. **X2 与 mode（Jack 已确认）**：X2 **跟随 mode**：shadow 只记录（Decision 里 `action` 仍标 block/ask，`applied=false`），advise 模式也不拦，只有 enforce 才生效。理由：config 注释写 `shadow=只记录`，M4 是 shadow 周、完成标准是「零阻塞事故」，M5 才打开 H 级拦截；design 说的「X2 不依赖守护进程」指的是故障时不放行、不是可以无视 mode。`rules.X2_dangerous.action: off` 则连命中都不产生。**Jack 已确认，维持现状**：shadow 是纯观察、完全不拦截；X2 危险操作必须被记录并醒目标记（见 #46）。
21. **X2 的 `rm -rf` 解释（Jack 已确认；design §5.5 已同步）**：design 原文写「删仓库外或 $HOME 下的路径」，但仓库通常就在 $HOME 下。实现为：目标是 `/`、`$HOME` 本身（含 `~/*`）、仓库外的绝对路径/`../` 路径、仓库根或 `.git` 时拦；仓库内普通子目录不拦（可由 git 恢复）；`/tmp`、`/var/folders` 和仓库内构建产物目录（node_modules、dist、build、target…）豁免；含未解析变量（`$X`）的路径无法判断，放行。`git push --force-with-lease` 不拦。
22. **X1 的判断**：只看测试文件（路径含 tests/、spec/、`test_*.py`、`*.test.ts`、`*_test.go` 等）的 Edit/Write/apply_patch：新增 skip/xfail/`.only`；断言数量减少；上一次测试失败后没改过源码就改了断言行。用户意图/当前计划步骤包含「写测试、补测试、flaky、快照、基准、修 CI」时降为 L。「fix the failing test」**不**算豁免（那通常是要修源码）。
23. **P1 的允许范围**：plan.md 写了 `allow:` → 显式（H，本地拦，不问 judge，不受连续拦截上限）；否则用当前 in_progress 步骤文本里的路径/glob + 该步期间读过/改过的文件。步骤文本里一个路径都没有 → 自动提取不可靠，P1 不报。匹配：无通配符按「相等或目录前缀」，有通配符用 `Bun.Glob`，不做子串匹配。
24. **R4** 在 engine 里实现（需要知道「最近没有其他触发」），judge `done=true` 暂停 R4/P4 直到下一次 M 级命中；R2 需要配置 `detect.session_budget_usd`，取不到花费就跳过。
25. **回放读取器的合成格式**：Claude 样本按公开的 transcript 结构手写（`type: user|assistant`、`message.content[]` 里的 `tool_use`/`tool_result`、`isSidechain`、`isMeta`、`isCompactSummary`）；Codex 样本按 rollout 结构手写（`session_meta`、`turn_context`、`response_item`{message, function_call, function_call_output, custom_tool_call(_output)}、`event_msg`{task_complete, turn_aborted, token_count}）。**真实文件的细节差异需要在 Jack 的机器上校准**——这也是 design §16 第 2 条的未决项。生成器是 `test/fixtures/gen.ts`，输出已提交。
26. **Codex 长命令回填**：`exec_command` 返回 `Process running with session ID N` 时先标 pending，之后 `write_stdin` 轮询拿到 `Process exited with code M` 时，就地替换最初那条 post 事件的 result（保留原 seq/ts）。这样检测器看到的是最终状态，代价是回放比线上多知道一点「未来」。
27. **sidechain**：Claude 子 agent（`isSidechain`）的事件默认丢弃，只保留主链；`Task` 工具调用本身仍作为 `agent` 类步骤（S4 用）。

## M2（eval / judge / 契约测试）
28. **步骤单位**：一律用「工具调用序号，从 1 开始」（`callIndex`）。回放时间线里的 `step` 是命中时已完成的调用数；`pre` 阶段命中时那次调用还没完成，所以 `callIndex = step + 1`，其余阶段 `callIndex = step`（至少 1）。`derail_step` 也用同一单位，表示「从第几次工具调用起开始跑偏」。不这样处理会让首次报警延迟差 1。
29. **labels.yaml 是 Jack 的人工数据，我不写合成标注进去**。`eval/labels.example.yaml` 只放 schema 和注释；测试用 `test/fixtures/labels.yaml`，指向合成样本。Schema：`sessions[]{ id, file, outcome: ok|derailed, derail_step?, derail_kind?, expected_rules?, plan?, notes? }`，`file` 相对 labels 文件所在目录。
30. **TP / FP 的定义**（规则级，按会话聚合）：
    - 规则 R 在会话里「触发」= 至少一次非 observeOnly 的命中（包括只记录的 L 级；INTERNAL 不算）。
    - 会话 `derailed`：R 有一次命中的 `callIndex ≥ derail_step − window`（`window` 默认 2，可 `--window`）→ 该会话对 R 是 TP；R 只在窗口之前触发 → FP（跑偏前的虚假警报）。
    - 会话 `ok`：R 触发 → FP。
    - `precision_R = TP会话 / (TP会话 + FP会话)`；没有触发过则 null。同时给出命中级（hit-level）的 TP/FP 数，避免一个循环会话里 5 次命中被当成 1 次而掩盖噪声。
    - `recall_R`：分母是标注里 `expected_rules` 含 R 的跑偏会话数；没有任何会话标 `expected_rules` 时为 null（不编造）。总体 recall = 跑偏会话里任意规则触发的比例。
31. **precision 分类（对应 §12.7 两个门槛）**：按*决策*（policy 之后）分三类，各自算 FDR（= FP 报警数 / 报警总数，等价于 1−precision）：
    - 拦截类：`block | ask | stop_continue`；门槛 <3%。
    - 建议类：`advise`（本地预设建议 + judge 给出的建议）；门槛 <25%。
    - 候选类：`judge_off`（M 级，judge 关闭时「待 judge」）——只在 `--judge=off` 时出现，让每条规则的 precision 在没有 judge 时也可见，不参与门槛。
    - `observeOnly`、只记录的 L 级、`skip`、`ignore` 不计入报警。FDR 之外同时给出「有拦截的 ok 会话占比」。门槛里 `null`（没有报警）显示为 n/a，不算通过。
    - **口径说明**：§12.7 写的是「误报率」，没有说是 per-alarm 还是 per-benign-call；这里取 per-alarm（FDR），并给出 per-ok-session 的占比供对照。**请 Jack 确认口径**。
32. **首次报警延迟**：跑偏会话里，**窗口内**（`callIndex ≥ derail_step − window`）第一条「报警类」决策（block/ask/stop_continue/advise/judge_off）的 `callIndex − derail_step`，可以为负（在窗口内提前报）。窗口之前的报警已经算 FP，**不参与**延迟（否则噪声越早，延迟数字越好看）；只有窗口前报警的会话算漏报。规则级同理（窗口内该规则的第一条非观察命中）。汇总 min/median/mean/max 和漏报数（跑偏会话没有任何报警）。
33. **judge 统计**：每会话和汇总都报 judge 调用数、按 model 的 ignore 率 / 解析失败率 / 超时 / 出错。成本需要 usage，live 之前为 n/a。
34. **提示 A/B**：`runEval` 接受 `judgeFactory(style)`，对 `recall` 与 `ignore_default` 各跑一遍并输出差异表。`--judge=mock` 下两种写法结果相同（mock 不读提示），所以这一阶段只验证管道；真正比较要等 live（M3）。
35. **judge 响应修复边界**：`message_to_agent` 超过 600 字符是*修复*（截断）而不是失败；非 ignore 但 message 为空是失败（`message-required`）。confidence 缺失给 0.5（低于拦截门槛 0.8，不会因此拦截）；(1,100] 的数值当百分数。未知 category 映射为 `other`。
36. **`<untrusted>`**：命令、输出、计划、本地提示都放进 `<untrusted>`；块外的文字（用户 prompt 等）也做脱敏并转义 `<untrusted`；转义后内容里不可能再出现真正的闭合标签。命令/输出/编辑文本/prompt/计划在进入 judge 请求前全部过 `redact()`。
37. **契约测试（§3.5）的位置**：`render()` 放在 `packages/adapter-claude/src/render.ts`（以后 sv-hook 直接复用），测试放 `test/contract/`，每一格一个固定 fixture JSON，做深比较。本阶段只做 Claude 部分。

## 复核后补充
38. **冷却只挡「放行类」结局，不挡 pre 阶段的 block**：L1/T1 的 H 命中（可在 pre 拦截）不先过冷却门——否则被拦的调用一重试就落进同 key 冷却而被放行，「连续拦截 ≤2」会变成 ≤1，第 2 次尝试连 advise 都没有。现在的流程：沿用此前的拦截判断（`blockedAt`，10 步 / 5 分钟）→ 冷却（只有 advise/ignore 结局写冷却记录）→ 连续拦截上限（≥2 时降级 advise 并写冷却）→ 指纹核实 → 同步 judge。block 本身不写冷却记录，只缓存判断，所以重复被拦时不会重复问 judge、不烧预算；默认 5 秒间隔下同一调用依次是 block、block、advise、skip（放行）。
39. **T1 的 key 不含 attempt 序号**（`T1:<normCmd>` 用于 advise，`T1H:<normCmd>` 用于 H）：这样 §6.3 的「advise 一次后冷却 10 步或 5 分钟」才生效。
40. **M 级 judge 的 block 判断（post 阶段命中）不计入连续拦截计数**，因为它还没有真正拦住任何调用（`atNextPre=true`，要等下一个 pre）。「把待执行的拦截带到下一个 pre」的机制属于 M3（outbox/daemon），这一阶段未做。

## Jack 的决定（监督者指示）
41. **不要任何模型特定规则**：所有规则（含 T 组测试重跑）通用、只有一套阈值。已删除 GPT/默认 profile（代码 `config.ts`/检测器/`engine`/回放、`config.example.yaml`、`design.md` §6.3、测试）；配置里只有 `thresholds`，没有 `profiles` / `model_profiles`。模型名（`SessionStart.model`、`PostModelSwitch`、Codex 的 `model` 字段、OpenCode 的 context hook）只记录到日志，不参与判定；测试断言「换任意模型名，命中时间线完全一致」。**decisions #16 中的分档作废。** 统一后的初值：T1 advise@2 / H@3；T2 advise@3 / M@5；T3 advise 一次；T4 L@4 / advise@6；T5 L@2 / advise@3 / M@4；T6 advise@3；T7 advise；T8 L@10 / M@14；每轮预算全量测试 ≤3、验证类 ≤12。这些是初值，用 `sv replay --set thresholds.X=…` 校准。
42. **日志（design §18）**：SQLite 为主、可选 JSONL 镜像/导出；保留期按写入时间 `logged_ts`（回放历史 transcript 不会被立刻清掉）；**被人工标注过的命中（及其决策/投递）不清理**，因为标注是人工成本；`runs` 记录当时生效的整套阈值/预算/规则配置、哈希和 `--set` 覆盖，用于对比调参；事件 JSON 正文、命令、输出、judge 请求响应、消息落盘前一律脱敏（测试里用真实形态的密钥断言整库 dump 找不到）；日志写入失败 fail-open。发现并修复了两个问题：事件 `body_json` 与命中 `detail_json` 最初没有脱敏；`redact` 会把 `prompt_tokens: 1200` 之类的纯数字统计字段当密钥抹掉（现在纯数字的值不算密钥）。
43. **遵从（complied）的判定**：只对能说清「同样的做法」的规则定义——L1/L2/L3/T1/T6 看同一 `argsHash`，T2/T4/T5 看同一命令类别；投递后观察之后 3 次调用（`pre`），出现同样的 → 0，没有 → 1，窗口没走完 → NULL。其他规则不判定（NULL）。这是启发式，目的是复盘时有个量，不是严格因果。
44. **误报率的来源**：只来自人工标注（`sv mark … fp|useful`，同一命中以最新一条为准）；没有标注就是 n/a，不编造。`sv eval` 的 precision/FDR 是另一套（对 `labels.yaml` 的会话级标注），两者互补。
45. **模型名**：`events.model`、`hits.model`、`sessions.model`、`judge_calls.model` 都记录；`sv stats --by model` 事后看谁更容易触发什么。任何检测器/策略代码里都不读模型名（有测试：换任意模型名，命中时间线完全一致）。
46. **shadow 下 X2 的记录方式（Jack 确认 #20 之后的落地）**：X2 行为不变（跟随 mode）。日志里 X2 命中恒记 `hits.severity='dangerous'` + `danger_category/subject/reason`；决策的 `outcome` 在 shadow/advise 下是 `would_have_blocked`（deny 类）或 `would_have_asked`（Claude 上 .env / CI 配置的 ask 类），enforce 下是 `blocked` / `asked`——Jack 要的「`would_have_blocked` 与真实 `blocked` 区分」对 deny 类原样满足，ask 类用对应的 `would_have_asked`，统计里两者都算「本应拦截」。同一套 `outcome` 对所有面向 agent 的动作通用（`would_have_advised` 等）。日志 schema 升 v2，旧库打开时自动补列。前端的「危险」徽标 / 筛选 / 会话危险数排序 / 「本应拦截」指示器见 frontend-design §7.5、§9.1。
47. **advisor 复核的修复**：`--set` 严格校验键名（写错的 `thresholds.T1.h` 现在直接报错，只允许给 T1–T8 阶梯新增 L/advise/M/H 级别）；原先写死在检测器里的阈值（L1 拦截前次数、L2 窗口、L2a、L3、L4、L6、S2、S4、R2、R3）全部进 `thresholds`，日志里记录的就是实际生效值；脱敏的纯数字例外收窄为复数 `…tokens` 用量字段，`DB_PASSWORD=123456` 这类仍脱敏；新增 `sv eval --sweep path=v1,v2,…`（每个取值一条 eval 运行记录）与 `sv eval --log`。

## M3（守护进程 / outbox / sv-hook / live judge）
48. **outbox（P0-8）**：表 `outbox`（schema v3）；`delivery_id` 唯一 → 同一条消息只入队一次；领取是**单条** `UPDATE … WHERE id = (SELECT … LIMIT 1) RETURNING *`，由 SQLite 写锁保证多进程/多连接同时领取时每条只会被一个领取者拿到；租约（默认 30 秒，大于 hook 的硬超时）过期的 `claimed` 会被下一次领取回收（`attempts+1`）；只有当前持有租约的领取者能 `markDelivered` / `markStale`（被回收后旧领取者的确认无效）；`expires_ts` 过期的不领取，`expireOld()` 标为 expired；投递前用 `precondition_json`（最近一次结果的错误指纹仍相同、工作区指纹没变、入队后不超过 N 步）复核，不成立记 stale 并写原因。并发测试：同进程 5 个连接交错领取、**6 个独立进程同时领取 240 条**，每条恰好一次、没有遗漏；租约回收后旧领取者确认被拒。注意这是「至少一次输出、至多一次确认」：领取者在输出后、确认前崩溃，消息会在租约过期后被再次输出一次——租约设得大于 hook 超时就是为了让这个窗口只在真正崩溃时出现。
49. **注入点与 outbox 的对应**：`PreToolUse` 可取 block/ask/advise；`PostToolUse`/`PostToolUseFailure`/`PostToolBatch` 只取 advise；`Stop` 只取 stop_continue（`stop_hook_active=true` 时既不输出也不消耗）。block/ask 在 post 阶段无法执行，所以留在 outbox 等下一个 `PreToolUse`。同一个 pre 事件上的 X2/显式 P1/L1·T1 拦截不经过 outbox，直接放进响应（并写 injections、标 deliveries 已送达）。
50. **守护进程结构**：每个会话一个 Engine + StoreSink（共用同一个 `kind='live'` 的 run）；同一会话的 hook 串行处理（Promise 链），保证 seq 顺序；M 级的异步 judge 用 `deferJudge`（不挡 hook，完成后迟到的决策经 `sink.onLate` 写日志、applied 的进 outbox）；H 级的同步 judge 仍然在 pre 里等（≤15 秒）。Stop 钩子里最多等后台 judge `stopWaitMs`（默认 3.5 秒，Stop 硬超时 4 秒），赶不上就 fail-open，结果留在 outbox。工作区指纹只在可能用于「期间无改动」判断时同步计算（同一 argsHash 出现过、或测试/构建/lint/typecheck 类命令），带 2 秒超时。重启后恢复 `injections`（origin 哈希）和 `plans`；**不恢复**调用历史（重启后循环/重复类计数从头开始）。
51. **`judge.enabled`（新增配置，默认 false）**：守护进程默认不调用 judge——M 级只记录「待 judge」；`sv start --judge=live` 或配置 `judge.enabled: true` 才会连 `judge.base_url`（默认 `http://127.0.0.1:3425/v1` 的 Magpie 路由组）。`sv replay/eval --judge=live` 同理。key 只读环境变量（`judge.api_key_env`，也读 `ADVISOR_API_KEY`），不读任何文件；没有 key 就不发 Authorization。任何 judge 故障（超时、HTTP 错误、连不上、解析失败）一律 fail-open，且都记入 `judge_calls`（`sv stats --by judge` 的 parse_fail 率、`GET /v1/status` 的 `judge.stats`）。
52. **sv-hook（Claude Code 先行）**：守护进程启动时写 `hook.json`（mode、socket、port，0600），hook 靠它在守护进程不可达时也知道 mode。输出走 `adapter-claude` 的 `render()` 白名单。**铁律在 hook 里再保一道**：`shadow` 永不输出任何 delivery、`advise` 只放行 advise、只有 `enforce` 才输出 deny/ask/Stop block——即使守护进程出 bug 说要 block 也会被丢弃（`dropped-by-mode`）。本地 X2 只在 `enforce` 下生效（守护进程不可达时也拦）；shadow/advise 下守护进程只记 would_have_*。守护进程不可达、超时（PreToolUse 18 秒 / 其他 4 秒，`SV_HOOK_TIMEOUT_MS` 可覆盖）、响应非 200 或非 JSON、hook 自己抛异常，一律 exit 0 且不输出，并往 `health-spool.jsonl` 追加一行（守护进程下次启动/收到请求时补记为 `adapter_health`，文件 >1MB 不再追加）。`bun build --compile` 可编出单文件（约 61MB），`sv install claude` 只打印 hooks 片段与 launchd plist。
53. **Origin 记录**：tracker 在判定 prompt 是 supervisor 回显后把 `event.origin` 改写为 `supervisor`，所以日志里也是 supervisor（之前只影响「本轮」计数）。
54. **M3 没做 / 已知缺口**：hook 找不到守护进程时**不会自动拉起**它（design §1 的 autostart）；Codex / OpenCode 适配器、sv-hook 的 Codex 输出；asyncRewake；`sessions.parent_session_id`（Claude hook 载荷里的子 agent 标识未核实）；Claude hook 真实载荷字段（`PostToolBatch` 的内容、`tool_response` 形态等）全部依据文档手写合成载荷测试，需要在 Jack 的机器上用真实输入校准；`GET /v1/sessions` 等前端文档里的查询 API 还没有（现在只有 `/v1/hello`、`/v1/status`、`/v1/hook`、`/v1/adapter-health`）；`mode` 改配置后需要重启守护进程（没有热加载）。
