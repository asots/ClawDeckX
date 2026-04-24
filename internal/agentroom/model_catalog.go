package agentroom

import "strings"

// ModelContextLimit 返回给定模型 ID 的 context window 大小估计（token 数）。
// 未知模型返回 0，表示前端应隐藏 context pressure 指标。
//
// 匹配策略：前缀 + 子串，忽略大小写和 provider 前缀（如 "anthropic/"）。
// 这里保守估计；具体数字按厂商公开规格。更新节奏参考 openclaw 的 model catalog。
func ModelContextLimit(model string) int {
	if model == "" {
		return 0
	}
	id := strings.ToLower(strings.TrimSpace(model))
	// 去掉 provider 前缀
	if i := strings.Index(id, "/"); i >= 0 {
		id = id[i+1:]
	}
	// 顺序敏感：先特化后通配
	switch {
	// Anthropic Claude
	case strings.Contains(id, "claude-opus-4"), strings.Contains(id, "claude-sonnet-4"):
		return 200_000
	case strings.Contains(id, "claude-3-7-sonnet"), strings.Contains(id, "claude-3.5-sonnet"):
		return 200_000
	case strings.Contains(id, "claude-3-5-sonnet"), strings.Contains(id, "claude-3-haiku"):
		return 200_000
	case strings.HasPrefix(id, "claude-"):
		return 200_000
	// OpenAI GPT
	case strings.Contains(id, "gpt-4.1"):
		return 1_000_000
	case strings.Contains(id, "gpt-4o"):
		return 128_000
	case strings.Contains(id, "o1"), strings.Contains(id, "o3"), strings.Contains(id, "o4"):
		return 200_000
	case strings.HasPrefix(id, "gpt-4"), strings.HasPrefix(id, "gpt-5"):
		return 128_000
	case strings.HasPrefix(id, "gpt-3.5"):
		return 16_000
	// Gemini
	case strings.Contains(id, "gemini-2.5"), strings.Contains(id, "gemini-2"):
		return 1_000_000
	case strings.HasPrefix(id, "gemini-"):
		return 1_000_000
	// DeepSeek
	case strings.HasPrefix(id, "deepseek-"):
		return 128_000
	// Qwen / Tongyi
	case strings.HasPrefix(id, "qwen"):
		return 128_000
	// Kimi / Moonshot
	case strings.Contains(id, "kimi"), strings.HasPrefix(id, "moonshot"):
		return 200_000
	// Mistral / Codestral
	case strings.HasPrefix(id, "mistral"), strings.HasPrefix(id, "codestral"):
		return 32_000
	// GLM
	case strings.HasPrefix(id, "glm-"):
		return 128_000
	// Grok
	case strings.HasPrefix(id, "grok"):
		return 131_000
	// Llama
	case strings.HasPrefix(id, "llama"):
		return 128_000
	}
	return 0
}
