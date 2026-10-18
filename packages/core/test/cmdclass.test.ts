import { describe, expect, test } from "bun:test";
import { analyzeShell, classifyCommand, isMutatingCommand, normCmd } from "../src/cmdclass.ts";
import type { CmdClass } from "../src/event.ts";

// [命令, 期望类别]
const CASES: [string, CmdClass][] = [
  // ---- pytest ----
  ["pytest", "test_full"],
  ["pytest -x -q", "test_full"],
  ["pytest tests/", "test_full"],
  ["pytest tests/test_a.py", "test_targeted"],
  ["pytest tests/test_a.py::test_one", "test_targeted"],
  ["pytest -k login", "test_targeted"],
  ["pytest -m slow", "test_targeted"],
  ["pytest --lf", "test_targeted"],
  ["pytest -n auto", "test_full"],
  ["pytest -p no:cacheprovider", "test_full"],
  ["python -m pytest", "test_full"],
  ["python3 -m pytest tests/unit/test_x.py -x", "test_targeted"],
  ["uv run pytest", "test_full"],
  ["uv run pytest tests/test_a.py", "test_targeted"],
  ["uv run --with httpx pytest -q", "test_full"],
  ["poetry run pytest -k foo", "test_targeted"],
  ["pipenv run pytest", "test_full"],
  ["cd backend && pytest", "test_full"],
  ["cd backend && uv run pytest tests/api/test_users.py", "test_targeted"],
  ["PYTHONPATH=. pytest", "test_full"],
  ["timeout 120 pytest", "test_full"],
  ["timeout 60 uv run pytest -k a", "test_targeted"],
  ["pytest 2>&1 | tail -20", "test_full"],
  ["pytest -x | head -50", "test_full"],
  ["pytest tests/test_a.py 2>&1 | grep FAILED", "test_targeted"],
  ["pytest | tee out.log", "test_full"],
  ["tox", "test_full"],
  ["tox -e py311", "test_targeted"],
  ["nox -s tests", "test_targeted"],
  // ---- JS/TS ----
  ["npm test", "test_full"],
  ["npm run test", "test_full"],
  ["npm t", "test_full"],
  ["npm run test:unit", "test_full"],
  ["npm test -- --watch", "test_watch"],
  ["npm test -- src/foo.test.ts", "test_targeted"],
  ["npm test -- -t 'adds numbers'", "test_targeted"],
  ["npm run test:watch", "test_watch"],
  ["pnpm test", "test_full"],
  ["pnpm run test", "test_full"],
  ["pnpm -F @acme/web test", "test_targeted"],
  ["pnpm --filter web test", "test_targeted"],
  ["pnpm test src/a.test.ts", "test_targeted"],
  ["yarn test", "test_full"],
  ["yarn test --watchAll", "test_watch"],
  ["bun test", "test_full"],
  ["bun test src/a.test.ts", "test_targeted"],
  ["bun test --watch", "test_watch"],
  ["bun run test", "test_full"],
  ["bun test -t foo", "test_targeted"],
  ["vitest", "test_watch"],
  ["vitest run", "test_full"],
  ["CI=1 vitest", "test_full"],
  ["env CI=true npx vitest", "test_full"],
  ["CI=0 vitest", "test_watch"],
  ["vitest run src/foo.test.ts", "test_targeted"],
  ["vitest run -t 'foo'", "test_targeted"],
  ["vitest --run", "test_full"],
  ["npx vitest run", "test_full"],
  ["npx vitest", "test_watch"],
  ["npx vitest run packages/core", "test_targeted"],
  ["bunx vitest run", "test_full"],
  ["jest", "test_full"],
  ["jest --watch", "test_watch"],
  ["jest --watchAll", "test_watch"],
  ["jest --watchAll=false", "test_full"],
  ["jest src/foo.test.js", "test_targeted"],
  ["jest -t 'something'", "test_targeted"],
  ["jest --findRelatedTests src/a.js", "test_targeted"],
  ["jest --onlyChanged", "test_targeted"],
  ["npx jest --ci", "test_full"],
  ["npx jest path/to/file.test.tsx", "test_targeted"],
  ["mocha", "test_full"],
  ["mocha test/foo.spec.js", "test_targeted"],
  ["npx playwright test", "test_full"],
  ["npx playwright test e2e/login.spec.ts", "test_targeted"],
  ["npx playwright install", "other"],
  ["deno test", "test_full"],
  ["deno test src/a_test.ts", "test_targeted"],
  ["turbo run test", "test_full"],
  ["turbo run test --filter=web", "test_targeted"],
  // ---- Go / Rust / 其他语言 ----
  ["go test ./...", "test_full"],
  ["go test ./... -count=1", "test_full"],
  ["go test ./internal/store", "test_targeted"],
  ["go test ./internal/...", "test_targeted"],
  ["go test -run TestFoo ./...", "test_targeted"],
  ["go test", "test_targeted"],
  ["go vet ./...", "lint"],
  ["go build ./...", "build"],
  ["cargo test", "test_full"],
  ["cargo test --workspace", "test_full"],
  ["cargo test -p core", "test_targeted"],
  ["cargo test parse_header", "test_targeted"],
  ["cargo test --lib", "test_targeted"],
  ["cargo test -- --nocapture", "test_full"],
  ["cargo test -- my_test --nocapture", "test_targeted"],
  ["cargo nextest run", "test_full"],
  ["cargo check", "typecheck"],
  ["cargo clippy --all-targets", "lint"],
  ["cargo fmt --check", "lint"],
  ["cargo build --release", "build"],
  ["make test", "test_full"],
  ["make test-fast", "test_targeted"],
  ["make test TEST=tests/test_a.py", "test_targeted"],
  ["make lint", "lint"],
  ["make build", "build"],
  ["make", "build"],
  ["make -C backend test", "test_full"],
  ["./gradlew test", "test_full"],
  ["./gradlew test --tests com.acme.FooTest", "test_targeted"],
  ["mvn test", "test_full"],
  ["mvn test -Dtest=FooTest", "test_targeted"],
  ["dotnet test", "test_full"],
  ["dotnet test --filter Name~Foo", "test_targeted"],
  ["rspec", "test_full"],
  ["rspec spec/models/user_spec.rb", "test_targeted"],
  ["bundle exec rspec spec/a_spec.rb:12", "test_targeted"],
  ["mix test", "test_full"],
  ["phpunit --filter testFoo", "test_targeted"],
  // ---- lint / typecheck / build ----
  ["npm run lint", "lint"],
  ["pnpm lint", "lint"],
  ["eslint src", "lint"],
  ["npx eslint . --fix", "lint"],
  ["ruff check .", "lint"],
  ["ruff format .", "lint"],
  ["flake8", "lint"],
  ["prettier --check .", "lint"],
  ["tsc --noEmit", "typecheck"],
  ["npx tsc --noEmit -p tsconfig.json", "typecheck"],
  ["npm run typecheck", "typecheck"],
  ["pnpm run type-check", "typecheck"],
  ["mypy src", "typecheck"],
  ["pyright", "typecheck"],
  ["uv run mypy .", "typecheck"],
  ["npm run build", "build"],
  ["pnpm build", "build"],
  ["bun run build", "build"],
  ["vite build", "build"],
  ["next build", "build"],
  ["tsc", "build"],
  ["docker build -t app .", "build"],
  // ---- probe（收紧后的定义）----
  ["python -c 'import myapp; print(myapp.__version__)'", "probe"],
  ["python3 -c \"from src.parser import parse; print(parse('x'))\"", "probe"],
  ["python -c 'from . import x'", "probe"],
  ["python -c 'import json; print(json.dumps({}))'", "other"],
  ["python -c 'import os; print(os.getcwd())'", "other"],
  ["python -c 'print(1+1)'", "other"],
  ["python -c 'import sys; print(sys.version)'", "other"],
  ["python -c \"assert 1 == 1\"", "probe"],
  ["uv run python -c 'import mypkg.core as c; print(c.run())'", "probe"],
  ["node -e \"require('./lib/index.js').run()\"", "probe"],
  ["node -e \"console.log(JSON.stringify(process.versions))\"", "other"],
  ["node -p \"require('./package.json').version\"", "probe"],
  ["node -e \"const a = require('assert'); a.equal(1,1)\"", "probe"],
  ["bun -e \"import { x } from './src/x'; console.log(x())\"", "probe"],
  ["deno eval \"console.log(1)\"", "other"],
  ["python - <<'EOF'\nimport myapp\nprint(myapp.x)\nEOF", "probe"],
  ["python - <<'EOF'\nimport json\nprint(json.load(open('a.json'))['k'])\nEOF", "other"],
  // ---- http_smoke ----
  ["curl localhost:3000/health", "http_smoke"],
  ["curl -s http://127.0.0.1:8080/api/ping", "http_smoke"],
  ["curl -X POST http://localhost:8000/v1/items -d '{}'", "http_smoke"],
  ["curl https://example.com", "other"],
  ["wget -qO- http://localhost:3000", "http_smoke"],
  ["http :8000/status", "http_smoke"],
  // ---- other ----
  ["ls -la", "other"],
  ["git status", "other"],
  ["cat README.md | head -20", "other"],
  ["rg TODO src | wc -l", "other"],
  ["echo hello", "other"],
  ["cd /tmp", "other"],
  ["npm install", "other"],
  ["git diff | tail -50", "other"],
  // ---- 剥壳 / 组合 ----
  ["cd app && npm run build && npm test", "test_full"],
  ["npm run build && npm test -- src/a.test.ts", "test_targeted"],
  ["pytest tests/a.py && pytest", "test_full"],
  ["pytest; echo done", "test_full"],
  ["bash -c 'cd x && pytest -q'", "test_full"],
  ["sh -c \"npm test -- --watch\"", "test_watch"],
  ["bash -lc 'uv run pytest tests/test_a.py'", "test_targeted"],
  ["env CI=1 npm test", "test_full"],
  ["CI=true npx vitest run", "test_full"],
  ["time pytest", "test_full"],
  ["nohup npm test &", "test_full"],
  ["(cd web && pnpm test)", "test_full"],
  ["pnpm exec vitest run", "test_full"],
  ["pnpm dlx vitest run", "test_full"],
];

describe("classifyCommand（≥100 条）", () => {
  test("用例数量 ≥ 100", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(100);
  });
  for (const [cmd, want] of CASES) {
    test(`${JSON.stringify(cmd)} → ${want}`, () => {
      expect(classifyCommand(cmd)).toBe(want);
    });
  }
  test("准确率 100%（汇总）", () => {
    const wrong = CASES.filter(([c, w]) => classifyCommand(c) !== w);
    expect(wrong).toEqual([]);
  });
});

describe("vitest watch 只看命令自己的 CI 赋值，不看 supervisor 进程的环境变量", () => {
  test("进程环境里有 CI=true 也不影响", () => {
    const old = process.env.CI;
    process.env.CI = "true";
    try {
      expect(classifyCommand("vitest")).toBe("test_watch");
      expect(classifyCommand("npx vitest")).toBe("test_watch");
      expect(classifyCommand("CI=1 npx vitest")).toBe("test_full");
    } finally {
      if (old === undefined) delete process.env.CI;
      else process.env.CI = old;
    }
  });
});

describe("watch / 后台", () => {
  test("vitest 无 run → watch 且 background", () => {
    const a = analyzeShell("vitest");
    expect(a.cls).toBe("test_watch");
    expect(a.background).toBe(true);
  });
  test("末尾 & → background", () => {
    expect(analyzeShell("npm run dev &").background).toBe(true);
    expect(analyzeShell("pytest").background).toBe(false);
  });
  test("npm run dev 是后台长进程", () => {
    expect(analyzeShell("npm run dev").background).toBe(true);
  });
  test("2>&1 不被当作后台", () => {
    expect(analyzeShell("pytest 2>&1").background).toBe(false);
  });
});

describe("smoke_script / repro_script", () => {
  const scripts = new Set(["smoke_test.py", "/tmp/check.py", "debug_it.py"]);
  test("修改源码前新建并运行 → repro_script", () => {
    expect(classifyCommand("python smoke_test.py", { newScripts: scripts, sourceEdited: false })).toBe("repro_script");
    expect(classifyCommand("python debug_it.py", { newScripts: scripts, sourceEdited: false })).toBe("repro_script");
  });
  test("修改源码后运行新建的 smoke 脚本 → smoke_script", () => {
    expect(classifyCommand("python smoke_test.py", { newScripts: scripts, sourceEdited: true })).toBe("smoke_script");
    expect(classifyCommand("uv run python /tmp/check.py", { newScripts: scripts, sourceEdited: true })).toBe("smoke_script");
  });
  test("非 smoke 命名的新脚本，修改后不算", () => {
    expect(classifyCommand("python debug_it.py", { newScripts: scripts, sourceEdited: true })).toBe("other");
  });
  test("不是本会话新建的脚本 → other", () => {
    expect(classifyCommand("python smoke_old.py", { newScripts: scripts, sourceEdited: true })).toBe("other");
    expect(classifyCommand("python smoke_old.py")).toBe("other");
  });
  test("scriptPath 暴露出来", () => {
    expect(analyzeShell("python scripts/seed.py").scriptPath).toBe("scripts/seed.py");
    expect(analyzeShell("./scripts/run.sh --fast").scriptPath).toBe("./scripts/run.sh");
  });
});

describe("项目配置覆盖", () => {
  test("test.full / test.fast", () => {
    expect(classifyCommand("just ci", { testFull: ["just ci"] })).toBe("test_full");
    expect(classifyCommand("make check-fast", { testFast: ["make check-fast"] })).toBe("test_targeted");
  });
  test("extra_patterns", () => {
    expect(classifyCommand("./run-suite.sh --all", { extraPatterns: ["run-suite\\.sh"] })).toBe("test_full");
  });
  test("非法正则不抛异常", () => {
    expect(classifyCommand("ls", { extraPatterns: ["(["] })).toBe("other");
  });
});

// [命令, 是否 mutating]
const MUT: [string, boolean][] = [
  ["sed -i 's/a/b/' src/x.ts", true],
  ["sed -i '' 's/a/b/' src/x.ts", true],
  ["sed -n '1,10p' src/x.ts", false],
  ["sed 's/a/b/' src/x.ts", false],
  ["perl -pi -e 's/a/b/' src/x.ts", true],
  ["perl -ne 'print if /x/' f.txt", false],
  ["echo hi > out.txt", true],
  ["echo hi >> out.txt", true],
  ["echo hi > /dev/null", false],
  ["echo hi > /tmp/x.txt", false],
  ["pytest 2>&1", false],
  ["pytest > /dev/null 2>&1", false],
  ["pytest &> run.log", true],
  ["cat <<EOF > a.txt\nhello\nEOF", true],
  ["cat file | tee out.log", true],
  ["cat file | tee /tmp/out.log", false],
  ["npm install", true],
  ["pnpm add zod", true],
  ["yarn add left-pad", true],
  ["bun add yaml", true],
  ["pip install requests", true],
  ["python -m pip install -e .", true],
  ["uv pip install httpx", true],
  ["uv sync", true],
  ["uv add pydantic", true],
  ["cargo add serde", true],
  ["cargo build", true],
  ["cargo test", false],
  ["go get github.com/x/y", true],
  ["go mod tidy", true],
  ["go test ./...", false],
  ["docker compose up -d", true],
  ["docker run --rm alpine ls", true],
  ["docker ps", false],
  ["npm run build", true],
  ["npm test", false],
  ["npm run db:migrate", true],
  ["alembic upgrade head", true],
  ["python manage.py migrate", true],
  ["python manage.py test", false],
  ["rm -rf dist", true],
  ["mv a.ts b.ts", true],
  ["cp a.ts b.ts", true],
  ["mkdir -p build", true],
  ["touch a.txt", true],
  ["chmod +x run.sh", true],
  ["git add -A", true],
  ["git commit -m x", true],
  ["git checkout -- .", true],
  ["git stash", true],
  ["git stash list", false],
  ["git status", false],
  ["git diff", false],
  ["git log --oneline", false],
  ["git branch", false],
  ["git branch -D old", true],
  ["git reset --hard HEAD", true],
  ["ls -la", false],
  ["cat a | wc -l", false],
  ["curl -s localhost:3000", false],
  ["curl -o out.json localhost:3000/x", true],
  ["find . -name '*.pyc' -delete", true],
  ["find . -name '*.ts'", false],
  ["tar xzf a.tgz", true],
  ["python -c \"open('a.txt','w').write('x')\"", true],
  ["python -c \"print(1)\"", false],
  ["node -e \"require('fs').writeFileSync('a','b')\"", true],
  ["python - <<'EOF'\nfrom pathlib import Path\nPath('a.txt').write_text('x')\nEOF", true],
  ["bash -c 'echo x > y.txt'", true],
  ["sudo rm x", true],
  ["prettier --write src", true],
  ["prettier --check src", false],
  ["ruff check --fix .", true],
  ["eslint --fix src", true],
  ["black .", true],
  ["black --check .", false],
  ["xargs rm < list.txt", true],
  ["pytest tests/a.py", false],
];

describe("mutating 识别", () => {
  for (const [cmd, want] of MUT) {
    test(`${JSON.stringify(cmd)} → ${want}`, () => {
      expect(isMutatingCommand(cmd)).toBe(want);
    });
  }
  test("写入目标被记录（含 /tmp）", () => {
    const a = analyzeShell("echo x > /tmp/s.py");
    expect(a.targets).toContain("/tmp/s.py");
    expect(a.mutating).toBe(false);
    expect(analyzeShell("sed -i 's/a/b/' a.ts b.ts").targets).toEqual(["a.ts", "b.ts"]);
    expect(analyzeShell("cp a b").targets).toEqual(["b"]);
  });
});

describe("normCmd", () => {
  test("剥掉 uv run / timeout / env / 管道尾巴 / 重定向", () => {
    expect(normCmd("timeout 60 uv run pytest -x 2>&1 | tail -20")).toBe("pytest -x");
    expect(normCmd("CI=1 npx vitest run")).toBe("vitest run");
    expect(normCmd("python -m pytest tests/a.py")).toBe("pytest tests/a.py");
  });
  test("不同参数保持不同", () => {
    expect(normCmd("pytest -k a")).not.toBe(normCmd("pytest -k b"));
  });
  test("范围参数保留，避免 -F a 与 -F b 混同", () => {
    expect(normCmd("pnpm -F a test")).not.toBe(normCmd("pnpm -F b test"));
  });
  test("cd 保留", () => {
    expect(normCmd("cd a && pytest")).not.toBe(normCmd("cd b && pytest"));
  });
  test("同一命令的不同包装得到同一 normCmd", () => {
    expect(normCmd("uv run pytest -q")).toBe(normCmd("pytest -q | tail -5"));
    expect(normCmd("poetry run pytest -q")).toBe(normCmd("timeout 300 pytest -q"));
  });
  test("引号内的 && 不切分", () => {
    expect(analyzeShell("echo 'a && b' && pytest").segments.length).toBe(2);
  });
});
