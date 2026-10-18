// 并发测试的工人进程：反复原子领取 outbox，确认投递，最后把自己拿到的 id 打印出来。
// 用法：bun claim-worker.ts <db> <claimer> <session> [leaseMs]
import { LogStore, Outbox } from "../../src/index.ts";

const [dbPath, claimer, session, lease] = process.argv.slice(2);
const store = new LogStore(dbPath);
const outbox = new Outbox(store);
const got: number[] = [];
const rejected: number[] = [];
for (;;) {
  const row = outbox.claim({ sessionId: session, claimer, leaseMs: Number(lease ?? 60_000) });
  if (!row) break;
  if (outbox.markDelivered(row.id, claimer, "worker")) got.push(row.id);
  else rejected.push(row.id);
}
console.log(JSON.stringify({ claimer, got, rejected }));
store.close();
