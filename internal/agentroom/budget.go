package agentroom

import "strings"

// ModelRate 按模型类别给出分别的输入/输出每百万 tokens 人民币估价。
// 真实部署时应读取 openclaw.json 的 provider/model 配置，这里只是粗估。
// 参考 models.dev 的常见价格 (CNY ≈ USD × 7)。
type ModelRate struct {
	InputPerM  float64
	OutputPerM float64
}

// CostTable ——输入/输出分开计价。
var CostTable = map[string]ModelRate{
	"claude-opus":   {InputPerM: 105.0, OutputPerM: 525.0}, // $15/$75
	"claude-sonnet": {InputPerM: 21.0, OutputPerM: 105.0},  // $3/$15
	"claude-haiku":  {InputPerM: 5.6, OutputPerM: 28.0},    // $0.8/$4
	"gpt-5":         {InputPerM: 87.5, OutputPerM: 350.0},  // $12.5/$50
	"gpt-5-mini":    {InputPerM: 17.5, OutputPerM: 70.0},   // $2.5/$10
	"gpt-4o":        {InputPerM: 17.5, OutputPerM: 70.0},
	"gpt-4o-mini":   {InputPerM: 1.05, OutputPerM: 4.2},
	"deepseek":      {InputPerM: 2.0, OutputPerM: 8.0},
	"qwen":          {InputPerM: 2.8, OutputPerM: 11.2},
	"gemini-pro":    {InputPerM: 8.75, OutputPerM: 35.0},
	"gemini-flash":  {InputPerM: 0.7, OutputPerM: 2.8},
	"default":       {InputPerM: 14.0, OutputPerM: 42.0},
}

// EstimateCostCNYSplit 输入与输出 tokens 分开计价，返回 CNY 估价。
func EstimateCostCNYSplit(model string, inputTokens, outputTokens int) float64 {
	rate := matchModelRate(model)
	cost := 0.0
	if inputTokens > 0 {
		cost += float64(inputTokens) * rate.InputPerM / 1_000_000.0
	}
	if outputTokens > 0 {
		cost += float64(outputTokens) * rate.OutputPerM / 1_000_000.0
	}
	return cost
}

// EstimateCostCNY（保留兼容）——总 tokens 估价；当无法区分输入/输出时使用。
// 取输入/输出均价做估算。
func EstimateCostCNY(model string, tokens int) float64 {
	if tokens <= 0 {
		return 0
	}
	rate := matchModelRate(model)
	avg := (rate.InputPerM + rate.OutputPerM) / 2
	return float64(tokens) * avg / 1_000_000.0
}

// EstimateCostMilliSplit 返回"分厘"（×10000，避免浮点累积误差）。
func EstimateCostMilliSplit(model string, inputTokens, outputTokens int) int64 {
	return int64(EstimateCostCNYSplit(model, inputTokens, outputTokens) * 10000)
}

// EstimateCostMilli（保留兼容）
func EstimateCostMilli(model string, tokens int) int64 {
	return int64(EstimateCostCNY(model, tokens) * 10000)
}

func matchModelRate(model string) ModelRate {
	m := strings.ToLower(strings.TrimSpace(model))
	if m == "" {
		return CostTable["default"]
	}
	// 剥 provider 前缀
	if idx := strings.Index(m, "/"); idx > 0 {
		m = m[idx+1:]
	}
	for key, rate := range CostTable {
		if key == "default" {
			continue
		}
		if strings.Contains(m, key) {
			return rate
		}
	}
	return CostTable["default"]
}

// EstimateTokens 粗略估算 tokens：中文 ≈ 1 字 1 token，英文 ≈ 4 字符 1 token。
// 真实应该走 tiktoken/provider counter；这里是 fallback。
func EstimateTokens(s string) int {
	if s == "" {
		return 0
	}
	runes := []rune(s)
	cjk := 0
	other := 0
	for _, r := range runes {
		if r >= 0x4E00 && r <= 0x9FFF {
			cjk++
		} else {
			other++
		}
	}
	return cjk + other/4 + 1
}
