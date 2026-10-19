package api

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// 契约测试：test/fixtures/api/*.json 是 TS 与 Go 共用的黄金样例（TS 侧由 packages/daemon/test/golden.test.ts 校验）。
// 这里逐个解码进生成的结构体：
//  1. DisallowUnknownFields —— 样例里有而 Go 结构体没有的字段（schema 漂移）直接报错；
//  2. 往返比较 —— 结构体重新编码后，样例里出现的每个键的值必须一致（抓类型不符、被截断的整数等）；
//  3. schema 的 required 字段必须出现在样例里（样例本身没跑偏）。
var types = map[string]func() any{
	"ConfigValidation": func() any { return new(ConfigValidation) },
	"ConfigView":       func() any { return new(ConfigView) },
	"DangerEvent":      func() any { return new(DangerEvent) },
	"DangerStats":      func() any { return new(DangerStats) },
	"Delivery":         func() any { return new(Delivery) },
	"Hit":              func() any { return new(Hit) },
	"JudgeCallDetail":  func() any { return new(JudgeCallDetail) },
	"JudgeCallList":    func() any { return new(JudgeCallList) },
	"JudgeRoutes":      func() any { return new(JudgeRoutes) },
	"Rule":             func() any { return new(Rule) },
	"RuleList":         func() any { return new(RuleList) },
	"RuleStat":         func() any { return new(RuleStat) },
	"Run":              func() any { return new(Run) },
	"RunDetail":        func() any { return new(RunDetail) },
	"SessionSummary":   func() any { return new(SessionSummary) },
	"Status":           func() any { return new(Status) },
	"StreamMessage":    func() any { return new(StreamMessage) },
	"Timeline":         func() any { return new(Timeline) },
}

const fixtureDir = "../../test/fixtures/api"

func TestGoldenFixtures(t *testing.T) {
	files, err := filepath.Glob(filepath.Join(fixtureDir, "*.json"))
	if err != nil || len(files) == 0 {
		t.Fatalf("没有找到黄金样例 %s: %v", fixtureDir, err)
	}
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		var env struct {
			Schema string            `json:"schema"`
			Value  json.RawMessage   `json:"value"`
			Values []json.RawMessage `json:"values"`
		}
		if err := json.Unmarshal(raw, &env); err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		mk, ok := types[env.Schema]
		if !ok {
			t.Errorf("%s: schema %q 在 Go 侧没有对应类型（生成器或 types 表漏了）", filepath.Base(f), env.Schema)
			continue
		}
		items := env.Values
		if env.Value != nil {
			items = []json.RawMessage{env.Value}
		}
		for i, it := range items {
			checkOne(t, filepath.Base(f), i, env.Schema, mk(), it)
		}
	}
}

func checkOne(t *testing.T, file string, idx int, schema string, dst any, raw json.RawMessage) {
	t.Helper()
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		t.Errorf("%s[%d] 解码进 %s 失败：%v", file, idx, schema, err)
		return
	}
	var want, back map[string]any
	_ = json.Unmarshal(raw, &want)
	enc, err := json.Marshal(dst)
	if err != nil {
		t.Errorf("%s[%d] 重新编码失败：%v", file, idx, err)
		return
	}
	_ = json.Unmarshal(enc, &back)
	if !subset(want, back) {
		t.Errorf("%s[%d] 往返不一致：样例 %v，Go %v", file, idx, want, back)
	}
	for _, k := range Required[schema] {
		if _, ok := want[k]; !ok {
			t.Errorf("%s[%d] 缺少 schema 要求的字段 %q", file, idx, k)
		}
	}
}

// subset 判断 want 里出现的每个键（递归）在 got 里值相同；got 里多出的可选字段（零值）不算差异。
func subset(want, got any) bool {
	switch w := want.(type) {
	case map[string]any:
		g, ok := got.(map[string]any)
		if !ok {
			return false
		}
		for k, v := range w {
			if !subset(v, g[k]) {
				return false
			}
		}
		return true
	case []any:
		g, ok := got.([]any)
		if !ok || len(g) != len(w) {
			return false
		}
		for i := range w {
			if !subset(w[i], g[i]) {
				return false
			}
		}
		return true
	}
	return reflect.DeepEqual(want, got)
}

// 样例里的关键语义：三类危险状态要能从字段里区分出来（outcome 只认 Decision.outcome，不看 applied）。
func TestTimelineGoldenDangerHit(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join(fixtureDir, "Timeline.json"))
	if err != nil {
		t.Fatal(err)
	}
	var env struct {
		Value Timeline `json:"value"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatal(err)
	}
	var hit *TimelineHit
	for _, e := range env.Value.Entries {
		if e.Hit != nil {
			hit = e.Hit
		}
	}
	if hit == nil || !hit.Dangerous || hit.Outcome == nil || *hit.Outcome != "would_have_blocked" || hit.Applied {
		t.Fatalf("危险命中解析不对：%+v", hit)
	}
}
