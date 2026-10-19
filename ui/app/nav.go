package app

import (
	"github.com/egoist/mygo/ui"
)

// 键盘导航约定（各页一致）：J / ↓ 下一条，K / ↑ 上一条，Enter 打开详情，Esc 关闭。
// 命令面板打开时，这些键归面板，页面不响应。

// moveDir 读取本帧的上下移动：+1 下、-1 上、0 无。
func (a *App) moveDir(c *ui.Context) int {
	if a.pal.open {
		return 0
	}
	switch {
	case c.Shortcut(0, ui.KeyJ), c.Shortcut(0, ui.KeyDown):
		return 1
	case c.Shortcut(0, ui.KeyK), c.Shortcut(0, ui.KeyUp):
		return -1
	}
	return 0
}

// enterPressed 本帧是否按了 Enter（面板打开时不响应）。
func (a *App) enterPressed(c *ui.Context) bool {
	return !a.pal.open && c.Shortcut(0, ui.KeyEnter)
}

// stepIndex 在 [0,n) 内从 cur 走 dir 步；cur<0（还没有游标）时，向下落在第 0 项，向上落在最后一项。
func stepIndex(cur, dir, n int) int {
	if n == 0 {
		return -1
	}
	if cur < 0 {
		if dir > 0 {
			return 0
		}
		return n - 1
	}
	cur += dir
	if cur < 0 {
		cur = 0
	}
	if cur > n-1 {
		cur = n - 1
	}
	return cur
}

// panelOpen 当前页是否有右侧详情面板打开。
func (a *App) panelOpen() bool {
	switch a.page {
	case PageDanger:
		return a.dg.sel != 0
	case PageSessions:
		return a.ss.hitSel != 0
	case PageJudge:
		return a.jd.open
	}
	return false
}

// closePanel 关闭当前页的右侧面板（Esc）。
func (a *App) closePanel() {
	a.dg.sel, a.ss.hitSel, a.jd.open = 0, 0, false
}

// 右侧详情面板的几何：浮在列表右侧，不推挤列表（列表不用重排）。
const (
	panelW      = 400
	panelRightM = 24
	panelBottom = 16
)

// sidePanel 在当前（定位）父元素内画右侧滑出面板。父元素需是整页的根容器。
// 进出只用位移 + 透明度（slideFromRight），内容在面板内自己滚动。
func (a *App) sidePanel(c *ui.Context, right, bottom float32, body func()) {
	p := a.pl
	ui.Box(c).Key("side-panel").Absolute().Top(0).Right(right).Bottom(bottom).Width(panelW).
		Radius(10).Background(p.Card).Border(1, p.Line).Padding(14).Transition(slideFromRight).Children(func() {
		ui.Scroll(c).Fill().Children(func() {
			ui.Column(c).FillWidth().Gap(8).Children(body)
		})
	})
}

// panelHeader 是面板标题行：标题 + 关闭按钮（悬停提示 Esc）。
func (a *App) panelHeader(c *ui.Context, title string, onClose func()) {
	p := a.pl
	ui.Row(c).FillWidth().AlignItems(ui.Center).Children(func() {
		a.label(c, title)
		ui.Spacer(c)
		x := ui.Row(c).Padding(4).Radius(6).Cursor(ui.CursorPointer).Children(func() { icon(c, "x", 14, p.Muted) }).Label("关闭").Tooltip("关闭 · Esc")
		if x.Hovered() {
			x.Background(p.Shade)
		}
		if x.Clicked() {
			onClose()
		}
	})
}
