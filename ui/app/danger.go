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
	cur    int64 // 键盘游标（命中 ID）；sel 是已在右侧面板打开的那条

	// 过滤结果缓存：事件、筛选、搜索词都没变时每帧零开销
	ver           int
	cVer, cFilter int
	cQuery        string
	cOK           bool
	cached        []api.DangerEvent
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
			a.dg.ver++
			keys := make([]string, len(ev))
			for i, e := range ev {
				keys[i] = fmt.Sprint(e.HitID)
			}
			a.noteList("danger", keys)
			if serr == nil {
				a.week = st
			}
		}, nil
	})
}

func (a *App) dangerFiltered() []api.DangerEvent {
	d := &a.dg
	if d.cOK && d.cVer == d.ver && d.cFilter == d.filter && d.cQuery == d.query {
		return d.cached
	}
	d.cached, d.cVer, d.cFilter, d.cQuery, d.cOK = a.computeDangerFiltered(), d.ver, d.filter, d.query, true
	return d.cached
}

func (a *App) computeDangerFiltered() []api.DangerEvent {
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
	a.dangerKeys(c, evs)
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
				a.card(c).FillWidth().Gap(10).Children(func() { a.dangerDistribution(c) })
				_ = p
			})
		})
		if a.dg.sel != 0 && a.ex.id == a.dg.sel {
			a.sidePanel(c, panelRightM, panelBottom, func() { a.inspector(c, func() { a.dg.sel = 0 }) })
		}
	})
}

// dangerKeys：J/K 移动游标（面板已开时右侧跟着切换），Enter 打开游标所在的事件。
func (a *App) dangerKeys(c *ui.Context, evs []api.DangerEvent) {
	d := &a.dg
	idx := -1
	for i, e := range evs {
		if e.HitID == d.cur {
			idx = i
			break
		}
	}
	if dir := a.moveDir(c); dir != 0 {
		if i := stepIndex(idx, dir, len(evs)); i >= 0 {
			d.cur = evs[i].HitID
			d.list.ScrollIntoView(i)
			if d.sel != 0 {
				a.openDanger(d.cur)
			}
		}
	} else if a.enterPressed(c) && idx >= 0 {
		a.openDanger(d.cur)
	}
}

func (a *App) openDanger(id int64) {
	a.dg.cur, a.dg.sel = id, id
	a.loadExplain(id)
}

func (a *App) dangerCard(c *ui.Context, e api.DangerEvent) {
	p := a.pl
	sel := a.dg.sel == e.HitID
	k := stateOf(Str(e.Outcome))
	line := p.Line
	if a.dg.cur == e.HitID {
		line = p.Muted // 键盘游标：边线加深（不依赖颜色，只是更深的灰线）
	}
	card := ui.Row(c).Key(e.HitID).FillWidth().Margin(0, 0, 8, 0).Gap(14).Padding(14, 16).Radius(8).Border(1, line).AlignItems(ui.Start)
	card = a.markFresh(card, "danger", fmt.Sprint(e.HitID))
	if sel {
		card = card.Background(p.Shade)
	} else if card.Hovered() {
		card = card.Background(p.Card2)
	}
	card = card.Cursor(ui.CursorPointer).ContextMenu(func(m *ui.Menu) { a.dangerMenu(c, m, e) })
	card.Children(func() {
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
			ui.Text(c, Or(Str(e.Subject), "–")).Font("monospace").FontSize(13).FontWeight(600)
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
		a.openDanger(e.HitID)
	}
}

// dangerMenu：右键菜单只放只读动作（打开、复制、跳转），没有任何写操作。
func (a *App) dangerMenu(c *ui.Context, m *ui.Menu, e api.DangerEvent) {
	if m.Item("查看详情").Shortcut(0, ui.KeyEnter).Chosen() {
		a.openDanger(e.HitID)
	}
	m.Separator()
	if s := Str(e.Subject); s != "" && m.Item("复制命令 / 对象").Chosen() {
		c.WriteClipboard(s)
	}
	if m.Item("复制会话 ID").Chosen() {
		c.WriteClipboard(e.SessionID)
	}
	if m.Item("复制命中 ID").Chosen() {
		c.WriteClipboard(fmt.Sprint(e.HitID))
	}
	m.Separator()
	if m.Item("跳到该会话").Chosen() {
		a.selectSession(e.SessionID)
		a.Goto(PageSessions)
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
