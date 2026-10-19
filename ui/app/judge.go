package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strings"

	"github.com/Fan-chou/agent-supervisor/ui/api"
	"github.com/egoist/mygo/ui"
)

type judgePage struct {
	calls   []api.JudgeCall
	totals  api.JudgeCallListTotals
	stats   []api.JudgeStat
	loaded  bool
	list    ui.ListState
	sel     int
	selID   int64
	focusID int64 // 从命中详情跳进来：加载后选中它
	detail  map[int64]api.JudgeCallDetail

	verdict, status, syncSel string
	query                    string
	withCache                bool
	cacheInit                bool

	cfg       *api.ConfigView
	cfgLoaded bool
	routeList ui.ListState
	routeSel  int
}

func (a *App) loadJudge() {
	j := &a.j
	if !j.cacheInit {
		j.withCache, j.cacheInit = true, true
		if j.syncSel == "" {
			j.syncSel = "同步/异步"
		}
	}
	q := url.Values{"limit": {"200"}}
	if j.verdict != "" && j.verdict != "全部裁决" {
		q.Set("verdict", j.verdict)
	}
	if j.status != "" && j.status != "全部状态" {
		q.Set("status", j.status)
	}
	switch j.syncSel {
	case "同步":
		q.Set("sync", "true")
	case "异步":
		q.Set("sync", "false")
	}
	if j.query != "" {
		q.Set("q", j.query)
	}
	q.Set("cache", map[bool]string{true: "include", false: "exclude"}[j.withCache])
	a.async("judge", func(ctx context.Context) (func(), error) {
		l, err := a.Client.JudgeCalls(ctx, q)
		if err != nil {
			return nil, err
		}
		st, serr := a.Client.JudgeStats(ctx, nil)
		return func() {
			a.j.calls, a.j.totals, a.j.loaded = l.Calls, l.Totals, true
			if serr == nil {
				a.j.stats = st
			}
			if a.j.focusID != 0 {
				for i, c := range a.j.calls {
					if c.ID == a.j.focusID {
						a.j.sel, a.j.selID = i, c.ID
					}
				}
				a.j.focusID = 0
			}
			a.loadJudgeDetail()
		}, nil
	})
}

func (a *App) loadJudgeDetail() {
	id := a.j.selID
	if id == 0 {
		return
	}
	a.async("judge-detail", func(ctx context.Context) (func(), error) {
		d, err := a.Client.JudgeCall(ctx, id)
		if err != nil {
			return nil, err
		}
		return func() {
			if a.j.detail == nil {
				a.j.detail = map[int64]api.JudgeCallDetail{}
			}
			a.j.detail[id] = d
		}, nil
	})
}

func (a *App) loadRouting() {
	a.async("config", func(ctx context.Context) (func(), error) {
		cv, err := a.Client.Config(ctx)
		if err != nil {
			return nil, err
		}
		st, serr := a.Client.JudgeStats(ctx, nil)
		l, lerr := a.Client.JudgeCalls(ctx, url.Values{"limit": {"200"}})
		return func() {
			a.j.cfg, a.j.cfgLoaded = &cv, true
			if serr == nil {
				a.j.stats = st
			}
			if lerr == nil {
				a.j.calls, a.j.totals = l.Calls, l.Totals
			}
		}, nil
	})
}

func (a *App) judgeView(c *ui.Context) {
	p := palOf(c)
	j := &a.j
	if !j.cacheInit {
		a.loadJudge()
	}
	pv, ps, py, pq, pc := j.verdict, j.status, j.syncSel, j.query, j.withCache
	ui.Row(c).FillWidth().Padding(10, 14).Gap(10).AlignItems(ui.Center).Children(func() {
		ui.Select(c, &j.verdict, []string{"全部裁决", "ignore", "advise", "block"}).Width(120).Label("裁决")
		ui.Select(c, &j.status, []string{"全部状态", "ok", "parse_fail", "timeout", "error"}).Width(120).Label("状态")
		ui.Select(c, &j.syncSel, []string{"同步/异步", "同步", "异步"}).Width(110).Label("同步或异步")
		ui.Checkbox(c, &j.withCache, "含缓存 tokens")
		ui.SearchField(c, &j.query).Width(220).Label("搜索 judge 调用")
		ui.Spacer(c)
		ui.Text(c, "X2 是本地规则，从不送 judge，所以这里没有危险行").FontSize(11).TextColor(p.Muted)
	})
	if pv != j.verdict || ps != j.status || py != j.syncSel || pq != j.query || pc != j.withCache {
		a.loadJudge()
	}
	if e := a.errOf("judge"); e != "" {
		a.errBar(c, "加载失败："+e, a.loadJudge)
	}
	if !j.loaded {
		a.emptyNote(c, "正在加载 judge 调用…")
		return
	}
	// 合计条
	tot := j.totals
	ignore, calls := int64(0), int64(0)
	for _, s := range j.stats {
		ignore += s.Ignores
		calls += s.Calls
	}
	ui.Row(c).FillWidth().Padding(0, 14, 6, 14).Gap(14).AlignItems(ui.Center).Children(func() {
		ui.Textf(c, "调用 %d · ok %d · 失败 %d（parse_fail %d）", tot.Calls, tot.Ok, tot.Failed, tot.ParseFail).FontSize(13)
		if calls > 0 {
			ui.Textf(c, "ignore %.0f%%", 100*float64(ignore)/float64(calls)).FontSize(13)
		}
		pt := tot.PromptTokens
		if !j.withCache {
			pt -= tot.CachedTokens
		}
		ui.Textf(c, "prompt %s（%s）· completion %s", Compact(pt), map[bool]string{true: "含缓存", false: "不含缓存"}[j.withCache], Compact(tot.CompletionTokens)).FontSize(13)
		ui.Textf(c, "延迟 p50 %s · p95 %s", ms(tot.LatencyP50), ms(tot.LatencyP95)).FontSize(13)
		ui.Text(c, "成本 "+cost(tot.CostUsd)).FontSize(13)
	})
	a.judgeWarnings(c)
	if len(j.calls) == 0 {
		a.judgeEmpty(c)
		return
	}
	ui.Row(c).Grow(1).MinHeight(0).Padding(0, 14, 10, 14).Gap(12).AlignItems(ui.Stretch).Children(func() {
		a.judgeTable(c)
		if d, ok := j.detail[j.selID]; ok {
			a.judgeDetailPanel(c, d)
		}
	})
}

func ms(v *float64) string {
	if v == nil {
		return "–"
	}
	return fmt.Sprintf("%.1fs", *v/1000)
}

func cost(v *float64) string {
	if v == nil {
		return "n/a"
	}
	return fmt.Sprintf("$%.3f", *v)
}

// judgeWarnings：judge 最近失败/解析失败率超线（样本 ≥10，15%）要明显提示（§4.1、design §8.5）。
func (a *App) judgeWarnings(c *ui.Context) {
	p := palOf(c)
	for _, s := range a.j.stats {
		if s.Calls >= 10 && s.ParseFailRate != nil && *s.ParseFailRate > 0.15 {
			banner(c, p.Warn, p.WarnBg, fmt.Sprintf("judge 模型 %s 的 parse_fail 率 %s 超过 15%%（样本 %d）：建议调整路由组", s.Model, Pct(s.ParseFailRate), s.Calls))
		}
	}
	fails := 0
	last := ""
	for _, call := range a.j.calls {
		if call.Status != "ok" {
			fails++
			if last == "" {
				last = Or(Str(call.Error), call.Status)
			}
		} else {
			break // 只数最近连续的失败
		}
	}
	if fails >= 3 {
		banner(c, p.Danger, p.DangerBg, fmt.Sprintf("最近 %d 次 judge 调用连续失败：%s", fails, last))
	}
}

// judgeEmpty 区分「没有任何裁决」的原因（§4.1）。
func (a *App) judgeEmpty(c *ui.Context) {
	p := palOf(c)
	ui.Column(c).Grow(1).Center().Gap(8).Children(func() {
		ui.Text(c, "没有符合条件的 judge 调用").Bold().FontSize(16)
		switch {
		case a.status != nil && !a.status.Judge.Enabled:
			ui.Text(c, "judge 未启用（--judge=off 或未配置）。配置见「Judge 路由」。").TextColor(p.Muted)
		default:
			ui.Text(c, "judge 已启用，但还没有 M 级命中触发它，或本会话预算已用完（judge n/12）。").TextColor(p.Muted)
		}
	})
}

func (a *App) judgeTable(c *ui.Context) {
	p := palOf(c)
	j := &a.j
	cols := []ui.TableColumn{
		{Title: "时间", Width: 118}, {Title: "会话", Width: 96}, {Title: "规则", Width: 64}, {Title: "同步", Width: 46},
		{Title: "裁决", Width: 62}, {Title: "置信", Width: 44, Align: ui.End}, {Title: "judge 模型", MinWidth: 110}, {Title: "状态", Width: 86},
		{Title: "延迟", Width: 52, Align: ui.End}, {Title: "tokens in/out", Width: 96, Align: ui.End}, {Title: "成本", Width: 56, Align: ui.End},
	}
	j.list.Selected = &j.sel
	j.list.Key = func(i int) any { return j.calls[i].ID }
	tbl := ui.Table(c, &j.list, cols, len(j.calls), func(i, col int) {
		r := j.calls[i]
		t := func(s string) ui.Element { return ui.Text(c, s).FontSize(13).SingleLine() }
		switch col {
		case 0:
			t(FmtTime(r.Ts)).Tooltip(FmtISO(r.Ts))
		case 1:
			t(ShortID(r.SessionID)).Tooltip(r.SessionID)
		case 2:
			t(strings.Join(r.RuleIds, " "))
		case 3:
			t(map[bool]string{true: "同步", false: "异步"}[r.Sync])
		case 4:
			if r.Verdict != nil {
				col := p.Muted
				if *r.Verdict == "block" {
					col = p.Danger
				} else if *r.Verdict == "advise" {
					col = p.Warn
				}
				t(*r.Verdict).TextColor(col).Bold()
			} else {
				t("–").TextColor(p.Muted)
			}
		case 5:
			t(Num(r.Confidence, 2))
		case 6:
			label := Or(Str(r.Model), "–")
			if r.FormatDowngraded {
				label += " ⤓"
			}
			t(label).Tooltip("路由：" + Or(Str(r.RouteModel), "–") + "；⤓ = response_format 已降级")
		case 7:
			if r.Status == "ok" {
				t("● ok").TextColor(p.Ok)
			} else {
				t("✕ " + r.Status).TextColor(p.Danger).Tooltip(Str(r.Error))
			}
		case 8:
			t(ms(r.LatencyMs))
		case 9:
			t(fmt.Sprintf("%s / %s", Compact(ptrF(r.PromptTokens)), Compact(ptrF(r.CompletionTokens))))
		case 10:
			t(cost(r.CostUsd))
		}
	}).Grow(1).MinWidth(0).Label("judge 调用列表")
	if tbl.Changed() && j.sel >= 0 && j.sel < len(j.calls) && j.calls[j.sel].ID != j.selID {
		j.selID = j.calls[j.sel].ID
		a.loadJudgeDetail()
	}
}

func ptrF(p *float64) float64 {
	if p == nil {
		return 0
	}
	return *p
}

func (a *App) judgeDetailPanel(c *ui.Context, d api.JudgeCallDetail) {
	p := palOf(c)
	ui.Scroll(c).Width(400).Shrink(0).Children(func() {
		ui.Column(c).FillWidth().Gap(10).Children(func() {
			section(c, fmt.Sprintf("judge 调用 #%d", d.ID), func() {
				st := "● ok"
				if d.Status != "ok" {
					st = "✕ " + d.Status
				}
				kv(c, "状态", st)
				kv(c, "裁决", Or(Str(d.Verdict), "–")+" · 置信 "+Num(d.Confidence, 2)+" · category "+Or(Str(d.Category), "–"))
				if d.Error != nil {
					kv(c, "错误", *d.Error)
				}
				kv(c, "模型", Or(Str(d.Model), "–")+"（路由："+Or(Str(d.RouteModel), "–")+"）")
				kv(c, "同步/异步", map[bool]string{true: "同步", false: "异步"}[d.Sync])
				kv(c, "延迟 / 重试 / HTTP", fmt.Sprintf("%s / %s / %s", ms(d.LatencyMs), Num(d.Retries, 0), Num(d.HttpRequests, 0)))
				fl := Or(Str(d.FormatLevel), "–")
				if d.FormatDowngraded {
					fl += "（上游拒绝，已降级并缓存）"
				}
				kv(c, "response_format", fl)
				kv(c, "tokens", fmt.Sprintf("prompt %s（缓存 %s）· completion %s", Compact(ptrF(d.PromptTokens)), Compact(ptrF(d.CachedTokens)), Compact(ptrF(d.CompletionTokens))))
				kv(c, "成本", cost(d.CostUsd))
				kv(c, "触发规则", strings.Join(d.RuleIds, " "))
				kv(c, "时间", FmtTime(d.Ts))
			})
			if !d.BodiesStored {
				banner(c, p.Warn, p.WarnBg, "该记录没有保存请求/响应正文（store_judge_bodies=false 或已过保留期），仍显示统计字段。")
			} else {
				if d.Response != nil {
					b, _ := json.MarshalIndent(d.Response, "", "  ")
					section(c, "上游返回（脱敏；不含 key 与 Authorization 头）", func() { mono(c, string(b)).MaxHeight(160) })
				}
				if d.Request != nil {
					b, _ := json.MarshalIndent(d.Request, "", "  ")
					section(c, "请求摘要（脱敏；不可信内容灰底）", func() { mono(c, string(b)).MaxHeight(160) })
				}
			}
			section(c, "解析与修复", func() {
				if len(d.Repairs) == 0 {
					ui.Text(c, "无修复步骤").FontSize(12).TextColor(p.Muted)
				} else {
					kv(c, "修复步骤", strings.Join(d.Repairs, "，"))
				}
				if d.Reason != nil {
					kv(c, "reason", *d.Reason)
				}
			})
			if d.MessageRaw != nil {
				section(c, "消息（message_to_agent 原文）", func() { mono(c, *d.MessageRaw) })
			}
			section(c, "关联与可复制命令", func() {
				if len(d.Hits) > 0 {
					id := mstr(d.Hits[0], "id")
					mono(c, "sv explain "+id)
					if ui.Button(c, "复制 sv explain").Clicked() {
						c.WriteClipboard("sv explain " + id)
						c.Toast("已复制（界面不会执行它）")
					}
				}
				if ui.Button(c, "打开该会话的事件时间线").Clicked() {
					a.openSession(d.SessionID, 0, "")
				}
			})
		})
	})
}

// ---- Judge 路由 ----
// /v1/judge/routes 还没有（design §9 的计划接口），所以这页只用 /v1/config + /v1/judge-calls/stats + judge_calls 记录，
// 能推出什么就显示什么；推不出的（降级原因的具体 4xx 文本）不编造。见 decisions #129。

type routeRow struct {
	Use, Model, Reason string
	Stat               *api.JudgeStat
}

// RoutesFromConfig 从生效配置里取 judge.routes（match + model）和默认模型。
func RoutesFromConfig(cfg map[string]any) (rows []routeRow, enabled bool, baseURL string) {
	jm, _ := cfg["judge"].(map[string]any)
	if jm == nil {
		return nil, false, ""
	}
	enabled, _ = jm["enabled"].(bool)
	baseURL, _ = jm["base_url"].(string)
	if rs, ok := jm["routes"].([]any); ok {
		for i, r := range rs {
			rm, _ := r.(map[string]any)
			if rm == nil {
				continue
			}
			use := "（未写匹配条件）"
			if m, ok := rm["match"].(map[string]any); ok {
				var parts []string
				for k, v := range m {
					parts = append(parts, fmt.Sprintf("%s=%v", k, v))
				}
				sort.Strings(parts)
				use = strings.Join(parts, " ")
			}
			model, _ := rm["model"].(string)
			rows = append(rows, routeRow{Use: use, Model: model, Reason: fmt.Sprintf("routes[%d] 命中", i)})
		}
	}
	def, _ := jm["model"].(string)
	rows = append(rows, routeRow{Use: "默认", Model: def, Reason: "没有路由命中时走 judge.model"})
	return rows, enabled, baseURL
}

// RouteStatus 给每个目标一个状态：未使用 / 正常 / 降级中（解析失败率超线或 response_format 已降级）。
func RouteStatus(s *api.JudgeStat) (string, string) {
	switch {
	case s == nil || s.Calls == 0:
		return "未使用", "近期没有调用"
	case s.Calls >= 10 && s.ParseFailRate != nil && *s.ParseFailRate > 0.15:
		return "降级中", fmt.Sprintf("parse_fail 率 %s 高于警告线 15%%（样本 ≥10）", Pct(s.ParseFailRate))
	case s.FormatDowngrades > 0:
		return "降级中", fmt.Sprintf("response_format 已降级 %d 次", s.FormatDowngrades)
	case s.Timeouts+s.Errors > 0 && s.Ok == 0:
		return "不可用", "没有成功的调用"
	}
	return "正常", ""
}

func (a *App) routingView(c *ui.Context) {
	p := palOf(c)
	j := &a.j
	if e := a.errOf("config"); e != "" {
		a.errBar(c, "加载失败："+e, a.loadRouting)
	}
	if !j.cfgLoaded {
		a.emptyNote(c, "正在加载 judge 配置…")
		return
	}
	rows, enabled, baseURL := RoutesFromConfig(j.cfg.Config)
	byModel := map[string]*api.JudgeStat{}
	for i := range j.stats {
		byModel[j.stats[i].Model] = &j.stats[i]
	}
	ui.Scroll(c).Grow(1).Padding(10, 14).Children(func() {
		ui.Column(c).FillWidth().Gap(12).Children(func() {
			banner(c, p.Muted, p.Faint, "路由只读：改路由请编辑 config.yaml。状态与原因来自 judge_calls 记录，不是界面猜的。")
			if !enabled {
				ui.Text(c, "judge 未启用（--judge=off 或未配置）").Bold().FontSize(16)
			}
			section(c, "judge 配置", func() {
				kv(c, "base_url", baseURL)
				kv(c, "key", fmt.Sprintf("环境变量 %s（%s）", j.cfg.Judge.ApiKeyEnv, map[bool]string{true: "已设置", false: "未设置"}[j.cfg.Judge.ApiKeySet]))
				if len(rows) == 1 {
					ui.Text(c, "没有配置路由：所有调用走 judge.model。").FontSize(12).TextColor(p.Muted)
				}
			})
			cols := []ui.TableColumn{{Title: "用途（匹配条件）", MinWidth: 180}, {Title: "当前模型", Width: 170}, {Title: "状态", Width: 90}, {Title: "模型近期调用", Width: 100, Align: ui.End}, {Title: "parse_fail", Width: 84, Align: ui.End}, {Title: "p95", Width: 64, Align: ui.End}, {Title: "为什么这样走", MinWidth: 220}}
			j.routeList.Selected = &j.routeSel
			ui.Table(c, &j.routeList, cols, len(rows), func(i, col int) {
				r := rows[i]
				s := byModel[r.Model]
				st, why := RouteStatus(s)
				t := func(x string) ui.Element { return ui.Text(c, x).FontSize(13).SingleLine() }
				switch col {
				case 0:
					t(r.Use)
				case 1:
					t(Or(r.Model, "–"))
				case 2:
					col := p.Ok
					switch st {
					case "降级中":
						col = p.Warn
					case "不可用":
						col = p.Danger
					case "未使用":
						col = p.Muted
					}
					t(map[string]string{"正常": "● 正常", "降级中": "▲ 降级中", "不可用": "✕ 不可用", "未使用": "○ 未使用"}[st]).TextColor(col).Bold()
				case 3:
					if s == nil {
						t("–")
					} else {
						t(fmt.Sprint(s.Calls))
					}
				case 4:
					if s == nil || s.Calls == 0 {
						t("–")
					} else {
						t(Pct(s.ParseFailRate))
					}
				case 5:
					if s == nil {
						t("–")
					} else {
						t(ms(s.LatencyP95))
					}
				case 6:
					t(Or(why, r.Reason)).TextColor(p.dim(i == j.routeSel))
				}
			}).Height(float32(36 + 34*len(rows))).Label("judge 路由表")
			if j.routeSel >= 0 && j.routeSel < len(rows) {
				r := rows[j.routeSel]
				s := byModel[r.Model]
				section(c, "选中「"+r.Use+"」", func() {
					kv(c, "走向", Or(r.Model, "–")+" · "+r.Reason)
					if s != nil {
						kv(c, "调用", fmt.Sprintf("%d（ok %d · 超时 %d · 出错 %d · parse_fail %d）", s.Calls, s.Ok, s.Timeouts, s.Errors, s.ParseFail))
						kv(c, "response_format 降级", fmt.Sprintf("%d 次", s.FormatDowngrades))
						kv(c, "裁决分布", fmt.Sprintf("ignore %d · advise %d · block %d（ignore 率 %s）", s.Ignores, s.Advises, s.Blocks, Pct(s.IgnoreRate)))
						kv(c, "tokens", fmt.Sprintf("prompt %s（缓存 %s）· completion %s", Compact(s.PromptTokens), Compact(s.CachedTokens), Compact(s.CompletionTokens)))
						kv(c, "成本", fmt.Sprintf("$%.3f", s.CostUsd))
					}
					for _, call := range j.calls {
						if Str(call.Model) == r.Model && call.Status != "ok" {
							kv(c, "最近一次失败", fmt.Sprintf("%s %s：%s", FmtTime(call.Ts), call.Status, Or(Str(call.Error), "–")))
							if ui.Button(c, "打开该调用").Clicked() {
								a.j.focusID = call.ID
								a.Goto(PageJudge)
							}
							break
						}
					}
				})
			}
		})
	})
}
