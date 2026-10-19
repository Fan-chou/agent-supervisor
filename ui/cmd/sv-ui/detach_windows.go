//go:build windows

package main

import (
	"os"
	"os/exec"
	"syscall"
)

func detach(c *exec.Cmd) {
	c.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000008 | 0x00000200 | 0x08000000} // DETACHED_PROCESS|NEW_PROCESS_GROUP|NO_WINDOW
}

// stopProcess 结束后台进程（Windows 没有 SIGTERM；数据已落 SQLite，hook 在空档里 fail-open）。
func stopProcess(pid int) error {
	p, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return p.Kill()
}
