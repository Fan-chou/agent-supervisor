package bepath

import (
	"path/filepath"
	"testing"
)

func TestDirAndExeName(t *testing.T) {
	t.Setenv("SV_BIN_DIR", "")
	t.Setenv("LOCALAPPDATA", `C:\Users\u\AppData\Local`)
	d, err := dirFor("windows")
	if err != nil || d != filepath.Join(`C:\Users\u\AppData\Local`, "agent-supervisor", "bin") {
		t.Fatalf("windows 目录：%q %v", d, err)
	}
	t.Setenv("SV_BIN_DIR", "/x/y")
	if d, _ := dirFor("windows"); d != "/x/y" {
		t.Fatalf("SV_BIN_DIR 应覆盖：%q", d)
	}
	if exeNameFor("windows", "sv") != "sv.exe" || exeNameFor("windows", "sv-hook") != "sv-hook.exe" || exeNameFor("windows", "config.example.yaml") != "config.example.yaml" {
		t.Fatal("windows 可执行文件应带 .exe，其他文件不动")
	}
	if exeNameFor("darwin", "sv") != "sv" {
		t.Fatal("非 windows 不加后缀")
	}
}
