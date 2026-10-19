package app

import (
	"fmt"
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

// 规则页：阈值输入框有焦点时，J/K/↑/↓ 不能切换规则（否则未保存的草稿会丢）。
func TestRulesKeysDoNotEatThresholdDraft(t *testing.T) {
	a, _, tt := newUX(t)
	a.Goto(PageRules)
	a.rl.sel = "T1"
	tt.Frame()
	tt.Advance(300 * time.Millisecond)
	tt.Frame()
	r0, _ := tt.Find("阈值 ladder.H")
	tt.ClickAt(r0.X+30, r0.Y+r0.H/2)
	tt.Frame()
	tt.Type("7")
	tt.Frame()
	if a.rl.draft["ladder.H"] == nil {
		t.Fatal("草稿应存在")
	}
	for _, k := range []struct {
		key ui.Key
		s   string
	}{{ui.KeyJ, "j"}, {ui.KeyK, "k"}, {ui.KeyDown, ""}, {ui.KeyUp, ""}} {
		tt.TypeKey(0, k.key, k.s)
		tt.Frame()
		if a.rl.sel != "T1" {
			t.Fatalf("输入框有焦点时 %v 不应切换规则：sel=%s typing=%v next=%v focused=%v", k.key, a.rl.sel, a.typing, a.typingNext, tt.Focused("阈值 ladder.H"))
		}
	}
}

// 会话搜索框里打 j/k 不能换会话。
func TestSessionSearchTypingDoesNotSwitch(t *testing.T) {
	a, _, tt := newUX(t)
	a.Goto(PageSessions)
	a.selectSession(fake.SessA)
	tt.Frame()
	if err := tt.Click("搜索会话"); err != nil {
		t.Fatal(err)
	}
	tt.Type("jk")
	tt.Frame()
	if a.ss.sel != fake.SessA || a.ss.query != "jk" {
		t.Fatalf("输入应进搜索框：sel=%s query=%q", a.ss.sel, a.ss.query)
	}
}

// 系统「减弱动态效果」：高亮不淡出、不请求逐帧动画；面板不做位移。
func TestReduceMotion(t *testing.T) {
	a, _, tt := newUX(t)
	tt.SetPreferences(ui.Preferences{ReduceMotion: true})
	a.fresh = map[string]time.Time{}
	a.seen = nil
	a.noteList("k", []string{"1"})
	a.noteList("k", []string{"1", "2"})
	tt.Frame()
	if !a.reduce {
		t.Fatal("应读到 ReduceMotion")
	}
	if a.freshness("k", "2") != 1 {
		t.Fatalf("减弱动态效果时高亮固定强度：%v", a.freshness("k", "2"))
	}
	if m := a.panelMotion(); m.Enter == nil || m.Enter.X != 0 || m.Exit.X != 0 {
		t.Fatalf("面板不应位移：%+v", m)
	}
}

// 端到端：fake 推一条新的危险事件 → 刷新 → 危险页出现该行，并处于「新事件」高亮。
func TestLiveEventEndToEnd(t *testing.T) {
	a, srv := newDemoApp(t)
	a.Goto(PageDanger)
	a.LoadAll()
	tt := ui.NewTester(a.View, 1440, 900)
	tt.Frame()
	if tt.HasText("rm -rf /tmp/live-0") {
		t.Fatal("还没推送，不应出现")
	}
	srv.AddLive()
	a.refresh()
	tt.Frame()
	if !tt.HasText("rm -rf /tmp/live-0") {
		t.Fatal("新危险事件应出现在危险页")
	}
	var id int64
	for _, e := range a.dg.events {
		if Str(e.Subject) == "rm -rf /tmp/live-0" {
			id = e.HitID
		}
	}
	if id == 0 || a.freshness("danger", fmt.Sprint(id)) <= 0 {
		t.Fatalf("新事件应处于高亮：id=%d fresh=%v", id, a.fresh)
	}
	if !tt.FramePending() {
		t.Fatal("高亮期间应请求动画帧")
	}
	tt.Advance(3 * time.Second)
	a.SetNow(func() time.Time { return time.Now().Add(time.Hour) })
	tt.Frame()
	tt.Frame()
	tt.Advance(time.Second)
	tt.Frame()
	if tt.FramePending() {
		t.Fatal("高亮过期后不应再请求帧")
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
	if len(items) == 0 || !strings.Contains(strings.Join(items, " "), "复制会话 ID") {
		t.Fatalf("右键应弹出我们的只读菜单：%v", items)
	}
	for _, it := range items {
		for _, bad := range []string{"删除", "停用", "启用", "修改", "保存", "放行", "拦截"} {
			if strings.Contains(it, bad) {
				t.Fatalf("右键菜单不应含写操作 %q：%v", bad, items)
			}
		}
	}
}

// 交互截图（-shots=<目录>，前缀 ux-）：命令面板、右侧详情面板、悬停提示、右键菜单；浅/深各一张。
func TestShotUX(t *testing.T) {
	for _, dark := range []bool{false, true} {
		sfx := "-light"
		if dark {
			sfx = "-dark"
		}
		mk := func(page string) (*App, *clock, *ui.Tester) {
			a, ck, _ := newUX(t)
			a.Goto(page)
			tt := ui.NewTester(a.View, 1440, 900)
			tt.SetDark(dark)
			tt.Frame()
			tt.Advance(600 * time.Millisecond)
			tt.Frame()
			return a, ck, tt
		}
		// 1) 命令面板：输入 "t" 过滤出若干规则/页面
		a, ck, tt := mk(PageOverview)
		tt.Key(ui.Cmd, ui.KeyK)
		tt.Frame()
		tt.Type("t")
		ck.t = ck.t.Add(300 * time.Millisecond)
		tt.Advance(300 * time.Millisecond)
		tt.Frame()
		tt.Key(0, ui.KeyDown)
		tt.Advance(300 * time.Millisecond)
		tt.Frame()
		writePNG("ux-palette"+sfx, tt.Image())
		if !tt.HasText("规则") || len(a.pal.items) == 0 {
			t.Fatalf("面板截图状态不对：%+v", a.pal.items)
		}

		// 2) 右侧详情面板（危险页，J → Enter）
		a, _, tt = mk(PageDanger)
		tt.TypeKey(0, ui.KeyJ, "j")
		tt.Frame()
		tt.Key(0, ui.KeyEnter)
		tt.Frame()
		tt.Advance(500 * time.Millisecond)
		tt.Frame()
		writePNG("ux-panel"+sfx, tt.Image())
		if !tt.HasText("决策（每条单独列出）") {
			t.Fatal("面板内容缺失")
		}

		// 3) 悬停提示：停在导航「危险」上
		_, _, tt = mk(PageSessions)
		if r, ok := tt.Find("危险"); ok {
			tt.Move(r.X+r.W/2, r.Y+r.H/2)
		}
		tt.Frame()
		tt.Advance(1200 * time.Millisecond)
		tt.Frame()
		writePNG("ux-tooltip"+sfx, tt.Image())

		// 3b) 悬停提示：页头 ⌘K 按钮
		_, _, tt = mk(PageOverview)
		if r, ok := tt.Find("⌘K"); ok {
			tt.Move(r.X+r.W/2, r.Y+r.H/2)
		}
		tt.Frame()
		tt.Advance(1200 * time.Millisecond)
		tt.Frame()
		writePNG("ux-tooltip-k"+sfx, tt.Image())

		// 4) 右键菜单
		a, _, tt = mk(PageDanger)
		evs := a.dangerFiltered()
		if err := tt.RightClick(Str(evs[0].Subject)); err != nil {
			t.Fatal(err)
		}
		tt.Frame()
		tt.Advance(300 * time.Millisecond)
		tt.Frame()
		t.Logf("菜单项 %v", tt.Menu())
		writePNG("ux-context-menu"+sfx, tt.Image())
	}
}

// 性能检查：演示会话灌 5000 条调用（约 6000+ 行含命中），测稳态帧、滚动、切页的帧耗时。
// 阈值很宽松（防止 CI 机器抖动误报）；真实数字用 -v 看，记录在 docs/progress.md。
func TestPerfFlood5000(t *testing.T) {
	a, srv := newDemoApp(t)
	srv.Extra = 5000
	a.Goto(PageSessions)
	a.LoadAll()
	a.selectSession(fake.SessA)
	n := len(a.ss.entries)
	if n < 5000 {
		t.Fatalf("应加载到 ≥5000 条记录：%d", n)
	}
	tt := ui.NewTester(a.View, 1440, 900)
	timeIt := func(label string, f func()) time.Duration {
		start := time.Now()
		f()
		d := time.Since(start)
		t.Logf("%-22s %v", label, d)
		return d
	}
	timeIt("首帧(含建缓存)", func() { tt.Frame() })
	var worst time.Duration
	for i := 0; i < 20; i++ {
		d := timeIt("稳态帧", func() { tt.Frame() })
		if d > worst {
			worst = d
		}
	}
	if worst > 150*time.Millisecond {
		t.Errorf("稳态帧过慢：%v", worst)
	}
	var sw time.Duration
	vis0, _ := a.ss.tl.Visible()
	for i := 0; i < 20; i++ {
		d := timeIt("滚动一帧", func() { tt.Scroll(700, 500, 0, -400); tt.Frame() })
		if d > sw {
			sw = d
		}
	}
	if vis1, _ := a.ss.tl.Visible(); vis1 == vis0 {
		t.Errorf("滚动没有真的移动列表（可见首行仍是 %d），帧耗时数字无意义", vis0)
	} else {
		t.Logf("滚动前后可见首行 %d → %d（共 %d 行）", vis0, vis1, len(a.ss.rows))
	}
	if sw > 200*time.Millisecond {
		t.Errorf("滚动帧过慢：%v", sw)
	}
	for _, pg := range []string{PageDanger, PageOverview, PageSessions, PageRules, PageJudge, PageSessions} {
		d := timeIt("切到 "+pg, func() { a.Goto(pg); tt.Frame() })
		if d > 400*time.Millisecond {
			t.Errorf("切页过慢 %s：%v", pg, d)
		}
	}
	// 回到会话页后空闲：不应有待处理帧
	tt.Advance(3 * time.Second)
	tt.Frame()
	if tt.FramePending() {
		t.Error("灌 5000 条后空闲时仍在请求帧")
	}
	// 缓存：entries 不变时 derived 必须复用（同一指针/同一切片）
	c1 := a.derived()
	c2 := a.derived()
	if c1 != c2 || len(c1.rows) == 0 {
		t.Error("derived 缓存失效")
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
