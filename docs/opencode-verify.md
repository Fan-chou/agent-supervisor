# OpenCode 2 核对记录与真机清单

状态：**类型层面的核对已完成**（依据 `docs/vendor/` 里 `@opencode/plugin`、`schema`、`ai`、`client` 2.0.32 的 `.d.ts`，decisions #105、#112、#115）；**真机验证还没做**。核对通过前 OpenCode **只观察、不拦截**（decisions #89）。

## 1. 类型核对结论（12 条假设）

图例：✓ 类型里确认；✗ 与假设不符（已改适配器）；? 类型里没有答案，只能真机看。

| # | 假设 | 结论 | 依据与处理 |
|---|---|---|---|
| 1 | `permission.hook("evaluate")` 存在，`effect`/`message` 可写 | **✓** | `PermissionEvaluation{sessionID, agent?, action, resources[], metadata?, source?, effect, message?}`，`effect`、`message` 非 readonly。`Permission.Effect = "allow"\|"deny"\|"ask"`（`@opencode/schema` permission.d.ts），`"deny"` 字面量正确。探针（§3 步骤 5）验证 deny 在真机上是否真的生效、message 是否被模型看到 |
| 2 | `session.hook("context")` 里往 `system` 追加建议 | **✗→已改 ✓** | `system` 是 `Array<SystemPart>`，`SystemPart = {type:"text", text, cache?, metadata?}`（`@opencode/ai` messages.d.ts）。适配器现在追加干净的 `{type:"text", text}`（不复制上一个部件的 `cache`），空数组也能注入；`system` 不是数组 → 不改。注入后模型是否体现、历史里是否没有，要真机（步骤 3） |
| 3 | `tool.hook("execute.before"/"execute.after")`，after 带 status/result/error | **✓** | before `{tool, sessionID, agent, messageID, id, input}`（`tool`、`input` 可写）；after `{…, input} & ({status:"completed", result} \| {status:"error", error: Tool.Error})`。**另有发现**：promise 版 `@opencode/plugin` 导出 `Error`（= `Tool.Error`），effect 版的 `ToolFailures["execute.before"] = Tool.Error`——before 钩子可以以 `Tool.Error` 失败，是不依赖 evaluate 顺序的官方拒绝通道。`Tool.Error = TaggedStruct("Tool.Error", {message, error?, metadata?})`，是**运行时值**；我们的插件不 import 运行时包，promise 钩子里 throw 它是否被当成拒绝只能真机试，**暂不使用** |
| 4 | 事件里有 sessionID、工具名、参数、callID、directory | **部分 ✗（字段名不同，已适配）** | 字段是 `id`（调用 id）和 `input`，不是 `callID`/`args`；**事件上没有 `directory`**，取自 `context.location`，`Location.Info` 有 `directory`（AbsolutePath 字符串）、`project{id,directory,canonical}`、`workspaceID?` ✓。插件的取值函数兼容 `id`/`input`，directory 走 `ctx.location.directory` |
| 5 | `execute.before` 先于 `permission.evaluate` | **?** 但**影响已缓解** | 类型不规定顺序。`PermissionEvaluation.source` 在工具发起的评估里是 `{type:"tool", messageID, id}`，`id` 就是工具调用 id——适配器**按 `source.id` 精确绑定**到对应的 `execute.before`，对不上就放行；没有 `source` 才退回「该会话最近一次 before」。顺序用 `sv opencode-report` 在真机上确认 |
| 6 | 每次调用都会触发 evaluate | **?** | 取决于各工具是否调用 `permission.assert`。真机看报告里的 `BA`（无 E）计数。若有，这些调用上 deny 只能走 `execute.before` 抛 `Tool.Error`（#3，需先在真机证明可行） |
| 7 | hook 处理函数可以是 async | **✓**，但**注册也是异步的** | `Hooks<Spec> = (name, cb) => Promise<Registration>`；回调可 async ✓。适配器已改为 `setup` async、逐个 await 注册并捕获拒绝，返回 `Cleanup`（注销全部 hook、abort 事件订阅） |
| 8 | `model`、`agent`、`messages` 形态 | **✓** | `model: Model.Ref = {id, providerID, …}`（`modelName()` 兼容）；`agent: Agent.ID` 字符串；`messages: Array<Message>`，`MessageRole = system\|user\|assistant\|tool`。user 消息改用专门钩子 `session.hook("prompt")`，注册成功后不再扫 `messages` |
| 9 | 工具名/参数形态（bash 的 `command`、编辑类的 `filePath`） | **?** | `input: unknown`，名字是各工具自己的 id。真机 dump 看；本地 X2 已兼容 `command`/`cmd` 与 `filePath`/`file_path`/`path`/`file` |
| 10 | 有中断 / 会话创建事件 | **中断 ✓（经事件订阅）；会话创建 ✗ 不需要** | 没有 hook，但 `context.event.subscribe({signal})` → `AsyncIterable<V2Event>`，事件 `session.execution.interrupted` 的 `data = {sessionID, reason: "user"\|"shutdown"\|"superseded"\|"inactivity"}`（`@opencode/client`）。插件现在订阅，**只有 reason=user** 才上报 `event=interrupt`（清零重复计数）；订阅断了 fail-open。事件到达的实时性、Esc 是否对应 `user` 要真机看（步骤 3 的 Esc）。会话创建靠第一次 `prompt`/`context` 事件隐式建立，不需要 |
| 11 | `session.prompt` 存在；有「这一轮结束」事件 | **✓（类型）；语义 ?** | `session.prompt` 入参是平铺的 `{sessionID, text, files?, agents?, skills?, metadata?, delivery?: "steer"\|"queue", resume?}`；`SessionInbox.Delivery = "steer"\|"queue"` ✓，与 `stop.ts` 一致。「一轮结束」= 事件 `session.execution.succeeded\|failed\|interrupted`。仍未知（真机）：排队的 prompt 是否算新 user turn、`prompt` 何时 resolve。`stop.ts` 仍**未接线**，不宣称可用 |
| 12 | 插件形态与加载方式 | **形态 ✓，登记方式半 ✓** | `Plugin.define({ id, setup(context) })`（promise API，`import { Plugin } from "@opencode/plugin"`），`setup` 可返回 `Cleanup`。配置：`Config.plugins: Array<string \| {package, options?}>`（`@opencode/schema` config.d.ts——注意是 `plugins`），本地路径由 `localSource(spec, directory)` 解析。**配置文件名与位置（`opencode.json`？项目 `.opencode/`？）类型里没有**——测试项目用 `opencode.json` + `plugins: ["./.opencode/plugins/agent-supervisor.ts"]`，第一次启动靠 dump 里有没有 setup 记录确认 |

## 2. 适配器因此改了什么
- 第一轮（#109）：`setup` async + 清理函数；`session.prompt` 钩子；`evaluate` 按 `source.id` 绑定；字段名 `id`/`input`。
- 第二轮（#115）：`injectSystem` 追加干净的 `SystemPart`；订阅 `session.execution.interrupted`（reason=user）→ `event=interrupt`；`stop.ts`、安装说明里的「未核实」措辞更新。
- **没改**：拦截策略仍是 observe-only；没有用 `Tool.Error`。

## 3. 真机清单（专门的测试项目；Jack 在场时做；我不会碰 `~/.config/opencode` 或任何全局配置，也不会自己运行 OpenCode）
准备（只创建测试项目文件夹，decisions #116）：
```
sv opencode-probe-project <目录>            # 先看计划（dry-run）
sv opencode-probe-project <目录> --apply    # Jack 同意后才创建
```
测试项目里：`opencode.json`（项目级配置，`plugins` 指向项目内插件）、`.opencode/plugins/agent-supervisor.ts`、`start-daemon.sh`（shadow，数据目录 `.sv-home`）、`run-observe.sh`、`run-probe.sh`、`report.sh`，并 `git init` + 一次提交。

1. **启动**：终端 A `./start-daemon.sh`；终端 B `./run-observe.sh`（`SV_OPENCODE_DUMP=1`，脚本里 `unset SV_OPENCODE_ENFORCE`）。先 `./report.sh` 确认插件被加载（五个钩子注册成功 + `event.subscribe` 注册）。dump 为空 = 登记写法不对，停下来，**不要往全局配置里放**。
2. **只读观察**：让 agent 依次做：列文件并读 README；新建 notes.txt 再改成两行；运行 `false` 再 `echo ok`；用 todowrite 列三步计划；Esc 中断一次；再开第二个会话。然后 `./report.sh`。看：各钩子字段；`BEA`/`EBA`/`BA` 计数（#5、#6）；`evaluate` 的 `source` 形状；`context` 的 `system` 元素；`prompt` 的 `prompt` 形状；`location`（#4）；Esc 之后守护进程是否收到 `interrupt`（#10）。
3. **sessionID/id 配对**：报告字段列里 before/after 的 `sessionID`、`id` 次数应相等。
4. **context 注入可见性**（可选）：advise 模式下造一条建议，看模型是否体现、历史里是否没有。
5. **探针（Jack 已批准，decisions #106）**：退出后 `./run-probe.sh`（`SV_OPENCODE_PROBE=sv-probe-deny`），让 agent 执行**一条**无害命令 `touch /tmp/sv-probe-deny`。预期：被拒绝，agent 看到的原因含「agent-supervisor 探针」，会话没有整体中断。验证 #1、#7。环境变量只在这个脚本里，不残留。
6. **本地 X2（仍不拦）**：`./run-observe.sh` 里让 agent 执行 `git reset --hard HEAD`，看 dump 里的 `wouldDeny` 备注和守护进程 `/v1/danger/events` 的 `would_have_blocked`。
7. 把 `./report.sh` 的文本输出（已脱敏，发之前自己扫一眼）和 `opencode --version` 发回来。

## 4. 仍只能真机确认的项（类型已补齐，剩下的都不是类型能回答的）
触发顺序（#5）、是否每次调用都触发 evaluate（#6）、工具名与参数形态（#9）、Esc 是否产生 `reason:"user"` 的 interrupted 事件、`opencode.json` 文件名与 `plugins` 登记是否生效（#12）、`Tool.Error` 能否在 promise 钩子里 throw（#3）、排队 prompt 的语义（#11）、context 注入的可见性（#2）。

## 5. 通过标准（才可以考虑打开 OpenCode 的拦截）
- `sv opencode-report` 显示 §1 的 #1 #3 #4 #5 #7 都成立（#6 不成立要有替代方案，例如 `execute.before` 抛 `Tool.Error`）。
- 探针按预期工作。
- shadow 下至少一周，OpenCode 的 `would_have_blocked` 记录人工看过没有误报。
- Jack 明确批准，并通过 `opencodeEnforce` 开关（decisions #110）打开——开关会检查最近一次报告。
