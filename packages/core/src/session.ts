// 会话状态：从 Event 流派生出检测器要用的索引。检测器只读它，不改它。
import { analyzeShell, type ClassifyOptions } from "./cmdclass.ts";
import type { CmdClass, Event } from "./event.ts";
import { OriginRegistry } from "./origin.ts";
import { currentStep, pathsInText, planFromEvent, type Plan } from "./plan.ts";

export const isTestPath = (p: string) =>
  /(^|\/)(tests?|__tests__|spec|specs|e2e)\//.test(p) || /(^|\/)test_[^/]+\.[a-z]+$/.test(p) || /[._-](test|spec)\.[a-z]+$/.test(p) || /_test\.(go|py|rs)$/.test(p) || /(^|\/)conftest\.py$/.test(p);

const NON_SOURCE = /(\.(md|txt|rst|json|ya?ml|toml|lock|cfg|ini)$|^\.|\/\.)/;
export const isSourcePath = (p: string) => !isTestPath(p) && !NON_SOURCE.test(p) && !/^\/tmp\//.test(p);

export const VERIFY_CLASSES: ReadonlySet<CmdClass> = new Set(["test_full", "test_targeted", "build", "typecheck"]);
/** T8 的「验证类调用」。 */
export const VERIFY_LIKE: ReadonlySet<CmdClass> = new Set(["test_full", "test_targeted", "probe", "smoke_script", "http_smoke", "build", "lint", "typecheck"]);

export interface Step {
  idx: number;
  seq: number;
  ts: number;
  turn: number;
  ev: Event;
  name: string;
  kind: string;
  argsHash: string;
  cls?: CmdClass;
  normCmd?: string;
  mutating: boolean;
  status: "ok" | "fail" | "unknown" | "pending";
  errFp?: string;
  outHash?: string;
  readFiles: string[];
  editedFiles: string[];
  isEdit: boolean;
  readOnly: boolean;
  neutral: boolean;
  /** 工作区版本号：编辑或 mutating 命令使其 +1。 */
  verBefore: number;
  verAfter: number;
}

export interface TestRun {
  stepIdx: number;
  cls: CmdClass;
  normCmd: string;
  status: Step["status"];
  turn: number;
}

export interface FileEditState {
  hashes: string[]; // 内容哈希序列（含第一次编辑前的 beforeHash）
  segments: number;
  lastEditStepIdx: number;
  /** 最近一次成功验证之后的段数（L5）。 */
  segmentsSinceVerify: number;
  editCount: number;
}

export type Unchanged = "verified" | "inferred" | "changed";

const READ_CMDS = new Set(["cat", "head", "tail", "less", "more", "bat", "nl", "sed", "awk", "grep", "rg", "ack", "wc", "file", "stat", "xxd", "od", "strings"]);

export function pathsOfInput(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const o = input as Record<string, unknown>;
  const out: string[] = [];
  for (const k of ["file_path", "path", "notebook_path", "filePath", "filename", "file"]) {
    if (typeof o[k] === "string") out.push(o[k] as string);
  }
  if (Array.isArray(o.paths)) out.push(...(o.paths as unknown[]).filter((x): x is string => typeof x === "string"));
  return out;
}

export function shellReadPaths(cmd: string): string[] {
  const out: string[] = [];
  for (const seg of analyzeShell(cmd).segments) {
    const base = seg.argv[0]?.replace(/^.*\//, "") ?? "";
    if (!READ_CMDS.has(base) || seg.tail) continue;
    const args = seg.argv.slice(1).filter((a) => !a.startsWith("-"));
    const rest = ["grep", "rg", "ack", "sed", "awk"].includes(base) ? args.slice(1) : args;
    out.push(...rest.filter((a) => /[./]/.test(a) && !/^\d+(,\d+)?p?$/.test(a)));
  }
  return out;
}

export class SessionTracker {
  readonly events: Event[] = [];
  readonly steps: Step[] = [];
  readonly pending = new Map<string, Event>();
  readonly registry = new OriginRegistry();
  sessionId = "";
  harness: Event["harness"] = "claude";
  model?: string;
  cwd?: string;
  turn = 0;
  turnStartStepIdx = 0;
  turnStartTs = 0;
  userPrompts: string[] = [];
  lastUserPromptTs = 0;
  plan: Plan | null = null;
  filePlan: Plan | null = null;
  /** 当前计划步骤期间读/改过的文件（自动提取的允许范围要加上它们）。 */
  stepTouched = new Set<string>();
  stepKey = "";
  edits = new Map<string, FileEditState>();
  readsSinceEdit = new Map<string, number>();
  readFileSet = new Set<string>();
  createdFiles = new Set<string>();
  newScripts = new Set<string>();
  sourceEdited = false;
  firstEditStepIdx = -1;
  lastEditStepIdx = -1;
  lastOkEditTs = 0;
  firstSourceEditStepIdx = -1;
  lastVerifyStepIdx = -1; // 最近一次「验证类」调用（不论成败）
  lastVerifyOkStepIdx = -1;
  testRuns: TestRun[] = [];
  version = 0;
  /** 中断后重复类计数从这里开始数。 */
  loopFloor = 0;
  silenced: "none" | "quiet" | "off" = "none";
  stopCount = 0;
  /** 已经投递给 agent 的监督消息（judge 提示里要列出，避免重复说同样的话）。 */
  sentMessages: { seq: number; ruleId: string; text: string }[] = [];
  editCount = 0;
  lastEventTs = 0;
  usage = { costUsd: 0, contextTokens: 0, hasCost: false };
  /** 自适应阈值倍数（§5.7），由 policy 写入。 */
  scale = new Map<string, number>();
  lastWs?: string;
  /** 一次性触发标记（边沿类检测器用）。 */
  fired = new Set<string>();

  constructor(readonly classifyOpts: ClassifyOptions = {}) {}

  get opts(): ClassifyOptions {
    return { ...this.classifyOpts, newScripts: this.newScripts, sourceEdited: this.sourceEdited };
  }

  get turnSteps(): Step[] {
    return this.steps.slice(this.turnStartStepIdx);
  }

  last(n = 1): Step | undefined {
    return this.steps[this.steps.length - n];
  }

  /** 本会话在 pre 阶段需要用的命令分析（带 newScripts / sourceEdited 上下文）。 */
  analyze(cmd: string) {
    return analyzeShell(cmd, this.opts);
  }

  ingest(e: Event): void {
    this.events.push(e);
    this.sessionId = e.sessionId || this.sessionId;
    this.harness = e.harness;
    if (e.model) this.model = e.model;
    if (e.cwd) this.cwd = e.cwd;
    if (e.wsFingerprint) this.lastWs = e.wsFingerprint;
    this.lastEventTs = Math.max(this.lastEventTs, e.ts);
    if (e.usage) {
      if (e.usage.costUsd !== undefined) {
        this.usage.costUsd = e.usage.costUsd;
        this.usage.hasCost = true;
      }
      if (e.usage.contextTokens !== undefined) this.usage.contextTokens = e.usage.contextTokens;
    }
    switch (e.phase) {
      case "prompt": {
        const text = e.text ?? "";
        const origin = e.origin === "user" && this.registry.isSupervisor(text) ? "supervisor" : e.origin;
        if (origin === "user") {
          this.turn++;
          this.turnStartStepIdx = this.steps.length;
          this.turnStartTs = e.ts;
          this.lastUserPromptTs = e.ts;
          this.userPrompts.push(text);
          if (/#sv\s+off\b/.test(text)) this.silenced = "off";
          else if (/#sv\s+quiet\b/.test(text)) this.silenced = "quiet";
        }
        break;
      }
      case "interrupt":
        this.loopFloor = this.steps.length;
        break;
      case "pre":
        if (e.toolUseId) this.pending.set(e.toolUseId, e);
        break;
      case "post":
        if (e.toolUseId) this.pending.delete(e.toolUseId);
        if (e.tool) this.addStep(e);
        break;
      case "stop":
        this.stopCount++;
        break;
      default:
        break;
    }
  }

  private addStep(e: Event): void {
    const tool = e.tool!;
    const sh = e.shell;
    const res = e.result;
    const status = res?.status ?? "unknown";
    // shell 的 cls 用带会话上下文的分析重算（smoke/repro 依赖 newScripts / sourceEdited）
    let cls = sh?.cls;
    let norm = sh?.normCmd;
    let mutating = sh?.mutating ?? false;
    let scriptPath = sh?.scriptPath;
    let targets = sh?.targets ?? [];
    if (sh?.cmd) {
      const a = this.analyze(sh.cmd);
      cls = a.cls;
      norm = a.normCmd;
      mutating = a.mutating;
      scriptPath = a.scriptPath;
      targets = a.targets;
    }
    const writtenByShell = sh && mutating ? targets.filter((t) => !/^(\/tmp\/|\/dev\/)/.test(t)) : [];
    const editedFiles = status === "fail" ? [] : [...(e.edit?.files ?? []), ...(tool.kind === "shell" ? writtenByShell : [])];
    const isEdit = editedFiles.length > 0 && tool.kind !== "plan";
    const readFiles: string[] = [];
    if (tool.kind === "read") readFiles.push(...pathsOfInput(tool.input));
    if (sh?.cmd) readFiles.push(...shellReadPaths(sh.cmd));
    const neutral = tool.kind === "plan";
    const readOnly = !neutral && !isEdit && (tool.kind === "read" || tool.kind === "search" || (tool.kind === "shell" && !mutating && (cls === "other" || cls === undefined) && !scriptPath));
    const verBefore = this.version;
    if (isEdit || (mutating && status !== "fail")) this.version++;
    const step: Step = {
      idx: this.steps.length,
      seq: e.seq,
      ts: e.ts,
      turn: this.turn,
      ev: e,
      name: tool.name,
      kind: tool.kind,
      argsHash: tool.argsHash,
      cls,
      normCmd: norm,
      mutating,
      status,
      errFp: res?.errFingerprint,
      outHash: res?.outHash,
      readFiles,
      editedFiles,
      isEdit,
      readOnly,
      neutral,
      verBefore,
      verAfter: this.version,
    };
    this.steps.push(step);
    // ---- 派生索引 ----
    for (const f of readFiles) {
      this.readFileSet.add(f);
      this.readsSinceEdit.set(f, (this.readsSinceEdit.get(f) ?? 0) + 1);
    }
    if (tool.kind === "plan") this.onPlanTool(e);
    if (isEdit) {
      this.editCount++;
      if (this.firstEditStepIdx < 0) this.firstEditStepIdx = step.idx;
      this.lastEditStepIdx = step.idx;
      this.lastOkEditTs = e.ts;
      for (const f of editedFiles) {
        let st = this.edits.get(f);
        if (!st) {
          st = { hashes: [], segments: 0, lastEditStepIdx: -1, segmentsSinceVerify: 0, editCount: 0 };
          this.edits.set(f, st);
          const before = e.edit?.beforeHashes?.[f];
          if (before) st.hashes.push(before);
        }
        const lastOnFile = st.lastEditStepIdx;
        const separated = lastOnFile < 0 || this.steps.slice(lastOnFile + 1, step.idx).some((s) => !s.isEdit && !s.neutral);
        if (lastOnFile < 0 || separated) {
          st.segments++;
          st.segmentsSinceVerify++;
        }
        st.lastEditStepIdx = step.idx;
        st.editCount++;
        const after = e.edit?.contentHashes?.[f];
        if (after) st.hashes.push(after);
        this.readsSinceEdit.set(f, 0);
        this.stepTouched.add(f);
        if (e.edit?.created) this.createdFiles.add(f);
        if (isSourcePath(f) && this.firstSourceEditStepIdx < 0) {
          this.firstSourceEditStepIdx = step.idx;
          this.sourceEdited = true;
        }
      }
      // 新建脚本：Write 新建的文件，或 shell 重定向到 /tmp 之外/之内的脚本
      for (const f of e.edit?.created ? e.edit.files : []) this.addScript(f);
    }
    // shell 往 /tmp 写的脚本也算新建（cat > /tmp/x.py）
    if (sh?.cmd) for (const t of targets) this.addScript(t);
    if (cls && VERIFY_CLASSES.has(cls) && status !== "pending") {
      this.lastVerifyStepIdx = step.idx;
      if (status === "ok") {
        this.lastVerifyOkStepIdx = step.idx;
        for (const st of this.edits.values()) st.segmentsSinceVerify = 0;
      }
    }
    if (cls === "test_full" || cls === "test_targeted") {
      this.testRuns.push({ stepIdx: step.idx, cls, normCmd: norm ?? "", status, turn: this.turn });
    }
    if (tool.kind !== "plan") for (const f of readFiles) this.stepTouched.add(f);
  }

  /** 登记本会话新建的脚本（绝对路径和相对路径两种写法都登记，命令里常写相对路径）。 */
  private addScript(f: string): void {
    if (!/\.(py|js|mjs|ts|sh|rb)$/.test(f)) return;
    this.newScripts.add(f);
    this.newScripts.add(this.rel(f));
  }

  private onPlanTool(e: Event): void {
    const p = planFromEvent(e);
    if (!p) return;
    this.plan = p;
    const key = currentStep(p)?.text ?? "";
    if (key !== this.stepKey) {
      this.stepKey = key;
      this.stepTouched = new Set();
    }
  }

  /** plan.md 优先于自动提取。 */
  effectivePlan(): Plan | null {
    return this.filePlan ?? this.plan;
  }

  setFilePlan(p: Plan | null): void {
    this.filePlan = p;
  }

  /** 两个 step（先 a 后 b）之间工作区是否没变。 */
  unchangedBetween(a: Step, b: { verBefore: number; ev?: Event }): Unchanged {
    if (a.verAfter !== b.verBefore) return "changed";
    const wa = a.ev.wsFingerprint;
    const wb = b.ev?.wsFingerprint;
    const real = (w?: string) => !!w && w !== "non-git" && w !== "timeout" && w !== "error";
    if (real(wa) && real(wb)) return wa === wb ? "verified" : "changed";
    return "inferred";
  }

  /** 以 origin=user 的 prompt 为界的「本轮」提示词。 */
  currentIntent(): string {
    return this.userPrompts.slice(-1)[0] ?? "";
  }

  scaleOf(rule: string): number {
    return this.scale.get(rule) ?? 1;
  }

  /** 本会话相关路径（相对化）。 */
  rel(p: string): string {
    if (this.cwd && p.startsWith(this.cwd.replace(/\/+$/, "") + "/")) return p.slice(this.cwd.replace(/\/+$/, "").length + 1);
    return p.replace(/^\.\//, "");
  }

  stepPathsFromPlan(): string[] {
    const p = this.effectivePlan();
    const cur = currentStep(p);
    return cur ? pathsInText(cur.text) : [];
  }
}
