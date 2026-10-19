package api

import "encoding/json"

// 列表接口的外层包装（schemas.ts 没有给它们单独的 schema，形状取自 packages/daemon/src/query-api.ts）。

type SessionList struct {
	Sessions []SessionSummary `json:"sessions"`
}

// ChildSession 是 /v1/sessions/{id}/children 的一行。
type ChildSession struct {
	RunID           int64   `json:"run_id"`
	SessionID       string  `json:"session_id"`
	Harness         *string `json:"harness"`
	Model           *string `json:"model"`
	Project         *string `json:"project"`
	Calls           *int64  `json:"calls"`
	StartedTs       *int64  `json:"started_ts"`
	EndedTs         *int64  `json:"ended_ts"`
	ParentSessionID *string `json:"parent_session_id"`
}

type ChildList struct {
	Children []ChildSession `json:"children"`
}

type HitList struct {
	Hits       []Hit  `json:"hits"`
	NextCursor *int64 `json:"nextCursor"`
}

type RunList struct {
	Runs []Run `json:"runs"`
}

type RuleStatList struct {
	By   string     `json:"by"`
	Rows []RuleStat `json:"rows"`
}

// ModelRuleStat 是 /v1/rules/stats?by=model 的一行。
type ModelRuleStat struct {
	Model           string   `json:"model"`
	Calls           int64    `json:"calls"`
	Rule            string   `json:"rule"`
	Hits            int64    `json:"hits"`
	HitsPer100Calls *float64 `json:"hitsPer100Calls"`
}

type ModelRuleStatList struct {
	By   string          `json:"by"`
	Rows []ModelRuleStat `json:"rows"`
}

type DangerEventList struct {
	Events []DangerEvent `json:"events"`
}

// RunDiffRow 是 /v1/runs/compare 的一行。
type RunDiffRow struct {
	Rule        string `json:"rule"`
	HitsA       int64  `json:"hitsA"`
	HitsB       int64  `json:"hitsB"`
	DeltaHits   int64  `json:"deltaHits"`
	AlarmsA     int64  `json:"alarmsA"`
	AlarmsB     int64  `json:"alarmsB"`
	DeltaAlarms int64  `json:"deltaAlarms"`
	BlocksA     int64  `json:"blocksA"`
	BlocksB     int64  `json:"blocksB"`
}

type RunCompare struct {
	A    int64        `json:"a"`
	B    int64        `json:"b"`
	Rows []RunDiffRow `json:"rows"`
}

// JudgeStat 是 /v1/judge-calls/stats 的一行（按被调用的 judge 模型）。
type JudgeStat struct {
	Model            string   `json:"model"`
	Calls            int64    `json:"calls"`
	Ok               int64    `json:"ok"`
	Ignores          int64    `json:"ignores"`
	Advises          int64    `json:"advises"`
	Blocks           int64    `json:"blocks"`
	ParseFail        int64    `json:"parseFail"`
	Timeouts         int64    `json:"timeouts"`
	Errors           int64    `json:"errors"`
	IgnoreRate       *float64 `json:"ignoreRate"`
	ParseFailRate    *float64 `json:"parseFailRate"`
	LatencyP50       *float64 `json:"latencyP50"`
	LatencyP95       *float64 `json:"latencyP95"`
	PromptTokens     float64  `json:"promptTokens"`
	CompletionTokens float64  `json:"completionTokens"`
	CachedTokens     float64  `json:"cachedTokens"`
	CostUsd          float64  `json:"costUsd"`
	Retries          float64  `json:"retries"`
	FormatDowngrades int64    `json:"formatDowngrades"`
}

type JudgeStatList struct {
	Rows []JudgeStat `json:"rows"`
}

// EvalReport 是 /v1/eval/reports 的一项：评测运行 + 它的逐规则统计。
type EvalReport struct {
	Run   Run        `json:"run"`
	Rules []RuleStat `json:"rules"`
}

type EvalReportList struct {
	Reports []EvalReport `json:"reports"`
}

// Explain 是 /v1/hits/{id} 的命中链路；各段形状随表结构变，只保留原始 JSON，界面挑要看的字段。
type Explain struct {
	Hit        map[string]any   `json:"hit"`
	Events     []map[string]any `json:"events"`
	Decisions  []map[string]any `json:"decisions"`
	Judge      []map[string]any `json:"judge"`
	Deliveries []map[string]any `json:"deliveries"`
	Labels     []map[string]any `json:"labels"`
}

// RuleEditResult 是 PUT /v1/rules/{id} 成功时的响应。
type RuleEditResult struct {
	Ok        bool            `json:"ok"`
	Rule      Rule            `json:"rule"`
	Changes   json.RawMessage `json:"changes"`
	AppliesTo string          `json:"appliesTo"`
}

// RuleEdit 是 PUT 的请求体（packages/core/src/rule-edit.ts validateRuleEdit）。
// Thresholds 的形状与 GET /v1/rules 返回的 thresholds 相同：普通规则 {键: 数字}，T 系列 {"ladder": {级别: 数字}}。
// disabled / thresholds / reset 三者互斥地用；界面一次只发其中一类。
type RuleEdit struct {
	Disabled   *bool          `json:"disabled,omitempty"`
	Thresholds map[string]any `json:"thresholds,omitempty"`
	Reset      bool           `json:"reset,omitempty"`
}
