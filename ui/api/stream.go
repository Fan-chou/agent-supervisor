package api

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// StreamIdleTimeout：超过这么久没收到任何消息（含心跳）就视为断开（§10.1，心跳每 5 秒一条）。
const StreamIdleTimeout = 45 * time.Second

// Stream 订阅 GET /v1/stream，用 NDJSON（每行一个 StreamMessage；HTTP 与 UDS 都显式要 ndjson，不解析 SSE）。
// since 是上次收到的 streamId（断线续传）；types / sessions 是订阅过滤（空 = 全部）。
// 连接建立后调用 onOpen，之后每条消息调用 onMsg；返回时流已结束，err 说明原因（ctx 取消时为 ctx.Err()）。
func (c *Client) Stream(ctx context.Context, since string, types, sessions []string, onOpen func(), onMsg func(StreamMessage)) error {
	q := url.Values{"format": {"ndjson"}}
	if since != "" {
		q.Set("since", since)
	}
	if len(types) > 0 {
		q.Set("types", strings.Join(types, ","))
	}
	if len(sessions) > 0 {
		q.Set("sessions", strings.Join(sessions, ","))
	}
	sctx, cancel := context.WithCancel(ctx)
	defer cancel()
	resp, err := c.do(sctx, c.sc, http.MethodGet, "/v1/stream", q, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if onOpen != nil {
		onOpen()
	}
	idle := time.AfterFunc(StreamIdleTimeout, cancel)
	defer idle.Stop()
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 64<<10), 4<<20)
	for sc.Scan() {
		idle.Reset(StreamIdleTimeout)
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var m StreamMessage
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			continue // 一行解析不了就跳过，其余照常（§12.1）
		}
		onMsg(m)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if sctx.Err() != nil {
		return &Error{Kind: ErrUnreachable, Message: "实时推送超过 45 秒没有消息，视为断开"}
	}
	if err := sc.Err(); err != nil {
		return &Error{Kind: ErrUnreachable, Message: unreachableMsg(err)}
	}
	return &Error{Kind: ErrUnreachable, Message: "实时推送连接已关闭"}
}
