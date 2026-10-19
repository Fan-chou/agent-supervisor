//go:build !windows

package main

import (
	"os"
	"path/filepath"
	"testing"
)

// 转发器把参数交给解压出的 sv，并传递退出码；找不到后端时返回 2。
func TestRunForwardsExitCode(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("SV_BIN_DIR", dir)
	if got := run([]string{"status"}); got != 2 {
		t.Fatalf("没有后端应返回 2：%d", got)
	}
	script := "#!/bin/sh\n[ \"$1\" = status ] && [ -n \"$SV_HOOK_PATH\" ] && exit 7\nexit 1\n"
	if err := os.WriteFile(filepath.Join(dir, "sv"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	if got := run([]string{"status"}); got != 7 {
		t.Fatalf("应传递子进程退出码 7：%d", got)
	}
}
