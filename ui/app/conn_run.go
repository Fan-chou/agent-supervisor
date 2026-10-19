package app

import (
	"time"

	"github.com/Fan-chou/agent-supervisor/ui/api"
)

// CoalesceEvery 是推送合并刷新的间隔（10 Hz，§10.3）。
const CoalesceEvery = 100 * time.Millisecond

// SafetyPoll 是不论连接状态都做的兜底刷新间隔：保证相对时间、会话状态在没有推送时也会更新。
const SafetyPoll = 5 * time.Second

// Start 启动后台协程：连接状态机（先探测 /v1/status，再订阅 /v1/stream，断线按退避重连）、
// 10 Hz 合并刷新、5 秒兜底刷新。ctx 取消后全部退出。
func (a *App) Start() {
	go a.runConn()
	go a.runCoalesce()
}

func (a *App) runCoalesce() {
	fast := time.NewTicker(CoalesceEvery)
	slow := time.NewTicker(SafetyPoll)
	defer fast.Stop()
	defer slow.Stop()
	for {
		select {
		case <-a.ctx.Done():
			return
		case <-slow.C:
			a.dirty.Store(true)
		case <-fast.C:
			if a.dirty.Swap(false) {
				a.post(a.refresh) // 只在有新消息时才投递，空闲时不产生帧
			}
		}
	}
}

func (a *App) connOK(stream bool) {
	a.connMu.Lock()
	// 重连中探测成功不清零失败计数（流还没恢复），否则「状态正常但流总失败」会永远停在 1 秒退避
	if stream || a.conn.State == Connecting || a.conn.State == Degraded || a.conn.State == Offline {
		a.conn.OnOK(a.now(), stream)
	}
	a.connMu.Unlock()
	a.post(func() {})
}

func (a *App) connFail(err error) time.Duration {
	msg := err.Error()
	a.connMu.Lock()
	a.conn.OnFail(a.now(), msg)
	d := a.conn.Backoff()
	a.connMu.Unlock()
	a.post(func() {})
	return d
}

func (a *App) runConn() {
	var since string
	sleep := func(d time.Duration) bool {
		select {
		case <-a.ctx.Done():
			return false
		case <-time.After(d):
			return true
		}
	}
	for a.ctx.Err() == nil {
		// 1. 探测（轮询也走这里）：能连上、鉴权通过、协议一致
		if _, err := a.Client.Status(a.ctx); err != nil {
			if a.ctx.Err() != nil {
				return
			}
			if !sleep(a.connFail(err)) {
				return
			}
			continue
		}
		a.connOK(false)
		a.dirty.Store(true)
		// 2. 订阅推送；onOpen 时进入 live
		err := a.Client.Stream(a.ctx, since, nil, nil,
			func() { a.connOK(true); a.dirty.Store(true) },
			func(m api.StreamMessage) {
				if m.StreamID != "" {
					since = m.StreamID
				}
				switch m.Type {
				case "heartbeat":
				case "reset":
					since = "" // 续传点已被挤出：丢弃增量状态，重新拉各列表
					a.post(func() { a.reloadGen++; a.resetIncremental() })
					a.dirty.Store(true)
				default:
					a.dirty.Store(true)
				}
			})
		if a.ctx.Err() != nil {
			return
		}
		if err == nil {
			err = &api.Error{Kind: api.ErrUnreachable, Message: "实时推送连接已关闭"}
		}
		if !sleep(a.connFail(err)) {
			return
		}
	}
}
