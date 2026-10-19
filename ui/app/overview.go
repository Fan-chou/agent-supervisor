package app

import (
	"fmt"
	"sort"
	"strings"

	"github.com/Fan-chou/agent-supervisor/ui/api"
	"github.com/egoist/mygo/ui"
	"github.com/egoist/mygo/ui/chart"
)

func (a *App) overviewView(c *ui.Context) {
	p := a.pl
	ui.Scroll(c).Grow(1).MinHeight(0).Children(func() {
		ui.Column(c).FillWidth().Padding(0, 24, 24, 24).Gap(16).Children(func() {
			a.modeBanner(c)
			ui.Row(c).FillWidth().Gap(14).Children(func() {
				d := a.today
				a.bigTile(c, StDanger, d.Total, "危险操作", "今天检测到的危险操作次数", func() { a.dg.filter = 0; a.Goto(PageDanger) })
				a.bigTile(c, StWould, d.WouldHaveBlocked, "本应拦截 · 未生效", "观察模式下「会拦」，没有真的拦", func() { a.dg.filter = 1; a.Goto(PageDanger) })
				a.bigTile(c, StEnforced, d.Enforced, "已拦截", "拦截开启后真正拦下/要求确认", func() { a.dg.filter = 2; a.Goto(PageDanger) })
			})
			ui.Row(c).FillWidth().Gap(14).AlignItems(ui.Stretch).Children(func() {
				a.card(c).Grow(3).Basis(0).MinWidth(0).Gap(10).Children(func() { a.overviewSessions(c) })
				a.card(c).Grow(2).Basis(0).MinWidth(0).Gap(10).Children(func() { a.overviewRecent(c) })
			})
			ui.Row(c).FillWidth().Gap(14).AlignItems(ui.Stretch).Children(func() {
				a.card(c).Grow(3).Basis(0).MinWidth(0).Gap(10).Children(func() { a.overviewRules(c) })
				a.card(c).Grow(2).Basis(0).MinWidth(0).Gap(10).Children(func() { a.overviewCategories(c) })
				a.card(c).Grow(2).Basis(0).MinWidth(0).Gap(10).Children(func() { a.overviewHealth(c) })
			})
			_ = p
		})
	})
}

func (a *App) modeBanner(c *ui.Context) {
	p := a.pl
	mode := "shadow"
	if a.status != nil {
		mode = a.status.Mode
	}
	d := a.today
	var title, sub, ic string
	switch mode {
	case "enforce":
		title, ic = "拦截已开启", "shield-check"
		sub = fmt.Sprintf("今天 %d 次危险操作：%d 次已被真正拦截（或要求确认）；另有 %d 次本应拦截但未生效。", d.Total, d.Enforced, d.WouldHaveBlocked)
	case "advise":
		title, ic = "仅建议模式 · 不会拦截", "eye"
		sub = fmt.Sprintf("今天 %d 次危险操作，监督只给 agent 提建议；%d 次本应拦截，实际都没有拦。", d.Total, d.WouldHaveBlocked)
	default:
		title, ic = "观察模式 · 监督只记录，不会拦截任何操作", "eye"
		sub = fmt.Sprintf("今天标记了 %d 次危险操作；如果开启拦截，其中 %d 次会被拦下。目前真正被拦截：%d 次。", d.Total, d.WouldHaveBlocked, d.Enforced)
	}
	ui.Row(c).FillWidth().Padding(2, 0).Gap(12).AlignItems(ui.Start).Children(func() {
		icon(c, ic, 16, p.Muted).Margin(2, 0, 0, 0)
		ui.Column(c).Gap(3).Grow(1).MinWidth(0).Children(func() {
			ui.Text(c, title).FontSize(15).FontWeight(600)
			a.txt(c, sub, 13, p.Muted)
		})
	})
}

func (a *App) overviewSessions(c *ui.Context) {
	ui.Row(c).FillWidth().AlignItems(ui.Center).Children(func() {
		a.label(c, "进行中的会话")
		ui.Spacer(c)
		if n := len(a.sessions); n > 0 {
			a.muted(c, fmt.Sprintf("共 %d 个 · 点击查看时间线", n))
		}
	})
	var live []api.SessionSummary
	for _, s := range a.sessions {
		if s.State != "ended" {
			live = append(live, s)
		}
	}
	if len(live) == 0 {
		a.emptyState(c, "terminal", "没有进行中的会话", "agent 开始工作后会出现在这里")
		return
	}
	if len(live) > 5 {
		live = live[:5]
	}
	for _, s := range live {
		a.sessionCompact(c, s)
	}
}

func (a *App) stateDot(c *ui.Context, state string) {
	p := a.pl
	switch state {
	case "active":
		// 进行中：实心点外加静态细环（不做常驻动画，空闲 CPU≈0）
		ui.Box(c).Size(9, 9).Radius(4.5).Border(1.5, p.Ok).Padding(1.5).Children(func() {
			a.dot(c, p.Ok, 3)
		})
	case "idle":
		ui.Box(c).Size(9, 9).Radius(4.5).Border(1.5, p.Muted)
	default:
		a.dot(c, p.Line, 9)
	}
}

func (a *App) sessionCompact(c *ui.Context, s api.SessionSummary) {
	p := a.pl
	row := ui.Row(c).Key(s.SessionID).FillWidth().Gap(12).Padding(10, 12).Radius(6).AlignItems(ui.Center).Border(1, ui.Transparent)
	row = a.hoverable(row, false)
	row.Children(func() {
		ui.Box(c).Size(9, 9).Children(func() { a.stateDot(c, s.State) })
		ui.Column(c).Gap(2).Grow(1).MinWidth(0).Children(func() {
			ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
				ui.Text(c, sid(s.SessionID)).Font("monospace").FontSize(13).FontWeight(600)
				a.pill(c, Or(Str(s.Harness), "?"), p.Muted, p.Shade)
			})
			a.txt(c, ShortPath(Str(s.Project))+" · "+Or(Str(s.Model), "模型未知"), 12, p.Muted).SingleLine()
		})
		if !a.narrow {
			a.hitBars(c, s)
		}
		ui.Column(c).Gap(3).AlignItems(ui.End).Children(func() {
			if s.Danger.Total > 0 {
				a.triadCounts(c, s.Danger.Total, s.Danger.WouldHaveBlocked, s.Danger.Enforced)
			}
			a.txt(c, fmt.Sprintf("%d 次调用 · %s", I64(s.Calls), a.rel(I64(s.LastTs))), 11, p.Muted)
		})
	})
	if row.Clicked() {
		a.selectSession(s.SessionID)
		a.Goto(PageSessions)
	}
}

// hitBars 是 L/M/H 命中数的三个小柱（图形+数字，不只靠颜色）。
func (a *App) hitBars(c *ui.Context, s api.SessionSummary) {
	p := a.pl
	if s.HitsL+s.HitsM+s.HitsH == 0 {
		return
	}
	ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
		for _, x := range []struct {
			sev string
			n   int64
			col ui.Color
		}{{"H", s.HitsH, p.Text}, {"M", s.HitsM, p.Text}, {"L", s.HitsL, p.Muted}} {
			if x.n == 0 {
				continue
			}
			ui.Row(c).Gap(3).AlignItems(ui.Center).Children(func() {
				a.txt(c, SevMark(x.sev), 11, x.col).FontWeight(700)
				a.txt(c, fmt.Sprint(x.n), 12, p.Text).FontFeatures("tnum")
			})
		}
	})
}

func (a *App) overviewRecent(c *ui.Context) {
	p := a.pl
	ui.Row(c).FillWidth().AlignItems(ui.Center).Children(func() {
		a.label(c, "最近危险事件")
		ui.Spacer(c)
		if a.ruleHasMore() {
			a.muted(c, "逐条记录，不合并")
		}
	})
	evs := a.dg.events
	if len(evs) == 0 {
		a.emptyState(c, "shield-check", "还没有危险操作", "危险操作被检测到时会逐条出现在这里")
		return
	}
	if len(evs) > 6 {
		evs = evs[:6]
	}
	for _, e := range evs {
		e := e
		row := ui.Row(c).Key(e.HitID).FillWidth().Gap(10).Padding(8, 10).Radius(6).AlignItems(ui.Start).Border(1, ui.Transparent)
		row = a.markFresh(row, "danger", fmt.Sprint(e.HitID))
		a.hoverable(row, false).Children(func() {
			ui.Column(c).Gap(3).Grow(1).MinWidth(0).Children(func() {
				ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
					a.dangerChip(c, Str(e.Category))
					a.outcomeChip(c, Str(e.Outcome), Str(e.Mode))
				})
				ui.Text(c, Or(Str(e.Subject), "–")).Font("monospace").FontSize(12).SingleLine()
				a.txt(c, Str(e.Reason)+" · "+sid(e.SessionID)+" · "+a.rel(e.Ts), 11, p.Muted).SingleLine()
			})
		})
		if row.Clicked() {
			a.dg.sel = e.HitID
			a.loadExplain(e.HitID)
			a.Goto(PageDanger)
		}
	}
}

func (a *App) ruleHasMore() bool { return len(a.dg.events) > 6 }

var sevColors = func(p pal) [3]ui.Color {
	return [3]ui.Color{p.Muted.Alpha(0.25), p.Muted.Alpha(0.55), p.Text.Alpha(0.85)}
}

func (a *App) overviewRules(c *ui.Context) {
	p := a.pl
	ui.Row(c).FillWidth().AlignItems(ui.Center).Gap(12).Children(func() {
		a.label(c, "规则命中 · 近 7 天")
		ui.Spacer(c)
		for i, n := range []string{"L", "M", "H"} {
			ui.Row(c).Gap(4).AlignItems(ui.Center).Children(func() {
				a.dot(c, sevColors(p)[i], 8)
				a.txt(c, SevMark(n), 11, p.Muted)
			})
		}
	})
	rs := append([]api.RuleStat(nil), a.ruleStat...)
	if len(rs) == 0 {
		a.emptyState(c, "sliders-horizontal", "暂无命中统计", "规则命中后会在这里出现")
		return
	}
	sort.SliceStable(rs, func(i, j int) bool { return rs[i].Hits > rs[j].Hits })
	labels := make([]string, len(rs))
	series := [][]float64{make([]float64, len(rs)), make([]float64, len(rs)), make([]float64, len(rs))}
	hi := 1.0
	for i, r := range rs {
		labels[i] = r.Rule
		series[0][i], series[1][i], series[2][i] = float64(r.BySev["L"]), float64(r.BySev["M"]), float64(r.BySev["H"])
		if float64(r.Hits) > hi {
			hi = float64(r.Hits)
		}
	}
	st := chart.Stack(series, chart.StackStandard)
	x := chart.NewBand(labels...).Padding(0.45, 0.2)
	y := chart.NewLinear(0, hi).Nice(4)
	ticks := y.Ticks(4)
	chart.Plot(c, chart.Axes{Left: ticks, Bottom: x.Ticks(), Label: func(side chart.Side, t chart.Tick) {
		ui.Text(c, t.Label).NoWrap().FontSize(11).TextColor(p.Muted).FontFeatures("tnum")
	}}, func(area ui.Element) {
		area.Draw(func(pt *ui.Painter, r ui.Rect) {
			for _, t := range ticks {
				pt.Line(r.X, chart.Y(r, t.At), r.X+r.W, chart.Y(r, t.At), 1, p.Line)
			}
		})
		for s := range st {
			for i, seg := range st[s] {
				if seg.Hi-seg.Lo <= 0 {
					continue
				}
				chart.Rect(c, x.Band(i), y.Span(seg.Lo, seg.Hi)).Background(sevColors(p)[s]).Radius(3).
					Tooltip(fmt.Sprintf("%s · %s：%d 次", labels[i], SevMark([]string{"L", "M", "H"}[s]), int(series[s][i])))
			}
		}
	}).Label("各规则命中数（按级别堆叠）").Height(170).Gap(6)
}

func (a *App) overviewCategories(c *ui.Context) {
	p := a.pl
	a.label(c, "危险类别 · 近 7 天")
	cats := make([]string, 0, len(a.week.ByCategory))
	for k := range a.week.ByCategory {
		cats = append(cats, k)
	}
	sort.Slice(cats, func(i, j int) bool {
		if a.week.ByCategory[cats[i]] != a.week.ByCategory[cats[j]] {
			return a.week.ByCategory[cats[i]] > a.week.ByCategory[cats[j]]
		}
		return cats[i] < cats[j]
	})
	if len(cats) == 0 {
		a.emptyState(c, "shield-check", "近 7 天没有危险操作", "")
		return
	}
	hi := a.week.ByCategory[cats[0]] // 灰色横条 + 数字，不用环形图
	if hi < 1 {
		hi = 1
	}
	ui.Column(c).FillWidth().Gap(10).Children(func() {
		for _, k := range cats {
			ui.Row(c).FillWidth().Gap(10).AlignItems(ui.Center).Children(func() {
				ui.Text(c, k).FontSize(13).Width(52)
				a.bar(c, float64(a.week.ByCategory[k])/float64(hi), p.Muted.Alpha(0.55), 6).Grow(1)
				ui.Text(c, fmt.Sprint(a.week.ByCategory[k])).FontSize(13).FontFeatures("tnum").Width(24).TextAlign(ui.End)
			})
		}
	})
}

func (a *App) overviewHealth(c *ui.Context) {
	p := a.pl
	a.label(c, "Judge 与系统")
	st := a.status
	if st == nil {
		a.muted(c, "等待守护进程…")
		return
	}
	j := st.Judge
	ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
		col := p.Ok
		txt := "judge 正常"
		switch {
		case !j.Enabled:
			col, txt = p.Muted, "judge 已关闭"
		case j.Health == "degraded":
			col, txt = p.Warn, "judge 降级"
		case j.Health == "unavailable":
			col, txt = p.Danger, "judge 不可用"
		}
		a.dot(c, col, 9)
		ui.Text(c, txt).FontSize(13).FontWeight(600)
		ui.Spacer(c)
		a.txt(c, Or(j.Model, "–"), 12, p.Muted).Font("monospace")
	})
	if j.Enabled && j.RecentCalls > 0 {
		fr := float64(j.RecentFailures) / float64(j.RecentCalls)
		ui.Meter(c, fr, 0, 1, &ui.MeterLevels{Warning: 0.1, Critical: 0.3}).Label("judge 近期失败率").FillWidth()
		a.muted(c, fmt.Sprintf("最近 %d 次调用中失败 %d 次（%.0f%%）", j.RecentCalls, j.RecentFailures, fr*100))
		if j.LastError != nil {
			a.txt(c, "最近错误："+*j.LastError, 11, p.Warn)
		}
	}
	ui.Box(c).FillWidth().Height(1).Background(p.Line)
	a.kv(c, "日志库", FmtBytes(st.DbBytes))
	a.kv(c, "会话数", fmt.Sprint(st.Sessions))
	if len(st.Outbox) > 0 {
		var parts []string
		for k, v := range st.Outbox {
			parts = append(parts, fmt.Sprintf("%s %d", k, v))
		}
		sort.Strings(parts)
		a.kv(c, "投递队列", strings.Join(parts, " · "))
	}
	a.kv(c, "运行时长", fmtDur(a.now().UnixMilli()-st.StartedAt))
}

func fmtDur(ms int64) string {
	m := ms / 60000
	switch {
	case m < 1:
		return "不足 1 分钟"
	case m < 60:
		return fmt.Sprintf("%d 分钟", m)
	case m < 48*60:
		return fmt.Sprintf("%d 小时 %d 分", m/60, m%60)
	}
	return fmt.Sprintf("%d 天", m/1440)
}
