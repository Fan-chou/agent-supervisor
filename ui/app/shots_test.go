package app

import (
	"context"
	"flag"
	"image/png"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Fan-chou/agent-supervisor/ui/api"
	"github.com/Fan-chou/agent-supervisor/ui/fake"
	"github.com/egoist/mygo/ui"
)

// 截图测试：把真实客户端指向进程内假守护进程（合成数据），加载后用 Tester 离屏渲染。
// 加 -shots=<目录> 时把每页的 PNG 写出来（浅色 + 深色）；不设则只做断言。不发任何网络请求（只连本机 httptest）。

var shotsDir = flag.String("shots", "", "写出截图 PNG 的目录")

func newDemoApp(t *testing.T) (*App, *fake.Server) {
	t.Helper()
	srv := fake.New()
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	a := New(ctx, api.NewHTTP(srv.URL, ""), nil)
	a.SetSync(true)
	a.Demo = true
	base := time.Now()
	a.SetNow(func() time.Time { return base })
	srv.Now = a.now
	a.connOK(true)
	return a, srv
}

func shoot(t *testing.T, a *App, name string, dark bool, w, h int) *ui.Tester {
	t.Helper()
	tt := ui.NewTester(a.View, w, h)
	tt.SetDark(dark)
	tt.Frame()
	if dir := *shotsDir; dir != "" {
		_ = os.MkdirAll(dir, 0o755)
		suffix := ""
		if dark {
			suffix = "-dark"
		}
		f, err := os.Create(filepath.Join(dir, name+suffix+".png"))
		if err == nil {
			_ = png.Encode(f, tt.Image())
			f.Close()
		}
	}
	return tt
}

func both(t *testing.T, a *App, name string, must ...string) {
	t.Helper()
	for _, dark := range []bool{false, true} {
		tt := shoot(t, a, name, dark, 1360, 860)
		for _, m := range must {
			if !tt.HasText(m) {
				t.Fatalf("%s 缺少文字 %q；现有：%q", name, m, tt.Texts())
			}
		}
	}
}

func TestScreenshotSessions(t *testing.T) {
	a, _ := newDemoApp(t)
	a.refresh()
	// 选中一个有危险的会话，右侧出现摘要
	a.s.sel, a.s.selID = 3, fake.SessA
	a.loadSessionDetail()
	both(t, a, "sessions", "实时会话", fake.SessA, "会话摘要")
}

func TestScreenshotTimeline(t *testing.T) {
	a, _ := newDemoApp(t)
	a.openSession(fake.SessA, 0, "")
	both(t, a, "timeline", "git reset --hard HEAD~1", "⚠ 危险·git", "◌ 本应拦截（shadow，未生效）")
	// 已拦截（enforce）的会话：■ 已拦截
	a.openSession(fake.SessD, 0, "")
	both(t, a, "timeline-enforced", "■ 已拦截")
}

func TestScreenshotStats(t *testing.T) {
	a, _ := newDemoApp(t)
	a.Goto(PageStats)
	a.k.sel, a.k.selRule = 1, "T1"
	a.loadStats()
	both(t, a, "stats-rules", "规则统计页签", "T1")
	a.k.tab = tabDanger
	a.loadStats()
	both(t, a, "stats-danger", "本应拦截 4（未生效）")
	a.k.dangerSel = 0
	a.openExplain(a.k.events[0].HitID)
	both(t, a, "stats-explain", "命中 #")
}

func TestScreenshotJudge(t *testing.T) {
	a, _ := newDemoApp(t)
	a.Goto(PageJudge)
	a.j.sel, a.j.selID = 0, a.j.calls[0].ID
	a.loadJudgeDetail()
	both(t, a, "judge", "judge 调用 #5")
	a.Goto(PageRouting)
	a.j.routeSel = 1
	both(t, a, "routing", "judge 路由表", "supervisor-judge")
}

func TestScreenshotRulesAndReplay(t *testing.T) {
	a, _ := newDemoApp(t)
	a.Goto(PageRules)
	a.r.sel = 2
	both(t, a, "rules", "T1", "保存阈值")
	a.r.sel = 6
	both(t, a, "rules-x2", "受保护")
	a.Goto(PageReplay)
	a.p.chosen.Add(2)
	a.p.chosen.Add(3)
	a.loadCompare()
	a.p.sel, a.p.selID = 1, 3
	a.loadRunDetail()
	both(t, a, "replay", "运行列表", "对比 run 2 → run 3")
	a.p.tab = 1
	both(t, a, "replay-eval", "n/a 不是通过")
}
