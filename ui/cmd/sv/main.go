// sv：发行版里的控制台转发器（主要给 Windows 用）。
//
// 打包后的 Agent Supervisor.exe 是 GUI 子系统（-H windowsgui，双击不弹黑窗），在终端里它拿不到控制台，
// 输出会丢，cmd/PowerShell 也不会等它结束。这个小程序是控制台子系统：先让同目录的 Agent Supervisor.exe
// 把内嵌后端解压/更新到固定目录（`extract`），再把参数原样交给解压出的 sv，继承标准输入输出，传递退出码。
//
//	sv.exe status            等同 sv status
//
// 不含任何业务逻辑，也不内嵌后端（所以很小）。
package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/Fan-chou/agent-supervisor/ui/internal/bepath"
)

const guiName = "Agent Supervisor.exe"

func main() { os.Exit(run(os.Args[1:])) }

func run(args []string) int {
	dir, err := bepath.Dir()
	if err != nil {
		fmt.Fprintln(os.Stderr, "sv:", err)
		return 2
	}
	// 同目录有 GUI 程序就让它先解压（内容相同时不重写，很快）；没有就用已解压的后端。
	if self, err := os.Executable(); err == nil {
		if gui := filepath.Join(filepath.Dir(self), guiName); fileExists(gui) {
			x := exec.Command(gui, "extract")
			x.Stdout, x.Stderr = os.Stderr, os.Stderr
			if err := x.Run(); err != nil {
				fmt.Fprintln(os.Stderr, "sv: 解压后端失败:", err)
				return 2
			}
		}
	}
	target := filepath.Join(dir, bepath.ExeName("sv"))
	if !fileExists(target) {
		fmt.Fprintf(os.Stderr, "sv: 找不到后端 %s；请把 sv.exe 放在 %s 旁边，或先运行一次该程序\n", target, guiName)
		return 2
	}
	cmd := exec.Command(target, args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr, cmd.Env = os.Stdin, os.Stdout, os.Stderr, bepath.Env(dir)
	if err := cmd.Run(); err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return ee.ExitCode()
		}
		fmt.Fprintln(os.Stderr, "sv:", err)
		return 2
	}
	return 0
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}
