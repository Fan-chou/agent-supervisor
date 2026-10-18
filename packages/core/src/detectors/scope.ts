// 范围 / 计划：P1–P6（design §5.4）。
import { analyzeShell } from "../cmdclass.ts";
import { currentStep, matchesAllow, pathsInText } from "../plan.ts";
import { isSourcePath, isTestPath, type SessionTracker } from "../session.ts";
import { mkHit, ruleDisabled, type Detector } from "./types.ts";

const SUPERVISOR_FILES = /(^|\/)\.supervisor\//;
const BUILD_DIR = /(^|\/)(node_modules|dist|build|\.next|target|__pycache__|\.venv|venv|coverage|\.pytest_cache|out|\.turbo|\.cache|tmp)(\/|$)/;

function editedFilesOf(e: Parameters<Detector>[0], s: SessionTracker): string[] {
  const files = [...(e.edit?.files ?? [])];
  if (e.shell && e.phase !== "session") {
    const a = s.analyze(e.shell.cmd);
    if (a.mutating) files.push(...a.targets.filter((t) => !/^(\/tmp\/|\/dev\/)/.test(t)));
  }
  return [...new Set(files)];
}

export const P1: Detector = (e, ctx) => {
  if (e.phase !== "pre" || ruleDisabled(ctx, "P1") || ctx.cfg.plan.source === "off") return [];
  const { s } = ctx;
  const plan = s.effectivePlan();
  if (!plan) return [];
  const files = editedFilesOf(e, s).map((f) => s.rel(f)).filter((f) => !SUPERVISOR_FILES.test(f) && !f.startsWith("/tmp/"));
  if (files.length === 0) return [];
  const explicit = plan.source === "file" && plan.explicitAllow.length > 0;
  let allowed: string[];
  if (explicit) allowed = plan.explicitAllow;
  else {
    const cur = currentStep(plan);
    if (!cur) return []; // 没有当前步骤：无法判断
    const fromText = pathsInText(cur.text);
    if (fromText.length === 0) return []; // 步骤文本里没有路径：自动提取不可靠，不报
    allowed = [...fromText, ...[...s.stepTouched].map((f) => s.rel(f))];
  }
  const outside = files.filter((f) => !allowed.some((g) => matchesAllow(f, g)));
  if (outside.length === 0) return [];
  return [
    mkHit(e, ctx, {
      ruleId: "P1",
      sev: explicit ? "H" : "M",
      category: "scope",
      explicit,
      blockable: explicit,
      key: `P1:${outside.join(",")}`,
      detail: { files: outside, allow: allowed.slice(0, 10), explicit },
      message: `计划${explicit ? "（plan.md 的 allow）" : "当前步骤"}允许的范围不包含：${outside.slice(0, 3).join("、")}。`,
    }),
  ];
};

export const P2: Detector = (e, ctx) => {
  if (e.phase !== "pre" || ruleDisabled(ctx, "P2") || e.harness === "claude") return [];
  const { s } = ctx;
  if (!e.edit || e.edit.created) return [];
  const out = [];
  for (const f of e.edit.files) {
    if (s.readFileSet.has(f) || s.createdFiles.has(f) || /^\/tmp\//.test(f) || s.edits.has(f)) continue;
    out.push(mkHit(e, ctx, { ruleId: "P2", sev: "L", category: "scope", key: `P2:${f}`, detail: { file: f } }));
  }
  return out;
};

export const P3: Detector = (e, ctx) => {
  if (e.phase !== "stop" || ruleDisabled(ctx, "P3")) return [];
  const { s } = ctx;
  if (s.lastEditStepIdx < 0) return [];
  // 最后一次编辑之后是否跑过相关测试、targeted 测试或构建
  if (s.lastVerifyStepIdx > s.lastEditStepIdx) return [];
  // 只改文档/配置不要求测试
  const editedSince = s.steps.filter((x) => x.isEdit && x.idx > Math.max(s.lastVerifyStepIdx, -1)).flatMap((x) => x.editedFiles);
  if (editedSince.length > 0 && !editedSince.some((f) => isSourcePath(f) || isTestPath(f))) return [];
  return [
    mkHit(e, ctx, {
      ruleId: "P3",
      sev: "M",
      category: "premature_done",
      blockable: true,
      key: `P3:${s.lastEditStepIdx}`,
      detail: { lastEditSeq: s.steps[s.lastEditStepIdx].seq, files: [...new Set(editedSince)].slice(0, 5) },
      message: "最后一次编辑之后没有运行过相关测试、targeted 测试或构建。",
    }),
  ];
};

export const P4: Detector = (e, ctx) => {
  if (e.phase !== "post" || ruleDisabled(ctx, "P4")) return [];
  const { s, cfg } = ctx;
  if (!s.effectivePlan() || cfg.plan.source === "off") return []; // 没有计划时停用
  const cur = s.last();
  if (!cur || cur.seq !== e.seq || !cur.isEdit) return [];
  if (s.editCount % cfg.detect.p4_every_edits !== 0) return [];
  return [mkHit(e, ctx, { ruleId: "P4", sev: "M", category: "drift", key: `P4:${s.editCount}`, detail: { sample: true, edits: s.editCount } })];
};

const DEP_MANIFESTS = /(^|\/)(package\.json|pyproject\.toml|requirements[^/]*\.txt|go\.mod|Cargo\.toml|Gemfile|Pipfile|composer\.json|build\.gradle(\.kts)?|pom\.xml)$/;
const DEP_LOCKS = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|poetry\.lock|uv\.lock|go\.sum|Cargo\.lock|Gemfile\.lock|composer\.lock)$/;
const INSTALL_RE = /^(npm|pnpm|yarn|bun)\s+(add|install|i)\s+\S|^(pip3?|uv pip)\s+install\s+(?!-r|-e\s*\.|\.)\S|^uv add\s|^cargo add\s|^go get\s|^poetry add\s|^pipenv install\s+\S|^gem install\s|^composer require\s/;

export const P5: Detector = (e, ctx) => {
  if (e.phase !== "post" || ruleDisabled(ctx, "P5")) return [];
  const { s } = ctx;
  const cur = s.last();
  if (!cur || cur.seq !== e.seq || cur.status === "fail") return [];
  const subjects: string[] = [];
  for (const f of cur.editedFiles) {
    if (DEP_MANIFESTS.test(f) && !DEP_LOCKS.test(f)) subjects.push(f);
  }
  if (cur.normCmd) {
    for (const seg of analyzeShell(e.shell?.cmd ?? "").segments) {
      const joined = seg.argv.join(" ");
      if (INSTALL_RE.test(joined)) subjects.push(joined.split(/\s+/).slice(0, 4).join(" "));
    }
  }
  if (subjects.length === 0) return [];
  const plan = s.effectivePlan();
  const text = (plan?.text ?? "").toLowerCase();
  const mentioned = plan ? subjects.some((x) => text.includes(x.split("/").pop()!.toLowerCase()) || /依赖|dependenc|install|安装|add package|引入/.test(text) || x.split(/\s+/).slice(2).some((p) => p && text.includes(p.toLowerCase()))) : false;
  const sev = plan && !mentioned ? "M" : "L";
  return [
    mkHit(e, ctx, {
      ruleId: "P5",
      sev,
      category: "scope",
      key: `P5:${subjects.join("|")}`,
      detail: { subjects, planMentions: mentioned },
      message: sev === "M" ? `新增或修改了依赖（${subjects[0]}），计划里没有提到。` : undefined,
    }),
  ];
};

export const P6: Detector = (e, ctx) => {
  if (e.phase !== "post" || ruleDisabled(ctx, "P6")) return [];
  const { s, cfg } = ctx;
  const cur = s.last();
  if (!cur || cur.seq !== e.seq || cur.status === "fail") return [];
  const edit = e.edit;
  const deleted: string[] = [];
  let lines = 0;
  if (edit?.deletedFile) deleted.push(...edit.files);
  if ((edit?.deletedLines ?? 0) - (edit?.addedLines ?? 0) >= cfg.detect.p6_deleted_lines) lines = (edit!.deletedLines ?? 0) - (edit!.addedLines ?? 0);
  if (e.shell?.cmd) {
    for (const seg of s.analyze(e.shell.cmd).segments) {
      const base = seg.argv[0]?.replace(/^.*\//, "");
      if ((base === "rm" || (base === "git" && seg.argv[1] === "rm")) && !seg.argv.some((a) => a === "-n")) {
        deleted.push(...seg.targets.filter((t) => !BUILD_DIR.test(t) && !/^(\/tmp\/|\/dev\/)/.test(t) && /[./]/.test(t)));
      }
    }
  }
  if (deleted.length === 0 && lines === 0) return [];
  return [
    mkHit(e, ctx, {
      ruleId: "P6",
      sev: "M",
      category: "scope",
      key: `P6:${deleted.join(",")}:${lines}`,
      detail: { deletedFiles: deleted, netDeletedLines: lines },
      message: deleted.length ? `删除了文件：${deleted.slice(0, 3).join("、")}。` : `单次净删除 ${lines} 行。`,
    }),
  ];
};

export const scopeDetectors: Detector[] = [P1, P2, P3, P4, P5, P6];
