package app

import (
	"strings"
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

func TestStepIndex(t *testing.T) {
	cases := []struct{ cur, dir, n, want int }{
		{-1, 1, 5, 0}, {-1, -1, 5, 4}, {0, -1, 5, 0}, {4, 1, 5, 4}, {2, 1, 5, 3}, {2, -1, 5, 1}, {0, 1, 0, -1},
	}
	for _, c := range cases {
		if got := stepIndex(c.cur, c.dir, c.n); got != c.want {
			t.Errorf("stepIndex(%d,%d,%d)=%d want %d", c.cur, c.dir, c.n, got, c.want)
		}
	}
}

// 首次登记不算新；之后出现的才高亮；高亮期间请求帧，过期后停止请求（空闲 CPU≈0）。
func TestFreshHighlightLifecycle(t *testing.T) {
	a, ck, tt := newUX(t)
	a.fresh = map[string]time.Time{}
	a.seen = nil
	a.noteList("k", []string{"1", "2"})
	if len(a.fresh) != 0 {
		t.Fatalf("首次登记不应高亮：%v", a.fresh)
	}
	a.noteList("k", []string{"1", "2", "3"})
	if a.freshness("k", "3") != 1 || a.freshness("k", "1") != 0 {
		t.Fatalf("只有新到的 3 高亮：%v", a.fresh)
	}
	tt.Frame()
	if !tt.FramePending() {
		t.Fatal("高亮期间应请求动画帧")
	}
	ck.t = ck.t.Add(800 * time.Millisecond)
	if f := a.freshness("k", "3"); f <= 0 || f >= 1 {
		t.Fatalf("800ms 时应在淡出中：%v", f)
	}
	ck.t = ck.t.Add(2 * time.Second)
	tt.Advance(3 * time.Second)
	tt.Frame()
	if len(a.fresh) != 0 || tt.FramePending() {
		t.Fatalf("过期后应清理且不再请求帧：%v pending=%v", a.fresh, tt.FramePending())
	}
}

func TestDangerKeysPanelAndEsc(t *testing.T) {
	a, _, tt := newUX(t)
	a.Goto(PageDanger)
	tt.Frame()
	evs := a.dangerFiltered()
	if len(evs) < 3 {
		t.Fatalf("演示数据应有多条危险事件：%d", len(evs))
	}
	tt.TypeKey(0, ui.KeyJ, "j")
	tt.Frame()
	if a.dg.cur != evs[0].HitID {
		t.Fatalf("J 应落在第一条：cur=%d", a.dg.cur)
	}
	tt.TypeKey(0, ui.KeyJ, "j")
	tt.Frame()
	if a.dg.cur != evs[1].HitID {
		t.Fatalf("再按 J 到第二条：cur=%d", a.dg.cur)
	}
	tt.TypeKey(0, ui.KeyK, "k")
	tt.Frame()
	if a.dg.cur != evs[0].HitID {
		t.Fatalf("K 回到第一条：cur=%d", a.dg.cur)
	}
	if a.dg.sel != 0 {
		t.Fatal("还没按 Enter，面板不应打开")
	}
	tt.Key(0, ui.KeyEnter)
	tt.Frame()
	if a.dg.sel != evs[0].HitID {
		t.Fatalf("Enter 应打开面板：sel=%d", a.dg.sel)
	}
	tt.Advance(400 * time.Millisecond)
	tt.Frame()
	if !tt.HasText("决策（每条单独列出）") {
		t.Fatal("右侧面板应显示检视内容")
	}
	tt.TypeKey(0, ui.KeyJ, "j")
	tt.Frame()
	if a.dg.sel != evs[1].HitID {
		t.Fatalf("面板打开时 J 应带着面板切换：sel=%d", a.dg.sel)
	}
	tt.Key(0, ui.KeyEscape)
	tt.Frame()
	if a.dg.sel != 0 {
		t.Fatal("Esc 应关闭面板")
	}
}

// 搜索框里打字不能触发 J/K 导航。
func TestTypingInSearchDoesNotNavigate(t *testing.T) {
	a, _, tt := newUX(t)
	a.Goto(PageDanger)
	tt.Frame()
	if err := tt.Click("搜索危险事件"); err != nil {
		t.Fatal(err)
	}
	tt.Type("jk")
	tt.Frame()
	if a.dg.query != "jk" || a.dg.cur != 0 {
		t.Fatalf("输入应进搜索框而不是移动游标：query=%q cur=%d", a.dg.query, a.dg.cur)
	}
}

func TestSessionsKeys(t *testing.T) {
	a, _, tt := newUX(t)
	a.Goto(PageSessions)
	a.selectSession(fake.SessA)
	tt.Frame()
	before := a.ss.sel
	tt.TypeKey(0, ui.KeyJ, "j")
	tt.Frame()
	if a.ss.sel == before || a.ss.sel == "" {
		t.Fatalf("J 应切到下一个会话：%s → %s", before, a.ss.sel)
	}
	tt.TypeKey(ui.Shift, ui.KeyJ, "J")
	tt.Frame()
	if a.ss.hitCur == 0 {
		t.Skip("该会话没有命中")
	}
	tt.Key(0, ui.KeyEnter)
	tt.Frame()
	if a.ss.hitSel != a.ss.hitCur {
		t.Fatalf("Enter 应打开游标命中：sel=%d cur=%d", a.ss.hitSel, a.ss.hitCur)
	}
	tt.Key(0, ui.KeyEscape)
	tt.Frame()
	if a.ss.hitSel != 0 {
		t.Fatal("Esc 应关闭")
	}
}

func TestJudgeAndRulesKeys(t *testing.T) {
	a, _, tt := newUX(t)
	a.Goto(PageJudge)
	tt.Frame()
	first := a.jd.sel
	tt.TypeKey(0, ui.KeyJ, "j")
	tt.Frame()
	if a.jd.sel == first {
		t.Fatalf("J 应切到下一条裁决：%d", a.jd.sel)
	}
	tt.Key(0, ui.KeyEnter)
	tt.Frame()
	if !a.jd.open {
		t.Fatal("Enter 应打开裁决面板")
	}
	tt.Key(0, ui.KeyEscape)
	tt.Frame()
	if a.jd.open {
		t.Fatal("Esc 应关闭裁决面板")
	}
	a.Goto(PageRules)
	tt.Frame()
	r0 := a.rl.sel
	tt.TypeKey(0, ui.KeyJ, "j")
	tt.Frame()
	if a.rl.sel == r0 {
		t.Fatal("J 应切换规则")
	}
}

// 命令面板打开时，页面不响应 J/K。
func TestPalettePausesPageKeys(t *testing.T) {
	a, _, tt := newUX(t)
	a.Goto(PageDanger)
	tt.Frame()
	tt.Key(ui.Cmd, ui.KeyK)
	tt.Frame()
	tt.TypeKey(0, ui.KeyJ, "j")
	tt.Frame()
	if a.dg.cur != 0 {
		t.Fatalf("面板打开时页面游标不应动：%d", a.dg.cur)
	}
}

// 右键菜单只含只读动作。
func TestContextMenusReadOnly(t *testing.T) {
	a, _, tt := newUX(t)
	a.Goto(PageDanger)
	tt.Frame()
	tt.Advance(400 * time.Millisecond)
	tt.Frame()
	evs := a.dangerFiltered()
	if err := tt.RightClick(Str(evs[0].Subject)); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	items := tt.Menu()
	if len(items) == 0 {
		t.Fatal("右键应弹出菜单")
	}
	for _, it := range items {
		for _, bad := range []string{"删除", "停用", "启用", "修改", "保存", "放行", "拦截"} {
			if strings.Contains(it, bad) {
				t.Fatalf("右键菜单不应含写操作 %q：%v", bad, items)
			}
		}
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
