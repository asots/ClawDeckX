package agentroom

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func TestWriteMetrics_EmptyRegistryProducesZeros(t *testing.T) {
	// Reset registry to fresh state for deterministic output
	resetMetricsForTest()
	var buf bytes.Buffer
	WriteMetrics(&buf)
	out := buf.String()
	// 必要的 metric 名应该至少出现一次（带 0 值）
	for _, name := range []string{
		"agentroom_llm_calls_total",
		"agentroom_llm_tokens_total",
		"agentroom_llm_cost_cny_total",
		"agentroom_llm_duration_seconds",
		"agentroom_rooms_total",
		"agentroom_rooms_active",
		"agentroom_breaker_open",
		"agentroom_messages_total",
		"agentroom_user_messages_total",
		"agentroom_ratelimit_rejected_total",
		"agentroom_uptime_seconds",
	} {
		if !strings.Contains(out, "# HELP "+name) {
			t.Errorf("missing # HELP for %s", name)
		}
		if !strings.Contains(out, name) {
			t.Errorf("metric %s not emitted", name)
		}
	}
}

func TestMetricLLMCall_RecordsCounterAndDuration(t *testing.T) {
	resetMetricsForTest()
	MetricLLMCall("claude-sonnet", "ok", 120*time.Millisecond)
	MetricLLMCall("claude-sonnet", "ok", 200*time.Millisecond)
	MetricLLMCall("claude-sonnet", "error", 50*time.Millisecond)

	var buf bytes.Buffer
	WriteMetrics(&buf)
	out := buf.String()

	// counter 有两行：ok=2, error=1
	if !strings.Contains(out, `agentroom_llm_calls_total{model="claude-sonnet",status="ok"} 2`) {
		t.Errorf("ok counter wrong; output:\n%s", out)
	}
	if !strings.Contains(out, `agentroom_llm_calls_total{model="claude-sonnet",status="error"} 1`) {
		t.Errorf("error counter wrong; output:\n%s", out)
	}
	// summary 输出三个分位
	for _, q := range []string{"0.5", "0.9", "0.99"} {
		if !strings.Contains(out, "quantile=\""+q+"\"") {
			t.Errorf("missing quantile %s", q)
		}
	}
}

func TestMetricLLMTokens_ByKind(t *testing.T) {
	resetMetricsForTest()
	MetricLLMTokens("gpt-5", "input", 1200)
	MetricLLMTokens("gpt-5", "output", 600)
	MetricLLMTokens("gpt-5", "input", 300)

	var buf bytes.Buffer
	WriteMetrics(&buf)
	out := buf.String()

	if !strings.Contains(out, `agentroom_llm_tokens_total{kind="input",model="gpt-5"} 1500`) {
		t.Errorf("input total wrong:\n%s", out)
	}
	if !strings.Contains(out, `agentroom_llm_tokens_total{kind="output",model="gpt-5"} 600`) {
		t.Errorf("output total wrong:\n%s", out)
	}
}

func TestMetricLLMCost_Accumulates(t *testing.T) {
	resetMetricsForTest()
	MetricLLMCost("deepseek", 1.5)
	MetricLLMCost("deepseek", 2.5)
	var buf bytes.Buffer
	WriteMetrics(&buf)
	out := buf.String()
	if !strings.Contains(out, `agentroom_llm_cost_cny_total{model="deepseek"}`) {
		t.Errorf("cost metric missing:\n%s", out)
	}
	// 数值可能写成 "4" 或 "4.0"；strings 子串判断靠数字前缀更稳
	if !strings.Contains(out, `deepseek"} 4`) {
		t.Errorf("cost sum should be 4; got:\n%s", out)
	}
}

func TestMetricRoomCounts_Gauges(t *testing.T) {
	resetMetricsForTest()
	MetricRoomCounts(10, 3)
	var buf bytes.Buffer
	WriteMetrics(&buf)
	out := buf.String()
	if !strings.Contains(out, "agentroom_rooms_total 10") {
		t.Errorf("rooms_total expected 10:\n%s", out)
	}
	if !strings.Contains(out, "agentroom_rooms_active 3") {
		t.Errorf("rooms_active expected 3:\n%s", out)
	}
}

func TestMetricBreakerState_Flips(t *testing.T) {
	resetMetricsForTest()
	MetricBreakerState("m1", true)
	MetricBreakerState("m2", false)
	var buf bytes.Buffer
	WriteMetrics(&buf)
	out := buf.String()
	if !strings.Contains(out, `agentroom_breaker_open{model="m1"} 1`) {
		t.Errorf("m1 expected 1:\n%s", out)
	}
	if !strings.Contains(out, `agentroom_breaker_open{model="m2"} 0`) {
		t.Errorf("m2 expected 0:\n%s", out)
	}
}

func TestFormatLabels_Escape(t *testing.T) {
	got := formatLabels([]labelKV{{Key: "k", Val: `a"b\c`}})
	want := `{k="a\"b\\c"}`
	if got != want {
		t.Fatalf("escape wrong: got=%s want=%s", got, want)
	}
}

func TestEscapeLabelValue_Newline(t *testing.T) {
	if got := escapeLabelValue("a\nb"); got != `a\nb` {
		t.Fatalf("newline escape wrong: %q", got)
	}
}

// resetMetricsForTest 把 registry 重置为干净状态（测试用）。
// 并行测试不安全；所有 observability_test.go 都走单线程即可。
func resetMetricsForTest() {
	metrics = &metricsRegistry{
		LLMCalls:        newCounterVec(),
		LLMTokens:       newCounterVec(),
		LLMCostCNY:      newCounterFloatVec(),
		LLMDuration:     newSampleRing(),
		RoomsTotal:      newGaugeVec(),
		RoomsActive:     newGaugeVec(),
		BreakerOpen:     newGaugeVec(),
		MessagesTotal:   newCounterVec(),
		UserMessages:    newCounterVec(),
		RateLimitReject: newCounterVec(),
		StartedAt:       time.Now(),
	}
}
