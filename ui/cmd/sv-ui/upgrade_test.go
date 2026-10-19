package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func write(t *testing.T, p, s string) {
	t.Helper()
	if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
		t.Fatal(err)
	}
}

func read(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// 模拟 Windows：目标文件（正在运行的 exe）不能被覆盖，但可以改名。
func TestReplaceFileMovesRunningExeAside(t *testing.T) {
	dir := t.TempDir()
	dst, tmp := filepath.Join(dir, "sv.exe"), filepath.Join(dir, ".tmp-1")
	write(t, dst, "old")
	write(t, tmp, "new")
	real := renameFn
	defer func() { renameFn = real }()
	renameFn = func(from, to string) error {
		if _, err := os.Stat(dst); err == nil && to == dst && strings.HasPrefix(filepath.Base(from), ".tmp-") {
			return errors.New("Access is denied.")
		}
		return real(from, to)
	}
	if err := replaceFile(tmp, dst); err != nil {
		t.Fatal(err)
	}
	if read(t, dst) != "new" {
		t.Fatal("新文件应已就位")
	}
	olds, _ := filepath.Glob(dst + ".old-*")
	if len(olds) != 1 || read(t, olds[0]) != "old" {
		t.Fatalf("旧文件应被挤到旁边：%v", olds)
	}
	// 下次启动清理
	cleanOld(dir)
	if olds, _ := filepath.Glob(dst + ".old-*"); len(olds) != 0 {
		t.Fatalf("旧文件应被清理：%v", olds)
	}
	if read(t, dst) != "new" {
		t.Fatal("清理不能动新文件")
	}
}

// 连改名也做不到时报错，并把旧文件放回原处，不留半截状态。
func TestReplaceFileRestoresOnFailure(t *testing.T) {
	dir := t.TempDir()
	dst, tmp := filepath.Join(dir, "sv-hook.exe"), filepath.Join(dir, ".tmp-2")
	write(t, dst, "old")
	write(t, tmp, "new")
	real := renameFn
	defer func() { renameFn = real }()
	renameFn = func(from, to string) error {
		if from == tmp {
			return errors.New("Access is denied.")
		}
		return real(from, to)
	}
	if err := replaceFile(tmp, dst); err == nil {
		t.Fatal("应报错")
	}
	if read(t, dst) != "old" {
		t.Fatal("失败后旧文件应还在原处")
	}
}

func TestReplaceFileNormalPath(t *testing.T) {
	dir := t.TempDir()
	dst, tmp := filepath.Join(dir, "a"), filepath.Join(dir, ".tmp-3")
	write(t, dst, "old")
	write(t, tmp, "new")
	if err := replaceFile(tmp, dst); err != nil || read(t, dst) != "new" {
		t.Fatalf("普通替换：%v", err)
	}
	if olds, _ := filepath.Glob(dst + ".old-*"); len(olds) != 0 {
		t.Fatal("正常路径不应留旧文件")
	}
}

func TestStaleDaemon(t *testing.T) {
	bin := time.Now()
	if !staleDaemon(bin.Add(-time.Hour).UnixMilli(), bin) {
		t.Fatal("后台早于二进制：应判为旧版本")
	}
	if staleDaemon(bin.Add(time.Minute).UnixMilli(), bin) {
		t.Fatal("后台晚于二进制：不是旧版本")
	}
	if staleDaemon(bin.Add(-time.Second).UnixMilli(), bin) {
		t.Fatal("2 秒内的差距不算")
	}
	if staleDaemon(0, bin) {
		t.Fatal("未知启动时间不动它")
	}
}

func TestReadHookPidRequiresMatchingStart(t *testing.T) {
	home := t.TempDir()
	write(t, filepath.Join(home, "hook.json"), `{"pid": 4242, "startedAt": 1000}`)
	if readHookPid(home, 1000) != 4242 {
		t.Fatal("startedAt 一致应返回 pid")
	}
	if readHookPid(home, 999) != 0 {
		t.Fatal("startedAt 不一致（pid 可能已被复用）不能返回")
	}
	if readHookPid(t.TempDir(), 1000) != 0 {
		t.Fatal("没有 hook.json 返回 0")
	}
}
