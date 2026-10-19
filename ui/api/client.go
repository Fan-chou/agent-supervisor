// Package api 是守护进程本地 API 的 Go 客户端：UDS 优先，或 127.0.0.1 HTTP + token。
// 界面只经由它与守护进程通信（不读 SQLite、transcript、.env）。除 PutRule 外全部是 GET。
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// Protocol 是本客户端说的协议版本（X-SV-Protocol）。
const Protocol = 1

// ErrKind 把请求失败归到界面要区分的几类（frontend-design §12.1）。
type ErrKind int

const (
	ErrUnreachable ErrKind = iota // 守护进程没在跑（socket 不存在、连接被拒、超时）
	ErrAuth                       // 401/403
	ErrProtocol                   // 426，或响应的 X-SV-Protocol 不同
	ErrHTTP                       // 其它 4xx/5xx
	ErrSchema                     // 响应不是预期的 JSON
)

// Error 是客户端返回的统一错误；Message 来自守护进程，已脱敏，不含 key 或 Authorization 头。
type Error struct {
	Kind      ErrKind
	Status    int
	Code      string
	Message   string
	Retryable bool
}

func (e *Error) Error() string {
	if e.Status != 0 {
		return fmt.Sprintf("HTTP %d %s: %s", e.Status, e.Code, e.Message)
	}
	return e.Message
}

// Client 说话对象是一个守护进程。零值不可用，用 NewUnix / NewHTTP。
type Client struct {
	hc    *http.Client // 普通请求，有超时
	sc    *http.Client // 长连接（stream），无总超时
	base  string
	token string
	Actor string // PUT 时写进 X-SV-Actor（审计用）
}

func newTransport(dial func(ctx context.Context, network, addr string) (net.Conn, error)) *http.Transport {
	return &http.Transport{DialContext: dial, MaxIdleConns: 4, IdleConnTimeout: 30 * time.Second, DisableCompression: true}
}

// NewUnix 通过 UDS 连接守护进程（鉴权靠 socket 文件的 0600 权限，不需要 token）。
func NewUnix(sock string) *Client {
	dial := func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "unix", sock)
	}
	tr := newTransport(dial)
	return &Client{hc: &http.Client{Transport: tr, Timeout: 10 * time.Second}, sc: &http.Client{Transport: tr}, base: "http://sv", Actor: "ui"}
}

// NewHTTP 通过 http://127.0.0.1:<port> + Bearer token 连接。
func NewHTTP(base, token string) *Client {
	tr := newTransport(nil)
	return &Client{hc: &http.Client{Transport: tr, Timeout: 10 * time.Second}, sc: &http.Client{Transport: tr}, base: strings.TrimRight(base, "/"), token: token, Actor: "ui"}
}

// CheckPerm 检查 socket / token 文件权限是否是 0600（§9：不是就在顶栏警告）。文件不存在时返回 ("", nil)。
func CheckPerm(path string) (warn string) {
	st, err := os.Stat(path)
	if err != nil {
		return ""
	}
	if st.Mode().Perm()&0o077 != 0 {
		return fmt.Sprintf("%s 的权限是 %04o，应为 0600", path, st.Mode().Perm())
	}
	return ""
}

func (c *Client) do(ctx context.Context, hc *http.Client, method, path string, q url.Values, body []byte) (*http.Response, error) {
	u := c.base + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rd)
	if err != nil {
		return nil, &Error{Kind: ErrUnreachable, Message: err.Error()}
	}
	req.Header.Set("X-SV-Protocol", strconv.Itoa(Protocol))
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-SV-Actor", c.Actor)
	}
	resp, err := hc.Do(req)
	if err != nil {
		return nil, &Error{Kind: ErrUnreachable, Message: unreachableMsg(err)}
	}
	if p := resp.Header.Get("X-SV-Protocol"); p != "" && p != strconv.Itoa(Protocol) {
		resp.Body.Close()
		return nil, &Error{Kind: ErrProtocol, Status: resp.StatusCode, Code: "protocol_mismatch", Message: fmt.Sprintf("守护进程协议 %s，界面协议 %d", p, Protocol)}
	}
	if resp.StatusCode >= 400 {
		defer resp.Body.Close()
		return nil, decodeError(resp)
	}
	return resp, nil
}

func unreachableMsg(err error) string {
	var ne net.Error
	switch {
	case errors.Is(err, context.Canceled):
		return "请求已取消"
	case errors.As(err, &ne) && ne.Timeout():
		return "守护进程响应超时"
	case errors.Is(err, os.ErrNotExist):
		return "守护进程未运行（socket 不存在）"
	}
	return "无法连接守护进程：" + trimErr(err)
}

// trimErr 去掉 url.Error 里带的 URL（里面可能有 token 之外的查询参数，也没必要给人看）。
func trimErr(err error) string {
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err.Error()
	}
	return err.Error()
}

func decodeError(resp *http.Response) *Error {
	e := &Error{Kind: ErrHTTP, Status: resp.StatusCode}
	switch resp.StatusCode {
	case 401, 403:
		e.Kind = ErrAuth
	case 426:
		e.Kind = ErrProtocol
	}
	var env struct {
		Error struct {
			Code      string `json:"code"`
			Message   string `json:"message"`
			Retryable bool   `json:"retryable"`
		} `json:"error"`
	}
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if json.Unmarshal(b, &env) == nil && env.Error.Code != "" {
		e.Code, e.Message, e.Retryable = env.Error.Code, env.Error.Message, env.Error.Retryable
	} else {
		e.Code, e.Message = "http_"+strconv.Itoa(resp.StatusCode), http.StatusText(resp.StatusCode)
		e.Retryable = resp.StatusCode >= 500
	}
	return e
}

// Get 取一个 JSON 资源并解码进 out。
func (c *Client) Get(ctx context.Context, path string, q url.Values, out any) error {
	resp, err := c.do(ctx, c.hc, http.MethodGet, path, q, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return &Error{Kind: ErrUnreachable, Message: unreachableMsg(err)}
	}
	if err := json.Unmarshal(b, out); err != nil {
		return &Error{Kind: ErrSchema, Status: resp.StatusCode, Code: "schema", Message: "响应无法解析：" + err.Error()}
	}
	return nil
}

func get[T any](c *Client, ctx context.Context, path string, q url.Values) (T, error) {
	var v T
	err := c.Get(ctx, path, q, &v)
	return v, err
}

// ---- 只读查询（路径与 daemon 的 query-api.ts 一一对应） ----

func (c *Client) Hello(ctx context.Context) (Hello, error) {
	return get[Hello](c, ctx, "/v1/hello", nil)
}
func (c *Client) Status(ctx context.Context) (Status, error) {
	return get[Status](c, ctx, "/v1/status", nil)
}
func (c *Client) Sessions(ctx context.Context, q url.Values) ([]SessionSummary, error) {
	r, err := get[SessionList](c, ctx, "/v1/sessions", q)
	return r.Sessions, err
}
func (c *Client) Children(ctx context.Context, id string) ([]ChildSession, error) {
	r, err := get[ChildList](c, ctx, "/v1/sessions/"+url.PathEscape(id)+"/children", nil)
	return r.Children, err
}
func (c *Client) Timeline(ctx context.Context, id string, q url.Values) (Timeline, error) {
	return get[Timeline](c, ctx, "/v1/sessions/"+url.PathEscape(id)+"/timeline", q)
}
func (c *Client) Hits(ctx context.Context, q url.Values) (HitList, error) {
	return get[HitList](c, ctx, "/v1/hits", q)
}
func (c *Client) Explain(ctx context.Context, hitID int64) (Explain, error) {
	return get[Explain](c, ctx, "/v1/hits/"+strconv.FormatInt(hitID, 10), nil)
}
func (c *Client) Runs(ctx context.Context) ([]Run, error) {
	r, err := get[RunList](c, ctx, "/v1/runs", nil)
	return r.Runs, err
}
func (c *Client) RunDetail(ctx context.Context, id int64) (RunDetail, error) {
	return get[RunDetail](c, ctx, "/v1/runs/"+strconv.FormatInt(id, 10), nil)
}
func (c *Client) Compare(ctx context.Context, a, b int64) (RunCompare, error) {
	return get[RunCompare](c, ctx, "/v1/runs/compare", url.Values{"a": {strconv.FormatInt(a, 10)}, "b": {strconv.FormatInt(b, 10)}})
}
func (c *Client) EvalReports(ctx context.Context) ([]EvalReport, error) {
	r, err := get[EvalReportList](c, ctx, "/v1/eval/reports", nil)
	return r.Reports, err
}
func (c *Client) RuleStats(ctx context.Context, q url.Values) ([]RuleStat, error) {
	r, err := get[RuleStatList](c, ctx, "/v1/rules/stats", q)
	return r.Rows, err
}
func (c *Client) ModelRuleStats(ctx context.Context, q url.Values) ([]ModelRuleStat, error) {
	if q == nil {
		q = url.Values{}
	}
	q.Set("by", "model")
	r, err := get[ModelRuleStatList](c, ctx, "/v1/rules/stats", q)
	return r.Rows, err
}
func (c *Client) Rules(ctx context.Context) (RuleList, error) {
	return get[RuleList](c, ctx, "/v1/rules", nil)
}
func (c *Client) Config(ctx context.Context) (ConfigView, error) {
	return get[ConfigView](c, ctx, "/v1/config", nil)
}
func (c *Client) JudgeCalls(ctx context.Context, q url.Values) (JudgeCallList, error) {
	return get[JudgeCallList](c, ctx, "/v1/judge-calls", q)
}
func (c *Client) JudgeCall(ctx context.Context, id int64) (JudgeCallDetail, error) {
	return get[JudgeCallDetail](c, ctx, "/v1/judge-calls/"+strconv.FormatInt(id, 10), nil)
}
func (c *Client) JudgeStats(ctx context.Context, q url.Values) ([]JudgeStat, error) {
	r, err := get[JudgeStatList](c, ctx, "/v1/judge-calls/stats", q)
	return r.Rows, err
}
func (c *Client) JudgeRoutes(ctx context.Context, q url.Values) (JudgeRoutes, error) {
	return get[JudgeRoutes](c, ctx, "/v1/judge/routes", q)
}
func (c *Client) DangerStats(ctx context.Context, q url.Values) (DangerStats, error) {
	return get[DangerStats](c, ctx, "/v1/danger/stats", q)
}
func (c *Client) DangerEvents(ctx context.Context, q url.Values) ([]DangerEvent, error) {
	r, err := get[DangerEventList](c, ctx, "/v1/danger/events", q)
	return r.Events, err
}

// Hello 是 GET /v1/hello 的响应（连接探测用）。
type Hello struct {
	Protocol  int    `json:"protocol"`
	Version   string `json:"version"`
	Mode      string `json:"mode"`
	StartedAt int64  `json:"startedAt"`
}

// PutRule 是界面唯一的写操作：PUT /v1/rules/{id}。以服务端响应为准，失败原样返回服务端的错误（含 errors 明细）。
func (c *Client) PutRule(ctx context.Context, id string, edit RuleEdit) (RuleEditResult, error) {
	b, err := json.Marshal(edit)
	if err != nil {
		return RuleEditResult{}, err
	}
	resp, err := c.do(ctx, c.hc, http.MethodPut, "/v1/rules/"+url.PathEscape(id), nil, b)
	if err != nil {
		return RuleEditResult{}, err
	}
	defer resp.Body.Close()
	var out RuleEditResult
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&out); err != nil {
		return out, &Error{Kind: ErrSchema, Code: "schema", Message: "响应无法解析：" + err.Error()}
	}
	return out, nil
}
