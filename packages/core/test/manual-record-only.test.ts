// decisions #100/#104：人工处理（manual_allow / manual_reject）只记录一笔，永远不影响实时策略和之后的判断。
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { LogStore, StoreSink, beginRun, defaultConfig } from "../src/index.ts";
import { PYTEST_FAIL, PYTEST_PASS, Sim } from "./sim.ts";

const ROOT = join(import.meta.dir, "../../..");

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n === "test") continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("manual_* 只记录", () => {
  test("源码里只有写入点（store 的类型、CLI 的 sv override（在 stats.ts））提到 manual_allow / manual_reject；策略、检测器、daemon、hook、适配器都不读", () => {
    const hits = walk(join(ROOT, "packages"))
      .filter((f) => /manual_(allow|reject)/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(ROOT.length + 1))
      .sort();
    expect(hits).toEqual(["packages/cli/src/stats.ts", "packages/core/src/store/store.ts"]);
  });

  async function run(withManual: boolean) {
    const store = new LogStore(":memory:");
    const cfg = defaultConfig();
    const runId = beginRun(store, cfg, { kind: "replay", label: "t" });
    const sink = new StoreSink(store, { runId });
    const sim = new Sim({ cfg, sink });
    await sim.start();
    await sim.prompt("请修一下");
    for (let i = 0; i < 4; i++) {
      await sim.bash("pytest tests/a.py", { out: PYTEST_FAIL(1), fail: true });
      if (withManual) {
        const dec = store.db.query("SELECT id, hit_id, session_id FROM decisions ORDER BY id DESC LIMIT 1").get() as { id: number; hit_id: number; session_id: string } | null;
        if (dec) {
          store.insertOverride({ runId, sessionId: dec.session_id, kind: i % 2 ? "manual_reject" : "manual_allow", targetType: "decision", targetId: dec.id, note: "人工处理" });
          store.insertOverride({ runId, sessionId: dec.session_id, kind: "manual_allow", targetType: "hit", targetId: dec.hit_id });
        }
      }
    }
    for (let i = 0; i < 3; i++) await sim.bash("pytest -q", { out: PYTEST_PASS });
    await sim.bash("git reset --hard HEAD~1");
    sink.close();
    const q = (sql: string) => store.db.query(sql).all();
    return {
      hits: q("SELECT rule_id, sev, seq, phase FROM hits ORDER BY id"),
      decisions: q("SELECT rule_id, action, applied, outcome, suppressed_by FROM decisions ORDER BY id"),
      manual: (store.db.query("SELECT COUNT(*) AS n FROM overrides WHERE kind IN ('manual_allow','manual_reject')").get() as { n: number }).n,
    };
  }

  test("同一段会话：先后记录若干 manual_*，之后的命中和决策序列与不记录时逐条相同（包括 would_have_blocked 的危险命中）", async () => {
    const a = await run(false);
    const b = await run(true);
    expect(a.hits.length).toBeGreaterThan(3);
    expect(a.decisions.some((d: any) => d.outcome === "would_have_blocked")).toBe(true);
    expect(b.manual).toBeGreaterThan(0);
    expect(a.manual).toBe(0);
    expect(b.hits).toEqual(a.hits);
    expect(b.decisions).toEqual(a.decisions);
  });
});
