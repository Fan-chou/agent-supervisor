package app

import (
	"context"
	"fmt"
	"net/url"
	"sort"

	"github.com/Fan-chou/agent-supervisor/ui/api"
	"github.com/egoist/mygo/ui"
)

const (
	tlInitialLimit = 500  // 首次拉最近这么多条
	tlMaxEntries   = 2000 // 内存里最多保留（§3：>2000 提示更早的按需加载）
	tlRewind       = 40   // 实时刷新时往回多拿的 seq 数（pending 调用补全、命中补上）
)

type timelinePage struct {
	sess    string
	run     int64
	title   string // 回放来源标记
	entries []api.TimelineEntry
	hasMore bool // 服务端还有更早的条目
	loaded  bool
	hdr     *api.SessionSummary

	filter     TimelineFilter
	onlyDanger bool
	onlyHits   bool
	outcomeSel string
	ruleSel    string
	sevSel     string
	query      string
	follow     bool

	list    ui.ListState
	sel     int
	pick    string // 没有会话时的选择框
	sessSel int
	rows    []TLRow
	atEnd   bool
}

func (t *timelinePage) reset() {
	*t = timelinePage{follow: true, sel: -1, sessSel: -1, outcomeSel: "全部结局", ruleSel: "全部规则", sevSel: "全部级别"}
	t.list.FollowEnd = true
}

// resetIncremental 在流发出 reset 或守护进程重启时丢弃增量状态并重新拉取（§10.1/10.4）。
func (a *App) resetIncremental() {
	a.t.entries, a.t.loaded = nil, false
	a.s.loaded = false
}

func (a *App) loadTimeline(older bool) {
	t := &a.t
	if t.sess == "" {
		if !a.s.loaded {
			a.loadSessions()
		}
		return
	}
	id, run := t.sess, t.run
	var firstSeq, lastSeq int64
	if len(t.entries) > 0 {
		firstSeq, lastSeq = t.entries[0].Seq(), t.entries[len(t.entries)-1].Seq()
	}
	loaded := t.loaded
	a.async("timeline", func(ctx context.Context) (func(), error) {
		q := url.Values{}
		if run > 0 {
			q.Set("run", fmt.Sprint(run))
		}
		switch {
		case older && firstSeq > 0:
			q.Set("before_seq", fmt.Sprint(firstSeq))
			q.Set("limit", fmt.Sprint(tlInitialLimit))
		case loaded:
			since := lastSeq - tlRewind
			if since < 0 {
				since = 0
			}
			q.Set("since_seq", fmt.Sprint(since))
			q.Set("limit", "1000")
		default:
			q.Set("before_seq", "1000000000000") // 取最近的 N 条
			q.Set("limit", fmt.Sprint(tlInitialLimit))
		}
		tl, err := a.Client.Timeline(ctx, id, q)
		if err != nil {
			return nil, err
		}
		hdr, _ := a.session(ctx, id, run)
		return func() {
			if a.t.sess != id {
				return // 期间切了会话
			}
			switch {
			case older && firstSeq > 0:
				a.t.entries = MergeTimeline(a.t.entries, tl.Entries)
				a.t.hasMore = tl.HasMore
			case a.t.loaded:
				a.t.entries = MergeTimeline(a.t.entries, tl.Entries)
			default:
				a.t.entries, a.t.hasMore = tl.Entries, tl.HasMore
			}
			if n := len(a.t.entries); n > tlMaxEntries {
				a.t.entries = a.t.entries[n-tlMaxEntries:]
				a.t.hasMore = true
			}
			a.t.loaded = true
			if hdr != nil {
				a.t.hdr = hdr
			}
		}, nil
	})
}

func (a *App) session(ctx context.Context, id string, run int64) (*api.SessionSummary, error) {
	q := url.Values{}
	if run > 0 {
		q.Set("run", fmt.Sprint(run))
	}
	var s api.SessionSummary
	if err := a.Client.Get(ctx, "/v1/sessions/"+url.PathEscape(id), q, &s); err != nil {
		return nil, err
	}
	return &s, nil
}

func (a *App) timelineView(c *ui.Context) {
	p := palOf(c)
	t := &a.t
	if t.sess == "" {
		a.pickSession(c)
		return
	}
	live := t.run == 0
	ended := t.hdr != nil && t.hdr.State == "ended"
	// 头部
	ui.Row(c).FillWidth().Padding(10, 14).Gap(10).AlignItems(ui.Center).Children(func() {
		if ui.Button(c, "← 会话").Clicked() {
			a.Goto(PageSessions)
		}
		ui.Text(c, t.sess).Bold().FontSize(15).Selectable()
		if h := t.hdr; h != nil {
			ui.Text(c, ShortPath(Str(h.Project))+" · "+Or(Str(h.Model), "?")+" · "+Or(Str(h.Harness), "?")).FontSize(12).TextColor(p.Muted)
		}
		if !live {
			chip(c, "回放 · "+Or(t.title, fmt.Sprintf("run %d", t.run)), p.Warn, p.WarnBg)
		}
		if ended {
			chip(c, "会话已结束", p.Muted, p.Faint)
		}
		ui.Spacer(c)
		if live && !ended {
			ui.Checkbox(c, &t.follow, "实时跟随 ●")
			t.list.FollowEnd = t.follow
		} else {
			t.list.FollowEnd = false
		}
		if ui.Button(c, "回到底部").Clicked() {
			t.list.ScrollToEnd()
			t.follow = live && !ended
		}
	})
	// 筛选条
	ui.Row(c).FillWidth().Padding(0, 14, 6, 14).Gap(10).AlignItems(ui.Center).Children(func() {
		ui.Checkbox(c, &t.onlyDanger, "⚠ 仅危险")
		ui.Checkbox(c, &t.onlyHits, "只看有命中")
		ui.Select(c, &t.outcomeSel, []string{"全部结局", "◌ 本应拦截", "■ 已拦截"}).Width(130).Label("结局")
		ui.Select(c, &t.ruleSel, a.ruleOptions()).Width(120).Label("规则")
		ui.Select(c, &t.sevSel, []string{"全部级别", "L 及以上", "M 及以上", "H"}).Width(110).Label("级别")
		ui.SearchField(c, &t.query).Width(220).Label("搜索时间线")
	})
	t.filter = TimelineFilter{OnlyDanger: t.onlyDanger, OnlyHits: t.onlyHits, Query: t.query}
	switch t.outcomeSel {
	case "◌ 本应拦截":
		t.filter.Outcome = "would"
	case "■ 已拦截":
		t.filter.Outcome = "enforced"
	}
	if t.ruleSel != "全部规则" && t.ruleSel != "" {
		t.filter.Rule = t.ruleSel
	}
	switch t.sevSel {
	case "L 及以上":
		t.filter.MinSev = "L"
	case "M 及以上":
		t.filter.MinSev = "M"
	case "H":
		t.filter.MinSev = "H"
	}
	// 合计条
	st := StatsOfTimeline(t.entries)
	ui.Row(c).FillWidth().Padding(0, 14, 6, 14).Gap(10).AlignItems(ui.Center).Children(func() {
		ui.Textf(c, "调用 %d · 命中 ▲H%d ●M%d ·L%d", st.Calls, st.H, st.M, st.L).FontSize(13)
		if st.Danger > 0 {
			ui.Text(c, "·").TextColor(p.Muted)
			dangerCount(c, int64(st.Danger), int64(st.Would), int64(st.Enforced))
			ui.Text(c, "（◌ = shadow 下没有真的拦；■ = 真的拦了）").FontSize(11).TextColor(p.Muted)
		}
		if t.hasMore {
			if ui.Button(c, "加载更早的事件").Clicked() {
				a.loadTimeline(true)
			}
		}
	})
	if e := a.errOf("timeline"); e != "" {
		a.errBar(c, "加载失败："+e, func() { a.loadTimeline(false) })
	}
	if !t.loaded {
		a.emptyNote(c, "正在加载时间线…")
		return
	}
	if len(t.entries) == 0 {
		a.emptyNote(c, "会话已连接，还没有工具调用")
		return
	}
	t.rows = BuildRows(t.entries, t.filter)
	if len(t.rows) == 0 {
		ui.Column(c).Grow(1).Center().Gap(8).Children(func() {
			ui.Text(c, "没有符合条件的事件").TextColor(p.Muted)
			if ui.Button(c, "清除筛选").Clicked() {
				t.onlyDanger, t.onlyHits, t.query = false, false, ""
				t.outcomeSel, t.ruleSel, t.sevSel = "全部结局", "全部规则", "全部级别"
			}
		})
		return
	}
	a.miniBar(c)
	ui.Row(c).Grow(1).MinHeight(0).Padding(0, 14, 10, 14).Gap(12).AlignItems(ui.Stretch).Children(func() {
		a.timelineList(c)
		if t.sel >= 0 && t.sel < len(t.rows) {
			a.timelineDetail(c, t.rows[t.sel])
		}
	})
	a.explainModal(c)
}

func (a *App) ruleOptions() []string {
	seen := map[string]bool{}
	for _, e := range a.t.entries {
		if e.Hit != nil {
			seen[e.Hit.RuleID] = true
		}
	}
	out := []string{"全部规则"}
	var ids []string
	for id := range seen {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return append(out, ids...)
}

func (a *App) pickSession(c *ui.Context) {
	p := palOf(c)
	if !a.s.loaded {
		a.emptyNote(c, "正在加载会话…")
		return
	}
	ui.Column(c).Grow(1).Center().Gap(10).Children(func() {
		ui.Text(c, "选择一个会话查看事件时间线").Bold().FontSize(16)
		ui.Text(c, "也可以在「实时会话」里双击一行。").TextColor(p.Muted)
		ids := make([]string, 0, len(a.s.all))
		for _, s := range a.s.all {
			ids = append(ids, s.SessionID)
		}
		if len(ids) == 0 {
			ui.Text(c, "还没有会话").TextColor(p.Muted)
			return
		}
		pick := a.t.pick
		ui.Select(c, &pick, ids).Width(260).Label("会话")
		if pick != a.t.pick && pick != "" {
			a.t.pick = pick
			a.openSession(pick, 0, "")
		}
	})
}

// miniBar 是整场会话的命中分布（横轴调用序号，竖线颜色/高度表示级别，危险最高最红）；点击跳转。
func (a *App) miniBar(c *ui.Context) {
	p := palOf(c)
	t := &a.t
	rows := t.rows
	n := len(rows)
	if n == 0 {
		return
	}
	bar := ui.Box(c).FillWidth().Height(30).Radius(4).Background(p.Faint).Margin(0, 14, 8, 14).Label("命中分布").Draw(func(pt *ui.Painter, r ui.Rect) {
		for i, row := range rows {
			if !row.Hit {
				continue
			}
			h := row.Entry.Hit
			x := r.X + 2 + (r.W-4)*float32(i)/float32(n)
			height, col := float32(10), p.sevColor(h.Sev)
			switch {
			case h.Dangerous:
				height, col = r.H-4, p.Danger
			case h.Sev == "H":
				height = 18
			case h.Sev == "M":
				height = 14
			}
			if h.Dangerous && ClassifyOutcome(Str(h.Outcome)) == OutcomeWould {
				pt.StrokeDashed(ui.Rect{X: x - 1, Y: r.Y + r.H - height - 2, W: 3, H: height}, col, 0, 1)
			} else {
				pt.Fill(ui.Rect{X: x - 1, Y: r.Y + r.H - height - 2, W: 3, H: height}, col, 1)
			}
		}
	})
	if bar.Clicked() {
		if x, _, ok := bar.PointerPosition(); ok {
			w := bar.Bounds().W
			if w > 0 {
				i := int(x / w * float32(n))
				if i < 0 {
					i = 0
				}
				if i >= n {
					i = n - 1
				}
				t.sel = i
				t.list.ScrollTo(i, ui.Center)
				t.follow = false
			}
		}
	}
}

func callGlyph(status string) (string, bool) {
	switch status {
	case "ok":
		return "✓", false
	case "fail":
		return "✗", true
	case "pending":
		return "…", false
	}
	return "?", false
}

func (a *App) timelineList(c *ui.Context) {
	p := palOf(c)
	t := &a.t
	rows := t.rows
	var t0 int64
	if len(t.entries) > 0 {
		t0 = t.entries[0].Ts()
	}
	t.list.Selected = &t.sel
	t.list.Key = func(i int) any {
		e := rows[i].Entry
		if e.Hit != nil {
			return fmt.Sprintf("h%d", e.Hit.HitID)
		}
		return fmt.Sprintf("e%d%s", e.Seq(), e.Type)
	}
	t.list.Label = func(i int) string { return rowLabel(rows[i]) }
	list := ui.List(c, &t.list, len(rows), func(i int) {
		row := rows[i]
		e := row.Entry
		rel := fmt.Sprintf("+%02d:%02d", (e.Ts()-t0)/60000, (e.Ts()-t0)/1000%60)
		switch {
		case e.Hit != nil:
			h := e.Hit
			r := ui.Row(c).FillWidth().Gap(8).AlignItems(ui.Center).Padding(3, 8, 3, 36)
			if h.Dangerous {
				r.Background(p.DangerBg)
			}
			r.Children(func() {
				ui.Text(c, "▸").TextColor(p.Muted)
				ui.Text(c, h.RuleID).Bold().FontSize(13)
				sevMark(c, h.Sev)
				if h.Dangerous {
					dangerBadge(c, Str(h.DangerCategory))
				}
				ui.Text(c, hitLine(h)).FontSize(12).TextColor(p.Muted).SingleLine().Grow(1)
				if o := Str(h.Outcome); o != "" {
					mode := ""
					if len(h.Decisions) > 0 {
						mode = Str(h.Decisions[0].Mode)
					}
					outcomeBadge(c, o, mode)
				}
			})
		case e.Call != nil:
			call := e.Call
			danger := callHasDanger(t.entries, call.Seq)
			r := ui.Row(c).FillWidth().Gap(8).AlignItems(ui.Center).Padding(4, 8)
			if danger {
				r.BorderWidth(0, 0, 0, 4).BorderColor(p.Danger).Background(p.DangerBg)
			}
			r.Children(func() {
				ui.Text(c, rel).FontSize(12).TextColor(p.Muted).Font("monospace").Width(52).SingleLine()
				ui.Text(c, fmt.Sprintf("#%d", call.Seq)).FontSize(12).TextColor(p.Muted).Font("monospace").Width(40).SingleLine()
				chip(c, Or(Str(call.Kind), Str(call.Tool)), p.Muted, p.Faint)
				ui.Text(c, Str(call.NormCmd)).Font("monospace").FontSize(13).SingleLine().Grow(1)
				g, bad := callGlyph(call.Status)
				col := p.Ok
				if bad {
					col = p.Danger
				} else if call.Status != "ok" {
					col = p.Muted
				}
				ui.Text(c, g).Bold().TextColor(col)
			})
		default:
			ui.Row(c).FillWidth().Gap(8).AlignItems(ui.Center).Padding(4, 8).Children(func() {
				ui.Text(c, rel).FontSize(12).TextColor(p.Muted).Font("monospace").Width(52).SingleLine()
				chip(c, e.Event.Phase+" · "+Or(Str(e.Event.Origin), "–"), p.Muted, p.Faint)
			})
		}
	}).Grow(1).MinWidth(0).Label("事件时间线")
	_ = list
	t.atEnd = t.list.AtEnd()
	if !t.atEnd && t.follow && t.list.FollowEnd {
		t.follow = false // 用户向上滚动：暂停跟随（§3）
	}
}

func rowLabel(r TLRow) string {
	e := r.Entry
	switch {
	case e.Hit != nil:
		return "命中 " + e.Hit.RuleID
	case e.Call != nil:
		return Str(e.Call.NormCmd)
	}
	return e.Event.Phase
}

func hitLine(h *api.TimelineHit) string {
	if h.Dangerous {
		return Str(h.DangerSubject) + " — " + Str(h.DangerReason)
	}
	return Str(h.Message)
}

func callHasDanger(es []api.TimelineEntry, seq int64) bool {
	for _, e := range es {
		if e.Hit != nil && e.Hit.Seq == seq && e.Hit.Dangerous {
			return true
		}
	}
	return false
}

func (a *App) timelineDetail(c *ui.Context, row TLRow) {
	p := palOf(c)
	t := &a.t
	e := row.Entry
	ui.Scroll(c).Width(420).Shrink(0).Children(func() {
		ui.Column(c).FillWidth().Gap(10).Children(func() {
			switch {
			case e.Hit != nil:
				a.hitDetail(c, e.Hit)
			case e.Call != nil:
				call := e.Call
				section(c, fmt.Sprintf("#%d %s", call.Seq, Or(Str(call.Kind), Str(call.Tool))), func() {
					ui.Text(c, "命令/文件（脱敏）").FontSize(12).TextColor(p.Muted)
					mono(c, Str(call.NormCmd))
					kv(c, "工具", Str(call.Tool))
					kv(c, "类别", Str(call.CmdClass))
					kv(c, "mutating", map[bool]string{true: "是", false: "否"}[call.Mutating != nil && *call.Mutating])
					kv(c, "状态", call.Status)
					if call.ExitCode != nil {
						kv(c, "退出码", fmt.Sprint(*call.ExitCode))
					}
					kv(c, "错误指纹", Str(call.ErrFp))
					kv(c, "模型", Str(call.Model)+"（只展示）")
					kv(c, "时间", FmtTime(call.Ts))
					ui.Text(c, "输出头/尾不在 API 里（只有脱敏后的统计字段）。").FontSize(11).TextColor(p.Muted)
				})
				var hs []*api.TimelineHit
				for _, x := range t.entries {
					if x.Hit != nil && x.Hit.Seq == call.Seq {
						hs = append(hs, x.Hit)
					}
				}
				if len(hs) > 0 {
					section(c, "本调用上的命中", func() {
						for _, h := range hs {
							ui.Row(c).FillWidth().Gap(6).AlignItems(ui.Center).Children(func() {
								ui.Text(c, h.RuleID).Bold()
								sevMark(c, h.Sev)
								if h.Dangerous {
									dangerBadge(c, Str(h.DangerCategory))
								}
								if o := Str(h.Outcome); o != "" {
									outcomeBadge(c, o, "")
								}
							})
						}
					})
				}
			default:
				section(c, "事件 "+e.Event.Phase, func() {
					kv(c, "序号", fmt.Sprint(e.Event.Seq))
					kv(c, "来源", Str(e.Event.Origin))
					kv(c, "时间", FmtTime(e.Event.Ts))
				})
			}
		})
	})
}

func (a *App) hitDetail(c *ui.Context, h *api.TimelineHit) {
	p := palOf(c)
	section(c, fmt.Sprintf("命中 #%d · %s", h.HitID, h.RuleID), func() {
		ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
			sevMark(c, h.Sev)
			if h.Dangerous {
				dangerBadge(c, Str(h.DangerCategory))
			}
		})
		kv(c, "阶段", Str(h.Phase))
		kv(c, "调用序号", fmt.Sprint(I64(h.CallIndex)))
		kv(c, "消息", Str(h.Message))
		if h.Dangerous {
			kv(c, "对象", Str(h.DangerSubject))
			kv(c, "原因", Str(h.DangerReason))
		}
	})
	section(c, "处置", func() {
		if len(h.Decisions) == 0 {
			ui.Text(c, "没有面向 agent 的动作").FontSize(12).TextColor(p.Muted)
		}
		for _, d := range h.Decisions {
			ui.Column(c).FillWidth().Gap(4).Children(func() {
				ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
					ui.Text(c, d.Action).Bold()
					if d.Outcome != nil {
						outcomeBadge(c, *d.Outcome, Str(d.Mode))
					}
				})
				kv(c, "mode / 生效", fmt.Sprintf("%s / %s", Or(Str(d.Mode), "–"), map[bool]string{true: "已生效", false: "未生效"}[d.Applied]))
				if d.SuppressedBy != nil {
					kv(c, "被抑制", *d.SuppressedBy)
				}
				if d.WouldBlockIfVerified {
					kv(c, "回放标注", "wouldBlockIfVerified（指纹核实后会拦）")
				}
				if d.AtNextPre {
					kv(c, "回放标注", "atNextPre")
				}
			})
		}
	})
	if ui.PrimaryButton(c, "打开命中详情").Clicked() {
		a.openExplain(h.HitID)
	}
}
