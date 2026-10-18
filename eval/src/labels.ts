// eval/labels.yaml 的读取与校验。labels.yaml 是 Jack 的人工标注，这里只做读取，不生成。
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export interface LabelSession {
  id: string;
  /** 绝对路径（读取时已按 labels 文件所在目录解析）。 */
  file: string;
  outcome: "ok" | "derailed";
  /** 从第几次工具调用起跑偏（从 1 开始）；outcome=derailed 时必填。 */
  derailStep?: number;
  derailKind?: string;
  expectedRules?: string[];
  /** 可选：这个会话对应的 plan.md。 */
  plan?: string;
  notes?: string;
}

export interface Labels {
  version: number;
  sessions: LabelSession[];
  path: string;
}

export class LabelError extends Error {}

export function parseLabels(yamlText: string, baseDir: string, path = "<inline>"): Labels {
  const raw = parseYaml(yamlText) as unknown;
  if (!raw || typeof raw !== "object") throw new LabelError(`${path}: 顶层必须是对象`);
  const o = raw as Record<string, unknown>;
  const version = typeof o.version === "number" ? o.version : 1;
  if (version !== 1) throw new LabelError(`${path}: 不支持的 labels 版本 ${version}`);
  if (!Array.isArray(o.sessions)) throw new LabelError(`${path}: 缺少 sessions 列表`);
  const ids = new Set<string>();
  const sessions: LabelSession[] = [];
  o.sessions.forEach((s, i) => {
    const where = `${path}: sessions[${i}]`;
    if (!s || typeof s !== "object") throw new LabelError(`${where} 不是对象`);
    const r = s as Record<string, unknown>;
    if (typeof r.id !== "string" || !r.id) throw new LabelError(`${where} 缺少 id`);
    if (ids.has(r.id)) throw new LabelError(`${where} id 重复：${r.id}`);
    ids.add(r.id);
    if (typeof r.file !== "string" || !r.file) throw new LabelError(`${where}(${r.id}) 缺少 file`);
    if (r.outcome !== "ok" && r.outcome !== "derailed") throw new LabelError(`${where}(${r.id}) outcome 必须是 ok 或 derailed`);
    const derail = r.derail_step;
    if (r.outcome === "derailed") {
      if (typeof derail !== "number" || !Number.isInteger(derail) || derail < 1) throw new LabelError(`${where}(${r.id}) derailed 的会话必须给 derail_step（≥1 的整数，工具调用序号）`);
    } else if (derail !== undefined) throw new LabelError(`${where}(${r.id}) outcome=ok 不应有 derail_step`);
    const expected = r.expected_rules;
    if (expected !== undefined && (!Array.isArray(expected) || expected.some((x) => typeof x !== "string"))) throw new LabelError(`${where}(${r.id}) expected_rules 必须是字符串列表`);
    sessions.push({
      id: r.id,
      file: resolve(baseDir, r.file),
      outcome: r.outcome,
      derailStep: r.outcome === "derailed" ? (derail as number) : undefined,
      derailKind: typeof r.derail_kind === "string" ? r.derail_kind : undefined,
      expectedRules: expected as string[] | undefined,
      plan: typeof r.plan === "string" ? resolve(baseDir, r.plan) : undefined,
      notes: typeof r.notes === "string" ? r.notes : undefined,
    });
  });
  return { version, sessions, path };
}

export function loadLabels(path: string): Labels {
  return parseLabels(readFileSync(path, "utf8"), dirname(resolve(path)), path);
}
