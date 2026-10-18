// 规则编辑（decisions #101）：前端唯一的写路径。纯函数校验 + 原子落盘；不碰 mode、judge、预算、日志等任何别的配置。
// 编辑只以「每条规则的覆盖记录」存在（rules.local.json），生效配置 = 启动配置 + 这些覆盖，所以 reset 就是删掉那条规则的记录。
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { applyOverride, thresholdsForRule, type Config } from "./config.ts";
import { PROTECTED_RULES, RULE_IDS, ruleConfigKey } from "./rules.ts";

export type ThresholdKind = "count" | "ratio" | "number";

/** 可编辑的阈值：键名（与 GET /v1/rules 返回的 thresholds 一致）→ 配置路径与取值类型。没列出的键（含只读展示用的）不可编辑。 */
export const RULE_THRESHOLD_PATHS: Record<string, Record<string, { path: string; kind: ThresholdKind }>> = {
  L1: { advise_after_failures: { path: "thresholds.L1_advise", kind: "count" }, block_after_failures: { path: "thresholds.L1_block_after", kind: "count" } },
  L2: { repeat: { path: "thresholds.L2_repeat", kind: "count" }, window_steps: { path: "thresholds.L2_window", kind: "count" } },
  L2a: { repeat: { path: "thresholds.L2a_repeat", kind: "count" } }, // window_steps 与 L2 共用，不在这里改
  L3: { repeat: { path: "thresholds.L3_repeat", kind: "count" }, window_steps: { path: "thresholds.L3_window", kind: "count" } },
  L4: { returns: { path: "thresholds.L4_returns", kind: "count" } },
  L5: { segments_L: { path: "detect.l5_segments_L", kind: "count" }, segments_M: { path: "detect.l5_segments_M", kind: "count" } },
  L6: { reads: { path: "thresholds.L6_reads", kind: "count" } },
  S1: { readonly_steps: { path: "thresholds.S1_readonly", kind: "count" } },
  S2: { stall_steps: { path: "thresholds.S2_phase_steps", kind: "count" } },
  S3: { minutes: { path: "detect.s3_minutes", kind: "number" }, calls: { path: "detect.s3_calls", kind: "count" } },
  S4: { subagents: { path: "thresholds.S4_subagents", kind: "count" }, empty_run: { path: "thresholds.S4_empty_run", kind: "count" } },
  P4: { every_edits: { path: "detect.p4_every_edits", kind: "count" } },
  P6: { deleted_lines: { path: "detect.p6_deleted_lines", kind: "count" } },
  R1: { calls: { path: "detect.r1_calls", kind: "count" } },
  R2: { L: { path: "thresholds.R2_warn", kind: "ratio" }, M: { path: "thresholds.R2_limit", kind: "ratio" } },
  R3: { ratio: { path: "thresholds.R3_ratio", kind: "ratio" }, context_window: { path: "detect.context_window", kind: "count" } },
  R4: { every_steps: { path: "detect.r4_interval_steps", kind: "count" } },
  TB: { full_tests_per_turn: { path: "thresholds.full_tests_per_turn", kind: "count" }, verify_calls_per_turn: { path: "thresholds.verify_calls_per_turn", kind: "count" } },
};
const LADDER_RULES = new Set(["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8"]);
const LADDER_LEVELS = ["L", "advise", "M", "H"] as const;


export interface RuleEdit {
  disabled?: boolean;
  /** 配置路径 → 数字（例 "thresholds.L2_repeat": 6）。 */
  set?: Record<string, number>;
}
export type RuleEdits = Record<string, RuleEdit>;

export interface RuleEditBody {
  disabled?: unknown;
  thresholds?: unknown;
  reset?: unknown;
}

export type RuleEditResult =
  | { ok: true; edits: RuleEdits; cfg: Config; changes: { what: string; from: unknown; to: unknown }[] }
  | { ok: false; status: 400 | 403 | 404 | 409; code: string; errors: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** 启动配置 + 规则覆盖 → 生效配置。覆盖里有过期/无效的路径（例如配置结构变了）就跳过那一条，不让守护进程起不来。 */
export function applyRuleEdits(base: Config, edits: RuleEdits): Config {
  let cfg = structuredClone(base) as Config;
  for (const [id, e] of Object.entries(edits)) {
    if (!RULE_IDS.includes(id) || PROTECTED_RULES.has(id)) continue;
    if (typeof e.disabled === "boolean") {
      const key = ruleConfigKey(cfg, id);
      cfg.rules = { ...cfg.rules, [key]: { ...cfg.rules[key], disabled: e.disabled } };
    }
    for (const [path, value] of Object.entries(e.set ?? {})) {
      try {
        cfg = applyOverride(cfg, `${path}=${JSON.stringify(value)}`);
      } catch {
        /* 路径已不存在：跳过 */
      }
    }
  }
  return cfg;
}

function checkValue(kind: ThresholdKind, v: unknown): string | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return "需要有限的数字";
  if (kind === "count" && !(Number.isInteger(v) && v >= 1 && v <= 1_000_000)) return "需要 1 到 1000000 的整数";
  if (kind === "ratio" && !(v > 0 && v <= 1)) return "需要大于 0 且不超过 1 的数";
  if (kind === "number" && !(v > 0 && v <= 1_000_000)) return "需要大于 0 的数";
  return null;
}

function getPath(cfg: Config, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), cfg);
}

/**
 * 校验并计算一次规则编辑。纯函数：不读不写文件，不修改入参。
 * - base：启动配置（不含规则覆盖）；edits：当前已有的覆盖。返回新的 edits 和生效配置。
 */
export function validateRuleEdit(base: Config, edits: RuleEdits, ruleId: string, body: unknown): RuleEditResult {
  const fail = (status: 400 | 403 | 404 | 409, code: string, ...errors: string[]): RuleEditResult => ({ ok: false, status, code, errors });
  if (!RULE_IDS.includes(ruleId)) return fail(404, "unknown_rule", `没有规则 ${ruleId}`);
  if (!isObj(body)) return fail(400, "bad_request", "body 需要是 JSON 对象");
  const b = body as RuleEditBody;
  const extra = Object.keys(b).filter((k) => !["disabled", "thresholds", "reset"].includes(k));
  if (extra.length) return fail(400, "unknown_field", `不允许的字段：${extra.join("、")}（只能改 disabled、thresholds，或 reset）`);
  if (!("disabled" in b) && !("thresholds" in b) && b.reset !== true) return fail(400, "empty_edit", "没有要改的内容");
  if (PROTECTED_RULES.has(ruleId)) return fail(403, "protected_rule", `${ruleId} 是受保护的安全规则，不能通过界面停用或修改`);

  const cur = edits[ruleId] ?? {};
  const before = applyRuleEdits(base, edits);
  const next: RuleEdit = b.reset === true ? {} : { ...cur, set: { ...(cur.set ?? {}) } };
  const changes: { what: string; from: unknown; to: unknown }[] = [];

  if (b.reset === true) {
    if ("disabled" in b || "thresholds" in b) return fail(400, "bad_request", "reset 不能和其他字段一起用");
  } else {
    if ("disabled" in b) {
      if (typeof b.disabled !== "boolean") return fail(400, "bad_request", "disabled 需要是 true 或 false");
      const key = ruleConfigKey(base, ruleId);
      if (b.disabled === false && base.rules?.[key]?.action === "off") return fail(409, "disabled_by_config", `${ruleId} 在启动配置里被 action: off 关掉了，界面不能重新启用；请改配置文件并重启`);
      next.disabled = b.disabled;
    }
    if ("thresholds" in b) {
      if (!isObj(b.thresholds)) return fail(400, "bad_request", "thresholds 需要是对象");
      const errors: string[] = [];
      const setPath = (path: string, label: string, kind: ThresholdKind, v: unknown) => {
        const err = checkValue(kind, v);
        if (err) errors.push(`${label}：${err}`);
        else next.set![path] = v as number;
      };
      if (LADDER_RULES.has(ruleId)) {
        const keys = Object.keys(b.thresholds);
        if (keys.some((k) => k !== "ladder") || !isObj(b.thresholds.ladder)) return fail(400, "bad_request", `${ruleId} 的阈值写成 {"ladder": {"advise": 数字, …}}`);
        const lad = b.thresholds.ladder as Record<string, unknown>;
        const existing = getPath(base, `thresholds.${ruleId}`) as Record<string, number>;
        for (const [lv, v] of Object.entries(lad)) {
          if (!(LADDER_LEVELS as readonly string[]).includes(lv)) errors.push(`ladder.${lv}：未知级别（只有 L、advise、M、H）`);
          else if (!(lv in existing)) errors.push(`ladder.${lv}：${ruleId} 没有这一级，界面不能新增级别`);
          else setPath(`thresholds.${ruleId}.${lv}`, `ladder.${lv}`, "count", v);
        }
      } else {
        const allowed = RULE_THRESHOLD_PATHS[ruleId] ?? {};
        if (!Object.keys(allowed).length) return fail(400, "no_editable_thresholds", `${ruleId} 没有可编辑的阈值`);
        for (const [k, v] of Object.entries(b.thresholds)) {
          const spec = allowed[k];
          if (!spec) errors.push(`${k}：不是 ${ruleId} 的可编辑阈值（可编辑：${Object.keys(allowed).join("、")}）`);
          else setPath(spec.path, k, spec.kind, v);
        }
      }
      if (errors.length) return fail(400, "invalid_threshold", ...errors);
    }
  }

  const nextEdits: RuleEdits = { ...edits };
  if (b.reset === true || (!next.disabled && next.disabled !== false && !Object.keys(next.set ?? {}).length)) delete nextEdits[ruleId];
  else {
    if (!Object.keys(next.set ?? {}).length) delete next.set;
    nextEdits[ruleId] = next;
  }
  const cfg = applyRuleEdits(base, nextEdits);

  // 跨字段一致性（对生效配置检查，所以只改一个值也会被发现）
  const cross: string[] = [];
  const t = (id: string) => getPath(cfg, `thresholds.${id}`) as Record<string, number> | undefined;
  if (LADDER_RULES.has(ruleId)) {
    const lad = t(ruleId) ?? {};
    const present = LADDER_LEVELS.filter((lv) => typeof lad[lv] === "number");
    for (let i = 1; i < present.length; i++) if (lad[present[i]] < lad[present[i - 1]]) cross.push(`ladder 必须单调：${present[i - 1]}=${lad[present[i - 1]]} 不能大于 ${present[i]}=${lad[present[i]]}`);
  }
  if (ruleId === "L5" && cfg.detect.l5_segments_L > cfg.detect.l5_segments_M) cross.push(`segments_L(${cfg.detect.l5_segments_L}) 不能大于 segments_M(${cfg.detect.l5_segments_M})`);
  if (ruleId === "R2" && cfg.thresholds.R2_warn >= cfg.thresholds.R2_limit) cross.push(`R2.L(${cfg.thresholds.R2_warn}) 必须小于 R2.M(${cfg.thresholds.R2_limit})`);
  if (cross.length) return fail(400, "inconsistent_thresholds", ...cross);

  // 变更清单（给审计和响应用）
  const ruleBefore = { disabled: before.rules?.[ruleConfigKey(before, ruleId)]?.disabled === true, thresholds: thresholdsForRule(ruleId, before) };
  const ruleAfter = { disabled: cfg.rules?.[ruleConfigKey(cfg, ruleId)]?.disabled === true, thresholds: thresholdsForRule(ruleId, cfg) };
  if (ruleBefore.disabled !== ruleAfter.disabled) changes.push({ what: "disabled", from: ruleBefore.disabled, to: ruleAfter.disabled });
  if (JSON.stringify(ruleBefore.thresholds) !== JSON.stringify(ruleAfter.thresholds)) changes.push({ what: "thresholds", from: ruleBefore.thresholds, to: ruleAfter.thresholds });
  return { ok: true, edits: nextEdits, cfg, changes };
}

// ---------- 落盘 ----------

export interface RuleEditsFile {
  version: 1;
  edits: RuleEdits;
}

/** 读取覆盖文件。不存在 → 空；损坏 → 空并返回 warning（守护进程照常启动，使用启动配置）。 */
export function loadRuleEdits(path: string): { edits: RuleEdits; warning?: string } {
  if (!existsSync(path)) return { edits: {} };
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as Partial<RuleEditsFile>;
    if (j?.version !== 1 || !isObj(j.edits)) return { edits: {}, warning: `${path} 格式不对（需要 {version:1, edits:{…}}），已忽略` };
    const out: RuleEdits = {};
    for (const [id, e] of Object.entries(j.edits)) {
      if (!RULE_IDS.includes(id) || PROTECTED_RULES.has(id) || !isObj(e)) continue;
      const clean: RuleEdit = {};
      if (typeof e.disabled === "boolean") clean.disabled = e.disabled;
      if (isObj(e.set)) clean.set = Object.fromEntries(Object.entries(e.set).filter(([, v]) => typeof v === "number" && Number.isFinite(v))) as Record<string, number>;
      out[id] = clean;
    }
    return { edits: out };
  } catch (err) {
    return { edits: {}, warning: `${path} 读取失败（${String((err as Error)?.message ?? err).slice(0, 100)}），已忽略` };
  }
}

/** 原子写（临时文件 + rename），0600。失败抛异常，调用方据此返回 500 且不改内存配置。 */
export function saveRuleEdits(path: string, edits: RuleEdits): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ version: 1, edits } satisfies RuleEditsFile, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
