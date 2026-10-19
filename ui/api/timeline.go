package api

import (
	"encoding/json"
	"fmt"
)

// TimelineEntry 是 schema 里 oneOf(TimelineCall | TimelineEvent | TimelineHit) 的 Go 形态，
// 按 "type" 分派；恰有一个指针非空。（oneOf 不由生成器处理，所以手写。）
type TimelineEntry struct {
	Type  string
	Call  *TimelineCall
	Event *TimelineEvent
	Hit   *TimelineHit
}

// Seq 是条目的会话内序号。
func (e TimelineEntry) Seq() int64 {
	switch {
	case e.Call != nil:
		return e.Call.Seq
	case e.Event != nil:
		return e.Event.Seq
	case e.Hit != nil:
		return e.Hit.Seq
	}
	return 0
}

// Ts 是条目时间（epoch 毫秒）。
func (e TimelineEntry) Ts() int64 {
	switch {
	case e.Call != nil:
		return e.Call.Ts
	case e.Event != nil:
		return e.Event.Ts
	case e.Hit != nil:
		return e.Hit.Ts
	}
	return 0
}

// MarshalJSON 写回具体的那一种（契约测试做往返比较用）。
func (e TimelineEntry) MarshalJSON() ([]byte, error) {
	switch {
	case e.Call != nil:
		return json.Marshal(e.Call)
	case e.Event != nil:
		return json.Marshal(e.Event)
	case e.Hit != nil:
		return json.Marshal(e.Hit)
	}
	return []byte("null"), nil
}

// UnmarshalJSON 按 type 解码；未知 type 返回错误（调用方把这一条记为「无法解析」，其余照常，§12.1）。
func (e *TimelineEntry) UnmarshalJSON(b []byte) error {
	var head struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(b, &head); err != nil {
		return err
	}
	*e = TimelineEntry{Type: head.Type}
	switch head.Type {
	case "call":
		e.Call = new(TimelineCall)
		return json.Unmarshal(b, e.Call)
	case "event":
		e.Event = new(TimelineEvent)
		return json.Unmarshal(b, e.Event)
	case "hit":
		e.Hit = new(TimelineHit)
		return json.Unmarshal(b, e.Hit)
	}
	return fmt.Errorf("unknown timeline entry type %q", head.Type)
}
