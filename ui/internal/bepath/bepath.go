// Package bepath 是 Agent Supervisor 单程序发行版里「解压出的后端」的位置约定，
// 供 GUI 程序（sv-ui）和 Windows 上的控制台转发器（sv.exe）共用。
package bepath

import (
	"os"
	"path/filepath"
	"runtime"
)

// Dir：SV_BIN_DIR 覆盖；macOS ~/Library/Application Support/agent-supervisor/bin；Windows %LOCALAPPDATA%\agent-supervisor\bin。
func Dir() (string, error) { return dirFor(runtime.GOOS) }

func dirFor(goos string) (string, error) {
	if d := os.Getenv("SV_BIN_DIR"); d != "" {
		return d, nil
	}
	if goos == "windows" {
		if d := os.Getenv("LOCALAPPDATA"); d != "" {
			return filepath.Join(d, "agent-supervisor", "bin"), nil
		}
	}
	d, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "agent-supervisor", "bin"), nil
}

// ExeName 给 sv / sv-hook 在 Windows 上补 .exe。
func ExeName(n string) string { return exeNameFor(runtime.GOOS, n) }

func exeNameFor(goos, n string) string {
	if goos == "windows" && (n == "sv" || n == "sv-hook") {
		return n + ".exe"
	}
	return n
}

// Env 是启动后端子进程的环境：在当前环境上加 sv install 用的固定路径。
func Env(dir string) []string {
	return append(os.Environ(),
		"SV_HOOK_PATH="+filepath.Join(dir, ExeName("sv-hook")),
		"SV_OPENCODE_PLUGIN="+filepath.Join(dir, "opencode-plugin", "agent-supervisor.ts"),
	)
}
