package app

import (
	"context"
	"fmt"
	"net/url"

	"github.com/Fan-chou/agent-supervisor/ui/api"
	"github.com/egoist/mygo/ui"
)

// ---- Judge 路由 ----
// 数据来自 GET /v1/judge/routes（后端按 judge_calls 记录算出状态与原因）；界面不推断。

// RouteStatusLabel 把后端的状态枚举翻成列表里的文字。
func RouteStatusLabel(st string) string {
	switch st {
	case "ok":
		return "● 正常"
	case "degraded":
		return "▲ 降级中"
	case "unavailable":
		return "✕ 不可用"
	}
	return "○ 未使用"
}

// RouteReason 是「为什么这样走」列的一行摘要：第一条原因，有更多时带个数。
func RouteReason(r api.JudgeRouteRow) string {
	if len(r.Reasons) == 0 {
		return "–"
	}
	if len(r.Reasons) == 1 {
		return r.Reasons[0]
	}
	return fmt.Sprintf("%s（另 %d 条）", r.Reasons[len(r.Reasons)-1], len(r.Reasons)-1)
}

func (a *App) loadRouting() {
	a.async("config", func(ctx context.Context) (func(), error) {
		cv, err := a.Client.Config(ctx)
		if err != nil {
			return nil, err
		}
		rt, rerr := a.Client.JudgeRoutes(ctx, url.Values{})
		if rerr != nil {
			return nil, rerr
		}
		return func() {
			a.j.cfg, a.j.cfgLoaded = &cv, true
			a.j.routes = &rt
		}, nil
	})
}

func (a *App) routingView(c *ui.Context) {
	p := palOf(c)
	j := &a.j
	if e := a.errOf("config"); e != "" {
		a.errBar(c, "加载失败："+e, a.loadRouting)
	}
	if !j.cfgLoaded || j.routes == nil {
		a.emptyNote(c, "正在加载 judge 路由…")
		return
	}
	rt := j.routes
	rows := rt.Routes
	ui.Scroll(c).Grow(1).Padding(10, 14).Children(func() {
		ui.Column(c).FillWidth().Gap(12).Children(func() {
			banner(c, p.Muted, p.Faint, "路由只读：改路由请编辑 config.yaml。状态与原因由守护进程按 judge_calls 记录算出（近 7 天）。")
			if !rt.Enabled {
				ui.Text(c, "judge 未启用（--judge=off 或未配置）").Bold().FontSize(16)
			}
			section(c, "judge 配置", func() {
				kv(c, "base_url", rt.BaseUrl)
				kv(c, "key", fmt.Sprintf("环境变量 %s（%s）", j.cfg.Judge.ApiKeyEnv, map[bool]string{true: "已设置", false: "未设置"}[j.cfg.Judge.ApiKeySet]))
				if len(rows) == 1 {
					ui.Text(c, "没有配置路由：所有调用走 judge.model。").FontSize(12).TextColor(p.Muted)
				}
			})
			cols := []ui.TableColumn{{Title: "用途（匹配条件）", MinWidth: 180}, {Title: "当前模型", Width: 170}, {Title: "状态", Width: 90}, {Title: "近期调用", Width: 90, Align: ui.End}, {Title: "parse_fail", Width: 84, Align: ui.End}, {Title: "p95", Width: 64, Align: ui.End}, {Title: "为什么这样走", MinWidth: 220}}
			j.routeList.Selected = &j.routeSel
			ui.Table(c, &j.routeList, cols, len(rows), func(i, col int) {
				r := rows[i]
				t := func(x string) ui.Element { return ui.Text(c, x).FontSize(13).SingleLine() }
				switch col {
				case 0:
					t(r.Use)
				case 1:
					t(Or(r.Model, "–"))
				case 2:
					col := p.Ok
					switch r.Status {
					case "degraded":
						col = p.Warn
					case "unavailable":
						col = p.Danger
					case "unused":
						col = p.Muted
					}
					t(RouteStatusLabel(r.Status)).TextColor(col).Bold()
				case 3:
					if r.Calls == 0 {
						t("–")
					} else {
						t(fmt.Sprint(r.Calls))
					}
				case 4:
					if r.Calls == 0 {
						t("–")
					} else {
						t(Pct(r.ParseFailRate))
					}
				case 5:
					if r.Calls == 0 {
						t("–")
					} else {
						t(ms(r.LatencyP95))
					}
				case 6:
					t(RouteReason(r)).TextColor(p.dim(i == j.routeSel))
				}
			}).Height(float32(36 + 34*len(rows))).Label("judge 路由表")
			if j.routeSel >= 0 && j.routeSel < len(rows) {
				r := rows[j.routeSel]
				section(c, "选中「"+r.Use+"」", func() {
					kv(c, "走向", Or(r.Model, "–"))
					for _, why := range r.Reasons {
						kv(c, "原因", why)
					}
					if r.Calls > 0 {
						kv(c, "调用", fmt.Sprintf("%d（ok %d · 超时 %d · 出错 %d · parse_fail %d）", r.Calls, r.Ok, r.Timeouts, r.Errors, r.ParseFail))
						kv(c, "response_format", fmt.Sprintf("%s · 降级 %d 次", Or(Str(r.FormatLevel), "–"), r.FormatDowngrades))
					}
					if r.LastFailureID != nil {
						kv(c, "最近一次失败", fmt.Sprintf("%s %s：%s", FmtTime(*r.LastFailureTs), Str(r.LastFailureStatus), Or(Str(r.LastFailureError), "–")))
						if ui.Button(c, "打开该调用").Clicked() {
							a.j.focusID = *r.LastFailureID
							a.Goto(PageJudge)
						}
					}
				})
			}
		})
	})
}
