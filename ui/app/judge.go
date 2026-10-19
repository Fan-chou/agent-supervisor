package app

import (
	"context"
	"fmt"
	"net/url"
	"sort"

	"github.com/Fan-chou/agent-supervisor/ui/api"
	"github.com/egoist/mygo/ui"
)

type judgePage struct {
	tab      int // 0 裁决记录 · 1 路由
	calls    api.JudgeCallList
	stats    []api.JudgeStat
	routes   api.JudgeRoutes
	hasRoute bool
	open     bool // 右侧详情面板
	sel      int64
	detail   *api.JudgeCallDetail
	list     ui.ListState
}

func (j *judgePage) init() {}

func (a *App) loadJudge() {
	a.async("judge", func(ctx context.Context) (func(), error) {
		cl, err := a.Client.JudgeCalls(ctx, url.Values{"limit": {"100"}, "kind": {"live"}})
		if err != nil {
			return nil, err
		}
		st, _ := a.Client.JudgeStats(ctx, url.Values{"kind": {"live"}})
		rt, rerr := a.Client.JudgeRoutes(ctx, url.Values{"since": {a.sinceDay(7)}})
		return func() {
			a.jd.calls, a.jd.stats = cl, st
			keys := make([]string, len(cl.Calls))
			for i, jc := range cl.Calls {
				keys[i] = fmt.Sprint(jc.ID)
			}
			a.noteList("judge", keys)
			if rerr == nil {
				a.jd.routes, a.jd.hasRoute = rt, true
			}
			if a.jd.sel == 0 && len(cl.Calls) > 0 {
				a.selectJudge(cl.Calls[0].ID)
			}
		}, nil
	})
}

func (a *App) selectJudge(id int64) {
	a.jd.sel, a.jd.detail = id, nil
	a.async("judge-detail", func(ctx context.Context) (func(), error) {
		d, err := a.Client.JudgeCall(ctx, id)
		if err != nil {
			return nil, err
		}
		return func() {
			if a.jd.sel == id {
				a.jd.detail = &d
			}
		}, nil
	})
}

func (a *App) judgeView(c *ui.Context) {
	if a.jd.tab == 0 {
		a.judgeKeys(c)
	}
	ui.Column(c).Fill().Padding(0, 24, 16, 24).Gap(12).MinHeight(0).Children(func() {
		ui.Row(c).FillWidth().AlignItems(ui.Center).Children(func() {
			ui.Segmented(c, &a.jd.tab, "裁决记录", "路由与健康")
			ui.Spacer(c)
			if a.status != nil {
				a.muted(c, "judge 只给建议（忽略 / 建议 / 拦截建议），真正的拦截由模式决定")
			}
		})
		if msg := a.errOf("judge"); msg != "" {
			a.errLine(c, msg)
		}
		if a.jd.tab == 0 {
			a.judgeRecords(c)
		} else {
			a.judgeRoutes(c)
		}
	})
}

// verdictChip 画 judge 的判定。它只是建议，不是拦截：用中性圆角标签，绝不使用盾牌/实心块。
func (a *App) verdictChip(c *ui.Context, v string) {
	p := a.pl
	name := map[string]string{"ignore": "判定 · 忽略", "advise": "判定 · 建议", "block": "判定 · 建议拦截"}[v]
	if name == "" {
		name = "无判定"
	}
	ui.Row(c).Padding(2, 8).Radius(6).Border(1, p.Line).Children(func() {
		ui.Text(c, name).FontSize(12).TextColor(p.Text).SingleLine()
	}).Tooltip("judge 的判定只是建议；是否真的拦截取决于模式与规则")
}

func (a *App) statusPill(c *ui.Context, st string) {
	p := a.pl
	switch st {
	case "ok":
		a.pill(c, "成功", p.Ok, p.OkSoft)
	case "parse_fail":
		a.pill(c, "解析失败", p.Warn, p.WarnSoft)
	case "timeout":
		a.pill(c, "超时", p.Warn, p.WarnSoft)
	case "degraded":
		a.pill(c, "▲ 降级", p.Warn, p.WarnSoft)
	default:
		a.pill(c, st, p.Danger, p.DangerSoft)
	}
}

func fmtMs(p *float64) string {
	if p == nil {
		return "–"
	}
	if *p >= 1000 {
		return fmt.Sprintf("%.1f s", *p/1000)
	}
	return fmt.Sprintf("%.0f ms", *p)
}

func (a *App) judgeRecords(c *ui.Context) {
	t := a.jd.calls.Totals
	okRate := 0.0
	if t.Calls > 0 {
		okRate = float64(t.Ok) / float64(t.Calls)
	}
	ui.Row(c).FillWidth().Gap(10).AlignItems(ui.Stretch).Children(func() {
		a.statCardJ(c, "调用", fmt.Sprint(t.Calls), fmt.Sprintf("成功 %d · 失败 %d · 解析失败 %d", t.Ok, t.Failed, t.ParseFail))
		a.statCardJ(c, "成功率", fmt.Sprintf("%.0f%%", okRate*100), "")
		a.statCardJ(c, "延迟 p50 / p95", fmtMs(t.LatencyP50)+" / "+fmtMs(t.LatencyP95), "")
		a.statCardJ(c, "Token", Compact(t.PromptTokens+t.CompletionTokens), fmt.Sprintf("输入 %s · 输出 %s · 缓存 %s", Compact(t.PromptTokens), Compact(t.CompletionTokens), Compact(t.CachedTokens)))
		cost := "–"
		if t.CostUsd != nil {
			cost = fmt.Sprintf("$%.2f", *t.CostUsd)
		}
		a.statCardJ(c, "成本", cost, "")
	})
	ui.Row(c).Grow(1).MinHeight(0).Gap(14).AlignItems(ui.Stretch).Children(func() {
		calls := a.jd.calls.Calls
		if len(calls) == 0 {
			a.card(c).Grow(1).Children(func() {
				a.emptyState(c, "scale", "还没有 judge 调用", "规则触发需要强模型复核时会出现在这里")
			})
			return
		}
		ui.Column(c).Grow(1).MinWidth(0).MinHeight(0).Children(func() {
			a.jd.list.Key = func(i int) any { return calls[i].ID }
			ui.List(c, &a.jd.list, len(calls), func(i int) { a.judgeRow(c, calls[i]) }).Grow(1).MinHeight(0)
		})
		if a.jd.open && a.jd.detail != nil {
			a.sidePanel(c, 0, 0, func() {
				a.panelHeader(c, fmt.Sprintf("裁决 #%d", a.jd.sel), func() { a.jd.open = false })
				a.judgeDetail(c)
			})
		}
	})
}

// judgeKeys：J/K 移动选中的调用（面板已开时右侧跟着切），Enter 打开详情。
func (a *App) judgeKeys(c *ui.Context) {
	calls := a.jd.calls.Calls
	cur := -1
	for i, jc := range calls {
		if jc.ID == a.jd.sel {
			cur = i
		}
	}
	if dir := a.moveDir(c); dir != 0 {
		if i := stepIndex(cur, dir, len(calls)); i >= 0 {
			a.selectJudge(calls[i].ID)
			a.jd.list.ScrollIntoView(i)
		}
	} else if a.enterPressed(c) && cur >= 0 {
		a.jd.open = true
	}
}

func (a *App) statCardJ(c *ui.Context, title, value, note string) {
	p := a.pl
	a.card(c).Grow(1).Basis(0).Gap(2).Padding(12, 16).Children(func() {
		a.muted(c, title)
		ui.Text(c, value).FontSize(22).FontWeight(700).FontFeatures("tnum").SingleLine()
		if note != "" {
			a.txt(c, note, 11, p.Muted).SingleLine()
		}
	})
}

func (a *App) judgeRow(c *ui.Context, jc api.JudgeCall) {
	p := a.pl
	row := ui.Column(c).Key(jc.ID).FillWidth().Margin(0, 0, 6, 0).Gap(6).Padding(11, 12).Radius(8).Border(1, p.Line)
	row = a.markFresh(row, "judge", fmt.Sprint(jc.ID))
	row = a.hoverable(row, a.jd.sel == jc.ID)
	row = row.ContextMenu(func(m *ui.Menu) {
		if m.Item("查看详情").Shortcut(0, ui.KeyEnter).Chosen() {
			a.selectJudge(jc.ID)
			a.jd.open = true
		}
		m.Separator()
		if m.Item("复制调用 ID").Chosen() {
			c.WriteClipboard(fmt.Sprint(jc.ID))
		}
		if m.Item("复制会话 ID").Chosen() {
			c.WriteClipboard(jc.SessionID)
		}
	})
	row.Children(func() {
		ui.Row(c).FillWidth().Gap(8).AlignItems(ui.Center).Children(func() {
			ui.Text(c, fmt.Sprintf("#%d", jc.ID)).Font("monospace").FontSize(13).FontWeight(700)
			a.statusPill(c, jc.Status)
			if jc.Verdict != nil {
				a.verdictChip(c, *jc.Verdict)
			}
			ui.Spacer(c)
			a.txt(c, a.rel(jc.Ts), 11, p.Muted)
		})
		ui.Row(c).FillWidth().Gap(8).AlignItems(ui.Center).Children(func() {
			for _, r := range jc.RuleIds {
				a.pill(c, r, p.Text, p.Shade).Font("monospace")
			}
			if jc.Sync {
				a.pill(c, "同步", p.Muted, p.Shade)
			}
			ui.Spacer(c)
			a.txt(c, Or(Str(jc.Model), "–")+" · "+fmtMs(jc.LatencyMs), 11, p.Muted)
		})
		if jc.Error != nil {
			a.txt(c, *jc.Error, 11, p.Warn).SingleLine()
		}
	})
	if row.Clicked() {
		a.selectJudge(jc.ID)
		a.jd.open = true
	}
}

func (a *App) judgeDetail(c *ui.Context) {
	p := a.pl
	d := a.jd.detail
	if d == nil {
		a.card(c).FillWidth().Children(func() { a.muted(c, "选择一条裁决查看详情") })
		return
	}
	a.card(c).FillWidth().Gap(10).Children(func() {
		ui.Row(c).Gap(10).AlignItems(ui.Center).Children(func() {
			ui.Text(c, fmt.Sprintf("judge 调用 #%d", d.ID)).FontSize(16).FontWeight(650)
			a.statusPill(c, d.Status)
			if d.Verdict != nil {
				a.verdictChip(c, *d.Verdict)
			}
			if d.Confidence != nil {
				a.muted(c, fmt.Sprintf("置信度 %.0f%%", *d.Confidence*100))
			}
		})
		if r := Str(d.Reason); r != "" {
			ui.Text(c, r).FontSize(14)
		}
		if m := Str(d.MessageRaw); m != "" {
			a.label(c, "给 agent 的话（原文）")
			ui.Text(c, m).FontSize(13).Selectable().Padding(10, 12).Radius(6).Background(p.Card2).FillWidth()
		}
		if d.Error != nil {
			a.errLine(c, *d.Error)
		}
	})
	a.card(c).FillWidth().Gap(8).Children(func() {
		a.label(c, "调用信息")
		a.kv(c, "会话", d.SessionID)
		a.kv(c, "规则", fmt.Sprint(d.RuleIds))
		a.kv(c, "路由 → 实际模型", Or(Str(d.RouteModel), "–")+" → "+Or(Str(d.Model), "–"))
		a.kv(c, "延迟", fmtMs(d.LatencyMs))
		if d.PromptTokens != nil && d.CompletionTokens != nil {
			a.kv(c, "Token", fmt.Sprintf("输入 %.0f · 输出 %.0f · 缓存 %.0f", *d.PromptTokens, *d.CompletionTokens, func() float64 {
				if d.CachedTokens != nil {
					return *d.CachedTokens
				}
				return 0
			}()))
		}
		if d.CostUsd != nil {
			a.kv(c, "成本", fmt.Sprintf("$%.4f", *d.CostUsd))
		}
		a.kv(c, "响应格式", Or(Str(d.FormatLevel), "–")+map[bool]string{true: "（已降级）", false: ""}[d.FormatDowngraded])
		if len(d.Repairs) > 0 {
			a.kv(c, "修复", fmt.Sprint(d.Repairs))
		}
		a.kv(c, "请求/响应体", map[bool]string{true: "已保存", false: "未保存"}[d.BodiesStored])
	})
	if len(d.Decisions) > 0 {
		a.card(c).FillWidth().Gap(8).Children(func() {
			a.label(c, "因此产生的决策")
			for _, dc := range d.Decisions {
				ui.Row(c).FillWidth().Gap(8).AlignItems(ui.Center).Children(func() {
					ui.Text(c, "动作 "+ms(dc, "action")).FontSize(13)
					a.outcomeChip(c, ms(dc, "outcome"), ms(dc, "mode"))
				})
			}
		})
	}
}

// ---- 路由与健康 ----

func (a *App) judgeRoutes(c *ui.Context) {
	p := a.pl
	if !a.jd.hasRoute {
		a.card(c).FillWidth().Children(func() { a.emptyState(c, "scale", "路由信息还没加载", "") })
		return
	}
	rt := a.jd.routes
	ui.Scroll(c).Grow(1).MinHeight(0).Children(func() {
		ui.Column(c).FillWidth().Gap(14).Children(func() {
			a.card(c).FillWidth().Gap(6).Children(func() {
				ui.Row(c).Gap(10).AlignItems(ui.Center).Children(func() {
					a.statusPill(c, map[bool]string{true: "ok", false: "off"}[rt.Enabled])
					ui.Text(c, "默认模型 "+Or(rt.DefaultModel, "–")).FontSize(14).FontWeight(600)
					ui.Spacer(c)
					a.txt(c, rt.BaseUrl, 12, p.Muted).Font("monospace")
				})
				a.muted(c, "每次调用按顺序匹配下面的路由，第一个命中的路由决定用哪个模型；都不命中时用默认模型。")
			})
			ui.Row(c).FillWidth().Gap(14).AlignItems(ui.Stretch).Children(func() {
				ui.Column(c).Grow(3).Basis(0).MinWidth(0).Gap(0).Children(func() {
					for i, r := range rt.Routes {
						a.routeCard(c, i, r)
						if i < len(rt.Routes)-1 {
							ui.Row(c).FillWidth().Height(26).Justify(ui.Center).AlignItems(ui.Center).Children(func() {
								ui.Box(c).Width(1.5).Height(26).Background(p.Line)
								a.txt(c, "未命中，继续往下", 11, p.Muted).Margin(0, 0, 0, 8)
							})
						}
					}
				})
				a.card(c).Grow(2).Basis(0).MinWidth(0).Gap(10).Children(func() { a.judgeModelStats(c) })
			})
		})
	})
}

func (a *App) routeCard(c *ui.Context, i int, r api.JudgeRouteRow) {
	p := a.pl
	a.card(c).FillWidth().Gap(10).Children(func() {
		ui.Row(c).FillWidth().Gap(10).AlignItems(ui.Center).Children(func() {
			label := "默认"
			if r.Index != nil {
				label = fmt.Sprint(*r.Index + 1)
			}
			ui.Box(c).Size(26, 26).Radius(13).Background(p.Shade).Center().Children(func() {
				ui.Text(c, label).FontSize(12).FontWeight(700).TextColor(p.Text)
			}).Width(Or2(r.Index == nil, 44, 26)).Radius(13)
			ui.Text(c, r.Use).FontSize(14).FontWeight(600)
			icon(c, "arrow-right", 14, p.Muted)
			ui.Text(c, r.Model).Font("monospace").FontSize(13)
			ui.Spacer(c)
			a.statusPill(c, r.Status)
		})
		ui.Row(c).FillWidth().Gap(18).Children(func() {
			a.mini(c, "调用", fmt.Sprint(r.Calls))
			a.mini(c, "成功", fmt.Sprint(r.Ok))
			a.mini(c, "解析失败", Pct(r.ParseFailRate))
			a.mini(c, "超时 / 错误", fmt.Sprintf("%d / %d", r.Timeouts, r.Errors))
			a.mini(c, "p95", fmtMs(r.LatencyP95))
			a.mini(c, "响应格式", Or(Str(r.FormatLevel), "–")+map[bool]string{true: fmt.Sprintf("（降级 %d 次）", r.FormatDowngrades), false: ""}[r.FormatDowngrades > 0])
		})
		if r.ParseFailRate != nil {
			ui.Meter(c, *r.ParseFailRate, 0, 1, &ui.MeterLevels{Warning: 0.05, Critical: 0.2}).Label("解析失败率").FillWidth()
		}
		for _, why := range r.Reasons {
			a.txt(c, "· "+why, 12, p.Muted)
		}
		if r.LastFailureID != nil {
			ui.Row(c).FillWidth().Gap(8).Padding(8, 12).Radius(6).Background(p.WarnSoft).AlignItems(ui.Center).Children(func() {
				icon(c, "circle-alert", 14, p.Warn)
				ui.Text(c, fmt.Sprintf("最近失败 #%d · %s · %s", *r.LastFailureID, Str(r.LastFailureStatus), Str(r.LastFailureError))).FontSize(12).TextColor(p.Warn)
			})
		}
	})
}

// Or2 在条件为真时给 a，否则 b。
func Or2(cond bool, a, b float32) float32 {
	if cond {
		return a
	}
	return b
}

func (a *App) mini(c *ui.Context, k, v string) {
	ui.Column(c).Gap(1).Children(func() {
		a.txt(c, k, 11, a.pl.Muted)
		ui.Text(c, v).FontSize(14).FontWeight(600).FontFeatures("tnum")
	})
}

func (a *App) judgeModelStats(c *ui.Context) {
	p := a.pl
	a.label(c, "按模型汇总")
	rows := append([]api.JudgeStat(nil), a.jd.stats...)
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].Calls > rows[j].Calls })
	if len(rows) == 0 {
		a.muted(c, "暂无")
		return
	}
	for _, s := range rows {
		ui.Column(c).FillWidth().Gap(5).Padding(10, 12).Radius(6).Background(p.Card2).Children(func() {
			ui.Row(c).FillWidth().AlignItems(ui.Center).Children(func() {
				ui.Text(c, s.Model).Font("monospace").FontSize(13).FontWeight(600)
				ui.Spacer(c)
				a.txt(c, fmt.Sprintf("%d 次 · $%.2f", s.Calls, s.CostUsd), 12, p.Muted)
			})
			ui.Row(c).FillWidth().Gap(14).Children(func() {
				a.mini(c, "忽略", fmt.Sprint(s.Ignores))
				a.mini(c, "建议", fmt.Sprint(s.Advises))
				a.mini(c, "建议拦截", fmt.Sprint(s.Blocks))
				a.mini(c, "p50 / p95", fmtMs(s.LatencyP50)+" / "+fmtMs(s.LatencyP95))
			})
		})
	}
}
