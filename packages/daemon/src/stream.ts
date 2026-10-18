// GET /v1/stream（frontend-design §10.1）：只读的增量推送。
// - 每条消息 {streamId, type, ts, …}；streamId 形如 "<epoch>.<n>"（epoch = 守护进程启动时间的 36 进制），n 单调递增。
// - 有上限的环形缓冲：重连带 ?since=<streamId>（或 SSE 的 Last-Event-ID）即可续上；since 已被挤出、或来自上一个守护进程（epoch 不同）时，先发 `reset`，客户端丢弃增量状态并重新拉取各列表。
// - 心跳默认每 15 秒一条；订阅过滤 ?sessions=a,b&types=event,hit。
// - 消息只带「发生了什么、在哪个会话」的轻量字段，细节让客户端用 REST 查（timeline?since_seq= 等），所以这里永远不放命令正文/输出。
// - publish 永远不抛异常、不阻塞 hook 路径；慢订阅者（队列堆满）直接断开，它重连时会按游标补上或收到 reset。

export type StreamType = "session" | "event" | "hit" | "decision" | "delivery" | "status" | "heartbeat" | "reset";

export interface StreamMessage {
  streamId: string;
  type: StreamType;
  ts: number;
  sessionId?: string;
  [k: string]: unknown;
}

export interface StreamFilter {
  sessions?: Set<string>;
  types?: Set<StreamType>;
}

export type StreamFormat = "sse" | "ndjson";

const BUFFER_CAP = 2000;
const QUEUE_CAP = 1000;

export class StreamHub {
  private buf: StreamMessage[] = [];
  private n = 0;
  private readonly subs = new Set<(m: StreamMessage) => void>();
  readonly epoch: string;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly opts: { heartbeatMs?: number; bufferCap?: number } = {},
    epochSeed: number = now(),
  ) {
    this.epoch = epochSeed.toString(36);
  }

  get lastId(): string {
    return `${this.epoch}.${this.n}`;
  }
  get subscribers(): number {
    return this.subs.size;
  }

  /** 发布一条消息（缓冲 + 广播）。永不抛异常。 */
  publish(type: Exclude<StreamType, "heartbeat" | "reset" | "status">, fields: { sessionId?: string; [k: string]: unknown }): void {
    try {
      const m: StreamMessage = { streamId: `${this.epoch}.${++this.n}`, type, ts: this.now(), ...fields };
      this.buf.push(m);
      const cap = this.opts.bufferCap ?? BUFFER_CAP;
      if (this.buf.length > cap) this.buf.splice(0, this.buf.length - cap);
      for (const s of [...this.subs]) {
        try {
          s(m);
        } catch {
          this.subs.delete(s);
        }
      }
    } catch {
      /* 推送失败不影响监督 */
    }
  }

  /** 解析游标："<epoch>.<n>"；格式不对返回 null。 */
  private parse(id: string): { epoch: string; n: number } | null {
    const m = /^([0-9a-z]+)\.(\d+)$/.exec(id);
    return m ? { epoch: m[1], n: Number(m[2]) } : null;
  }

  /** 游标之后的缓冲消息；缓冲已经覆盖不到（被挤出 / 别的 epoch / 游标非法）返回 null，表示需要 reset。 */
  replayFrom(since: string): StreamMessage[] | null {
    const c = this.parse(since);
    if (!c || c.epoch !== this.epoch || c.n > this.n) return null;
    if (c.n === this.n) return [];
    const first = this.buf.length ? Number(this.buf[0].streamId.split(".")[1]) : this.n + 1;
    if (c.n + 1 < first) return null;
    return this.buf.filter((m) => Number(m.streamId.split(".")[1]) > c.n);
  }

  static match(m: StreamMessage, f: StreamFilter): boolean {
    if (f.types && !f.types.has(m.type)) return false;
    if (f.sessions && m.sessionId !== undefined && !f.sessions.has(m.sessionId)) return false;
    if (f.sessions && m.sessionId === undefined && m.type !== "status") return false;
    return true;
  }

  /** 打开一个订阅流。first = 连接后立刻发送的 status 快照（不进缓冲，没有 streamId 游标语义）。 */
  open(o: { since?: string; filter?: StreamFilter; format: StreamFormat; first?: () => Record<string, unknown>; signal?: AbortSignal }): Response {
    const enc = new TextEncoder();
    const filter = o.filter ?? {};
    const format = o.format;
    const frame = (m: StreamMessage) => enc.encode(format === "sse" ? `id: ${m.streamId}\nevent: ${m.type}\ndata: ${JSON.stringify(m)}\n\n` : JSON.stringify(m) + "\n");
    let unsub: ((m: StreamMessage) => void) | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const cleanup = () => {
      if (unsub) this.subs.delete(unsub);
      unsub = undefined;
      if (timer) clearInterval(timer);
      timer = undefined;
    };
    const body = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          const send = (m: StreamMessage) => {
            if (controller.desiredSize !== null && controller.desiredSize <= 0) {
              // 订阅者读得太慢：断开，它会带着游标重连
              cleanup();
              try {
                controller.close();
              } catch {
                /* 已关闭 */
              }
              return;
            }
            controller.enqueue(frame(m));
          };
          // 订阅先于回放登记，回放期间到达的新消息不会丢（按 streamId 去重）
          const pending: StreamMessage[] = [];
          let replaying = true;
          let maxSent = -1;
          const idx = (m: StreamMessage) => Number(m.streamId.split(".")[1]);
          unsub = (m) => {
            if (!StreamHub.match(m, filter)) return;
            if (replaying) pending.push(m);
            else if (idx(m) > maxSent) (send(m), (maxSent = idx(m)));
          };
          this.subs.add(unsub);
          if (o.first) {
            try {
              send({ streamId: this.lastId, type: "status", ts: this.now(), ...o.first() });
            } catch {
              /* 快照失败不影响流 */
            }
          }
          if (o.since) {
            const back = this.replayFrom(o.since);
            if (back === null) send({ streamId: this.lastId, type: "reset", ts: this.now(), reason: "cursor_expired" });
            else for (const m of back) if (StreamHub.match(m, filter)) (send(m), (maxSent = Math.max(maxSent, idx(m))));
          }
          replaying = false;
          for (const m of pending) if (idx(m) > maxSent) (send(m), (maxSent = idx(m)));
          const hb = this.opts.heartbeatMs ?? 15_000;
          timer = setInterval(() => {
            try {
              send({ streamId: this.lastId, type: "heartbeat", ts: this.now() });
            } catch {
              cleanup();
            }
          }, hb);
          o.signal?.addEventListener("abort", () => {
            cleanup();
            try {
              controller.close();
            } catch {
              /* 已关闭 */
            }
          });
        },
        cancel: () => cleanup(),
      },
      { highWaterMark: QUEUE_CAP },
    );
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": format === "sse" ? "text/event-stream" : "application/x-ndjson",
        "cache-control": "no-cache",
        "x-accel-buffering": "no",
      },
    });
  }

  close(): void {
    this.subs.clear();
  }
}
