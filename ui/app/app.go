package app

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Fan-chou/agent-supervisor/ui/api"
	"github.com/egoist/mygo/ui"
)

// 页面 id（侧栏项的 id）。
const (
	PageSessions = "sessions"
	PageTimeline = "timeline"
	PageJudge    = "judge"
	PageRouting  = "routing"
	PageRules    = "rules"
	PageStats    = "stats"
	PageReplay   = "replay"
)

// App 是界面的全部状态。视图只在主线程读写它；网络协程只经由 post 改它（frontend-design §10.3）。
type App struct {
	Client *api.Client
	Demo   bool // 数据来自内置的合成演示数据

	ctx  context.Context
	post func(func()) // 在主线程执行（win.Update）；测试里直接执行
	now  func() time.Time
	sync bool // 同步模式：async 在调用线程里跑完（截图/测试）

	connMu sync.Mutex
	conn   *Machine
	dirty  atomic.Bool // 流上来了新消息；10 Hz 合并后刷新当前页

	page      string
	inflight  map[string]bool
	pending   map[string]func(context.Context) (func(), error)
	errByKey  map[string]string
	errLog    []string
	lastData  time.Time
	permWarn  string
	reloadGen int

	// 顶栏
	status   *api.Status
	today    api.DangerStats
	hasToday bool

	s sessionsPage
	t timelinePage
	j judgePage
	r rulesPage
	k statsPage
	p replayPage
}

// New 创建 App；post 为 nil 时在调用线程里直接执行（测试用）。
func New(ctx context.Context, cl *api.Client, post func(func())) *App {
	a := &App{Client: cl, ctx: ctx, post: post, now: time.Now, conn: NewMachine(), page: PageSessions,
		inflight: map[string]bool{}, pending: map[string]func(context.Context) (func(), error){}, errByKey: map[string]string{}}
	if a.post == nil {
		a.post = func(f func()) { f() }
	}
	a.initPages()
	return a
}

// SetSync 打开同步模式：所有 async 在调用线程里完成（截图和测试用，不启动后台协程）。
func (a *App) SetSync(v bool) { a.sync = v }

// SetNow 替换时钟（截图要稳定的相对时间）。
func (a *App) SetNow(f func() time.Time) { a.now = f }

// Page 返回当前页。
func (a *App) Page() string { return a.page }

// Goto 切换页面并刷新它的数据。
func (a *App) Goto(page string) {
	if a.page != page {
		a.page = page
	}
	a.refresh()
}

// ---- 异步加载 ----

// async 在后台跑 load（不碰界面状态），成功后在主线程里调用它返回的 apply。
// 同一 key 同时只有一个请求在飞；期间又来的请求只记最后一个，前一个结束后再跑。
func (a *App) async(key string, load func(ctx context.Context) (func(), error)) {
	if a.inflight[key] {
		a.pending[key] = load
		return
	}
	a.inflight[key] = true
	run := func() {
		apply, err := load(a.ctx)
		a.post(func() {
			delete(a.inflight, key)
			if err != nil {
				a.fail(key, err)
			} else {
				delete(a.errByKey, key)
				apply()
				a.lastData = a.now()
			}
			if next, ok := a.pending[key]; ok {
				delete(a.pending, key)
				a.async(key, next)
			}
		})
	}
	if a.sync {
		run()
		return
	}
	go run()
}

func (a *App) fail(key string, err error) {
	msg := err.Error()
	if ae, ok := err.(*api.Error); ok && ae.Kind == api.ErrUnreachable && a.ctx.Err() != nil {
		return
	}
	a.errByKey[key] = msg
	line := fmt.Sprintf("%s %s: %s", a.now().Format("15:04:05"), key, msg)
	a.errLog = append(a.errLog, line)
	if len(a.errLog) > 20 {
		a.errLog = a.errLog[len(a.errLog)-20:]
	}
}

// errOf 返回某个加载键最近一次失败原因（空 = 没失败）。
func (a *App) errOf(keys ...string) string {
	for _, k := range keys {
		if m := a.errByKey[k]; m != "" {
			return m
		}
	}
	return ""
}

// ---- 刷新调度 ----

// refresh 重新拉当前页需要的数据（顶栏数据永远拉）。
func (a *App) refresh() {
	a.loadTop()
	switch a.page {
	case PageSessions:
		a.loadSessions()
	case PageTimeline:
		a.loadTimeline(false)
	case PageJudge:
		a.loadJudge()
	case PageRouting:
		a.loadRouting()
	case PageRules:
		a.loadRules()
	case PageStats:
		a.loadStats()
	case PageReplay:
		a.loadReplay()
	}
}

// LoadAll 拉所有页面的数据（同步模式下截图用）。
func (a *App) LoadAll() {
	cur := a.page
	for _, p := range []string{PageSessions, PageTimeline, PageJudge, PageRouting, PageRules, PageStats, PageReplay} {
		a.page = p
		a.refresh()
	}
	a.page = cur
}

func (a *App) loadTop() {
	a.async("status", func(ctx context.Context) (func(), error) {
		st, err := a.Client.Status(ctx)
		if err != nil {
			return nil, err
		}
		q := url.Values{"since": {fmt.Sprint(TodayStartMs(a.now()))}}
		ds, derr := a.Client.DangerStats(ctx, q)
		return func() {
			a.status = &st
			if derr == nil {
				a.today, a.hasToday = ds, true
			}
		}, nil
	})
}

// ---- 视图 ----

// View 是窗口内容的 view 函数。
func (a *App) View(c *ui.Context) {
	for i, p := range []string{PageSessions, PageTimeline, PageJudge, PageRouting, PageRules, PageStats, PageReplay} {
		p := p
		c.OnShortcut(ui.Cmd, ui.Key(int(ui.Key1)+i), func() { a.Goto(p) })
	}
	c.OnShortcut(ui.Cmd, ui.KeyR, a.refresh)
	stale := a.connSnapshot().Stale()
	ui.Column(c).Fill().Children(func() {
		a.topBar(c)
		ui.Row(c).Grow(1).MinHeight(0).AlignItems(ui.Stretch).Children(func() {
			a.sidebar(c)
			ui.Column(c).Grow(1).MinWidth(0).MinHeight(0).Children(func() {
				p := palOf(c)
				if stale {
					m := a.connSnapshot()
					banner(c, p.Danger, p.DangerBg, fmt.Sprintf("守护进程离线：页面只读，保留旧数据（最后成功 %s）。UI 不会启动它：请在终端运行 sv start。", FmtClock(m.LastOK)))
				}
				col := ui.Column(c).Grow(1).MinHeight(0)
				if stale {
					col.Opacity(0.55)
				}
				col.Children(func() { a.pageBody(c) })
			})
		})
		a.bottomBar(c)
	})
}

// FmtClock 写 HH:MM:SS，零时间写「从未」。
func FmtClock(t time.Time) string {
	if t.IsZero() {
		return "从未"
	}
	return t.Local().Format("15:04:05")
}

func (a *App) pageBody(c *ui.Context) {
	switch a.page {
	case PageSessions:
		a.sessionsView(c)
	case PageTimeline:
		a.timelineView(c)
	case PageJudge:
		a.judgeView(c)
	case PageRouting:
		a.routingView(c)
	case PageRules:
		a.rulesView(c)
	case PageStats:
		a.statsView(c)
	case PageReplay:
		a.replayView(c)
	}
}

func (a *App) sidebar(c *ui.Context) {
	page := a.page
	danger := int64(0)
	if a.hasToday {
		danger = a.today.Total
	}
	ui.Sidebar(c, &page, func() {
		ui.SidebarSection(c, "监督", nil, func() {
			ui.SidebarItem(c, PageSessions, nil, "实时会话")
			ui.SidebarItem(c, PageTimeline, nil, "事件时间线")
			ui.SidebarItem(c, PageStats, nil, "规则统计").Children(func() {
				if danger > 0 {
					ui.Badge(c, fmt.Sprintf("⚠ %d", danger))
				}
			})
		})
		ui.SidebarSection(c, "Judge", nil, func() {
			ui.SidebarItem(c, PageJudge, nil, "Judge 裁决")
			ui.SidebarItem(c, PageRouting, nil, "Judge 路由")
		})
		ui.SidebarSection(c, "配置与回放", nil, func() {
			ui.SidebarItem(c, PageRules, nil, "规则配置")
			ui.SidebarItem(c, PageReplay, nil, "回放结果")
		})
	}).Width(190).Label("页面")
	if page != a.page {
		a.Goto(page)
	}
}

func (a *App) topBar(c *ui.Context) {
	p := palOf(c)
	t := c.Theme()
	m := a.connSnapshot()
	ui.Row(c).FillWidth().Padding(8, 14).Gap(12).AlignItems(ui.Center).Background(p.Panel).BorderWidth(0, 0, 1, 0).BorderColor(t.Border).Children(func() {
		ui.Text(c, "agent-supervisor").Bold().FontSize(15)
		// 连接状态：图形 + 文字
		cfg, cbg := p.Muted, p.Faint
		switch m.State {
		case Live:
			cfg, cbg = p.Ok, p.Faint
		case Reconnecting, Degraded:
			cfg, cbg = p.Warn, p.WarnBg
		case Offline:
			cfg, cbg = ui.RGB(255, 255, 255), p.Danger
		}
		chip(c, m.State.Label(), cfg, cbg)
		a.modeBadge(c)
		a.dangerCounter(c)
		ui.Spacer(c)
		if a.status != nil {
			var bad []string
			for h, n := range a.status.AdapterFailures15m {
				if n > 0 {
					bad = append(bad, fmt.Sprintf("%s %d", h, n))
				}
			}
			if len(bad) > 0 {
				chip(c, "⚠ 适配器失败(15m) "+strings.Join(bad, " · "), p.Warn, p.WarnBg)
			}
			if a.status.Judge.Enabled {
				label := "judge 开"
				if a.status.Judge.Model != "" {
					label += " · " + a.status.Judge.Model
				}
				fg, bg := p.Muted, p.Faint
				switch a.status.Judge.Health {
				case "degraded":
					label, fg, bg = "▲ judge 降级", p.Warn, p.WarnBg
				case "unavailable":
					label, fg, bg = "✕ judge 不可用", ui.RGB(255, 255, 255), p.Danger
				}
				chip(c, label, fg, bg)
			} else {
				chip(c, "judge 关", p.Muted, p.Faint)
			}
			if a.status.DbBytes > 0 {
				ui.Text(c, "日志库 "+FmtBytes(a.status.DbBytes)).FontSize(12).SingleLine().TextColor(p.Muted).Tooltip(a.status.Db)
			}
			ui.Text(c, fmt.Sprintf("v%s · 协议 %d", a.status.Version, a.status.Protocol)).FontSize(12).TextColor(p.Muted).Tooltip("日志库：" + a.status.Db)
		}
		if a.permWarn != "" {
			chip(c, "⚠ "+a.permWarn, p.Warn, p.WarnBg)
		}
		if a.Demo {
			chip(c, "DEMO · 合成数据", ui.RGB(255, 255, 255), ui.Hex("#7c3aed"))
		}
	})
	if msg := m.LastErr; msg != "" && m.State != Live {
		banner(c, p.Warn, p.WarnBg, "实时推送已断开："+msg+(map[bool]string{true: "；数据每 5 秒轮询刷新", false: ""}[m.State == Degraded]))
	}
}

func (a *App) modeBadge(c *ui.Context) {
	p := palOf(c)
	mode := "?"
	if a.status != nil {
		mode = a.status.Mode
	}
	switch mode {
	case "shadow":
		chip(c, "SHADOW · 纯观察，未拦截", p.Muted, p.Faint)
	case "advise":
		chip(c, "ADVISE · 只建议，不拦截", p.Warn, p.WarnBg)
	case "enforce":
		chip(c, "ENFORCE · 拦截已开启", ui.RGB(255, 255, 255), p.Enforced)
	default:
		chip(c, "mode 未知", p.Muted, p.Faint)
	}
}

// dangerCounter 是顶栏常驻的今日危险计数；点击进规则统计的危险页签（§7.5）。
func (a *App) dangerCounter(c *ui.Context) {
	p := palOf(c)
	if !a.hasToday {
		return
	}
	d := a.today
	row := ui.Row(c).Gap(6).AlignItems(ui.Center).Padding(0, 4).Cursor(ui.CursorPointer).Tooltip("点击查看危险明细")
	row.Children(func() {
		if d.Total == 0 {
			ui.Text(c, "· 今日无危险操作").FontSize(12).TextColor(p.Muted)
			return
		}
		ui.Text(c, fmt.Sprintf("⚠ 今日危险 %d", d.Total)).Bold().FontSize(13).TextColor(p.Danger)
		if d.WouldHaveBlocked > 0 {
			wouldBadge(c, fmt.Sprintf("本应拦截 %d", d.WouldHaveBlocked))
		}
		if d.Enforced > 0 {
			enforcedBadge(c, fmt.Sprintf("已拦截 %d", d.Enforced))
		}
	})
	if row.Clicked() {
		a.k.tab = tabDanger
		a.Goto(PageStats)
	}
}

func (a *App) bottomBar(c *ui.Context) {
	p := palOf(c)
	t := c.Theme()
	ui.Row(c).FillWidth().Padding(4, 14).Gap(12).AlignItems(ui.Center).BorderWidth(1, 0, 0, 0).BorderColor(t.Border).Children(func() {
		if n := len(a.errLog); n > 0 {
			el := ui.Text(c, fmt.Sprintf("最近错误 %d 条 · %s（点击复制全部）", n, a.errLog[n-1])).FontSize(12).TextColor(p.Warn).SingleLine().Grow(1).Cursor(ui.CursorPointer)
			if el.Clicked() {
				c.WriteClipboard(strings.Join(a.errLog, "\n"))
				c.Toast("已复制最近错误")
			}
		} else {
			ui.Text(c, "无错误").FontSize(12).TextColor(p.Muted).Grow(1)
		}
		ui.Text(c, "最后更新 "+FmtClock(a.lastData)).FontSize(12).TextColor(p.Muted)
		ui.Text(c, "界面只读（唯一可改：规则启用与阈值）").FontSize(12).TextColor(p.Muted)
	})
}

func (a *App) connSnapshot() Machine {
	a.connMu.Lock()
	defer a.connMu.Unlock()
	return *a.conn
}
