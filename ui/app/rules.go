package app

import (
	"context"
	"fmt"
	"net/url"
	"sort"
	"strings"

	"github.com/Fan-chou/agent-supervisor/ui/api"
	"github.com/egoist/mygo/ui"
)

type rulesPage struct {
	rules  []api.Rule
	mode   string
	stats  map[string]api.RuleStat
	loaded bool
	query  string
	sel    string
	list   ui.ListState

	// 阈值草稿：键是展平后的路径（普通规则 "repeat"，T 系列 "ladder.advise"）
	draft   map[string]*float64
	orig    map[string]float64
	draftID string
	err     string
	busy    bool
	// resetDraft：保存成功后，下一次规则刷新重建草稿
	resetDraft bool
}

func (r *rulesPage) init() {}

func (a *App) loadRules() {
	a.async("rules", func(ctx context.Context) (func(), error) {
		rl, err := a.Client.Rules(ctx)
		if err != nil {
			return nil, err
		}
		rs, serr := a.Client.RuleStats(ctx, url.Values{"kind": {"live"}, "since": {a.sinceDay(7)}})
		return func() {
			r := &a.rl
			r.rules, r.mode, r.loaded = rl.Rules, rl.Mode, true
			if serr == nil {
				r.stats = map[string]api.RuleStat{}
				for _, s := range rs {
					r.stats[s.Rule] = s
				}
			}
			if r.sel == "" && len(r.rules) > 0 {
				r.sel = r.rules[0].ID
			}
			// 保存/恢复默认成功后以服务端为准重建草稿；平时的后台刷新不动未保存的输入（decisions #133）
			if r.resetDraft {
				r.draftID, r.resetDraft = "", false
			}
		}, nil
	})
}

func (a *App) selectedRule() *api.Rule {
	for i := range a.rl.rules {
		if a.rl.rules[i].ID == a.rl.sel {
			return &a.rl.rules[i]
		}
	}
	return nil
}

// isLocked：X2 与服务端标 protected 的规则不可停用、不可改阈值。
func isLocked(r *api.Rule) bool { return r.Protected || r.ID == "X2" }

func (a *App) ensureDraft(r *api.Rule) {
	if a.rl.draftID == r.ID && a.rl.draft != nil {
		return
	}
	a.rl.draftID, a.rl.err = r.ID, ""
	a.rl.draft, a.rl.orig = map[string]*float64{}, map[string]float64{}
	for _, f := range FlattenThresholds(r.Thresholds) {
		if !f.Ok {
			continue
		}
		v := f.Value
		a.rl.draft[f.Path], a.rl.orig[f.Path] = &v, f.Value
	}
}

func (a *App) putRule(id string, edit api.RuleEdit, okMsg string) {
	if a.rl.busy {
		return
	}
	a.rl.busy, a.rl.err = true, ""
	a.async("rule-put", func(ctx context.Context) (func(), error) {
		res, err := a.Client.PutRule(ctx, id, edit)
		if err == nil && !res.Ok {
			err = fmt.Errorf("守护进程拒绝了这次修改")
		}
		return func() {
			a.rl.busy = false
			if err != nil {
				a.rl.err = err.Error() // 草稿保留，方便改完再试
				a.loadRules()
				return
			}
			a.toast = okMsg
			a.rl.resetDraft = true
			a.loadRules()
		}, nil
	})
}

// rulesKeys：J/K 在规则列表里切换选中（右侧详情随之更新；规则页的详情常驻，因为要编辑阈值）。
func (a *App) rulesKeys(c *ui.Context) {
	r := &a.rl
	if dir := a.moveDir(c); dir != 0 {
		cur := -1
		for i := range r.rules {
			if r.rules[i].ID == r.sel {
				cur = i
			}
		}
		if i := stepIndex(cur, dir, len(r.rules)); i >= 0 {
			r.sel, r.draftID = r.rules[i].ID, ""
			r.list.ScrollIntoView(i)
		}
	}
}

func (a *App) rulesView(c *ui.Context) {
	a.rulesKeys(c)
	ui.Row(c).Fill().Padding(0, 24, 16, 24).Gap(16).AlignItems(ui.Stretch).Children(func() {
		a.card(c).Width(400).MinHeight(0).Padding(12).Gap(8).Children(func() { a.ruleList(c) })
		ui.Scroll(c).Grow(1).MinWidth(0).MinHeight(0).Children(func() {
			ui.Column(c).FillWidth().Gap(14).Children(func() { a.ruleDetail(c) })
		})
	})
}

func (a *App) ruleList(c *ui.Context) {
	p := a.pl
	r := &a.rl
	ui.Row(c).FillWidth().Gap(8).AlignItems(ui.Center).Children(func() {
		a.label(c, "规则")
		ui.Spacer(c)
		a.muted(c, fmt.Sprintf("%d 条 · 近 7 天命中", len(r.rules)))
	})
	if msg := a.errOf("rules"); msg != "" {
		a.errLine(c, msg)
	}
	var maxHits int64 = 1
	for _, s := range r.stats {
		if s.Hits > maxHits {
			maxHits = s.Hits
		}
	}
	rules := r.rules
	r.list.Key = func(i int) any { return rules[i].ID }
	ui.List(c, &r.list, len(rules), func(i int) {
		ru := rules[i]
		sel := r.sel == ru.ID
		st := r.stats[ru.ID]
		row := ui.Row(c).Key(ru.ID).FillWidth().Margin(0, 0, 4, 0).Gap(10).Padding(10, 10).Radius(6).AlignItems(ui.Center).Border(1, ui.Transparent)
		a.hoverable(row, sel)
		row = row.ContextMenu(func(m *ui.Menu) {
			if m.Item("查看规则").Chosen() {
				r.sel, r.draftID = ru.ID, ""
			}
			m.Separator()
			if m.Item("复制规则编号").Chosen() {
				c.WriteClipboard(ru.ID)
			}
			if m.Item("复制规则名称").Chosen() {
				c.WriteClipboard(ru.Title)
			}
		})
		if ru.Disabled {
			row = row.Opacity(0.55)
		}
		row.Children(func() {
			ui.Text(c, ru.ID).Font("monospace").FontSize(14).FontWeight(700).Width(32)
			ui.Column(c).Grow(1).MinWidth(0).Gap(4).Children(func() {
				ui.Text(c, ru.Title).FontSize(13).SingleLine()
				ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
					a.bar(c, float64(st.Hits)/float64(maxHits), p.Muted.Alpha(0.6), 6).Grow(1)
					a.txt(c, fmt.Sprintf("%d", st.Hits), 11, p.Muted).FontFeatures("tnum").Width(26)
				})
			})
			switch {
			case isLocked(&ru):
				icon(c, "lock", 15, p.Muted).Tooltip("安全底线规则，不能停用")
			case ru.Disabled:
				a.pill(c, "已停用", p.Muted, p.Shade)
			default:
				a.dot(c, p.Ok, 8).Tooltip("已启用")
			}
		}).Label(ru.ID + " " + ru.Title)
		if row.Clicked() {
			r.sel = ru.ID
			r.draftID = ""
		}
	}).Grow(1).MinHeight(0)
}

func (a *App) ruleDetail(c *ui.Context) {
	p := a.pl
	r := a.selectedRule()
	if r == nil {
		a.card(c).FillWidth().Children(func() {
			a.emptyState(c, "sliders-horizontal", "选一条规则", "左边选择规则，这里显示统计和阈值")
		})
		return
	}
	a.ensureDraft(r)
	st := a.rl.stats[r.ID]
	locked := isLocked(r)

	a.card(c).FillWidth().Gap(12).Children(func() {
		ui.Row(c).FillWidth().Gap(12).AlignItems(ui.Center).Children(func() {
			ui.Text(c, r.ID).Font("monospace").FontSize(26).FontWeight(700)
			ui.Column(c).Gap(3).Grow(1).MinWidth(0).Children(func() {
				ui.Text(c, r.Title).FontSize(15).FontWeight(600)
				ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
					a.pill(c, "类别 "+r.Category, p.Muted, p.Shade)
					a.pill(c, "级别 "+r.Level, p.Muted, p.Shade)
					if r.ObserveOnly {
						a.pill(c, "仅观察", p.Muted, p.Shade)
					}
					if r.Edited {
						a.pill(c, "已修改", p.Warn, p.WarnSoft)
					}
				})
			})
			if locked {
				ui.Row(c).Gap(6).Padding(5, 10).Radius(999).Background(p.Shade).AlignItems(ui.Center).Children(func() {
					icon(c, "lock", 14, p.Muted)
					a.txt(c, "不可停用", 12, p.Muted)
				})
			} else {
				on := !r.Disabled
				sw := ui.Switch(c, &on).Label("启用 " + r.ID)
				if sw.Changed() && !a.rl.busy {
					off := !on
					a.putRule(r.ID, api.RuleEdit{Disabled: &off}, map[bool]string{true: r.ID + " 已停用", false: r.ID + " 已启用"}[off])
				}
				a.txt(c, map[bool]string{true: "已启用", false: "已停用"}[!r.Disabled], 12, p.Muted)
			}
		})
		if locked {
			ui.Row(c).FillWidth().Gap(8).Padding(10, 12).Radius(6).Background(p.Shade).AlignItems(ui.Center).Children(func() {
				icon(c, "shield-check", 16, p.Text)
				ui.Text(c, "X2 是安全底线规则：为了不让界面成为关掉危险检测的入口，它不能被停用，也没有可调阈值。").FontSize(12)
			})
		}
		if a.rl.err != "" {
			a.errLine(c, "保存失败："+a.rl.err)
		}
	})

	a.card(c).FillWidth().Gap(12).Children(func() {
		a.label(c, "命中统计 · 近 7 天")
		ui.Row(c).FillWidth().Gap(10).Children(func() {
			a.statCell(c, "命中", fmt.Sprint(st.Hits), fmt.Sprintf("涉及 %d 个会话", st.Sessions))
			a.statCell(c, "每百次调用", Num(st.HitsPer100Calls, 1), "命中率")
			fp := Pct(st.FpRate)
			note := fmt.Sprintf("已标注 %d", st.LabeledFp+st.LabeledUseful)
			if SmallSample(st) {
				note += " · 样本少"
			}
			a.statCell(c, "误报率", fp, note)
			a.statCell(c, "遵从率", Pct(st.ComplianceRate), fmt.Sprintf("已投递 %d · 遵从 %d", st.Delivered, st.Complied))
		})
		a.outcomeBreakdown(c, st)
	})

	if !locked {
		a.card(c).FillWidth().Gap(12).Children(func() { a.thresholdEditor(c, r) })
	}
}

func (a *App) statCell(c *ui.Context, title, value, note string) {
	p := a.pl
	ui.Column(c).Grow(1).Basis(0).Gap(2).Padding(12, 14).Radius(8).Background(p.Card2).Children(func() {
		a.muted(c, title)
		ui.Text(c, value).FontSize(24).FontWeight(700).FontFeatures("tnum")
		a.txt(c, note, 11, p.Muted)
	})
}

// outcomeBreakdown 按 outcome 逐项列出：会拦=幽灵、已拦截=实心、建议类=弱灰。action 计数单独一行，不用三态样式。
func (a *App) outcomeBreakdown(c *ui.Context, st api.RuleStat) {
	p := a.pl
	if len(st.Outcomes) == 0 {
		a.muted(c, "这段时间没有产生结局")
		return
	}
	keys := make([]string, 0, len(st.Outcomes))
	for k := range st.Outcomes {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	a.muted(c, "结局构成（按 outcome 统计；「会拦」没有生效）")
	var total int64
	for _, n := range st.Outcomes {
		total += n
	}
	for _, k := range keys {
		n := st.Outcomes[k]
		ui.Row(c).FillWidth().Gap(10).AlignItems(ui.Center).Children(func() {
			ui.Row(c).Width(150).Children(func() {
				switch ClassifyOutcome(k) {
				case OutcomeWould, OutcomeEnforced:
					a.outcomeChip(c, k, "")
				default:
					a.weakTag(c, Or(OutcomeText(k, ""), k))
				}
			})
			a.bar(c, float64(n)/float64(total), p.Muted.Alpha(0.55), 8).Grow(1)
			ui.Text(c, fmt.Sprint(n)).FontSize(12).FontFeatures("tnum").Width(34).TextAlign(ui.End)
		})
	}
	if len(st.Actions) > 0 {
		var parts []string
		for k, n := range st.Actions {
			parts = append(parts, fmt.Sprintf("%s %d", k, n))
		}
		sort.Strings(parts)
		a.txt(c, "规则给出的动作（只是计数，不代表已拦截）："+strings.Join(parts, " · "), 11, p.Muted)
	}
}

func (a *App) thresholdEditor(c *ui.Context, r *api.Rule) {
	p := a.pl
	ui.Row(c).FillWidth().AlignItems(ui.Center).Children(func() {
		a.label(c, "阈值")
		ui.Spacer(c)
		a.muted(c, "改动对所有会话生效，下次评估时起作用")
	})
	fields := FlattenThresholds(r.Thresholds)
	if len(fields) == 0 {
		a.muted(c, "这条规则没有可调阈值")
		return
	}
	changed := map[string]float64{}
	ui.Grid(c).Columns(2).GapX(14).GapY(10).FillWidth().Children(func() {
		for _, f := range fields {
			v := a.rl.draft[f.Path]
			ui.Column(c).Gap(4).Padding(10, 12).Radius(6).Background(p.Card2).Children(func() {
				a.txt(c, f.Path, 12, p.Muted).Font("monospace")
				if v == nil {
					ui.Text(c, fmt.Sprint(f.Raw)).FontSize(13)
					return
				}
				lo, hi, step := 1.0, 1e6, 1.0
				if f.Value != float64(int64(f.Value)) {
					lo, hi, step = 0, 1, 0.05
				}
				ui.NumberInput(c, v, lo, hi, step).Label("阈值 " + f.Path).FillWidth()
				if *v != a.rl.orig[f.Path] {
					changed[f.Path] = *v
					a.txt(c, fmt.Sprintf("原值 %g", a.rl.orig[f.Path]), 11, p.Warn)
				}
			})
		}
	})
	ui.Row(c).FillWidth().Gap(10).AlignItems(ui.Center).Children(func() {
		save := ui.PrimaryButton(c, "保存阈值").Disabled(len(changed) == 0 || a.rl.busy)
		if save.Clicked() {
			a.putRule(r.ID, api.RuleEdit{Thresholds: BuildThresholdBody(changed)}, r.ID+" 阈值已保存")
		}
		reset := ui.Button(c, "恢复默认").Disabled(!r.Edited || a.rl.busy)
		if reset.Clicked() {
			a.putRule(r.ID, api.RuleEdit{Reset: true}, r.ID+" 已恢复默认")
		}
		if len(changed) > 0 {
			a.txt(c, fmt.Sprintf("%d 项未保存", len(changed)), 12, p.Warn)
		}
	})
}
