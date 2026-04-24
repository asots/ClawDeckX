package agentroom

import "testing"

func TestEstimateCostCNYSplit_OutputMoreExpensive(t *testing.T) {
	input := EstimateCostCNYSplit("claude-sonnet", 1_000_000, 0)
	output := EstimateCostCNYSplit("claude-sonnet", 0, 1_000_000)
	if output <= input {
		t.Fatalf("output should cost more than input: in=%.3f out=%.3f", input, output)
	}
}

func TestEstimateCostCNYSplit_DefaultModel(t *testing.T) {
	// Unknown model → falls back to "default"
	got := EstimateCostCNYSplit("totally-unknown-model", 1_000_000, 0)
	want := CostTable["default"].InputPerM // CNY per 1M input
	if got != want {
		t.Fatalf("expect %.3f, got %.3f", want, got)
	}
}

func TestEstimateCostCNYSplit_ZeroTokens(t *testing.T) {
	if got := EstimateCostCNYSplit("gpt-5", 0, 0); got != 0 {
		t.Fatalf("expect 0, got %.6f", got)
	}
}

func TestEstimateCostMilliSplit_RoundsDown(t *testing.T) {
	// 1 input token at claude-sonnet: 21/1e6 CNY = 21e-6 CNY × 10000 = 0.21 分厘 → int64 truncates to 0
	got := EstimateCostMilliSplit("claude-sonnet", 1, 0)
	if got != 0 {
		t.Fatalf("expect truncation to 0, got %d", got)
	}
	// With 1M input tokens: 21 CNY × 10000 = 210_000 分厘
	got = EstimateCostMilliSplit("claude-sonnet", 1_000_000, 0)
	if got != 210_000 {
		t.Fatalf("expect 210000, got %d", got)
	}
}

func TestEstimateTokens_CJKHeavierThanASCII(t *testing.T) {
	cjk := EstimateTokens("你好世界今天") // 6 CJK chars
	ascii := EstimateTokens("hello world today") // 17 ASCII chars
	if cjk < 6 {
		t.Fatalf("CJK should be ~1 token per char, got %d", cjk)
	}
	// 17/4 + 1 ≈ 5 tokens for ASCII
	if ascii > cjk {
		t.Fatalf("CJK 6 chars should weigh more than ASCII 17 chars: cjk=%d ascii=%d", cjk, ascii)
	}
}

func TestEstimateTokens_EmptyZero(t *testing.T) {
	if got := EstimateTokens(""); got != 0 {
		t.Fatalf("expect 0, got %d", got)
	}
}

func TestMatchModelRate_StripsProviderPrefix(t *testing.T) {
	rate := matchModelRate("anthropic/claude-sonnet-4")
	if rate.InputPerM != 21.0 {
		t.Fatalf("expect claude-sonnet rate via prefix strip, got %.2f", rate.InputPerM)
	}
}
