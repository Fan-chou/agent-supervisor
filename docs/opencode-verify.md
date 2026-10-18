# OpenCode 2 真机核对清单

状态（本轮）：**适配器依赖的钩子还没有对照 `@opencode/plugin` 2.0.32 的类型和官方文档核实。** 原因：包不在可读位置（全局只装了 `@opencode/cli` 2.0.32，里面是二进制，没有 `.d.ts`；`@opencode/plugin` 没装；项目里不能联网装），文档站的只读访问也没有被工具权限放行。下面的清单是为「Jack 和监督者一起在真机上核对」准备的；核对完成之前 OpenCode **只观察、不拦截**（decisions #89）。

## 0. 先补上类型（二选一，Jack 决定）
- A. 在一个**新建的空目录**里取包（不要在本项目里装，也不要全局装）：`npm pack @opencode/plugin@2.0.32`，解开后把 `package.json` 和 `*.d.ts`（`dist/` 或 `src/` 下的类型文件）拷到本项目的 `docs/vendor/opencode-plugin-2.0.32/`，然后告诉监督者。我会逐项对照下表。
- B. 放行文档站 https://opencode.ai/v2/docs 的只读抓取，我自己读。
- 不论哪种：核对结果写进 decisions.md，不一致的地方改 `packages/adapter-opencode/plugin/agent-supervisor.ts` 和 `normalize.ts`。

## 1. 适配器依赖的假设（逐项核对）

| # | 假设 | 用在哪 | 怎么核对 | 不成立时 |
|---|---|---|---|---|
| 1 | `ctx.permission.hook("evaluate", e => …)` 存在；`e.effect = "deny"`、`e.message` 可写 | 拦截 | 类型 + 探针（§3 步骤 4） | 拦截改走 `ctx.tool.hook("execute.before")` 抛错；设计要重写 |
| 2 | `ctx.session.hook("context", e => e.system.push(…))`；`e.system` 是可变数组，只作用于这一次请求 | 建议注入 | 类型 + dump 里 `context` 的 shape；看模型是否收到 | 建议改走别的注入点，或暂不注入 |
| 3 | `ctx.tool.hook("execute.before")` / `("execute.after")` 存在；`after` 带 `status: completed\|error`、`result`/`error` | 事件来源（Pre/Post） | 类型 + dump | 事件源要换；失败判定回退到 FailureClassifier |
| 4 | 事件对象里有 `sessionID`、工具名（`tool`）、参数（`args`）、`callID`；`directory` 或 `ctx.location.directory` | 归一化、会话区分、pre/post 配对 | dump 的 shape（`sv opencode-report` 的「字段」列） | 改插件里的取值函数（`sid/callId/toolName/dirOf`） |
| 5 | **触发顺序**：同一次调用里 `execute.before` 先于 `permission.evaluate` | block 绑定、本地 X2 | `sv opencode-report` 的「触发顺序」：要看到 `BEA` | 若是 `EBA`：本地 X2 和 daemon block 目前只会漏拦；需改成在 evaluate 里直接用 evaluate 事件自带的参数判断 |
| 6 | 每次调用都会触发 `permission.evaluate`（含已被配置允许的、不需要审批的工具） | deny 能落在每个调用上 | 报告里的 `BA`（没有 E）计数 | 这类调用拦不住；X2 要改用 `execute.before` 抛 `Tool.Error`（并核实抛错的效果） |
| 7 | hook 处理函数可以是 **async**（宿主会 await） | 插件所有 hook 都是 async | 探针：evaluate 里 await 之后才写 `effect`——如果 deny 生效说明被 await 了 | 若宿主不 await：evaluate 里不能再请求守护进程，要改成同步（先在 before 里预取） |
| 8 | `e.model`（字符串或 `{providerID, modelID}`）、`e.agent`、`e.messages`（role/content/parts）形态 | 模型名只记日志；user 消息回显 → origin | dump 的 context shape | 改 `modelName()` / `lastUserMessage()` |
| 9 | 工具名：`bash/edit/write/read/grep/glob/list/todowrite/task/webfetch`；`bash` 的参数是 `command`；编辑类的路径字段是 `filePath` | toolKind、本地 X2 的 `x2Inputs()` | dump 里各工具的 args shape | 改 core 的 `toolKind` 名单 / `x2Inputs()` |
| 10 | 有「用户中断」和「会话创建」事件（插件目前**没有**订阅） | interrupt / session 事件 | 类型里找 | 暂不订阅；中断清零重复计数这条在 OpenCode 上缺失 |
| 11 | `ctx.session.prompt({sessionID, text, delivery:"queue"})` 存在；有「这一轮结束」的事件 | 收尾续跑（仅研究，`adapter-opencode/src/stop.ts`，未接线） | 类型；真机上发一条看是否作为 user 消息排队、会不会重置「本轮」 | 不做收尾续跑 |
| 12 | 插件的加载方式、目录、`Plugin.define` 的导入路径、插件 id 规则 | 安装 | 文档 | 改 `sv install opencode` 的说明与导出形态（现在导出 `{id, setup}`） |

## 2. 需要 Jack 在本机做的事（我不会做）
- 决定插件放哪、怎么登记到 OpenCode 的配置（**我不会改 `~/.config/opencode`**，也不会装/卸任何全局软件）。`sv install opencode` 会把打包好的插件源码打印出来（x2Check/redactDeep 已内联）。
- 启动守护进程：`sv start`（保持 `mode=shadow`）。
- 用环境变量启动 OpenCode：`SV_OPENCODE_DUMP=1`（落样本，脱敏，0600，写到 `~/.agent-supervisor/dumps/opencode-<日期>.jsonl`）。如果 OpenCode 不把环境变量传给插件，在启动命令里显式设置。

## 3. 核对步骤（建议在一个一次性目录里做；每步之后跑 `sv opencode-report <dump 文件>`）
1. **只读观察**：开 `SV_OPENCODE_DUMP=1`，让 agent 做这几件事（提示词可直接复制）：
   - 「列出当前目录的文件，然后读 README」（bash + read）
   - 「新建 notes.txt，写入一行字，再改成两行」（write + edit，会触发权限）
   - 「运行 `false`，再运行 `echo ok`」（一个失败的 bash 调用）
   - 「用 todowrite 列一个三步计划」
   - 用 `Esc` 中断一次长任务；开第二个会话再做一次（确认 sessionID 不同）。
   报告里应当看到：四个钩子都注册成功；`evaluate/execute.before/execute.after/context` 都被调用；每个钩子的顶层字段；§1 的 #3 #4 #5 #6 #8 #9 的结论。
2. **sessionID / callID 配对**：报告的「字段」列里 `sessionID` 和 `callID` 应当在 before/after 里出现次数相等。
3. **context 注入可见性**：把守护进程的 `outbox` 里手工放一条 advise（`sv` 目前没有命令，可在测试环境里用 `Daemon.outbox.enqueue`；或等 L/M 级命中自然产生），确认模型回复里体现了这条 system 文本，且**没有**出现在会话历史里。*（需要 Jack 配合；不影响第 1 步。）*
4. **探针（会拦截，只用于核对，需 Jack 明确同意后才做）**：`SV_OPENCODE_PROBE=sv-probe-deny` 启动 OpenCode，让 agent 执行 `touch /tmp/sv-probe-deny`（一个无害命令）。预期：被拒绝，agent 看到的拒绝原因里有「agent-supervisor 探针」，且这一步没有结束整个会话。这一条同时证明 #1 #7（deny、message、async）。**探针只在环境变量显式设置时存在，默认关。**
5. **本地 X2 是否生效（仍然不拦）**：保持 `mode=shadow`，让 agent 执行 `git reset --hard HEAD`（在一次性 git 目录里），到 `sv stats`/`/v1/danger/events` 看是否有 `would_have_blocked`；同时 dump 里应有 `wouldDeny` 备注（`withheld: enforce gate closed`）。
6. **收尾研究（可选）**：只看 `session.prompt` 的类型和文档，不要在真机上发；等类型核对完，由监督者决定是否做受控实验。

## 4. 通过标准（才可以考虑打开 OpenCode 的拦截）
- §1 的 #1 #3 #4 #5 #7 都确认成立（#6 如果不成立，要有替代方案）。
- 步骤 4 的探针按预期工作。
- 在 shadow 下至少一周，`would_have_blocked` 的 OpenCode 记录里没有误报（人工看）。
- Jack 明确批准。批准后的开关（两处都要）：守护进程以 `opencodeEnforce: true` 启动（目前只能通过代码选项，没有命令行参数——要用的话再加），插件进程里 `SV_OPENCODE_ENFORCE=1`，并且全局 `mode=enforce`。

## 5. 把这些发回来
`sv opencode-report` 的输出（文本即可，不含正文）；步骤 3/4/5 的现象描述；OpenCode 的版本号（`opencode --version`）。dump 文件已脱敏，但发出去前请自己扫一眼。

## 6. 本轮已经为核对做好的东西
- 插件：`SV_OPENCODE_DUMP=1` 落样本（setup 的 ctx 形状、每个钩子 enter/exit 的形状 + 脱敏截断样本、注册成败）；`SV_OPENCODE_PROBE`；本地 X2；观察模式闸门。
- `sv opencode-report`：汇总字段、触发顺序（B/E/A）、各钩子耗时、deny 观察。
- `adapter-opencode/src/stop.ts`：收尾续跑的纯函数与护栏（未接线）。
