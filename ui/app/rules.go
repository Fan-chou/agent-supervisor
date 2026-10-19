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

type rulesPage struct {
	rules  []api.Rule
	mode   string
	stats  map[string]api.RuleStat
	loaded bool
	list   ui.ListState
	sel    int
	selID  string

	// 编辑草稿：键是展平后的路径（普通规则 "repeat"，T 系列 "ladder.advise"）
	draft   map[string]float64
	orig    map[string]float64
	draftID string
	errs    []string // 服务端校验错误，原样显示
	okMsg   string
	busy    bool

	confirmDisable bool
}

// ThField 是阈值展平后的一项。
type ThField struct {
	Path  string
	Value float64
	Ok    bool // false：不是数字（只读展示）
	Raw   any
}

// FlattenThresholds 把 GET /v1/rules 的 thresholds 展平成可编辑的叶子，路径用点号（ladder.advise）。
func FlattenThresholds(m map[string]any) []ThField {
	var out []ThField
	var walk func(prefix string, v map[string]any)
	walk = func(prefix string, v map[string]any) {
		keys := make([]string, 0, len(v))
		for k := range v {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			path := k
			if prefix != "" {
				path = prefix + "." + k
			}
			switch x := v[k].(type) {
			case map[string]any:
				walk(path, x)
			case float64:
				out = append(out, ThField{Path: path, Value: x, Ok: true, Raw: x})
			default:
				out = append(out, ThField{Path: path, Raw: x})
			}
		}
	}
	walk("", m)
	return out
}

// BuildThresholdBody 把改动过的叶子还原成 PUT 的 thresholds：{"repeat":6} 或 {"ladder":{"advise":4}}。只含改过的键。
func BuildThresholdBody(changed map[string]float64) map[string]any {
	body := map[string]any{}
	for path, v := range changed {
		parts := strings.Split(path, ".")
		cur := body
		for _, p := range parts[:len(parts)-1] {
			next, _ := cur[p].(map[string]any)
			if next == nil {
				next = map[string]any{}
				cur[p] = next
			}
			cur = next
		}
		cur[parts[len(parts)-1]] = v
	}
	return body
}

func (a *App) loadRules() {
	a.async("rules", func(ctx context.Context) (func(), error) {
		rl, err := a.Client.Rules(ctx)
		if err != nil {
			return nil, err
		}
		q := url.Values{"kind": {"live"}, "since": {fmt.Sprint(a.now().Add(-7 * 24 * time.Hour).UnixMilli())}}
		rs, serr := a.Client.RuleStats(ctx, q)
		return func() {
			r := &a.r
			r.rules, r.mode, r.loaded = rl.Rules, rl.Mode, true
			if serr == nil {
				r.stats = map[string]api.RuleStat{}
				for _, s := range rs {
					r.stats[s.Rule] = s
				}
			}
		}, nil
	})
}

func (a *App) selectedRule() *api.Rule {
	r := &a.r
	if r.sel < 0 || r.sel >= len(r.rules) {
		return nil
	}
	return &r.rules[r.sel]
}

// syncDraft 在选中规则变化时重置编辑草稿。
func (a *App) syncDraft(rule *api.Rule) {
	r := &a.r
	if r.draftID == rule.ID && r.draft != nil {
		return
	}
	r.draftID = rule.ID
	r.draft, r.orig = map[string]float64{}, map[string]float64{}
	for _, f := range FlattenThresholds(rule.Thresholds) {
		if f.Ok {
			r.draft[f.Path], r.orig[f.Path] = f.Value, f.Value
		}
	}
}

func (a *App) rulesView(c *ui.Context) {
	p := palOf(c)
	r := &a.r
	if e := a.errOf("rules"); e != "" {
		a.errBar(c, "加载失败："+e, a.loadRules)
	}
	if !r.loaded {
		a.emptyNote(c, "正在加载规则…")
		return
	}
	ui.Row(c).FillWidth().Padding(10, 14).Gap(12).AlignItems(ui.Center).Children(func() {
		ui.Text(c, "mode："+r.mode).Bold()
		ui.Text(c, "改 mode、judge、预算、日志请编辑 config.yaml 并重启；被监督模型只记录到日志，不参与判定。").FontSize(12).TextColor(p.Muted)
		ui.Spacer(c)
		ui.Text(c, "整个界面唯一能写的地方：规则的启用/停用与它自己的阈值").FontSize(12).TextColor(p.Warn)
	})
	if len(r.rules) == 0 {
		a.emptyNote(c, "没有规则")
		return
	}
	ui.Row(c).Grow(1).MinHeight(0).Padding(0, 14, 10, 14).Gap(12).AlignItems(ui.Stretch).Children(func() {
		a.rulesTable(c)
		if rule := a.selectedRule(); rule != nil {
			a.ruleEditor(c, rule)
		}
	})
}

func levelText(r api.Rule) string {
	if r.ObserveOnly || r.Level == "observe" {
		return "仅回放观察"
	}
	return r.Level
}

func thresholdSummary(r api.Rule) string {
	if r.Protected {
		return "本地拦截（deny/ask）"
	}
	var parts []string
	for _, f := range FlattenThresholds(r.Thresholds) {
		if f.Ok {
			parts = append(parts, fmt.Sprintf("%s=%g", strings.TrimPrefix(f.Path, "ladder."), f.Value))
		}
	}
	return Or(strings.Join(parts, " · "), "–")
}

func (a *App) rulesTable(c *ui.Context) {
	p := palOf(c)
	r := &a.r
	cols := []ui.TableColumn{
		{Title: "ID", Width: 68}, {Title: "名称", MinWidth: 220}, {Title: "级别", Width: 84}, {Title: "阈值（一套）", MinWidth: 190},
		{Title: "启用", Width: 70}, {Title: "7 天命中", Width: 70, Align: ui.End}, {Title: "误报率", Width: 70}, {Title: "遵从率", Width: 64},
	}
	r.list.Selected = &r.sel
	r.list.Key = func(i int) any { return r.rules[i].ID }
	r.list.Label = func(i int) string { return r.rules[i].ID + " " + r.rules[i].Title }
	tbl := ui.Table(c, &r.list, cols, len(r.rules), func(i, col int) {
		ru := r.rules[i]
		st, hasSt := r.stats[ru.ID]
		t := func(s string) ui.Element { return ui.Text(c, s).FontSize(13).SingleLine() }
		switch col {
		case 0:
			ui.Row(c).Gap(4).AlignItems(ui.Center).Children(func() {
				t(ru.ID).Bold()
				if ru.Protected {
					ui.Text(c, "⚠").TextColor(p.Danger)
				}
			})
		case 1:
			ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
				t(ru.Title)
				if ru.Edited {
					chip(c, "已改", p.Warn, p.WarnBg)
				}
			})
		case 2:
			t(levelText(ru)).TextColor(p.dim(i == r.sel))
		case 3:
			t(thresholdSummary(ru)).TextColor(p.dim(i == r.sel)).Font("monospace").FontSize(12)
		case 4:
			switch {
			case ru.Protected:
				ui.Text(c, "● 锁定").FontSize(13).TextColor(p.Danger).Bold()
			case ru.Disabled:
				ui.Text(c, "◌ 停用").FontSize(13).TextColor(p.Muted)
			default:
				ui.Text(c, "● 启用").FontSize(13).TextColor(p.Ok)
			}
		case 5:
			if hasSt {
				t(fmt.Sprint(st.Hits))
			} else {
				t("–")
			}
		case 6:
			if hasSt {
				t(Pct(st.FpRate))
			} else {
				t("n/a")
			}
		case 7:
			if hasSt {
				t(Pct(st.ComplianceRate))
			} else {
				t("–")
			}
		}
	}).Grow(1).MinWidth(0).Label("规则列表")
	if tbl.Changed() && r.sel >= 0 {
		r.errs, r.okMsg = nil, ""
	}
}

func (a *App) ruleEditor(c *ui.Context, rule *api.Rule) {
	p := palOf(c)
	r := &a.r
	a.syncDraft(rule)
	ui.Scroll(c).Width(400).Shrink(0).Children(func() {
		ui.Column(c).FillWidth().Gap(10).Children(func() {
			section(c, fmt.Sprintf("%s · %s", rule.ID, rule.Title), func() {
				kv(c, "类别 / 级别", rule.Category+" · "+levelText(*rule))
				kv(c, "出处", rule.Source)
				if st, ok := r.stats[rule.ID]; ok {
					kv(c, "7 天", fmt.Sprintf("命中 %d · 会话 %d · 标注 %d/%d", st.Hits, st.Sessions, st.LabeledFp, st.LabeledUseful))
				}
				if rule.Edited {
					ui.Text(c, "已被界面/命令行改过（rules.local.json）").FontSize(12).TextColor(p.Warn)
				}
			})
			if rule.Protected {
				section(c, "受保护", func() {
					ui.Text(c, rule.ID+" 是受保护的安全规则：不可停用，没有可编辑阈值。shadow 下只记录，危险操作标 ◌ 本应拦截；enforce 下才真的拦。").FontSize(13)
				})
				return
			}
			section(c, "启用", func() {
				on := !rule.Disabled
				before := on
				ui.Toggle(c, &on, map[bool]string{true: "● 启用中", false: "◌ 已停用"}[on]).Label("启用或停用 " + rule.ID).Disabled(r.busy)
				if on != before {
					if !on {
						r.confirmDisable = true // 停用要二次确认
					} else {
						a.putRule(rule.ID, api.RuleEdit{Disabled: ptrBool(false)})
					}
				}
			})
			fields := FlattenThresholds(rule.Thresholds)
			section(c, "阈值（只改它自己的）", func() {
				if len(fields) == 0 {
					ui.Text(c, "没有可编辑的阈值").FontSize(12).TextColor(p.Muted)
				}
				for _, f := range fields {
					f := f
					ui.Row(c).FillWidth().Gap(8).AlignItems(ui.Center).Children(func() {
						ui.Text(c, f.Path).Font("monospace").FontSize(12).Width(150).SingleLine()
						if !f.Ok {
							ui.Text(c, fmt.Sprint(Or(fmt.Sprint(f.Raw), "–"))+"（只读）").FontSize(12).TextColor(p.Muted)
							return
						}
						v := r.draft[f.Path]
						lo, hi, step := 1.0, 1000000.0, 1.0
						if f.Value > 0 && f.Value <= 1 {
							lo, hi, step = 0.01, 1, 0.05 // 比例类阈值
						}
						if ui.NumberInput(c, &v, lo, hi, step).Width(130).Disabled(r.busy).Label(f.Path).Changed() {
							r.draft[f.Path] = v
							r.errs, r.okMsg = nil, ""
						}
					})
				}
			})
			changed := map[string]float64{}
			for k, v := range r.draft {
				if v != r.orig[k] {
					changed[k] = v
				}
			}
			ui.Row(c).FillWidth().Gap(8).Children(func() {
				if ui.PrimaryButton(c, "保存阈值").Disabled(len(changed) == 0 || r.busy).Clicked() {
					a.putRule(rule.ID, api.RuleEdit{Thresholds: BuildThresholdBody(changed)})
				}
				if ui.Button(c, "撤销草稿").Disabled(len(changed) == 0).Clicked() {
					r.draftID = ""
				}
				if ui.Button(c, "恢复默认").Disabled(!rule.Edited || r.busy).Clicked() {
					a.putRule(rule.ID, api.RuleEdit{Reset: true})
				}
			})
			ui.Text(c, "保存后立即作用于所有在跑的会话；会话中途阈值会跳变，命中记录里会写当时实际用的值。以服务端响应为准，不做乐观更新。").FontSize(11).TextColor(p.Muted)
			if len(r.errs) > 0 {
				ui.Column(c).FillWidth().Gap(2).Padding(8).Radius(6).Background(p.DangerBg).Children(func() {
					ui.Text(c, "服务端拒绝了这次修改：").Bold().FontSize(12).TextColor(p.Danger)
					for _, e := range r.errs {
						ui.Text(c, "· "+e).FontSize(12).TextColor(p.Danger).Selectable()
					}
				})
			}
			if r.okMsg != "" {
				ui.Text(c, r.okMsg).FontSize(12).TextColor(p.Ok)
			}
			ui.Text(c, "试算（不改配置）：").FontSize(12).TextColor(p.Muted)
			mono(c, fmt.Sprintf("sv replay <dir> --log --label try --set thresholds.%s=…", rule.ID))
		})
	})
	if ui.AlertDialog(c, &r.confirmDisable, "停用 "+rule.ID+"？", "停用后这条规则立即对所有在跑的会话失效（不再命中、不再提醒），可以随时重新启用。", "取消", "停用") == 1 {
		a.putRule(rule.ID, api.RuleEdit{Disabled: ptrBool(true)})
	}
}

func ptrBool(b bool) *bool { return &b }

// putRule 是界面唯一的写：成功后以服务端返回为准重新拉规则；失败原样显示服务端给的错误。
func (a *App) putRule(id string, edit api.RuleEdit) {
	r := &a.r
	r.busy, r.errs, r.okMsg = true, nil, ""
	run := func() {
		_, err := a.Client.PutRule(a.ctx, id, edit)
		a.post(func() {
			r.busy = false
			if err != nil {
				a.fail("put-rule", err)
				if ae, ok := err.(*api.Error); ok && ae.Message != "" {
					r.errs = strings.Split(ae.Message, "；")
				} else {
					r.errs = []string{err.Error()}
				}
				a.loadRules() // 草稿保留，方便改了再提交
				return
			}
			delete(a.errByKey, "put-rule")
			r.okMsg = "已保存，立即对所有在跑的会话生效。"
			r.draftID = ""
			a.loadRules()
		})
	}
	if a.sync {
		run()
		return
	}
	go run()
}
