package app

import (
	"fmt"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"
)

type navMatch struct{}

var pageSubtitle = map[string]string{
	PageOverview: "一眼看清：现在是观察还是拦截，今天有没有真的拦住什么",
	PageSessions: "每一次调用与每一次命中，按时间排开",
	PageDanger:   "所有危险操作，逐条记录",
	PageRules:    "命中统计与阈值；这里是界面唯一可以修改的地方",
	PageJudge:    "强模型裁决记录与路由健康",
	PageReplay:   "回放与评测运行，对比阈值改动的影响",
}

// View 是窗口内容的 view 函数。
func (a *App) View(c *ui.Context) {
	dark := c.Theme().Dark
	if dark {
		a.pl = darkPal()
	} else {
		a.pl = lightPal()
	}
	c.SetTheme(theme(dark, a.pl))
	w, _ := c.Size()
	a.narrow = w < 1200 // 窄窗口：页头收起次要标签
	for i, d := range pageDefs {
		d := d
		c.OnShortcut(ui.Cmd, ui.Key(int(ui.Key1)+i), func() { a.Goto(d.id) })
	}
	c.OnShortcut(ui.Cmd, ui.KeyR, a.refresh)
	if a.toast != "" {
		c.Toast(a.toast)
		a.toast = ""
	}

	m := a.connSnapshot()
	stale := m.Stale()
	ui.Row(c).Fill().AlignItems(ui.Stretch).Background(a.pl.Bg).Children(func() {
		a.rail(c)
		ui.Column(c).Grow(1).MinWidth(0).MinHeight(0).Children(func() {
			a.header(c)
			if stale {
				a.banner(c, a.pl.Danger, a.pl.DangerSoft, fmt.Sprintf("守护进程离线：页面只读，保留旧数据（最后成功 %s）。界面不会启动它，请在终端运行 sv start。", FmtClock(m.LastOK)))
			} else if m.LastErr != "" && m.State != Live && m.State != Connecting {
				a.banner(c, a.pl.Warn, a.pl.WarnSoft, "实时推送已断开："+m.LastErr+map[bool]string{true: "；数据每 5 秒轮询刷新", false: ""}[m.State == Degraded])
			}
			ui.Column(c).Grow(1).MinHeight(0).Opacity(map[bool]float32{true: 0.5, false: 1}[stale]).Children(func() {
				ui.Column(c).Key(a.page).Grow(1).MinHeight(0).
					Transition(ui.ElementTransition{Enter: &ui.Motion{Y: 10}, Duration: 220 * time.Millisecond}).
					Children(func() { a.pageBody(c) })
			})
			a.footer(c)
		})
	})
}

func (a *App) pageBody(c *ui.Context) {
	switch a.page {
	case PageOverview:
		a.overviewView(c)
	case PageSessions:
		a.sessionsView(c)
	case PageDanger:
		a.dangerView(c)
	case PageRules:
		a.rulesView(c)
	case PageJudge:
		a.judgeView(c)
	case PageReplay:
		a.replayView(c)
	}
}

func (a *App) banner(c *ui.Context, fg, bg ui.Color, text string) {
	ui.Row(c).FillWidth().Padding(8, 24).Background(bg).Children(func() {
		ui.Text(c, text).TextColor(fg).FontSize(12)
	})
}

// ---- 导航轨 ----

func (a *App) rail(c *ui.Context) {
	p := a.pl
	bar := c.TitleBar()
	ui.Column(c).Width(80).Padding(float32(max(bar.Height, 0))+14, 0, 14, 0).AlignItems(ui.Center).Gap(6).
		Background(p.Card2).BorderWidth(0, 1, 0, 0).BorderColor(p.Line).Children(func() {
		ui.Box(c).Absolute().Top(0).Left(0).Right(0).Height(max(bar.Height, 0) + 8).DragWindow()
		// 徽标：三态合一的小盾
		ui.Box(c).Size(32, 32).Radius(8).Center().Border(1, p.Line).
			Children(func() { icon(c, "shield-check", 16, p.Text) }).Label("agent-supervisor")
		ui.Box(c).Height(14)
		for _, d := range pageDefs {
			a.navItem(c, d)
		}
		ui.Spacer(c)
		a.connDot(c)
	})
}

func (a *App) navItem(c *ui.Context, d pageDef) {
	p := a.pl
	sel := a.page == d.id
	it := ui.Column(c).Key(d.id).Width(64).Padding(9, 0, 7, 0).AlignItems(ui.Center).Gap(4).Radius(8).Cursor(ui.CursorPointer)
	if !sel && it.Hovered() {
		it = it.Background(p.Shade)
	}
	it.Transition(ui.ElementTransition{Colors: true, Duration: 120 * time.Millisecond}).Children(func() {
		if sel {
			ui.Box(c).Absolute().Top(0).Left(0).Right(0).Bottom(0).PassThrough().Radius(8).Background(p.Shade).
				Transition(ui.ElementTransition{Animation: &ui.Snappy, Match: navMatch{}})
		}
		fg := p.Muted
		if sel {
			fg = p.Text
		}
		ui.Box(c).Children(func() {
			icon(c, d.icon, 17, fg)
			if d.id == PageDanger && a.hasToday && a.today.Total > 0 {
				ui.Row(c).Absolute().Top(-6).Right(-10).Padding(0, 5).Radius(8).Background(p.Danger).Children(func() {
					ui.Text(c, fmt.Sprint(a.today.Total)).FontSize(10).FontWeight(700).TextColor(ui.Hex("#FFFFFF"))
				})
			}
		})
		w := 500
		if sel {
			w = 650
		}
		ui.Text(c, d.title).FontSize(11).FontWeight(w).TextColor(fg)
	}).Label(d.title)
	if it.Clicked() {
		a.Goto(d.id)
	}
}

// connDot 是左下角的连接状态灯：形状 + 文字（悬停）+ 颜色。
func (a *App) connDot(c *ui.Context) {
	p := a.pl
	m := a.connSnapshot()
	col := p.Muted
	switch m.State {
	case Live:
		col = p.Ok
	case Reconnecting, Degraded:
		col = p.Warn
	case Offline:
		col = p.Danger
	}
	ui.Column(c).AlignItems(ui.Center).Gap(4).Children(func() {
		a.dot(c, col, 10)
		a.txt(c, strings.TrimLeft(m.State.Label(), "●◐↻◑✕ "), 10, p.Muted).SingleLine()
	}).Tooltip(m.State.Label())
}

// ---- 页头 ----

func (a *App) header(c *ui.Context) {
	p := a.pl
	d := pageDef{}
	for _, x := range pageDefs {
		if x.id == a.page {
			d = x
		}
	}
	bar := c.TitleBar()
	ui.Row(c).FillWidth().Padding(14, 24+bar.Right, 14, 24).Margin(0, 0, 18, 0).Gap(16).AlignItems(ui.Center).DragWindow().
		BorderWidth(0, 0, 1, 0).BorderColor(p.Line).Children(func() {
		ui.Column(c).Gap(2).Grow(1).MinWidth(0).Children(func() {
			ui.Text(c, d.title).FontSize(17).FontWeight(600)
			if !a.narrow {
				a.txt(c, pageSubtitle[a.page], 12, p.Muted).SingleLine()
			}
		})
		a.statusCluster(c)
	})
}

func (a *App) statusCluster(c *ui.Context) {
	p := a.pl
	ui.Row(c).Gap(10).AlignItems(ui.Center).Children(func() {
		if a.hasToday {
			ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
				if !a.narrow {
					a.muted(c, "今日")
				}
				a.triadCounts(c, a.today.Total, a.today.WouldHaveBlocked, a.today.Enforced)
			})
		}
		if a.status == nil {
			return
		}
		st := a.status
		switch st.Mode {
		case "enforce":
			ui.Row(c).Gap(5).Padding(3, 10, 3, 8).Radius(999).Background(p.Ink).AlignItems(ui.Center).Children(func() {
				icon(c, "shield-check", 14, p.InkText)
				ui.Text(c, "拦截已开启").FontSize(12).FontWeight(700).TextColor(p.InkText)
			})
		case "advise":
			a.pill(c, "仅建议 · 不拦截", p.Warn, p.WarnSoft)
		default:
			ui.Row(c).Gap(5).Padding(2, 10, 2, 8).Radius(999).Border(1, p.Line).AlignItems(ui.Center).Children(func() {
				icon(c, "eye", 14, p.Muted)
				ui.Text(c, "观察模式 · 不会拦截").FontSize(12).TextColor(p.Muted)
			})
		}
		switch {
		case !st.Judge.Enabled:
			a.pill(c, "judge 关", p.Muted, p.Shade)
		case st.Judge.Health == "degraded":
			a.pill(c, "▲ judge 降级", p.Warn, p.WarnSoft)
		case st.Judge.Health == "unavailable":
			a.pill(c, "✕ judge 不可用", p.Danger, p.DangerSoft)
		default:
			a.pill(c, "judge 正常", p.Ok, p.OkSoft)
		}
		for h, n := range st.AdapterFailures15m {
			if n > 0 {
				txt := fmt.Sprintf("⚠ %s 适配器失败 %d", h, n)
				if a.narrow {
					txt = fmt.Sprintf("⚠ %s %d", h, n)
				}
				a.pill(c, txt, p.Warn, p.WarnSoft)
			}
		}
		if a.Demo && !a.narrow {
			a.pill(c, "DEMO · 合成数据", p.Muted, p.Shade)
		}
		if a.permWarn != "" {
			a.pill(c, "⚠ "+a.permWarn, p.Warn, p.WarnSoft)
		}
	})
}

func (a *App) footer(c *ui.Context) {
	p := a.pl
	ui.Row(c).FillWidth().Padding(6, 24).Gap(12).AlignItems(ui.Center).BorderWidth(1, 0, 0, 0).BorderColor(p.Line).Children(func() {
		if n := len(a.errLog); n > 0 {
			el := a.txt(c, fmt.Sprintf("最近错误 %d 条 · %s（点击复制）", n, a.errLog[n-1]), 11, p.Warn).SingleLine().Grow(1).Cursor(ui.CursorPointer)
			if el.Clicked() {
				c.WriteClipboard(strings.Join(a.errLog, "\n"))
				c.Toast("已复制最近错误")
			}
		} else {
			a.txt(c, "无错误", 11, p.Muted).Grow(1)
		}
		if a.status != nil {
			a.txt(c, fmt.Sprintf("日志库 %s · v%s · 协议 %d", FmtBytes(a.status.DbBytes), a.status.Version, a.status.Protocol), 11, p.Muted).Tooltip(a.status.Db)
		}
		a.txt(c, "最后更新 "+FmtClock(a.lastData), 11, p.Muted)
		a.txt(c, "只读 · 仅规则开关与阈值可改", 11, p.Muted)
	})
}
