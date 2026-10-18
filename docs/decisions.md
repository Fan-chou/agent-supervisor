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
16. **L1 的次数定义**：同一 argsHash 连续失败（errFingerprint 相同、两次之间无改动）——第 2 次失败的 `post` 上记 M（advise）；第 3 次*尝试*的 `pre` 上记 H。T1 在 `pre` 上评估：第 2 次无改动重跑 advise，GPT 档第 3 次 H；默认档 T1 没有 H（design 表里默认档只写了第 2 次 advise），`rules.T1_rerun_unchanged.block_on` 只改 GPT 档的 H 阈值。
17. **「advise」的表示**：L 级 + `message` = 本地预设建议（不经 judge）；L 且无 message = 只记录。T 组的 advise 因此是「L + 事实陈述 message」；M 进 judge。L 级本地建议：非 T 组每规则每会话最多 1 次，T 组靠冷却（10 步 / 5 分钟，两个条件同时满足才算冷却中）。
18. **阶梯阈值**：`Profile` 里每条 T 规则是 `{L?, advise?, M?, H?}` 次数阶梯，取满足的最高级，且只在「升级的那一次」触发（边沿触发），避免每一步都重复报。`config.example.yaml` 里 `profiles` 的扁平键（`T2_full_per_turn` 等）映射到这些阶梯。
19. **没有真实指纹时（回放）**：`SessionTracker.unchangedBetween` 返回 `verified | inferred | changed`。`inferred` = 事件流里没有编辑也没有 mutating 命令，但没有真实 `wsFingerprint`。policy 默认（线上）对 `inferred` 不拦，只 advise；回放用 `trustInferredUnchanged=true`，并在时间线里标注 `verified=false` / `wouldBlockIfVerified`。
20. **X2 与 mode**：X2 **跟随 mode**：shadow 只记录（Decision 里 `action` 仍标 block/ask，`applied=false`），advise 模式也不拦，只有 enforce 才生效。理由：config 注释写 `shadow=只记录`，M4 是 shadow 周、完成标准是「零阻塞事故」，M5 才打开 H 级拦截；design 说的「X2 不依赖守护进程」指的是故障时不放行、不是可以无视 mode。`rules.X2_dangerous.action: off` 则连命中都不产生。**请 Jack 确认**：如果希望 shadow 阶段 X2 就真的拦，需要改这一条。
21. **X2 的 `rm -rf` 解释**：design 写「删仓库外或 $HOME 下的路径」，但仓库通常就在 $HOME 下。实现为：目标是 `/`、`$HOME` 本身（含 `~/*`）、仓库外的绝对路径/`../` 路径、仓库根或 `.git` 时拦；仓库内普通子目录不拦（可由 git 恢复）；`/tmp`、`/var/folders` 和仓库内构建产物目录（node_modules、dist、build、target…）豁免；含未解析变量（`$X`）的路径无法判断，放行。`git push --force-with-lease` 不拦。
22. **X1 的判断**：只看测试文件（路径含 tests/、spec/、`test_*.py`、`*.test.ts`、`*_test.go` 等）的 Edit/Write/apply_patch：新增 skip/xfail/`.only`；断言数量减少；上一次测试失败后没改过源码就改了断言行。用户意图/当前计划步骤包含「写测试、补测试、flaky、快照、基准、修 CI」时降为 L。「fix the failing test」**不**算豁免（那通常是要修源码）。
23. **P1 的允许范围**：plan.md 写了 `allow:` → 显式（H，本地拦，不问 judge，不受连续拦截上限）；否则用当前 in_progress 步骤文本里的路径/glob + 该步期间读过/改过的文件。步骤文本里一个路径都没有 → 自动提取不可靠，P1 不报。匹配：无通配符按「相等或目录前缀」，有通配符用 `Bun.Glob`，不做子串匹配。
24. **R4** 在 engine 里实现（需要知道「最近没有其他触发」），judge `done=true` 暂停 R4/P4 直到下一次 M 级命中；R2 需要配置 `detect.session_budget_usd`，取不到花费就跳过。
25. **回放读取器的合成格式**：Claude 样本按公开的 transcript 结构手写（`type: user|assistant`、`message.content[]` 里的 `tool_use`/`tool_result`、`isSidechain`、`isMeta`、`isCompactSummary`）；Codex 样本按 rollout 结构手写（`session_meta`、`turn_context`、`response_item`{message, function_call, function_call_output, custom_tool_call(_output)}、`event_msg`{task_complete, turn_aborted, token_count}）。**真实文件的细节差异需要在 Jack 的机器上校准**——这也是 design §16 第 2 条的未决项。生成器是 `test/fixtures/gen.ts`，输出已提交。
26. **Codex 长命令回填**：`exec_command` 返回 `Process running with session ID N` 时先标 pending，之后 `write_stdin` 轮询拿到 `Process exited with code M` 时，就地替换最初那条 post 事件的 result（保留原 seq/ts）。这样检测器看到的是最终状态，代价是回放比线上多知道一点「未来」。
27. **sidechain**：Claude 子 agent（`isSidechain`）的事件默认丢弃，只保留主链；`Task` 工具调用本身仍作为 `agent` 类步骤（S4 用）。
