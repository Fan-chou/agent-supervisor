package app

import (
	"context"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/Fan-chou/agent-supervisor/ui/api"
	"github.com/egoist/mygo/ui"
)

const (
	tabRules  = 0
	tabModels = 1
	tabDanger = 2
	tabReview = 3
)

type statsPage struct {
	tab       int
	source    string // "live" 或 "run N"
	srcRun    int64  // 0 = live
	rangeSel  string
	rules     []api.RuleStat
	models    []api.ModelRuleStat
	danger    api.DangerStats
	events    []api.DangerEvent
	hits      []api.Hit // 选中规则的命中（tab 规则）
	review    []api.Hit // 待复盘（未标注）
	ruleList  ui.ListState
	hitList   ui.ListState
	revList   ui.ListState
	evList    ui.ListState
	sel       int // 规则行
	hitSel    int
	dangerSel int
	revSel    int
	loaded    bool
	selRule   string

	explain   *api.Explain
	explainID int64
	explainOn bool
}

var rangeOpts = []string{"全部时间", "近 24 小时", "近 7 天", "近 14 天"}

func (a *App) statsScope() url.Values {
	k := &a.k
	q := url.Values{}
	if k.srcRun > 0 {
		q.Set("run", fmt.Sprint(k.srcRun))
	} else {
		q.Set("kind", "live")
	}
	now := a.now()
	switch k.rangeSel {
	case "近 24 小时":
		q.Set("since", fmt.Sprint(now.Add(-24*time.Hour).UnixMilli()))
	case "近 7 天":
		q.Set("since", fmt.Sprint(now.Add(-7*24*time.Hour).UnixMilli()))
	case "近 14 天":
		q.Set("since", fmt.Sprint(now.Add(-14*24*time.Hour).UnixMilli()))
	}
	return q
}

func (a *App) loadStats() {
	if a.k.rangeSel == "" {
		a.k.rangeSel = rangeOpts[0]
	}
	if len(a.p.runs) == 0 && !a.p.loaded {
		a.loadReplay() // 数据来源选择需要运行列表
	}
	scope := a.statsScope()
	tab := a.k.tab
	rule := a.k.selRule
	a.async("stats", func(ctx context.Context) (func(), error) {
		rs, err := a.Client.RuleStats(ctx, cloneQ(scope))
		if err != nil {
			return nil, err
		}
		var (
			models []api.ModelRuleStat
			ds     api.DangerStats
			evs    []api.DangerEvent
			hits   []api.Hit
			review []api.Hit
		)
		switch tab {
		case tabModels:
			if models, err = a.Client.ModelRuleStats(ctx, cloneQ(scope)); err != nil {
				return nil, err
			}
		case tabDanger:
			if ds, err = a.Client.DangerStats(ctx, cloneQ(scope)); err != nil {
				return nil, err
			}
			if evs, err = a.Client.DangerEvents(ctx, cloneQ(scope)); err != nil {
				return nil, err
			}
		case tabReview:
			q := cloneQ(scope)
			q.Set("label", "unlabeled")
			q.Set("limit", "200")
			hl, err := a.Client.Hits(ctx, q)
			if err != nil {
				return nil, err
			}
			review = hl.Hits
		default:
			if rule != "" {
				q := cloneQ(scope)
				q.Set("rule", rule)
				q.Set("limit", "200")
				hl, err := a.Client.Hits(ctx, q)
				if err != nil {
					return nil, err
				}
				hits = hl.Hits
			}
		}
		return func() {
			k := &a.k
			k.rules, k.loaded = rs, true
			switch tab {
			case tabModels:
				k.models = models
			case tabDanger:
				k.danger, k.events = ds, evs
			case tabReview:
				k.review = review
			default:
				k.hits = hits
			}
		}, nil
	})
}

func cloneQ(q url.Values) url.Values {
	o := url.Values{}
	for k, v := range q {
		o[k] = append([]string(nil), v...)
	}
	return o
}

func (a *App) sourceOptions() []string {
	opts := []string{"live"}
	for _, r := range a.p.runs {
		if r.Kind != "live" {
			opts = append(opts, fmt.Sprintf("run %d · %s", r.ID, Or(Str(r.Label), r.Kind)))
		}
	}
	return opts
}

func (a *App) statsView(c *ui.Context) {
	p := palOf(c)
	k := &a.k
	if k.rangeSel == "" {
		k.rangeSel = rangeOpts[0]
	}
	tab := k.tab
	prevSrc, prevRange := k.source, k.rangeSel
	ui.Row(c).FillWidth().Padding(10, 14).Gap(10).AlignItems(ui.Center).Children(func() {
		ui.Tabs(c, &tab, "规则", "按模型", "⚠ 危险", "待复盘命中").Label("规则统计页签")
		ui.Spacer(c)
		ui.Text(c, "数据").FontSize(12).TextColor(p.Muted)
		ui.Select(c, &k.source, a.sourceOptions()).Width(170).Label("数据来源")
		ui.Select(c, &k.rangeSel, rangeOpts).Width(120).Label("时间范围")
	})
	if tab != k.tab {
		k.tab = tab
		a.loadStats()
	}
	if k.source != prevSrc || k.rangeSel != prevRange {
		k.srcRun = 0
		if strings.HasPrefix(k.source, "run ") {
			fmt.Sscanf(k.source, "run %d", &k.srcRun)
		}
		k.sel, k.selRule, k.hits = -1, "", nil
		a.loadStats()
	}
	if k.srcRun > 0 {
		banner(c, p.Warn, p.WarnBg, "数据来源：回放 · "+k.source+"（遵从率列为模拟值）")
	}
	if e := a.errOf("stats"); e != "" {
		a.errBar(c, "加载失败："+e, a.loadStats)
	}
	if !k.loaded {
		a.emptyNote(c, "正在加载规则统计…")
		return
	}
	switch k.tab {
	case tabModels:
		a.modelsTab(c)
	case tabDanger:
		a.dangerTab(c)
	case tabReview:
		a.reviewTab(c)
	default:
		a.rulesTab(c)
	}
	a.explainModal(c)
}

// ---- 规则页签 ----

func (a *App) rulesTab(c *ui.Context) {
	p := palOf(c)
	k := &a.k
	var tot, applied, lab, fp int64
	for _, r := range k.rules {
		tot += r.Hits
		applied += r.Applied
		lab += r.LabeledFp + r.LabeledUseful
		fp += r.LabeledFp
	}
	ui.Row(c).FillWidth().Padding(0, 14, 4, 14).Gap(10).Children(func() {
		ui.Textf(c, "规则 %d · 命中 %d · 已标注 %d（误报 %d）", len(k.rules), tot, lab, fp).FontSize(13)
		if lab == 0 {
			ui.Text(c, "没有人工标注：误报率显示 n/a，不编造数字。标注用命令行 sv mark。").FontSize(12).TextColor(p.Muted)
		}
	})
	if len(k.rules) == 0 {
		ui.Column(c).Grow(1).Center().Gap(8).Children(func() {
			ui.Text(c, "还没有命中记录").Bold().FontSize(18)
			ui.Text(c, "用 sv replay <dir> --log 产生数据，或等守护进程收到真实会话。").TextColor(p.Muted)
		})
		return
	}
	ui.Column(c).Grow(1).MinHeight(0).Padding(0, 14, 10, 14).Gap(10).Children(func() {
		k.ruleList.Selected = &k.sel
		h := 0 // 选中规则后，规则表收成内容高度，把空间让给下面的命中列表
		if k.selRule != "" {
			h = 40 + 32*len(k.rules)
		}
		tbl := a.ruleStatTable(c, k.rules, h, &k.ruleList)
		if tbl.Changed() && k.sel >= 0 && k.sel < len(k.rules) {
			k.selRule = k.rules[k.sel].Rule
			a.loadStats()
		}
		if k.selRule != "" {
			a.hitsTable(c, k.hits, &k.hitList, &k.hitSel, "规则 "+k.selRule+" 的命中（最新在前）")
		}
	})
}

// ruleStatTable 是 sv stats --by rule 的可视化。height=0 时占满剩余空间。
func (a *App) ruleStatTable(c *ui.Context, rows []api.RuleStat, height int, ls *ui.ListState) ui.Element {
	p := palOf(c)
	cols := []ui.TableColumn{
		{Title: "规则", Width: 60},
		{Title: "命中", Width: 52, Align: ui.End},
		{Title: "会话", Width: 52, Align: ui.End},
		{Title: "/100 调用", Width: 78, Align: ui.End},
		{Title: "会话占比", Width: 74, Align: ui.End},
		{Title: "H / M / L", Width: 110},
		{Title: "生效", Width: 48, Align: ui.End},
		{Title: "标注 误报/有用", Width: 132},
		{Title: "误报率", Width: 110},
		{Title: "遵从率", Width: 64},
		{Title: "处置 · 被抑制", MinWidth: 200},
	}
	if ls != nil {
		ls.Key = func(i int) any { return rows[i].Rule }
		ls.Label = func(i int) string { return rows[i].Rule }
	}
	tbl := ui.Table(c, ls, cols, len(rows), func(i, col int) {
		r := rows[i]
		t := func(s string) ui.Element { return ui.Text(c, s).FontSize(13).SingleLine() }
		switch col {
		case 0:
			ui.Row(c).Gap(4).AlignItems(ui.Center).Children(func() {
				t(r.Rule).Bold()
				if r.Rule == "X2" {
					ui.Text(c, "⚠").TextColor(p.Danger)
				}
			})
		case 1:
			t(fmt.Sprint(r.Hits))
		case 2:
			t(fmt.Sprint(r.Sessions))
		case 3:
			t(Num(r.HitsPer100Calls, 1))
		case 4:
			t(Pct(r.SessionRate))
		case 5:
			t(fmt.Sprintf("%s%d  %s%d  %s%d", "▲", r.BySev["H"], "●", r.BySev["M"], "·", r.BySev["L"])).FontSize(12)
		case 6:
			t(fmt.Sprint(r.Applied))
		case 7:
			t(fmt.Sprintf("%d / %d", r.LabeledFp, r.LabeledUseful))
		case 8:
			ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
				t(Pct(r.FpRate))
				if r.FpRate != nil && SmallSample(r) {
					ui.Text(c, "样本少").FontSize(11).TextColor(p.Muted)
				}
			})
		case 9:
			t(Pct(r.ComplianceRate))
		case 10:
			t(outcomesText(r)).FontSize(12).TextColor(p.dim(ls != nil && ls.Selected != nil && *ls.Selected == i))
		}
	}).Label("规则统计")
	if height > 0 {
		tbl.Height(float32(height)).MaxHeight(float32(height))
	} else {
		tbl.Grow(1).MinHeight(120)
	}
	return tbl
}

func outcomesText(r api.RuleStat) string {
	var parts []string
	keys := make([]string, 0, len(r.Outcomes))
	for k := range r.Outcomes {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("%s×%d", k, r.Outcomes[k]))
	}
	s := strings.Join(parts, " ")
	if len(r.Suppressed) > 0 {
		var sp []string
		for k, v := range r.Suppressed {
			sp = append(sp, fmt.Sprintf("%s×%d", k, v))
		}
		sort.Strings(sp)
		s += " · 抑制 " + strings.Join(sp, " ")
	}
	return Or(s, "–")
}

// hitsTable 是命中列表（只读）；双击/回车打开命中详情。
func (a *App) hitsTable(c *ui.Context, hits []api.Hit, ls *ui.ListState, sel *int, title string) {
	p := palOf(c)
	ui.Text(c, title).Bold().FontSize(12).TextColor(p.Muted)
	cols := []ui.TableColumn{
		{Title: "时间", Width: 128}, {Title: "会话", Width: 120}, {Title: "规则", Width: 60}, {Title: "级别", Width: 56},
		{Title: "阶段", Width: 52}, {Title: "处置", Width: 256}, {Title: "消息", MinWidth: 200}, {Title: "标注", Width: 70},
	}
	ls.Selected = sel
	ls.Key = func(i int) any { return hits[i].ID }
	tbl := ui.Table(c, ls, cols, len(hits), func(i, col int) {
		h := hits[i]
		switch col {
		case 0:
			ui.Text(c, FmtTime(h.Ts)).FontSize(13).SingleLine().Tooltip(FmtISO(h.Ts))
		case 1:
			ui.Text(c, ShortID(h.SessionID)).FontSize(13).SingleLine().Tooltip(h.SessionID)
		case 2:
			ui.Row(c).Gap(4).AlignItems(ui.Center).Children(func() {
				ui.Text(c, h.RuleID).Bold().FontSize(13)
				if h.Dangerous {
					ui.Text(c, "⚠").TextColor(p.Danger)
				}
			})
		case 3:
			sevMark(c, h.Sev)
		case 4:
			ui.Text(c, Str(h.Phase)).FontSize(13).SingleLine()
		case 5:
			if h.Outcome != nil && *h.Outcome != "" {
				outcomeBadge(c, *h.Outcome, "")
			} else {
				ui.Text(c, "–").TextColor(p.Muted)
			}
		case 6:
			ui.Text(c, Str(h.Message)).FontSize(12).TextColor(p.dim(i == *sel)).SingleLine()
		case 7:
			ui.Text(c, labelText(h.Label)).FontSize(12).SingleLine()
		}
	}).Grow(1).MinHeight(120).Label("命中列表")
	if tbl.Submitted() && *sel >= 0 && *sel < len(hits) {
		a.openExplain(hits[*sel].ID)
	}
}

func labelText(l *string) string {
	switch Str(l) {
	case "false_positive":
		return "误报"
	case "useful":
		return "有用"
	}
	return "未标注"
}

// ---- 按模型 ----

func (a *App) modelsTab(c *ui.Context) {
	p := palOf(c)
	k := &a.k
	ui.Column(c).Grow(1).MinHeight(0).Padding(0, 14, 10, 14).Gap(8).Children(func() {
		ui.Text(c, "模型名只用来事后观察；界面没有任何按模型改变阈值的入口。").FontSize(12).TextColor(p.Muted)
		cols := []ui.TableColumn{{Title: "被监督模型", MinWidth: 200}, {Title: "调用数", Width: 90, Align: ui.End}, {Title: "规则", Width: 70}, {Title: "命中", Width: 70, Align: ui.End}, {Title: "每 100 调用命中", Width: 130, Align: ui.End}}
		ui.Table(c, nil, cols, len(k.models), func(i, col int) {
			m := k.models[i]
			t := func(s string) { ui.Text(c, s).FontSize(13).SingleLine() }
			switch col {
			case 0:
				t(m.Model)
			case 1:
				t(fmt.Sprint(m.Calls))
			case 2:
				ui.Text(c, m.Rule).Bold().FontSize(13)
			case 3:
				t(fmt.Sprint(m.Hits))
			case 4:
				t(Num(m.HitsPer100Calls, 2))
			}
		}).Grow(1).Label("按模型统计")
	})
}

// ---- 危险页签 ----

func (a *App) dangerTab(c *ui.Context) {
	p := palOf(c)
	k := &a.k
	d := k.danger
	ui.Column(c).Grow(1).MinHeight(0).Padding(0, 14, 10, 14).Gap(10).Children(func() {
		// 「◌ 本应拦截」的数量与明细是醒目的第一块内容（shadow 一周后决定是否打开 enforce 的依据）
		ui.Row(c).FillWidth().Gap(14).AlignItems(ui.Center).Padding(10, 12).Radius(8).Background(p.Panel).Children(func() {
			ui.Text(c, fmt.Sprintf("⚠ 危险 %d", d.Total)).Bold().FontSize(20).TextColor(p.Danger)
			ui.Column(c).Gap(2).Children(func() {
				wouldBadge(c, fmt.Sprintf("本应拦截 %d（未生效）", d.WouldHaveBlocked))
				ui.Text(c, "shadow/advise 下规则本来会拦、但没有真的拦").FontSize(11).TextColor(p.Muted)
			})
			ui.Column(c).Gap(2).Children(func() {
				enforcedBadge(c, fmt.Sprintf("已拦截 %d", d.Enforced))
				ui.Text(c, "enforce 下真的拦了/要求了确认").FontSize(11).TextColor(p.Muted)
			})
			ui.Spacer(c)
			cats := make([]string, 0, len(d.ByCategory))
			for cat := range d.ByCategory {
				cats = append(cats, cat)
			}
			sort.Strings(cats)
			for _, cat := range cats {
				chip(c, fmt.Sprintf("%s ×%d", cat, d.ByCategory[cat]), p.Danger, p.DangerBg)
			}
		})
		if d.Total == 0 {
			ui.Column(c).Grow(1).Center().Children(func() {
				ui.Text(c, "没有危险操作记录").TextColor(p.Muted)
			})
			return
		}
		cols := []ui.TableColumn{
			{Title: "时间", Width: 128}, {Title: "会话", Width: 120}, {Title: "类别", Width: 118}, {Title: "对象", MinWidth: 170},
			{Title: "原因", Width: 170}, {Title: "结局", Width: 256}, {Title: "mode", Width: 76}, {Title: "被监督模型", Width: 100},
		}
		k.evList.Selected = &k.dangerSel
		k.evList.Key = func(i int) any { return k.events[i].HitID }
		tbl := ui.Table(c, &k.evList, cols, len(k.events), func(i, col int) {
			e := k.events[i]
			t := func(s string) ui.Element { return ui.Text(c, s).FontSize(13).SingleLine() }
			switch col {
			case 0:
				t(FmtTime(e.Ts)).Tooltip(FmtISO(e.Ts))
			case 1:
				t(ShortID(e.SessionID)).Tooltip(e.SessionID)
			case 2:
				dangerBadge(c, Str(e.Category))
			case 3:
				t(Str(e.Subject)).Font("monospace")
			case 4:
				t(Str(e.Reason)).TextColor(p.dim(i == k.dangerSel))
			case 5:
				outcomeBadge(c, Str(e.Outcome), Str(e.Mode))
			case 6:
				t(Str(e.Mode))
			case 7:
				t(Str(e.Model)).TextColor(p.dim(i == k.dangerSel))
			}
		}).Grow(1).Label("危险事件")
		if tbl.Submitted() && k.dangerSel >= 0 && k.dangerSel < len(k.events) {
			a.openExplain(k.events[k.dangerSel].HitID)
		}
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			ui.Text(c, "双击/回车打开命中详情").FontSize(12).TextColor(p.Muted)
			if k.dangerSel >= 0 && k.dangerSel < len(k.events) {
				e := k.events[k.dangerSel]
				if ui.Button(c, "打开该会话的事件时间线").Clicked() {
					a.openSession(e.SessionID, k.srcRun, "")
				}
			}
		})
	})
}

// ---- 待复盘命中（只读；标注只能用 sv mark） ----

func (a *App) reviewTab(c *ui.Context) {
	p := palOf(c)
	k := &a.k
	ui.Column(c).Grow(1).MinHeight(0).Padding(0, 14, 10, 14).Gap(8).Children(func() {
		ui.Text(c, fmt.Sprintf("还没有人工标注的命中 %d 条。界面不提供标注按钮：用命令行 sv mark <hit-id> false_positive|useful。", len(k.review))).FontSize(12).TextColor(p.Muted)
		if len(k.review) == 0 {
			ui.Column(c).Grow(1).Center().Children(func() { ui.Text(c, "没有待复盘的命中").TextColor(p.Muted) })
			return
		}
		a.hitsTable(c, k.review, &k.revList, &k.revSel, "待复盘命中（最新在前）")
	})
}

// ---- 命中详情（explain） ----

func (a *App) openExplain(id int64) {
	k := &a.k
	k.explainID, k.explainOn, k.explain = id, true, nil
	a.async("explain", func(ctx context.Context) (func(), error) {
		ex, err := a.Client.Explain(ctx, id)
		if err != nil {
			return nil, err
		}
		return func() { k.explain = &ex }, nil
	})
}

func mstr(m map[string]any, key string) string {
	v, ok := m[key]
	if !ok || v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	if f, ok := v.(float64); ok && f == float64(int64(f)) {
		return fmt.Sprint(int64(f))
	}
	return fmt.Sprint(v)
}

func (a *App) explainModal(c *ui.Context) {
	k := &a.k
	if !k.explainOn {
		return
	}
	p := palOf(c)
	ui.Modal(c, &k.explainOn, func() {
		ui.Scroll(c).Width(720).MaxHeight(620).Children(func() {
			ui.Column(c).FillWidth().Gap(10).Padding(4).Children(func() {
				ui.Row(c).FillWidth().Gap(10).AlignItems(ui.Center).Children(func() {
					ui.Text(c, fmt.Sprintf("命中 #%d 详情", k.explainID)).Bold().FontSize(16)
					ui.Spacer(c)
					if ui.Button(c, "复制 sv explain").Clicked() {
						c.WriteClipboard(fmt.Sprintf("sv explain %d", k.explainID))
						c.Toast("已复制（界面不会执行它）")
					}
					if ui.Button(c, "关闭").Clicked() {
						k.explainOn = false
					}
				})
				if e := a.errOf("explain"); e != "" {
					banner(c, p.Danger, p.DangerBg, "加载失败："+e)
				}
				ex := k.explain
				if ex == nil {
					ui.Text(c, "加载中…").TextColor(p.Muted)
					return
				}
				section(c, "命中（阈值、观测值、指纹）", func() {
					h := ex.Hit
					kv(c, "规则 / 级别", mstr(h, "rule_id")+" · "+SevMark(mstr(h, "sev")))
					kv(c, "会话 / 序号", mstr(h, "session_id")+" #"+mstr(h, "seq"))
					kv(c, "阶段", mstr(h, "phase"))
					kv(c, "阈值", mstr(h, "threshold_json"))
					kv(c, "观测值", mstr(h, "observed_json"))
					kv(c, "指纹", mstr(h, "fingerprint"))
					kv(c, "消息", mstr(h, "message"))
					if mstr(h, "severity") == "dangerous" {
						dangerBadge(c, mstr(h, "danger_category"))
						kv(c, "对象", mstr(h, "danger_subject"))
						kv(c, "原因", mstr(h, "danger_reason"))
					}
				})
				section(c, fmt.Sprintf("证据调用（%d）", len(ex.Events)), func() {
					for _, e := range ex.Events {
						mono(c, fmt.Sprintf("#%s %s %s  %s", mstr(e, "seq"), mstr(e, "phase"), mstr(e, "tool_name"), mstr(e, "norm_cmd")))
					}
				})
				section(c, "决策（含抑制原因）", func() {
					if len(ex.Decisions) == 0 {
						ui.Text(c, "没有面向 agent 的决策").FontSize(12).TextColor(p.Muted)
					}
					for _, d := range ex.Decisions {
						ui.Row(c).FillWidth().Gap(8).AlignItems(ui.Center).Children(func() {
							ui.Text(c, mstr(d, "action")).Bold().FontSize(13)
							if o := mstr(d, "outcome"); o != "" {
								outcomeBadge(c, o, mstr(d, "mode"))
							}
							if s := mstr(d, "suppressed_by"); s != "" {
								weakTag(c, "被抑制："+s)
							}
							ui.Text(c, mstr(d, "message")).FontSize(12).TextColor(p.Muted).SingleLine().Grow(1)
						})
					}
				})
				if len(ex.Judge) > 0 {
					section(c, "judge 调用", func() {
						for _, j := range ex.Judge {
							id := mstr(j, "id")
							line := fmt.Sprintf("#%s · %s · %s · %s", id, mstr(j, "model"), mstr(j, "verdict"), mstr(j, "status"))
							if ui.Text(c, line+"  → 打开 Judge 裁决").FontSize(13).TextColor(c.Theme().Accent).Cursor(ui.CursorPointer).Clicked() {
								k.explainOn = false
								var n int64
								fmt.Sscan(id, &n)
								a.j.focusID = n
								a.Goto(PageJudge)
							}
						}
					})
				}
				section(c, "投递与遵从", func() {
					if len(ex.Deliveries) == 0 {
						ui.Text(c, "没有投递记录").FontSize(12).TextColor(p.Muted)
					}
					for _, d := range ex.Deliveries {
						mono(c, fmt.Sprintf("%s · %s", mstr(d, "kind"), mstr(d, "text")))
					}
				})
				section(c, "人工标注历史（只显示）", func() {
					if len(ex.Labels) == 0 {
						ui.Text(c, "没有标注").FontSize(12).TextColor(p.Muted)
					}
					for _, l := range ex.Labels {
						mono(c, fmt.Sprintf("%s · %s", mstr(l, "kind"), mstr(l, "note")))
					}
				})
			})
		})
	})
}
