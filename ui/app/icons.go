package app

import (
	"fmt"
	"os"

	"github.com/egoist/mygo/ui"
)

// 图标取自 Lucide（https://lucide.dev，ISC 许可；部分源自 Feather，MIT）。许可全文见 icons/LICENSE。
// 这里只存 24×24 画布上的图形主体，统一包上描边属性；解析失败的图标退化为空白，不会 panic。
var iconBodies = map[string]string{
	"layout-dashboard":   `<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>`,
	"terminal":           `<path d="M12 19h8"/><path d="m4 17 6-6-6-6"/>`,
	"triangle-alert":     `<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>`,
	"sliders-horizontal": `<path d="M10 5H3"/><path d="M12 19H3"/><path d="M14 3v4"/><path d="M16 17v4"/><path d="M21 12h-9"/><path d="M21 19h-5"/><path d="M21 5h-7"/><path d="M8 10v4"/><path d="M8 12H3"/>`,
	"scale":              `<path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="M7 21h10"/><path d="M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/>`,
	"history":            `<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>`,
	"shield":             `<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>`,
	"shield-check":       `<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>`,
	"activity":           `<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>`,
	"lock":               `<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>`,
	"search":             `<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>`,
	"chevron-right":      `<path d="m9 18 6-6-6-6"/>`,
	"chevron-down":       `<path d="m6 9 6 6 6-6"/>`,
	"eye":                `<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>`,
	"check":              `<path d="M20 6 9 17l-5-5"/>`,
	"x":                  `<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`,
	"folder":             `<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>`,
	"database":           `<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>`,
	"wifi":               `<path d="M12 20h.01"/><path d="M2 8.82a15 15 0 0 1 20 0"/><path d="M5 12.859a10 10 0 0 1 14 0"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/>`,
	"panel-right":        `<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>`,
	"arrow-right":        `<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>`,
	"clock":              `<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>`,
	"cpu":                `<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/>`,
	"git-compare":        `<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M11 18H8a2 2 0 0 1-2-2V9"/>`,
	"circle-alert":       `<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>`,
	"pencil":             `<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>`,
}

var iconCache = map[string]*ui.SVG{}

func iconSVG(name string) *ui.SVG {
	if s, ok := iconCache[name]; ok {
		return s
	}
	var s *ui.SVG
	if body, ok := iconBodies[name]; ok {
		src := `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` + body + `</svg>`
		var err error
		if s, err = ui.ParseSVG([]byte(src)); err != nil {
			fmt.Fprintln(os.Stderr, "icon", name, err)
			s = nil
		}
	}
	iconCache[name] = s
	return s
}

// icon 画一个线性图标；size 是边长，col 为零值时继承文字色。
func icon(c *ui.Context, name string, size float32, col ui.Color) ui.Element {
	s := iconSVG(name)
	if s == nil {
		return ui.Box(c).Size(size, size)
	}
	e := ui.Icon(c, s).FontSize(size)
	if col != (ui.Color{}) {
		e = e.TextColor(col)
	}
	return e
}
