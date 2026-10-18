// 命令分类器 CmdClass（design §6.2）+ mutating 识别（§4.3）+ normCmd。
import type { CmdClass } from "./event.ts";
import { joinArgv, splitShell, type Segment } from "./shell.ts";

export interface ClassifyOptions {
  /** 项目配置：test.full / test.fast / test.extra_patterns */
  testFull?: string[];
  testFast?: string[];
  extraPatterns?: string[];
  /** 本会话新建过的脚本路径（smoke / repro 判定用）。 */
  newScripts?: ReadonlySet<string>;
  /** 本会话是否已修改过源码（区分 repro_script 与 smoke_script）。 */
  sourceEdited?: boolean;
}

export interface SegmentInfo {
  argv: string[]; // 剥壳后的语义 argv
  scope: string[]; // 被剥掉但会改变语义的范围参数（-F pkg 等）
  cls: CmdClass;
  mutating: boolean;
  targets: string[];
  scriptPath?: string;
  background: boolean;
  /** 管道尾巴（| tail / grep / tee 等），不参与分类和 normCmd。 */
  tail?: boolean;
}

export interface ShellAnalysis {
  cls: CmdClass;
  mutating: boolean;
  targets: string[];
  /** watch 模式或放后台：不会自己结束。 */
  background: boolean;
  scriptPath?: string;
  normCmd: string;
  segments: SegmentInfo[];
}

// ---------- 剥壳 ----------

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PIPE_TAILS = new Set(["tail", "head", "grep", "egrep", "tee", "cat", "wc", "sort", "uniq", "less", "more", "cut", "tr", "awk", "sed", "xargs", "nl", "column", "jq", "rg"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);
const PY = /^python(\d+(\.\d+)*)?$/;

interface Unwrapped {
  argv: string[];
  scope: string[];
  inner?: string; // sh -c "..." 的内层脚本
  /** 命令自己带了 CI=1/true（决定 vitest 是不是 watch）；看的是命令里的赋值，不是 supervisor 进程的环境。 */
  ci: boolean;
}

const CI_ASSIGN = /^CI=(1|true|yes|on)$/i;

function skipOpts(argv: string[], i: number, withValue: Set<string>): number {
  while (i < argv.length && argv[i].startsWith("-") && argv[i] !== "--") {
    i += withValue.has(argv[i]) ? 2 : 1;
  }
  return i;
}

export function unwrap(input: string[]): Unwrapped {
  let argv = input.slice();
  const scope: string[] = [];
  let ci = false;
  for (let guard = 0; guard < 12 && argv.length; guard++) {
    // 环境变量赋值
    if (ENV_ASSIGN.test(argv[0])) {
      if (CI_ASSIGN.test(argv[0])) ci = true;
      argv = argv.slice(1);
      continue;
    }
    const a = argv[0];
    const base = a.replace(/^.*\//, "");
    if (base === "env") {
      let i = 1;
      while (i < argv.length && (argv[i].startsWith("-") || ENV_ASSIGN.test(argv[i]))) {
        if (CI_ASSIGN.test(argv[i])) ci = true;
        i++;
      }
      argv = argv.slice(i);
      continue;
    }
    if (["time", "nohup", "command", "exec", "builtin", "stdbuf", "ionice", "caffeinate"].includes(base)) {
      argv = argv.slice(skipOpts(argv, 1, new Set(["-o", "-e", "-i", "-c", "-n"])));
      continue;
    }
    if (base === "nice") {
      argv = argv.slice(skipOpts(argv, 1, new Set(["-n"])));
      continue;
    }
    if (base === "timeout" || base === "gtimeout") {
      let i = skipOpts(argv, 1, new Set(["-s", "-k", "--signal", "--kill-after"]));
      if (i < argv.length && /^\d+(\.\d+)?[smhd]?$/.test(argv[i])) i++;
      argv = argv.slice(i);
      continue;
    }
    if (base === "uv" && argv[1] === "run") {
      argv = argv.slice(2 + countRunOpts(argv.slice(2), new Set(["--with", "-p", "--python", "--project", "--directory", "--package", "--with-requirements", "--extra", "--group", "--env-file"])));
      continue;
    }
    if ((base === "poetry" || base === "pipenv" || base === "pdm" || base === "rye" || base === "hatch" || base === "pixi") && argv[1] === "run") {
      argv = argv.slice(2 + countRunOpts(argv.slice(2), new Set()));
      continue;
    }
    if (base === "uvx" || base === "pipx" && argv[1] === "run") {
      argv = argv.slice(base === "uvx" ? 1 : 2);
      argv = argv.slice(countRunOpts(argv, new Set(["--from", "--with", "-p", "--python"])));
      continue;
    }
    if (base === "npx" || base === "bunx") {
      argv = argv.slice(1);
      argv = argv.slice(countRunOpts(argv, new Set(["-p", "--package", "-c", "--call"])));
      continue;
    }
    if ((base === "pnpm" || base === "yarn" || base === "bun") && ["dlx", "x", "exec"].includes(argv[1] ?? "") && base !== "yarn") {
      argv = [argv[0] === "bun" ? "bunx" : "x", ...argv.slice(2)];
      argv = argv.slice(1);
      argv = argv.slice(countRunOpts(argv, new Set()));
      continue;
    }
    if (base === "yarn" && argv[1] === "dlx") {
      argv = argv.slice(2 + countRunOpts(argv.slice(2), new Set()));
      continue;
    }
    // pnpm -F pkg / --filter pkg / -w ；npm -w pkg / --workspace
    if (base === "pnpm" || base === "npm" || base === "yarn") {
      let i = 1;
      let stripped = false;
      const rest: string[] = [argv[0]];
      while (i < argv.length && argv[i].startsWith("-")) {
        const f = argv[i];
        if (f === "-F" || f === "--filter" || f === "-w" || f === "--workspace" || f === "-C" || f === "--dir" || f === "--prefix") {
          scope.push(f, argv[i + 1] ?? "");
          i += 2;
          stripped = true;
        } else if (/^--(filter|workspace|dir|prefix)=/.test(f) || /^-F./.test(f)) {
          scope.push(f);
          i++;
          stripped = true;
        } else if (f === "-r" || f === "--recursive" || f === "--silent" || f === "-s" || f === "--if-present") {
          i++;
          if (f === "-r" || f === "--recursive") scope.push(f);
        } else break;
      }
      if (stripped || i > 1) {
        argv = rest.concat(argv.slice(i));
        // 不 continue：下面还要处理 python -m 等，但这里已经稳定
      }
    }
    // python -m X
    if (PY.test(base) || base === "py") {
      let i = 1;
      while (i < argv.length && argv[i].startsWith("-") && argv[i] !== "-m" && argv[i] !== "-c" && argv[i] !== "-") i++;
      if (argv[i] === "-m" && argv[i + 1]) {
        argv = argv.slice(i + 1);
        continue;
      }
    }
    if (base === "bun" && argv[1] === "x") {
      argv = argv.slice(2);
      continue;
    }
    // sh -c "..."
    if (SHELLS.has(base)) {
      const ci = argv.findIndex((t, idx) => idx > 0 && /^-[a-z]*c[a-z]*$/.test(t));
      if (ci > 0 && argv[ci + 1] !== undefined) return { argv, scope, inner: argv[ci + 1], ci: false };
    }
    break;
  }
  return { argv, scope, ci };
}

function countRunOpts(rest: string[], withValue: Set<string>): number {
  let i = 0;
  while (i < rest.length && rest[i].startsWith("-") && rest[i] !== "--") {
    i += withValue.has(rest[i]) ? 2 : 1;
  }
  return i;
}

// ---------- 命令类别 ----------

const TEST_FILE_EXT = /\.(py|ts|tsx|js|jsx|mjs|cjs|go|rs|rb|java|kt|php|exs?|cs|swift|c|cc|cpp)$/;
const BROAD_DIRS = new Set([".", "./", "tests", "test", "tests/", "test/", "src", "spec", "specs", "__tests__", "src/", "spec/", "e2e"]);

/** 位置参数是否「具体」：文件、::name、:line，或两层以上路径。 */
function isSpecificPath(p: string): boolean {
  if (p.includes("::")) return true;
  if (/:\d+$/.test(p) && !p.startsWith("-")) return true;
  if (TEST_FILE_EXT.test(p)) return true;
  if (BROAD_DIRS.has(p)) return false;
  const segs = p.replace(/\/+$/, "").split("/").filter((s) => s && s !== "." && s !== "..");
  return segs.length >= 2;
}

function positionals(args: string[], withValue: Set<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      out.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("-")) {
      if (withValue.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

const hasAny = (args: string[], names: string[]) =>
  args.some((a) => names.some((n) => a === n || a.startsWith(n + "=")));

type TestKind = "full" | "targeted" | "watch";

function pytestKind(args: string[]): TestKind {
  if (hasAny(args, ["-k", "-m", "--lf", "--last-failed", "--ff", "--sw", "--stepwise", "--deselect", "--testmon", "--picked"])) return "targeted";
  const pos = positionals(args, new Set(["-c", "-p", "-o", "-n", "-W", "-r", "--rootdir", "--tb", "--maxfail", "--ignore", "--ignore-glob", "--durations", "--junitxml", "--color", "-x", "-q", "-v"].filter((x) => !["-x", "-q", "-v"].includes(x))));
  return pos.some(isSpecificPath) ? "targeted" : "full";
}

function genericFilterKind(args: string[], valueFlags: string[]): "full" | "targeted" {
  if (hasAny(args, ["-t", "--testNamePattern", "--test-name-pattern", "--grep", "-g", "--filter", "--testPathPattern", "--findRelatedTests", "--onlyChanged", "-o", "--changed", "--related", "--lf", "-run", "--run-name", "--only"])) return "targeted";
  const pos = positionals(args, new Set(valueFlags));
  return pos.length > 0 ? "targeted" : "full";
}

function isWatchFlag(args: string[]): boolean {
  for (const a of args) {
    if (a === "--watch=false" || a === "--watchAll=false" || a === "--run" || a === "--no-watch") return false;
  }
  return args.some((a) => a === "--watch" || a === "--watchAll" || a === "-w" || a === "--watch=true" || a === "--watchAll=true" || a === "--watchman");
}

function scriptKind(name: string): CmdClass | "watch" | "dev" | null {
  const n = name.toLowerCase();
  if (/(^|[:_-])(watch|dev)$/.test(n) && /test|spec|jest|vitest/.test(n)) return "watch";
  if (/^test([:_-].*)?$/.test(n) || /^(unit|e2e|spec|specs|jest|vitest|pytest|integration)([:_-].*)?$/.test(n)) {
    if (/(watch)/.test(n)) return "watch";
    return "test_full";
  }
  if (/^(lint|eslint|prettier|format|fmt|check-format|style)([:_-].*)?$/.test(n)) return "lint";
  if (/^(typecheck|type-check|types|tsc|check-types|tscheck)([:_-].*)?$/.test(n)) return "typecheck";
  if (/^(check)([:_-].*)?$/.test(n)) return "lint";
  if (/^(build|compile|bundle|package|dist|prepare|prepublish)([:_-].*)?$/.test(n)) return "build";
  if (/^(dev|start|serve|watch|preview|storybook)([:_-].*)?$/.test(n)) return "dev";
  return null;
}

const NODE_PM = new Set(["npm", "pnpm", "yarn", "bun"]);
const NODE_PM_RESERVED = new Set(["install", "i", "add", "remove", "rm", "uninstall", "update", "up", "upgrade", "ci", "link", "unlink", "dedupe", "prune", "init", "publish", "pack", "audit", "outdated", "ls", "list", "why", "config", "cache", "login", "whoami", "version", "view", "info", "exec", "x", "create", "dlx", "pm", "patch", "rebuild", "store", "env", "help", "root", "bin", "fund", "doctor"]);

interface Classified {
  cls: CmdClass;
  mutating?: boolean;
  background?: boolean;
  scriptPath?: string;
  targets?: string[];
}

const PROBE_BENIGN_PY = new Set(["json", "os", "sys", "re", "pathlib", "math", "time", "datetime", "collections", "itertools", "functools", "typing", "platform", "shutil", "subprocess", "random", "string", "base64", "hashlib", "urllib", "textwrap", "inspect", "importlib", "yaml", "toml", "tomllib", "requests", "numpy", "pandas", "uuid", "glob", "argparse", "pprint", "dataclasses", "enum", "io", "csv", "sqlite3", "socket", "ast", "site", "sysconfig", "pkg_resources", "importlib.metadata", "locale", "zoneinfo", "decimal", "fractions", "copy", "struct", "operator", "contextlib", "traceback", "warnings", "logging", "secrets", "tempfile", "getpass", "signal", "threading", "multiprocessing", "asyncio"]);

const WRITE_PY = /\bopen\([^)]*['"][wax]\+?b?['"]|\.write_text\(|\.write_bytes\(|shutil\.(copy|copytree|move|rmtree)|os\.(remove|unlink|rename|makedirs|mkdir|rmdir|replace)\b|\.unlink\(|\.mkdir\(|json\.dump\(/;
const WRITE_JS = /\b(writeFile|writeFileSync|appendFile|appendFileSync|rmSync|rm|unlinkSync|mkdirSync|renameSync|copyFileSync|Bun\.write)\b\s*\(/;

/** code 是否包含「导入项目包 / 相对 require / assert」。 */
export function isProbeCode(code: string, lang: "py" | "js"): boolean {
  if (lang === "py") {
    if (/\bassert\b/.test(code)) return true;
    const mods: string[] = [];
    for (const m of code.matchAll(/^\s*(?:;|\s)*from\s+([A-Za-z_.][\w.]*)\s+import\b/gm)) mods.push(m[1]);
    for (const m of code.matchAll(/(?:^|[;\s])from\s+([A-Za-z_.][\w.]*)\s+import\b/g)) mods.push(m[1]);
    for (const m of code.matchAll(/(?:^|[;\s])import\s+([A-Za-z_][\w.]*(?:\s*,\s*[A-Za-z_][\w.]*)*)/g)) {
      for (const part of m[1].split(",")) mods.push(part.trim());
    }
    return mods.some((m) => m.startsWith(".") || !PROBE_BENIGN_PY.has(m.split(".")[0]) || m.split(".")[0] === "src" || m.split(".")[0] === "app");
  }
  if (/\bassert\b/.test(code)) return true;
  if (/\b(?:require|import)\s*\(\s*['"]\.{1,2}\//.test(code)) return true;
  if (/\bfrom\s+['"]\.{1,2}\//.test(code)) return true;
  if (/\bimport\s+['"]\.{1,2}\//.test(code)) return true;
  return false;
}

function classifyProbe(argv: string[], heredoc: string | undefined): Classified | null {
  const base = argv[0].replace(/^.*\//, "");
  let code: string | undefined;
  let lang: "py" | "js" | undefined;
  if (PY.test(base) || base === "py") {
    lang = "py";
    const ci = argv.indexOf("-c");
    if (ci > 0) code = argv[ci + 1] ?? "";
    else if (argv.includes("-") && heredoc !== undefined) code = heredoc;
    else if (argv.length === 1 && heredoc !== undefined) code = heredoc;
  } else if (base === "node" || base === "bun" || base === "deno" || base === "ruby" || base === "nodejs") {
    lang = "js";
    const ei = argv.findIndex((t, i) => i > 0 && /^(-e|-p|--eval|--print|-pe|-ep)$/.test(t));
    if (base === "deno" && argv[1] === "eval") code = argv[2] ?? "";
    else if (ei > 0) code = argv[ei + 1] ?? "";
    else if (argv.includes("-") && heredoc !== undefined) code = heredoc;
    if (base === "ruby") {
      if (ei > 0) code = argv[ei + 1] ?? "";
    }
  }
  if (code === undefined || !lang) return null;
  const writes = lang === "py" ? WRITE_PY.test(code) : WRITE_JS.test(code);
  if (writes) return { cls: "other", mutating: true };
  const probe = base === "ruby" ? /\brequire(_relative)?\b/.test(code) : isProbeCode(code, lang);
  return { cls: probe ? "probe" : "other" };
}

const SMOKE_NAME = /(^|\/)(smoke[^/]*|check_[^/]*|verify[^/]*|try_[^/]*|test_smoke[^/]*)\.[a-z]+$/;
function isSmokeName(p: string): boolean {
  return SMOKE_NAME.test(p) || /^\/tmp\/[^/]+\.(py|js|ts|sh|mjs)$/.test(p) || /(^|\/)scripts\/try_[^/]*$/.test(p);
}

function scriptOf(argv: string[]): string | undefined {
  const base = argv[0].replace(/^.*\//, "");
  const isRunner = PY.test(base) || ["python", "node", "bun", "deno", "tsx", "ts-node", "bash", "sh", "zsh", "ruby", "perl", "php", "go"].includes(base);
  if (isRunner) {
    const start = base === "deno" || base === "bun" || base === "go" ? (["run"].includes(argv[1] ?? "") ? 2 : 1) : 1;
    for (let i = start; i < argv.length; i++) {
      const t = argv[i];
      if (t.startsWith("-")) continue;
      if (/\.(py|js|mjs|cjs|ts|tsx|sh|rb|pl|php|go)$/.test(t)) return t;
      return undefined;
    }
    return undefined;
  }
  if (/^(\.\/|\/|scripts\/)/.test(argv[0]) && /\.(py|js|mjs|ts|sh|rb)$/.test(argv[0])) return argv[0];
  return undefined;
}

const LOCALHOST = /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i;

function classifyHttp(argv: string[]): boolean {
  const base = argv[0].replace(/^.*\//, "");
  if (!["curl", "wget", "http", "https", "xh", "httpie", "hurl"].includes(base)) return false;
  return argv.slice(1).some((t) => LOCALHOST.test(t.replace(/^['"]|['"]$/g, "")) || /^:\d{2,5}(\/|$)/.test(t));
}

/** 单段 argv（已剥壳）分类。 */
function classifyArgv(argv: string[], opts: ClassifyOptions, seg: Segment | undefined, scoped: boolean, rawJoined: string, ci = false): Classified {
  if (argv.length === 0) return { cls: "other" };
  const a0 = argv[0];
  const base = a0.replace(/^.*\//, "");
  const args = argv.slice(1);

  // 项目配置覆盖
  for (const f of opts.testFast ?? []) if (rawJoined === f || rawJoined.startsWith(f + " ")) return { cls: "test_targeted" };
  for (const f of opts.testFull ?? []) if (rawJoined === f || rawJoined.startsWith(f + " ")) return { cls: "test_full" };
  for (const p of opts.extraPatterns ?? []) {
    try {
      if (new RegExp(p).test(rawJoined)) return { cls: "test_full" };
    } catch {
      /* 非法正则忽略 */
    }
  }

  // probe / 内联代码
  const probe = classifyProbe(argv, seg?.heredoc);
  if (probe) return probe;

  // http_smoke
  if (classifyHttp(argv)) {
    const out = args.some((t, i) => (t === "-o" || t === "--output" || t === "-O" || t === "--remote-name") && args[i + 1] !== "/dev/null");
    return { cls: "http_smoke", mutating: out };
  }

  const testKind = (k: TestKind): Classified => ({ cls: k === "full" ? "test_full" : k === "targeted" ? "test_targeted" : "test_watch", background: k === "watch" });

  // ---- 各测试运行器 ----
  if (base === "pytest" || base === "py.test") {
    const k = pytestKind(args);
    return testKind(scoped && k === "full" ? "targeted" : k);
  }
  if (base === "tox" || base === "nox") return testKind(hasAny(args, ["-e", "-s", "--session"]) ? "targeted" : "full");
  if (base === "unittest" || (base === "trial")) return testKind(positionals(args, new Set()).length ? "targeted" : "full");
  if (base === "vitest") {
    if (args[0] === "bench" || args[0] === "typecheck") return { cls: "other" };
    const wantsRun = args[0] === "run" || args.includes("--run") || args.includes("--watch=false");
    if (!wantsRun && !ci && !args.includes("--no-watch")) return testKind("watch");
    const rest = args[0] === "run" ? args.slice(1) : args;
    const k = genericFilterKind(rest, ["-c", "--config", "--root", "-r", "--reporter", "--outputFile", "--project", "--shard", "--environment", "--pool", "-t", "--testNamePattern"]);
    return testKind(scoped && k === "full" ? "targeted" : k);
  }
  if (base === "jest") {
    if (isWatchFlag(args)) return testKind("watch");
    const k = genericFilterKind(args, ["-c", "--config", "--maxWorkers", "-w", "--testTimeout", "--reporters", "--shard", "--rootDir", "--projects", "--testEnvironment", "-t"]);
    return testKind(scoped && k === "full" ? "targeted" : k);
  }
  if (base === "mocha" || base === "ava" || base === "tap" || base === "playwright" || base === "cypress") {
    if (base === "playwright" && args[0] !== "test") return { cls: "other" };
    if (base === "cypress" && args[0] !== "run") return { cls: "other" };
    if (isWatchFlag(args)) return testKind("watch");
    const rest = base === "playwright" || base === "cypress" ? args.slice(1) : args;
    return testKind(genericFilterKind(rest, ["--config", "-c", "--reporter", "-r", "--project", "--timeout", "--workers", "-j"]));
  }
  if (base === "bun" && args[0] === "test") {
    if (isWatchFlag(args.slice(1))) return testKind("watch");
    return testKind(genericFilterKind(args.slice(1), ["--timeout", "--preload", "--rerun-each", "--bail", "--coverage-reporter", "--reporter"]));
  }
  if (base === "deno" && args[0] === "test") {
    if (isWatchFlag(args.slice(1))) return testKind("watch");
    return testKind(genericFilterKind(args.slice(1), ["--reporter", "--parallel", "--coverage", "-c", "--config"]));
  }
  if (base === "go") {
    const sub = args[0];
    if (sub === "test") {
      const rest = args.slice(1);
      if (hasAny(rest, ["-run", "-bench"])) return testKind("targeted");
      const pk = positionals(rest, new Set(["-count", "-timeout", "-p", "-parallel", "-tags", "-cpu", "-coverprofile", "-covermode", "-short", "-run", "-bench", "-o", "-exec", "-vet", "-skip", "-shuffle", "-mod"]).add("-count"));
      if (pk.some((p) => p === "./..." || p === "..." || p.endsWith("/..."))) {
        return testKind(pk.some((p) => p === "./..." || p === "...") ? "full" : "targeted");
      }
      return testKind("targeted");
    }
    if (sub === "vet") return { cls: "lint" };
    if (sub === "build" || sub === "install") return { cls: "build", mutating: true };
    if (sub === "get" || sub === "mod" || sub === "generate" || sub === "work") return { cls: "other", mutating: sub !== "work" ? !(sub === "mod" && ["why", "graph", "verify", "edit -json"].includes(args[1] ?? "")) : false };
    if (sub === "run") return { cls: "other", scriptPath: scriptOf(argv) };
    return { cls: "other" };
  }
  if (base === "cargo" || base === "cargo-nextest") {
    let sub = args[0] ?? "";
    let rest = args.slice(1);
    if (base === "cargo" && sub.startsWith("+")) {
      sub = args[1] ?? "";
      rest = args.slice(2);
    }
    if (sub === "nextest") {
      sub = "test";
      rest = rest.slice(1);
    }
    if (base === "cargo-nextest") sub = "test";
    if (sub === "test" || sub === "t") {
      if (hasAny(rest, ["-p", "--package", "--test", "--lib", "--bin", "--doc", "--example", "--bench"])) return testKind("targeted");
      if (hasAny(rest, ["--workspace", "--all"])) return testKind("full");
      const pk = positionals(rest.slice(0, rest.indexOf("--") < 0 ? rest.length : rest.indexOf("--")), new Set(["-j", "--jobs", "--target", "--features", "-F", "--manifest-path", "--profile", "--color", "--message-format"]));
      const afterDash = rest.indexOf("--") >= 0 ? rest.slice(rest.indexOf("--") + 1).filter((t) => !t.startsWith("-")) : [];
      return testKind(pk.length || afterDash.length ? "targeted" : "full");
    }
    if (sub === "check" || sub === "c") return { cls: "typecheck" };
    if (sub === "clippy") return { cls: "lint" };
    if (sub === "fmt") return { cls: "lint", mutating: !hasAny(rest, ["--check"]) };
    if (sub === "build" || sub === "b" || sub === "doc" || sub === "bench") return { cls: "build", mutating: true };
    if (sub === "run" || sub === "r") return { cls: "other" };
    if (["add", "remove", "install", "update", "fix", "generate-lockfile", "new", "init", "vendor", "clean", "publish"].includes(sub)) return { cls: "other", mutating: true };
    return { cls: "other" };
  }
  if (base === "make" || base === "gmake" || base === "just" || base === "task" || base === "mage" || base === "ninja") {
    const pos = positionals(args, new Set(["-C", "-f", "-j", "--file", "--directory", "-I", "--jobs"]));
    const vars = pos.filter((p) => /^[A-Za-z_]+=/.test(p));
    const targets = pos.filter((p) => !/^[A-Za-z_]+=/.test(p));
    if (targets.length === 0) return { cls: base === "just" || base === "task" ? "other" : "build", mutating: base === "make" || base === "gmake" };
    for (const t of targets) {
      const sk = scriptKind(t);
      if (sk === "test_full") {
        if (/(fast|quick|single|one|file|focus)/.test(t) || vars.some((v) => /^(TEST|TESTS|FILE|K|PATTERN|ARGS|RUN|PKG|T|SPEC)=/i.test(v))) return { cls: "test_targeted" };
        return { cls: "test_full" };
      }
      if (sk === "watch") return { cls: "test_watch", background: true };
      if (sk === "lint" || sk === "typecheck") return { cls: sk };
      if (sk === "build") return { cls: "build", mutating: true };
    }
    return { cls: "other", mutating: /\b(install|clean|migrate|deploy|generate|codegen|setup|bootstrap|docker|release|publish)\b/.test(targets.join(" ")) };
  }
  if (["gradle", "gradlew", "mvn", "mvnw", "dotnet", "rspec", "phpunit", "ctest", "swift", "mix", "bundle", "rake", "sbt", "bazel", "mill"].includes(base)) {
    const sub = args.filter((t) => !t.startsWith("-"))[0] ?? "";
    if (base === "rspec") return testKind(positionals(args, new Set(["-e", "--example", "-t", "--tag", "-r", "--require"])).some((p) => /:\d+$|_spec\.rb$/.test(p)) || hasAny(args, ["-e", "--example", "-t", "--tag"]) ? "targeted" : "full");
    if (base === "phpunit") return testKind(positionals(args, new Set(["-c", "--filter"])).length || hasAny(args, ["--filter"]) ? "targeted" : "full");
    if (base === "ctest") return testKind(hasAny(args, ["-R", "-I", "--tests-regex"]) ? "targeted" : "full");
    if ((base === "gradle" || base === "gradlew") && /^(test|check|:.*:test|.*:test)$/.test(sub)) return testKind(hasAny(args, ["--tests"]) || sub.includes(":") ? "targeted" : "full");
    if ((base === "mvn" || base === "mvnw") && /^(test|verify)$/.test(sub)) return testKind(hasAny(args, ["-Dtest", "-pl", "--projects"]) || args.some((t) => t.startsWith("-Dtest=")) ? "targeted" : "full");
    if (base === "dotnet" && sub === "test") return testKind(hasAny(args, ["--filter"]) || positionals(args.slice(args.indexOf("test") + 1), new Set(["--filter", "-c", "--configuration", "-f", "--framework", "--logger"])).length ? "targeted" : "full");
    if (base === "mix" && sub === "test") return testKind(positionals(args.slice(args.indexOf("test") + 1), new Set()).length ? "targeted" : "full");
    if (base === "swift" && sub === "test") return testKind(hasAny(args, ["--filter"]) ? "targeted" : "full");
    if (base === "bazel" && sub === "test") return testKind(args.filter((t) => !t.startsWith("-")).length > 1 && !args.includes("//...") ? "targeted" : "full");
    if (base === "sbt" && sub === "test") return testKind("full");
    if (["gradle", "gradlew", "mvn", "mvnw", "dotnet", "sbt", "bazel", "mill"].includes(base) && /^(build|assemble|compile|package|install|jar|classes|publish)$/.test(sub)) return { cls: "build", mutating: true };
    if (base === "bundle" && ["install", "update", "add", "remove", "lock"].includes(sub)) return { cls: "other", mutating: true };
    if (base === "bundle" && sub === "exec") {
      return classifyArgv(args.slice(args.indexOf("exec") + 1), opts, seg, scoped, rawJoined, ci);
    }
    if (base === "rake" && /^test/.test(sub)) return testKind("full");
    if (base === "rake" && /db:/.test(sub)) return { cls: "other", mutating: true };
    if (base === "swift" && sub === "build") return { cls: "build", mutating: true };
    return { cls: "other" };
  }

  // ---- 包管理器脚本 ----
  if (NODE_PM.has(base)) {
    let sub = args[0] ?? "";
    let rest = args.slice(1);
    // npm run <script> / yarn run / pnpm run / bun run
    let script: string | undefined;
    if (sub === "run" || sub === "run-script" || sub === "rum" || sub === "urn") {
      script = rest[0];
      rest = rest.slice(1);
    } else if (sub === "t" || sub === "tst") {
      script = "test";
    } else if (sub === "test") {
      script = "test";
    } else if (!NODE_PM_RESERVED.has(sub) && sub && !sub.startsWith("-") && (base === "yarn" || base === "pnpm" || base === "bun") && !/[\\/.]/.test(sub)) {
      // yarn <script> / pnpm <script> / bun <script>
      script = sub;
    }
    if (script !== undefined) {
      const dd = rest.indexOf("--");
      const pass = dd >= 0 ? rest.slice(dd + 1) : base === "npm" ? [] : rest;
      const sk = scriptKind(script);
      if (sk === "watch" || (sk === "test_full" && isWatchFlag(pass))) return { cls: "test_watch", background: true };
      if (sk === "test_full") {
        const passKind = genericFilterKind(pass, ["--timeout", "-c", "--config", "--reporter", "--project", "--maxWorkers", "-w"]);
        if (passKind === "targeted" || scoped || script.toLowerCase().match(/fast|quick|single|focus/)) return { cls: "test_targeted" };
        return { cls: "test_full" };
      }
      if (sk === "lint" || sk === "typecheck") return { cls: sk };
      if (sk === "build") return { cls: "build", mutating: true };
      if (sk === "dev") return { cls: "other", background: true };
      const mut = /(migrate|^db[:_-]|seed|generate|codegen|install|clean|setup|bootstrap|release|deploy|publish|prisma|drizzle|format|fix)/i.test(script);
      return { cls: "other", mutating: mut };
    }
    if (["install", "i", "add", "remove", "rm", "uninstall", "update", "up", "upgrade", "ci", "link", "unlink", "dedupe", "prune", "rebuild", "patch", "create", "init", "publish"].includes(sub)) {
      return { cls: "other", mutating: true };
    }
    if (sub === "x" || sub === "exec") return classifyArgv(rest, opts, seg, scoped, rest.join(" "), ci);
    return { cls: "other" };
  }

  // ---- lint / typecheck / build 工具 ----
  const LINT = new Set(["eslint", "flake8", "pylint", "ruff", "biome", "golangci-lint", "shellcheck", "stylelint", "rubocop", "pyflakes", "black", "isort", "prettier", "clippy-driver", "oxlint", "tflint", "hadolint", "markdownlint", "yamllint", "swiftlint", "ktlint", "gofmt", "gofumpt", "taplo", "dprint", "deno-lint"]);
  if (LINT.has(base) || (base === "deno" && (args[0] === "lint" || args[0] === "fmt"))) {
    let mut = false;
    if (base === "prettier") mut = hasAny(args, ["--write", "-w"]);
    else if (base === "black" || base === "isort") mut = !hasAny(args, ["--check", "--diff"]);
    else if (base === "eslint") mut = hasAny(args, ["--fix"]);
    else if (base === "ruff") mut = hasAny(args, ["--fix"]) || (args[0] === "format" && !hasAny(args, ["--check", "--diff"]));
    else if (base === "biome") mut = hasAny(args, ["--write", "--apply", "--fix"]) || (args[0] === "format" && hasAny(args, ["--write"]));
    else if (base === "gofmt" || base === "gofumpt") mut = hasAny(args, ["-w"]);
    else if (base === "rubocop") mut = hasAny(args, ["-a", "-A", "--auto-correct", "--autocorrect", "--auto-correct-all"]);
    else if (base === "deno") mut = args[0] === "fmt" && !hasAny(args, ["--check"]);
    else if (base === "golangci-lint") mut = hasAny(args, ["--fix"]);
    return { cls: "lint", mutating: mut };
  }
  if (["tsc", "mypy", "pyright", "basedpyright", "vue-tsc", "svelte-check", "flow", "pytype", "ty", "pyre"].includes(base)) {
    if (base === "tsc" || base === "vue-tsc") {
      if (hasAny(args, ["--watch", "-w"])) return { cls: "other", background: true };
      if (hasAny(args, ["--noEmit"]) || args.includes("--build") === false && false) return { cls: "typecheck" };
      if (hasAny(args, ["-b", "--build"])) return { cls: "build", mutating: true };
      return { cls: "build", mutating: true };
    }
    return { cls: "typecheck" };
  }
  if (["vite", "next", "webpack", "rollup", "esbuild", "parcel", "turbo", "nx", "tsup", "swc", "babel", "gatsby", "nuxt", "astro", "remix", "svelte-kit", "ng", "cmake", "zig"].includes(base)) {
    const sub = args[0] ?? "";
    if (base === "vite" || base === "next" || base === "nuxt" || base === "astro" || base === "gatsby" || base === "remix" || base === "ng") {
      if (sub === "build" || sub === "generate") return { cls: "build", mutating: true };
      if (sub === "test" && base === "ng") return testKind(hasAny(args, ["--include"]) ? "targeted" : "full");
      if (sub === "lint" && (base === "ng" || base === "next")) return { cls: "lint" };
      if (sub === "preview" || sub === "dev" || sub === "start" || sub === "serve" || sub === "" ) return { cls: "other", background: true };
      return { cls: "other" };
    }
    if (base === "turbo" || base === "nx") {
      const task = (sub === "run" ? args[1] : sub) ?? "";
      const t = task.replace(/^.*:/, "");
      const sk = scriptKind(t);
      if (sk === "test_full") return { cls: hasAny(args, ["--filter", "--projects", "-p"]) ? "test_targeted" : "test_full" };
      if (sk === "lint" || sk === "typecheck") return { cls: sk };
      if (sk === "build") return { cls: "build", mutating: true };
      return { cls: "other" };
    }
    if (base === "cmake") return { cls: args.includes("--build") ? "build" : "other", mutating: true };
    if (base === "zig") return sub === "test" ? testKind("full") : sub === "build" ? { cls: "build", mutating: true } : { cls: "other" };
    return { cls: "build", mutating: true };
  }
  if (base === "docker" || base === "docker-compose" || base === "podman" || base === "nerdctl") {
    const sub = args.filter((t) => !t.startsWith("-"))[0] ?? "";
    const ro = ["ps", "logs", "images", "inspect", "version", "info", "stats", "top", "port", "ls", "diff", "history", "events", "search"];
    return { cls: sub === "build" ? "build" : "other", mutating: !ro.includes(sub), background: sub === "compose" && args.includes("up") && !args.includes("-d") };
  }
  if (base === "kubectl" || base === "helm" || base === "terraform" || base === "ansible-playbook") {
    const sub = args[0] ?? "";
    return { cls: "other", mutating: ["apply", "delete", "create", "patch", "replace", "scale", "rollout", "install", "upgrade", "uninstall", "destroy", "taint", "import", "edit", "label", "annotate", "cordon", "drain"].includes(sub) || base === "ansible-playbook" };
  }
  if (["alembic", "prisma", "drizzle-kit", "knex", "sequelize", "sqlx", "diesel", "typeorm", "flyway", "liquibase", "atlas", "dbmate", "goose", "migrate"].includes(base)) {
    return { cls: "other", mutating: /\b(migrate|upgrade|downgrade|push|generate|up|down|reset|deploy|apply|revert)\b/.test(args.join(" ")) };
  }
  if (/^(manage\.py|django-admin)$/.test(base) || (PY.test(base) && /manage\.py$/.test(args[0] ?? ""))) {
    return { cls: "other", mutating: /\b(migrate|makemigrations|loaddata|flush|collectstatic|startapp|startproject)\b/.test(args.join(" ")) };
  }
  if (base === "make") return { cls: "build", mutating: true };

  // ---- 脚本 ----
  const script = scriptOf(argv);
  if (script) {
    const created = opts.newScripts?.has(script) || opts.newScripts?.has(script.replace(/^\.\//, ""));
    if (created && isSmokeName(script)) {
      return { cls: opts.sourceEdited ? "smoke_script" : "repro_script", scriptPath: script };
    }
    if (created && !opts.sourceEdited) return { cls: "repro_script", scriptPath: script };
    return { cls: "other", scriptPath: script };
  }
  return { cls: "other" };
}

// ---------- 写入 / mutating 识别 ----------

const GIT_READONLY = new Set(["status", "diff", "log", "show", "branch", "rev-parse", "ls-files", "ls-tree", "blame", "grep", "describe", "remote", "config", "fetch", "cat-file", "shortlog", "reflog", "tag", "rev-list", "name-rev", "merge-base", "ls-remote", "whatchanged", "help", "version", "diff-tree", "diff-index", "for-each-ref", "count-objects", "check-ignore", "var", "show-ref", "show-branch", "difftool", "archive", "bisect"]);
const GIT_READONLY_SUB: Record<string, (rest: string[]) => boolean> = {
  branch: (r) => !r.some((t) => /^(-d|-D|-m|-M|-c|-C|--delete|--move|--copy|--set-upstream-to|-u|--unset-upstream)$/.test(t)) && !r.some((t) => !t.startsWith("-")),
  tag: (r) => !r.some((t) => /^(-d|--delete|-a|-s|-f|-m)$/.test(t)) && r.filter((t) => !t.startsWith("-")).length === 0,
  remote: (r) => r.length === 0 || ["-v", "show", "get-url"].includes(r[0]),
  config: (r) => r.some((t) => /^(--get|--get-all|--list|-l|--get-regexp)$/.test(t)),
  stash: (r) => ["list", "show"].includes(r[0] ?? ""),
  bisect: () => false,
  archive: (r) => r.some((t) => t === "-o" || t === "--output") === false,
};

const NOT_FS_PATH = (t: string) => t === "/dev/null" || t === "/dev/stdout" || t === "/dev/stderr" || t === "/dev/tty" || t === "";
const isTmpPath = (p: string) => /^(\/tmp\/|\/private\/tmp\/|\/var\/folders\/|\$TMPDIR|\/dev\/)/.test(p) || p === "/tmp";

function fileArgs(cmd: string, args: string[]): string[] {
  const pos = args.filter((t, i) => !t.startsWith("-") && !(args[i - 1] === "-t" || args[i - 1] === "-S"));
  switch (cmd) {
    case "chmod":
    case "chown":
    case "chgrp":
      return pos.slice(1);
    case "sed":
    case "perl":
      return pos.slice(args.includes("-e") ? 0 : 1);
    case "cp":
    case "mv":
    case "ln":
    case "install":
    case "rsync":
      return pos.slice(-1);
    case "dd":
      return args.filter((t) => t.startsWith("of=")).map((t) => t.slice(3));
    case "patch":
      return pos.slice(0, 1);
    default:
      return pos;
  }
}

/** 返回此段是否会改动工作区（保守）及写入目标。 */
function segmentMutation(argv: string[], seg: Segment | undefined, cls: Classified): { mutating: boolean; targets: string[] } {
  const targets: string[] = [];
  let mutating = cls.mutating ?? false;
  if (cls.targets) targets.push(...cls.targets);
  // 重定向
  for (const r of seg?.redirects ?? []) {
    if (r.op === "<") continue;
    if (NOT_FS_PATH(r.target) || /^&\d?$/.test(r.target)) continue;
    targets.push(r.target);
    if (!isTmpPath(r.target)) mutating = true;
  }
  if (argv.length === 0) return { mutating, targets };
  const base = argv[0].replace(/^.*\//, "");
  const args = argv.slice(1);
  const mark = (files: string[]) => {
    for (const f of files) {
      if (NOT_FS_PATH(f)) continue;
      targets.push(f);
      if (!isTmpPath(f)) mutating = true;
    }
    if (files.length === 0) mutating = true;
  };
  switch (base) {
    case "sed":
      if (args.some((t) => /^-[a-zA-Z]*i/.test(t) || t.startsWith("--in-place"))) mark(fileArgs("sed", args));
      break;
    case "perl":
      if (args.some((t) => /^-[a-zA-Z]*i/.test(t))) mark(fileArgs("perl", args));
      break;
    case "tee":
      mark(args.filter((t) => !t.startsWith("-")));
      if (args.filter((t) => !t.startsWith("-")).length === 0) mutating = cls.mutating ?? false;
      break;
    case "rm": case "rmdir": case "unlink": case "mkdir": case "touch": case "truncate": case "shred": case "chmod": case "chown": case "chgrp":
    case "mv": case "cp": case "ln": case "install": case "rsync": case "patch": case "ditto": case "unzip": case "gunzip": case "mkfifo": case "trash":
      mark(fileArgs(base, args));
      break;
    case "dd":
      if (args.some((t) => t.startsWith("of="))) mark(fileArgs("dd", args));
      break;
    case "tar":
      if (args.some((t) => /^-?[a-zA-Z]*x/.test(t) && !t.startsWith("--")) || args.includes("--extract")) mutating = true;
      if (args.some((t) => /^-?[a-zA-Z]*c[a-zA-Z]*f?$/.test(t))) mutating = true;
      break;
    case "find":
      if (args.includes("-delete") || args.includes("-exec") || args.includes("-execdir") || args.includes("-ok")) mutating = true;
      break;
    case "wget":
      if (!args.some((t) => /^-[a-zA-Z]*O-?$/.test(t) && false) && !(args.includes("-O") && args[args.indexOf("-O") + 1] === "-") && !args.includes("-qO-") && !args.includes("--spider")) mutating = true;
      break;
    case "curl":
      if (args.some((t, i) => (t === "-o" || t === "--output") && !NOT_FS_PATH(args[i + 1] ?? "") ) || args.includes("-O") || args.includes("--remote-name")) mutating = true;
      break;
    case "git": {
      const sub = args.filter((t) => !t.startsWith("-"))[0] ?? "";
      const si = args.indexOf(sub);
      const rest = si >= 0 ? args.slice(si + 1) : [];
      if (!sub) break;
      if (sub === "stash") {
        if (!GIT_READONLY_SUB.stash(rest)) mutating = true;
      } else if (GIT_READONLY.has(sub)) {
        const f = GIT_READONLY_SUB[sub];
        if (f && !f(rest)) mutating = true;
        if (sub === "bisect" || sub === "fetch" && false) mutating = true;
      } else mutating = true;
      break;
    }
    case "pip": case "pip3": case "pipx":
      if (/^(install|uninstall|download)$/.test(args[0] ?? "")) mutating = true;
      break;
    case "uv":
      if (/^(sync|add|remove|lock|venv|install|init|build|publish|tool)$/.test(args[0] ?? "") || (args[0] === "pip" && /^(install|uninstall|sync|compile)$/.test(args[1] ?? ""))) mutating = true;
      break;
    case "poetry": case "pdm": case "rye": case "pipenv": case "conda": case "mamba": case "micromamba":
      if (/^(add|install|remove|update|lock|sync|init|env|create|uninstall|upgrade)$/.test(args[0] ?? "")) mutating = true;
      break;
    case "brew": case "apt": case "apt-get": case "yum": case "dnf": case "pacman": case "apk": case "port": case "nix": case "nix-env": case "snap": case "choco": case "scoop": case "winget":
      if (/^(install|remove|uninstall|upgrade|update|autoremove|-S|-R|add|del|reinstall|tap|untap|link|unlink|-s)/.test(args[0] ?? "")) mutating = true;
      break;
    case "gem": case "composer": case "conda-lock": case "cpan": case "cpanm": case "luarocks": case "nuget": case "pod":
      if (/^(install|update|uninstall|require|remove|add|upgrade)$/.test(args[0] ?? "")) mutating = true;
      break;
    case "asdf": case "nvm": case "fnm": case "volta": case "pyenv": case "rbenv": case "mise": case "rustup": case "sdk":
      if (/^(install|use|uninstall|global|local|update|default|plugin|pin|set|toolchain|component|target)/.test(args[0] ?? "")) mutating = true;
      break;
    case "sudo": case "su":
      mutating = true;
      break;
    case "go":
      if (/^(get|install|generate)$/.test(args[0] ?? "") || (args[0] === "mod" && /^(tidy|download|vendor|init|edit)$/.test(args[1] ?? ""))) mutating = true;
      break;
    case "npm": case "pnpm": case "yarn": case "bun": case "npx": case "bunx": case "cargo": case "deno": case "dotnet":
      break;
    case "launchctl": case "systemctl": case "service": case "crontab": case "defaults": case "scutil": case "networksetup":
      mutating = true;
      break;
    case "xargs": {
      const inner = args.filter((t) => !t.startsWith("-"));
      if (inner.length) {
        const r = segmentMutation(inner, undefined, { cls: "other" });
        if (r.mutating) {
          mutating = true;
          targets.push(...r.targets);
        }
      }
      break;
    }
    default:
      break;
  }
  // 数据库迁移 / 内联脚本写文件的兜底
  const joined = argv.join(" ");
  if (/\b(migrate|makemigrations|db:(migrate|reset|seed|setup|drop|create)|alembic\s+(upgrade|downgrade)|prisma\s+(migrate|db\s+push))\b/.test(joined)) mutating = true;
  return { mutating, targets: [...new Set(targets)] };
}

// ---------- 对外入口 ----------

const PRIORITY: CmdClass[] = ["test_watch", "test_full", "test_targeted", "repro_script", "smoke_script", "probe", "http_smoke", "build", "typecheck", "lint", "other"];

function analyzeSegments(segs: Segment[], opts: ClassifyOptions, depth: number, out: SegmentInfo[]): void {
  for (let idx = 0; idx < segs.length; idx++) {
    const seg = segs[idx];
    // 管道尾巴：前一段是管道的上游，当前段若在 PIPE_TAILS 里就只做 mutating 判断
    const prevPipes = idx > 0 && segs[idx - 1].sep === "|";
    const u = unwrap(seg.argv);
    if (u.inner !== undefined && depth < 3) {
      const innerSegs = splitShell(u.inner);
      const before = out.length;
      analyzeSegments(innerSegs, opts, depth + 1, out);
      // sh -c 本身的重定向
      if (seg.redirects.length) {
        const r = segmentMutation([], seg, { cls: "other" });
        if (r.mutating && out.length > before) {
          out[out.length - 1].mutating = true;
          out[out.length - 1].targets.push(...r.targets);
        }
      }
      continue;
    }
    const base = u.argv[0]?.replace(/^.*\//, "") ?? "";
    const rawJoined = u.argv.join(" ");
    const isTail = prevPipes && PIPE_TAILS.has(base);
    const cls = isTail ? ({ cls: "other" } as Classified) : classifyArgv(u.argv, opts, seg, u.scope.length > 0, rawJoined, u.ci);
    const mut = segmentMutation(u.argv, seg, cls);
    // heredoc 内容里写文件（cat <<EOF > f 已由重定向处理；python/node 无 -c 的 heredoc 另行判断）
    let mutating = mut.mutating;
    if (seg.heredoc !== undefined && cls.cls === "other" && /^(python[\d.]*|node|bun|ruby|perl)$/.test(base)) {
      if (WRITE_PY.test(seg.heredoc) || WRITE_JS.test(seg.heredoc)) mutating = true;
    }
    const sepAfter = seg.sep;
    out.push({
      argv: u.argv,
      scope: u.scope,
      cls: cls.cls,
      mutating,
      targets: mut.targets,
      scriptPath: cls.scriptPath,
      background: Boolean(cls.background) || sepAfter === "&",
      tail: isTail,
    });
  }
}

const NORM_SKIP = new Set(["export", "set", "unset", "source", ".", "alias", "true", "false", ":", "wait"]);

function renderNorm(infos: SegmentInfo[]): string {
  return infos
    .filter((s) => s.argv.length > 0 && !s.tail && !(NORM_SKIP.has(s.argv[0]) && !s.mutating))
    .map((s) => joinArgv([s.argv[0], ...s.scope, ...s.argv.slice(1)]))
    .join(" && ");
}

/** 分析一条 shell 命令。 */
export function analyzeShell(cmd: string, opts: ClassifyOptions = {}): ShellAnalysis {
  const segs = splitShell(cmd);
  const infos: SegmentInfo[] = [];
  analyzeSegments(segs, opts, 0, infos);
  const meaningful = infos.filter((s) => !s.tail);
  let cls: CmdClass = "other";
  for (const c of PRIORITY) {
    if (meaningful.some((s) => s.cls === c)) {
      cls = c;
      break;
    }
  }
  const scriptPath = meaningful.find((s) => s.scriptPath && s.cls === cls)?.scriptPath ?? meaningful.find((s) => s.scriptPath)?.scriptPath;
  return {
    cls,
    mutating: infos.some((s) => s.mutating),
    targets: [...new Set(infos.flatMap((s) => s.targets))],
    background: cls === "test_watch" || infos.some((s) => s.background),
    scriptPath,
    normCmd: renderNorm(infos),
    segments: infos,
  };
}

export function classifyCommand(cmd: string, opts: ClassifyOptions = {}): CmdClass {
  return analyzeShell(cmd, opts).cls;
}

export function isMutatingCommand(cmd: string, opts: ClassifyOptions = {}): boolean {
  return analyzeShell(cmd, opts).mutating;
}

/** 归一化命令：剥壳、去管道尾巴和重定向，保留 cd 与范围参数。用于「同一调用」比较。 */
export function normCmd(cmd: string, opts: ClassifyOptions = {}): string {
  return analyzeShell(cmd, opts).normCmd;
}
