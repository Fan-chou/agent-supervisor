// uismoke：UI0 冒烟——验证 MyGo 能在本机编译、离屏渲染、表格虚拟化（不开窗口）。
package main

import (
	"fmt"
	"image/png"
	"os"
	"time"

	"github.com/egoist/mygo/ui"
)

type app struct {
	list ui.ListState
	sel  int
}

func (a *app) view(c *ui.Context) {
	cols := []ui.TableColumn{{Title: "#", Width: 80, Align: ui.End}, {Title: "命令 pytest -q 中文"}, {Title: "级别", Width: 60}}
	a.list.Selected = &a.sel
	ui.Column(c).Fill().Padding(8).Gap(6).Children(func() {
		ui.Text(c, "冒烟 ⚠ ◌ ■ ▲H ●M ·L").Bold()
		ui.Table(c, &a.list, cols, 100000, func(row, col int) {
			switch col {
			case 0:
				ui.Text(c, fmt.Sprint(row)).SingleLine()
			case 1:
				ui.Text(c, fmt.Sprintf("pytest -q tests/%d", row)).SingleLine()
			default:
				ui.Text(c, "M").SingleLine()
			}
		}).Grow(1)
	})
}

func main() {
	a := &app{}
	t0 := time.Now()
	img := ui.Render(a.view, 640, 360, 2)
	f, _ := os.Create(os.Args[1])
	defer f.Close()
	_ = png.Encode(f, img)
	fmt.Println("rendered 100000-row table in", time.Since(t0))
}
