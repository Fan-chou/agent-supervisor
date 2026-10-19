package app

import (
	"math/rand"
	"time"
)

// ConnState 是顶栏的连接状态（frontend-design §10.2）。
//
//	connecting ─ok→ live ─(心跳超时/连接断)→ reconnecting ─(连续失败 >3 次)→ degraded(轮询)
//	degraded 连续 60 秒失败 → offline（页面变灰，只读保留旧数据）；任何一次成功 → connecting/live
type ConnState int

const (
	Connecting ConnState = iota
	Live
	Reconnecting
	Degraded
	Offline
)

func (s ConnState) String() string {
	return [...]string{"connecting", "live", "reconnecting", "degraded", "offline"}[s]
}

// Label 是顶栏文案（图形 + 文字，不只靠颜色）。
func (s ConnState) Label() string {
	return [...]string{"◐ 连接中", "● 实时", "↻ 重连中", "◑ 降级轮询（每 5 秒）", "✕ 守护进程离线"}[s]
}

const (
	maxReconnects = 3                // 重连失败超过这么多次进入 degraded
	offlineAfter  = 60 * time.Second // degraded 下连续失败这么久进入 offline
	PollEvery     = 5 * time.Second  // degraded 的轮询间隔
	backoffMax    = 30 * time.Second
)

// Machine 是连接状态机。纯逻辑：时间由调用方传入，便于测试。非并发安全（只在主线程用）。
type Machine struct {
	State      ConnState
	Failures   int       // 当前连续失败次数
	FailingFor time.Time // 本轮连续失败的起点（成功时清零）
	LastOK     time.Time // 最后一次成功拿到数据的时间
	LastErr    string
	rnd        *rand.Rand
}

func NewMachine() *Machine { return &Machine{rnd: rand.New(rand.NewSource(time.Now().UnixNano()))} }

// OnOK 记一次成功（流打开，或轮询 status 成功）。
func (m *Machine) OnOK(now time.Time, stream bool) {
	m.Failures = 0
	m.FailingFor = time.Time{}
	m.LastOK = now
	m.LastErr = ""
	switch {
	case stream:
		m.State = Live
	case m.State == Offline || m.State == Degraded:
		// 轮询成功说明守护进程回来了；回到 connecting，由调用方再去开流
		m.State = Connecting
	}
}

// OnFail 记一次失败，返回新状态。
func (m *Machine) OnFail(now time.Time, err string) ConnState {
	m.LastErr = err
	m.Failures++
	if m.FailingFor.IsZero() {
		m.FailingFor = now
	}
	switch m.State {
	case Connecting, Live:
		m.State = Reconnecting
		if m.Failures > maxReconnects {
			m.State = Degraded
		}
	case Reconnecting:
		if m.Failures > maxReconnects {
			m.State = Degraded
		}
	case Degraded:
		if now.Sub(m.FailingFor) >= offlineAfter {
			m.State = Offline
		}
	}
	return m.State
}

// Backoff 返回下次重连前的等待：1s、2s、4s… 上限 30s，±20% 抖动；degraded/offline 固定轮询间隔。
func (m *Machine) Backoff() time.Duration {
	if m.State == Degraded || m.State == Offline {
		return PollEvery
	}
	n := m.Failures
	if n < 1 {
		n = 1
	}
	d := time.Second << (n - 1)
	if d > backoffMax || d <= 0 {
		d = backoffMax
	}
	j := 0.8 + 0.4*m.rnd.Float64()
	return time.Duration(float64(d) * j)
}

// Stale 为真时页面变灰（只读保留旧数据）。
func (m Machine) Stale() bool { return m.State == Offline }
