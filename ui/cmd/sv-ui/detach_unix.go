//go:build !windows

package main

import (
	"os/exec"
	"syscall"
)

func detach(c *exec.Cmd) { c.SysProcAttr = &syscall.SysProcAttr{Setsid: true} }

// stopProcess 请求后台退出（SIGTERM，sv 会优雅关闭）。
func stopProcess(pid int) error { return syscall.Kill(pid, syscall.SIGTERM) }
