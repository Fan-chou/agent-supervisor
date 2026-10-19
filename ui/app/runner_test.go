package app

import (
	"context"
	"testing"
	"time"

	"github.com/Fan-chou/agent-supervisor/ui/api"
	"github.com/Fan-chou/agent-supervisor/ui/fake"
)

func waitState(t *testing.T, a *App, want ConnState, d time.Duration) {
	t.Helper()
	dl := time.Now().Add(d)
	for time.Now().Before(dl) {
		if a.connSnapshot().State == want {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("state %v not reached, now %v", want, a.connSnapshot().State)
}

// 连接状态机端到端：connecting → live；掐断连接且返回 503 → 离开 live；恢复后回到 live。
func TestRunnerReconnects(t *testing.T) {
	srv := fake.New()
	defer srv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	a := New(ctx, api.NewHTTP(srv.URL, ""), func(fn func()) { fn() })
	a.Start()
	waitState(t, a, Live, 5*time.Second)

	srv.SetOffline(true)
	srv.CloseClientConnections()
	dl := time.Now().Add(5 * time.Second)
	for a.connSnapshot().State == Live && time.Now().Before(dl) {
		time.Sleep(20 * time.Millisecond)
	}
	if a.connSnapshot().State == Live {
		t.Fatal("still live after outage")
	}
	srv.SetOffline(false)
	waitState(t, a, Live, 15*time.Second)
}
