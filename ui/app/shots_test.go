package app

import (
	"context"
	"flag"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Fan-chou/agent-supervisor/ui/api"
	"github.com/Fan-chou/agent-supervisor/ui/fake"
	"github.com/egoist/mygo/ui"
)

// 截图测试：把真实客户端指向进程内假守护进程（合成数据），用 Tester 离屏渲染。
// 加 -shots=<目录> 时写出 PNG：ln-<页>-light / -dark，关键页再加 -gray（由亮度转换，用来验证三态在灰度下仍可分）。
// 不设则只做断言。不发任何网络请求（只连本机 httptest）。

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

func writePNG(name string, img image.Image) {
	dir := *shotsDir
	if dir == "" {
		return
	}
	_ = os.MkdirAll(dir, 0o755)
	if f, err := os.Create(filepath.Join(dir, name+".png")); err == nil {
		_ = png.Encode(f, img)
		f.Close()
	}
}

func gray(src image.Image) image.Image {
	b := src.Bounds()
	g := image.NewGray(b)
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			g.Set(x, y, color.GrayModel.Convert(src.At(x, y)))
		}
	}
	return g
}

// shoot 渲染 浅色 + 深色（withGray 时再加一张灰度），返回深色 Tester 供断言。
func shoot(t *testing.T, a *App, name string, withGray bool, must ...string) {
	t.Helper()
	shootSize(t, a, name, 1440, 900, withGray, must...)
}

func shootSize(t *testing.T, a *App, name string, w, h int, withGray bool, must ...string) {
	t.Helper()
	for _, dark := range []bool{false, true} {
		tt := ui.NewTester(a.View, w, h)
		tt.SetDark(dark)
		tt.Frame()
		tt.Advance(800 * time.Millisecond) // 让进入动画走完再截图
		tt.Frame()
		suffix := "-light"
		if dark {
			suffix = "-dark"
		}
		writePNG("ln-"+name+suffix, tt.Image())
		if withGray && !dark {
			writePNG("ln-"+name+"-gray", gray(tt.Image()))
		}
		for _, m := range must {
			if !tt.HasText(m) {
				t.Fatalf("%s%s 缺少文字 %q；现有：%q", name, suffix, m, tt.Texts())
			}
		}
	}
}

func TestShotOverview(t *testing.T) {
	a, _ := newDemoApp(t)
	a.Goto(PageOverview)
	shoot(t, a, "overview", true, "总览", "危险操作", "已拦截", "进行中的会话")
}

// 总览下半部分（图表、环形图、健康卡）与最小窗口 960×600 的布局。
func TestShotOverviewTallAndMin(t *testing.T) {
	a, _ := newDemoApp(t)
	a.Goto(PageOverview)
	shootSize(t, a, "overview-tall", 1440, 1300, false, "规则命中 · 近 7 天", "Judge 与系统")
	shootSize(t, a, "overview-min", 960, 600, false, "总览")
	a.Goto(PageSessions)
	shootSize(t, a, "sessions-min", 960, 600, false, "会话")
}

func TestShotSessions(t *testing.T) {
	a, _ := newDemoApp(t)
	a.Goto(PageSessions)
	a.selectSession(fake.SessA)
	a.ss.hitSel = 0
	shoot(t, a, "sessions", true, "会话", fake.SessA)
	var hid int64
	for _, e := range a.ss.entries {
		if e.Hit != nil && e.Hit.Dangerous {
			hid = e.Hit.HitID
		}
	}
	a.ss.hitSel = hid
	a.loadExplain(hid)
	shoot(t, a, "sessions-inspector", false, fmt.Sprintf("命中检视 #%d", hid), "决策（每条单独列出）")
}

// 模拟 macOS 隐藏标题栏（红绿灯占左上角）：导航轨内容要在红绿灯下面。
func TestShotTitleBar(t *testing.T) {
	a, _ := newDemoApp(t)
	a.Goto(PageOverview)
	tt := ui.NewTester(a.View, 1440, 900)
	tt.SetTitleBar(ui.TitleBar{Height: 28, Left: 78})
	tt.Frame()
	tt.Advance(800 * time.Millisecond)
	tt.Frame()
	writePNG("ln-titlebar-light", tt.Image())
}

func TestShotRules(t *testing.T) {
	a, srv := newDemoApp(t)
	a.Goto(PageRules)
	a.rl.sel = "T1"
	shoot(t, a, "rules", false, "规则", "保存阈值", "命中统计")
	a.rl.sel = "X2"
	shoot(t, a, "rules-x2", true, "不可停用", "安全底线规则")
	// 停用一条规则：只发 disabled
	a.rl.sel = "L1"
	off := true
	a.putRule("L1", api.RuleEdit{Disabled: &off}, "L1 已停用")
	if len(srv.Puts) != 1 || a.rl.err != "" {
		t.Fatalf("puts=%v err=%q", srv.Puts, a.rl.err)
	}
	// X2 的 PUT 由服务端拒绝，界面原样显示
	a.putRule("X2", api.RuleEdit{Disabled: &off}, "x")
	if a.rl.err == "" {
		t.Fatal("X2 停用应被服务端拒绝并显示错误")
	}
}

// 未保存的阈值输入不能被后台刷新冲掉；保存成功后才以服务端值重建草稿。
func TestRuleDraftSurvivesRefresh(t *testing.T) {
	a, srv := newDemoApp(t)
	a.Goto(PageRules)
	a.rl.sel = "T1"
	r := a.selectedRule()
	a.ensureDraft(r)
	*a.rl.draft["ladder.H"] = 5
	a.refresh()
	a.refresh()
	r = a.selectedRule()
	a.ensureDraft(r)
	if got := *a.rl.draft["ladder.H"]; got != 5 {
		t.Fatalf("后台刷新冲掉了未保存的输入：%v", got)
	}
	// 保存：只发改过的键
	a.putRule("T1", api.RuleEdit{Thresholds: BuildThresholdBody(map[string]float64{"ladder.H": 5})}, "ok")
	if len(srv.Puts) != 1 || a.rl.err != "" {
		t.Fatalf("puts=%v err=%q", srv.Puts, a.rl.err)
	}
	r = a.selectedRule()
	a.ensureDraft(r)
	if got := a.rl.orig["ladder.H"]; got != 5 {
		t.Fatalf("保存后草稿应按服务端新值重建，orig=%v", got)
	}
}

func TestShotJudge(t *testing.T) {
	a, _ := newDemoApp(t)
	a.Goto(PageJudge)
	a.selectJudge(5)
	shoot(t, a, "judge", true, "裁决记录", "judge 调用 #5")
	a.jd.tab = 1
	shoot(t, a, "judge-routes", false, "路由与健康", "supervisor-judge")
}

func TestShotReplay(t *testing.T) {
	a, _ := newDemoApp(t)
	a.Goto(PageReplay)
	shoot(t, a, "replay", false, "对比", "评测报告")
}

func TestShotDanger(t *testing.T) {
	a, _ := newDemoApp(t)
	a.Goto(PageDanger)
	shoot(t, a, "danger", true, "危险")
	a.selectSession(fake.SessD)
	a.Goto(PageSessions)
	shoot(t, a, "sessions-enforced", true, "已拦截")
}
