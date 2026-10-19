package fake

import (
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/Fan-chou/agent-supervisor/ui/api"
)

// 合成会话 id（固定，便于测试和截图）。
const (
	SessA = "claude-7f3a91c2" // 活跃，T1/L1 命中 + X2 本应拦截（shadow）
	SessB = "codex-b21c4d08"  // 活跃，3 个危险（本应拦截/要求确认）
	SessC = "claude-2e90aa17" // 闲置，几乎没命中
	SessD = "claude-91be3340" // enforce 下真的拦了一次（■ 已拦截）
	SessE = "opencode-5c77e1" // 已结束
)

func home(rest string) string { return "~/dev/" + rest }

func (s *Server) sessions(q url.Values) []api.SessionSummary {
	if r := q.Get("run"); r != "" && r != "1" {
		// 回放运行的会话：一份缩小版
		id := "replay-" + r
		return []api.SessionSummary{
			{RunID: atoi(r), SessionID: id + "-fail-loop", Harness: ptr("claude"), Model: ptr("model-x"), Project: ptr("test/fixtures"), Calls: ptr(int64(18)), HitsL: 2, HitsM: 1, HitsH: 1, Alarms: 3, State: "ended", FirstTs: ptr(s.ms(40 * time.Minute)), LastTs: ptr(s.ms(39 * time.Minute)), Events: 40},
			{RunID: atoi(r), SessionID: id + "-danger", Harness: ptr("codex"), Model: ptr("model-y"), Project: ptr("test/fixtures"), Calls: ptr(int64(9)), HitsH: 1, Alarms: 1, Dangerous: 1, WouldHaveBlocked: 1, Danger: api.SessionSummaryDanger{Total: 1, WouldHaveBlocked: 1}, State: "ended", FirstTs: ptr(s.ms(38 * time.Minute)), LastTs: ptr(s.ms(37 * time.Minute)), Events: 21},
		}
	}
	mk := func(id, harness, model, project string, calls int64, l, m, h int64, d, w, b int64, state string, lastAgo time.Duration, judge int64) api.SessionSummary {
		return api.SessionSummary{RunID: 1, SessionID: id, Harness: ptr(harness), Model: ptr(model), Project: ptr(home(project)), Calls: ptr(calls), HitsL: l, HitsM: m, HitsH: h, Alarms: l + m + h, Dangerous: d, WouldHaveBlocked: w, Blocked: b,
			JudgeCalls: judge, Danger: api.SessionSummaryDanger{Total: d, WouldHaveBlocked: w, Enforced: b}, FirstTs: ptr(s.ms(lastAgo + 50*time.Minute)), LastTs: ptr(s.ms(lastAgo)), Events: calls*2 + 3, State: state}
	}
	out := []api.SessionSummary{
		mk(SessA, "claude", "claude-sonnet-5-5", "agent-supervisor", 132, 5, 2, 1, 1, 1, 0, "active", 40*time.Second, 2),
		mk(SessB, "codex", "gpt-5-codex", "agent-supervisor", 57, 9, 3, 1, 3, 3, 0, "active", 2*time.Minute, 1),
		mk(SessC, "claude", "claude-opus-5-5", "agent-supervisor", 210, 1, 0, 0, 0, 0, 0, "idle", 17*time.Minute, 0),
		mk(SessD, "claude", "claude-sonnet-5-5", "api", 64, 3, 1, 1, 1, 0, 1, "idle", 41*time.Minute, 1),
		mk(SessE, "opencode", "opencode-model", "web", 98, 0, 0, 0, 0, 0, 0, "ended", 3*time.Hour, 0),
	}
	var f []api.SessionSummary
	for _, x := range out {
		if st := q.Get("state"); st != "" && x.State != st {
			continue
		}
		if q.Get("has_danger") == "true" && x.Danger.Total == 0 {
			continue
		}
		f = append(f, x)
	}
	return f
}

func atoi(s string) int64 {
	var n int64
	fmt.Sscan(s, &n)
	return n
}

func (s *Server) sessionSub(w http.ResponseWriter, p string, q url.Values) {
	rest := strings.TrimPrefix(p, "/v1/sessions/")
	parts := strings.SplitN(rest, "/", 2)
	id := parts[0]
	if len(parts) == 2 && parts[1] == "children" {
		var kids []api.ChildSession
		if id == SessA {
			for i, n := range []string{"Explore", "Plan", "general"} {
				kids = append(kids, api.ChildSession{RunID: 1, SessionID: fmt.Sprintf("%s-sub%d", SessA, i), Harness: ptr("claude"), Model: ptr(n), Calls: ptr(int64(7 + i)), ParentSessionID: ptr(SessA)})
			}
		}
		writeJSON(w, 200, api.ChildList{Children: kids})
		return
	}
	if len(parts) == 2 && parts[1] == "timeline" {
		es := s.timeline(id)
		if sinceStr := q.Get("since_seq"); sinceStr != "" {
			since := atoi(sinceStr)
			var cut []api.TimelineEntry
			for _, e := range es {
				if e.Seq() > since {
					cut = append(cut, e)
				}
			}
			es = cut
		}
		if q.Get("severity") == "dangerous" {
			var cut []api.TimelineEntry
			for _, e := range es {
				if e.Hit != nil && e.Hit.Dangerous {
					cut = append(cut, e)
				}
			}
			es = cut
		}
		writeJSON(w, 200, api.Timeline{RunID: 1, Entries: es})
		return
	}
	for _, x := range s.sessions(q) {
		if x.SessionID == id {
			writeJSON(w, 200, x)
			return
		}
	}
	errJSON(w, 404, "not_found", "会话 "+id+" 不存在")
}

type step struct {
	tool, kind, cmd, class string
	mut                    bool
	status                 string
	exit                   int64
	hits                   []hspec
}

type hspec struct {
	rule, sev, msg        string
	danger                string // 危险类别（空 = 非危险）
	subject, reason       string
	action, outcome, mode string
	suppressed            string
	applied               bool
}

var nextHit int64 = 100

func (s *Server) buildTimeline(id string, steps []step, start time.Duration, gap time.Duration) []api.TimelineEntry {
	var es []api.TimelineEntry
	seq := int64(0)
	t0 := s.ms(start)
	es = append(es, api.TimelineEntry{Type: "event", Event: &api.TimelineEvent{Type: "event", Seq: seq, Ts: t0, Phase: "prompt", Origin: ptr("user"), Model: ptr("model")}})
	hid := int64(1)
	if id == SessB {
		hid = 40
	}
	if id == SessD {
		hid = 60
	}
	for i, st := range steps {
		seq += 2
		ts := t0 + int64(i+1)*gap.Milliseconds()
		call := &api.TimelineCall{Type: "call", Seq: seq - 1, PostSeq: ptr(seq), Ts: ts, ToolUseID: ptr(fmt.Sprintf("tu_%d", i)), Tool: ptr(st.tool), Kind: ptr(st.kind), CmdClass: ptr(st.class), NormCmd: ptr(st.cmd), Mutating: ptr(st.mut), Status: st.status, ExitCode: ptr(st.exit), Model: ptr("model")}
		if st.status == "pending" {
			call.PostSeq, call.ExitCode = nil, nil
		}
		es = append(es, api.TimelineEntry{Type: "call", Call: call})
		for _, h := range st.hits {
			mode := Or(h.mode, "shadow")
			d := api.Decision{ID: hid + 1000, Action: h.action, Applied: h.applied, Mode: ptr(mode), Outcome: ptr(h.outcome), WouldBlockIfVerified: false, Message: ptr(h.msg)}
			if h.suppressed != "" {
				d.SuppressedBy = ptr(h.suppressed)
			}
			th := &api.TimelineHit{Type: "hit", Seq: call.Seq, Ts: ts, HitID: hid, RuleID: h.rule, Sev: h.sev, Severity: ptr(map[string]string{"L": "low", "M": "medium", "H": "high"}[h.sev]), Category: ptr("loop"), Phase: ptr("pre"), CallIndex: ptr(int64(i + 1)), Message: ptr(h.msg), Decisions: []api.Decision{d}, Outcome: ptr(h.outcome), Applied: h.applied}
			if h.danger != "" {
				th.Severity, th.Dangerous, th.DangerCategory, th.DangerSubject, th.DangerReason, th.Category = ptr("dangerous"), true, ptr(h.danger), ptr(h.subject), ptr(h.reason), ptr("unsafe")
			}
			es = append(es, api.TimelineEntry{Type: "hit", Hit: th})
			hid++
		}
	}
	return es
}

// Or 返回 s，空则 alt。
func Or(s, alt string) string {
	if s == "" {
		return alt
	}
	return s
}

func sh(cmd string) step {
	return step{tool: "Bash", kind: "shell", cmd: cmd, class: "other", status: "ok"}
}
func rd(path string) step {
	return step{tool: "Read", kind: "read", cmd: path, class: "read", status: "ok"}
}
func ed(path string) step {
	return step{tool: "Edit", kind: "edit", cmd: path, class: "edit", mut: true, status: "ok"}
}

func (s *Server) timeline(id string) []api.TimelineEntry {
	switch id {
	case SessA:
		pytest := func(exit int64, hits ...hspec) step {
			st := step{tool: "Bash", kind: "shell", cmd: "pytest -q", class: "test_full", status: "ok", exit: exit, hits: hits}
			if exit != 0 {
				st.status = "fail"
			}
			return st
		}
		steps := []step{
			sh("ls -la"), rd("src/parser.py"), rd("tests/test_parser.py"), sh("sed -n 1,40p src/parser.py"),
			ed("src/parser.py"), pytest(1), ed("src/parser.py"),
			pytest(1, hspec{rule: "T1", sev: "L", msg: "工作区自上次运行 pytest 以来没有变化，上次结果：1 failed。", action: "advise", outcome: "would_have_advised"}),
			pytest(1, hspec{rule: "T1", sev: "L", msg: "第 2 次无改动重跑 pytest。", action: "advise", outcome: "would_have_advised"}, hspec{rule: "T2", sev: "L", msg: "没有编辑就再次全量测试。", action: "advise", outcome: "would_have_advised"}),
			pytest(1, hspec{rule: "T1", sev: "H", msg: "第 3 次无改动重跑 pytest（指纹已核实）。", action: "block", outcome: "would_have_blocked"}),
			sh("git status --short"), rd("src/lexer.py"),
			{tool: "Bash", kind: "shell", cmd: "git reset --hard HEAD~1", class: "other", mut: true, status: "ok", hits: []hspec{{rule: "X2", sev: "H", msg: "X2：命令包含 git reset --hard，可能丢失未提交的工作。", danger: "git", subject: "git reset --hard HEAD~1", reason: "可能丢失未提交的工作", action: "block", outcome: "would_have_blocked"}}},
			sh("git status --short"), ed("src/lexer.py"), pytest(0), sh("git diff --stat"),
			{tool: "Bash", kind: "shell", cmd: "pytest -q tests/test_lexer.py", class: "test_one", status: "pending"},
		}
		s.mu.Lock()
		extra, live := s.Extra, append([]step(nil), s.live...)
		s.mu.Unlock()
		// 压测：Extra 个调用，每 5 个一条 L 命中、每 10 个一条 X2 危险（会拦）
		for i := 0; i < extra; i++ {
			st := sh(fmt.Sprintf("echo step %d", i))
			switch {
			case i%10 == 9:
				st.mut = true
				st.cmd = fmt.Sprintf("rm -rf build-%d", i)
				st.hits = []hspec{{rule: "X2", sev: "H", msg: "X2：rm -rf", danger: "rm", subject: st.cmd, reason: "递归删除", action: "block", outcome: "would_have_blocked"}}
			case i%5 == 4:
				st.hits = []hspec{{rule: "T1", sev: "L", msg: "无改动重跑", action: "advise", outcome: "would_have_advised"}}
			}
			steps = append(steps, st)
		}
		steps = append(steps, live...)
		return s.buildTimeline(id, steps, 50*time.Minute, 90*time.Second)
	case SessB:
		steps := []step{
			sh("ls"), rd("Cargo.toml"), sh("cargo build"),
			{tool: "Bash", kind: "shell", cmd: "echo SECRET=1 >> .env", class: "other", mut: true, status: "ok", hits: []hspec{{rule: "X2", sev: "H", msg: "X2：写入 .env", danger: "env", subject: ".env", reason: "写入环境变量文件", action: "ask", outcome: "would_have_asked"}}},
			sh("cargo test"),
			{tool: "Bash", kind: "shell", cmd: "rm -rf target build", class: "other", mut: true, status: "ok", hits: []hspec{{rule: "X2", sev: "H", msg: "X2：rm -rf 非临时目录", danger: "rm", subject: "rm -rf target build", reason: "递归删除", action: "block", outcome: "would_have_blocked"}}},
			sh("cargo build --release"),
			{tool: "Bash", kind: "shell", cmd: "git push --force origin main", class: "other", mut: true, status: "ok", hits: []hspec{{rule: "X2", sev: "H", msg: "X2：git push --force", danger: "git", subject: "git push --force origin main", reason: "改写远端历史", action: "block", outcome: "would_have_blocked"}}},
		}
		return s.buildTimeline(id, steps, 30*time.Minute, 2*time.Minute)
	case SessD:
		steps := []step{
			sh("ls"), rd("api/server.go"),
			{tool: "Bash", kind: "shell", cmd: "rm -rf /var/tmp/../data", class: "other", mut: true, status: "fail", exit: 1, hits: []hspec{{rule: "X2", sev: "H", msg: "X2：rm -rf 越出临时目录（enforce：已拦截）", danger: "rm", subject: "rm -rf /var/tmp/../data", reason: "递归删除越出临时目录", action: "block", outcome: "blocked", mode: "enforce", applied: true}}},
			sh("go test ./..."),
		}
		return s.buildTimeline(id, steps, 80*time.Minute, time.Minute)
	}
	return s.buildTimeline(id, []step{sh("ls"), rd("README.md"), ed("README.md")}, 3*time.Hour, time.Minute)
}

func (s *Server) allHits() []api.Hit {
	var hs []api.Hit
	for _, id := range []string{SessA, SessB, SessD} {
		for _, e := range s.timeline(id) {
			if e.Hit == nil {
				continue
			}
			h := e.Hit
			d := h.Decisions[0]
			hs = append(hs, api.Hit{ID: h.HitID, RunID: 1, SessionID: id, Seq: h.Seq, Ts: h.Ts, RuleID: h.RuleID, Sev: h.Sev, Severity: h.Severity, Dangerous: h.Dangerous, Category: h.Category, Phase: h.Phase, Message: h.Message, Model: ptr("model"), Action: ptr(d.Action), Outcome: d.Outcome, Applied: d.Applied})
		}
	}
	sort.Slice(hs, func(i, j int) bool { return hs[i].ID > hs[j].ID })
	return hs
}

func (s *Server) hits(q url.Values) api.HitList {
	var out []api.Hit
	for _, h := range s.allHits() {
		if r := q.Get("rule"); r != "" && h.RuleID != r {
			continue
		}
		if q.Get("label") == "unlabeled" && h.Label != nil {
			continue
		}
		out = append(out, h)
	}
	return api.HitList{Hits: out}
}

func (s *Server) explain(id int64) api.Explain {
	var h api.Hit
	for _, x := range s.allHits() {
		if x.ID == id {
			h = x
		}
	}
	dec := map[string]any{"id": id + 1000, "action": Str(h.Action), "applied": h.Applied, "outcome": Str(h.Outcome), "mode": "shadow", "suppressed_by": nil, "message": Str(h.Message), "judge_call_id": nil}
	ex := api.Explain{Hit: map[string]any{"id": id, "rule_id": h.RuleID, "sev": h.Sev, "session_id": h.SessionID, "seq": h.Seq, "message": Str(h.Message), "phase": "pre", "threshold_json": `{"advise":2,"H":3}`, "observed_json": `{"attempt":3}`, "fingerprint": "git:2f3a9c…"},
		Events:    []map[string]any{{"seq": h.Seq, "phase": "pre", "tool_name": "Bash", "norm_cmd": "pytest -q", "status": "ok"}},
		Decisions: []map[string]any{dec}, Judge: []map[string]any{}, Deliveries: []map[string]any{}, Labels: []map[string]any{}}
	if h.RuleID == "L1" || h.RuleID == "T2" {
		dec["judge_call_id"] = 3
		ex.Judge = []map[string]any{{"id": 3, "verdict": "advise", "model": "supervisor-judge", "status": "ok"}}
	}
	return ex
}

func Str(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func (s *Server) dangerEvents() []api.DangerEvent {
	var out []api.DangerEvent
	for _, id := range []string{SessA, SessB, SessD} {
		for _, e := range s.timeline(id) {
			if e.Hit == nil || !e.Hit.Dangerous {
				continue
			}
			h := e.Hit
			d := h.Decisions[0]
			out = append(out, api.DangerEvent{HitID: h.HitID, RunID: 1, SessionID: id, Ts: h.Ts, CallIndex: h.CallIndex, Category: h.DangerCategory, Subject: h.DangerSubject, Reason: h.DangerReason, Action: ptr(d.Action), Outcome: d.Outcome, Mode: d.Mode, Model: ptr("model")})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Ts > out[j].Ts })
	return out
}

func (s *Server) dangerStats() api.DangerStats {
	st := api.DangerStats{ByCategory: map[string]int64{}, ByOutcome: map[string]int64{}}
	by := map[string]*api.DangerStatsBySessionItem{}
	for _, e := range s.dangerEvents() {
		st.Total++
		st.ByCategory[Str(e.Category)]++
		st.ByOutcome[Str(e.Outcome)]++
		b := by[e.SessionID]
		if b == nil {
			b = &api.DangerStatsBySessionItem{RunID: 1, SessionID: e.SessionID}
			by[e.SessionID] = b
		}
		b.Dangerous++
		switch o := Str(e.Outcome); {
		case strings.HasPrefix(o, "would_have_"):
			st.WouldHaveBlocked++
			b.WouldHaveBlocked++
		case o == "blocked" || o == "asked":
			st.Enforced++
			b.Enforced++
		}
	}
	for _, id := range []string{SessB, SessA, SessD} {
		if b := by[id]; b != nil {
			st.BySession = append(st.BySession, *b)
		}
	}
	return st
}

func defaultRules() []api.Rule {
	r := func(id, title, cat, level string, th map[string]any) api.Rule {
		return api.Rule{ID: id, Title: title, Category: cat, Level: level, Source: "LoopGuard、self-critic", Thresholds: th}
	}
	rules := []api.Rule{
		r("L1", "同一调用连续失败", "loop", "M→H", map[string]any{"advise_after_failures": float64(2), "block_after_failures": float64(3)}),
		r("L2", "同一调用且输出哈希相同（最近若干步内）", "loop", "M", map[string]any{"repeat": float64(4), "window_steps": float64(12)}),
		r("T1", "无改动重跑同命令", "test", "L→H", map[string]any{"ladder": map[string]any{"L": float64(2), "advise": float64(2), "H": float64(3)}}),
		r("T2", "没有编辑就再次全量测试", "test", "L→M", map[string]any{"ladder": map[string]any{"advise": float64(3), "M": float64(5)}}),
		r("S2", "同一阶段停滞", "stagnation", "observe", map[string]any{"stall_steps": float64(7)}),
		r("R3", "上下文占用过高", "resource", "M", map[string]any{"context_window": float64(200000), "ratio": 0.8}),
		r("X2", "危险操作", "unsafe", "H", map[string]any{}),
	}
	rules[4].ObserveOnly = true
	rules[4].Disabled, rules[4].Edited, rules[4].Override = true, true, map[string]any{"disabled": true}
	rules[6].Protected = true
	return rules
}

func (s *Server) ruleStats() []api.RuleStat {
	f := func(v float64) *float64 { return &v }
	return []api.RuleStat{
		{Rule: "L1", Hits: 38, Sessions: 9, HitsPer100Calls: f(1.0), SessionRate: f(0.22), BySev: map[string]int64{"M": 26, "H": 12}, Actions: map[string]int64{"advise": 21, "block": 7}, Outcomes: map[string]int64{"would_have_advised": 21, "would_have_blocked": 7}, Suppressed: map[string]int64{"cooldown": 10}, Applied: 0, LabeledFp: 4, LabeledUseful: 9, FpRate: f(0.31), Delivered: 14, Complied: 10, NotComplied: 4, ComplianceRate: f(0.71)},
		{Rule: "T1", Hits: 96, Sessions: 14, HitsPer100Calls: f(2.5), SessionRate: f(0.34), BySev: map[string]int64{"L": 60, "H": 36}, Actions: map[string]int64{"advise": 60, "skip": 36}, Outcomes: map[string]int64{"would_have_advised": 60}, Suppressed: map[string]int64{"cooldown": 36}, LabeledFp: 11, LabeledUseful: 3, FpRate: f(0.79), Delivered: 20, Complied: 8, NotComplied: 12, ComplianceRate: f(0.4)},
		{Rule: "T2", Hits: 9, Sessions: 4, HitsPer100Calls: f(0.2), SessionRate: f(0.1), BySev: map[string]int64{"L": 9}, Actions: map[string]int64{"advise": 9}, Outcomes: map[string]int64{"would_have_advised": 9}, Suppressed: map[string]int64{}},
		{Rule: "X2", Hits: 5, Sessions: 3, HitsPer100Calls: f(0.1), SessionRate: f(0.07), BySev: map[string]int64{"H": 5}, Actions: map[string]int64{"ask": 1, "block": 4}, Outcomes: map[string]int64{"would_have_blocked": 3, "would_have_asked": 1, "blocked": 1}, Suppressed: map[string]int64{}, Applied: 1, LabeledFp: 0, LabeledUseful: 1, FpRate: f(0)},
	}
}

func (s *Server) modelStats() []api.ModelRuleStat {
	f := func(v float64) *float64 { return &v }
	return []api.ModelRuleStat{
		{Model: "claude-sonnet-5-5", Calls: 1284, Rule: "T1", Hits: 40, HitsPer100Calls: f(3.1)},
		{Model: "claude-sonnet-5-5", Calls: 1284, Rule: "L1", Hits: 12, HitsPer100Calls: f(0.93)},
		{Model: "gpt-5-codex", Calls: 640, Rule: "T1", Hits: 31, HitsPer100Calls: f(4.8)},
		{Model: "claude-opus-5-5", Calls: 910, Rule: "T1", Hits: 8, HitsPer100Calls: f(0.88)},
	}
}

func (s *Server) runs() []api.Run {
	return []api.Run{
		{ID: 4, Kind: "eval", Label: ptr("eval-1"), Source: ptr("test/fixtures/sessions"), Mode: ptr("shadow"), JudgeMode: ptr("mock"), ThresholdsHash: ptr("dc4b0245"), StartedTs: s.ms(26 * time.Hour), EndedTs: ptr(s.ms(26*time.Hour - 4*time.Second)), Sessions: 8, Hits: 74},
		{ID: 3, Kind: "replay", Label: ptr("t1h4"), Source: ptr("test/fixtures/sessions"), Mode: ptr("shadow"), JudgeMode: ptr("mock"), ThresholdsHash: ptr("ed937b28"), OverridesJson: ptr(`["thresholds.T1.H=4"]`), StartedTs: s.ms(27 * time.Hour), EndedTs: ptr(s.ms(27*time.Hour - 3*time.Second)), Sessions: 8, Hits: 71},
		{ID: 2, Kind: "replay", Label: ptr("base"), Source: ptr("test/fixtures/sessions"), Mode: ptr("shadow"), JudgeMode: ptr("mock"), ThresholdsHash: ptr("dc4b0245"), StartedTs: s.ms(27*time.Hour + 2*time.Minute), EndedTs: ptr(s.ms(27*time.Hour + 2*time.Minute - 3*time.Second)), Sessions: 8, Hits: 74},
		{ID: 1, Kind: "live", Label: ptr("daemon"), Source: ptr("pid 4312"), Mode: ptr("shadow"), JudgeMode: ptr("on"), ThresholdsHash: ptr("dc4b0245"), StartedTs: s.ms(3 * time.Hour), Sessions: 5, Hits: 56},
	}
}

func (s *Server) runDetail(id int64) api.RunDetail {
	for _, r := range s.runs() {
		if r.ID != id {
			continue
		}
		ov := []string{}
		if r.OverridesJson != nil {
			ov = []string{"thresholds.T1.H=4"}
		}
		return api.RunDetail{ID: r.ID, Kind: r.Kind, Label: r.Label, Source: r.Source, Mode: r.Mode, JudgeMode: r.JudgeMode, Version: ptr("0.1.0"), ThresholdsHash: r.ThresholdsHash, StartedTs: r.StartedTs, EndedTs: r.EndedTs,
			Tuning: map[string]any{"thresholds": map[string]any{"T1": map[string]any{"L": 2, "advise": 2, "H": 3}}, "budgets": map[string]any{}}, Overrides: ov, Sessions: r.Sessions, Calls: 412, Hits: r.Hits, JudgeCalls: 6}
	}
	return api.RunDetail{ID: id, Kind: "live", StartedTs: s.ms(time.Hour)}
}

func (s *Server) compare() api.RunCompare {
	return api.RunCompare{A: 2, B: 3, Rows: []api.RunDiffRow{
		{Rule: "L1", HitsA: 12, HitsB: 12, AlarmsA: 9, AlarmsB: 9},
		{Rule: "T1", HitsA: 31, HitsB: 28, DeltaHits: -3, AlarmsA: 6, AlarmsB: 5, DeltaAlarms: -1, BlocksA: 4, BlocksB: 2},
		{Rule: "T2", HitsA: 9, HitsB: 9, AlarmsA: 9, AlarmsB: 9},
		{Rule: "X2", HitsA: 2, HitsB: 2, AlarmsA: 2, AlarmsB: 2, BlocksA: 2, BlocksB: 2},
	}}
}

func (s *Server) evalReports() []api.EvalReport {
	rs := s.runs()
	return []api.EvalReport{{Run: rs[0], Rules: s.ruleStats()[:3]}}
}

func (s *Server) config() api.ConfigView {
	return api.ConfigView{Source: "daemon-startup", Judge: api.ConfigViewJudge{ApiKeyEnv: "SUPERVISOR_API_KEY", ApiKeySet: true},
		Sources: map[string]string{"mode": "default", "judge.model": "configured"},
		Config: map[string]any{"mode": s.Mode, "judge": map[string]any{"enabled": true, "base_url": "http://127.0.0.1:3425/v1", "model": "supervisor-judge", "api_key_env": "SUPERVISOR_API_KEY",
			"routes": []any{map[string]any{"when": map[string]any{"sync": true}, "model": "fast-judge"}, map[string]any{"when": map[string]any{"rule": "T*"}, "model": "supervisor-judge"}}}}}
}

func (s *Server) judgeRoutes() api.JudgeRoutes {
	f := func(v float64) *float64 { return &v }
	return api.JudgeRoutes{Enabled: true, BaseUrl: "http://127.0.0.1:3425/v1", DefaultModel: "supervisor-judge", Since: ptr[int64](s.ms(7 * 24 * time.Hour)),
		Routes: []api.JudgeRouteRow{
			{Index: ptr[int64](0), Use: "同步（sync=true）", When: api.JudgeRouteRowWhen{Sync: true}, Model: "fast-judge", Status: "ok", Calls: 38, Ok: 38, ParseFailRate: f(0), LatencyP95: f(2400), FormatLevel: ptr("json_schema"), Reasons: []string{"routes[0] 命中"}},
			{Index: ptr[int64](1), Use: "规则 T*", When: api.JudgeRouteRowWhen{Rule: "T*"}, Model: "supervisor-judge", Status: "ok", Calls: 61, Ok: 60, ParseFail: 1, ParseFailRate: f(0.016), LatencyP95: f(9100), FormatLevel: ptr("json_schema"), Reasons: []string{"routes[1] 命中"}},
			{Use: "默认", When: api.JudgeRouteRowWhen{}, Model: "supervisor-judge", Status: "degraded", Calls: 115, Ok: 100, ParseFail: 9, Timeouts: 1, Errors: 5, ParseFailRate: f(0.078), LatencyP95: f(14000), FormatLevel: ptr("json_object"), FormatDowngrades: 1,
				LastFailureID: ptr[int64](2), LastFailureTs: ptr[int64](s.ms(12 * time.Minute)), LastFailureStatus: ptr("parse_fail"), LastFailureError: ptr("响应不是合法 JSON（已重试 1 次）"),
				Reasons: []string{"没有路由命中时走 judge.model", "response_format 已降级 1 次，当前 json_object"}},
		}}
}

func (s *Server) judgeCalls() api.JudgeCallList {
	f := func(v float64) *float64 { return &v }
	mk := func(id int64, ago time.Duration, sess string, rules []string, sync bool, route, model, status string, verdict *string, conf *float64, lat float64, pt, ct float64, cost *float64, errMsg *string, down bool) api.JudgeCall {
		return api.JudgeCall{ID: id, RunID: 1, SessionID: sess, Harness: ptr("claude"), Ts: s.ms(ago), RuleIds: rules, Sync: sync, RouteModel: ptr(route), Model: ptr(model), Status: status, Verdict: verdict, Confidence: conf, Category: ptr("loop"), LatencyMs: f(lat), PromptTokens: f(pt), CompletionTokens: f(ct), CachedTokens: f(pt / 3), CostUsd: cost, Retries: f(0), FormatDowngraded: down, Error: errMsg}
	}
	calls := []api.JudgeCall{
		mk(5, 4*time.Minute, SessB, []string{"T2"}, false, "supervisor-judge", "supervisor-judge", "ok", ptr("advise"), f(0.82), 5100, 8100, 400, f(0.012), nil, false),
		mk(4, 6*time.Minute, SessA, []string{"L1"}, true, "fast-judge", "fast-judge", "ok", ptr("block"), f(0.72), 2000, 7600, 200, f(0.003), nil, false),
		mk(3, 9*time.Minute, SessA, []string{"T1", "L1"}, false, "supervisor-judge", "supervisor-judge", "ok", ptr("advise"), f(0.9), 7400, 9000, 500, f(0.015), nil, true),
		mk(2, 12*time.Minute, SessD, []string{"L3"}, false, "supervisor-judge", "supervisor-judge", "parse_fail", nil, nil, 3300, 7900, 100, f(0.002), ptr("响应不是合法 JSON（已重试 1 次）"), false),
		mk(1, 30*time.Minute, SessB, []string{"T1"}, false, "supervisor-judge", "supervisor-judge", "ok", ptr("ignore"), f(0.6), 4800, 6000, 150, f(0.008), nil, false),
	}
	return api.JudgeCallList{Calls: calls, Totals: api.JudgeCallListTotals{Calls: 214, Ok: 201, Failed: 13, ParseFail: 7, PromptTokens: 1.82e6, CompletionTokens: 96000, CachedTokens: 6.1e5, CostUsd: f(3.41), LatencyP50: f(4200), LatencyP95: f(14200)}}
}

func (s *Server) judgeDetail(id int64) api.JudgeCallDetail {
	var c api.JudgeCall
	for _, x := range s.judgeCalls().Calls {
		if x.ID == id {
			c = x
		}
	}
	f := func(v float64) *float64 { return &v }
	return api.JudgeCallDetail{ID: c.ID, RunID: c.RunID, SessionID: c.SessionID, Harness: c.Harness, Ts: c.Ts, RuleIds: c.RuleIds, Sync: c.Sync, RouteModel: c.RouteModel, Model: c.Model, Status: c.Status, Verdict: c.Verdict, Confidence: c.Confidence, Category: c.Category, LatencyMs: c.LatencyMs, PromptTokens: c.PromptTokens, CompletionTokens: c.CompletionTokens, CachedTokens: c.CachedTokens, CostUsd: c.CostUsd, Retries: c.Retries, FormatDowngraded: c.FormatDowngraded, Error: c.Error,
		Reason: ptr("同一错误重复出现，建议先读报错再改。"), MessageRaw: ptr("同一调用已连续失败。先读完整报错，再决定是否改动。"), HttpRequests: f(2), FormatLevel: ptr("json_object"), Repairs: []string{"strip-think", "close-truncated"},
		Request: map[string]any{"messages": []any{map[string]any{"role": "user", "content": "任务 · 规则与证据 · 最近 25 步 · 改动摘要（已脱敏）"}}}, Response: map[string]any{"verdict": Str(c.Verdict), "confidence": 0.82},
		BodiesStored: true, Hits: []map[string]any{{"id": 1, "rule_id": "T1"}}, Decisions: []map[string]any{{"id": 9, "action": "advise", "applied": false, "outcome": "would_have_advised"}}, Deliveries: []map[string]any{}}
}

func (s *Server) judgeStats() []api.JudgeStat {
	f := func(v float64) *float64 { return &v }
	return []api.JudgeStat{
		{Model: "supervisor-judge", Calls: 176, Ok: 163, Ignores: 70, Advises: 80, Blocks: 13, ParseFail: 7, Timeouts: 1, Errors: 5, IgnoreRate: f(0.4), ParseFailRate: f(0.04), LatencyP50: f(5100), LatencyP95: f(14200), PromptTokens: 1.5e6, CompletionTokens: 80000, CachedTokens: 5e5, CostUsd: 3.1, Retries: 3, FormatDowngrades: 1},
		{Model: "fast-judge", Calls: 38, Ok: 38, Ignores: 22, Advises: 14, Blocks: 2, IgnoreRate: f(0.58), ParseFailRate: f(0), LatencyP50: f(1800), LatencyP95: f(2400), PromptTokens: 3.2e5, CompletionTokens: 16000, CachedTokens: 1.1e5, CostUsd: 0.31},
	}
}
