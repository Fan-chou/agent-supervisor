// 结构化日志的 SQLite schema（design §18）。bun:sqlite，WAL。
// severity：hits.sev 是 L/M/H 三级；hits.severity 是面向人的标签 info/low/medium/high，X2 危险操作一律是 'dangerous'。
// outcome：真实生效是 blocked/asked/continued/advised；shadow 等不生效时是 would_have_*（X2 在 shadow 下就是 would_have_blocked）。
// 约定：ts = 事件发生的时间（epoch ms，回放里是历史时间）；logged_ts = 写入日志的墙钟时间（保留期按它清理）。
// 所有正文（命令、输出、prompt、judge 请求/响应）都是脱敏后的文本。

export const SCHEMA_VERSION = 2;

/** v1 → v2 新增的列（旧库打开时按这个表补列）。 */
export const MIGRATIONS_V2: { table: string; column: string; type: string }[] = [
  { table: "hits", column: "severity", type: "TEXT" },
  { table: "hits", column: "danger_category", type: "TEXT" },
  { table: "hits", column: "danger_subject", type: "TEXT" },
  { table: "hits", column: "danger_reason", type: "TEXT" },
  { table: "decisions", column: "outcome", type: "TEXT" },
];

export const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,

  // 一次运行：live（守护进程一次启动）、replay（sv replay）、eval（sv eval）。thresholds_* 记录当时生效的一套阈值，用于对比调参。
  `CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    label TEXT,
    source TEXT,
    started_ts INTEGER NOT NULL,
    ended_ts INTEGER,
    mode TEXT,
    judge_mode TEXT,
    thresholds_json TEXT,
    thresholds_hash TEXT,
    overrides_json TEXT,
    config_json TEXT,
    version TEXT,
    logged_ts INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    harness TEXT,
    model TEXT,
    cwd TEXT,
    project TEXT,
    source_file TEXT,
    parent_session_id TEXT,
    started_ts INTEGER,
    ended_ts INTEGER,
    calls INTEGER DEFAULT 0,
    logged_ts INTEGER NOT NULL,
    UNIQUE (run_id, session_id)
  )`,

  // 每个事件一行（pre/post/prompt/stop/...）。正文 body_json 可通过 log.store_event_bodies 关闭。
  `CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    phase TEXT NOT NULL,
    origin TEXT,
    tool_use_id TEXT,
    agent_id TEXT,
    model TEXT,
    tool_name TEXT,
    tool_kind TEXT,
    cmd_class TEXT,
    args_hash TEXT,
    norm_cmd TEXT,
    mutating INTEGER,
    status TEXT,
    exit_code INTEGER,
    err_fp TEXT,
    out_hash TEXT,
    ws_fp TEXT,
    context_tokens INTEGER,
    body_json TEXT,
    logged_ts INTEGER NOT NULL
  )`,

  // 每次检测器命中一行：规则、指纹（key）、证据、实际观测值与当时的阈值。
  `CREATE TABLE IF NOT EXISTS hits (
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    call_index INTEGER,
    rule_id TEXT NOT NULL,
    sev TEXT NOT NULL,
    category TEXT,
    phase TEXT,
    key TEXT,
    evidence_json TEXT,
    observed_json TEXT,
    threshold_json TEXT,
    detail_json TEXT,
    message TEXT,
    verified INTEGER,
    observe_only INTEGER,
    blockable INTEGER,
    explicit INTEGER,
    model TEXT,
    severity TEXT,
    danger_category TEXT,
    danger_subject TEXT,
    danger_reason TEXT,
    logged_ts INTEGER NOT NULL
  )`,

  // judge 的每一次调用（含重试合并成一行）：请求/响应（脱敏）、延迟、token、模型、解析修复、response_format 降级。
  `CREATE TABLE IF NOT EXISTS judge_calls (
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    rule_ids TEXT,
    sync INTEGER,
    route_model TEXT,
    model TEXT,
    status TEXT NOT NULL,
    verdict TEXT,
    confidence REAL,
    category TEXT,
    message_raw TEXT,
    reason TEXT,
    latency_ms INTEGER,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    cached_tokens INTEGER,
    cost_usd REAL,
    retries INTEGER,
    http_requests INTEGER,
    format_level TEXT,
    format_downgraded INTEGER,
    repairs_json TEXT,
    error TEXT,
    request_json TEXT,
    response_json TEXT,
    logged_ts INTEGER NOT NULL
  )`,

  // 策略的每个决定：ignore / advise / block / ask / stop_continue / skip …，以及原因和结构化的抑制代码（冷却、预算、上限…）。
  `CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    hit_id INTEGER NOT NULL,
    judge_call_id INTEGER,
    ts INTEGER NOT NULL,
    rule_id TEXT NOT NULL,
    action TEXT NOT NULL,
    applied INTEGER NOT NULL,
    mode TEXT,
    reason TEXT,
    suppressed_by TEXT,
    message TEXT,
    would_block_if_verified INTEGER,
    at_next_pre INTEGER,
    counted INTEGER,
    outcome TEXT,
    logged_ts INTEGER NOT NULL
  )`,

  // 投递结果：有没有送达、经由哪个通道、没送达的原因、agent 是否遵从。
  `CREATE TABLE IF NOT EXISTS deliveries (
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    decision_id INTEGER NOT NULL,
    rule_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    channel TEXT NOT NULL,
    delivered INTEGER NOT NULL,
    delivered_ts INTEGER,
    expired_reason TEXT,
    text TEXT,
    watch_json TEXT,
    complied INTEGER,
    compliance_note TEXT,
    logged_ts INTEGER NOT NULL
  )`,

  // 用户覆盖：#sv off / #sv quiet、手动放行/驳回、标为误报/有用。
  `CREATE TABLE IF NOT EXISTS overrides (
    id INTEGER PRIMARY KEY,
    run_id INTEGER,
    session_id TEXT,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id INTEGER,
    actor TEXT,
    note TEXT,
    logged_ts INTEGER NOT NULL
  )`,

  // 适配器 → 守护进程的连接健康（design §1：避免监督静默失效）。
  `CREATE TABLE IF NOT EXISTS adapter_health (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    harness TEXT NOT NULL,
    ok INTEGER NOT NULL,
    error TEXT,
    logged_ts INTEGER NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_events_session ON events (run_id, session_id, seq)`,
  `CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts)`,
  `CREATE INDEX IF NOT EXISTS idx_events_model ON events (model)`,
  `CREATE INDEX IF NOT EXISTS idx_hits_rule ON hits (rule_id, run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_hits_session ON hits (run_id, session_id, seq)`,
  `CREATE INDEX IF NOT EXISTS idx_decisions_hit ON decisions (hit_id)`,
  `CREATE INDEX IF NOT EXISTS idx_decisions_rule ON decisions (rule_id, action)`,
  `CREATE INDEX IF NOT EXISTS idx_judge_model ON judge_calls (model, ts)`,
  `CREATE INDEX IF NOT EXISTS idx_deliveries_decision ON deliveries (decision_id)`,
  `CREATE INDEX IF NOT EXISTS idx_overrides_target ON overrides (target_type, target_id)`,
  `CREATE INDEX IF NOT EXISTS idx_logged ON events (logged_ts)`,
  // 注意：依赖 v2 新增列的索引在 store.migrate() 里补列之后再建
];

/** 参与保留期清理 / JSONL 导出的表（按依赖顺序）。 */
export const TABLES = ["runs", "sessions", "events", "hits", "judge_calls", "decisions", "deliveries", "overrides", "adapter_health"] as const;
export type TableName = (typeof TABLES)[number];
