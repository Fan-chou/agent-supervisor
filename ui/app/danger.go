package app

import (
	"context"
	"fmt"
	"net/url"
	"sort"
	"strings"

	"github.com/Fan-chou/agent-supervisor/ui/api"
	"github.com/egoist/mygo/ui"
)

type dangerPage struct {
	events []api.DangerEvent
	filter int // 0 全部 · 1 会拦（未生效）· 2 已拦截 · 3 仅记录
	query  string
	sel    int64
	list   ui.ListState
	selRow int
}

func (d *dangerPage) init() { d.selRow = -1; d.list.Selected = nil }

func (a *App) loadDanger() {
	a.async("danger", func(ctx context.Context) (func(), error) {
		q := url.Values{"since": {a.sinceDay(7)}, "limit": {"500"}}
		ev, err := a.Client.DangerEvents(ctx, q)
		if err != nil {
			return nil, err
		}
		st, serr := a.Client.DangerStats(ctx, url.Values{"since": {a.sinceDay(7)}})
		return func() {
			a.dg.events = ev
			if serr == nil {
				a.week = st
			}
		}, nil
	})
}

func (a *App) dangerFiltered() []api.DangerEvent {
	q := strings.ToLower(a.dg.query)
	var out []api.DangerEvent
	for _, e := range a.dg.events {
		k := stateOf(Str(e.Outcome))
		switch a.dg.filter {
		case 1:
			if k != StWould {
				continue
			}
		case 2:
			if k != StEnforced {
				continue
			}
		case 3:
			if k != StNone {
				continue
			}
		}
		if q != "" && !strings.Contains(strings.ToLower(Str(e.Subject)+" "+Str(e.Reason)+" "+Str(e.Category)+" "+e.SessionID), q) {
			continue
		}
		out = append(out, e)
	}
	return out
}

func (a *App) dangerView(c *ui.Context) {
	p := a.pl
	evs := a.dangerFiltered()
	ui.Row(c).Fill().Padding(0, 24, 16, 24).Gap(16).AlignItems(ui.Stretch).Children(func() {
		// 左：筛选 + 逐条列表
		ui.Column(c).Grow(1).MinWidth(0).MinHeight(0).Gap(12).Children(func() {
			ui.Row(c).FillWidth().Gap(12).AlignItems(ui.Center).Children(func() {
				seg := ui.Segmented(c, &a.dg.filter, "全部", "◌ 会拦（未生效）", "■ 已拦截", "仅记录")
				if seg.Changed() {
					a.dg.sel = 0
				}
				ui.SearchField(c, &a.dg.query).Width(240).Label("搜索危险事件")
				ui.Spacer(c)
				a.muted(c, fmt.Sprintf("%d / %d 条 · 近 7 天", len(evs), len(a.dg.events)))
			})
			if msg := a.errOf("danger"); msg != "" {
				a.errLine(c, msg)
			}
			if len(evs) == 0 {
				a.card(c).FillWidth().Children(func() {
					a.emptyState(c, "shield-check", "没有符合条件的危险事件", "换一个筛选，或者等 agent 干点危险的事")
				})
				return
			}
			a.dg.list.Key = func(i int) any { return evs[i].HitID }
			ui.List(c, &a.dg.list, len(evs), func(i int) {
				a.dangerCard(c, evs[i])
			}).Grow(1).MinHeight(0)
		})
		// 右：分布 + 检视器
		ui.Scroll(c).Width(340).MinHeight(0).Children(func() {
			ui.Column(c).FillWidth().Gap(12).Children(func() {
				if a.dg.sel != 0 && a.ex.id == a.dg.sel {
					a.card(c).FillWidth().Gap(8).Children(func() {
						a.inspector(c, func() { a.dg.sel = 0 })
					})
				}
				a.card(c).FillWidth().Gap(10).Children(func() { a.dangerDistribution(c) })
				_ = p
			})
		})
	})
}

func (a *App) dangerCard(c *ui.Context, e api.DangerEvent) {
	p := a.pl
	sel := a.dg.sel == e.HitID
	k := stateOf(Str(e.Outcome))
	card := ui.Row(c).Key(e.HitID).FillWidth().Margin(0, 0, 8, 0).Gap(14).Padding(14, 16).Radius(14).Background(p.Card).Border(1, p.Line).AlignItems(ui.Start)
	if sel {
		card = card.Background(p.AccentSoft).Border(1.5, p.Accent)
	} else if card.Hovered() {
		card = card.Background(p.Card2)
	}
	card.Cursor(ui.CursorPointer).Transition(ui.ElementTransition{Colors: true, Duration: 120e6}).Children(func() {
		// 左侧状态柱：形状随三态
		ui.Box(c).Width(4).FillHeight().MinHeight(46).Radius(2).Draw(func(pt *ui.Painter, r ui.Rect) {
			switch k {
			case StEnforced:
				pt.Fill(r, p.Ink, 2)
			case StWould:
				pt.StrokeDashed(ui.Rect{X: r.X, Y: r.Y, W: r.W, H: r.H}, p.Would, 2, 1.5)
			default:
				pt.Fill(r, p.Danger.Alpha(0.55), 2)
			}
		})
		ui.Column(c).Grow(1).MinWidth(0).Gap(5).Children(func() {
			ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
				a.dangerChip(c, Str(e.Category))
				a.outcomeChip(c, Str(e.Outcome), Str(e.Mode))
				ui.Spacer(c)
				a.txt(c, FmtTime(e.Ts)+" · "+a.rel(e.Ts), 11, p.Muted).Tooltip(FmtISO(e.Ts))
			})
			ui.Text(c, Or(Str(e.Subject), "–")).Font("monospace").FontSize(13).FontWeight(600).Selectable()
			if r := Str(e.Reason); r != "" {
				a.txt(c, r, 12, p.Muted)
			}
			ui.Row(c).Gap(10).Children(func() {
				a.txt(c, sid(e.SessionID), 11, p.Muted).Font("monospace")
				if e.CallIndex != nil {
					a.txt(c, fmt.Sprintf("第 %d 次调用", *e.CallIndex), 11, p.Muted)
				}
				if m := Str(e.Model); m != "" {
					a.txt(c, m, 11, p.Muted)
				}
				a.txt(c, "模式 "+Or(Str(e.Mode), "shadow"), 11, p.Muted)
			})
		})
	})
	if card.Clicked() {
		a.dg.sel = e.HitID
		a.loadExplain(e.HitID)
	}
}

func (a *App) dangerDistribution(c *ui.Context) {
	p := a.pl
	a.label(c, "近 7 天分布")
	w := a.week
	ui.Row(c).FillWidth().Gap(6).Children(func() { a.triadCounts(c, w.Total, w.WouldHaveBlocked, w.Enforced) })
	cats := make([]string, 0, len(w.ByCategory))
	hi := int64(1)
	for k, n := range w.ByCategory {
		cats = append(cats, k)
		if n > hi {
			hi = n
		}
	}
	sort.Slice(cats, func(i, j int) bool { return w.ByCategory[cats[i]] > w.ByCategory[cats[j]] })
	if len(cats) > 0 {
		a.muted(c, "按类别")
	}
	for _, k := range cats {
		ui.Row(c).FillWidth().Gap(8).AlignItems(ui.Center).Children(func() {
			ui.Text(c, k).FontSize(12).Width(48)
			a.bar(c, float64(w.ByCategory[k])/float64(hi), p.Danger.Alpha(0.75), 8).Grow(1)
			ui.Text(c, fmt.Sprint(w.ByCategory[k])).FontSize(12).FontFeatures("tnum").Width(22).TextAlign(ui.End)
		})
	}
	if len(w.BySession) > 0 {
		a.muted(c, "按会话")
	}
	for _, s := range w.BySession {
		s := s
		row := ui.Row(c).FillWidth().Gap(8).Padding(6, 8).Radius(8).AlignItems(ui.Center)
		a.hoverable(row, false).Children(func() {
			ui.Text(c, sid(s.SessionID)).Font("monospace").FontSize(12).SingleLine().Grow(1).MinWidth(0)
			a.miniTriad(c, s.Dangerous, s.WouldHaveBlocked, s.Enforced)
		})
		if row.Clicked() {
			a.selectSession(s.SessionID)
			a.Goto(PageSessions)
		}
	}
}
