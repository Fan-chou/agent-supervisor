// 测试辅助：用脚本方式构造一个会话，喂给 Engine，收集命中。
import { defaultConfig, Engine, postEvent, preEvent, resolveConfig, type Config, type Decision, type Event, type Harness, type Hit, type JudgeFn, type Origin, type RawCall, type RawResult, type StepRecord } from "../src/index.ts";

export interface SimOpts {
  harness?: Harness;
  model?: string;
  cwd?: string;
  cfg?: Config;
  judge?: JudgeFn;
  trustInferred?: boolean;
  planMd?: string;
  sink?: import("../src/index.ts").LogSink;
  /** 每步前进的毫秒数。 */
  dt?: number;
}

export interface CallOpts {
  out?: string;
  fail?: boolean;
  exit?: number;
  pending?: boolean;
  ws?: string;
  dt?: number;
  created?: boolean;
}

export class Sim {
  seq = 0;
  ts = 1_700_000_000_000;
  n = 0;
  readonly engine: Engine;
  readonly harness: Harness;
  readonly model?: string;
  readonly dt: number;
  readonly sessionId = "sess-1";

  constructor(readonly opts: SimOpts = {}) {
    this.harness = opts.harness ?? "claude";
    this.model = opts.model;
    this.dt = opts.dt ?? 5000;
    this.engine = new Engine({ cfg: opts.cfg ?? defaultConfig(), judge: opts.judge, policy: { trustInferredUnchanged: opts.trustInferred }, planMd: opts.planMd, sink: opts.sink });
    this.engine.tracker.cwd = opts.cwd ?? "/work/proj";
  }

  get hits(): Hit[] {
    return this.engine.allHits;
  }
  get decisions(): Decision[] {
    return this.engine.allDecisions;
  }
  hitsOf(rule: string): Hit[] {
    return this.hits.filter((h) => h.ruleId === rule);
  }
  decisionsOf(rule: string): Decision[] {
    return this.decisions.filter((d) => d.hit.ruleId === rule);
  }

  advance(ms: number) {
    this.ts += ms;
  }

  private base(phase: Event["phase"], extra: Partial<Event> = {}): Event {
    return { sessionId: this.sessionId, harness: this.harness, model: this.model, seq: this.seq++, ts: this.ts, origin: "agent", phase, cwd: this.opts.cwd ?? "/work/proj", ...extra };
  }

  async start(): Promise<void> {
    await this.engine.feed(this.base("session", { origin: "agent" }));
  }

  async prompt(text: string, origin: Origin = "user"): Promise<StepRecord> {
    this.advance(this.dt);
    return this.engine.feed(this.base("prompt", { origin, text }));
  }

  async interrupt(): Promise<StepRecord> {
    this.advance(this.dt);
    return this.engine.feed(this.base("interrupt"));
  }

  async stop(): Promise<StepRecord> {
    this.advance(this.dt);
    return this.engine.feed(this.base("stop"));
  }

  /** 任意工具调用：先 pre 再 post。返回 [pre, post] 记录。 */
  async call(name: string, input: unknown, o: CallOpts = {}): Promise<[StepRecord, StepRecord]> {
    this.advance(o.dt ?? this.dt);
    const id = `tu_${this.n++}`;
    const raw: RawCall = { harness: this.harness, sessionId: this.sessionId, toolUseId: id, name, input, ts: this.ts, model: this.model };
    const copts = this.engine.tracker.opts;
    const pre = preEvent(raw, this.seq++, copts);
    if (o.ws) pre.wsFingerprint = o.ws;
    pre.cwd = this.opts.cwd ?? "/work/proj";
    const r1 = await this.engine.feed(pre);
    this.advance(1000);
    const res: RawResult = { output: o.out ?? "", isError: this.harness === "claude" ? !!o.fail : undefined, exitCode: this.harness === "codex" ? (o.exit ?? (o.fail ? 1 : 0)) : o.exit, pending: o.pending, ts: this.ts };
    const post = postEvent(raw, res, this.seq++, copts);
    if (o.ws) post.wsFingerprint = o.ws;
    if (o.created && post.edit) post.edit.created = true;
    const r2 = await this.engine.feed(post);
    return [r1, r2];
  }

  bash(cmd: string, o: CallOpts = {}) {
    return this.call(this.harness === "codex" ? "shell" : "Bash", this.harness === "codex" ? { command: ["bash", "-lc", cmd] } : { command: cmd }, o);
  }
  read(file: string, o: CallOpts = {}) {
    return this.call("Read", { file_path: file }, { out: "contents", ...o });
  }
  grep(pattern: string, o: CallOpts = {}) {
    return this.call("Grep", { pattern }, { out: "x", ...o });
  }
  edit(file: string, oldS: string, newS: string, o: CallOpts = {}) {
    return this.call("Edit", { file_path: file, old_string: oldS, new_string: newS }, { out: "The file has been updated", ...o });
  }
  write(file: string, content: string, o: CallOpts = {}) {
    return this.call("Write", { file_path: file, content }, { out: o.created ? "File created successfully at: " + file : "The file has been updated", ...o });
  }
  todo(items: [string, "pending" | "in_progress" | "completed"][]) {
    return this.call("TodoWrite", { todos: items.map(([content, status]) => ({ content, status, activeForm: content })) }, { out: "ok" });
  }
}

export const cfgWith = (raw: unknown) => resolveConfig(raw);

export const PYTEST_FAIL = (n = 1) => `============ test session starts ============
collected 3 items

tests/test_a.py F

E   AssertionError: expected 4 got ${n + 1}
FAILED tests/test_a.py::test_x - AssertionError
=========== 1 failed, 2 passed in 0.3${n}s ===========`;
export const PYTEST_PASS = "=========== 3 passed in 0.31s ===========";
