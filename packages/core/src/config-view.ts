// GET /v1/config 用的只读视图：生效配置的拷贝，疑似凭据的值一律遮掉，api key 只给环境变量名和「是否已设置」。
// 不读任何文件、不读 key 的值（只检查环境变量是否非空）。
import { defaultConfig, type Config } from "./config.ts";
import { flattenLeaves } from "./config-validate.ts";

const SECRET_KEY = /(authorization|api[-_]?key|token|secret|passw(or)?d|credential|cookie)/i;
const MASK = "••••";

/** 深拷贝并遮掉疑似凭据的字符串值（键名匹配 authorization/api_key/token/secret/password/cookie…）。api_key_env 是变量名，保留。 */
export function maskSecrets<T>(v: T, key = ""): T {
  if (Array.isArray(v)) return v.map((x) => maskSecrets(x, key)) as unknown as T;
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k !== "api_key_env" && SECRET_KEY.test(k) && typeof x === "string" && x.length > 0) o[k] = MASK;
      else o[k] = maskSecrets(x, k);
    }
    return o as T;
  }
  return v;
}

export type ValueSource = "default" | "configured" | "rules.local";

export interface ConfigView {
  /** 生效配置（已遮掉疑似凭据的值）。 */
  config: Record<string, unknown>;
  judge: { api_key_env: string; api_key_set: boolean };
  /**
   * 每个叶子值的来源：default = 与内置默认相同；configured = 启动配置（文件或命令行）改过；rules.local = 被规则编辑覆盖。
   * 守护进程不知道启动配置来自哪个文件，所以不区分全局/项目级。
   */
  sources: Record<string, ValueSource>;
  source: "daemon-startup";
}

export function configView(cfg: Config, env: Record<string, string | undefined> = process.env, base?: Config): ConfigView {
  const name = cfg.judge.api_key_env;
  const set = !!(name && ((env[name] ?? "").length > 0 || (env.ADVISOR_API_KEY ?? "").length > 0));
  const eff = flattenLeaves(cfg);
  const def = flattenLeaves(defaultConfig());
  const start = base ? flattenLeaves(base) : eff;
  const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  const sources: Record<string, ValueSource> = {};
  for (const p of Object.keys(eff)) {
    // 凭据类叶子不暴露具体值，但来源可以说
    sources[p] = !same(eff[p], start[p]) ? "rules.local" : same(eff[p], def[p]) ? "default" : "configured";
  }
  return { config: maskSecrets(cfg) as unknown as Record<string, unknown>, judge: { api_key_env: name, api_key_set: set }, sources, source: "daemon-startup" };
}
