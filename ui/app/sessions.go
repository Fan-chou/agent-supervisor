package app

import (
	"context"
	"fmt"
	"net/url"
	"strings"

	"github.com/Fan-chou/agent-supervisor/ui/api"
	"github.com/egoist/mygo/ui"
)

const (
	tlInitialLimit = 500
	tlRewind       = 4
	tlMaxEntries   = 5000
)

type sessionsPage struct {
	sel       string
	query     string
	scope     int // 0 进行中 · 1 全部
	collapsed map[string]bool
	left      ui.ListState
	splitW    float32

	entries  []api.TimelineEntry
	tlLoaded bool
	hasMore  bool
	filter   int // 0 全部 · 1 仅命中 · 2 仅危险
	tl       ui.ListState
	rows     []TLRow
	hitSel   int64
	showInsp bool
}

func (s *sessionsPage) init() {
	s.collapsed = map[string]bool{}
	s.splitW = 360
	s.tl.FollowEnd = true
}

func (a *App) defaultSession() string {
	best := ""
	for _, s := range a.sessions {
		if s.State == "ended" {
			continue
		}
		if best == "" {
			best = s.SessionID
		}
		if s.Danger.Total > 0 {
			return s.SessionID
		}
	}
	if best == "" && len(a.sessions) > 0 {
		best = a.sessions[0].SessionID
	}
	return best
}

func (a *App) selectSession(id string) {
	if a.ss.sel == id {
		return
	}
	a.ss.sel, a.ss.entries, a.ss.tlLoaded, a.ss.hasMore = id, nil, false, false
	a.ss.hitSel, a.ss.showInsp = 0, false
	a.ss.tl = ui.ListState{FollowEnd: true}
	a.loadTimeline()
}

func (a *App) sessionByID(id string) *api.SessionSummary {
	for i := range a.sessions {
		if a.sessions[i].SessionID == id {
			return &a.sessions[i]
		}
	}
	return nil
}

func (a *App) loadTimeline() {
	t := &a.ss
	id := t.sel
	if id == "" {
		return
	}
	var lastSeq int64
	if n := len(t.entries); n > 0 {
		lastSeq = t.entries[n-1].Seq()
		for _, e := range t.entries {
			if e.Call != nil && e.Call.Status == "pending" && e.Seq() < lastSeq {
				lastSeq = e.Seq()
			}
		}
	}
	loaded := t.tlLoaded
	a.async("timeline", func(ctx context.Context) (func(), error) {
		q := url.Values{}
		if loaded {
			since := lastSeq - tlRewind
			if since < 0 {
				since = 0
			}
			q.Set("since_seq", fmt.Sprint(since))
			q.Set("limit", "1000")
		} else {
			q.Set("before_seq", "1000000000000")
			q.Set("limit", fmt.Sprint(tlInitialLimit))
		}
		tl, err := a.Client.Timeline(ctx, id, q)
		if err != nil {
			return nil, err
		}
		return func() {
			if a.ss.sel != id {
				return
			}
			if a.ss.tlLoaded {
				a.ss.entries = MergeTimeline(a.ss.entries, tl.Entries)
			} else {
				a.ss.entries, a.ss.hasMore = tl.Entries, tl.HasMore
			}
			if n := len(a.ss.entries); n > tlMaxEntries {
				a.ss.entries = a.ss.entries[n-tlMaxEntries:]
				a.ss.hasMore = true
			}
			a.ss.tlLoaded = true
		}, nil
	})
}

func (a *App) sessionsView(c *ui.Context) {
	ui.Row(c).Fill().Padding(0, 24, 16, 24).AlignItems(ui.Stretch).Children(func() {
		ui.Split(c, &a.ss.splitW, func() {
			ui.Column(c).Fill().MinHeight(0).Padding(0, 14, 0, 0).Gap(10).Children(func() { a.sessionList(c) })
		}, func() {
			ui.Column(c).Fill().MinHeight(0).MinWidth(0).Padding(0, 0, 0, 14).Gap(12).Children(func() { a.sessionDetail(c) })
		}).Grow(1).MinHeight(0)
	})
}

// ---- 左：会话列表 ----

func (a *App) sessionList(c *ui.Context) {
	p := a.pl
	filt := SessionFilter{Query: a.ss.query, SortDanger: true}
	if a.ss.scope == 0 {
		filt.State = "!ended"
	}
	groups := GroupSessions(a.sessions, filt)
	rows := FlattenGroups(groups, a.ss.collapsed)
	ended := 0
	for _, s := range a.sessions {
		if s.State == "ended" {
			ended++
		}
	}
	ui.Row(c).FillWidth().Gap(8).AlignItems(ui.Center).Children(func() {
		ui.SearchField(c, &a.ss.query).Grow(1).Label("搜索会话")
		ui.Segmented(c, &a.ss.scope, "进行中", "全部")
	})
	if msg := a.errOf("sessions"); msg != "" {
		a.errLine(c, msg)
	}
	if len(rows) == 0 {
		a.emptyState(c, "terminal", "没有会话", map[bool]string{true: fmt.Sprintf("另有 %d 个已结束，切到「全部」查看", ended), false: "agent 开始工作后会出现在这里"}[ended > 0 && a.ss.scope == 0])
		return
	}
	a.ss.left.Key = func(i int) any {
		if rows[i].Header != nil {
			return "g:" + rows[i].Header.Project
		}
		return rows[i].Session.SessionID
	}
	ui.List(c, &a.ss.left, len(rows), func(i int) {
		r := rows[i]
		if r.Header != nil {
			a.groupHeader(c, r.Header)
			return
		}
		a.sessionCard(c, *r.Session)
	}).Grow(1).MinHeight(0)
	if ended > 0 && a.ss.scope == 0 {
		a.txt(c, fmt.Sprintf("已隐藏 %d 个已结束的会话", ended), 11, p.Muted)
	}
}

func (a *App) groupHeader(c *ui.Context, g *Group) {
	p := a.pl
	open := !a.ss.collapsed[g.Project]
	row := ui.Row(c).FillWidth().Gap(6).Padding(12, 4, 6, 4).AlignItems(ui.Center).Cursor(ui.CursorPointer)
	row.Children(func() {
		ic := "chevron-down"
		if !open {
			ic = "chevron-right"
		}
		icon(c, ic, 14, p.Muted)
		icon(c, "folder", 14, p.Muted)
		ui.Text(c, ShortPath(g.Project)).FontSize(12).FontWeight(650).TextColor(p.Muted).SingleLine().Grow(1)
		if g.Danger.Total > 0 {
			a.miniTriad(c, g.Danger.Total, g.Danger.WouldHaveBlocked, g.Danger.Enforced)
		}
		a.txt(c, fmt.Sprint(len(g.Sessions)), 11, p.Muted).FontFeatures("tnum")
	})
	if row.Clicked() {
		a.ss.collapsed[g.Project] = open
	}
}

func (a *App) sessionCard(c *ui.Context, s api.SessionSummary) {
	p := a.pl
	sel := a.ss.sel == s.SessionID
	card := ui.Column(c).Key(s.SessionID).FillWidth().Margin(0, 0, 6, 0).Gap(6).Padding(11, 12).Radius(12).Background(p.Card).Border(1, p.Line)
	if sel {
		card = card.Background(p.AccentSoft).Border(1.5, p.Accent)
	} else if card.Hovered() {
		card = card.Background(p.Card2)
	}
	card.Cursor(ui.CursorPointer).Transition(ui.ElementTransition{Colors: true, Duration: 120e6}).Children(func() {
		ui.Row(c).FillWidth().Gap(8).AlignItems(ui.Center).Children(func() {
			ui.Box(c).Size(9, 9).Children(func() { a.stateDot(c, s.State) })
			ui.Text(c, sid(s.SessionID)).Font("monospace").FontSize(13).FontWeight(600).SingleLine()
			a.pill(c, Or(Str(s.Harness), "?"), p.Muted, p.Shade)
			ui.Spacer(c)
			a.txt(c, a.rel(I64(s.LastTs)), 11, p.Muted)
		})
		a.txt(c, Or(Str(s.Model), "模型未知")+" · "+fmt.Sprintf("%d 次调用", I64(s.Calls)), 12, p.Muted).SingleLine()
		if s.Danger.Total > 0 || s.HitsL+s.HitsM+s.HitsH > 0 {
			ui.Row(c).FillWidth().Gap(10).AlignItems(ui.Center).Children(func() {
				a.hitBars(c, s)
				ui.Spacer(c)
				if s.Danger.Total > 0 {
					a.triadCounts(c, s.Danger.Total, s.Danger.WouldHaveBlocked, s.Danger.Enforced)
				}
			})
		}
	}).Label(s.SessionID)
	if card.Clicked() {
		a.selectSession(s.SessionID)
	}
}

// ---- 右：会话详情 ----

func (a *App) sessionDetail(c *ui.Context) {
	p := a.pl
	s := a.sessionByID(a.ss.sel)
	if s == nil {
		a.card(c).Grow(1).Children(func() {
			a.emptyState(c, "terminal", "选一个会话", "左边选择会话，这里显示它的时间线")
		})
		return
	}
	st := StatsOfTimeline(a.ss.entries)
	a.card(c).FillWidth().Gap(10).Children(func() {
		ui.Row(c).FillWidth().Gap(10).AlignItems(ui.Center).Children(func() {
			ui.Box(c).Size(9, 9).Children(func() { a.stateDot(c, s.State) })
			ui.Text(c, s.SessionID).Font("monospace").FontSize(15).FontWeight(650).Selectable()
			a.pill(c, Or(Str(s.Harness), "?"), p.Muted, p.Shade)
			a.pill(c, map[string]string{"active": "进行中", "idle": "闲置", "ended": "已结束"}[s.State], p.Muted, p.Shade)
			ui.Spacer(c)
			a.triadCounts(c, int64(max(st.Danger, int(s.Danger.Total))), int64(max(st.Would, int(s.Danger.WouldHaveBlocked))), int64(max(st.Enforced, int(s.Danger.Enforced))))
		})
		ui.Row(c).FillWidth().Gap(14).Children(func() {
			a.txt(c, ShortPath(Str(s.Project)), 12, p.Muted)
			a.txt(c, Or(Str(s.Model), "模型未知"), 12, p.Muted)
			a.txt(c, fmt.Sprintf("%d 次调用 · 命中 ▲H%d ●M%d ·L%d · judge %d 次", I64(s.Calls), s.HitsH, s.HitsM, s.HitsL, s.JudgeCalls), 12, p.Muted)
		})
		a.heartbeat(c)
	})
	ui.Row(c).FillWidth().Gap(10).AlignItems(ui.Center).Children(func() {
		ui.Segmented(c, &a.ss.filter, "全部", "仅命中", "仅危险")
		if a.ss.hasMore {
			a.muted(c, "仅显示最近的记录")
		}
		ui.Spacer(c)
		a.txt(c, "◌ 空心虚线 = 会拦（未生效）", 11, p.Would).Italic()
		a.txt(c, "■ 实心 = 已拦截", 11, p.Text).FontWeight(700)
		a.txt(c, "▲ 危险", 11, p.Danger).FontWeight(650)
	})
	if msg := a.errOf("timeline"); msg != "" {
		a.errLine(c, msg)
	}
	ui.Row(c).Grow(1).MinHeight(0).Gap(12).AlignItems(ui.Stretch).Children(func() {
		a.timelineList(c)
		if a.ss.hitSel != 0 && a.ex.id == a.ss.hitSel {
			a.card(c).Width(330).MinHeight(0).Gap(8).Transition(ui.ElementTransition{Enter: &ui.Motion{X: 24}, Duration: 200e6}).Children(func() {
				ui.Scroll(c).Grow(1).MinHeight(0).Children(func() {
					ui.Column(c).FillWidth().Gap(8).Children(func() { a.inspector(c, func() { a.ss.hitSel = 0 }) })
				})
			})
		}
	})
}

func (a *App) timelineList(c *ui.Context) {
	f := TimelineFilter{OnlyHits: a.ss.filter == 1, OnlyDanger: a.ss.filter == 2}
	rows := BuildRows(a.ss.entries, f)
	a.ss.rows = rows
	if len(rows) == 0 {
		a.card(c).Grow(1).Children(func() {
			a.emptyState(c, "activity", "没有记录", map[bool]string{true: "这个筛选下没有命中", false: "会话还没有产生调用"}[a.ss.filter != 0])
		})
		return
	}
	a.ss.tl.Key = func(i int) any {
		e := rows[i]
		switch {
		case e.Hit:
			return fmt.Sprintf("h%d", e.Entry.Hit.HitID)
		case e.Entry.Call != nil:
			return fmt.Sprintf("c%d", e.Entry.Call.Seq)
		}
		return fmt.Sprintf("e%d", e.Entry.Seq())
	}
	ui.List(c, &a.ss.tl, len(rows), func(i int) { a.timelineRow(c, rows[i]) }).Grow(1).MinWidth(0).MinHeight(0)
}

var phaseText = map[string]string{"prompt": "用户提示", "stop": "本轮结束", "compact": "上下文压缩", "start": "会话开始", "end": "会话结束"}

func (a *App) timelineRow(c *ui.Context, r TLRow) {
	p := a.pl
	e := r.Entry
	k := StNone
	dangerous := false
	if r.Hit {
		k = stateOf(Str(e.Hit.Outcome))
		dangerous = e.Hit.Dangerous
	}
	isCall := e.Call != nil
	ui.Row(c).FillWidth().AlignItems(ui.Stretch).Children(func() {
		ui.Box(c).Width(70).Padding(11, 8, 0, 0).Children(func() {
			if !r.Hit {
				a.txt(c, hhmmss(e.Ts()), 11, p.Muted).Font("monospace").NoWrap()
			}
		})
		// 轨道：竖线 + 节点（节点形状编码三态）
		ui.Box(c).Width(26).Draw(func(pt *ui.Painter, rc ui.Rect) {
			cx := rc.X + rc.W/2
			pt.Line(cx, rc.Y, cx, rc.Y+rc.H, 1.5, p.Line)
			y := rc.Y + 16
			switch {
			case r.Hit && k == StEnforced:
				pt.Fill(ui.Rect{X: cx - 6, Y: y - 6, W: 12, H: 12}, p.Ink, 2)
			case r.Hit && k == StWould:
				pt.Fill(ui.Rect{X: cx - 6, Y: y - 6, W: 12, H: 12}, p.Card, 6)
				pt.StrokeDashed(ui.Rect{X: cx - 6, Y: y - 6, W: 12, H: 12}, p.Would, 6, 1.5)
			case r.Hit && dangerous:
				pt.Icon(iconSVG("triangle-alert"), ui.Rect{X: cx - 7, Y: y - 7, W: 14, H: 14}, p.Danger)
			case r.Hit:
				col := p.Muted
				if e.Hit.Sev == "H" {
					col = p.Danger
				} else if e.Hit.Sev == "M" {
					col = p.Warn
				}
				pt.Stroke(ui.Rect{X: cx - 4, Y: y - 4, W: 8, H: 8}, col, 4, 2)
			case isCall:
				pt.Fill(ui.Rect{X: cx - 3.5, Y: y - 3.5, W: 7, H: 7}, p.Muted.Alpha(0.7), 3.5)
			default:
				pt.Fill(ui.Rect{X: cx - 2, Y: y - 2, W: 4, H: 4}, p.Line, 1)
			}
		})
		ui.Column(c).Grow(1).MinWidth(0).Padding(4, 0, 4, 6).Children(func() {
			switch {
			case r.Hit:
				a.hitCard(c, e.Hit)
			case isCall:
				a.callLine(c, e.Call)
			default:
				ph := e.Event.Phase
				ui.Row(c).Gap(8).Padding(8, 0).AlignItems(ui.Center).Children(func() {
					a.txt(c, Or(phaseText[ph], ph), 11, p.Muted).FontWeight(600)
					if o := Str(e.Event.Origin); o != "" {
						a.txt(c, o, 11, p.Muted)
					}
				})
			}
		})
	})
}

func hhmmss(ms int64) string {
	return strings.Split(FmtTime(ms), " ")[len(strings.Split(FmtTime(ms), " "))-1]
}

func (a *App) callLine(c *ui.Context, cl *api.TimelineCall) {
	p := a.pl
	ui.Row(c).FillWidth().Gap(8).Padding(8, 0).AlignItems(ui.Center).Children(func() {
		a.pill(c, Or(Str(cl.Tool), "?"), p.Text, p.Shade)
		ui.Text(c, Or(Str(cl.NormCmd), "–")).Font("monospace").FontSize(12).SingleLine().Grow(1).MinWidth(0)
		switch cl.Status {
		case "pending":
			a.pill(c, "运行中", p.Accent, p.AccentSoft)
		case "fail":
			a.pill(c, fmt.Sprintf("失败 exit %d", I64(cl.ExitCode)), p.Danger, p.DangerSoft)
		}
		if cl.Mutating != nil && *cl.Mutating {
			a.txt(c, "写", 11, p.Muted).Tooltip("会修改工作区")
		}
	})
}

func (a *App) hitCard(c *ui.Context, h *api.TimelineHit) {
	p := a.pl
	k := stateOf(Str(h.Outcome))
	sel := a.ss.hitSel == h.HitID
	card := ui.Column(c).Key(h.HitID).FillWidth().Gap(5).Padding(10, 12).Radius(10)
	switch {
	case h.Dangerous:
		card = card.Background(p.DangerSoft)
	default:
		card = card.Background(p.Card)
	}
	switch {
	case sel:
		card = card.Border(2, p.Accent)
	case k == StEnforced:
		card = card.Border(2, p.Ink)
	case k == StWould:
		card = card.Border(1.5, p.Would).BorderStyle(ui.BorderDashed)
	default:
		card = card.Border(1, p.Line)
	}
	card.Cursor(ui.CursorPointer).Children(func() {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			a.sevMark(c, h.Sev)
			ui.Text(c, h.RuleID).Font("monospace").FontSize(13).FontWeight(700)
			if h.Dangerous {
				a.dangerChip(c, Str(h.DangerCategory))
			}
			mode := ""
			if len(h.Decisions) > 0 {
				mode = Str(h.Decisions[0].Mode)
			}
			a.outcomeChip(c, Str(h.Outcome), mode)
			ui.Spacer(c)
			a.txt(c, "#"+fmt.Sprint(h.HitID), 11, p.Muted).Font("monospace")
		})
		if h.Dangerous && Str(h.DangerSubject) != "" {
			ui.Text(c, Str(h.DangerSubject)).Font("monospace").FontSize(12).FontWeight(600)
		}
		if m := Str(h.Message); m != "" {
			a.txt(c, m, 12, p.Muted)
		}
	})
	if card.Clicked() {
		a.ss.hitSel = h.HitID
		a.loadExplain(h.HitID)
	}
}

// heartbeat 是会话的「心跳条」：一格一次调用；命中逐条叠在格子上方，形状随三态，点击跳到该调用。
func (a *App) heartbeat(c *ui.Context) {
	p := a.pl
	type cell struct {
		seq  int64
		hits []*api.TimelineHit
	}
	var cells []cell
	idx := map[int64]int{}
	for _, e := range a.ss.entries {
		switch {
		case e.Call != nil:
			idx[e.Call.Seq] = len(cells)
			cells = append(cells, cell{seq: e.Call.Seq})
		case e.Hit != nil:
			if i, ok := idx[e.Hit.Seq]; ok {
				cells[i].hits = append(cells[i].hits, e.Hit)
			}
		}
	}
	if len(cells) == 0 {
		return
	}
	strip := ui.Box(c).FillWidth().Height(54).Cursor(ui.CursorPointer).Label("会话心跳条").Draw(func(pt *ui.Painter, r ui.Rect) {
		n := float32(len(cells))
		step := r.W / n
		if step > 44 {
			step = 44
		}
		w := step * 0.6
		if w < 2 {
			w = 2
		}
		base := r.Y + r.H - 4
		for i, ce := range cells {
			x := r.X + float32(i)*step
			pt.Fill(ui.Rect{X: x, Y: base - 8, W: w, H: 8}, p.Line, 1)
			for j, h := range ce.hits {
				if j > 2 {
					break
				}
				y := base - 12 - float32(j+1)*11
				m := ui.Rect{X: x + w/2 - 5, Y: y, W: 10, H: 10}
				switch k := stateOf(Str(h.Outcome)); {
				case k == StEnforced:
					pt.Fill(m, p.Ink, 2)
				case k == StWould:
					pt.StrokeDashed(m, p.Would, 5, 1.5)
				case h.Dangerous:
					pt.Icon(iconSVG("triangle-alert"), ui.Rect{X: m.X - 1, Y: m.Y - 1, W: 12, H: 12}, p.Danger)
				default:
					col := p.Muted
					if h.Sev == "H" {
						col = p.Danger
					} else if h.Sev == "M" {
						col = p.Warn
					}
					pt.Fill(ui.Rect{X: m.X + 2, Y: m.Y + 2, W: 6, H: 6}, col, 3)
				}
			}
		}
	})
	if strip.Clicked() {
		if x, _, over := strip.PointerPosition(); over {
			step := strip.Bounds().W / float32(len(cells))
			if step > 44 {
				step = 44
			}
			i := int(x / step)
			if i >= len(cells) {
				i = len(cells) - 1
			}
			for ri, r := range a.ss.rows {
				if r.Entry.Seq() >= cells[i].seq && !r.Hit {
					a.ss.tl.ScrollTo(ri, ui.Center)
					break
				}
			}
		}
	}
}
