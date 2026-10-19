package app

import (
	"fmt"

	"github.com/egoist/mygo/ui"
)

// pal 是语义色（浅色/深色各一套，随系统外观）。三类危险状态用不同的形状、边框、颜色和文案（§7.5）。
type pal struct {
	Danger, DangerBg        ui.Color // ⚠ 危险：实心红
	Would, WouldBg          ui.Color // ◌ 本应拦截：琥珀 + 虚线 + 斜纹
	Enforced                ui.Color // ■ 已拦截：实心深红
	Warn, WarnBg            ui.Color // 警告条
	Ok, Muted, Faint, Panel ui.Color
	SevH, SevM, SevL        ui.Color
}

func palOf(c *ui.Context) pal {
	t := c.Theme()
	if t.Dark {
		return pal{
			Danger: ui.Hex("#ef4444"), DangerBg: ui.RGBA(239, 68, 68, 0.16),
			Would: ui.Hex("#fbbf24"), WouldBg: ui.RGBA(251, 191, 36, 0.10),
			Enforced: ui.Hex("#b91c1c"),
			Warn:     ui.Hex("#fbbf24"), WarnBg: ui.RGBA(251, 191, 36, 0.14),
			Ok: ui.Hex("#4ade80"), Muted: t.TextMuted, Faint: ui.RGBA(255, 255, 255, 0.06), Panel: ui.RGBA(255, 255, 255, 0.04),
			SevH: ui.Hex("#f87171"), SevM: ui.Hex("#fbbf24"), SevL: t.TextMuted,
		}
	}
	return pal{
		Danger: ui.Hex("#dc2626"), DangerBg: ui.RGBA(220, 38, 38, 0.09),
		Would: ui.Hex("#b45309"), WouldBg: ui.RGBA(245, 158, 11, 0.10),
		Enforced: ui.Hex("#991b1b"),
		Warn:     ui.Hex("#b45309"), WarnBg: ui.RGBA(245, 158, 11, 0.16),
		Ok: ui.Hex("#15803d"), Muted: t.TextMuted, Faint: ui.RGBA(0, 0, 0, 0.05), Panel: ui.RGBA(0, 0, 0, 0.025),
		SevH: ui.Hex("#dc2626"), SevM: ui.Hex("#b45309"), SevL: t.TextMuted,
	}
}

// dim 是表格里「次要文字」的颜色：行被选中（蓝底）时用半透明白，保证对比度。
func (p pal) dim(selected bool) ui.Color {
	if selected {
		return ui.RGBA(255, 255, 255, 0.85)
	}
	return p.Muted
}

func (p pal) sevColor(sev string) ui.Color {
	switch sev {
	case "H":
		return p.SevH
	case "M":
		return p.SevM
	}
	return p.SevL
}

// dangerBadge 是实心红色的「⚠ 危险·类别」徽标。
func dangerBadge(c *ui.Context, category string) {
	p := palOf(c)
	label := "⚠ 危险"
	if category != "" {
		label += "·" + category
	}
	ui.Row(c).Padding(2, 7).Radius(4).Background(p.Danger).Children(func() {
		ui.Text(c, label).Bold().FontSize(12).TextColor(ui.RGB(255, 255, 255)).SingleLine()
	}).Label(label)
}

// wouldBadge 是「◌ 本应拦截」：虚线琥珀描边、斜体、浅色斜纹底，看上去是「未兑现」。
func wouldBadge(c *ui.Context, text string) {
	p := palOf(c)
	ui.Row(c).Padding(1, 7).Radius(4).Background(p.WouldBg).Stripes(p.WouldBg, 3, 5, 45).
		Border(1.5, p.Would).BorderStyle(ui.BorderDashed).Children(func() {
		ui.Text(c, "◌ "+text).Italic().FontSize(12).TextColor(p.Would).SingleLine()
	}).Label(text)
}

// enforcedBadge 是「■ 已拦截」：实心深红填充、白字，看上去是「已兑现」。
func enforcedBadge(c *ui.Context, text string) {
	p := palOf(c)
	ui.Row(c).Padding(2, 7).Radius(4).Background(p.Enforced).Children(func() {
		ui.Text(c, "■ "+text).Bold().FontSize(12).TextColor(ui.RGB(255, 255, 255)).SingleLine()
	}).Label(text)
}

// outcomeBadge 按 Decision.outcome 画结局指示器：◌ / ■ 用上面两种；建议类用较弱的灰色小标签。
func outcomeBadge(c *ui.Context, outcome, mode string) {
	txt := OutcomeText(outcome, mode)
	switch ClassifyOutcome(outcome) {
	case OutcomeWould:
		wouldBadge(c, txt)
	case OutcomeEnforced:
		enforcedBadge(c, txt)
	case OutcomeAdvise:
		weakTag(c, txt)
	}
}

// weakTag 是普通（非危险）规则在 shadow 下的「未生效」灰色小标签，不与三类危险状态混用。
func weakTag(c *ui.Context, text string) {
	p := palOf(c)
	ui.Row(c).Padding(1, 6).Radius(4).Background(p.Faint).Children(func() {
		ui.Text(c, text).FontSize(11).TextColor(p.Muted).SingleLine()
	})
}

// chip 是中性的小胶囊（harness、状态…）。
func chip(c *ui.Context, text string, fg, bg ui.Color) {
	ui.Row(c).Padding(1, 7).Radius(8).Background(bg).Children(func() {
		ui.Text(c, text).FontSize(12).TextColor(fg).SingleLine()
	})
}

// sevMark 是 ▲H ●M ·L（文字/图形 + 颜色双重编码）。
func sevMark(c *ui.Context, sev string) ui.Element {
	return ui.Text(c, SevMark(sev)).Bold().TextColor(palOf(c).sevColor(sev)).SingleLine()
}

// dangerCount 是危险列：`⚠ 3 ◌3`（有本应拦截）/ `⚠ 3 ■3`（已拦截）/ 灰色 ·。
func dangerCount(c *ui.Context, total, would, enforced int64) {
	p := palOf(c)
	if total == 0 {
		ui.Text(c, "·").TextColor(p.Muted)
		return
	}
	ui.Row(c).Gap(4).AlignItems(ui.Center).Children(func() {
		ui.Text(c, fmt.Sprintf("⚠ %d", total)).Bold().TextColor(p.Danger).SingleLine()
		if would > 0 {
			ui.Row(c).Padding(0, 5).Radius(3).Border(1, p.Would).BorderStyle(ui.BorderDashed).Children(func() {
				ui.Text(c, fmt.Sprintf("◌ 本应拦截 %d", would)).Italic().FontSize(12).TextColor(p.Would).SingleLine()
			})
		}
		if enforced > 0 {
			ui.Row(c).Padding(0, 5).Radius(3).Background(p.Enforced).Children(func() {
				ui.Text(c, fmt.Sprintf("■ 已拦截 %d", enforced)).FontSize(12).Bold().TextColor(ui.RGB(255, 255, 255)).SingleLine()
			})
		}
	})
}

// banner 是整行的提示条（警告/错误）。
func banner(c *ui.Context, fg, bg ui.Color, text string) {
	ui.Row(c).FillWidth().Padding(6, 12).Background(bg).Children(func() {
		ui.Text(c, text).TextColor(fg).FontSize(13)
	})
}

// section 是带标题的卡片区块。
func section(c *ui.Context, title string, body func()) {
	p := palOf(c)
	ui.Column(c).FillWidth().Gap(6).Padding(10, 12).Radius(8).Background(p.Panel).Children(func() {
		ui.Text(c, title).Bold().FontSize(12).TextColor(p.Muted)
		body()
	})
}

// kv 是详情里的「键 值」一行；值可选可复制。
func kv(c *ui.Context, k, v string) {
	p := palOf(c)
	ui.Row(c).FillWidth().Gap(10).Children(func() {
		ui.Text(c, k).FontSize(12).TextColor(p.Muted).Width(96)
		ui.Text(c, Or(v, "–")).FontSize(13).Grow(1).Selectable()
	})
}

// mono 是等宽的可选文本（命令、路径、消息）。
func mono(c *ui.Context, s string) ui.Element {
	return ui.Text(c, s).Font("monospace").FontSize(12).Selectable()
}
