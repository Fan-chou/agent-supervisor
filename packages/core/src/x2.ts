// X2 危险操作（design §5.5）。纯函数，适配器本地执行，不依赖守护进程，不受连续拦截上限约束。
// 只是尽力而为——bash -c / python -c open() 之类的写法可以绕过，它不是安全边界。
import { homedir } from "node:os";
import { posix } from "node:path";
import { analyzeShell } from "./cmdclass.ts";
import type { Harness } from "./event.ts";

export type X2Category = "env" | "key" | "ci" | "rm" | "git";

export interface X2Result {
  rule: "X2";
  category: X2Category;
  /** Claude 上 CI/.env 用 ask，其余 deny；Codex/OpenCode 一律 deny。 */
  action: "deny" | "ask";
  reason: string;
  subject: string;
}

export interface X2Input {
  harness: Harness;
  /** shell 命令（如果是 shell 工具）。 */
  command?: string;
  /** 编辑/写入的文件（如果是编辑工具）。 */
  files?: string[];
  cwd?: string;
  home?: string;
}

const CI_RES: RegExp[] = [
  /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/,
  /(^|\/)\.github\/actions\/.+\.ya?ml$/,
  /(^|\/)\.gitlab-ci\.ya?ml$/,
  /(^|\/)\.circleci\/config\.ya?ml$/,
  /(^|\/)Jenkinsfile$/,
  /(^|\/)azure-pipelines\.ya?ml$/,
  /(^|\/)\.travis\.ya?ml$/,
  /(^|\/)bitbucket-pipelines\.ya?ml$/,
  /(^|\/)\.drone\.ya?ml$/,
  /(^|\/)cloudbuild\.ya?ml$/,
  /(^|\/)buildkite\/.+\.ya?ml$/,
];

const BUILD_DIRS = new Set(["node_modules", "dist", "build", ".next", "target", "__pycache__", ".venv", "venv", "coverage", ".pytest_cache", "out", ".turbo", ".cache", "tmp", ".mypy_cache", ".ruff_cache", ".nuxt", ".svelte-kit", ".parcel-cache", ".gradle", "htmlcov", ".tox", ".eggs", ".idea"]);

export function classifyWritePath(path: string): X2Category | null {
  const base = path.replace(/\/+$/, "").split("/").pop() ?? "";
  if (/^\.env(\..+)?$/.test(base)) {
    if (/\.(example|sample|template|dist)$/.test(base)) return null;
    return "env";
  }
  if (/\.(pem|key)$/i.test(base)) return "key";
  if (CI_RES.some((re) => re.test(path))) return "ci";
  return null;
}

function actionFor(harness: Harness, cat: X2Category): "deny" | "ask" {
  return harness === "claude" && (cat === "ci" || cat === "env") ? "ask" : "deny";
}

function expandHome(p: string, home: string): string {
  if (p === "~" || p === "$HOME" || p === "${HOME}") return home;
  if (p.startsWith("~/")) return posix.join(home, p.slice(2));
  if (p.startsWith("$HOME/")) return posix.join(home, p.slice(6));
  if (p.startsWith("${HOME}/")) return posix.join(home, p.slice(8));
  return p;
}

const TMP_RE = /^(\/tmp|\/private\/tmp|\/var\/folders|\/private\/var\/folders)(\/|$)/;

function rmDangerous(target: string, cwd: string | undefined, home: string): string | null {
  const t = expandHome(target, home);
  // 含未解析变量/命令替换：无法判断，放行（尽力而为）
  if (/[$`]/.test(t)) return null;
  const abs = t.startsWith("/") ? posix.normalize(t) : cwd ? posix.normalize(posix.join(cwd, t)) : undefined;
  if (t === "/" || t === "/*" || abs === "/") return "根目录";
  if (abs === undefined) {
    return t.startsWith("..") ? "仓库外的相对路径" : null;
  }
  const clean = abs.replace(/\/+$/, "") || "/";
  if (TMP_RE.test(clean)) return null;
  const homeClean = home.replace(/\/+$/, "");
  const globbed = clean.replace(/\/\*+$/, "");
  if (globbed === homeClean) return "$HOME";
  if (cwd) {
    const root = posix.normalize(cwd).replace(/\/+$/, "") || "/";
    const inside = clean === root || clean.startsWith(root + "/");
    if (!inside) return "仓库外的路径";
    const rel = clean === root ? "" : clean.slice(root.length + 1);
    if (rel === "" || rel === ".git" || rel.startsWith(".git/")) return rel === "" ? "仓库根目录" : ".git";
    const first = rel.split("/")[0];
    if (BUILD_DIRS.has(first)) return null;
    return null; // 仓库内的普通子目录：可由 git 恢复，不拦
  }
  // 不知道仓库根：绝对路径且不在 /tmp，保守地按「仓库外」处理
  if (t.startsWith("/") || t.startsWith("~")) return "仓库外的路径（未知仓库根）";
  return null;
}

function gitDangerous(args: string[]): string | null {
  // 去掉全局选项 -C dir / -c k=v
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    i += args[i] === "-C" || args[i] === "-c" || args[i] === "--git-dir" || args[i] === "--work-tree" ? 2 : 1;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  const has = (...fl: string[]) => rest.some((a) => fl.includes(a));
  switch (sub) {
    case "push":
      // --force-with-lease 更安全，不拦
      if (has("--force", "--mirror") || rest.some((a) => /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a)) || rest.some((a) => /^\+[\w./-]+(:[\w./-]+)?$/.test(a)))
        return "git push --force";
      return null;
    case "reset":
      return has("--hard") ? "git reset --hard" : null;
    case "checkout":
      return rest.includes("--") && rest[rest.indexOf("--") + 1] === "." ? "git checkout -- ." : rest.length === 1 && rest[0] === "." ? "git checkout ." : null;
    case "restore":
      if ((has("--staged") || has("-S")) && !has("--worktree", "-W")) return null;
      return rest.includes(".") ? "git restore ." : null;
    case "clean":
      return rest.some((a) => /^-[a-zA-Z]*f/.test(a) || a === "--force") && !has("-n", "--dry-run") ? "git clean -f" : null;
    case "stash":
      return rest[0] === "drop" || rest[0] === "clear" ? `git stash ${rest[0]}` : null;
    default:
      return null;
  }
}

export function x2Check(input: X2Input): X2Result | null {
  const home = input.home ?? homedir();
  const mk = (category: X2Category, subject: string, reason: string): X2Result => ({
    rule: "X2",
    category,
    action: actionFor(input.harness, category),
    reason,
    subject,
  });
  for (const f of input.files ?? []) {
    const c = classifyWritePath(f);
    if (c) return mk(c, f, `X2：写入 ${f}（${labelOf(c)}）需要用户确认`);
  }
  if (input.command) {
    const a = analyzeShell(input.command);
    for (const seg of a.segments) {
      for (const t of seg.targets) {
        const c = classifyWritePath(t);
        if (c) return mk(c, t, `X2：命令写入 ${t}（${labelOf(c)}）需要用户确认`);
      }
      const base = seg.argv[0]?.replace(/^.*\//, "");
      const args = seg.argv.slice(1);
      if (base === "rm") {
        const recursive = args.some((x) => /^-[a-zA-Z]*[rR]/.test(x) || x === "--recursive");
        if (recursive) {
          for (const t of args.filter((x) => !x.startsWith("-"))) {
            const why = rmDangerous(t, input.cwd, home);
            if (why) return mk("rm", t, `X2：rm -r 目标 ${t} 属于${why}`);
          }
        }
      } else if (base === "git") {
        const why = gitDangerous(args);
        if (why) return mk("git", why, `X2：${why} 可能丢失未提交的工作或改写远端历史`);
      }
    }
  }
  return null;
}

function labelOf(c: X2Category): string {
  return c === "env" ? "环境变量/密钥文件" : c === "key" ? "私钥/证书" : c === "ci" ? "CI 配置" : c === "rm" ? "删除" : "git";
}
