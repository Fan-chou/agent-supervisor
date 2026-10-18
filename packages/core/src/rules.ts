// 规则目录（design §5、§6.3）：给前端「规则」页和 `GET /v1/rules` 用的静态说明。不参与任何判定；判定逻辑在 detectors/ 和 policy.ts。
// 阈值不写在这里——一律从生效配置取（thresholdsForRule），所以改了配置这里自动跟着变。
import { thresholdsForRule, type Config } from "./config.ts";

export type RuleLevel = "L" | "M" | "H" | "M→H" | "L→M" | "observe";

export interface RuleInfo {
  id: string;
  /** 一句话说明（design 表里的「规则」列）。 */
  title: string;
  /** 与 detectors/types.ts 的 Category 一致。 */
  category: "loop" | "stagnation" | "over_testing" | "scope" | "premature_done" | "test_gaming" | "drift" | "unsafe" | "other";
  /** 默认级别（design 表里的「级」）。 */
  level: RuleLevel;
  /** 只在回放里观察、不上线。 */
  observeOnly?: boolean;
  /** 只对这些 harness 生效；没写 = 全部。 */
  harness?: string[];
  /** 来源（design 表里的「出处」，没有就省略）。 */
  source?: string;
}

export const RULES: RuleInfo[] = [
  { id: "L1", title: "同一调用连续失败（错误指纹相同，且两次之间工作区指纹不变）", category: "loop", level: "M→H", source: "loop-guard、claude-focus、histori" },
  { id: "L2", title: "同一调用且输出哈希相同（最近若干步内）", category: "loop", level: "M", source: "LoopGuard、self-critic" },
  { id: "L2a", title: "轮询类白名单命令的重复", category: "loop", level: "L" },
  { id: "L3", title: "同一错误指纹反复出现（不同命令也算）", category: "loop", level: "M", source: "LoopGuard error_echo、histori" },
  { id: "L4", title: "编辑振荡：文件内容哈希回到之前出现过的值", category: "loop", level: "M", source: "Squawk、LivePlan" },
  { id: "L5", title: "同一文件的编辑段数过多且期间没有成功的验证", category: "loop", level: "L→M", source: "claude-focus" },
  { id: "L6", title: "同一文件重复读取而期间没有改动", category: "loop", level: "L", source: "claude-focus" },
  { id: "S1", title: "连续只读/只搜索", category: "stagnation", level: "M", source: "claude-focus、histori" },
  { id: "S2", title: "同一阶段停滞", category: "stagnation", level: "observe", observeOnly: true, source: "LivePlan" },
  { id: "S3", title: "距上次成功编辑太久且期间调用很多", category: "stagnation", level: "M", source: "LoopGuard、claude-focus" },
  { id: "S4", title: "子 agent 过多或连续没有产出", category: "stagnation", level: "M", source: "claude-focus" },
  { id: "P1", title: "编辑计划允许范围以外的路径", category: "scope", level: "M→H", source: "KEEL" },
  { id: "P2", title: "没读就改：编辑本会话没读过的已有文件", category: "scope", level: "L", harness: ["codex", "opencode"], source: "LivePlan" },
  { id: "P3", title: "宣布完成，但最后一次编辑之后没有跑过相关验证", category: "premature_done", level: "M", source: "self-critic、claude-focus" },
  { id: "P4", title: "意图漂移（judge 抽查）", category: "drift", level: "M", source: "Viper" },
  { id: "P5", title: "新增依赖而计划里没提", category: "scope", level: "L→M" },
  { id: "P6", title: "大段删除", category: "scope", level: "M" },
  { id: "X1", title: "改测试让它通过（删断言、加 skip/only、改期望值）", category: "test_gaming", level: "M", source: "Squawk" },
  { id: "X2", title: "危险操作：写 .env/密钥/CI 配置、递归删除、git 破坏性命令", category: "unsafe", level: "H", source: "claude-focus、histori" },
  { id: "R1", title: "自上次真实用户消息起的工具调用数过多", category: "other", level: "M", source: "claude-focus" },
  { id: "R2", title: "会话花费/token 接近预算", category: "other", level: "M", source: "LoopGuard、histori" },
  { id: "R3", title: "上下文填充率过高", category: "other", level: "L", source: "LoopGuard" },
  { id: "R4", title: "定期抽查", category: "other", level: "M", source: "LivePlan、Cadence" },
  { id: "T1", title: "没改动就重跑同一条测试命令", category: "over_testing", level: "M→H" },
  { id: "T2", title: "两次之间没有编辑的完整测试运行次数过多", category: "over_testing", level: "M" },
  { id: "T3", title: "有 targeted 可用时仍跑完整测试", category: "over_testing", level: "L" },
  { id: "T4", title: "探测（probe）命令次数过多", category: "over_testing", level: "L" },
  { id: "T5", title: "修复之后新建 smoke/验证脚本过多", category: "over_testing", level: "L→M" },
  { id: "T6", title: "没改动就重复 http_smoke", category: "over_testing", level: "L" },
  { id: "T7", title: "花样运行测试（随机顺序、重复、换种子）", category: "over_testing", level: "L" },
  { id: "T8", title: "验证类调用占比过高", category: "over_testing", level: "L→M" },
  { id: "TB", title: "本轮完整测试/验证调用总量", category: "over_testing", level: "M" },
];

export const RULE_IDS = RULES.map((r) => r.id);

/** 配置里该规则对应的 rules 键（和检测器 ruleDisabled 用同一种查找：id 或 id_ 前缀）。没有就用 id。 */
export function ruleConfigKey(cfg: Config, id: string): string {
  return Object.keys(cfg.rules ?? {}).find((k) => k === id || k.startsWith(id + "_")) ?? id;
}

export interface RuleView extends RuleInfo {
  /** 生效阈值（来自配置，不是写死的）。 */
  thresholds: Record<string, unknown>;
  /** 配置里对该规则的显式覆盖（rules.<ID>：action/mode/block_on/disabled）。 */
  override: Record<string, unknown> | null;
  /** 配置里被 disabled 掉了。 */
  disabled: boolean;
}

export function ruleViews(cfg: Config): RuleView[] {
  return RULES.map((r) => {
    const ov = cfg.rules?.[ruleConfigKey(cfg, r.id)] ?? null;
    return { ...r, thresholds: thresholdsForRule(r.id, cfg), override: ov ? { ...ov } : null, disabled: ov?.disabled === true || ov?.action === "off" };
  });
}
