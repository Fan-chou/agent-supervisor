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
   - `vitest` 不带 `run`/`--run` 且 `CI` 环境变量未设置时为 watch。
8. **probe 的「项目包」判定**：分类器不知道项目包名，用「不在常见标准库/常见第三方白名单里的 import」近似；相对导入、`require('./…')`、`assert` 一律算。`import numpy` 这类常见第三方包放进白名单（不算 probe）。heredoc 里有写文件调用 → `other` + mutating。
9. **smoke/repro 判定需要上下文**：分类器是无状态的，调用方通过 `ClassifyOptions.newScripts`（本会话新建过的脚本）和 `sourceEdited`（是否已改过源码）传入。新建脚本在改源码前运行 → `repro_script`；改源码后且文件名符合 `smoke*/check_*/verify*/try_*`、`/tmp/*.py` → `smoke_script`。
10. **FailureClassifier**：退出码只认头部（`Output:` 之前，或无 `Output:` 时的前 600 字符），防止输出正文伪造。强失败信号优先于强成功信号；弱信号（`Error:`、`failed` 单词）只对测试/构建/lint/typecheck/脚本类命令采信。带计数的失败模式要求非零（`0 failed`、`Found 0 errors` 不算失败）。
11. **errFingerprint**：错误行最多取 8 条不同的归一化行；归一化会去掉带目录的路径与孤立文件名、行号、数字、十六进制（≥7 位）、UUID、ANSI。只取最后一个 Traceback 的最后一帧。无错误行 → 尾部 300 字符。返回 16 位十六进制；空输出返回 `undefined`。
12. **工作区指纹**：`kind` ∈ `git | non-git | timeout | error`。只有两边都是 `git` 且指纹相同才算「确定没改动」；其余一律按「可能有改动」。指纹包含 `status`（含未跟踪文件逐个列出）、未暂存 diff 哈希、暂存区 diff 哈希、未跟踪文件 `(path, mtime, size)`（最多 2000 个）。`git` 调用设 `GIT_OPTIONAL_LOCKS=0`，避免 `status` 去写 index 锁。
13. **脱敏**：`redact()` 对 `*_KEY=`/`*_TOKEN=`/`password=` 保留变量名只抹值；`redactDeep` 对键名以 key/token/secret/password 结尾的字段整体抹掉。输出头尾各 1k 字符的截断是独立函数 `headTail`，由调用方决定何时用。
