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
