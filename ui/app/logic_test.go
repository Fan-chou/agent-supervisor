package app

import (
	"testing"
	"time"

	"github.com/Fan-chou/agent-supervisor/ui/api"
)

func TestClassifyOutcome(t *testing.T) {
	cases := map[string]OutcomeKind{
		"would_have_blocked": OutcomeWould, "would_have_asked": OutcomeWould,
		"blocked": OutcomeEnforced, "asked": OutcomeEnforced,
		"would_have_advised": OutcomeAdvise, "advised": OutcomeAdvise,
		"": OutcomeNone, "weird": OutcomeNone,
	}
	for in, want := range cases {
		if got := ClassifyOutcome(in); got != want {
			t.Errorf("%q → %v，想要 %v", in, got, want)
		}
	}
	// 三种状态的文案互不相同，shadow 的「本应拦截」必须写明未生效
	w, b := OutcomeText("would_have_blocked", "shadow"), OutcomeText("blocked", "enforce")
	if w == b || w != "本应拦截（shadow，未生效）" || b != "已拦截" {
		t.Errorf("文案不对：%q / %q", w, b)
	}
}

func TestMachineTransitions(t *testing.T) {
	m := NewMachine()
	t0 := time.Unix(1000, 0)
	m.OnOK(t0, true)
	if m.State != Live {
		t.Fatal("流打开应进入 live")
	}
	// live → reconnecting（前 3 次失败）→ degraded（第 4 次）
	for i := 1; i <= 3; i++ {
		if s := m.OnFail(t0.Add(time.Duration(i)*time.Second), "x"); s != Reconnecting {
			t.Fatalf("第 %d 次失败应是 reconnecting，得到 %v", i, s)
		}
	}
	if s := m.OnFail(t0.Add(4*time.Second), "x"); s != Degraded {
		t.Fatalf("第 4 次失败应进入 degraded，得到 %v", s)
	}
	// degraded 连续 60 秒失败 → offline，页面变灰
	if s := m.OnFail(t0.Add(30*time.Second), "x"); s != Degraded {
		t.Fatalf("未满 60 秒仍是 degraded，得到 %v", s)
	}
	if s := m.OnFail(t0.Add(65*time.Second), "x"); s != Offline || !m.Stale() {
		t.Fatalf("满 60 秒应进入 offline，得到 %v", s)
	}
	// 轮询成功 → connecting，再开流成功 → live
	m.OnOK(t0.Add(70*time.Second), false)
	if m.State != Connecting || m.Failures != 0 {
		t.Fatalf("轮询成功应回到 connecting，得到 %v", m.State)
	}
	m.OnOK(t0.Add(71*time.Second), true)
	if m.State != Live {
		t.Fatal("应回到 live")
	}
}

func TestBackoffCapped(t *testing.T) {
	m := NewMachine()
	m.State = Reconnecting
	for n, max := range map[int]time.Duration{1: 1200 * time.Millisecond, 3: 4800 * time.Millisecond, 20: 36 * time.Second} {
		m.Failures = n
		for i := 0; i < 50; i++ {
			if d := m.Backoff(); d > max || d < 800*time.Millisecond {
				t.Fatalf("failures=%d 退避 %v 越界（上限 %v）", n, d, max)
			}
		}
	}
}

func TestMergeTimelineReplacesPending(t *testing.T) {
	call := func(seq int64, status string) api.TimelineEntry {
		return api.TimelineEntry{Type: "call", Call: &api.TimelineCall{Seq: seq, Status: status}}
	}
	hit := func(seq, id int64) api.TimelineEntry {
		return api.TimelineEntry{Type: "hit", Hit: &api.TimelineHit{Seq: seq, HitID: id, RuleID: "T1"}}
	}
	old := []api.TimelineEntry{call(1, "ok"), call(3, "pending")}
	got := MergeTimeline(old, []api.TimelineEntry{call(3, "ok"), hit(3, 7), call(5, "pending")})
	if len(got) != 4 || got[1].Call.Status != "ok" || got[2].Hit == nil || got[3].Seq() != 5 {
		t.Fatalf("合并结果不对：%+v", got)
	}
}

func TestBuildRowsKeepsEveryHit(t *testing.T) {
	mk := func(seq, id int64, rule string, danger bool, outcome string) api.TimelineEntry {
		o := outcome
		return api.TimelineEntry{Type: "hit", Hit: &api.TimelineHit{Seq: seq, HitID: id, RuleID: rule, Sev: "H", Dangerous: danger, Outcome: &o}}
	}
	call := func(seq int64) api.TimelineEntry {
		return api.TimelineEntry{Type: "call", Call: &api.TimelineCall{Seq: seq}}
	}
	es := []api.TimelineEntry{call(1), call(2), mk(2, 1, "T1", false, "would_have_blocked"), mk(2, 2, "T1", false, "would_have_blocked"), call(3), mk(3, 3, "X2", true, "would_have_blocked")}
	if rows := BuildRows(es, TimelineFilter{}); len(rows) != 6 {
		t.Fatalf("不筛选应全部显示（命中不合并），得到 %d 行", len(rows))
	}
	if rows := BuildRows(es, TimelineFilter{OnlyDanger: true}); len(rows) != 2 || !rows[1].Hit {
		t.Fatalf("仅危险应只剩危险命中所在的调用 + 命中，得到 %d 行", len(rows))
	}
}

func TestThresholdsRoundTrip(t *testing.T) {
	fs := FlattenThresholds(map[string]any{"repeat": 5.0, "ladder": map[string]any{"advise": 3.0, "block": 6.0}, "name": "x"})
	if len(fs) != 4 || fs[0].Path != "ladder.advise" || !fs[0].Ok || fs[3].Path != "repeat" {
		t.Fatalf("flatten: %+v", fs)
	}
	if fs[2].Ok {
		t.Fatalf("string leaf must be read-only: %+v", fs[2])
	}
	body := BuildThresholdBody(map[string]float64{"ladder.advise": 4, "repeat": 6})
	l, _ := body["ladder"].(map[string]any)
	if body["repeat"] != 6.0 || l["advise"] != 4.0 || len(l) != 1 {
		t.Fatalf("body: %+v", body)
	}
}

func TestGroupSessionsDangerFirst(t *testing.T) {
	p1, p2 := "~/a", "~/b"
	l1, l2 := int64(100), int64(200)
	ss := []api.SessionSummary{
		{SessionID: "s1", Project: &p1, LastTs: &l1, Danger: api.SessionSummaryDanger{Total: 2, WouldHaveBlocked: 2}},
		{SessionID: "s2", Project: &p2, LastTs: &l2},
	}
	gs := GroupSessions(ss, SessionFilter{SortDanger: true})
	if gs[0].Project != "~/a" || gs[0].Danger.WouldHaveBlocked != 2 {
		t.Fatalf("按危险排序时有危险的项目应在前：%+v", gs[0])
	}
	if gs := GroupSessions(ss, SessionFilter{}); gs[0].Project != "~/b" {
		t.Fatal("默认按最近活动")
	}
}
