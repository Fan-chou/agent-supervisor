# 评审：`docs/design.md`（对照 `docs/research.md`）

我没有改动任何文件。这次环境里没有 Write 和 ExitPlanMode 工具，所以评审只能直接写在这里，plan 文件也没有生成。

**来源标注**分三档：
- 【文档✓】：本次重新读了官方文档，链接列在文末；
- 【源码✓】：本次重新读了 Codex `rust-v0.163.0` 的 `context.rs`；
- 【沿用】：沿用 research 的结论，本次没有复核。

## 总评

骨架是对的：规则报警 → 强模型否决或改写措辞 → 队列加钩子取出，外加 shadow 先行。问题主要在两处：
- **设计内部有几处矛盾**，会造成漏拦、误拦或把 agent 困死；
- **机制描述落后于现状**：有 5 处【未核实】现在可以直接改掉，OpenCode V2 还漏了两个比现有方案更合适的通道。

阈值方面，最大的误伤来源是「**无改动**」这个判断太弱。另外 T 组和 P3 会互相夹击。

---

## 一、P0：必须在 M4 之前修（会导致漏拦、误拦或困死）

**P0-1　§9「连续拦截 ≤2，第 3 次降级为 advise」会让 X2 失效**
- 问题：agent 把 `rm -rf ~/x` 或 `git push --force` 连试 3 次，第 3 次就被放行了。
- 改法：X2（以及启用后的 P1）不受连续拦截上限约束。防困死上限只作用于 judge 和计数类规则（L1、T1）产生的拦截。

**P0-2　§9「X2 在适配器本地执行」与 §3.1「优先用 `type:"http"` 钩子」互相矛盾**
- http 钩子没有本地进程。守护进程一挂，连接失败按非阻塞错误处理【文档✓】，X2 跟着全部失效。
- 改法：Claude Code 的 PreToolUse 固定用 command 钩子 `sv-hook`，X2 编译进 sv-hook；其他事件才用 http。
- 另一种做法是 PreToolUse 只给 X2 单独设 `onFailure:"block"`（需要 v2.1.295+）。但这会让守护进程宕机时所有工具调用都被拦，不推荐。

**P0-3　§7 和 §9 对 judge 超时的处理相反**
- §7 写的是：L1/T1 第 3 次同步问 judge，超时就照规则拦截（fail-closed）。
- §9 写的是：超时一律放行。
- 改法：明确写成「judge 超时时，按规则本身的默认动作处理」。只有 T1 这种可以确定性复核的情况（见 P0-4 的工作区检查）才允许本地拦截，其余降级为 advise。另外，§3.1 的 PreToolUse timeout 是 20 秒，§9 适配器硬超时却写「其余 3 秒」，§3.1 又写「其他 5 秒」，三处要统一。

**P0-4　「无改动」只数编辑事件，T1 和 L1 会误拦**
- §6.3 只统计会话内的编辑事件，`git diff` 被写成可选。GPT/Codex 经常用 shell 改文件，比如 `sed -i`、`cat > f`、`python3 - <<EOF` 写文件、`perl -pi`、`npm install`、迁移数据库。这些都看不见，系统会误判「工作区没变」，然后拦掉一次合理的重跑。
- L1（同一调用连续失败）**完全没有「期间无改动」这个条件**。agent 改完代码重试同一条命令，也会在第 3 次被拦。
- 改法：
  - 任何「因为无改动」而拦截之前，PreToolUse 同步算一次工作区指纹：`git status --porcelain` 加 `git diff` 的哈希，再把未跟踪文件的 mtime 算进去。这样做每次大约 20–50ms。
  - 非 git 目录不拦截。
  - 期间有非测试类的 shell 命令（安装、构建、docker、迁移、写文件）就视为可能有改动。
  - L1 加上「两次之间工作区指纹不变」这个条件。

**P0-5　render 层没有按「harness × 事件」设字段白名单**
- Codex 的 PreToolUse 如果输出 `continue`、`stopReason`、`suppressOutput`，或者 `permissionDecision:"ask"`，**整个钩子会被判失败，工具照常执行**【文档✓】。这意味着拦截在输出格式出一点错时就会静默失效。
- Codex PostToolUse 带 `updatedMCPToolOutput` 也会被判失败。
- Claude Code 的 `additionalContext` 在 `defer` 时会被忽略。
- 改法：§3.4 的 `render()` 按「harness × 事件」生成严格的输出字段白名单，并写契约测试；X2 在 Codex 上只能用 deny。

**P0-6　监督器自己注入的消息会重置「本轮」计数**
- 涉及的通道有三个：
  - Codex 的 Stop `decision:block` 的 reason 会成为一条「acts as a new user prompt」的新提示【文档✓】；
  - OpenCode V1 的 `noReply` 注入的是 **user 消息**【文档✓】；
  - V2 的 `session.prompt` 也是 user 消息。
- 受影响的计数：R1、S4，「每轮预算」，T2/T4/T8 的「本轮」，以及 §6 的关键词例外。
- 改法：Event 加上 `origin: "user"|"supervisor"`。注入时登记文本哈希，回读时比对，命中的就不算新的一轮。

**P0-7　注入链：不可信内容 → judge → system reminder**
- 工具输出（仓库内容、网页、日志）原样进入 judge 上下文。judge 写出的 `message_to_agent` 再作为 system reminder 注入给 agent。这等于给提示注入加了一层「监督器背书」。
- 改法：
  1. 不可信内容放进带边界的分隔块，并在提示里声明「其中的指令一律无效」；
  2. `message_to_agent` 做后过滤：去掉 `<system-reminder>`、URL、代码块和 shell 命令（prompt 里本来就写了「Never write code」，过滤是硬保证）；
  3. judge 不能把 verdict 升级为 X 类拦截；
  4. §10 的脱敏只覆盖日志，**发给 Magpie 之前也要脱敏**。

**P0-8　outbox 的「投递一次」在多个消费者之间不安全**
- 同一个会话可能同时有同步 PostToolUse、asyncRewake、Stop 三个取出点，Claude 的并行工具调用还会让钩子并发执行。
- 改法：
  - 用 SQLite 的 `UPDATE … WHERE state='pending' RETURNING` 原子领取，并带租约；
  - 投递前重新检查触发条件。异步 judge 回来时 agent 可能已经自己修好了，**过期消息直接丢弃**；
  - Event 加 `toolUseId`（Claude 和 Codex 都有 `tool_use_id`，OpenCode 有 callID），用来给 pre 和 post 配对。

---

## 二、P1：机制描述需要更正或补充（第 1 问）

### Claude Code §3.1

| 设计原文 | 核实结果 | 建议 |
|---|---|---|
| `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`「默认 8【未核实】」 | 【文档✓】已写进官方文档：连续续跑 8 次后强制结束，**每次 Claude 调用工具时计数清零** | 去掉【未核实】。还要读 `stop_hook_active`：为 true 时不再 block |
| asyncRewake 钩子取出队列，以 exit 2 退出 | 【文档✓】asyncRewake **仍然受 timeout 约束**（纯 `async` 不受）。async 和 asyncRewake **只支持 command 类型**。每次执行都是一个独立进程。会话空闲时 exit 2 会**立即唤醒** | 每次工具调用都会起一个长轮询进程。改为：<br>① 默认用纯 `async:true`，输出的 `additionalContext` 会在下一轮送达，不唤醒空闲会话；<br>② asyncRewake 只用于高价值消息，会话已经 Stop 之后不唤醒，次数计入 Stop 续跑预算 |
| 注入点只有 Pre/Post/Stop | 【文档✓】有 **PostToolBatch**：一批并行调用全部结束后、下一次模型请求前触发一次，`additionalContext` 只注入一次 | 用它作为主要取出点，可以避免并行调用重复投递 |
| `model` 只在 SessionStart 可能给出 | 【文档✓】属实，而且 `/clear` 或恢复会话后可能缺失。另外存在 Pre/PostModelSwitch 事件 | 订阅 PostModelSwitch，中途换模型时同步切换档位 |
| 失败结果 | 【文档✓】Bash 非零退出走 PostToolUseFailure，`error` 第一行是 `Exit code N`；PostToolUse 的 `tool_response` 里是 stdout/stderr/interrupted | normalize 解析这一行作为 exitCode。Claude 侧不需要 FailureClassifier |
| X2 用 deny | 【文档✓】PreToolUse 支持 `ask`，交给用户确认 | 「改 CI 配置」「写 .env」这类有合理场景的操作改用 `ask`，不要 deny（**仅限 Claude**，Codex 上 ask 等于放行） |
| http 钩子 | 【文档✓】支持 `headers` 和 `allowedEnvVars` | 用它传本地 token，见 P1-架构 |

其余描述我核对过，与文档一致：
- deny 的 reason 模型能看到；
- exit 0 时的 stderr 模型看不到；
- `additionalContext` 上限 10k 字符，超出会转存文件，**而且 Claude 不会主动去读那个文件**，所以消息必须短；
- 措辞要用事实陈述的口吻；
- `last_assistant_message` 可用；
- 默认 timeout 600 秒；`onFailure` 需要 v2.1.295+，对 Stop 和后台钩子无效。

### Codex §3.2

| 设计原文 | 核实结果 | 建议 |
|---|---|---|
| async 能不能唤醒并注入【未核实】，第一阶段用排队 | 【文档✓】async 输出**会送达模型**：活跃轮次里在下一次模型请求时送达，否则等到下一个用户轮次。每会话最多 8 个并发，会话结束时没投递的输出会丢弃 | 改掉【未核实】。Codex 的异步建议改用 async 钩子，不必等下一次 PreToolUse |
| §4、§16.5「Codex 取不到模型名」 | 【文档✓】通用输入里**有 `model` 字段**（Codex 扩展） | 改掉。§6.4 的「Codex 且模型未知时默认 GPT 档」基本用不上了，但 Codex 也能接其他 provider，应该按 `model` 判定 |
| 没有退出码 | 【源码✓】`post_tool_use_response` 只返回 `truncated_output_with_policy(...)`，`Process exited with code N` 只在给模型看的 `response_header` 里。**`process_id` 不为空或 `hook_command` 为空时都不触发** | 结论和 research 一致。补充第二个不触发的条件。FailureClassifier 要在 0.163 上 dump 真实 payload 建 fixture |
| Stop 的 block 加 reason，自己设上限 | 【文档✓】reason 会成为新的 user prompt；文档没写上限；有 `stop_hook_active` | 措辞要按「用户口吻的事实陈述」写；读 `stop_hook_active`；相关的计数问题见 P0-6 |
| 未提 | 【文档✓】非托管钩子需要在 `/hooks` 里审核信任，**信任按哈希绑定**，钩子改动后会被跳过，直到重新信任 | `sv install` 的说明里要写清楚。钩子命令应指向固定路径的本地二进制，升级时不改命令串 |
| 未提 | 【文档✓】PreToolUse 的 `updatedInput` 只能和 `allow` 一起用；`ask` 不支持 | 并入 P0-5 的白名单 |

matcher 是正则、`apply_patch` 能被 `Edit|Write` 匹配、输出上限约 2,500 token、PostToolUse 的 block 会替换工具结果，这几处都已核实无误。

### OpenCode §3.3

| 设计原文 | 核实结果 | 建议 |
|---|---|---|
| V1 的 `noReply`【未核实】 | 【文档✓】SDK 文档写明 `body.noReply: true` 只作为上下文、不触发回复，示例注释是「useful for plugins」 | 改掉。但它是 **user 消息**，会写进历史，见 P0-6 |
| V2 建议通道：改写 `execute.after` 的 `event.result` | 【文档✓】V2 有 **`ctx.session.hook("context")`**，每次发请求给模型之前运行，包括工具调用之后的续跑。可以往 `event.system` 里 push，改动只作用于这一次请求、不写入历史，并且带 `model` 和 `agent` 字段 | **漏掉的最佳通道**：在 context hook 里取出 outbox 作为建议通道，比改工具结果干净。它同时解决了「取不到模型名」和「没有按 agent 区分」两个缺口。因为不写入历史，需要决定一条消息连续注入几次 |
| 拦截：在 `execute.before` 里抛 Tool.Error | 【文档✓】文档没写 `execute.before` 抛异常会怎样。写明的是 `ctx.permission.hook("evaluate")`：把 `effect` 设为 deny、`message` 填原因，会产生带原因的 `Tool.Error`，「模型看到原因并继续」；而 **plain rejection 会结束当前 step** | 拦截优先走 permission evaluate，`execute.before` 作为后备，并实测普通 throw 会不会结束这一步。注意：配置里显式的 deny 不会进入这个钩子 |
| 收尾只能用 synthetic 加 resume | 【文档✓】V2 还有 `session.prompt({delivery:"steer"\|"queue"})`。synthetic 的 `resume`、`id`、`description` 文档里都没有 | 保留【未实测】，把 prompt+queue 列为备选 |
| 工具钩子不带 cwd | 【文档✓】V1 插件上下文有 `directory`、`worktree`，V2 有 `ctx.location.directory` | 降为次要问题 |
| V1 对象写法 1.18.29 | 【文档✓】更早的 V1 可能要求函数导出 | 双导出时同时兼容函数形式 |

---

## 三、P1：检测器（第 2 问），只列误伤面最大的几条

1. **L3 和 `errFingerprint` 取前 300 字符**：pytest、jest、cargo 输出的开头是固定的样板（`=== test session starts ===`、平台行）。去掉数字之后，几乎所有失败都会撞成同一个指纹。**改法**：先抽取错误行（`E `、`Error:`、`FAILED`、`panicked at`、最后一个 Traceback 帧），再做归一化。
2. **L2（窗口内重复 ≥4 次）**：轮询类命令是正常行为，比如 `git status`、`gh run view`、`curl` 健康检查、`sleep && tail log`。**改法**：要求「同调用 + 同输出哈希」才算原地不动；轮询白名单降到 L 级。
3. **L4 振荡**：设计里的 diff 哈希拿不到 shell 改动。**改法**：守护进程在 PostToolUse 读出被编辑文件的内容哈希，维护一份历史，哈希回到某个旧值就判为振荡。表里的「M（阻断型）」含义不清，要写明是 M 级送 judge 还是可以拦截。
4. **L5（同一文件编辑 ≥4 次）**：Claude Code 写大文件时，常常是连续多次小 Edit。self-critic 承认过这类误报。**改法**：按「编辑段」计数，被非编辑动作隔开的才算一次；或者把阈值提到 ≥6。
5. **S1（只读 ≥12 步）和 S2（θp=7）**：大仓库的首轮探索常常有 20–40 次读取。θp=7 来自 SWE-agent 的步骤粒度，搬到并行批量调用的 Claude/Codex 上未必成立。**改法**：会话里第一次编辑之前，S1 只记 L 级；S2 先只在回放中观察，不上线。
6. **P2（没读就改）**：Claude 的 Edit 工具本身就强制先 Read，这条规则重复了。新建文件要豁免。建议降为 L，只对 Codex 生效。
7. **X1 和 X2 的场景豁免**：
   - 任务本身是写测试、修 CI、更新快照时，「只改测试」「改 CI 配置」都是合理操作，应先比对 intent；
   - `.env.example` 要放行，`/tmp` 下的 `rm -rf` 要放行；
   - X2 **漏了更常见的破坏性 git 操作**：`git reset --hard`、`git checkout -- .`、`git restore .`、`git clean -fdx`、`git stash drop/clear`；
   - 要明确写出 X2 只是尽力而为，`bash -c`、`python -c open(...)` 都能绕过，它不是安全边界。

---

## 四、P1：GPT 过度测试规则组（第 3 问）

1. **T5 和复现脚本冲突**：SWE-agent 和 LivePlan 都把「先写复现脚本」视为良好实践，LivePlan 把「不复现」算作偏差。GPT 档写着「≥1 个 smoke 脚本就 advise」，会直接误伤这种做法。**改法**：在第一次修改源码之前新建的脚本视为复现脚本，豁免；只统计修复之后又新建的验证脚本，阈值 ≥2。
2. **T2 和 P3 互相夹击**：改之前跑一次、改之后跑一次全量，本来是正常节奏，GPT 档却在 ≥2 次时就 advise。可是 P3 又要求宣布完成之前必须跑过测试。**改法**：
   - T2 只统计「两次之间没有编辑」的全量运行；
   - P3 跑过 targeted 测试或构建就算满足；
   - 两条规则共享一个状态：T 组 advise 过之后，P3 只要求 targeted 测试。
3. **T4 把 `python -c` 一律当成 probe**：Codex 经常用 `python -c` 读 JSON、算路径，用 `python3 - <<EOF` 写文件，这些都不是验证。**改法**：probe 必须带 `import <项目包>` 或 assert 才算；heredoc 里有写文件的就归为编辑（同时修复 P0-4 的盲区）。
4. **CmdClass 剥壳**：需要先剥掉各种包装，比如 `uv run`、`poetry run`、`python -m pytest`、`npx/bunx`、`timeout N`、`| tail`、`&&` 串联，以及 `pnpm -F pkg test`、`go test ./pkg/...`、`make test`。还要识别 watch 模式：`vitest` 不带 `run`、`jest --watch` 会让 Codex 侧不触发 PostToolUse，需要跟踪「已发起但还没有结果」的调用。
5. **T8 和 §6 的例外条件太窄**：任务本身是写测试、修 flaky、做基准测试或修 CI 时，T 组应整体降一级。判定方法是用户 prompt 关键词加 judge 复核，比只认「跑全量」这一种措辞更稳。
6. **档位正则** `/gpt|o\d|codex/i` 没有锚定。既然 Codex 和 OpenCode V2 都能直接拿到 model，建议改成 `^(gpt-|o\d|codex)`，配合显式的映射表。
7. 证据部分：§6.1 的社区证据是二手来源，自己也写明「没有定量研究」。所以 **T1 是 T 组里唯一允许拦截的规则，这个定位是对的**。前提是 P0-4 的工作区检查必须到位，否则这一条恰恰是误拦的主要来源。

---

## 五、P1：架构（第 4 问）

- **运行时版本**：Node 20 已于 2026-04 停止维护。better-sqlite3 是原生扩展，在 `npx -y github:` 安装时需要编译，容易失败。**建议** Node ≥22 配 `node:sqlite`，或者统一用 Bun（自带 `bun:sqlite`，还能 `bun build --compile` 出单文件 sv-hook）。
- **<50ms 的目标不现实**：Node 冷启动加一次 HTTP 往返通常要 60–120ms。钩子命令**绝不能是 `npx …`**，那样每次调用都可能走网络。Claude 侧尽量用 http 钩子（PreToolUse 例外，见 P0-2），Codex 侧用编译好的单文件二进制。
- **守护进程生命周期**：现在守护进程不在时只是放行，监督会静默失效。需要补：
  - 用 launchd 自动启动，或者由适配器在发现守护进程不在时拉起一个独立进程；
  - 协议里带版本号，用来检测适配器和守护进程的版本不一致；
  - `sv status` 显示「最近 N 分钟内适配器连不上守护进程」的次数。
- **本地鉴权**：127.0.0.1 随机端口不带鉴权，本机任何进程都能伪造事件或读 outbox。**建议**优先用 UDS，权限 0600；HTTP 加一个 token 文件，Claude 的 http 钩子通过 `allowedEnvVars` 传 header。
- **judge schema**（§8）：
  - 如果走 OpenAI 的 strict `json_schema`，要求所有属性都在 `required` 里，嵌套对象也要设 `additionalProperties:false`。现在 `evidence_steps`、`watch`、`done` 是可选的，`watch` 的条目也没有约束，**很可能被拒绝**。改法：全部列为必填，允许为空或 null。
  - `watch` 的条目要求 `rule` 必填、`text_contains` 设 `minLength:3`，加 `ttl_steps`，防止一条通配监视器耗光预算（iterion 专门防过这种情况）。
  - `done` 的语义要写清楚。
  - verdict 为 ignore 时，`message_to_agent` 允许为空。
  - LLM 给的 `confidence` 校准很差，0.8 这条门槛要在回放中校准。
- **judge 提示和召回策略方向相反**：提示里写「Most alerts are false positives; say ignore when unsure」，而 §7 主张召回优先，HiSentinel 的结论是误报更少的变体解决率反而更低。这样写等于主动选了低召回的变体。**改法**：提示改成「只有在能指出 agent 正在取得进展的证据时才 ignore」，并用回放比较两种写法。
- **fail-open 和 shadow 先行**的方向正确，保留。

---

## 六、P2：遗漏、评测和优先级（第 5 问）

**遗漏**
- 没有处理压缩事件。需要在 PreCompact/PostCompact，以及 Claude 的 `SessionStart source=compact` 时，重新注入 intent 和已经发过的监督要点，并决定 L6 等读取计数是否清零。
- 没有处理用户中断（Esc、Codex 的 Interrupt）。中断时应把重复类计数清零，loop-guard 就是这么做的。
- 缺少两条便宜的范围类规则：新增依赖（`package.json`/lockfile 变化）、大段删除。
- 缺少「已发起、还没有结果」的调用跟踪：Codex 长时间运行的命令、后台 shell 都需要。

**评测（§12）**
- 门槛「误拦率 <10%」对拦截类太宽松。research 里 #64405 说明，用户最痛恨的就是拦截后无法恢复。**建议**：拦截类误报率 <2–3%（参考 AI Control 的 2% 审计预算），advise 类 <25%。
- 「重复或过度测试类会话的步数下降 ≥15%」是事后挑出来的子集，有选择偏差。必须同时加上「解决率不下降」这个约束。
- 10–20 个任务各跑 2 遍，统计功效不足。在线 A/B 只适合当冒烟检查，第二阶段要不要做，主要看离线 precision 加一周 shadow 的结果。离线回放只能测报警准不准，测不出介入后的效果，§12 应该写明这一点。

**低严重度合集**
- §5.7 的「2 次 ignore 就 ×1.5」比 research 的「3 次 ×2」更激进，两种都可以，但要选一个写清楚。
- R3 上下文填充率在 hooks 里拿不到，只能从 transcript 的 usage 推算。
- §13 的成本没有算异步重复评估和 P4 抽查。
- M0–M6 合计约 14–17 天，要做三个适配器，排期偏紧。建议 M4 先做 Claude 和 Codex，OpenCode 放到最后。

---

## 七、可以划掉或改正的【未核实】

| 位置 | 改为 |
|---|---|
| §3.1 / §16.4 Stop 上限 | 默认 8，调用工具后清零【文档✓】 |
| §3.2 / §16.2 Codex async | 会在下一个安全点送达模型，每会话最多 8 个并发【文档✓】 |
| §4 / §16.5 Codex 模型名 | 通用输入里有 `model`【文档✓】；OpenCode V2 的 context hook 也有 `model` |
| §3.3 / §16.3 V1 `noReply` | 存在，注入的是 user 消息【文档✓】 |
| §3.2 没有退出码 | 维持原结论，补充 `hook_command` 为空时也不触发【源码✓】 |
| 仍需实测 | V2 `synthetic` 的 `resume`/`id`；`execute.before` 普通 throw 的效果；Codex rollout jsonl 里的退出码；Magpie 是否支持 json_schema |

**来源**：[Claude Code hooks](https://code.claude.com/docs/en/hooks)；[Codex hooks](https://learn.chatgpt.com/docs/hooks)（由 `developers.openai.com/codex/hooks` 308 跳转过去）；[OpenCode plugins](https://opencode.ai/docs/plugins/)；[OpenCode V2 build/plugins](https://opencode.ai/v2/docs/build/plugins/)；[OpenCode SDK](https://opencode.ai/docs/sdk/)；[codex `context.rs`@rust-v0.163.0](https://raw.githubusercontent.com/openai/codex/rust-v0.163.0/codex-rs/core/src/tools/context.rs)。`registry.rs` 的行号、LivePlan 和 HiSentinel 的数字、各社区项目的描述都沿用 research，本次没有复核。
