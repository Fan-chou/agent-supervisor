package app

import (
	"context"
	"fmt"
	"sort"

	"github.com/Fan-chou/agent-supervisor/ui/api"
	"github.com/egoist/mygo/ui"
)

// explainState 是右侧「命中检视器」的数据：一次命中的完整链路（事件、决策、judge、投递、标注）。
type explainState struct {
	id   int64
	data *api.Explain
	busy bool
}

func (a *App) loadExplain(id int64) {
	if id == 0 {
		return
	}
	a.ex.id, a.ex.data, a.ex.busy = id, nil, true
	a.async("explain", func(ctx context.Context) (func(), error) {
		ex, err := a.Client.Explain(ctx, id)
		if err != nil {
			return nil, err
		}
		return func() {
			if a.ex.id == id {
				a.ex.data, a.ex.busy = &ex, false
			}
		}, nil
	})
}

func ms(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k]; ok && v != nil {
			switch x := v.(type) {
			case string:
				if x != "" {
					return x
				}
			case float64:
				if x == float64(int64(x)) {
					return fmt.Sprint(int64(x))
				}
				return fmt.Sprint(x)
			case bool:
				return map[bool]string{true: "是", false: "否"}[x]
			default:
				return fmt.Sprint(x)
			}
		}
	}
	return ""
}

// inspector 画命中检视器；close 非 nil 时右上角有关闭按钮。
func (a *App) inspector(c *ui.Context, onClose func()) {
	p := a.pl
	ui.Row(c).FillWidth().AlignItems(ui.Center).Children(func() {
		a.label(c, fmt.Sprintf("命中检视 #%d", a.ex.id))
		ui.Spacer(c)
		if onClose != nil {
			x := ui.Row(c).Padding(4).Radius(6).Cursor(ui.CursorPointer).Children(func() { icon(c, "x", 14, p.Muted) }).Label("关闭检视器")
			if x.Hovered() {
				x.Background(p.Shade)
			}
			if x.Clicked() {
				onClose()
			}
		}
	})
	if msg := a.errOf("explain"); msg != "" {
		a.errLine(c, msg)
		return
	}
	ex := a.ex.data
	if ex == nil {
		a.muted(c, "加载中…")
		return
	}
	h := ex.Hit
	ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
		a.sevMark(c, ms(h, "sev"))
		ui.Text(c, ms(h, "rule_id", "ruleId")).Font("monospace").FontWeight(700).FontSize(14)
	})
	if m := ms(h, "message"); m != "" {
		ui.Text(c, m).FontSize(13)
	}
	a.kv(c, "会话", ms(h, "session_id", "sessionId"))
	a.kv(c, "阶段", ms(h, "phase"))
	a.kv(c, "阈值", ms(h, "threshold_json"))
	a.kv(c, "观测值", ms(h, "observed_json"))
	a.kv(c, "指纹", ms(h, "fingerprint"))

	a.inspSection(c, "决策（每条单独列出）")
	if len(ex.Decisions) == 0 {
		a.muted(c, "没有决策")
	}
	for _, d := range ex.Decisions {
		d := d
		outcome, mode := ms(d, "outcome"), ms(d, "mode")
		ui.Column(c).FillWidth().Gap(5).Padding(10).Radius(6).Background(p.Card2).Children(func() {
			ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
				ui.Text(c, "动作 "+Or(ms(d, "action"), "–")).FontSize(12).FontWeight(600)
				a.outcomeChip(c, outcome, mode)
			})
			a.kv(c, "模式", Or(mode, "shadow"))
			a.kv(c, "是否生效", ms(d, "applied"))
			if s := ms(d, "suppressed_by", "suppressedBy"); s != "" {
				a.kv(c, "被抑制", s)
			}
			if s := ms(d, "message"); s != "" {
				ui.Text(c, s).FontSize(12).TextColor(p.Muted)
			}
		})
	}
	if len(ex.Events) > 0 {
		a.inspSection(c, "触发的调用")
		for _, e := range ex.Events {
			ui.Text(c, Or(ms(e, "tool_name"), "–")+"  "+ms(e, "norm_cmd")).Font("monospace").FontSize(12).Selectable()
		}
	}
	if len(ex.Judge) > 0 {
		a.inspSection(c, "Judge")
		for _, j := range ex.Judge {
			a.kv(c, "裁决 #"+ms(j, "id"), ms(j, "verdict")+" · "+ms(j, "model")+" · "+ms(j, "status"))
		}
	}
	if len(ex.Deliveries) > 0 {
		a.inspSection(c, "投递给 agent")
		for _, d := range ex.Deliveries {
			keys := make([]string, 0, len(d))
			for k := range d {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				a.kv(c, k, ms(d, k))
			}
		}
	}
}

func (a *App) inspSection(c *ui.Context, s string) {
	ui.Box(c).FillWidth().Height(1).Background(a.pl.Line).Margin(4, 0, 0, 0)
	a.label(c, s)
}
