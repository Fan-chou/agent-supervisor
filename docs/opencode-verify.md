# OpenCode 2 核对记录与真机清单

状态：**类型层面的核对已完成**（依据 `docs/vendor/opencode-plugin-2.0.32/` 里 `@opencode/plugin` 2.0.32 的 `.d.ts`，decisions #105）；**真机验证还没做**。核对通过前 OpenCode **只观察、不拦截**（decisions #89）。

## 1. 类型核对结论（12 条假设）

图例：✓ 类型里确认；✗ 与假设不符（已改适配器）；? 类型里没有答案（引用的类型包没有 vendor，或只能真机看）。

| # | 假设 | 结论 | 依据与处理 |
|---|---|---|---|
| 1 | `permission.hook("evaluate")` 存在，`effect`/`message` 可写 | **✓**（`Permission.Effect` 的取值 **?**） | `promise/permission.d.ts`：`PermissionEvaluation{sessionID, agent?, action, resources[], metadata?, source?, effect, message?}`，`effect`、`message` 非 readonly。`Permission.Effect` 在 `@opencode/schema/permission`（没 vendor），"deny" 这个字面量未经类型确认——探针（§3 步骤 4）会验证 |
| 2 | `session.hook("context")` 里 `e.system.push(字符串)` | **✗** | `SessionContext.system` 是 `Array<SystemPart>`（来自 `@opencode/ai`，没 vendor），**不是字符串数组**。适配器已改：只在能确认元素形态时才注入（元素是字符串 → 推字符串；元素是带字符串 `text` 的对象 → 复制最后一个元素的形状只换 `text`；空数组/未知形态 → 不注入，只记 dump）。`SystemPart` 的真实定义需要补 `@opencode/ai` 的类型（§4） |
| 3 | `tool.hook("execute.before"/"execute.after")`，after 带 status/result/error | **✓** | `ToolHooks`：before `{tool, sessionID, agent, messageID, id, input}`（`tool`、`input` 可写）；after `{…, input} & ({status:"completed", result} \| {status:"error", error})`。**另有重要发现**：`ToolFailures["execute.before"] = Tool.Error`——before 钩子可以以 `Tool.Error` 失败，是一条官方的「拒绝这次调用」通道，不依赖 evaluate 的触发顺序（`Tool.Error` 的构造参数在 `@opencode/schema/tool`，没 vendor；暂不使用） |
| 4 | 事件里有 sessionID、工具名、参数、callID、directory | **部分 ✗（字段名不同）** | 真实字段是 `id`（调用 id，`Tool.CallID`）和 `input`，不是 `callID`/`args`；**事件上没有 `directory`**，目录来自 `context.location`（`Location.Info`，字段在 `@opencode/schema/location`，**?**）。插件的取值函数本来就兼容 `id`/`input`（有测试用真实字段名）；directory 走 `ctx.location.directory`（未确认字段名） |
| 5 | `execute.before` 先于 `permission.evaluate` | **?** 但**影响已缓解** | 类型不规定顺序。但 `PermissionEvaluation.source` 在工具发起的评估里是 `{type:"tool", messageID, id}`（`permission.d.ts` 的 `AssertInput.source`），`id` 就是工具调用 id——适配器改为**按 `source.id` 精确绑定**到对应的 `execute.before`，对不上就放行；没有 `source` 才退回「该会话最近一次 before」。顺序仍用 `sv opencode-report` 在真机上确认 |
| 6 | 每次调用都会触发 evaluate | **?** | 取决于各工具是否调用 `permission.assert`（`permission.d.ts` 注释：先评估规则，需要审批时才询问）。真机看报告里的 `BA`（无 E）计数。若有，这些调用上 deny 只能走 `execute.before` 抛 `Tool.Error` |
| 7 | hook 处理函数可以是 async | **✓**，但**注册也是异步的** | promise API：`Hooks<Spec> = (name, cb: (input) => Promise<void>\|void) => Promise<Registration>`。回调可以 async ✓。**适配器之前同步忽略了注册返回的 Promise**（注册失败会变成未处理的 rejection）——已改：`setup` 改为 async、逐个 await 注册并捕获拒绝，返回 `Cleanup`（注销全部 hook） |
| 8 | `e.model`、`e.agent`、`e.messages` 形态 | **部分 ✓** | `model: Model.Ref`（形态 **?**，`modelName()` 兼容字符串和 `{providerID, id\|modelID}`）；`agent: Agent.ID`（字符串 ✓）；`messages: Array<Message>`（`@opencode/ai`，**?**）。user 消息改用专门的钩子（见 #10 之后的补充），不再依赖扫 messages |
| 9 | 工具名/参数形态（bash 的 `command`、编辑类的 `filePath`） | **?** | `input: unknown`，名字是各工具自己的 id（`Tool.Info.id`）。真机 dump 看 |
| 10 | 有中断 / 会话创建事件 | **? 大概率没有 hook** | `SessionHooks` 里没有 interrupt / created；`session.interrupt` 是要**调用**的 API；事件只能走 `context.event.subscribe`（`EventApi`，事件模型在 `@opencode/client`，没 vendor）。插件暂不订阅，OpenCode 上「中断清零重复计数」缺失。**补充发现**：`session.hook("prompt")`（`SessionPrompt{sessionID, messageID, prompt, delivery}`，`prompt` 可写）是真正的 user 消息入口——适配器已接上（`event=prompt`），origin 回显判定改用它 |
| 11 | `session.prompt({sessionID,text,delivery})` 存在；有「这一轮结束」事件 | **部分 ✓** | `SessionDomain` 有 `prompt`/`synthetic`/`interrupt`/`wait`/`command`/`compact`（`Pick<SessionApi,…>`），参数形态在 `@opencode/client`（没 vendor）；`SessionPrompt.delivery: SessionInbox.Delivery`（取值 **?**）；「这一轮结束」没有钩子，候选是 `session.wait` 或 `event.subscribe`。收尾续跑仍是研究（`adapter-opencode/src/stop.ts`，未接线） |
| 12 | 插件形态与加载方式 | **形态 ✓，登记方式 ?** | `import { Plugin } from "@opencode/plugin"`（promise API，默认导出）：`Plugin.define({ id, setup(context) })`，`setup` 可返回 `Cleanup`；另有 `@opencode/plugin/effect`（`effect: (ctx) => Effect`）。我们导出结构相同的对象（不 import 运行时包，保持可打包）。**怎么在 OpenCode 配置里登记**（`host.d.ts` 只有 `Host.resolve({directory,name}) → {server?, tui?, rpc?}` 入口概念）类型里没有——要看文档或 Jack 在真机上决定 |

## 2. 适配器因此改了什么（对应 commit）
- 插件：`setup` async、await 注册并捕获拒绝、返回清理函数；新增 `session.prompt` 钩子（user 消息 → `event=prompt`）；`context` 注入只在 `system` 元素形态可确认时做；`evaluate` 按 `source.id` 绑定调用；`DUMP` 记录每个钩子是否注册成功。
- 归一化器：新增 `prompt` 事件（origin=user，tracker 判回显）。
- 安装说明：改为「已对照类型核对，未在真机验证」。
- **没改**：拦截策略仍是 observe-only；没有用 `Tool.Error`（构造参数未知）。

## 3. 真机清单（Jack 在场时做；我不会碰 `~/.config/opencode`，改配置前必须先问 Jack）
前置：`sv start`（shadow）；把 `sv install opencode` 打印的插件保存并按 OpenCode 的方式登记（**这一步由 Jack 决定位置和写法**）；以 `SV_OPENCODE_DUMP=1` 启动 OpenCode。
1. **只读观察**：让 agent 依次做：列文件并读 README；新建 notes.txt 再改成两行；运行 `false` 再 `echo ok`；用 todowrite 列三步计划；Esc 中断一次；再开第二个会话。然后 `sv opencode-report ~/.agent-supervisor/dumps/opencode-<日期>.jsonl`。看：五个钩子都注册成功；各钩子字段；`BEA`/`EBA`/`BA` 计数（#5、#6）；`evaluate` 的 `source` 形状；`context` 的 `system` 元素形状（#2）；`prompt` 的 `prompt` 形状；`location` 形状（#4）。
2. **sessionID/id 配对**：报告的字段列里 before/after 的 `sessionID`、`id` 次数应相等。
3. **context 注入可见性**（可选）：在 advise 模式下造一条建议，看模型是否体现、历史里是否没有（需要 #2 的形态确认之后）。
4. **探针（Jack 已批准，decisions #106）**：`SV_OPENCODE_PROBE=sv-probe-deny` 启动 OpenCode，让 agent 执行**一条**无害命令 `touch /tmp/sv-probe-deny`。预期：被拒绝，agent 看到的原因含「agent-supervisor 探针」，会话没有整体中断。同时验证 #1（deny 字面量与 message）、#7（异步）。做完立刻取消该环境变量。
5. **本地 X2（仍不拦）**：保持 `mode=shadow`，在一次性 git 目录里让 agent 执行 `git reset --hard HEAD`，看 `/v1/danger/events` 有 `would_have_blocked`，dump 里有 `wouldDeny` 备注。
6. 把 `sv opencode-report` 的文本输出发回来（已脱敏，发之前自己扫一眼）和 `opencode --version`。

## 4. 还需要补的类型（Jack 方便时 `npm pack` 同版本 2.0.32 的这几个包，拷到 `docs/vendor/`）
`@opencode/schema`（permission、tool、location、prompt-input、session-inbox、session-message）、`@opencode/ai`（`SystemPart`、`Message`）、`@opencode/client`（`SessionApi.prompt` 的参数、`EventApi` 的事件模型）。有了它们，#1 的 effect 取值、#2 的 SystemPart、#4 的 Location、#8/#9/#10/#11 里标 ? 的部分可以不用真机直接定下来。

## 5. 通过标准（才可以考虑打开 OpenCode 的拦截）
- `sv opencode-report` 显示 §1 的 #1 #3 #4 #5 #7 都成立（#6 不成立要有替代方案，例如 `execute.before` 抛 `Tool.Error`）。
- 探针按预期工作。
- shadow 下至少一周，OpenCode 的 `would_have_blocked` 记录人工看过没有误报。
- Jack 明确批准，并通过 `opencodeEnforce` 开关（decisions #109）打开——开关会检查最近一次报告。
