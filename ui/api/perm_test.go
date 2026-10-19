package api

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCheckPermSkipsOnWindows(t *testing.T) {
	p := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(p, []byte("x"), 0o666); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(p, 0o666); err != nil {
		t.Fatal(err)
	}
	if w := checkPerm(p, "windows"); w != "" {
		t.Fatalf("Windows 上不应告警：%q", w)
	}
	if w := checkPerm(p, "linux"); w == "" {
		t.Fatal("非 Windows 上 0666 应告警")
	}
	if err := os.Chmod(p, 0o600); err != nil {
		t.Fatal(err)
	}
	if w := checkPerm(p, "linux"); w != "" {
		t.Fatalf("0600 不应告警：%q", w)
	}
}
