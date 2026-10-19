// Package app 是界面：状态、连接状态机、视图。logic.go 是不依赖 MyGo 的纯逻辑（可直接单测）。
package app

import (
	"fmt"
	"math"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/Fan-chou/agent-supervisor/ui/api"
)

// ---- 三类危险状态（frontend-design §7.5） ----

// OutcomeKind 把 Decision.outcome 归到界面要区分的几种结局。
// 只认 outcome（would_have_* = 本应拦截；blocked/asked = 已拦截），不用 applied 推断（§10.4）。
type OutcomeKind int

const (
	OutcomeNone     OutcomeKind = iota // 没有面向 agent 的动作
	OutcomeWould                       // ◌ 本应拦截/要求确认（未生效）
	OutcomeEnforced                    // ■ 已拦截/已要求确认
	OutcomeAdvise                      // 建议/续跑（已生效或未生效，较弱的灰色标签）
)

// ClassifyOutcome 返回结局类别。未知取值按 OutcomeNone（不猜）。
func ClassifyOutcome(outcome string) OutcomeKind {
	switch outcome {
	case "would_have_blocked", "would_have_asked":
		return OutcomeWould
	case "blocked", "asked":
		return OutcomeEnforced
	case "advised", "would_have_advised", "continued", "would_have_continued":
		return OutcomeAdvise
	}
	return OutcomeNone
}

// OutcomeText 是结局的固定文案。mode 是决策发生时的 mode（空则按 shadow）。
func OutcomeText(outcome, mode string) string {
	if mode == "" {
		mode = "shadow"
	}
	switch outcome {
	case "would_have_blocked":
		return "本应拦截（" + mode + "，未生效）"
	case "would_have_asked":
		return "本应要求确认（" + mode + "，未生效）"
	case "blocked":
		return "已拦截"
	case "asked":
		return "已要求确认"
	case "advised":
		return "已建议"
	case "continued":
		return "已续跑"
	case "would_have_advised":
		return mode + ":不生效 · 建议"
	case "would_have_continued":
		return mode + ":不生效 · 续跑"
	}
	return ""
}

// SevMark 是级别的「文字 + 图形」双重编码（§12.2）：▲H ●M ·L。
func SevMark(sev string) string {
	switch sev {
	case "H":
		return "▲H"
	case "M":
		return "●M"
	case "L":
		return "·L"
	}
	return sev
}

// DangerSummary 是 danger 计数的一行文字，如「⚠ 3 · ◌ 本应拦截 3 · ■ 已拦截 0」。
func DangerSummary(total, would, enforced int64) string {
	return fmt.Sprintf("⚠ 危险 %d · ◌ 本应拦截 %d · ■ 已拦截 %d", total, would, enforced)
}

// ---- 格式化 ----

// FmtTime 是列表统一的本地时间 MM-DD HH:mm:ss。
func FmtTime(ms int64) string {
	if ms <= 0 {
		return "–"
	}
	return time.UnixMilli(ms).Local().Format("01-02 15:04:05")
}

// FmtISO 给悬停提示：带毫秒的 ISO 时间。
func FmtISO(ms int64) string {
	return time.UnixMilli(ms).Local().Format("2006-01-02T15:04:05.000Z07:00")
}

// Rel 是相对时间（2m前）。
func Rel(ms int64, now time.Time) string {
	if ms <= 0 {
		return "–"
	}
	d := now.Sub(time.UnixMilli(ms))
	switch {
	case d < 0:
		return "刚刚"
	case d < time.Minute:
		return fmt.Sprintf("%ds前", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm前", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%dh前", int(d.Hours()))
	}
	return fmt.Sprintf("%dd前", int(d.Hours()/24))
}

// ShortID 缩写会话 id（保留前 8 位）。
func ShortID(id string) string {
	r := []rune(id)
	if len(r) <= 10 {
		return id
	}
	return string(r[:8]) + "…"
}

// ShortPath 把家目录缩写成 ~。
func ShortPath(p string) string {
	if p == "" {
		return "（无目录）"
	}
	if h, err := os.UserHomeDir(); err == nil && h != "" && strings.HasPrefix(p, h) {
		return "~" + strings.TrimPrefix(p, h)
	}
	return p
}

// Str 解引用可空字符串。
func Str(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// Or 在 s 为空时给占位。
func Or(s, alt string) string {
	if s == "" {
		return alt
	}
	return s
}

// I64 解引用可空整数（nil → 0）。
func I64(p *int64) int64 {
	if p == nil {
		return 0
	}
	return *p
}

// Pct 把 0..1 的比例写成百分数；nil → n/a（不编造数字）。
func Pct(p *float64) string {
	if p == nil || math.IsNaN(*p) {
		return "n/a"
	}
	return fmt.Sprintf("%.0f%%", *p*100)
}

// Num 写可空小数；nil → –。
func Num(p *float64, digits int) string {
	if p == nil {
		return "–"
	}
	return fmt.Sprintf("%.*f", digits, *p)
}

// Compact 把大数缩写成 1.2k / 3.4M。
// FmtBytes 把字节数写成 KB / MB / GB（1024 进制，一位小数）。
func FmtBytes(n int64) string {
	const k = 1024.0
	v := float64(n)
	switch {
	case v < k:
		return fmt.Sprintf("%d B", n)
	case v < k*k:
		return fmt.Sprintf("%.1f KB", v/k)
	case v < k*k*k:
		return fmt.Sprintf("%.1f MB", v/(k*k))
	}
	return fmt.Sprintf("%.1f GB", v/(k*k*k))
}

func Compact(v float64) string {
	switch {
	case v >= 1e6:
		return fmt.Sprintf("%.2fM", v/1e6)
	case v >= 1e4:
		return fmt.Sprintf("%.1fk", v/1e3)
	}
	return fmt.Sprintf("%.0f", v)
}

// ---- 会话分组 ----

// SessionFilter 是会话页的筛选。
type SessionFilter struct {
	State      string // "" | active | idle | ended
	Harness    string
	OnlyDanger bool
	Query      string
	SortDanger bool // 默认按最近活动；true 时有危险的项目排前面
}

// Group 是一个项目目录下的会话。
type Group struct {
	Project  string
	Sessions []api.SessionSummary
	Calls    int64
	L, M, H  int64
	Danger   api.SessionSummaryDanger
	Active   int
	LastTs   int64
}

// GroupSessions 按 project 分组（§2）。组内按最近活动，含 H 的在前；
// 组间按最近活动，SortDanger 时危险合计多的在前。
func GroupSessions(ss []api.SessionSummary, f SessionFilter) []Group {
	by := map[string]*Group{}
	var order []string
	q := strings.ToLower(f.Query)
	for _, s := range ss {
		if f.State == "!ended" && s.State == "ended" {
			continue // 默认隐藏已结束会话（页面提示另有 N 个）
		}
		if f.State != "" && f.State != "!ended" && s.State != f.State {
			continue
		}
		if f.Harness != "" && Str(s.Harness) != f.Harness {
			continue
		}
		if f.OnlyDanger && s.Danger.Total == 0 {
			continue
		}
		if q != "" && !strings.Contains(strings.ToLower(s.SessionID+" "+Str(s.Project)+" "+Str(s.Model)+" "+Str(s.Harness)), q) {
			continue
		}
		p := Str(s.Project)
		g := by[p]
		if g == nil {
			g = &Group{Project: p}
			by[p] = g
			order = append(order, p)
		}
		g.Sessions = append(g.Sessions, s)
		g.Calls += I64(s.Calls)
		g.L += s.HitsL
		g.M += s.HitsM
		g.H += s.HitsH
		g.Danger.Total += s.Danger.Total
		g.Danger.WouldHaveBlocked += s.Danger.WouldHaveBlocked
		g.Danger.Enforced += s.Danger.Enforced
		if s.State == "active" {
			g.Active++
		}
		if last := I64(s.LastTs); last > g.LastTs {
			g.LastTs = last
		}
	}
	out := make([]Group, 0, len(order))
	for _, p := range order {
		g := by[p]
		sort.SliceStable(g.Sessions, func(i, j int) bool {
			a, b := g.Sessions[i], g.Sessions[j]
			if (a.HitsH > 0) != (b.HitsH > 0) {
				return a.HitsH > 0
			}
			return I64(a.LastTs) > I64(b.LastTs)
		})
		out = append(out, *g)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if f.SortDanger && out[i].Danger.Total != out[j].Danger.Total {
			return out[i].Danger.Total > out[j].Danger.Total
		}
		return out[i].LastTs > out[j].LastTs
	})
	return out
}

// SessionRow 是展平后的一行：组头或会话。
type SessionRow struct {
	Header  *Group
	Session *api.SessionSummary
}

// FlattenGroups 把分组展平成 Table 的行（组头 + 会话）；collapsed 里的项目只留组头。
func FlattenGroups(gs []Group, collapsed map[string]bool) []SessionRow {
	var rows []SessionRow
	for i := range gs {
		g := &gs[i]
		rows = append(rows, SessionRow{Header: g})
		if collapsed[g.Project] {
			continue
		}
		for j := range g.Sessions {
			rows = append(rows, SessionRow{Session: &g.Sessions[j]})
		}
	}
	return rows
}

// SessionTotals 是会话页合计条。
type SessionTotals struct {
	Projects, Sessions, Active int
	Calls                      int64
	L, M, H                    int64
	Danger                     api.SessionSummaryDanger
}

func TotalsOf(gs []Group) SessionTotals {
	var t SessionTotals
	t.Projects = len(gs)
	for _, g := range gs {
		t.Sessions += len(g.Sessions)
		t.Active += g.Active
		t.Calls += g.Calls
		t.L += g.L
		t.M += g.M
		t.H += g.H
		t.Danger.Total += g.Danger.Total
		t.Danger.WouldHaveBlocked += g.Danger.WouldHaveBlocked
		t.Danger.Enforced += g.Danger.Enforced
	}
	return t
}

// ---- 时间线 ----

// TLRow 是时间线左栏的一行：一次调用/事件，或挂在调用下的一条命中。
type TLRow struct {
	Entry api.TimelineEntry
	Hit   bool // 命中子行
}

// MergeTimeline 把增量条目并进已有列表：新批次里最小 seq 之后的旧条目被替换
// （pending 调用的 post 到达后会变，命中也可能补上），结果按 seq 排序、同 seq 命中在调用之后。
func MergeTimeline(old, fresh []api.TimelineEntry) []api.TimelineEntry {
	if len(fresh) == 0 {
		return old
	}
	min := fresh[0].Seq()
	for _, e := range fresh {
		if e.Seq() < min {
			min = e.Seq()
		}
	}
	out := make([]api.TimelineEntry, 0, len(old)+len(fresh))
	for _, e := range old {
		if e.Seq() < min {
			out = append(out, e)
		}
	}
	out = append(out, fresh...)
	sortTimeline(out)
	return out
}

func sortTimeline(es []api.TimelineEntry) {
	sort.SliceStable(es, func(i, j int) bool {
		if es[i].Seq() != es[j].Seq() {
			return es[i].Seq() < es[j].Seq()
		}
		return es[i].Hit == nil && es[j].Hit != nil
	})
}

// TimelineFilter 是时间线页筛选。
type TimelineFilter struct {
	OnlyDanger bool
	OnlyHits   bool
	Outcome    string // "" | would | enforced
	Rule       string
	Query      string
	MinSev     string // "" | L | M | H
}

func sevRank(s string) int {
	switch s {
	case "H":
		return 3
	case "M":
		return 2
	case "L":
		return 1
	}
	return 0
}

func hitMatches(h *api.TimelineHit, f TimelineFilter) bool {
	if f.OnlyDanger && !h.Dangerous {
		return false
	}
	if f.Rule != "" && h.RuleID != f.Rule {
		return false
	}
	if f.MinSev != "" && sevRank(h.Sev) < sevRank(f.MinSev) {
		return false
	}
	if f.Outcome != "" {
		k := ClassifyOutcome(Str(h.Outcome))
		if (f.Outcome == "would" && k != OutcomeWould) || (f.Outcome == "enforced" && k != OutcomeEnforced) {
			return false
		}
	}
	return true
}

// BuildRows 按筛选生成显示行。命中永远单独成行（不聚合，#100）。
// 有命中类筛选时只保留相关调用及其命中；调用行按 query 做子串匹配。
func BuildRows(es []api.TimelineEntry, f TimelineFilter) []TLRow {
	hitFilter := f.OnlyDanger || f.Rule != "" || f.Outcome != "" || f.MinSev != ""
	q := strings.ToLower(f.Query)
	// 先按 seq 找出每个调用的命中
	hitsAt := map[int64][]*api.TimelineHit{}
	for _, e := range es {
		if e.Hit != nil && hitMatches(e.Hit, f) {
			hitsAt[e.Hit.Seq] = append(hitsAt[e.Hit.Seq], e.Hit)
		}
	}
	var rows []TLRow
	for _, e := range es {
		switch {
		case e.Hit != nil:
			if !hitMatches(e.Hit, f) {
				continue
			}
			if q != "" && !strings.Contains(strings.ToLower(e.Hit.RuleID+" "+Str(e.Hit.Message)), q) && !callMatchesAt(es, e.Hit.Seq, q) {
				continue
			}
			rows = append(rows, TLRow{Entry: e, Hit: true})
		default:
			if (hitFilter || f.OnlyHits) && len(hitsAt[e.Seq()]) == 0 {
				continue
			}
			if q != "" && len(hitsAt[e.Seq()]) == 0 && !entryText(e, q) {
				continue
			}
			rows = append(rows, TLRow{Entry: e})
		}
	}
	return rows
}

func callMatchesAt(es []api.TimelineEntry, seq int64, q string) bool {
	for _, e := range es {
		if e.Seq() == seq && e.Hit == nil && entryText(e, q) {
			return true
		}
	}
	return false
}

func entryText(e api.TimelineEntry, q string) bool {
	switch {
	case e.Call != nil:
		return strings.Contains(strings.ToLower(Str(e.Call.Tool)+" "+Str(e.Call.NormCmd)), q)
	case e.Event != nil:
		return strings.Contains(strings.ToLower(e.Event.Phase), q)
	}
	return false
}

// TimelineStats 是时间线头部合计。
type TimelineStats struct {
	Calls, L, M, H                  int
	Danger, Would, Enforced, Judged int
}

func StatsOfTimeline(es []api.TimelineEntry) TimelineStats {
	var s TimelineStats
	for _, e := range es {
		switch {
		case e.Call != nil:
			s.Calls++
		case e.Hit != nil:
			switch e.Hit.Sev {
			case "L":
				s.L++
			case "M":
				s.M++
			case "H":
				s.H++
			}
			if e.Hit.Dangerous {
				s.Danger++
				switch ClassifyOutcome(Str(e.Hit.Outcome)) {
				case OutcomeWould:
					s.Would++
				case OutcomeEnforced:
					s.Enforced++
				}
			}
		}
	}
	return s
}

// ---- 误报率样本提示（§7） ----

// SmallSample 为真时规则统计里在误报率旁加「样本少」（命中 <10 或已标注 <5）。
func SmallSample(s api.RuleStat) bool { return s.Hits < 10 || s.LabeledFp+s.LabeledUseful < 5 }

// ---- 阈值编辑 ----

// ThField 是阈值展平后的一项。
type ThField struct {
	Path  string
	Value float64
	Ok    bool // false：不是数字（只读展示）
	Raw   any
}

// FlattenThresholds 把 GET /v1/rules 的 thresholds 展平成可编辑的叶子，路径用点号（ladder.advise）。
func FlattenThresholds(m map[string]any) []ThField {
	var out []ThField
	var walk func(prefix string, v map[string]any)
	walk = func(prefix string, v map[string]any) {
		keys := make([]string, 0, len(v))
		for k := range v {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			path := k
			if prefix != "" {
				path = prefix + "." + k
			}
			switch x := v[k].(type) {
			case map[string]any:
				walk(path, x)
			case float64:
				out = append(out, ThField{Path: path, Value: x, Ok: true, Raw: x})
			default:
				out = append(out, ThField{Path: path, Raw: x})
			}
		}
	}
	walk("", m)
	return out
}

// BuildThresholdBody 把改动过的叶子还原成 PUT 的 thresholds：{"repeat":6} 或 {"ladder":{"advise":4}}。只含改过的键。
func BuildThresholdBody(changed map[string]float64) map[string]any {
	body := map[string]any{}
	for path, v := range changed {
		parts := strings.Split(path, ".")
		cur := body
		for _, p := range parts[:len(parts)-1] {
			next, _ := cur[p].(map[string]any)
			if next == nil {
				next = map[string]any{}
				cur[p] = next
			}
			cur = next
		}
		cur[parts[len(parts)-1]] = v
	}
	return body
}

// TodayStartMs 是本地今天 0 点（epoch 毫秒），顶栏「今日危险」用。
func TodayStartMs(now time.Time) int64 {
	y, m, d := now.Local().Date()
	return time.Date(y, m, d, 0, 0, 0, 0, now.Local().Location()).UnixMilli()
}
