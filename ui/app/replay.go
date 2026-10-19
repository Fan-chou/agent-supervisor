package app

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/Fan-chou/agent-supervisor/ui/api"
	"github.com/egoist/mygo/ui"
)

type replayPage struct {
	tab    int // 0 运行 1 评测报告
	runs   []api.Run
	loaded bool
	list   ui.ListState
	sel    int
	selID  int64
	chosen ui.Selection[int64] // 勾选的运行（用于对比）
	detail map[int64]api.RunDetail
	cmp    *api.RunCompare
	cmpKey string
	evals  []api.EvalReport
	a, b   int
}

func (a *App) loadReplay() {
	a.async("runs", func(ctx context.Context) (func(), error) {
		rs, err := a.Client.Runs(ctx)
		if err != nil {
			return nil, err
		}
		evals, eerr := a.Client.EvalReports(ctx)
		return func() {
			a.p.runs, a.p.loaded = rs, true
			if eerr == nil {
				a.p.evals = evals
			}
			a.loadRunDetail()
			a.loadCompare()
		}, nil
	})
}

func (a *App) loadRunDetail() {
	id := a.p.selID
	if id == 0 {
		return
	}
	a.async("run-detail", func(ctx context.Context) (func(), error) {
		d, err := a.Client.RunDetail(ctx, id)
		if err != nil {
			return nil, err
		}
		return func() {
			if a.p.detail == nil {
				a.p.detail = map[int64]api.RunDetail{}
			}
			a.p.detail[id] = d
		}, nil
	})
}

// chosenPair 返回勾选的两次运行（id 小的是 A）。
func (a *App) chosenPair() (int64, int64, bool) {
	var ids []int64
	for id := range a.p.chosen.All() {
		ids = append(ids, id)
	}
	if len(ids) != 2 {
		return 0, 0, false
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids[0], ids[1], true
}

func (a *App) loadCompare() {
	x, y, ok := a.chosenPair()
	if !ok {
		a.p.cmp, a.p.cmpKey = nil, ""
		return
	}
	key := fmt.Sprintf("%d-%d", x, y)
	if a.p.cmpKey == key && a.p.cmp != nil {
		return
	}
	a.async("compare", func(ctx context.Context) (func(), error) {
		r, err := a.Client.Compare(ctx, x, y)
		if err != nil {
			return nil, err
		}
		return func() { a.p.cmp, a.p.cmpKey = &r, key }, nil
	})
}

func runTitle(r api.Run) string {
	return fmt.Sprintf("run %d · %s · %s", r.ID, Or(Str(r.Label), r.Kind), r.Kind)
}

func (a *App) replayView(c *ui.Context) {
	p := palOf(c)
	rp := &a.p
	ui.Row(c).FillWidth().Padding(10, 14).Gap(12).AlignItems(ui.Center).Children(func() {
		ui.Tabs(c, &rp.tab, "运行", "评测报告").Label("回放与评测")
		ui.Text(c, "回放与评测由命令行 sv replay / sv eval 发起；界面只读，不提供新建回放。").FontSize(12).TextColor(p.Muted)
	})
	if e := a.errOf("runs"); e != "" {
		a.errBar(c, "加载失败："+e, a.loadReplay)
	}
	if !rp.loaded {
		a.emptyNote(c, "正在加载运行列表…")
		return
	}
	if len(rp.runs) == 0 {
		ui.Column(c).Grow(1).Center().Gap(8).Children(func() {
			ui.Text(c, "还没有回放结果").Bold().FontSize(18)
			ui.Text(c, "用命令行产生：sv replay <路径> --log --label base").TextColor(p.Muted)
		})
		return
	}
	if rp.tab == 1 {
		a.evalView(c)
		return
	}
	ui.Row(c).Grow(1).MinHeight(0).Padding(0, 14, 10, 14).Gap(12).AlignItems(ui.Stretch).Children(func() {
		ui.Column(c).Grow(1).MinWidth(0).Gap(10).Children(func() {
			a.runsTable(c)
			a.compareView(c)
		})
		if d, ok := rp.detail[rp.selID]; ok {
			a.runDetailPanel(c, d)
		}
	})
}

func (a *App) runsTable(c *ui.Context) {
	p := palOf(c)
	rp := &a.p
	cols := []ui.TableColumn{
		{Title: "run", Width: 52, Align: ui.End},
		{Title: "标签", Width: 90},
		{Title: "类型", Width: 64},
		{Title: "来源", MinWidth: 150},
		{Title: "mode", Width: 66},
		{Title: "judge", Width: 56},
		{Title: "阈值哈希", Width: 94},
		{Title: "覆盖项", Width: 170},
		{Title: "会话", Width: 52, Align: ui.End},
		{Title: "命中", Width: 52, Align: ui.End},
		{Title: "时间", Width: 112},
	}
	rp.list.Selected = &rp.sel
	rp.list.Selection = &rp.chosen
	rp.list.Key = func(i int) any { return rp.runs[i].ID }
	rp.list.Label = func(i int) string { return runTitle(rp.runs[i]) }
	tbl := ui.Table(c, &rp.list, cols, len(rp.runs), func(i, col int) {
		r := rp.runs[i]
		on := i == rp.sel || rp.chosen.Has(r.ID)
		t := func(s string) ui.Element { return ui.Text(c, s).FontSize(13).SingleLine() }
		switch col {
		case 0:
			t(fmt.Sprint(r.ID))
		case 1:
			t(Or(Str(r.Label), "–"))
		case 2:
			switch {
			case on:
				t(r.Kind) // 选中行（蓝底）上直接用继承的白字，chip 的灰底会看不清
			case r.Kind == "live":
				chip(c, "live", p.Ok, p.Faint)
			case r.Kind == "eval":
				chip(c, "eval", p.Warn, p.WarnBg)
			default:
				chip(c, "replay", p.Muted, p.Faint)
			}
		case 3:
			t(Or(Str(r.Source), "–")).TextColor(p.dim(on))
		case 4:
			t(Or(Str(r.Mode), "–"))
		case 5:
			t(Or(Str(r.JudgeMode), "–"))
		case 6:
			t(Or(Str(r.ThresholdsHash), "–")).Font("monospace")
		case 7:
			t(overridesText(r)).TextColor(p.dim(on))
		case 8:
			t(fmt.Sprint(r.Sessions))
		case 9:
			t(fmt.Sprint(r.Hits))
		case 10:
			t(FmtTime(r.StartedTs)).TextColor(p.dim(on)).Tooltip(FmtISO(r.StartedTs))
		}
	}).Height(float32(40 + 32*len(rp.runs))).MaxHeight(340).Label("运行列表")
	if tbl.Changed() && rp.sel >= 0 && rp.sel < len(rp.runs) {
		if id := rp.runs[rp.sel].ID; id != rp.selID {
			rp.selID = id
			a.loadRunDetail()
		}
		a.loadCompare()
	}
	ui.Row(c).Gap(10).AlignItems(ui.Center).Children(func() {
		x, y, ok := a.chosenPair()
		if ok {
			ui.Textf(c, "已勾选 run %d 与 run %d（⌘/Ctrl 点击多选）→ 下方对比 A→B", x, y).FontSize(12).TextColor(p.Muted)
		} else {
			ui.Text(c, "⌘/Ctrl 点击勾选两次运行，下方显示对比（sv stats --compare A,B）").FontSize(12).TextColor(p.Muted)
		}
		ui.Spacer(c)
		if rp.sel >= 0 && rp.sel < len(rp.runs) {
			r := rp.runs[rp.sel]
			if ui.Button(c, "查看该运行的会话").Clicked() {
				a.s.run, a.s.runTi = r.ID, runTitle(r)
				a.s.selID, a.s.sel, a.s.stateIdx = "", -1, 4
				a.s.all, a.s.loaded = nil, false
				a.Goto(PageSessions)
			}
			if ui.Button(c, "在规则统计中打开").Clicked() {
				a.k.source = fmt.Sprintf("run %d", r.ID)
				a.k.srcRun = r.ID
				a.k.tab = 0
				a.Goto(PageStats)
			}
		}
	})
}

func overridesText(r api.Run) string {
	if r.OverridesJson == nil {
		return "–"
	}
	var xs []string
	if json.Unmarshal([]byte(*r.OverridesJson), &xs) == nil && len(xs) > 0 {
		return strings.Join(xs, "; ")
	}
	return "–"
}

func (a *App) compareView(c *ui.Context) {
	rp := &a.p
	if rp.cmp == nil {
		return
	}
	p := palOf(c)
	cmp := rp.cmp
	section(c, fmt.Sprintf("对比 run %d → run %d", cmp.A, cmp.B), func() {
		cols := []ui.TableColumn{
			{Title: "规则", Width: 70}, {Title: "命中 A", Width: 70, Align: ui.End}, {Title: "命中 B", Width: 70, Align: ui.End}, {Title: "Δ", ID: "dh", Width: 56, Align: ui.End},
			{Title: "报警 A", Width: 70, Align: ui.End}, {Title: "报警 B", Width: 70, Align: ui.End}, {Title: "Δ", ID: "da", Width: 56, Align: ui.End},
			{Title: "拦截 A", Width: 70, Align: ui.End}, {Title: "拦截 B", Width: 70, Align: ui.End},
		}
		delta := func(v int64) {
			col := p.Muted
			switch {
			case v > 0:
				col = p.Warn
			case v < 0:
				col = p.Ok
			}
			ui.Text(c, fmt.Sprintf("%+d", v)).FontSize(13).TextColor(col).SingleLine()
		}
		ui.Table(c, nil, cols, len(cmp.Rows), func(i, col int) {
			r := cmp.Rows[i]
			n := func(v int64) { ui.Text(c, fmt.Sprint(v)).FontSize(13).SingleLine() }
			switch col {
			case 0:
				ui.Text(c, r.Rule).Bold().FontSize(13)
			case 1:
				n(r.HitsA)
			case 2:
				n(r.HitsB)
			case 3:
				delta(r.DeltaHits)
			case 4:
				n(r.AlarmsA)
			case 5:
				n(r.AlarmsB)
			case 6:
				delta(r.DeltaAlarms)
			case 7:
				n(r.BlocksA)
			case 8:
				n(r.BlocksB)
			}
		}).Height(float32(36 + 30*len(cmp.Rows))).MaxHeight(260).Label("运行对比")
	})
}

func (a *App) runDetailPanel(c *ui.Context, d api.RunDetail) {
	p := palOf(c)
	ui.Scroll(c).Width(340).Shrink(0).Children(func() {
		ui.Column(c).FillWidth().Gap(10).Children(func() {
			section(c, fmt.Sprintf("run %d · %s", d.ID, Or(Str(d.Label), d.Kind)), func() {
				kv(c, "类型", d.Kind)
				kv(c, "来源", Str(d.Source))
				kv(c, "mode / judge", Or(Str(d.Mode), "–")+" / "+Or(Str(d.JudgeMode), "–"))
				kv(c, "版本", Str(d.Version))
				kv(c, "阈值哈希", Str(d.ThresholdsHash))
				kv(c, "开始", FmtTime(d.StartedTs))
				if d.EndedTs != nil {
					kv(c, "耗时", (time.Duration(*d.EndedTs-d.StartedTs) * time.Millisecond).Round(time.Second).String())
				}
				kv(c, "会话 / 调用", fmt.Sprintf("%d / %d", d.Sessions, d.Calls))
				kv(c, "命中 / judge", fmt.Sprintf("%d / %d", d.Hits, d.JudgeCalls))
			})
			section(c, "当时生效的阈值覆盖（--set）", func() {
				if len(d.Overrides) == 0 {
					ui.Text(c, "无覆盖项（基线阈值）").FontSize(12).TextColor(p.Muted)
				}
				for _, o := range d.Overrides {
					mono(c, o)
				}
			})
			if th, ok := d.Tuning["thresholds"]; ok {
				b, _ := json.MarshalIndent(th, "", "  ")
				section(c, "阈值快照", func() { mono(c, string(b)).MaxHeight(220) })
			}
			section(c, "可复制命令", func() {
				cmd := fmt.Sprintf("sv replay %s --log --label %s", Or(Str(d.Source), "<路径>"), Or(Str(d.Label), "run"))
				for _, o := range d.Overrides {
					cmd += " --set " + o
				}
				mono(c, cmd)
				if ui.Button(c, "复制回放命令").Clicked() {
					c.WriteClipboard(cmd)
					c.Toast("已复制（界面不会执行它）")
				}
			})
		})
	})
}

// evalView 展示 /v1/eval/reports：评测运行 + 逐规则统计。
// 会话级 precision/recall、首次报警延迟和 FDR 门槛目前不入库（见 progress），这里如实说明，不编造。
func (a *App) evalView(c *ui.Context) {
	p := palOf(c)
	rp := &a.p
	ui.Scroll(c).Grow(1).Padding(0, 14, 10, 14).Children(func() {
		ui.Column(c).FillWidth().Gap(12).Children(func() {
			banner(c, p.Warn, p.WarnBg, "n/a 不是通过：没有人工标注时误报率显示 n/a。会话级 precision/recall 与 FDR 门槛由命令行 sv eval 输出，目前不入库，界面不重算。")
			if len(rp.evals) == 0 {
				ui.Text(c, "还没有评测运行。用 sv eval 产生（需要 eval/labels.yaml，由 Jack 提供标注）。").TextColor(p.Muted)
			}
			for _, rep := range rp.evals {
				rep := rep
				section(c, runTitle(rep.Run)+" · 评测运行", func() {
					kv(c, "来源", Str(rep.Run.Source))
					kv(c, "会话 / 命中", fmt.Sprintf("%d / %d", rep.Run.Sessions, rep.Run.Hits))
					a.ruleStatTable(c, rep.Rules, 34+30*len(rep.Rules), nil)
				})
			}
		})
	})
}
