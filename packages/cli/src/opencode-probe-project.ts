// `sv opencode-probe-project <dir> [--apply]`：为 OpenCode 真机核对准备一个**专门的测试项目文件夹**（decisions #113）。
// 只用项目级 OpenCode 配置（<dir>/opencode.json + <dir>/.opencode/plugins/）；守护进程数据目录也放在 <dir>/.sv-home，不碰 ~/.agent-supervisor。
// 绝不读写 ~/.config/opencode 或任何全局配置；默认只打印计划（dry-run），加 --apply 才在 <dir> 里创建文件。**不启动 OpenCode、不启动守护进程**——那是 Jack 在场时按计划手动做的。
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { opencodePluginSource } from "./install.ts";

export interface ProbeFile {
  path: string; // 相对 dir
  mode: number;
  content: string;
}

export const PROBE_MARKER = ".sv-probe-project";
export const PROBE_STRING = "sv-probe-deny";

const FORBIDDEN_UNDER_HOME = [".config", ".claude", ".codex", ".agent-supervisor", ".ssh", ".gnupg", ".aws"];

/** 目录必须安全：不是 ~ 本身、不在被禁的用户配置目录里、不在本仓库里；已存在则必须是空目录或带标记的旧测试项目。返回错误列表。 */
export function checkProbeDir(dir: string, o: { home?: string; repoRoot: string; exists?: (p: string) => boolean; list?: (p: string) => string[] }): string[] {
  const home = resolve(o.home ?? homedir());
  const d = resolve(dir);
  const errs: string[] = [];
  const under = (p: string, base: string) => p === base || p.startsWith(base + sep);
  if (d === home || d === sep) errs.push("不能用用户主目录或根目录");
  for (const f of FORBIDDEN_UNDER_HOME) if (under(d, join(home, f))) errs.push(`不能放在 ~/${f} 里（绝不碰全局配置）`);
  if (under(d, resolve(o.repoRoot))) errs.push("不能放在 agent-supervisor 仓库里（测试项目有自己的 git）");
  if (/(^|[\\/])\.env/.test(d)) errs.push("路径里含 .env");
  const exists = o.exists ?? existsSync;
  if (exists(d)) {
    const names = (o.list ?? ((p) => readdirSync(p)))(d);
    if (names.length && !names.includes(PROBE_MARKER)) errs.push(`目录已存在且非空，也不是之前的测试项目（没有 ${PROBE_MARKER}）`);
  }
  return errs;
}

/** 要创建的文件。pluginSource 是 `sv install opencode` 同一份自包含插件。 */
export function probeFiles(o: { repoRoot: string; pluginSource: string }): ProbeFile[] {
  const sv = `bun ${JSON.stringify(join(resolve(o.repoRoot), "packages/cli/src/sv.ts"))}`;
  const sh = (body: string): ProbeFile["content"] => `#!/bin/sh\nset -e\ncd "$(dirname "$0")"\nexport SV_HOME="$PWD/.sv-home"\nunset SV_OPENCODE_ENFORCE SV_OPENCODE_PROBE # 核对通过前绝不拦截；探针只在 run-probe.sh 里显式打开，即使外层 shell 里设过也不继承\n${body}\n`;
  return [
    { path: PROBE_MARKER, mode: 0o644, content: "agent-supervisor OpenCode 真机核对用的测试项目；可以整个删除。\n" },
    // 登记方式：@opencode/schema 的 Config 有 `plugins: Array<string | {package, options?}>`，本地路径由 @opencode/plugin 的 localSource(spec, directory) 解析。配置文件名 opencode.json 是 OpenCode 的惯例，类型里没有——第一次启动看 dump 里有没有 setup 记录来确认。
    { path: "opencode.json", mode: 0o644, content: JSON.stringify({ plugins: ["./.opencode/plugins/agent-supervisor.ts"] }, null, 2) + "\n" },
    { path: ".opencode/plugins/agent-supervisor.ts", mode: 0o644, content: o.pluginSource + "\n" },
    { path: "README.md", mode: 0o644, content: "# OpenCode 核对用测试项目\n\n一个小项目，用来让 agent 做点无害的事。步骤见 agent-supervisor 仓库的 docs/opencode-verify.md §3。\n" },
    { path: "start-daemon.sh", mode: 0o755, content: sh(`# 守护进程（shadow：只记录，永不拦截），数据目录在本项目的 .sv-home\nexec ${sv} start --home "$SV_HOME" --mode shadow`) },
    { path: "run-observe.sh", mode: 0o755, content: sh(`# 只观察：SV_OPENCODE_DUMP=1，不开拦截、没有探针\nSV_OPENCODE_DUMP=1 exec opencode "$@"`) },
    { path: "run-probe.sh", mode: 0o755, content: sh(`# 探针（Jack 已批准，decisions #106）：只有含 ${PROBE_STRING} 的权限评估会被拒绝；只让 agent 执行 touch /tmp/${PROBE_STRING}。跑完直接退出，不要把环境变量留在 shell 里\nSV_OPENCODE_DUMP=1 SV_OPENCODE_PROBE=${PROBE_STRING} exec opencode "$@"`) },
    { path: "report.sh", mode: 0o755, content: sh(`f="$(ls -t "$SV_HOME"/dumps/opencode-*.jsonl | head -1)"\nexec ${sv} opencode-report "$f"`) },
  ];
}

/** 给 Jack 的计划（真机运行前先过目）。 */
export function probePlan(dir: string, repoRoot: string): string[] {
  const d = resolve(dir);
  const sv = join(resolve(repoRoot), "packages/cli/src/sv.ts");
  return [
    `测试项目：${d}（只在这里创建文件；不碰 ~/.config/opencode 或任何全局配置；OpenCode 仍会按自己的规则读取全局配置，我们不改它）`,
    "将创建：",
    `  ${PROBE_MARKER}  opencode.json（plugins 指向本项目 .opencode/plugins/agent-supervisor.ts）  .opencode/plugins/agent-supervisor.ts（sv install opencode 同一份插件）`,
    "  README.md  start-daemon.sh  run-observe.sh  run-probe.sh  report.sh   并在项目里 git init + 一次提交（让 git reset --hard 之类的 X2 测试有一次性仓库）",
    "数据目录是 <项目>/.sv-home（守护进程库、dump、hook.json 都在这里，不用 ~/.agent-supervisor）。",
    "真机步骤（Jack 在场时，逐步手动做；我不会自己跑）：",
    "  1) 终端 A：./start-daemon.sh                    （shadow；永不拦截）",
    "  2) 终端 B：./run-observe.sh                     （OpenCode 在本项目里启动，SV_OPENCODE_DUMP=1；不设 SV_OPENCODE_ENFORCE）",
    "     先确认插件被加载：./report.sh 里「五个钩子都注册成功」。如果 .sv-home/dumps 里没有任何记录 = 登记写法不对（opencode.json 的字段/文件名未经类型确认），停下来告诉我，不要往全局配置里放。",
    "  3) 让 agent 依次：列文件并读 README；新建 notes.txt 再改成两行；运行 false 再 echo ok；用 todowrite 列三步计划；Esc 中断一次；再开第二个会话。",
    "  4) ./report.sh 看：钩子字段、BEA/EBA/BA 计数、evaluate 的 source、interrupt 事件是否到达（插件已订阅 session.execution.interrupted）、context 的 system 元素。",
    `  5) 探针：退出后 ./run-probe.sh，让 agent 只执行一条 touch /tmp/${PROBE_STRING}。预期被拒绝且 agent 看到「agent-supervisor 探针」。做完退出（环境变量只在这个脚本里，不残留）。`,
    "  6) 本地 X2（仍不拦）：在 ./run-observe.sh 里让 agent 执行 git reset --hard HEAD；看 .sv-home 里 dump 的 wouldDeny 备注和守护进程的 /v1/danger/events。",
    `  7) 把 ./report.sh 的文本输出和 opencode --version 发回来（已脱敏，发之前自己扫一眼）。`,
    `守护进程命令等价于：bun ${sv} start --home <项目>/.sv-home --mode shadow`,
    "加 --apply 才会真的创建上述文件。",
  ];
}

export async function runOpencodeProbeProject(pos: string[], flags: Record<string, string | boolean | string[] | undefined>, o: { repoRoot: string; home?: string }): Promise<{ code: number; lines: string[] }> {
  const dir = pos[0];
  if (!dir) return { code: 2, lines: ["用法：sv opencode-probe-project <目录> [--apply]   （默认只打印计划；--apply 才在该目录里创建测试项目）"] };
  const errs = checkProbeDir(dir, { repoRoot: o.repoRoot, home: o.home });
  if (errs.length) return { code: 2, lines: ["目录不合适：", ...errs.map((e) => "  - " + e)] };
  const plan = probePlan(dir, o.repoRoot);
  if (flags.apply !== true) return { code: 0, lines: [...plan, "（dry-run：没有创建任何文件）"] };
  const d = resolve(dir);
  const files = probeFiles({ repoRoot: o.repoRoot, pluginSource: await opencodePluginSource() });
  mkdirSync(d, { recursive: true });
  for (const f of files) {
    const p = join(d, f.path);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, f.content, { mode: f.mode });
    chmodSync(p, f.mode);
  }
  const git = (...a: string[]) => Bun.spawnSync(["git", "-c", "user.name=sv-probe", "-c", "user.email=sv-probe@example.invalid", "-c", "commit.gpgsign=false", ...a], { cwd: d, stdout: "ignore", stderr: "ignore" }).exitCode;
  let gitNote = "目录里已有 .git，未改动。";
  if (!existsSync(join(d, ".git"))) gitNote = git("init", "-q") === 0 && git("add", "-A") === 0 && git("commit", "-q", "-m", "probe project") === 0 ? "已 git init 并提交一次。" : "git init/commit 失败（X2 的 git reset 测试需要手动准备一个仓库）。";
  return { code: 0, lines: [`已在 ${d} 创建测试项目（${files.length} 个文件）。${gitNote}`, "没有启动 OpenCode 或守护进程；按上面的计划由 Jack 手动做。"] };
}
