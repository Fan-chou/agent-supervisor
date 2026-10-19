# 使用说明：安装 / 启用 / 停用 / 数据收集

默认行为：**shadow 模式只记录、永不拦截**（含危险命令：只标 `severity=dangerous`、`outcome=would_have_blocked`）；OpenCode 的 `opencodeEnforce` 默认关；任何出错（守护进程没开、超时、坏响应、hook 自己抛异常）hook 都是 exit 0 且不输出，不会卡住 agent。所以装上之后，守护进程没启动时 agent 照常工作，只是没有记录（hook 只把"守护进程不可达"这件事写进 `health-spool.jsonl`，下次启动时补记为 adapter_health；工具调用事件本身不补）。

## 1. 守护进程（三个 agent 共用）
```
cd <本仓库>
bun install                      # 只装在本项目里
bun run build:hook               # 编译 hook 二进制 bin/sv-hook（Claude / Codex 共用）
mkdir -p ~/.agent-supervisor/bin && cp bin/sv-hook ~/.agent-supervisor/bin/sv-hook
bun packages/cli/src/sv.ts start # 前台运行，默认 shadow；Ctrl-C 停止
bun packages/cli/src/sv.ts status
```
数据在 `~/.agent-supervisor/`（`state.db`、`hook.json`、`token`、`spool/`、`dumps/`）。`--home <dir>` / `SV_HOME` 可改位置。hook 不会自动拉起守护进程（有意如此）；改 mode 需重启守护进程。judge 默认关；要用 `--judge=live` 并自己设 `judge.api_key_env` 指向的环境变量。

> 下文用 `sv` 代替 `bun packages/cli/src/sv.ts`。

## 2. Claude Code
- **启用**：`sv install claude` 打印 hooks 片段，手动合并进 `.claude/settings.json`（建议先放某个项目的项目级设置里试，而不是全局）。本工具不会改任何设置文件。
- **停用**：删掉片段里的 hooks（或整个 `~/.agent-supervisor/bin/sv-hook` 不存在时 Claude 会报 hook 命令失败但不阻塞——仍建议删掉配置）。守护进程不用关也行。
- Claude hook 的真实载荷还没校准过（见 `docs/data-request.md` A）。

## 3. Codex
- **启用**：`sv install codex` 打印片段，合并进 `~/.codex/hooks.json`（命令串必须保持 `~/.agent-supervisor/bin/sv-hook codex`，改了要重新审核）。
- **停用**：删掉这些 hooks。
- 格式未在 0.163 上实测。

## 4. OpenCode（2.0.32，真机跑过一轮）
- **启用**（项目级，不碰 `~/.config/opencode`）：把 `sv install opencode` 输出里 `agent-supervisor.ts` 那一段保存到 `<项目>/.opencode/plugins/agent-supervisor.ts`。OpenCode 会自动从该目录加载；**不要**在 `opencode.json` 的 `plugins` 里写 `.ts` 路径（会警告 `plugin path must be a directory`）。
- **停用**：删掉那个插件文件。
- **拦截**：保持关闭。要打开必须同时满足守护进程 `mode=enforce`、`sv opencode-enforce on --approved-by <名字>`（要求最新的 `sv opencode-report` 机器门槛全过）、插件进程 `SV_OPENCODE_ENFORCE=1`。日常使用不需要。
- **专门测试项目**：`sv opencode-probe-project <目录> [--apply]`（已有一个：`~/Documents/dev/opencode-sv-probe`）。
- 真机事实（run1）：工具名 `read/write/edit/shell`，参数 `path`、`oldString/newString`、`{command, workdir?}`；OpenCode 2 `run` 模式没有 `todowrite`，所以任务计划只剩 `.supervisor/plan.md`（见下）；批量调用的钩子顺序是 BBBEEA，插件按调用 id 绑定。
- Esc 中断**尚未验证**：日常使用时顺带按一次 Esc，然后 `SV_OPENCODE_DUMP=1` 启动的话跑 `sv opencode-report` 看「中断事件」一节是否出现 `user`。

### 没有 todowrite 时的任务计划
计划相关规则（P1 越界、作弊检测里的"当前步骤"等）没有计划就自动不触发，不会误报。想启用它们：在项目里写 `.supervisor/plan.md`（标题 + 清单，可加 `allow: 路径` 行），守护进程会读取。Claude Code / Codex 有自己的 todo/plan 工具，不受影响。

## 5. 看数据 / 前端
```
sv stats --by rule|model|session|danger|runs [--since 7d] [--format text|json|csv]
sv stats --by danger                  # 危险操作：本应拦 / 已拦
sv explain <hit-id>                   # 一次命中的完整链路
sv rules show|set|reset ...           # 规则编辑（立即作用于在跑的会话）
```
前端（MyGo，在另一个仓库）通过守护进程的只读查询 API（`/v1/sessions`、`/v1/hits`、`/v1/judge-calls`、`/v1/rules`、`/v1/config`、`/v1/danger/events`、`/v1/runs`、`/v1/replays`、`/v1/eval/reports`…）取数，唯一可写的是 `PUT /v1/rules/{id}`。接口清单见 `docs/frontend-design.md`。

## 6. 数据收集（Jack 在实际使用中提供反馈/数据）
- **hook 载荷样本**：给 Claude Code / Codex 设 `SV_HOOK_DUMP=1` 启动 → `~/.agent-supervisor/dumps/<harness>-<日期>.jsonl`（0600，密钥已脱敏，但 prompt/命令/文件内容不会被抹掉，交出前自己过一遍）。OpenCode 用 `SV_OPENCODE_DUMP=1` → `dumps/opencode-<日期>.jsonl`，`sv opencode-report <文件>` 汇总。
- **监督记录**：shadow 下正常用即可，记录在 `state.db`；`sv export --out <目录>` 导出 JSONL（正文已脱敏）。
- **标注**：命中级 `sv mark <hit-id> fp|useful [--note ..]`（只记录，不影响策略）；会话级照 `eval/labels.example.yaml` 写 `eval/labels.yaml`，`sv eval eval/labels.yaml` 出 precision/recall。详见 `docs/data-request.md`。
- 回放：`sv replay <file|dir> --judge=off|mock`，用来调阈值（`--set thresholds.T1.H=4`）。

## 7. 未完成项
- Claude / Codex hook 真实载荷校准（等 Jack 的 dump）；Codex hooks 格式未实测。
- 30 个会话标注 → 阈值校准（等 Jack 的数据）。
- OpenCode：Esc 中断事件待验；`Tool.Error` 拒绝通道、收尾续跑（`stop.ts`）未接线；拦截（`opencodeEnforce`）未打开，需要 shadow 观察期 + Jack 批准。
- hook 不自动拉起守护进程、mode 不热加载（有意不做）。
- MyGo 前端的 Go 结构体生成与黄金样例测试在前端仓库。
