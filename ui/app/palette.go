package app

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"
)

// 命令面板（Cmd+K）：搜页面 / 会话 / 规则并跳转。只读：这里没有任何写操作入口。

const (
	palDebounce = 90 * time.Millisecond
	palMax      = 40
)

type palItem struct {
	kind  string // page · session · rule
	id    string
	title string
	sub   string
	icon  string
}

type palState struct {
	open    bool
	query   string // 输入框里的内容
	applied string // 已用于过滤的内容（防抖后）
	edited  time.Time
	items   []palItem // 当前显示
	cur     int
	list    ui.ListState
	opened  bool // 本次打开是否已触发过数据加载
}

// FilterPalette 按空格分词做不区分大小写的子串匹配（每个词都要命中），标题命中优先、越靠前越好。
// 空查询返回前 max 项（调用方把页面放在最前）。纯函数，便于测试。
func FilterPalette(all []palItem, q string, max int) []palItem {
	q = strings.ToLower(strings.TrimSpace(q))
	if q == "" {
		if len(all) > max {
			return all[:max]
		}
		return all
	}
	toks := strings.Fields(q)
	type sc struct {
		it    palItem
		score int
		idx   int
	}
	var hits []sc
	for i, it := range all {
		t, s := strings.ToLower(it.title), strings.ToLower(it.sub+" "+it.id)
		score, ok := 0, true
		for _, tk := range toks {
			if p := strings.Index(t, tk); p >= 0 {
				score += p
			} else if p := strings.Index(s, tk); p >= 0 {
				score += 100 + p
			} else {
				ok = false
				break
			}
		}
		if ok {
			hits = append(hits, sc{it, score, i})
		}
	}
	sort.SliceStable(hits, func(i, j int) bool { return hits[i].score < hits[j].score })
	if len(hits) > max {
		hits = hits[:max]
	}
	out := make([]palItem, len(hits))
	for i, h := range hits {
		out[i] = h.it
	}
	return out
}

// paletteSource 汇集可搜索的条目：页面、规则、会话。
func (a *App) paletteSource() []palItem {
	var all []palItem
	for i, d := range pageDefs {
		all = append(all, palItem{kind: "page", id: d.id, title: d.title, sub: fmt.Sprintf("页面 ⌘%d", i+1), icon: d.icon})
	}
	for _, r := range a.rl.rules {
		all = append(all, palItem{kind: "rule", id: r.ID, title: r.ID + " " + r.Title, sub: "规则 · " + r.Category, icon: "sliders-horizontal"})
	}
	for _, s := range a.sessions {
		all = append(all, palItem{kind: "session", id: s.SessionID, title: sid(s.SessionID), sub: "会话 · " + ShortPath(Str(s.Project)) + " " + Str(s.Harness) + " " + s.SessionID, icon: "terminal"})
	}
	return all
}

func (a *App) openPalette() {
	p := &a.pal
	p.open, p.query, p.applied, p.cur = true, "", "\x00", 0 // applied 设成不可能值，强制首帧重算
	p.list = ui.ListState{}
	if !p.opened {
		p.opened = true
	}
	// 规则列表只在规则页加载过；打开面板时补一次，会话列表同理
	if !a.rl.loaded {
		a.loadRules()
	}
	a.loadSessions()
}

func (a *App) pickPalette(it palItem) {
	a.pal.open = false
	switch it.kind {
	case "page":
		a.Goto(it.id)
	case "session":
		a.selectSession(it.id)
		a.Goto(PageSessions)
	case "rule":
		a.rl.sel, a.rl.draftID = it.id, ""
		a.Goto(PageRules)
	}
}

// refilter 防抖：输入停顿 palDebounce 之后才重算；期间用 After 排一次重画，不逐帧请求。
func (a *App) refilter(c *ui.Context) {
	p := &a.pal
	if p.applied == p.query && p.items != nil {
		return
	}
	if wait := palDebounce - a.now().Sub(p.edited); wait > 0 && p.applied != "\x00" {
		c.After(wait)
		return
	}
	p.applied = p.query
	p.items = FilterPalette(a.paletteSource(), p.query, palMax)
	if p.items == nil {
		p.items = []palItem{}
	}
	p.cur = 0
}

func (a *App) palette(c *ui.Context) {
	p := &a.pal
	if !p.open {
		return
	}
	a.refilter(c)
	pl := a.pl
	submitted := false
	m := ui.Modal(c, &p.open, func() {
		ui.Column(c).Width(560).Gap(0).Children(func() {
			ui.Row(c).FillWidth().Padding(4, 4, 8, 8).Gap(8).AlignItems(ui.Center).Children(func() {
				icon(c, "search", 15, pl.Muted)
				f := ui.TextInput(c, &p.query).Label("搜索页面、会话、规则").Placeholder("搜索页面、会话、规则…").Focus().Grow(1)
				if f.Changed() {
					p.edited = a.now()
				}
				submitted = f.Submitted()
			})
			ui.Box(c).FillWidth().Height(1).Background(pl.Line)
			if len(p.items) == 0 {
				a.emptyState(c, "search", "没有匹配", "试试页面名、规则编号（如 X2）或会话 ID")
				return
			}
			p.list.Key = func(i int) any { return p.items[i].kind + p.items[i].id }
			ui.List(c, &p.list, len(p.items), func(i int) { a.palRow(c, i) }).Height(minf(float32(len(p.items))*38+8, 380))
		})
	})
	if m.OverlayShortcut(0, ui.KeyDown) && p.cur < len(p.items)-1 {
		p.cur++
		p.list.ScrollIntoView(p.cur)
	}
	if m.OverlayShortcut(0, ui.KeyUp) && p.cur > 0 {
		p.cur--
		p.list.ScrollIntoView(p.cur)
	}
	if (submitted || m.OverlayShortcut(0, ui.KeyEnter)) && p.cur < len(p.items) {
		a.pickPalette(p.items[p.cur])
	}
}

func minf(a, b float32) float32 {
	if a < b {
		return a
	}
	return b
}

func (a *App) palRow(c *ui.Context, i int) {
	p := &a.pal
	pl := a.pl
	it := p.items[i]
	row := ui.Row(c).Key(it.kind+it.id).FillWidth().Height(36).Padding(0, 10).Gap(10).Radius(6).AlignItems(ui.Center)
	if i == p.cur {
		row = row.Background(pl.Shade)
	} else if row.Hovered() {
		row = row.Background(pl.Card2)
	}
	row.Cursor(ui.CursorPointer).Children(func() {
		icon(c, it.icon, 15, pl.Muted)
		a.txt(c, it.title, 13, pl.Text).SingleLine().Grow(1).MinWidth(0)
		if it.kind != "session" {
			a.txt(c, it.sub, 11, pl.Muted).SingleLine()
		} else {
			a.txt(c, "会话", 11, pl.Muted)
		}
		if i == p.cur {
			a.txt(c, "↵", 11, pl.Muted)
		}
	})
	if row.Clicked() {
		a.pickPalette(it)
	}
}
