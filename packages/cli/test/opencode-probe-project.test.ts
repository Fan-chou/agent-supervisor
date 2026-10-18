import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROBE_MARKER, checkProbeDir, probeFiles, probePlan, runOpencodeProbeProject } from "../src/opencode-probe-project.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "sv-pp-"));
  dirs.push(d);
  return d;
};
const REPO = "/fake/repo/agent-supervisor";

describe("sv opencode-probe-project（测试项目准备；decisions #113）", () => {
  test("目录检查：拒绝 ~、~/.config 及其子目录、~/.claude/.codex/.agent-supervisor、仓库内、含 .env、非空的陌生目录；带标记的旧测试项目和空目录通过", () => {
    const home = "/Users/x";
    const ok = (d: string, o: Partial<Parameters<typeof checkProbeDir>[1]> = {}) => checkProbeDir(d, { home, repoRoot: REPO, exists: () => false, ...o });
    expect(ok("/Users/x/dev/probe")).toEqual([]);
    expect(ok("/Users/x").length).toBeGreaterThan(0);
    for (const bad of ["/Users/x/.config", "/Users/x/.config/opencode", "/Users/x/.config/opencode/plugins", "/Users/x/.claude/p", "/Users/x/.codex", "/Users/x/.agent-supervisor/p", REPO, REPO + "/sub", "/Users/x/proj/.env/p"]) expect(ok(bad).length, bad).toBeGreaterThan(0);
    expect(ok("/Users/x/other", { exists: () => true, list: () => ["a.txt"] }).length).toBeGreaterThan(0);
    expect(ok("/Users/x/other", { exists: () => true, list: () => [] })).toEqual([]);
    expect(ok("/Users/x/other", { exists: () => true, list: () => ["a.txt", PROBE_MARKER] })).toEqual([]);
  });
  test("文件清单：只项目级配置（opencode.json 的 plugins 指向项目内插件）；脚本用项目内 SV_HOME；observe 不设 ENFORCE；探针脚本只在 probe 里；任何文件都不引用 ~/.config", () => {
    const files = probeFiles({ repoRoot: REPO, pluginSource: "// plugin" });
    const by = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(JSON.parse(by["opencode.json"].content)).toEqual({ plugins: ["./.opencode/plugins/agent-supervisor.ts"] });
    expect(by[".opencode/plugins/agent-supervisor.ts"].content).toContain("// plugin");
    for (const n of ["start-daemon.sh", "run-observe.sh", "run-probe.sh", "report.sh"]) {
      expect(by[n].mode).toBe(0o755);
      expect(by[n].content).toContain('SV_HOME="$PWD/.sv-home"');
    }
    expect(by["run-observe.sh"].content).not.toContain("SV_OPENCODE_PROBE");
    expect(by["run-probe.sh"].content).toContain("SV_OPENCODE_PROBE=sv-probe-deny");
    expect(by["start-daemon.sh"].content).toContain("--mode shadow");
    for (const f of files) {
      expect(f.content, f.path).not.toMatch(/SV_OPENCODE_ENFORCE=|export SV_OPENCODE_ENFORCE/);
      if (f.path.endsWith(".sh")) expect(f.content, f.path).toContain("unset SV_OPENCODE_ENFORCE");
      expect(f.content, f.path).not.toContain(".config/opencode");
    }
  });
  test("计划文本提到全部步骤并声明不碰全局配置；默认 dry-run 不创建任何东西", async () => {
    const plan = probePlan("/Users/x/dev/probe", REPO).join("\n");
    for (const w of ["start-daemon.sh", "run-observe.sh", "run-probe.sh", "report.sh", "touch /tmp/sv-probe-deny", "不碰 ~/.config/opencode"]) expect(plan).toContain(w);
    const base = tmp();
    const d = join(base, "probe");
    const r = await runOpencodeProbeProject([d], {}, { repoRoot: REPO, home: tmp() });
    expect(r.code).toBe(0);
    expect(r.lines.join("\n")).toContain("dry-run");
    expect(existsSync(d)).toBe(false);
  });
  test("--apply：在目录里创建文件（脚本可执行、插件是打包后的自包含文件）、git 初始化一次提交；重复 apply 不动 .git；陌生非空目录被拒绝", async () => {
    const base = tmp();
    const d = join(base, "probe");
    const o = { repoRoot: REPO, home: tmp() };
    const r = await runOpencodeProbeProject([d], { apply: true }, o);
    expect(r.code).toBe(0);
    expect(readdirSync(d).sort()).toEqual([".git", ".opencode", ".sv-probe-project", "README.md", "opencode.json", "report.sh", "run-observe.sh", "run-probe.sh", "start-daemon.sh"].sort());
    expect(statSync(join(d, "run-observe.sh")).mode & 0o111).not.toBe(0);
    const plugin = readFileSync(join(d, ".opencode/plugins/agent-supervisor.ts"), "utf8");
    expect(plugin).toContain("agent-supervisor");
    expect(plugin).not.toContain("../../core/src"); // x2Check / redactDeep 已内联
    expect(Bun.spawnSync(["git", "log", "--oneline"], { cwd: d }).stdout.toString()).toContain("probe project");
    expect((await runOpencodeProbeProject([d], { apply: true }, o)).code).toBe(0);
    const stranger = join(base, "stranger");
    mkdirSync(stranger);
    writeFileSync(join(stranger, "x.txt"), "x");
    const bad = await runOpencodeProbeProject([stranger], { apply: true }, o);
    expect(bad.code).toBe(2);
    expect(readdirSync(stranger)).toEqual(["x.txt"]);
  });
});
