package agentroom

import (
	"sort"

	"ClawDeckX/internal/database"
)

// Metrics 聚合房间行为指标，直接从 DB 计算（不做长期存储）。
// 对应前端 RoomMetrics。P0 只提供可计算的字段；语义指标（agreement/infoGain）留空待 P1。
type Metrics struct {
	AgreementScore    float64            `json:"agreementScore"`
	InfoGainTrend     string             `json:"infoGainTrend"` // up | down | flat
	DominanceGini     float64            `json:"dominanceGini"`
	ConvergenceRounds *int               `json:"convergenceRounds"`
	ToolUsageRate     float64            `json:"toolUsageRate"`
	TotalMessages     int                `json:"totalMessages"`
	TotalTokens       int64              `json:"totalTokens"`
	PerMember         []MetricsPerMember `json:"perMember"`
}

type MetricsPerMember struct {
	MemberID string  `json:"memberId"`
	Messages int     `json:"messages"`
	Tokens   int64   `json:"tokens"`
	CostCNY  float64 `json:"costCNY"`
}

// ComputeMetrics 根据房间的 members + messages 快照计算指标。
func ComputeMetrics(members []database.AgentRoomMember, messages []database.AgentRoomMessage) *Metrics {
	perIdx := make(map[string]int, len(members))
	per := make([]MetricsPerMember, 0, len(members))
	for _, m := range members {
		perIdx[m.ID] = len(per)
		per = append(per, MetricsPerMember{MemberID: m.ID})
	}

	totalMsgs := 0
	var totalTokens int64
	toolCalls := 0
	chatMsgs := 0
	for i := range messages {
		m := &messages[i]
		if m.Deleted {
			continue
		}
		if m.Kind == MsgKindChat || m.Kind == MsgKindWhisper {
			totalMsgs++
			chatMsgs++
			if idx, ok := perIdx[m.AuthorID]; ok {
				per[idx].Messages++
				per[idx].Tokens += int64(m.TokensPrompt + m.TokensComplete)
				per[idx].CostCNY += float64(m.CostMilli) / 10000.0
			}
			totalTokens += int64(m.TokensPrompt + m.TokensComplete)
		}
		if m.Kind == MsgKindTool || m.Kind == MsgKindToolApproval {
			toolCalls++
		}
	}

	toolRate := 0.0
	if chatMsgs > 0 {
		toolRate = float64(toolCalls) / float64(chatMsgs)
		if toolRate > 1 {
			toolRate = 1
		}
	}

	counts := make([]float64, 0, len(per))
	for _, p := range per {
		counts = append(counts, float64(p.Messages))
	}

	return &Metrics{
		AgreementScore:    0, // P1: 语义分析
		InfoGainTrend:     "flat",
		DominanceGini:     gini(counts),
		ConvergenceRounds: nil,
		ToolUsageRate:     toolRate,
		TotalMessages:     totalMsgs,
		TotalTokens:       totalTokens,
		PerMember:         per,
	}
}

// gini 计算 0~1 的基尼系数。全部相等 → 0；极度集中 → 接近 1。
func gini(values []float64) float64 {
	n := len(values)
	if n == 0 {
		return 0
	}
	sorted := make([]float64, n)
	copy(sorted, values)
	sort.Float64s(sorted)
	sum := 0.0
	for _, v := range sorted {
		sum += v
	}
	if sum == 0 {
		return 0
	}
	var numer float64
	for i, v := range sorted {
		numer += float64(2*(i+1)-n-1) * v
	}
	return numer / (float64(n) * sum)
}
