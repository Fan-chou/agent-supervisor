//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

func detach(c *exec.Cmd) {
	c.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000008 | 0x00000200 | 0x08000000} // DETACHED_PROCESS|NEW_PROCESS_GROUP|NO_WINDOW
}
