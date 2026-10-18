// 配置（config.example.yaml）：默认值、合并、加载、覆盖。
// 所有规则通用、只有一套阈值（`thresholds`），不按模型分档；模型名只记录到日志。
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

export type Level = "L" | "advise" | "M" | "H";
/** 阶梯阈值：次数达到 n 时升到对应级别（取满足的最高级）。 */
export type Ladder = Partial<Record<Level, number>>;

export interface Thresholds {
  L2_repeat: number;
  S1_readonly: number;
  /** L1：连续失败多少次后 advise。 */
  L1_advise: number;
  T1: Ladder;
  T2: Ladder;
  T3: Ladder;
  T4: Ladder;
  T5: Ladder;
  T6: Ladder;
  T7: Ladder;
  T8: Ladder;
  /** 每轮预算：超出进入 M。 */
  full_tests_per_turn: number;
  verify_calls_per_turn: number;
}

export interface JudgeRoute {
  when: { rule?: string; sync?: boolean };
  model: string;
}

export interface LogConfig {
  /** SQLite 日志库路径（design §18）。 */
  db: string;
  /** 保留天数；0 = 不自动清理。 */
  retention_days: number;
  /** 非空时同时把每条记录镜像追加到该目录下的 JSONL 文件（按表、按日期）。 */
  jsonl_dir: string | null;
  /** 是否保存事件正文 / judge 请求响应正文（脱敏后）。关掉后只留指纹与统计字段。 */
  store_event_bodies: boolean;
  store_judge_bodies: boolean;
}

export interface Config {
  mode: "shadow" | "advise" | "enforce";
  judge: {
    base_url: string;
    api_key_env: string;
    model: string;
    response_format: "auto" | "json_schema" | "json_object" | "none";
    timeout_async_s: number;
    timeout_sync_s: number;
    request: Record<string, unknown>;
    routes: JudgeRoute[];
    block_confidence: number;
  };
  budgets: {
    judge_calls_per_session: number;
    judge_cooldown_s: number;
    rule_cooldown_steps: number;
    rule_cooldown_s: number;
    max_consecutive_blocks: number;
    max_stop_continues: number;
    max_async_rewakes: number;
  };
  thresholds: Thresholds;
  rules: Record<string, { action?: string; mode?: string; block_on?: number; disabled?: boolean }>;
  plan: { source: "auto" | "file" | "off" };
  test: { full: string[]; fast: string[]; extra_patterns: string[] };
  harness: Record<string, { enabled: boolean; api?: string }>;
  runtime: { socket: string; autostart_daemon: boolean };
  log: LogConfig;
  /** 回放/检测器用的其他参数。 */
  detect: {
    context_window: number;
    session_budget_usd?: number;
    r4_interval_steps: number;
    s3_minutes: number;
    s3_calls: number;
    r1_calls: number;
    p4_every_edits: number;
    p6_deleted_lines: number;
    l5_segments_L: number;
    l5_segments_M: number;
  };
}

/** 初值（design §5、§6.3），必须用回放校准。 */
export function defaultThresholds(): Thresholds {
  return {
    L2_repeat: 4,
    S1_readonly: 12,
    L1_advise: 2,
    T1: { advise: 2, H: 3 },
    T2: { advise: 3, M: 5 },
    T3: { advise: 1 },
    T4: { L: 4, advise: 6 },
    T5: { L: 2, advise: 3, M: 4 },
    T6: { advise: 3 },
    T7: { advise: 1 },
    T8: { L: 10, M: 14 },
    full_tests_per_turn: 3,
    verify_calls_per_turn: 12,
  };
}

export function defaultConfig(): Config {
  return {
    mode: "shadow",
    judge: {
      base_url: "http://127.0.0.1:3425/v1",
      api_key_env: "SUPERVISOR_API_KEY",
      model: "supervisor-judge",
      response_format: "auto",
      timeout_async_s: 30,
      timeout_sync_s: 15,
      request: { temperature: 0, max_tokens: 800 },
      routes: [],
      block_confidence: 0.8,
    },
    budgets: {
      judge_calls_per_session: 12,
      judge_cooldown_s: 60,
      rule_cooldown_steps: 10,
      rule_cooldown_s: 300,
      max_consecutive_blocks: 2,
      max_stop_continues: 2,
      max_async_rewakes: 2,
    },
    thresholds: defaultThresholds(),
    rules: {
      X2_dangerous: { action: "block" },
      S2_phase_stall: { mode: "replay_only" },
      T1_rerun_unchanged: { block_on: 3 },
    },
    plan: { source: "auto" },
    test: { full: [], fast: [], extra_patterns: [] },
    harness: { claude: { enabled: true }, codex: { enabled: true }, opencode: { enabled: true, api: "v2" } },
    runtime: { socket: "~/.agent-supervisor/sock", autostart_daemon: true },
    log: { db: "~/.agent-supervisor/state.db", retention_days: 14, jsonl_dir: null, store_event_bodies: true, store_judge_bodies: true },
    detect: {
      context_window: 200_000,
      r4_interval_steps: 20,
      s3_minutes: 8,
      s3_calls: 10,
      r1_calls: 50,
      p4_every_edits: 8,
      p6_deleted_lines: 200,
      l5_segments_L: 4,
      l5_segments_M: 6,
    },
  };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge<T>(base: T, over: unknown): T {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : (over as T);
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) {
    out[k] = k in out && isObj(out[k]) && isObj(v) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

export function resolveConfig(raw: unknown, base: Config = defaultConfig()): Config {
  if (!isObj(raw)) return base;
  const cfg = deepMerge(base, raw);
  // rules.T1_rerun_unchanged.block_on 是 thresholds.T1.H 的别名（config.example.yaml 沿用的写法）
  const bo = cfg.rules.T1_rerun_unchanged?.block_on;
  const explicitH = isObj(raw.thresholds) && isObj((raw.thresholds as Record<string, unknown>).T1) && "H" in ((raw.thresholds as Record<string, unknown>).T1 as object);
  if (typeof bo === "number" && !explicitH) cfg.thresholds = { ...cfg.thresholds, T1: { ...cfg.thresholds.T1, H: bo } };
  return cfg;
}

export function loadConfigFile(path: string, base?: Config): Config {
  return resolveConfig(parseYaml(readFileSync(path, "utf8")), base);
}

/**
 * 命令行覆盖：`thresholds.T1.H=4`、`budgets.judge_cooldown_s=30`（点号路径，值按 JSON 解析，失败当字符串）。
 * 返回新的配置，不修改入参。用于 `sv replay --set …` 调阈值。
 */
export function applyOverride(cfg: Config, assignment: string): Config {
  const eq = assignment.indexOf("=");
  if (eq <= 0) throw new Error(`覆盖格式应为 path=value：${assignment}`);
  const path = assignment.slice(0, eq).split(".").filter(Boolean);
  const raw = assignment.slice(eq + 1);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    value = raw;
  }
  const clone = structuredClone(cfg) as unknown as Record<string, unknown>;
  let cur: Record<string, unknown> = clone;
  for (let i = 0; i < path.length - 1; i++) {
    const next = cur[path[i]];
    if (!isObj(next)) throw new Error(`配置里没有路径 ${path.slice(0, i + 1).join(".")}`);
    cur = next;
  }
  const last = path[path.length - 1];
  if (!(last in cur) && !path[0].startsWith("thresholds")) throw new Error(`配置里没有路径 ${path.join(".")}`);
  cur[last] = value;
  return clone as unknown as Config;
}

/** 阶梯取值：返回满足的最高级别。 */
export function ladderLevel(l: Ladder, n: number, scale = 1): Level | null {
  const order: Level[] = ["H", "M", "advise", "L"];
  for (const lv of order) {
    const t = l[lv];
    if (t !== undefined && n >= Math.ceil(t * scale)) return lv;
  }
  return null;
}
