package app

import (
	"fmt"
	"time"

	"github.com/egoist/mygo/ui"
)

// pal 是语义色板（浅色「暖纸」/ 深色「石墨」）。三态：危险=朱红三角、会拦=赭金虚线空心、已拦截=实心墨块。
type pal struct {
	Dark                       bool
	Bg, Card, Card2, Line      ui.Color
	Text, Muted                ui.Color
	Accent, AccentSoft         ui.Color
	Danger, DangerSoft         ui.Color
	Would, WouldSoft           ui.Color
	Ink, InkText               ui.Color // 已拦截：实心墨块与反白字
	Ok, OkSoft, Warn, WarnSoft ui.Color
	Shade                      ui.Color // 轻微加深/提亮的覆盖层（悬停、条纹）
}

func lightPal() pal {
	return pal{Dark: false,
		Bg: ui.Hex("#F4F2EC"), Card: ui.Hex("#FFFFFF"), Card2: ui.Hex("#F0EDE5"), Line: ui.Hex("#E3DFD3"),
		Text: ui.Hex("#1D1B16"), Muted: ui.Hex("#6F6A5D"),
		Accent: ui.Hex("#4F46E5"), AccentSoft: ui.RGBA(79, 70, 229, 0.10),
		Danger: ui.Hex("#D93A1E"), DangerSoft: ui.RGBA(217, 58, 30, 0.10),
		Would: ui.Hex("#9A6A00"), WouldSoft: ui.RGBA(154, 106, 0, 0.06),
		Ink: ui.Hex("#1D1B16"), InkText: ui.Hex("#F7F5EF"),
		Ok: ui.Hex("#2E8F62"), OkSoft: ui.RGBA(46, 143, 98, 0.12), Warn: ui.Hex("#B4640A"), WarnSoft: ui.RGBA(180, 100, 10, 0.12),
		Shade: ui.RGBA(29, 27, 22, 0.05)}
}

func darkPal() pal {
	return pal{Dark: true,
		Bg: ui.Hex("#0E1013"), Card: ui.Hex("#171A1F"), Card2: ui.Hex("#1E2228"), Line: ui.Hex("#2A2F37"),
		Text: ui.Hex("#E8E6E1"), Muted: ui.Hex("#8E9099"),
		Accent: ui.Hex("#8B93FF"), AccentSoft: ui.RGBA(139, 147, 255, 0.14),
		Danger: ui.Hex("#FF6A4D"), DangerSoft: ui.RGBA(255, 106, 77, 0.14),
		Would: ui.Hex("#E8B84A"), WouldSoft: ui.RGBA(232, 184, 74, 0.07),
		Ink: ui.Hex("#F2EFE8"), InkText: ui.Hex("#0E1013"),
		Ok: ui.Hex("#4CC38A"), OkSoft: ui.RGBA(76, 195, 138, 0.14), Warn: ui.Hex("#E8A04A"), WarnSoft: ui.RGBA(232, 160, 74, 0.14),
		Shade: ui.RGBA(255, 255, 255, 0.05)}
}

var themes = map[bool]*ui.Theme{}

// theme 返回与调色板一致的 MyGo 主题（缓存），让内置控件（输入框、开关、滚动条…）也跟着变。
func theme(dark bool, p pal) *ui.Theme {
	if t, ok := themes[dark]; ok {
		return t
	}
	var t ui.Theme
	if dark {
		t = *ui.DarkTheme()
	} else {
		t = *ui.LightTheme()
	}
	t.Background, t.Surface, t.SurfaceHover, t.SurfacePressed = p.Bg, p.Card, p.Card2, p.Card2
	t.Border, t.Text, t.TextMuted = p.Line, p.Text, p.Muted
	t.Accent, t.AccentText = p.Accent, ui.Hex("#FFFFFF")
	if dark {
		t.AccentText = ui.Hex("#0E1013")
	}
	t.Danger, t.Warning, t.Success = p.Danger, p.Warn, p.Ok
	t.Radius, t.FontSize, t.Spacing = 10, 13, 4
	t.Inverse, t.InverseText = p.Ink, p.InkText
	themes[dark] = &t
	return &t
}

// ---- 基础积木 ----

func (a *App) txt(c *ui.Context, s string, size float32, col ui.Color) ui.Element {
	return ui.Text(c, s).FontSize(size).TextColor(col)
}

func (a *App) muted(c *ui.Context, s string) ui.Element { return a.txt(c, s, 12, a.pl.Muted) }

func (a *App) mono(c *ui.Context, s string) ui.Element {
	return ui.Text(c, s).Font("monospace").FontSize(12).Selectable()
}

// label 是区块小标题。
func (a *App) label(c *ui.Context, s string) ui.Element {
	return ui.Text(c, s).FontSize(12).FontWeight(600).TextColor(a.pl.Muted).LetterSpacing(0.6)
}

// card 是白色圆角卡片（浅色带极淡阴影，深色带内描边高光）。
func (a *App) card(c *ui.Context) ui.Element {
	p := a.pl
	e := ui.Column(c).Padding(16).Radius(14).Background(p.Card).Border(1, p.Line)
	if p.Dark {
		return e.InsetShadow(0, 1, 0, 0, ui.RGBA(255, 255, 255, 0.04))
	}
	return e.Shadow(0, 1, 2, 0, ui.RGBA(29, 27, 22, 0.05)).Shadow(0, 6, 18, -6, ui.RGBA(29, 27, 22, 0.08))
}

// hoverable 让元素悬停时背景换成 Card2，并平滑过渡颜色。
func (a *App) hoverable(e ui.Element, selected bool) ui.Element {
	p := a.pl
	switch {
	case selected:
		e = e.Background(p.AccentSoft).Border(1, p.Accent)
	case e.Hovered():
		e = e.Background(p.Card2)
	}
	return e.Cursor(ui.CursorPointer).Transition(ui.ElementTransition{Colors: true, Duration: 120 * time.Millisecond})
}

func (a *App) pill(c *ui.Context, text string, fg, bg ui.Color) ui.Element {
	return ui.Row(c).Padding(2, 8).Radius(999).Background(bg).AlignItems(ui.Center).Children(func() {
		ui.Text(c, text).FontSize(12).TextColor(fg).SingleLine()
	})
}

// dot 是小圆点（状态灯）。
func (a *App) dot(c *ui.Context, col ui.Color, size float32) ui.Element {
	return ui.Box(c).Size(size, size).Radius(size / 2).Background(col)
}

// ---- 三态 ----

// StateKind 是三态之一。
type StateKind int

const (
	StNone StateKind = iota
	StDanger
	StWould
	StEnforced
)

// stateOf 把 outcome 归到三态之一（只看 outcome，不看 applied）。危险属性单独用 StDanger 表示。
func stateOf(outcome string) StateKind {
	switch ClassifyOutcome(outcome) {
	case OutcomeWould:
		return StWould
	case OutcomeEnforced:
		return StEnforced
	}
	return StNone
}

// stateChip 画一个三态标签。形状各不相同：危险=浅底+三角；会拦=虚线空心斜体；已拦截=实心墨块。
func (a *App) stateChip(c *ui.Context, k StateKind, text string) ui.Element {
	p := a.pl
	switch k {
	case StDanger:
		return ui.Row(c).Gap(4).Padding(2, 8, 2, 6).Radius(6).Background(p.DangerSoft).AlignItems(ui.Center).Children(func() {
			icon(c, "triangle-alert", 13, p.Danger)
			ui.Text(c, text).FontSize(12).FontWeight(650).TextColor(p.Danger).SingleLine()
		}).Label(text)
	case StWould:
		return ui.Row(c).Gap(4).Padding(1, 8, 1, 6).Radius(6).Border(1.5, p.Would).BorderStyle(ui.BorderDashed).AlignItems(ui.Center).Children(func() {
			icon(c, "shield", 13, p.Would)
			ui.Text(c, text).FontSize(12).Italic().TextColor(p.Would).SingleLine()
		}).Label(text)
	default:
		return ui.Row(c).Gap(4).Padding(3, 9, 3, 7).Radius(6).Background(p.Ink).AlignItems(ui.Center).Children(func() {
			icon(c, "shield-check", 13, p.InkText)
			ui.Text(c, text).FontSize(12).FontWeight(700).TextColor(p.InkText).SingleLine()
		}).Label(text)
	}
}

// shortOutcome 是结局标签的文案。
func shortOutcome(outcome string) string {
	switch outcome {
	case "would_have_blocked":
		return "会拦 · 未生效"
	case "would_have_asked":
		return "会问 · 未生效"
	case "blocked":
		return "已拦截"
	case "asked":
		return "已要求确认"
	}
	return ""
}

// outcomeChip 按 outcome 画结局标签：会拦=幽灵、已拦截=实心；建议/续跑只给弱灰标签；其余不画。
func (a *App) outcomeChip(c *ui.Context, outcome, mode string) {
	switch ClassifyOutcome(outcome) {
	case OutcomeWould:
		a.stateChip(c, StWould, shortOutcome(outcome))
	case OutcomeEnforced:
		a.stateChip(c, StEnforced, shortOutcome(outcome))
	case OutcomeAdvise:
		a.weakTag(c, OutcomeText(outcome, mode))
	}
}

// weakTag 是普通（非危险）建议类结局的弱灰标签，与三态不同形。
func (a *App) weakTag(c *ui.Context, text string) ui.Element {
	return ui.Row(c).Padding(1, 6).Radius(4).Background(a.pl.Shade).Children(func() {
		ui.Text(c, text).FontSize(11).TextColor(a.pl.Muted).SingleLine()
	})
}

func (a *App) dangerChip(c *ui.Context, category string) ui.Element {
	t := "危险"
	if category != "" {
		t += "·" + category
	}
	return a.stateChip(c, StDanger, t)
}

// sevMark 是 ▲H ●M ·L：图形 + 文字 + 颜色。
func (a *App) sevMark(c *ui.Context, sev string) ui.Element {
	col := a.pl.Muted
	switch sev {
	case "H":
		col = a.pl.Danger
	case "M":
		col = a.pl.Warn
	}
	return ui.Text(c, SevMark(sev)).FontWeight(700).FontSize(12).TextColor(col).SingleLine()
}

// triadCounts 是一行三态计数（危险 / 会拦 / 已拦截），每个独立成形。0 的项淡显但仍在。
func (a *App) triadCounts(c *ui.Context, total, would, enforced int64) {
	ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
		a.countChip(c, StDanger, total, "危险")
		a.countChip(c, StWould, would, "会拦")
		a.countChip(c, StEnforced, enforced, "已拦")
	})
}

// miniTriad 是紧凑版三态计数：三角 n · 虚线空心圆 n · 实心方块 n（窄处用，形状同样编码三态）。
func (a *App) miniTriad(c *ui.Context, total, would, enforced int64) {
	p := a.pl
	ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
		for _, x := range []struct {
			k StateKind
			n int64
		}{{StDanger, total}, {StWould, would}, {StEnforced, enforced}} {
			ui.Row(c).Gap(3).AlignItems(ui.Center).Children(func() {
				col := p.Muted
				if x.n > 0 {
					switch x.k {
					case StDanger:
						col = p.Danger
					case StWould:
						col = p.Would
					default:
						col = p.Text
					}
				}
				ui.Box(c).Size(13, 13).Draw(func(pt *ui.Painter, r ui.Rect) {
					switch x.k {
					case StDanger:
						pt.Icon(iconSVG("triangle-alert"), r, col)
					case StWould:
						pt.StrokeDashed(ui.Rect{X: r.X + 1, Y: r.Y + 1, W: r.W - 2, H: r.H - 2}, col, 6, 1.5)
					default:
						pt.Fill(ui.Rect{X: r.X + 1, Y: r.Y + 1, W: r.W - 2, H: r.H - 2}, col, 2)
					}
				})
				ui.Text(c, fmt.Sprint(x.n)).FontSize(12).FontWeight(650).TextColor(col).FontFeatures("tnum")
			})
		}
	}).Label(fmt.Sprintf("危险 %d，会拦 %d，已拦截 %d", total, would, enforced))
}

func (a *App) countChip(c *ui.Context, k StateKind, n int64, name string) {
	p := a.pl
	txt := fmt.Sprintf("%s %d", name, n)
	if n == 0 {
		ui.Row(c).Gap(4).Padding(1, 7).AlignItems(ui.Center).Children(func() {
			ui.Text(c, txt).FontSize(12).TextColor(p.Muted).SingleLine()
		}).Opacity(0.6)
		return
	}
	a.stateChip(c, k, txt)
}

// bigTile 是总览的三态大磁贴：数字 + 说明，材质各不相同。
func (a *App) bigTile(c *ui.Context, k StateKind, n int64, title, sub string, onClick func()) {
	p := a.pl
	var fg ui.Color
	var ic string
	e := ui.Column(c).Grow(1).Basis(0).Padding(18, 20).Radius(16).Gap(2)
	switch k {
	case StDanger:
		fg, ic = p.Danger, "triangle-alert"
		e = e.Background(p.DangerSoft).Border(1, p.Danger.Alpha(0.35))
	case StWould:
		fg, ic = p.Would, "shield"
		e = e.Background(p.WouldSoft).Border(2, p.Would).BorderStyle(ui.BorderDashed)
	default:
		fg, ic = p.InkText, "shield-check"
		e = e.Background(p.Ink).Border(1, p.Ink)
	}
	e.Children(func() {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			icon(c, ic, 18, fg)
			ui.Text(c, title).FontSize(13).FontWeight(650).TextColor(fg)
		})
		num := ui.Text(c, fmt.Sprint(n)).FontSize(44).FontWeight(700).TextColor(fg).FontFeatures("tnum")
		if k == StWould {
			num.Italic()
		}
		ui.Text(c, sub).FontSize(12).TextColor(fg).Opacity(0.8)
	}).Label(fmt.Sprintf("%s %d：%s", title, n, sub))
	if onClick != nil && e.Cursor(ui.CursorPointer).Clicked() {
		onClick()
	}
}

func (a *App) kv(c *ui.Context, k, v string) {
	ui.Row(c).FillWidth().Gap(10).Children(func() {
		a.txt(c, k, 12, a.pl.Muted).Width(84)
		ui.Text(c, Or(v, "–")).FontSize(13).Grow(1).Selectable()
	})
}

func (a *App) emptyState(c *ui.Context, ic, title, sub string) {
	ui.Column(c).FillWidth().AlignItems(ui.Center).Padding(40, 16).Gap(8).Children(func() {
		icon(c, ic, 28, a.pl.Muted)
		ui.Text(c, title).FontSize(14).FontWeight(600)
		a.muted(c, sub)
	})
}

// bar 画一条圆角占比条：frac∈[0,1]。
func (a *App) bar(c *ui.Context, frac float64, col ui.Color, h float32) ui.Element {
	if frac < 0 {
		frac = 0
	}
	if frac > 1 {
		frac = 1
	}
	return ui.Box(c).FillWidth().Height(h).Radius(h / 2).Background(a.pl.Shade).Draw(func(p *ui.Painter, r ui.Rect) {
		if frac > 0 {
			w := r.W * float32(frac)
			if w < h {
				w = h
			}
			p.Fill(ui.Rect{X: r.X, Y: r.Y, W: w, H: r.H}, col, h/2)
		}
	})
}

func (a *App) errLine(c *ui.Context, msg string) {
	if msg == "" {
		return
	}
	ui.Row(c).FillWidth().Gap(8).Padding(8, 12).Radius(8).Background(a.pl.WarnSoft).AlignItems(ui.Center).Children(func() {
		icon(c, "circle-alert", 14, a.pl.Warn)
		ui.Text(c, msg).FontSize(12).TextColor(a.pl.Warn)
	})
}

func (a *App) rel(ms int64) string { return Rel(ms, a.now()) }

// sid 缩写会话 id：短的原样，UUID 之类保留头 8 位和末 4 位。
func sid(id string) string {
	r := []rune(id)
	if len(r) <= 18 {
		return id
	}
	return string(r[:8]) + "…" + string(r[len(r)-4:])
}
