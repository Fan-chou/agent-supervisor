// 作弊 / 危险：X1、X2（design §5.5）。
import { x2Check } from "../x2.ts";
import { isTestPath, type SessionTracker } from "../session.ts";
import { mkHit, ruleDisabled, type Detector } from "./types.ts";

const SKIP_RE = /\b(xfail|skipIf|skipUnless|xit|xdescribe|xtest)\b|\.skip\b|\bpytest\.mark\.skip|\bunittest\.skip|\bt\.Skip(f|Now)?\(|@Disabled|@Ignore|\bit\.todo\b|\btest\.todo\b|\.only\s*\(|\bfit\(|\bfdescribe\(/g;
const ASSERT_RE = /\b(assert\w*|expect\s*\(|should\b|assert_eq!|assert_ne!|assert!|require\.\w+|XCTAssert\w*|t\.(Error|Errorf|Fatal|Fatalf|Fail))\b/g;
const ASSERT_LINE = /\b(assert\w*|expect\s*\(|should\b|assert_eq!|assert!|require\.\w+|XCTAssert\w*)/;

const count = (re: RegExp, s: string) => (s.match(re) ?? []).length;

/** 用户意图是写测试、修 flaky、更新快照、基准、修 CI 时，X1/T 组降级。 */
export const TEST_INTENT_RE = /写测试|加测试|补测试|新增测试|添加测试|增加测试|测试用例|修复?(?:\s*)测试|flaky|不稳定|快照|snapshot|基准|benchmark|\bwrite (?:the )?(?:unit |integration |e2e )?tests?\b|\badd (?:unit |integration |e2e )?tests?\b|\bfix (?:the |a )?(?:failing |broken |flaky )?tests?\b|\bupdate (?:the )?snapshots?\b|\bfix (?:the )?ci\b|修\s*ci|修复\s*ci|ci\s*(?:失败|挂了|报错)/i;

export function hasTestIntent(s: SessionTracker): boolean {
  if (TEST_INTENT_RE.test(s.currentIntent())) return true;
  const plan = s.effectivePlan();
  const cur = plan?.items.find((i) => i.status === "in_progress")?.text ?? "";
  return TEST_INTENT_RE.test(cur);
}

export const X1: Detector = (e, ctx) => {
  if (e.phase !== "post" || !e.edit || ruleDisabled(ctx, "X1")) return [];
  const { s } = ctx;
  const cur = s.last();
  if (!cur || cur.seq !== e.seq || cur.status === "fail") return [];
  const testFiles = e.edit.files.filter(isTestPath);
  if (testFiles.length === 0) return [];
  const oldText = e.edit.oldText ?? "";
  const newText = e.edit.newText ?? "";
  const reasons: string[] = [];
  const skipsAdded = count(SKIP_RE, newText) - count(SKIP_RE, oldText);
  if (skipsAdded > 0) reasons.push("加了 skip/xfail/.only");
  if (!e.edit.created) {
    const aOld = count(ASSERT_RE, oldText);
    const aNew = count(ASSERT_RE, newText);
    if (oldText && aOld > aNew) reasons.push(`断言从 ${aOld} 处减到 ${aNew} 处`);
    // 上一次测试失败、之后没改过源码、现在改了测试里的断言行 → 疑似把期望值改成实际输出
    const lastRun = s.testRuns[s.testRuns.length - 1];
    if (lastRun && lastRun.status === "fail") {
      const sourceEditedSince = s.steps.slice(lastRun.stepIdx + 1, cur.idx).some((x) => x.isEdit && x.editedFiles.some((f) => !isTestPath(f)));
      const changedAssertLines = oldText && newText && oldText !== newText && (oldText.split("\n").some((l) => ASSERT_LINE.test(l)) || newText.split("\n").some((l) => ASSERT_LINE.test(l)));
      if (!sourceEditedSince && changedAssertLines && aNew <= aOld) reasons.push("上次测试失败后没改源码，只改了测试里的断言");
    }
  }
  if (reasons.length === 0) return [];
  const exempt = hasTestIntent(s);
  return [
    mkHit(e, ctx, {
      ruleId: "X1",
      sev: exempt ? "L" : "M",
      category: "test_gaming",
      key: `X1:${testFiles.join(",")}:${reasons.join("|")}`,
      detail: { files: testFiles, reasons, exempt },
      message: exempt ? undefined : `测试文件 ${s.rel(testFiles[0])} 的改动看起来是在让测试通过：${reasons.join("；")}。`,
    }),
  ];
};

/** X2：在 pre 阶段同步判定，本地拦截，不问 judge，不受连续拦截上限约束。 */
export const X2: Detector = (e, ctx) => {
  if (e.phase !== "pre" || ruleDisabled(ctx, "X2")) return [];
  const { s } = ctx;
  const r = x2Check({
    harness: e.harness,
    command: e.shell?.cmd,
    files: e.edit?.files,
    cwd: s.cwd,
  });
  if (!r) return [];
  return [
    mkHit(e, ctx, {
      ruleId: "X2",
      sev: "H",
      category: "unsafe",
      explicit: true,
      blockable: true,
      key: `X2:${r.category}:${r.subject}`,
      detail: { category: r.category, subject: r.subject, action: r.action },
      message: r.reason,
      x2: { action: r.action, category: r.category },
    }),
  ];
};

export const cheatDetectors: Detector[] = [X1, X2];
