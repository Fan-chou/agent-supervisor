// 轻量 shell 切分器：不求完整，只求把常见的 agent 命令拆成「段」，
// 保留引号、heredoc、重定向信息。无法解析的部分宁可保守地并入当前段。

export type Sep = "&&" | "||" | ";" | "|" | "&" | "";

export interface Redirect {
  op: ">" | ">>" | "&>" | "<";
  target: string;
}

export interface Segment {
  argv: string[];
  /** 本段后面的分隔符（空串表示最后一段）。 */
  sep: Sep;
  redirects: Redirect[];
  heredoc?: string;
  /** 段内是否含 $(...) 或反引号。 */
  hasSubst: boolean;
}

const isSpace = (c: string) => c === " " || c === "\t" || c === "\r";

export function splitShell(input: string): Segment[] {
  const segs: Segment[] = [];
  let argv: string[] = [];
  let redirects: Redirect[] = [];
  let hasSubst = false;
  let word = "";
  let inWord = false; // 区分空串引号 '' 与无词

  const pushWord = () => {
    if (inWord) argv.push(word);
    word = "";
    inWord = false;
  };
  const endSegment = (sep: Sep) => {
    pushWord();
    let pushed: Segment | null = null;
    if (argv.length > 0 || redirects.length > 0) {
      pushed = { argv, sep, redirects, hasSubst };
      segs.push(pushed);
    } else if (segs.length > 0 && sep !== "") {
      // 连续分隔符（如 `;;` 或 `&& \n`）：并入上一段的分隔符
      const last = segs[segs.length - 1];
      if (last.sep === "") last.sep = sep;
    }
    argv = [];
    redirects = [];
    hasSubst = false;
    return pushed;
  };
  const pendingHeredocSeg: { delim: string; strip: boolean }[] = [];

  let i = 0;
  const n = input.length;

  const readRedirTarget = () => {
    while (i < n && isSpace(input[i])) i++;
    let t = "";
    let q: string | null = null;
    while (i < n) {
      const c = input[i];
      if (q) {
        if (c === q) q = null;
        else t += c;
      } else if (c === "'" || c === '"') q = c;
      else if (isSpace(c) || c === "\n" || c === ";" || c === "|" || c === "&" || c === ")" || c === "<" || c === ">") break;
      else t += c;
      i++;
    }
    return t;
  };

  while (i < n) {
    const c = input[i];

    // 单引号
    if (c === "'") {
      inWord = true;
      i++;
      while (i < n && input[i] !== "'") word += input[i++];
      i++;
      continue;
    }
    // 双引号（支持 \ 转义和 $( ) 嵌套的粗略处理）
    if (c === '"') {
      inWord = true;
      i++;
      while (i < n && input[i] !== '"') {
        if (input[i] === "\\" && i + 1 < n) {
          word += input[i + 1];
          i += 2;
          continue;
        }
        if (input[i] === "$" && input[i + 1] === "(") hasSubst = true;
        word += input[i++];
      }
      i++;
      continue;
    }
    if (c === "\\") {
      if (input[i + 1] === "\n") {
        i += 2; // 续行
        continue;
      }
      inWord = true;
      word += input[i + 1] ?? "";
      i += 2;
      continue;
    }
    // $( ... ) 和反引号：整体并入词
    if (c === "$" && input[i + 1] === "(") {
      hasSubst = true;
      inWord = true;
      let depth = 0;
      while (i < n) {
        const d = input[i];
        word += d;
        i++;
        if (d === "(") depth++;
        else if (d === ")") {
          depth--;
          if (depth === 0) break;
        }
      }
      continue;
    }
    if (c === "`") {
      hasSubst = true;
      inWord = true;
      word += c;
      i++;
      while (i < n && input[i] !== "`") word += input[i++];
      if (i < n) word += input[i++];
      continue;
    }
    if (c === "#" && !inWord && (i === 0 || isSpace(input[i - 1]) || input[i - 1] === "\n")) {
      while (i < n && input[i] !== "\n") i++;
      continue;
    }
    if (isSpace(c)) {
      pushWord();
      i++;
      continue;
    }
    if (c === "\n") {
      const seg = endSegment(";");
      i++;
      // 读取待处理 heredoc 的正文
      if (pendingHeredocSeg.length) {
        for (const h of pendingHeredocSeg) {
          const lines: string[] = [];
          while (i < n) {
            let j = input.indexOf("\n", i);
            if (j < 0) j = n;
            const line = input.slice(i, j);
            i = Math.min(j + 1, n);
            const cmp = h.strip ? line.replace(/^\t+/, "") : line;
            if (cmp === h.delim) break;
            lines.push(line);
          }
          const target = seg ?? segs[segs.length - 1];
          if (target) target.heredoc = (target.heredoc ? target.heredoc + "\n" : "") + lines.join("\n");
        }
        pendingHeredocSeg.length = 0;
      }
      continue;
    }
    if (c === "&") {
      if (input[i + 1] === "&") {
        endSegment("&&");
        i += 2;
      } else if (input[i + 1] === ">") {
        // &> file
        i += input[i + 2] === ">" ? 3 : 2;
        pushWord();
        const t = readRedirTarget();
        redirects.push({ op: "&>", target: t });
      } else {
        endSegment("&");
        i++;
      }
      continue;
    }
    if (c === "|") {
      if (input[i + 1] === "|") {
        endSegment("||");
        i += 2;
      } else {
        endSegment("|");
        i += input[i + 1] === "&" ? 2 : 1;
      }
      continue;
    }
    if (c === ";" || c === "(" || c === ")" || c === "{" || c === "}") {
      // `{` `}` 只有独立成词时才是分组
      if ((c === "{" || c === "}") && (inWord || !(isSpace(input[i + 1] ?? " ") || input[i + 1] === "\n"))) {
        inWord = true;
        word += c;
        i++;
        continue;
      }
      endSegment(";");
      i++;
      continue;
    }
    if (c === ">" || c === "<") {
      // fd 前缀：2> / 1>
      if (inWord && /^\d+$/.test(word)) {
        word = "";
        inWord = false;
      } else pushWord();
      if (c === "<") {
        if (input[i + 1] === "<" && input[i + 2] === "<") {
          i += 3;
          readRedirTarget();
          continue;
        }
        if (input[i + 1] === "<") {
          i += 2;
          let strip = false;
          if (input[i] === "-") {
            strip = true;
            i++;
          }
          const delim = readRedirTarget();
          pendingHeredocSeg.push({ delim, strip });
          continue;
        }
        i++;
        const t = readRedirTarget();
        redirects.push({ op: "<", target: t });
        continue;
      }
      // c === ">"
      let op: Redirect["op"] = ">";
      i++;
      if (input[i] === ">") {
        op = ">>";
        i++;
      } else if (input[i] === "&") {
        // >&2 / >&- ：fd 复制，不是写文件
        i++;
        readRedirTarget();
        continue;
      } else if (input[i] === "|") i++;
      const t = readRedirTarget();
      redirects.push({ op, target: t });
      continue;
    }
    inWord = true;
    word += c;
    i++;
  }
  endSegment("");
  // 最后一段的 sep 修正：把末尾分隔符为空的最后一段保持 ""
  return segs;
}

/** heredoc 目标段：在换行处理里 target 取「刚结束的那一段」，这里提供辅助以便测试。 */
export function joinArgv(argv: string[]): string {
  return argv.map((a) => (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(a) ? a : JSON.stringify(a))).join(" ");
}
