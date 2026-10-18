// 任务计划提取（design §4.2）：TodoWrite / update_plan / todowrite，以及 .supervisor/plan.md。
import type { Event } from "./event.ts";

export type PlanSource = "auto" | "file";
export type StepStatus = "pending" | "in_progress" | "completed";

export interface PlanItem {
  text: string;
  status: StepStatus;
}

export interface Plan {
  source: PlanSource;
  title?: string;
  items: PlanItem[];
  /** plan.md 里显式写的 allow: 路径/glob；只有这种来源下 P1 才能拦截。 */
  explicitAllow: string[];
  /** 计划全文，P5 判断「计划里是否提到」时用。 */
  text: string;
}

function normStatus(s: unknown): StepStatus {
  const v = String(s ?? "").toLowerCase();
  if (v === "in_progress" || v === "inprogress" || v === "active" || v === "running") return "in_progress";
  if (v === "completed" || v === "complete" || v === "done" || v === "cancelled") return "completed";
  return "pending";
}

/** 工具调用 → 计划；不是计划工具返回 null。 */
export function planFromToolCall(name: string, input: unknown): Plan | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const lname = name.toLowerCase();
  let items: PlanItem[] | null = null;
  if ((lname === "todowrite" || lname === "todo_write") && Array.isArray(o.todos)) {
    items = (o.todos as Record<string, unknown>[])
      .filter((t) => t && typeof t === "object")
      .map((t) => ({ text: String(t.content ?? t.text ?? t.activeForm ?? ""), status: normStatus(t.status) }));
  } else if (lname === "update_plan" && Array.isArray(o.plan)) {
    items = (o.plan as Record<string, unknown>[])
      .filter((t) => t && typeof t === "object")
      .map((t) => ({ text: String(t.step ?? t.text ?? ""), status: normStatus(t.status) }));
  }
  if (!items) return null;
  items = items.filter((i) => i.text);
  return { source: "auto", items, explicitAllow: [], text: items.map((i) => i.text).join("\n") };
}

export function planFromEvent(e: Event): Plan | null {
  if (e.phase !== "post" && e.phase !== "pre") return null;
  if (!e.tool) return null;
  return planFromToolCall(e.tool.name, e.tool.input);
}

/** 解析 .supervisor/plan.md：标题、清单、`allow:` 行（可逗号分隔，也可写在清单项里）。 */
export function parsePlanMd(md: string): Plan {
  const items: PlanItem[] = [];
  const allow: string[] = [];
  let title: string | undefined;
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const h = /^#{1,3}\s+(.*)$/.exec(line);
    if (h && !title) {
      title = h[1].trim();
      continue;
    }
    const a = /^(?:[-*]\s+)?allow\s*:\s*(.+)$/i.exec(line);
    if (a) {
      allow.push(...splitList(a[1]));
      continue;
    }
    const c = /^[-*]\s+\[( |x|X|~|-)\]\s+(.*)$/.exec(line);
    if (c) {
      let text = c[2];
      const inline = /\ballow\s*:\s*([^;]+)$/i.exec(text);
      if (inline) {
        allow.push(...splitList(inline[1]));
        text = text.slice(0, inline.index).trim().replace(/[;,]$/, "");
      }
      items.push({ text, status: c[1] === " " ? "pending" : c[1] === "~" ? "in_progress" : "completed" });
      continue;
    }
    const b = /^[-*]\s+(.*)$/.exec(line);
    if (b) items.push({ text: b[1], status: "pending" });
  }
  // 没有 ~ 标记时，第一个未完成的项视为当前步骤
  if (!items.some((i) => i.status === "in_progress")) {
    const first = items.find((i) => i.status === "pending");
    if (first) first.status = "in_progress";
  }
  return { source: "file", title, items, explicitAllow: [...new Set(allow)], text: md };
}

function splitList(s: string): string[] {
  return s
    .split(/[,\s]+/)
    .map((x) => x.replace(/^[`'"]|[`'"]$/g, "").trim())
    .filter(Boolean);
}

const PATH_RE = /(?:^|[\s`'"(\[])((?:\.{0,2}\/)?(?:[\w@.+*-]+\/)+[\w@.*+-]*(?:\.[\w*]+)?|[\w@.+-]+\.(?:py|ts|tsx|js|jsx|mjs|go|rs|rb|java|json|ya?ml|toml|md|sh|css|html|sql))(?=$|[\s`'"),.:;\]，。；：、）])/g;

/** 从步骤文本里提取路径和 glob。 */
export function pathsInText(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(PATH_RE)) {
    const p = m[1].replace(/^\.\//, "");
    if (p.length >= 3 && !/^https?:/.test(p) && !/^\d+(\.\d+)*$/.test(p)) out.add(p);
  }
  return [...out];
}

export function currentStep(plan: Plan | null | undefined): PlanItem | undefined {
  return plan?.items.find((i) => i.status === "in_progress");
}

/** glob 匹配（相对路径）。无通配符时按「相等或目录前缀」处理，不做子串匹配。 */
export function matchesAllow(path: string, pattern: string): boolean {
  const p = path.replace(/^\.\//, "");
  const g = pattern.replace(/^\.\//, "");
  if (!/[*?[{]/.test(g)) {
    return p === g || p.startsWith(g.endsWith("/") ? g : g + "/");
  }
  return new Bun.Glob(g).match(p);
}
