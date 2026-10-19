package app

import (
	"time"

	"github.com/egoist/mygo/ui"
)

// 动效约定：短促（150–250ms）、缓出；只动 transform/opacity 与背景色，不在动画里改布局或重建树。
// 空闲时没有任何常驻动画循环：只有「新事件高亮」存在的那 1.6 秒才逐帧请求，过期即停。
const (
	motionDur   = 200 * time.Millisecond
	freshWindow = 1600 * time.Millisecond
)

var enterFromTop = ui.ElementTransition{Enter: &ui.Motion{Y: -10}, Colors: true, Duration: motionDur, Ease: ui.EaseOut}

// slideFromRight 是右侧详情面板的进出：从右滑入并淡入，退出时反向（减弱动态效果时只淡入淡出）。
var slideFromRight = ui.ElementTransition{
	Enter: &ui.Motion{X: 36}, Exit: &ui.Motion{X: 36},
	Duration: motionDur, Ease: ui.EaseOut,
}

// noteList 登记一批条目的 key。第一次登记（首屏加载）不算新；之后出现的 key 记为「新事件」。
func (a *App) noteList(kind string, keys []string) {
	if a.seen == nil {
		a.seen, a.fresh = map[string]map[string]bool{}, map[string]time.Time{}
	}
	m := a.seen[kind]
	first := m == nil
	if first {
		m = make(map[string]bool, len(keys))
		a.seen[kind] = m
	}
	now := a.now()
	for _, k := range keys {
		if !m[k] {
			m[k] = true
			if !first {
				a.fresh[kind+"/"+k] = now
			}
		}
	}
}

// tickFresh 在每帧开头清理过期的高亮，并只在还有高亮时请求下一帧（空闲时 CPU≈0）。
func (a *App) tickFresh(c *ui.Context) {
	a.reduce = c.Preferences().ReduceMotion
	if len(a.fresh) == 0 {
		return
	}
	now := a.now()
	var soonest time.Duration
	for k, t := range a.fresh {
		left := freshWindow - now.Sub(t)
		if left <= 0 {
			delete(a.fresh, k)
			continue
		}
		if soonest == 0 || left < soonest {
			soonest = left
		}
	}
	if soonest == 0 {
		return
	}
	if a.reduce {
		c.After(soonest) // 不逐帧：只在过期时重画一次
	} else {
		c.AnimationFrame()
	}
}

// freshness 返回某条目的高亮强度 0..1（线性淡出）。减弱动态效果时不淡出，只在窗口内保持固定强度。
func (a *App) freshness(kind, key string) float32 {
	t, ok := a.fresh[kind+"/"+key]
	if !ok {
		return 0
	}
	age := a.now().Sub(t)
	if age >= freshWindow {
		return 0
	}
	if a.reduce {
		return 1
	}
	return 1 - float32(age)/float32(freshWindow)
}

// markFresh 给新事件行加「短暂高亮 + 从顶部滑入」。非新条目原样返回，不挂任何过渡。
func (a *App) markFresh(e ui.Element, kind, key string) ui.Element {
	f := a.freshness(kind, key)
	if f == 0 {
		return e.Transition(colorsOnly)
	}
	e = e.Background(a.pl.Text.Alpha(0.07 * f))
	if a.reduce {
		return e
	}
	return e.Transition(enterFromTop)
}

// colorsOnly：悬停/选中的底色变化平滑 120ms；不动位置。
var colorsOnly = ui.ElementTransition{Colors: true, Duration: 120 * time.Millisecond}
