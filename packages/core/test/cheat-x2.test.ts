import { describe, expect, test } from "bun:test";
import { x2Check, classifyWritePath } from "../src/x2.ts";
import { PYTEST_FAIL, PYTEST_PASS, Sim, cfgWith } from "./sim.ts";

const HOME = "/Users/jack";
const CWD = "/Users/jack/proj";
const sh = (command: string, harness: "claude" | "codex" | "opencode" = "claude") => x2Check({ harness, command, cwd: CWD, home: HOME });
const wr = (files: string[], harness: "claude" | "codex" | "opencode" = "claude") => x2Check({ harness, files, cwd: CWD, home: HOME });

describe("X2 危险操作", () => {
  test("写 .env* 但 .env.example/.env.sample 豁免", () => {
    expect(wr([".env"])?.category).toBe("env");
    expect(wr(["/Users/jack/proj/.env.local"])?.category).toBe("env");
    expect(wr([".env.production"])?.category).toBe("env");
    expect(wr([".env.example"])).toBeNull();
    expect(wr(["config/.env.sample"])).toBeNull();
    expect(wr(["src/environment.ts"])).toBeNull();
  });
  test("*.pem / *.key", () => {
    expect(wr(["certs/server.pem"])?.category).toBe("key");
    expect(wr(["id_rsa.key"])?.category).toBe("key");
    expect(wr(["keyboard.ts"])).toBeNull();
  });
  test("CI 配置", () => {
    for (const f of [".github/workflows/ci.yml", ".gitlab-ci.yml", ".circleci/config.yml", "Jenkinsfile", "azure-pipelines.yml", "sub/.github/workflows/x.yaml"]) {
      expect(wr([f])?.category).toBe("ci");
    }
    expect(wr([".github/CODEOWNERS"])).toBeNull();
  });
  test("动作：Claude 上 CI/.env 用 ask，其余 deny；Codex/OpenCode 一律 deny", () => {
    expect(wr([".github/workflows/ci.yml"], "claude")?.action).toBe("ask");
    expect(wr([".env"], "claude")?.action).toBe("ask");
    expect(wr(["a.pem"], "claude")?.action).toBe("deny");
    expect(wr([".github/workflows/ci.yml"], "codex")?.action).toBe("deny");
    expect(wr([".env"], "opencode")?.action).toBe("deny");
    expect(sh("git reset --hard", "claude")?.action).toBe("deny");
  });
  test("shell 写入这些文件也算", () => {
    expect(sh("echo KEY=1 > .env")?.category).toBe("env");
    expect(sh("cat x >> .env.local")?.category).toBe("env");
    expect(sh("sed -i 's/a/b/' .github/workflows/ci.yml")?.category).toBe("ci");
    expect(sh("tee certs/a.pem < x")?.category).toBe("key");
    expect(sh("cat .env")).toBeNull(); // 只读不拦
    expect(sh("echo hi > .env.example")).toBeNull();
  });
  test("rm -rf：仓库外/$HOME 拦，/tmp 和构建产物豁免", () => {
    expect(sh("rm -rf /")?.category).toBe("rm");
    expect(sh("rm -rf ~")?.category).toBe("rm");
    expect(sh("rm -rf $HOME")?.category).toBe("rm");
    expect(sh("rm -rf ~/*")?.category).toBe("rm");
    expect(sh("rm -rf /Users/jack/other-project")?.category).toBe("rm");
    expect(sh("rm -rf ../sibling")?.category).toBe("rm");
    expect(sh("rm -rf /etc/foo")?.category).toBe("rm");
    expect(sh("rm -rf .git")?.category).toBe("rm");
    expect(sh("rm -rf .")?.category).toBe("rm");
    expect(sh("rm -rf /tmp/build-123")).toBeNull();
    expect(sh("rm -rf /private/tmp/x")).toBeNull();
    expect(sh("rm -rf node_modules dist .next")).toBeNull();
    expect(sh("rm -rf build/")).toBeNull();
    expect(sh("rm -rf /Users/jack/proj/target")).toBeNull();
    expect(sh("rm -f a.txt")).toBeNull(); // 非递归
    expect(sh("rm -rf $BUILD_DIR/out")).toBeNull(); // 未解析变量：尽力而为
  });
  test("破坏性 git 命令", () => {
    for (const c of ["git push --force", "git push -f origin main", "git push origin +main", "git reset --hard HEAD~1", "git checkout -- .", "git checkout .", "git restore .", "git clean -fdx", "git clean -f", "git stash drop", "git stash clear", "git -C sub reset --hard"]) {
      expect(sh(c)?.category).toBe("git");
    }
    for (const c of ["git push", "git push --force-with-lease", "git reset --soft HEAD~1", "git reset", "git checkout main", "git checkout -b x", "git restore --staged .", "git restore src/a.py", "git clean -n", "git clean -nd", "git stash", "git stash pop", "git stash list", "git status"]) {
      expect(sh(c)).toBeNull();
    }
  });
  test("链式命令里的危险段也能识别（bash -c / && ）", () => {
    expect(sh("cd x && git reset --hard")?.category).toBe("git");
    expect(sh("bash -c 'git push --force origin main'")?.category).toBe("git");
    expect(sh("pytest && rm -rf ~")?.category).toBe("rm");
  });
  test("classifyWritePath", () => {
    expect(classifyWritePath("a/b/.env")).toBe("env");
    expect(classifyWritePath("a/b/.envrc")).toBeNull();
  });
});

describe("X2 在 pre 阶段：本地拦截，不受连续拦截上限约束", () => {
  test("enforce：连续 5 次 X2 全部拦截（上限只管 judge/计数类规则）", async () => {
    const s = new Sim({ cwd: CWD, cfg: cfgWith({ mode: "enforce" }) });
    for (let i = 0; i < 5; i++) {
      const [pre] = await s.bash("git reset --hard");
      const d = pre.decisions.find((x) => x.hit.ruleId === "X2");
      expect(d?.action).toBe("block");
      expect(d?.applied).toBe(true);
    }
  });
  test("shadow：X2 照样产生 block/ask 动作供观察，但 applied=false（不生效）", async () => {
    const s = new Sim({ cwd: CWD });
    const [pre] = await s.bash("git reset --hard");
    const d = pre.decisions.find((x) => x.hit.ruleId === "X2");
    expect(d?.action).toBe("block");
    expect(d?.applied).toBe(false);
    const a = new Sim({ cwd: CWD, cfg: cfgWith({ mode: "advise" }) });
    expect((await a.bash("git reset --hard"))[0].decisions.find((x) => x.hit.ruleId === "X2")?.applied).toBe(false);
  });
  test("Claude 写 .env → ask", async () => {
    const s = new Sim({ cwd: CWD });
    const [pre] = await s.write("/Users/jack/proj/.env", "A=1");
    expect(pre.decisions.find((x) => x.hit.ruleId === "X2")?.action).toBe("ask");
  });
  test("judge 不能降级 X2：即使有 judge，X2 也不会被送去判断", async () => {
    const calls: unknown[] = [];
    const s = new Sim({ cwd: CWD, judge: async (r) => (calls.push(r), { kind: "ok", out: { verdict: "ignore", confidence: 1, category: "unsafe", message_to_agent: null, reason: "", evidence_steps: [], watch: [], done: false } }) });
    const [pre] = await s.bash("git push --force");
    expect(pre.decisions.find((x) => x.hit.ruleId === "X2")?.action).toBe("block");
    expect(calls).toHaveLength(0);
  });
  test("规则配置 action 为 off 时只记录", async () => {
    const { cfgWith } = await import("./sim.ts");
    const s = new Sim({ cwd: CWD, cfg: cfgWith({ rules: { X2_dangerous: { action: "off" } } }) });
    const [pre] = await s.bash("git reset --hard");
    expect(pre.hits.some((h) => h.ruleId === "X2")).toBe(false);
  });
});

describe("X1 改测试让它通过", () => {
  const T = "/work/proj/tests/test_a.py";
  test("加 skip/xfail → M", async () => {
    const s = new Sim();
    await s.prompt("fix the bug in parser");
    await s.edit(T, "def test_x():\n    assert f() == 1", "@pytest.mark.skip\ndef test_x():\n    assert f() == 1");
    const h = s.hitsOf("X1");
    expect(h).toHaveLength(1);
    expect(h[0].sev).toBe("M");
  });
  test("删断言 → M", async () => {
    const s = new Sim();
    await s.prompt("fix the bug");
    await s.edit(T, "    assert a == 1\n    assert b == 2", "    pass");
    expect(s.hitsOf("X1")[0]?.sev).toBe("M");
  });
  test("加 .only", async () => {
    const s = new Sim();
    await s.prompt("fix the bug");
    await s.edit("/work/proj/src/a.test.ts", "it('a', () => {})", "it.only('a', () => {})");
    expect(s.hitsOf("X1")).toHaveLength(1);
  });
  test("测试失败后没改源码、只改了测试里的期望值 → M", async () => {
    const s = new Sim();
    await s.prompt("fix the bug");
    await s.bash("pytest", { fail: true, out: PYTEST_FAIL() });
    await s.edit(T, "assert f() == 4", "assert f() == 5");
    expect(s.hitsOf("X1")).toHaveLength(1);
  });
  test("先改了源码，再改测试 → 不报", async () => {
    const s = new Sim();
    await s.prompt("fix the bug");
    await s.bash("pytest", { fail: true, out: PYTEST_FAIL() });
    await s.edit("/work/proj/src/a.py", "x", "y");
    await s.edit(T, "assert f() == 4", "assert f() == 5");
    expect(s.hitsOf("X1")).toHaveLength(0);
  });
  test("意图是写测试/修 flaky/更新快照 → 降为 L", async () => {
    for (const p of ["请给 parser 补测试", "fix the flaky test", "update the snapshots", "修复 flaky 的 e2e"]) {
      const s = new Sim();
      await s.prompt(p);
      await s.edit(T, "assert a == 1\n    assert b == 2", "pass");
      expect(s.hitsOf("X1")[0]?.sev).toBe("L");
    }
  });
  test("计划当前步骤是写测试 → 降为 L", async () => {
    const s = new Sim();
    await s.prompt("fix the bug");
    await s.todo([["写测试覆盖 parser", "in_progress"]]);
    await s.edit(T, "assert a == 1\n    assert b == 2", "pass");
    expect(s.hitsOf("X1")[0]?.sev).toBe("L");
  });
  test("普通地新增断言/新增测试文件 → 不报", async () => {
    const s = new Sim();
    await s.prompt("fix the bug");
    await s.edit(T, "def test_x():\n    pass", "def test_x():\n    assert f() == 1\n    assert g() == 2");
    await s.write("/work/proj/tests/test_new.py", "def test_n():\n    assert 1", { created: true });
    expect(s.hitsOf("X1")).toHaveLength(0);
  });
  test("改的不是测试文件 → 不报", async () => {
    const s = new Sim();
    await s.edit("/work/proj/src/a.py", "assert x", "pass");
    expect(s.hitsOf("X1")).toHaveLength(0);
  });
});

describe("judge 在 X1 上不能 block", () => {
  test("X 类规则的 block 被降级为 advise", async () => {
    const { mockJudge } = await import("../src/judge/mock.ts");
    const s = new Sim({ judge: mockJudge({ rules: { X1: { verdict: "block", confidence: 0.99 } } }), cfg: (await import("./sim.ts")).cfgWith({ mode: "enforce" }) });
    await s.prompt("fix the bug");
    await s.edit("/work/proj/tests/test_a.py", "assert a == 1\n    assert b == 2", "pass");
    const d = s.decisionsOf("X1")[0];
    expect(d.action).toBe("advise");
  });
});

void PYTEST_PASS;
