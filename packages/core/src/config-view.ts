// GET /v1/config 用的只读视图：生效配置的拷贝，疑似凭据的值一律遮掉，api key 只给环境变量名和「是否已设置」。
// 不读任何文件、不读 key 的值（只检查环境变量是否非空）。
import type { Config } from "./config.ts";

const SECRET_KEY = /(authorization|api[-_]?key|token|secret|passw(or)?d|credential|cookie)/i;
const MASK = "••••";

function mask(v: unknown, key = ""): unknown {
  if (Array.isArray(v)) return v.map((x) => mask(x, key));
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      // api_key_env 是环境变量的名字，不是密钥本身
      if (k !== "api_key_env" && SECRET_KEY.test(k) && typeof x === "string" && x.length > 0) o[k] = MASK;
      else o[k] = mask(x, k);
    }
    return o;
  }
  return v;
}

export interface ConfigView {
  /** 生效配置（已遮掉疑似凭据的值）。 */
  config: Record<string, unknown>;
  judge: { api_key_env: string; api_key_set: boolean };
  /** 配置来自哪里。守护进程只知道自己启动时拿到的那一份，不追踪每个值的来源文件。 */
  source: "daemon-startup";
}

export function configView(cfg: Config, env: Record<string, string | undefined> = process.env): ConfigView {
  const name = cfg.judge.api_key_env;
  const set = !!(name && ((env[name] ?? "").length > 0 || (env.ADVISOR_API_KEY ?? "").length > 0));
  return { config: mask(cfg) as Record<string, unknown>, judge: { api_key_env: name, api_key_set: set }, source: "daemon-startup" };
}
