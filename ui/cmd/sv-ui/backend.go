package main

// 单程序发行：sv-ui 内嵌 sv / sv-hook，启动时解压到每用户固定目录（内容哈希不同才重写，原子替换），
// 并提供 CLI 透传：`sv-ui sv <args>`、`sv-ui hook <args>`。hook 配置直接指向解压后的 sv-hook 固定路径。

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"
)

var backendFiles = []struct {
	src, dst string
	exe      bool
}{
	{"embedded/sv", "sv", true},
	{"embedded/sv-hook", "sv-hook", true},
	{"embedded/agent-supervisor.ts", "opencode-plugin/agent-supervisor.ts", false},
	{"embedded/config.example.yaml", "config.example.yaml", false},
}

// backendDir：SV_BIN_DIR 覆盖；macOS ~/Library/Application Support/agent-supervisor/bin；Windows %LOCALAPPDATA%\agent-supervisor\bin。
func backendDir() (string, error) {
	if d := os.Getenv("SV_BIN_DIR"); d != "" {
		return d, nil
	}
	if runtime.GOOS == "windows" {
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

func exeName(n string) string {
	if runtime.GOOS == "windows" && (n == "sv" || n == "sv-hook") {
		return n + ".exe"
	}
	return n
}

// extractBackend 把内嵌文件写到 backendDir；已存在且 sha256 相同则跳过。
func extractBackend() (string, error) {
	if !hasBackend {
		return "", errors.New("本构建未内嵌后端（开发构建请用 bun packages/cli/src/sv.ts）")
	}
	dir, err := backendDir()
	if err != nil {
		return "", err
	}
	for _, f := range backendFiles {
		data, err := fs.ReadFile(backendFS, f.src)
		if err != nil {
			return "", err
		}
		dst := filepath.Join(dir, filepath.FromSlash(exeName(f.dst)))
		if old, err := os.ReadFile(dst); err == nil && sha256.Sum256(old) == sha256.Sum256(data) {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return "", err
		}
		mode := os.FileMode(0o644)
		if f.exe {
			mode = 0o755
		}
		tmp, err := os.CreateTemp(filepath.Dir(dst), ".tmp-*")
		if err != nil {
			return "", err
		}
		_, werr := tmp.Write(data)
		cerr := tmp.Close()
		if werr == nil {
			werr = cerr
		}
		if werr == nil {
			werr = os.Chmod(tmp.Name(), mode)
		}
		if werr == nil {
			werr = os.Rename(tmp.Name(), dst)
		}
		if werr != nil {
			os.Remove(tmp.Name())
			return "", werr
		}
	}
	return dir, nil
}

func backendEnv(dir string) []string {
	return append(os.Environ(),
		"SV_HOOK_PATH="+filepath.Join(dir, exeName("sv-hook")),
		"SV_OPENCODE_PLUGIN="+filepath.Join(dir, "opencode-plugin", "agent-supervisor.ts"),
	)
}

// passthrough 处理 `sv-ui sv ...` / `sv-ui hook ...`；返回 false 表示不是透传调用。
func passthrough(args []string) bool {
	if len(args) == 0 || (args[0] != "sv" && args[0] != "hook") {
		return false
	}
	dir, err := extractBackend()
	if err != nil {
		if args[0] == "hook" { // fail-open：hook 出错不拦，直接放行
			os.Exit(0)
		}
		fmt.Fprintln(os.Stderr, "sv-ui:", err)
		os.Exit(2)
	}
	name := "sv"
	if args[0] == "hook" {
		name = "sv-hook"
	}
	cmd := exec.Command(filepath.Join(dir, exeName(name)), args[1:]...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr, cmd.Env = os.Stdin, os.Stdout, os.Stderr, backendEnv(dir)
	if err := cmd.Run(); err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			os.Exit(ee.ExitCode())
		}
		if args[0] == "hook" {
			os.Exit(0)
		}
		fmt.Fprintln(os.Stderr, "sv-ui:", err)
		os.Exit(2)
	}
	os.Exit(0)
	return true
}

// ensureDaemon：内嵌构建下，socket 连不上就解压并后台启动 `sv start`（日志写 bin 目录旁的 daemon.log）。
func ensureDaemon(sock string) {
	if !hasBackend {
		return
	}
	if c, err := net.DialTimeout("unix", sock, 300*time.Millisecond); err == nil {
		c.Close()
		return
	}
	dir, err := extractBackend()
	if err != nil {
		fmt.Fprintln(os.Stderr, "解压后端失败:", err)
		return
	}
	logf, _ := os.OpenFile(filepath.Join(filepath.Dir(dir), "daemon.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	cmd := exec.Command(filepath.Join(dir, exeName("sv")), "start")
	cmd.Env = backendEnv(dir)
	cmd.Stdin = bytes.NewReader(nil)
	if logf != nil {
		cmd.Stdout, cmd.Stderr = logf, logf
	}
	detach(cmd)
	if err := cmd.Start(); err != nil {
		fmt.Fprintln(os.Stderr, "启动守护进程失败:", err)
		return
	}
	_ = cmd.Process.Release()
	for i := 0; i < 30; i++ { // 最多等 3 秒
		if c, err := net.DialTimeout("unix", sock, 100*time.Millisecond); err == nil {
			c.Close()
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
}
