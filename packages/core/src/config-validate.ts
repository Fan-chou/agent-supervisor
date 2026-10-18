// POST /v1/config/validate 的核心（decisions #102）：把一份 YAML 草稿对着当前生效配置校验并给出 diff。纯函数：不读不写文件，不应用任何东西。
import { parse as parseYaml } from "yaml";
import { defaultConfig, resolveConfig, type Config } from "./config.ts";
import { maskSecrets } from "./config-view.ts";

export interface ConfigDiffEntry {
  path: string;
  from: unknown;
  to: unknown;
}

export interface ConfigValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
  /** 草稿合并到当前配置之后，哪些叶子值会变（疑似凭据的值已遮掉）。 */
  diff: ConfigDiffEntry[];
  /** 草稿把 mode 设成 enforce（而当前不是）——前端据此黄色强调「这会开启拦截」。 */
  enablesBlocking: boolean;
}

export const MAX_DRAFT_BYTES = 65_536;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** 叶子路径 → 值（数组和原始值是叶子）。 */
export function flattenLeaves(v: unknown, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> {
  if (isObj(v) && Object.keys(v).length > 0) for (const [k, x] of Object.entries(v)) flattenLeaves(x, prefix ? `${prefix}.${k}` : k, out);
  else out[prefix] = v;
  return out;
}

/** 键集合不固定的段：里面的键不做「未知键」检查（规则覆盖、请求体、harness 表、阈值阶梯的级别）。 */
const OPEN_MAPS = new Set(["rules", "judge.request", "harness", "judge.routes"]);

function walk(draft: unknown, ref: unknown, path: string, errors: string[], warnings: string[]): void {
  if (!isObj(draft)) return;
  for (const [k, v] of Object.entries(draft)) {
    const p = path ? `${path}.${k}` : k;
    if (!isObj(ref) || !(k in ref)) {
      if (!OPEN_MAPS.has(path) && !/^thresholds\.T[1-8]$/.test(path)) warnings.push(path ? `未知配置键 ${p}（会被忽略或不起作用）` : `未知配置段 ${p}（会被忽略）`);
      continue;
    }
    const r = (ref as Record<string, unknown>)[k];
    if (r === undefined || r === null) continue; // 默认值是 null/缺省的可选项：不限定类型
    if (typeof r === "number") {
      if (typeof v !== "number" || !Number.isFinite(v)) errors.push(`${p}：需要数字，收到 ${JSON.stringify(v)}`);
      else if (v < 0) errors.push(`${p}：不能是负数（${v}）`);
    } else if (typeof r === "string") {
      if (typeof v !== "string") errors.push(`${p}：需要字符串，收到 ${JSON.stringify(v)}`);
    } else if (typeof r === "boolean") {
      if (typeof v !== "boolean") errors.push(`${p}：需要 true 或 false，收到 ${JSON.stringify(v)}`);
    } else if (Array.isArray(r)) {
      if (!Array.isArray(v)) errors.push(`${p}：需要列表，收到 ${JSON.stringify(v)}`);
    } else if (isObj(r)) {
      if (!isObj(v)) errors.push(`${p}：需要对象，收到 ${JSON.stringify(v)}`);
      else walk(v, r, p, errors, warnings);
    }
  }
}

export function validateConfigDraft(yamlText: string, current: Config): ConfigValidation {
  const res: ConfigValidation = { valid: false, errors: [], warnings: [], diff: [], enablesBlocking: false };
  if (Buffer.byteLength(yamlText) > MAX_DRAFT_BYTES) {
    res.errors.push(`草稿太大（超过 ${MAX_DRAFT_BYTES} 字节）`);
    return res;
  }
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    res.errors.push(`YAML 解析失败：${String((err as Error)?.message ?? err).split("\n")[0].slice(0, 200)}`);
    return res;
  }
  if (raw === null || raw === undefined) raw = {}; // 空文件 = 全部用默认
  if (!isObj(raw)) {
    res.errors.push("顶层需要是对象（键值对）");
    return res;
  }
  walk(raw, defaultConfig(), "", res.errors, res.warnings);

  const d = raw as Record<string, any>;
  if ("mode" in d && !["shadow", "advise", "enforce"].includes(d.mode)) res.errors.push(`mode：只能是 shadow | advise | enforce，收到 ${JSON.stringify(d.mode)}`);
  if (typeof d.judge?.base_url === "string") {
    try {
      const u = new URL(d.judge.base_url);
      if (!["http:", "https:"].includes(u.protocol)) res.errors.push(`judge.base_url：只支持 http/https，收到 ${u.protocol}`);
      else if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) res.warnings.push(`judge.base_url 指向非本机地址 ${u.hostname}：启用 judge 后脱敏后的上下文会发往该地址`);
    } catch {
      res.errors.push(`judge.base_url：不是合法的 URL（${String(d.judge.base_url).slice(0, 80)}）`);
    }
  }
  if (d.rules && isObj(d.rules)) {
    for (const [k, v] of Object.entries(d.rules)) {
      if (!isObj(v)) res.errors.push(`rules.${k}：需要对象`);
      else if ((v as any).action === "off" && /^X2(_|$)/.test(k)) res.warnings.push("rules.X2_*.action: off 会关闭 X2 危险操作检测（界面的规则编辑不允许这样做，配置文件允许）");
    }
  }
  if (res.errors.length) return res;

  let merged: Config;
  try {
    merged = resolveConfig(raw, structuredClone(current));
  } catch (err) {
    res.errors.push(`合并配置失败：${String((err as Error)?.message ?? err).slice(0, 200)}`);
    return res;
  }
  const a = flattenLeaves(maskSecrets(current));
  const b = flattenLeaves(maskSecrets(merged));
  for (const p of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (JSON.stringify(a[p]) !== JSON.stringify(b[p])) res.diff.push({ path: p, from: a[p] ?? null, to: b[p] ?? null });
  }
  res.enablesBlocking = merged.mode === "enforce" && current.mode !== "enforce";
  if (res.enablesBlocking) res.warnings.push("这份草稿把 mode 设为 enforce：应用后 block/ask/Stop 续跑会真的生效（OpenCode 在核对通过前仍只观察）");
  res.valid = true;
  return res;
}
