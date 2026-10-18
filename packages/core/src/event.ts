// 统一事件模型，见 docs/design.md §4.1。

export type Harness = "claude" | "codex" | "opencode";
/** P0-6：谁产生了这条事件。supervisor = 我们自己注入的文本被 harness 回显。 */
export type Origin = "user" | "agent" | "supervisor";
export type Phase = "pre" | "post" | "batch" | "stop" | "prompt" | "session" | "compact" | "interrupt";

export type CmdClass =
  | "test_full"
  | "test_targeted"
  | "test_watch"
  | "probe"
  | "smoke_script"
  | "repro_script"
  | "http_smoke"
  | "build"
  | "lint"
  | "typecheck"
  | "other";

export type ToolKind = "shell" | "read" | "edit" | "search" | "plan" | "agent" | "web" | "other";

export type ResultStatus = "ok" | "fail" | "unknown" | "pending";

export interface TestSummary {
  passed?: number;
  failed?: number;
  skipped?: number;
  errors?: number;
  raw?: string;
}

export interface ToolInfo {
  name: string;
  kind: ToolKind;
  input: unknown;
  argsHash: string;
}

export interface ShellInfo {
  cmd: string;
  normCmd: string;
  cls: CmdClass;
  mutating: boolean;
  targets: string[];
  /** 命令不会自己结束（watch 模式或放后台），调用方应标 pending。 */
  background?: boolean;
  scriptPath?: string;
}

export interface EditInfo {
  files: string[];
  contentHashes?: Record<string, string>;
  /** 本次编辑净删除的行数（P6 用，取不到就不填）。 */
  deletedLines?: number;
  addedLines?: number;
  deletedFile?: boolean;
  /** 编辑是否新建了文件（P2 豁免）。 */
  created?: boolean;
}

export interface ResultInfo {
  status: ResultStatus;
  exitCode?: number;
  errFingerprint?: string;
  outHash: string;
  outputHead: string;
  outputTail: string;
  testSummary?: TestSummary;
}

export interface Event {
  sessionId: string;
  harness: Harness;
  agentId?: string;
  model?: string;
  turnId?: string;
  seq: number;
  ts: number; // epoch ms
  origin: Origin;
  /** Claude/Codex tool_use_id，OpenCode callID；pre/post 配对。 */
  toolUseId?: string;
  phase: Phase;
  tool?: ToolInfo;
  shell?: ShellInfo;
  edit?: EditInfo;
  result?: ResultInfo;
  /** §4.3 工作区指纹；"non-git" / "timeout" 是特殊值。 */
  wsFingerprint?: string;
  text?: string;
  /** 回放用：用量信息（R2/R3）。 */
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number; contextTokens?: number };
}
