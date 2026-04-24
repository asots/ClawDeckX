package agentroom

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"ClawDeckX/internal/database"
	"ClawDeckX/internal/logger"
)

// v0.9：对问题 / 风险 两类房间对象的"按钮一键抽取"能力。
//
// 动机：
//   推进会议组的 QuestionsPanel / RisksPanel 此前没有自动化入口 —— 只能人类在 UI
//   里一条条手动添加，实际使用几乎为 0。Agent 的对话流里其实经常已经指出"有没人回答
//   的问题"或"潜在风险"，但没有沉淀机制。
//
// 实现模式完全参照 v06_orch.go 的 ExtractTodos：
//   1. 选一个 synthesizer（主持人优先，否则第一个存活 agent）
//   2. 把最近 60 条消息渲染成 transcript + 成员列表
//   3. 丢给 LLM，强制 JSON 输出
//   4. 解析后批量写 DB，并通过 broker 广播 room.question.append / room.risk.append
//      —— 前端 QuestionsPanel / RisksPanel 已订阅这些事件，会实时刷新；
//      同时 useUnseenCounts hook 会把未读圆点点亮。
//
// 保守点：maxTokens 600、条数上限 6、avoid 凑数。

// ExtractOpenQuestions 从最近消息里抽取"阻碍推进的未决问题"，写入数据库并广播。
func (o *Orchestrator) ExtractOpenQuestions(ctx context.Context) ([]OpenQuestion, error) {
	synthesizer := o.pickSynthesizer()
	if synthesizer == nil {
		return nil, errors.New("没有可用的 agent 来抽取开放问题；请先邀请至少一个 agent")
	}

	recent, _ := o.repo.ListMessages(o.roomID, 0, 60)
	transcript := renderTranscript(recent, o.members)
	memberList := listMembersForPrompt(o.members)

	system := "你是一个会议秘书，从讨论里提炼出还没解决、阻碍会议推进的开放问题。必须严格输出 JSON 数组，不要有任何额外文字。"
	user := fmt.Sprintf(
		"会议目标：%s\n成员列表：\n%s\n----\n时间线：\n%s\n----\n请输出 JSON 数组，每个元素 {\"text\": \"一句话具体描述\", \"raisedBy\": \"提出者成员 ID 或空\"}。\n最多 6 条；只输出'真正阻碍推进、没人回答'的开放问题，不要把陈述句或已解决事项误报。\n若本场讨论没有这样的开放问题，直接输出 [] 。",
		o.room.Goal, memberList, transcript,
	)

	res, err := o.nonStreamComplete(ctx, synthesizer, system, user, 600)
	if err != nil {
		return nil, err
	}
	o.recordCloseoutUsage(res)

	items := parseOpenQuestionJSON(res.Text)
	out := make([]OpenQuestion, 0, len(items))
	for _, it := range items {
		q := &database.AgentRoomOpenQuestion{
			RoomID:     o.roomID,
			Text:       it.Text,
			RaisedByID: it.RaisedBy,
		}
		if err := o.repo.CreateOpenQuestion(q); err != nil {
			logger.Log.Warn().Err(err).Msg("agentroom: extract-questions: create failed")
			continue
		}
		dto := OpenQuestionFromModel(q)
		o.broker.Emit(o.roomID, "room.question.append", map[string]any{
			"roomId": o.roomID, "question": dto,
		})
		out = append(out, dto)
	}
	return out, nil
}

// ExtractRisks 从最近消息里抽取风险，写入数据库并广播。
func (o *Orchestrator) ExtractRisks(ctx context.Context) ([]Risk, error) {
	synthesizer := o.pickSynthesizer()
	if synthesizer == nil {
		return nil, errors.New("没有可用的 agent 来抽取风险；请先邀请至少一个 agent")
	}

	recent, _ := o.repo.ListMessages(o.roomID, 0, 60)
	transcript := renderTranscript(recent, o.members)
	memberList := listMembersForPrompt(o.members)

	system := "你是一个会议秘书，从讨论里识别风险 —— 即可能导致目标失败、延期、超支、质量下降的事情。必须严格输出 JSON 数组。"
	// 注意：severity 值必须和前端 types.ts 的 RiskSeverity 一致（'low' | 'mid' | 'high'），
	// 不是常见的 "medium"。前端 RisksPanel 的 SEVERITY_META 严格按这 3 个值配色。
	user := fmt.Sprintf(
		"会议目标：%s\n成员列表：\n%s\n----\n时间线：\n%s\n----\n请输出 JSON 数组，每个元素 {\"text\": \"风险一句话描述\", \"severity\": \"low|mid|high\", \"owner\": \"责任人成员 ID 或空\"}。\n最多 6 条；只输出有实际威胁的风险，避免凑数。severity 按严重度填；若不确定用 \"mid\"。\n若本场讨论无明显风险，直接输出 [] 。",
		o.room.Goal, memberList, transcript,
	)

	res, err := o.nonStreamComplete(ctx, synthesizer, system, user, 600)
	if err != nil {
		return nil, err
	}
	o.recordCloseoutUsage(res)

	items := parseRiskJSON(res.Text)
	out := make([]Risk, 0, len(items))
	for _, it := range items {
		k := &database.AgentRoomRisk{
			RoomID:   o.roomID,
			Text:     it.Text,
			Severity: it.Severity,
			OwnerID:  it.Owner,
		}
		if err := o.repo.CreateRisk(k); err != nil {
			logger.Log.Warn().Err(err).Msg("agentroom: extract-risks: create failed")
			continue
		}
		dto := RiskFromModel(k)
		o.broker.Emit(o.roomID, "room.risk.append", map[string]any{
			"roomId": o.roomID, "risk": dto,
		})
		out = append(out, dto)
	}
	return out, nil
}

// ── LLM 输出解析 ──

type openQuestionItem struct {
	Text     string `json:"text"`
	RaisedBy string `json:"raisedBy,omitempty"`
}

func parseOpenQuestionJSON(s string) []openQuestionItem {
	raw := extractJSONBlock(s)
	if raw == "" {
		return nil
	}
	var items []openQuestionItem
	if err := json.Unmarshal([]byte(raw), &items); err != nil {
		return nil
	}
	out := items[:0]
	for _, it := range items {
		it.Text = strings.TrimSpace(it.Text)
		if it.Text == "" {
			continue
		}
		out = append(out, it)
	}
	return out
}

type riskItem struct {
	Text     string `json:"text"`
	Severity string `json:"severity,omitempty"`
	Owner    string `json:"owner,omitempty"`
}

func parseRiskJSON(s string) []riskItem {
	raw := extractJSONBlock(s)
	if raw == "" {
		return nil
	}
	var items []riskItem
	if err := json.Unmarshal([]byte(raw), &items); err != nil {
		return nil
	}
	out := items[:0]
	for _, it := range items {
		it.Text = strings.TrimSpace(it.Text)
		if it.Text == "" {
			continue
		}
		sev := strings.ToLower(strings.TrimSpace(it.Severity))
		// 兼容 LLM 常见变体："medium" / "middle" / "normal" 都规范为 "mid"。
		switch sev {
		case "medium", "middle", "normal", "":
			sev = "mid"
		case "critical", "severe":
			sev = "high"
		case "minor":
			sev = "low"
		}
		if sev != "low" && sev != "mid" && sev != "high" {
			sev = "mid"
		}
		it.Severity = sev
		out = append(out, it)
	}
	return out
}
