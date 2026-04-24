package agentroom

import "testing"

func TestModelContextLimit(t *testing.T) {
	cases := []struct {
		model string
		want  int
	}{
		{"", 0},
		{"made-up-local", 0},
		{"claude-opus-4.6", 200_000},
		{"anthropic/claude-3-5-sonnet-20241022", 200_000},
		{"gpt-4o", 128_000},
		{"openai/gpt-4.1-2025-04-14", 1_000_000},
		{"o3-mini", 200_000},
		{"gemini-2.5-pro", 1_000_000},
		{"deepseek-chat", 128_000},
		{"qwen3-max", 128_000},
		{"kimi-k2", 200_000},
		{"moonshot-v1-128k", 200_000},
		{"mistral-large-latest", 32_000},
		{"glm-4.5-air", 128_000},
		{"grok-4", 131_000},
		{"llama-3.1-70b", 128_000},
	}
	for _, tc := range cases {
		t.Run(tc.model, func(t *testing.T) {
			got := ModelContextLimit(tc.model)
			if got != tc.want {
				t.Fatalf("model=%q got=%d want=%d", tc.model, got, tc.want)
			}
		})
	}
}
