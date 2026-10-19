package app

import (
	"testing"
	"time"

	"github.com/Fan-chou/agent-supervisor/ui/fake"
	"github.com/egoist/mygo/ui"
)

// 交互层测试：命令面板、键盘导航、新事件高亮、右侧面板。离屏 Tester，时钟手动推进。

type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

func newUX(t *testing.T) (*App, *clock, *ui.Tester) {
	t.Helper()
	a, _ := newDemoApp(t)
	ck := &clock{t: time.Now()}
	a.SetNow(ck.now)
	a.Goto(PageOverview)
	a.LoadAll()
	tt := ui.NewTester(a.View, 1440, 900)
	tt.Frame()
	return a, ck, tt
}

func TestFilterPalette(t *testing.T) {
	all := []palItem{
		{kind: "page", id: "danger", title: "危险", sub: "页面 ⌘3"},
		{kind: "rule", id: "X2", title: "X2 递归删除", sub: "规则 · danger"},
		{kind: "rule", id: "T1", title: "T1 无改动重跑", sub: "规则 · loop"},
		{kind: "session", id: "sess-abc", title: "sess-abc", sub: "会话 · proj claude sess-abc"},
	}
	if got := FilterPalette(all, "", 10); len(got) != 4 {
		t.Fatalf("空查询应返回全部：%d", len(got))
	}
	if got := FilterPalette(all, "x2", 10); len(got) != 1 || got[0].id != "X2" {
		t.Fatalf("x2：%+v", got)
	}
	if got := FilterPalette(all, "规则 递归", 10); len(got) != 1 {
		t.Fatalf("多词应全部命中：%+v", got)
	}
	if got := FilterPalette(all, "zzz", 10); len(got) != 0 {
		t.Fatalf("无匹配：%+v", got)
	}
	if got := FilterPalette(all, "", 2); len(got) != 2 {
		t.Fatalf("max：%d", len(got))
	}
}

func TestPaletteOpenSearchJump(t *testing.T) {
	a, ck, tt := newUX(t)
	tt.Key(ui.Cmd, ui.KeyK)
	tt.Frame()
	if !a.pal.open {
		t.Fatal("Cmd+K 应打开面板")
	}
	tt.Type("x2")
	tt.Frame()
	// 防抖：刚输入时不过滤
	if a.pal.applied == "x2" {
		t.Fatal("输入后应先等防抖")
	}
	ck.t = ck.t.Add(200 * time.Millisecond)
	tt.Advance(200 * time.Millisecond)
	tt.Frame()
	if a.pal.applied != "x2" || len(a.pal.items) == 0 || a.pal.items[0].id != "X2" {
		t.Fatalf("防抖后应过滤到 X2：%q %+v", a.pal.applied, a.pal.items)
	}
	tt.Key(0, ui.KeyEnter)
	tt.Frame()
	if a.page != PageRules || a.rl.sel != "X2" || a.pal.open {
		t.Fatalf("Enter 应跳到规则 X2：page=%s sel=%s open=%v", a.page, a.rl.sel, a.pal.open)
	}
}

func TestPaletteEscAndSessions(t *testing.T) {
	a, ck, tt := newUX(t)
	tt.Key(ui.Cmd, ui.KeyK)
	tt.Frame()
	tt.Key(0, ui.KeyEscape)
	tt.Frame()
	if a.pal.open {
		t.Fatal("Esc 应关闭面板")
	}
	tt.Key(ui.Cmd, ui.KeyK)
	tt.Frame()
	tt.Type(fake.SessD[:6])
	ck.t = ck.t.Add(200 * time.Millisecond)
	tt.Advance(200 * time.Millisecond)
	tt.Frame()
	found := false
	for _, it := range a.pal.items {
		if it.kind == "session" && it.id == fake.SessD {
			found = true
		}
	}
	if !found {
		t.Fatalf("应能按会话 ID 前缀搜到会话：%+v", a.pal.items)
	}
	tt.Key(0, ui.KeyEnter)
	tt.Frame()
	if a.page != PageSessions || a.ss.sel == "" {
		t.Fatalf("应跳到会话页：%s %s", a.page, a.ss.sel)
	}
}

func TestPaletteArrowKeys(t *testing.T) {
	a, _, tt := newUX(t)
	tt.Key(ui.Cmd, ui.KeyK)
	tt.Frame()
	tt.Key(0, ui.KeyDown)
	tt.Key(0, ui.KeyDown)
	tt.Frame()
	if a.pal.cur != 2 {
		t.Fatalf("Down 两次应选中第 3 项：cur=%d", a.pal.cur)
	}
	tt.Key(0, ui.KeyUp)
	tt.Frame()
	if a.pal.cur != 1 {
		t.Fatalf("Up 应回到第 2 项：cur=%d", a.pal.cur)
	}
	tt.Key(0, ui.KeyEnter)
	tt.Frame()
	if a.page != PageSessions {
		t.Fatalf("第 2 项是会话页：%s", a.page)
	}
}

// 空闲时不请求帧：没有新事件、没有打开面板，Tester 不应有待处理帧。
func TestIdleNoFrames(t *testing.T) {
	for _, pg := range []string{PageOverview, PageSessions, PageDanger, PageRules, PageJudge, PageReplay} {
		a, _, tt := newUX(t)
		a.Goto(pg)
		tt.Frame()
		tt.Advance(3 * time.Second)
		tt.Frame()
		if tt.FramePending() {
			t.Fatalf("%s 空闲时仍在请求帧（常驻动画）", pg)
		}
	}
}
