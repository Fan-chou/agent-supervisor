package app

import (
	"context"
	"fmt"
	"net/url"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Fan-chou/agent-supervisor/ui/api"
	"github.com/egoist/mygo/ui"
)

// 页面 id。
const (
	PageOverview = "overview"
	PageSessions = "sessions"
	PageDanger   = "danger"
	PageRules    = "rules"
	PageJudge    = "judge"
	PageReplay   = "replay"
)

type pageDef struct{ id, title, icon string }

var pageDefs = []pageDef{
	{PageOverview, "总览", "layout-dashboard"},
	{PageSessions, "会话", "terminal"},
	{PageDanger, "危险", "triangle-alert"},
	{PageRules, "规则", "sliders-horizontal"},
	{PageJudge, "Judge", "scale"},
	{PageReplay, "回放", "history"},
}

// App 是界面的全部状态。视图只在主线程读写它；网络协程只经由 post 改它。
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

	pl     pal  // 当前帧的调色板
	narrow bool // 窗口宽度 < 1200：收起次要信息

	// 全局
	status   *api.Status
	today    api.DangerStats
	hasToday bool
	week     api.DangerStats
	sessions []api.SessionSummary
	sessLoad bool
	ruleStat []api.RuleStat

	ex    explainState
	toast string // 下一帧弹出的提示

	// 新事件高亮（motion.go）：seen 记录已见 key，fresh 记录新到时间；reduce 来自系统「减弱动态效果」。
	seen   map[string]map[string]bool
	fresh  map[string]time.Time
	reduce bool

	ss sessionsPage
	dg dangerPage
	rl rulesPage
	jd judgePage
	rp replayPage
}

// New 创建 App；post 为 nil 时在调用线程里直接执行（测试用）。
func New(ctx context.Context, cl *api.Client, post func(func())) *App {
	a := &App{Client: cl, ctx: ctx, post: post, now: time.Now, conn: NewMachine(), page: PageOverview,
		inflight: map[string]bool{}, pending: map[string]func(context.Context) (func(), error){}, errByKey: map[string]string{}}
	if a.post == nil {
		a.post = func(f func()) { f() }
	}
	a.ss.init()
	a.dg.init()
	a.rl.init()
	a.jd.init()
	a.rp.init()
	return a
}

// SetSync 打开同步模式：所有 async 在调用线程里完成（截图和测试用）。
func (a *App) SetSync(v bool) { a.sync = v }

// SetNow 替换时钟（截图要稳定的相对时间）。
func (a *App) SetNow(f func() time.Time) { a.now = f }

// Page 返回当前页。
func (a *App) Page() string { return a.page }

// Goto 切换页面并刷新它的数据。
func (a *App) Goto(page string) {
	a.page = page
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
	if ae, ok := err.(*api.Error); ok && ae.Kind == api.ErrUnreachable && a.ctx.Err() != nil {
		return
	}
	msg := err.Error()
	a.errByKey[key] = msg
	a.errLog = append(a.errLog, fmt.Sprintf("%s %s: %s", a.now().Format("15:04:05"), key, msg))
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
	case PageOverview:
		a.loadSessions()
		a.loadRuleStats()
		a.loadDanger()
	case PageSessions:
		a.loadSessions()
		a.loadTimeline()
	case PageDanger:
		a.loadDanger()
		a.loadSessions()
	case PageRules:
		a.loadRules()
	case PageJudge:
		a.loadJudge()
	case PageReplay:
		a.loadReplay()
	}
}

// resetIncremental 在流发出 reset 时丢弃增量状态并重新拉取。
func (a *App) resetIncremental() {
	a.ss.entries, a.ss.tlLoaded = nil, false
	a.sessLoad = false
}

// LoadAll 拉所有页面的数据（同步模式下截图用）。
func (a *App) LoadAll() {
	cur := a.page
	for _, p := range pageDefs {
		a.page = p.id
		a.refresh()
	}
	a.page = cur
}

func (a *App) sinceDay(n int) string {
	return fmt.Sprint(a.now().Add(-time.Duration(n) * 24 * time.Hour).UnixMilli())
}

func (a *App) loadTop() {
	a.async("status", func(ctx context.Context) (func(), error) {
		st, err := a.Client.Status(ctx)
		if err != nil {
			return nil, err
		}
		ds, derr := a.Client.DangerStats(ctx, url.Values{"since": {fmt.Sprint(TodayStartMs(a.now()))}})
		return func() {
			a.status = &st
			if derr == nil {
				a.today, a.hasToday = ds, true
			}
		}, nil
	})
}

func (a *App) loadSessions() {
	a.async("sessions", func(ctx context.Context) (func(), error) {
		ss, err := a.Client.Sessions(ctx, url.Values{"sort": {"recent"}, "kind": {"live"}})
		if err != nil {
			return nil, err
		}
		return func() {
			a.sessions, a.sessLoad = ss, true
			if a.ss.sel == "" && len(ss) > 0 {
				a.selectSession(a.defaultSession())
			}
		}, nil
	})
}

func (a *App) loadRuleStats() {
	a.async("rulestats", func(ctx context.Context) (func(), error) {
		rs, err := a.Client.RuleStats(ctx, url.Values{"kind": {"live"}, "since": {a.sinceDay(7)}})
		if err != nil {
			return nil, err
		}
		return func() { a.ruleStat = rs }, nil
	})
}

func (a *App) connSnapshot() Machine {
	a.connMu.Lock()
	defer a.connMu.Unlock()
	return *a.conn
}

// FmtClock 写 HH:MM:SS，零时间写「从未」。
func FmtClock(t time.Time) string {
	if t.IsZero() {
		return "从未"
	}
	return t.Local().Format("15:04:05")
}

// ui 包别名，避免页面文件里重复导入时的未使用告警。
var _ = ui.Center
