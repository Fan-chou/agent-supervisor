package app

import (
	"context"
	"fmt"
	"net/url"

	"github.com/Fan-chou/agent-supervisor/ui/api"
	"github.com/egoist/mygo/ui"
)

type sessionsPage struct {
	all       []api.SessionSummary
	loaded    bool
	filter    SessionFilter
	stateIdx  int // 0 未结束 1 活跃 2 闲置 3 已结束 4 全部
	harness   string
	query     string
	list      ui.ListState
	sel       int
	selID     string
	collapsed map[string]bool
	children  map[string][]api.ChildSession
	recent    map[string][]api.Hit
	// run > 0 时看某次回放运行的会话（只读回放视图），0 = 实时
	run   int64
	runTi string
}

var stateKeys = []string{"!ended", "active", "idle", "ended", ""}

func (a *App) initPages() {
	a.s = sessionsPage{sel: -1, collapsed: map[string]bool{}, children: map[string][]api.ChildSession{}, recent: map[string][]api.Hit{}, harness: "全部 harness"}
	a.t.reset()
	a.j = judgePage{sel: -1, verdict: "全部裁决", status: "全部状态", syncSel: "同步/异步", routeSel: -1}
	a.r = rulesPage{sel: -1}
	a.k = statsPage{sel: -1, hitSel: -1, dangerSel: -1, revSel: -1, source: "live", rangeSel: rangeOpts[0]}
	a.p = replayPage{sel: -1}
}

func (a *App) loadSessions() {
	run := a.s.run
	a.async("sessions", func(ctx context.Context) (func(), error) {
		q := url.Values{"sort": {"recent"}}
		if run > 0 {
			q.Set("run", fmt.Sprint(run))
		} else {
			q.Set("kind", "live")
		}
		ss, err := a.Client.Sessions(ctx, q)
		if err != nil {
			return nil, err
		}
		return func() { a.s.all, a.s.loaded = ss, true; a.loadSessionDetail() }, nil
	})
}

// loadSessionDetail 为选中的会话拉子 agent 和最近命中（右侧摘要）。
func (a *App) loadSessionDetail() {
	id := a.s.selID
	if id == "" {
		return
	}
	run := a.s.run
	a.async("sess-detail", func(ctx context.Context) (func(), error) {
		kids, err := a.Client.Children(ctx, id)
		if err != nil {
			return nil, err
		}
		q := url.Values{"session": {id}, "limit": {"5"}}
		if run > 0 {
			q.Set("run", fmt.Sprint(run))
		}
		hl, herr := a.Client.Hits(ctx, q)
		return func() {
			a.s.children[id] = kids
			if herr == nil {
				a.s.recent[id] = hl.Hits
			}
		}, nil
	})
}

// openSession 在事件时间线里打开会话（run>0 为回放视图）。
func (a *App) openSession(id string, run int64, title string) {
	a.t.reset()
	a.t.sess, a.t.run, a.t.title = id, run, title
	a.Goto(PageTimeline)
}

func (a *App) sessionsView(c *ui.Context) {
	p := palOf(c)
	s := &a.s
	if s.run > 0 {
		ui.Row(c).FillWidth().Padding(6, 14).Gap(10).AlignItems(ui.Center).Background(p.WarnBg).Children(func() {
			ui.Text(c, "回放 · "+s.runTi).Bold().FontSize(13).TextColor(p.Warn)
			ui.Text(c, "只读回放视图：没有实时跟随").FontSize(12).TextColor(p.Muted)
			ui.Spacer(c)
			if ui.Button(c, "← 回到回放结果").Clicked() {
				s.run = 0
				a.Goto(PageReplay)
			}
		})
	}
	// 筛选条
	ui.Row(c).FillWidth().Padding(10, 14).Gap(10).AlignItems(ui.Center).Children(func() {
		ui.Text(c, "状态").FontSize(12).TextColor(p.Muted)
		ui.Segmented(c, &s.stateIdx, "未结束", "活跃", "闲置", "已结束", "全部").Label("会话状态")
		harnesses := []string{"全部 harness", "claude", "codex", "opencode"}
		ui.Select(c, &s.harness, harnesses).Width(130).Label("harness")
		ui.Checkbox(c, &s.filter.OnlyDanger, "仅有危险")
		ui.Checkbox(c, &s.filter.SortDanger, "危险项目在前")
		ui.SearchField(c, &s.query).Placeholder("搜索 会话 / 目录 / 模型").Width(220).Label("搜索会话")
	})
	s.filter.State = stateKeys[s.stateIdx]
	s.filter.Query = s.query
	s.filter.Harness = ""
	if s.harness != "" && s.harness != "全部 harness" {
		s.filter.Harness = s.harness
	}
	groups := GroupSessions(s.all, s.filter)
	tot := TotalsOf(groups)
	ended := 0
	for _, x := range s.all {
		if x.State == "ended" {
			ended++
		}
	}
	// 合计条
	ui.Row(c).FillWidth().Padding(4, 14).Gap(10).AlignItems(ui.Center).Children(func() {
		ui.Textf(c, "项目 %d · 会话 %d（活跃 %d）· 调用 %s · 命中 ", tot.Projects, tot.Sessions, tot.Active, Compact(float64(tot.Calls))).FontSize(13)
		ui.Textf(c, "▲H %d  ●M %d  ·L %d", tot.H, tot.M, tot.L).FontSize(13)
		if tot.Danger.Total > 0 {
			ui.Text(c, "·").TextColor(p.Muted)
			dangerCount(c, tot.Danger.Total, tot.Danger.WouldHaveBlocked, tot.Danger.Enforced)
		}
		if s.stateIdx == 0 && ended > 0 {
			ui.Text(c, fmt.Sprintf("另有 %d 个已结束会话", ended)).FontSize(12).TextColor(p.Muted)
		}
	})
	if e := a.errOf("sessions"); e != "" {
		a.errBar(c, "加载失败："+e, a.loadSessions)
	}
	rows := FlattenGroups(groups, s.collapsed)
	if !s.loaded {
		a.emptyNote(c, "正在加载会话…")
		return
	}
	if len(s.all) == 0 {
		a.emptySessions(c)
		return
	}
	if len(rows) == 0 {
		ui.Column(c).Grow(1).Center().Gap(8).Children(func() {
			ui.Text(c, "没有符合条件的会话").TextColor(p.Muted)
			if ui.Button(c, "清除筛选").Clicked() {
				s.stateIdx, s.harness, s.query, s.filter = 4, "全部 harness", "", SessionFilter{}
			}
		})
		return
	}
	ui.Row(c).Grow(1).MinHeight(0).Padding(0, 14, 10, 14).Gap(12).AlignItems(ui.Stretch).Children(func() {
		a.sessionsTable(c, rows)
		if s.sel >= 0 && s.sel < len(rows) && rows[s.sel].Session != nil {
			a.sessionSummary(c, rows[s.sel].Session)
		}
	})
}

func (a *App) sessionsTable(c *ui.Context, rows []SessionRow) {
	p := palOf(c)
	s := &a.s
	cols := []ui.TableColumn{
		{Title: "状态", Width: 78},
		{Title: "会话 / 项目", MinWidth: 160},
		{Title: "harness", Width: 78},
		{Title: "被监督模型", Width: 150},
		{Title: "调用", Width: 60, Align: ui.End},
		{Title: "命中 H/M/L", Width: 110},
		{Title: "⚠ 危险", Width: 200},
		{Title: "最近活动", Width: 86, Align: ui.End},
	}
	s.list.Selected = &s.sel
	s.list.Header = func(i int) bool { return rows[i].Header != nil }
	s.list.Key = func(i int) any {
		if rows[i].Header != nil {
			return "g:" + rows[i].Header.Project
		}
		return rows[i].Session.SessionID
	}
	s.list.Label = func(i int) string {
		if rows[i].Header != nil {
			return ShortPath(rows[i].Header.Project)
		}
		return rows[i].Session.SessionID
	}
	now := a.now()
	tbl := ui.Table(c, &s.list, cols, len(rows), func(i, col int) {
		r := rows[i]
		if g := r.Header; g != nil {
			if col == 0 {
				arrow := "▾"
				if s.collapsed[g.Project] {
					arrow = "▸"
				}
				ui.Row(c).Gap(10).AlignItems(ui.Center).Padding(4, 0).Background(p.Faint).Children(func() {
					ui.Text(c, arrow+" "+ShortPath(g.Project)).Bold().FontSize(13).SingleLine()
					ui.Text(c, fmt.Sprintf("%d 个会话 · 活跃 %d · 调用 %d", len(g.Sessions), g.Active, g.Calls)).FontSize(12).TextColor(p.Muted).SingleLine()
					ui.Text(c, fmt.Sprintf("H %d / M %d / L %d", g.H, g.M, g.L)).FontSize(12).TextColor(p.Muted).SingleLine()
					dangerCount(c, g.Danger.Total, g.Danger.WouldHaveBlocked, g.Danger.Enforced)
				})
			}
			return
		}
		x := r.Session
		switch col {
		case 0:
			switch x.State {
			case "active":
				ui.Text(c, "● 活跃").TextColor(p.Ok).FontSize(13).SingleLine()
			case "idle":
				ui.Text(c, "○ 闲置").TextColor(p.Muted).FontSize(13).SingleLine()
			default:
				ui.Text(c, "◌ 已结束").TextColor(p.Muted).FontSize(13).SingleLine()
			}
		case 1:
			ui.Text(c, x.SessionID).FontSize(13).SingleLine()
		case 2:
			ui.Text(c, Or(Str(x.Harness), "–")).FontSize(13).SingleLine()
		case 3:
			ui.Text(c, Or(Str(x.Model), "–")).FontSize(13).TextColor(p.dim(i == s.sel)).SingleLine().Tooltip("只展示，不参与判定")
		case 4:
			ui.Text(c, fmt.Sprint(I64(x.Calls))).FontSize(13).SingleLine()
		case 5:
			ui.Row(c).Gap(8).Children(func() {
				cnt := func(sev string, n int64) {
					col := p.Muted
					if n > 0 {
						col = p.sevColor(sev)
					}
					ui.Text(c, fmt.Sprintf("%s%d", SevMark(sev), n)).FontSize(12).TextColor(col).SingleLine()
				}
				cnt("H", x.HitsH)
				cnt("M", x.HitsM)
				cnt("L", x.HitsL)
			})
		case 6:
			dangerCount(c, x.Danger.Total, x.Danger.WouldHaveBlocked, x.Danger.Enforced)
		case 7:
			el := ui.Text(c, Rel(I64(x.LastTs), now)).FontSize(12).TextColor(p.dim(i == s.sel)).SingleLine()
			if x.LastTs != nil {
				el.Tooltip(FmtISO(*x.LastTs))
			}
		}
	}).Grow(1).Label("会话列表")
	// 选中变化 → 记 id、拉摘要；双击/回车 → 打开时间线；点击组头折叠
	if tbl.Changed() || s.selID == "" && s.sel >= 0 {
		if s.sel >= 0 && s.sel < len(rows) {
			if g := rows[s.sel].Header; g != nil {
				s.collapsed[g.Project] = !s.collapsed[g.Project]
				s.sel = -1
			} else if rows[s.sel].Session != nil && rows[s.sel].Session.SessionID != s.selID {
				s.selID = rows[s.sel].Session.SessionID
				a.loadSessionDetail()
			}
		}
	}
	if tbl.Submitted() && s.sel >= 0 && s.sel < len(rows) && rows[s.sel].Session != nil {
		x := rows[s.sel].Session
		title := ""
		if s.run > 0 {
			title = s.runTi
		}
		a.openSession(x.SessionID, s.run, title)
	}
}

func (a *App) sessionSummary(c *ui.Context, x *api.SessionSummary) {
	p := palOf(c)
	s := &a.s
	ui.Scroll(c).Width(340).Shrink(0).Children(func() {
		ui.Column(c).FillWidth().Gap(10).Children(func() {
			section(c, "会话摘要", func() {
				ui.Text(c, x.SessionID).Bold().Selectable()
				kv(c, "目录", ShortPath(Str(x.Project)))
				kv(c, "harness", Str(x.Harness))
				kv(c, "模型", Str(x.Model)+"（只展示）")
				kv(c, "调用 / 事件", fmt.Sprintf("%d / %d", I64(x.Calls), x.Events))
				kv(c, "首个事件", FmtTime(I64(x.FirstTs)))
				kv(c, "最近事件", FmtTime(I64(x.LastTs))+"  "+Rel(I64(x.LastTs), a.now()))
				kv(c, "judge 调用", fmt.Sprint(x.JudgeCalls))
				kv(c, "命中", fmt.Sprintf("▲H %d  ●M %d  ·L %d（报警 %d）", x.HitsH, x.HitsM, x.HitsL, x.Alarms))
			})
			if x.Danger.Total > 0 {
				section(c, "危险", func() {
					ui.Text(c, DangerSummary(x.Danger.Total, x.Danger.WouldHaveBlocked, x.Danger.Enforced)).FontSize(13)
					ui.Row(c).Gap(6).Children(func() {
						if x.Danger.WouldHaveBlocked > 0 {
							wouldBadge(c, fmt.Sprintf("本应拦截 %d（未生效）", x.Danger.WouldHaveBlocked))
						}
						if x.Danger.Enforced > 0 {
							enforcedBadge(c, fmt.Sprintf("已拦截 %d", x.Danger.Enforced))
						}
					})
				})
			}
			if kids := s.children[x.SessionID]; len(kids) > 0 {
				section(c, fmt.Sprintf("子 agent ×%d", len(kids)), func() {
					for _, k := range kids {
						ui.Text(c, fmt.Sprintf("%s · %s · 调用 %d", ShortID(k.SessionID), Or(Str(k.Model), "?"), I64(k.Calls))).FontSize(12)
					}
				})
			}
			if hs := s.recent[x.SessionID]; len(hs) > 0 {
				section(c, "最近命中", func() {
					for _, h := range hs {
						ui.Row(c).FillWidth().Gap(6).AlignItems(ui.Center).Children(func() {
							sevMark(c, h.Sev)
							ui.Text(c, h.RuleID).Bold().FontSize(12)
							if h.Dangerous {
								dangerBadge(c, "")
							}
							ui.Text(c, Str(h.Message)).FontSize(12).TextColor(p.Muted).SingleLine().Grow(1)
						})
					}
				})
			}
			ui.Row(c).Gap(8).Children(func() {
				if ui.PrimaryButton(c, "打开事件时间线").Clicked() {
					a.openSession(x.SessionID, s.run, s.runTi)
				}
				if ui.Button(c, "复制会话 id").Clicked() {
					c.WriteClipboard(x.SessionID)
					c.Toast("已复制会话 id")
				}
			})
		})
	})
}

// emptySessions 是「还没有任何会话」的空状态（§2）。
func (a *App) emptySessions(c *ui.Context) {
	p := palOf(c)
	ui.Column(c).Grow(1).Center().Gap(10).Children(func() {
		ui.Text(c, "还没有会话").Bold().FontSize(18)
		ui.Text(c, "监督已就绪，等待 Claude Code / Codex / OpenCode 的第一次工具调用。").TextColor(p.Muted)
		if a.status != nil {
			for _, h := range []string{"claude", "codex", "opencode"} {
				ui.Text(c, fmt.Sprintf("%s：最近 15 分钟适配器失败 %d 次", h, a.status.AdapterFailures15m[h])).FontSize(12).TextColor(p.Muted)
			}
		}
		ui.Text(c, "安装 hook 用命令行 sv install（界面不执行任何命令）。").FontSize(12).TextColor(p.Muted)
	})
}

func (a *App) emptyNote(c *ui.Context, msg string) {
	ui.Column(c).Grow(1).Center().Children(func() {
		ui.Text(c, msg).TextColor(palOf(c).Muted)
	})
}

// errBar 是行内错误条：「加载失败（…）[重试]」，不清空已有内容。
func (a *App) errBar(c *ui.Context, msg string, retry func()) {
	p := palOf(c)
	ui.Row(c).FillWidth().Padding(5, 14).Gap(10).AlignItems(ui.Center).Background(p.DangerBg).Children(func() {
		ui.Text(c, msg).FontSize(13).TextColor(p.Danger).Grow(1).SingleLine()
		if ui.Button(c, "重试").Clicked() {
			retry()
		}
	})
}
