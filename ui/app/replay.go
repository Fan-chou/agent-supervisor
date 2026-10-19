package app

import (
	"context"
	"fmt"
	"sort"

	"github.com/Fan-chou/agent-supervisor/ui/api"
	"github.com/egoist/mygo/ui"
)

type replayPage struct {
	runs  []api.Run
	evals []api.EvalReport
	a, b  int64 // 对比的两个运行（0 = 未选）
	// defaulted：只在第一次加载时默认选最近两次，之后用户清掉就不再自动补回
	defaulted bool
	cmp       *api.RunCompare
	sel       int64
	detail    *api.RunDetail
	list      ui.ListState
}

func (r *replayPage) init() {}

func (a *App) loadReplay() {
	a.async("replay", func(ctx context.Context) (func(), error) {
		runs, err := a.Client.Runs(ctx)
		if err != nil {
			return nil, err
		}
		ev, _ := a.Client.EvalReports(ctx)
		return func() {
			a.rp.runs, a.rp.evals = runs, ev
			if a.rp.sel == 0 && len(runs) > 0 {
				a.selectRun(runs[0].ID)
			}
			if !a.rp.defaulted && a.rp.a == 0 && a.rp.b == 0 {
				a.rp.defaulted = true
				// 默认拿最近两次回放/评测做对比
				var ids []int64
				for _, r := range runs {
					if r.Kind != "live" {
						ids = append(ids, r.ID)
					}
				}
				if len(ids) >= 2 {
					a.rp.a, a.rp.b = ids[1], ids[0]
					a.loadCompare()
				}
			}
		}, nil
	})
}

func (a *App) selectRun(id int64) {
	a.rp.sel, a.rp.detail = id, nil
	a.async("run-detail", func(ctx context.Context) (func(), error) {
		d, err := a.Client.RunDetail(ctx, id)
		if err != nil {
			return nil, err
		}
		return func() {
			if a.rp.sel == id {
				a.rp.detail = &d
			}
		}, nil
	})
}

func (a *App) loadCompare() {
	x, y := a.rp.a, a.rp.b
	if x == 0 || y == 0 {
		a.rp.cmp = nil
		return
	}
	a.async("compare", func(ctx context.Context) (func(), error) {
		cm, err := a.Client.Compare(ctx, x, y)
		if err != nil {
			return nil, err
		}
		return func() {
			if a.rp.a == x && a.rp.b == y {
				a.rp.cmp = &cm
			}
		}, nil
	})
}

func (a *App) replayView(c *ui.Context) {
	ui.Row(c).Fill().Padding(0, 24, 16, 24).Gap(16).AlignItems(ui.Stretch).Children(func() {
		a.card(c).Width(420).MinHeight(0).Padding(12).Gap(8).Children(func() { a.runList(c) })
		ui.Scroll(c).Grow(1).MinWidth(0).MinHeight(0).Children(func() {
			ui.Column(c).FillWidth().Gap(14).Children(func() {
				if msg := a.errOf("replay", "compare", "run-detail"); msg != "" {
					a.errLine(c, msg)
				}
				a.compareCard(c)
				a.runDetailCard(c)
				a.evalCard(c)
			})
		})
	})
}

var kindText = map[string]string{"live": "实时", "replay": "回放", "eval": "评测"}

func (a *App) runList(c *ui.Context) {
	p := a.pl
	ui.Row(c).FillWidth().AlignItems(ui.Center).Children(func() {
		a.label(c, "运行")
		ui.Spacer(c)
		a.muted(c, "点 A / B 选两个做对比")
	})
	runs := a.rp.runs
	if len(runs) == 0 {
		a.emptyState(c, "history", "还没有运行记录", "用 sv replay 回放样本后会出现在这里")
		return
	}
	a.rp.list.Key = func(i int) any { return runs[i].ID }
	ui.List(c, &a.rp.list, len(runs), func(i int) {
		r := runs[i]
		row := ui.Row(c).Key(r.ID).FillWidth().Margin(0, 0, 4, 0).Gap(10).Padding(10, 10).Radius(6).AlignItems(ui.Center).Border(1, ui.Transparent)
		a.hoverable(row, a.rp.sel == r.ID).Children(func() {
			ui.Column(c).Grow(1).MinWidth(0).Gap(3).Children(func() {
				ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
					ui.Text(c, fmt.Sprintf("#%d", r.ID)).Font("monospace").FontWeight(700)
					a.pill(c, Or(kindText[r.Kind], r.Kind), p.Muted, p.Shade)
					ui.Text(c, Str(r.Label)).FontSize(13).SingleLine()
				})
				a.txt(c, fmt.Sprintf("%d 个会话 · %d 次命中 · %s", r.Sessions, r.Hits, FmtTime(r.StartedTs)), 11, p.Muted).SingleLine()
			})
			a.abButton(c, "A", r.ID, &a.rp.a)
			a.abButton(c, "B", r.ID, &a.rp.b)
		})
		if row.Clicked() {
			a.selectRun(r.ID)
		}
	}).Grow(1).MinHeight(0)
}

func (a *App) abButton(c *ui.Context, name string, id int64, slot *int64) {
	p := a.pl
	on := *slot == id
	b := ui.Box(c).Size(26, 26).Radius(13).Center().Cursor(ui.CursorPointer).Border(1.5, p.Line)
	if on {
		b = b.Background(p.Accent).BorderColor(p.Accent)
	} else if b.Hovered() {
		b = b.Background(p.Shade)
	}
	b.Children(func() {
		col := p.Muted
		if on {
			col = ui.Hex("#FFFFFF")
			if p.Dark {
				col = ui.Hex("#0E1013")
			}
		}
		ui.Text(c, name).FontSize(11).FontWeight(700).TextColor(col)
	}).Label("对比 " + name)
	if b.Clicked() {
		if on {
			*slot = 0
		} else {
			*slot = id
		}
		a.loadCompare()
	}
}

func signed(n int64) string {
	switch {
	case n > 0:
		return fmt.Sprintf("▲ +%d", n)
	case n < 0:
		return fmt.Sprintf("▼ %d", n)
	}
	return "＝ 0"
}

func (a *App) compareCard(c *ui.Context) {
	p := a.pl
	a.card(c).FillWidth().Gap(10).Children(func() {
		a.label(c, "对比")
		if a.rp.cmp == nil {
			a.muted(c, "在左边给两个运行分别点 A 和 B，就能看到每条规则的命中变化。")
			return
		}
		cm := a.rp.cmp
		ui.Text(c, fmt.Sprintf("run %d  →  run %d", cm.A, cm.B)).FontSize(15).FontWeight(650).Font("monospace")
		a.muted(c, "回放运行是 shadow：下表里的「会拦」都是假设，没有任何一次真正拦截。")
		rows := append([]api.RunDiffRow(nil), cm.Rows...)
		sort.SliceStable(rows, func(i, j int) bool { return abs64(rows[i].DeltaHits) > abs64(rows[j].DeltaHits) })
		ui.Row(c).FillWidth().Gap(10).Padding(0, 12).Children(func() {
			for i, h := range []string{"规则", "命中 A → B", "变化", "告警 A → B", "会拦（未生效）A → B"} {
				a.txt(c, h, 11, p.Muted).FontWeight(600).Grow(float32([]int{1, 2, 1, 2, 2}[i])).Basis(0)
			}
		})
		for _, r := range rows {
			col := p.Muted
			if r.DeltaHits > 0 {
				col = p.Warn
			} else if r.DeltaHits < 0 {
				col = p.Ok
			}
			ui.Row(c).FillWidth().Gap(10).Padding(9, 12).Radius(6).Background(p.Card2).AlignItems(ui.Center).Children(func() {
				ui.Text(c, r.Rule).Font("monospace").FontWeight(700).Grow(1).Basis(0)
				ui.Text(c, fmt.Sprintf("%d → %d", r.HitsA, r.HitsB)).FontFeatures("tnum").Grow(2).Basis(0)
				a.txt(c, signed(r.DeltaHits), 13, col).FontWeight(650).Grow(1).Basis(0)
				ui.Text(c, fmt.Sprintf("%d → %d（%s）", r.AlarmsA, r.AlarmsB, signed(r.DeltaAlarms))).FontSize(12).FontFeatures("tnum").Grow(2).Basis(0)
				ui.Row(c).Grow(2).Basis(0).Children(func() {
					if r.BlocksA+r.BlocksB > 0 {
						a.stateChip(c, StWould, fmt.Sprintf("%d → %d", r.BlocksA, r.BlocksB))
					} else {
						a.muted(c, "0")
					}
				})
			})
		}
	})
}

func abs64(n int64) int64 {
	if n < 0 {
		return -n
	}
	return n
}

func (a *App) runDetailCard(c *ui.Context) {
	d := a.rp.detail
	if d == nil {
		return
	}
	a.card(c).FillWidth().Gap(8).Children(func() {
		a.label(c, fmt.Sprintf("运行 #%d 详情", d.ID))
		a.kv(c, "类型", Or(kindText[d.Kind], d.Kind))
		a.kv(c, "标签 / 来源", Str(d.Label)+" · "+Str(d.Source))
		a.kv(c, "模式", Or(Str(d.Mode), "–")+" · judge "+Or(Str(d.JudgeMode), "–"))
		a.kv(c, "版本 / 阈值指纹", Or(Str(d.Version), "–")+" · "+Or(Str(d.ThresholdsHash), "–"))
		a.kv(c, "开始", FmtTime(d.StartedTs))
		if d.EndedTs != nil {
			a.kv(c, "结束", FmtTime(*d.EndedTs))
		}
		a.kv(c, "规模", fmt.Sprintf("%d 个会话 · %d 次调用 · %d 次命中 · %d 次 judge", d.Sessions, d.Calls, d.Hits, d.JudgeCalls))
		if len(d.Overrides) > 0 {
			a.kv(c, "覆盖的阈值", fmt.Sprint(d.Overrides))
		}
	})
}

func (a *App) evalCard(c *ui.Context) {
	p := a.pl
	if len(a.rp.evals) == 0 {
		return
	}
	a.card(c).FillWidth().Gap(8).Children(func() {
		a.label(c, "评测报告")
		a.muted(c, "误报率 n/a 表示没有标注，不代表通过。")
		for _, ev := range a.rp.evals {
			ui.Text(c, fmt.Sprintf("run #%d · %s", ev.Run.ID, Str(ev.Run.Label))).FontSize(14).FontWeight(600)
			for _, r := range ev.Rules {
				ui.Row(c).FillWidth().Gap(10).Padding(8, 12).Radius(6).Background(p.Card2).AlignItems(ui.Center).Children(func() {
					ui.Text(c, r.Rule).Font("monospace").FontWeight(700).Width(40)
					ui.Text(c, fmt.Sprintf("命中 %d · 会话 %d", r.Hits, r.Sessions)).FontSize(12).Grow(1)
					a.txt(c, "误报率 "+Pct(r.FpRate)+map[bool]string{true: " · 样本少", false: ""}[SmallSample(r)], 12, p.Muted)
				})
			}
		}
	})
}
