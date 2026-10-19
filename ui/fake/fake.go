// Package fake 是一个进程内的「假守护进程」：用自己构造的合成数据回答 UI 用到的全部 GET 接口
// 和 PUT /v1/rules/{id}。用途：契约/截图测试（不发网络请求、不依赖真守护进程）和 `sv-ui -demo`。
// 数据全是合成的（不含任何真实会话内容）。
package fake

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Fan-chou/agent-supervisor/ui/api"
)

// Server 包着 httptest.Server；Data 可在启动前改。
type Server struct {
	*httptest.Server
	mu    sync.Mutex
	Now   func() time.Time
	Mode  string
	Rules []api.Rule
	// StreamEvery > 0 时 /v1/stream 每隔这么久发一条 heartbeat；0 发一条 status 后保持连接。
	StreamEvery time.Duration
	// Offline 为真时所有请求返回 503（演示断线）。
	Offline bool
	// Puts 记录收到的 PUT（测试用）。
	Puts []string
}

func ptr[T any](v T) *T { return &v }

// New 启动假守护进程（127.0.0.1 随机端口，无需 token）。
func New() *Server {
	s := &Server{Now: time.Now, Mode: "shadow", StreamEvery: 15 * time.Second}
	s.Rules = defaultRules()
	s.Server = httptest.NewServer(http.HandlerFunc(s.serve))
	return s
}

// SetOffline 切换「断线」演示：开启后所有请求返回 503。
func (s *Server) SetOffline(v bool) {
	s.mu.Lock()
	s.Offline = v
	s.mu.Unlock()
}

func (s *Server) ms(ago time.Duration) int64 { return s.Now().Add(-ago).UnixMilli() }

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-SV-Protocol", "1")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func errJSON(w http.ResponseWriter, code int, c, msg string) {
	writeJSON(w, code, map[string]any{"error": map[string]any{"code": c, "message": msg, "retryable": code >= 500}})
}

func (s *Server) serve(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	off := s.Offline
	s.mu.Unlock()
	if off {
		errJSON(w, 503, "offline", "守护进程不可用（演示）")
		return
	}
	p := r.URL.Path
	q := r.URL.Query()
	switch {
	case p == "/v1/hello":
		writeJSON(w, 200, api.Hello{Protocol: 1, Version: "0.1.0", Mode: s.Mode, StartedAt: s.ms(3 * time.Hour)})
	case p == "/v1/status":
		writeJSON(w, 200, s.status())
	case p == "/v1/stream":
		s.stream(w, r)
	case p == "/v1/sessions":
		writeJSON(w, 200, api.SessionList{Sessions: s.sessions(q)})
	case strings.HasPrefix(p, "/v1/sessions/"):
		s.sessionSub(w, p, q)
	case p == "/v1/hits":
		writeJSON(w, 200, s.hits(q))
	case strings.HasPrefix(p, "/v1/hits/"):
		id, _ := strconv.ParseInt(strings.TrimPrefix(p, "/v1/hits/"), 10, 64)
		writeJSON(w, 200, s.explain(id))
	case p == "/v1/runs":
		writeJSON(w, 200, api.RunList{Runs: s.runs()})
	case p == "/v1/runs/compare":
		writeJSON(w, 200, s.compare())
	case strings.HasPrefix(p, "/v1/runs/"):
		id, _ := strconv.ParseInt(strings.TrimPrefix(p, "/v1/runs/"), 10, 64)
		writeJSON(w, 200, s.runDetail(id))
	case p == "/v1/eval/reports":
		writeJSON(w, 200, api.EvalReportList{Reports: s.evalReports()})
	case p == "/v1/rules/stats":
		if q.Get("by") == "model" {
			writeJSON(w, 200, api.ModelRuleStatList{By: "model", Rows: s.modelStats()})
		} else {
			writeJSON(w, 200, api.RuleStatList{By: "rule", Rows: s.ruleStats()})
		}
	case p == "/v1/rules":
		s.mu.Lock()
		defer s.mu.Unlock()
		writeJSON(w, 200, api.RuleList{Rules: s.Rules, Mode: s.Mode})
	case strings.HasPrefix(p, "/v1/rules/") && r.Method == http.MethodPut:
		s.putRule(w, r, strings.TrimPrefix(p, "/v1/rules/"))
	case p == "/v1/config":
		writeJSON(w, 200, s.config())
	case p == "/v1/judge-calls":
		writeJSON(w, 200, s.judgeCalls())
	case p == "/v1/judge-calls/stats":
		writeJSON(w, 200, api.JudgeStatList{Rows: s.judgeStats()})
	case strings.HasPrefix(p, "/v1/judge-calls/"):
		id, _ := strconv.ParseInt(strings.TrimPrefix(p, "/v1/judge-calls/"), 10, 64)
		writeJSON(w, 200, s.judgeDetail(id))
	case p == "/v1/danger/stats":
		writeJSON(w, 200, s.dangerStats())
	case p == "/v1/danger/events":
		writeJSON(w, 200, api.DangerEventList{Events: s.dangerEvents()})
	default:
		errJSON(w, 404, "not_found", p)
	}
}

func (s *Server) status() api.Status {
	return api.Status{Protocol: 1, Version: "0.1.0", Mode: s.Mode, StartedAt: s.ms(3 * time.Hour), RunID: 1, Db: "~/.agent-supervisor/state.db", Sessions: 3,
		Outbox: map[string]int64{"pending": 0, "delivered": 4}, AdapterFailures15m: map[string]int64{"claude": 0, "codex": 1, "opencode": 0},
		Judge: api.StatusJudge{Enabled: true, Model: "supervisor-judge"}}
}

func (s *Server) stream(w http.ResponseWriter, r *http.Request) {
	fl, _ := w.(http.Flusher)
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("X-SV-Protocol", "1")
	w.WriteHeader(200)
	enc := json.NewEncoder(w)
	_ = enc.Encode(api.StreamMessage{StreamID: "demo.1", Type: "status", Ts: s.Now().UnixMilli(), Mode: s.Mode, RunID: 1, Sessions: 3})
	if fl != nil {
		fl.Flush()
	}
	if s.StreamEvery <= 0 {
		<-r.Context().Done()
		return
	}
	n := 1
	t := time.NewTicker(s.StreamEvery)
	defer t.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-t.C:
			n++
			_ = enc.Encode(api.StreamMessage{StreamID: fmt.Sprintf("demo.%d", n), Type: "heartbeat", Ts: s.Now().UnixMilli()})
			if fl != nil {
				fl.Flush()
			}
		}
	}
}

func (s *Server) putRule(w http.ResponseWriter, r *http.Request, id string) {
	var body api.RuleEdit
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		errJSON(w, 400, "bad_request", "body 不是合法 JSON")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	raw, _ := json.Marshal(body)
	s.Puts = append(s.Puts, id+" "+string(raw))
	for i := range s.Rules {
		ru := &s.Rules[i]
		if ru.ID != id {
			continue
		}
		if ru.Protected {
			errJSON(w, 403, "protected_rule", id+" 是受保护的安全规则，不能通过界面停用或修改")
			return
		}
		if body.Reset {
			ru.Disabled, ru.Edited, ru.Override = false, false, nil
		}
		if body.Disabled != nil {
			ru.Disabled, ru.Edited = *body.Disabled, true
		}
		for k, v := range body.Thresholds {
			if nested, ok := v.(map[string]any); ok {
				cur, _ := ru.Thresholds[k].(map[string]any)
				if cur == nil {
					cur = map[string]any{}
				}
				for lk, lv := range nested {
					if f, ok := lv.(float64); ok && f < 1 {
						errJSON(w, 400, "invalid_threshold", fmt.Sprintf("ladder.%s：需要 1 到 1000000 的整数", lk))
						return
					}
					cur[lk] = lv
				}
				ru.Thresholds[k] = cur
			} else {
				if f, ok := v.(float64); ok && f < 1 {
					errJSON(w, 400, "invalid_threshold", fmt.Sprintf("%s：需要 1 到 1000000 的整数", k))
					return
				}
				ru.Thresholds[k] = v
			}
			ru.Edited = true
		}
		writeJSON(w, 200, map[string]any{"ok": true, "rule": ru, "changes": []any{}, "appliesTo": "all_sessions"})
		return
	}
	errJSON(w, 404, "unknown_rule", "没有规则 "+id)
}
