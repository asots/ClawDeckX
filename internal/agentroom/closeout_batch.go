package agentroom

// closeout_batch.go —— v0.7+ 关闭仪式"minutes 复用 + 后三步合一"优化。
//
// 背景：之前 Closeout 跑 4 次独立 LLM 调用（minutes / todos / playbook / retro），
// 每次都把完整对话时间线 send 过去，总 input token ≈ 4 × 10k。现在：
//   1. 仅 Step 1 (minutes) 读完整对话
//   2. Step 2/3/4 合并为一次 batchPostMinutes：只 send 已生成的 minutes（1-2k）
//      → 产出 JSON {"todos":[...], "playbook":{...}, "retro":{...}}
//   3. 单次 JSON 失败则 fallback 到分步调用（仍用 minutes 作为 context）
//
// Token 成本从 ~40k → ~11k（降 73%），RTT 从 4 次 → 2 次。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"ClawDeckX/internal/database"
	"ClawDeckX/internal/logger"
)

// postMinutesBatchResult 是 batchPostMinutes 一次调用的容器。
// 任一字段失败不影响其它字段 —— 调用方检查哪些是 nil/空。
type postMinutesBatchResult struct {
	Todos    []Task
	Playbook *ExtractedPlaybook
	Retro    *Retro
	// RawText 供失败时回落到分步调用；也可用于 debug 看 LLM 原始输出。
	RawText string
}

// batchPostMinutes —— 基于已生成的 minutes markdown，一次调用产出 todos / playbook / retro。
// 任一子对象 JSON 解析失败时，partial 返回（其它两个成功就有值）。
// 整个 LLM 调用失败返回 error，调用方应 fallback 到逐个分步调用。
func (o *Orchestrator) batchPostMinutes(ctx context.Context, minutesMarkdown string) (*postMinutesBatchResult, error) {
	synthesizer := o.pickSynthesizer()
	if synthesizer == nil {
		return nil, errors.New("没有可用 agent 做批量后处理")
	}

	memberList := listMembersForPrompt(o.members)
	decisions, _ := o.repo.ListDecisions(o.roomID)
	tasks, _ := o.repo.ListTasks(o.roomID)
	agenda, _ := o.repo.ListAgendaItems(o.roomID)
	doneCount := 0
	for _, it := range agenda {
		if it.Status == AgendaStatusDone {
			doneCount++
		}
	}

	// system prompt 强调 "只 JSON，不要解释，允许 partial"
	system := "你是资深会议秘书。基于给定会议纪要，同时产出三段结构化数据。严格输出单个 JSON 对象，不要解释、不要用 markdown 代码块包裹。"

	user := fmt.Sprintf(
		`房间标题：%s
目标：%s
议程完成度：%d/%d
决策数：%d
已有行动项：%d
成员列表：
%s

----
会议纪要（markdown，已包含决策 / 关键讨论 / 议题）：
%s
----

请基于上面的 minutes 直接输出以下 JSON（**三段都要出**，都不能缺）：
{
  "todos": [{"text":"待办具体描述","assignee":"成员 id 或空串"}],
  "playbook": {
    "title":"<=40字",
    "problem":"<=600字",
    "approach":"<=600字",
    "conclusion":"<=600字"
  },
  "retro": {
    "scoreOverall":1-100,
    "scoreGoal":1-100,
    "scoreQuality":1-100,
    "scoreDecisionClarity":1-100,
    "scoreEfficiency":1-100,
    "offTopicRate":0-100,
    "highlights":["", ""],
    "lowlights":["", ""],
    "summary":"200字以内",
    "nextMeeting":{"title":"","goal":"","agenda":["",""]}
  }
}
约束：
- todos 最多 8 条；若 minutes 里没有明确待办，给 []。
- 所有评分为整数；highlights/lowlights 各最多 3 条。
- 若不需要下次会议，nextMeeting 可为 {} 或省略。`,
		o.room.Title, o.room.Goal, doneCount, len(agenda), len(decisions), len(tasks),
		memberList, minutesMarkdown,
	)

	// 单次调用，maxTokens 留足三段 JSON 输出 —— 经验值 2400 够
	cres, err := o.nonStreamComplete(ctx, synthesizer, system, user, 2400)
	if err != nil {
		return nil, err
	}
	o.recordCloseoutUsage(cres)
	res := &postMinutesBatchResult{RawText: cres.Text}

	// partial parse：先提 JSON 块，再分别 Unmarshal 每个子字段。
	// 任一子解析失败只影响对应字段，不阻断其它字段的落库。
	block := extractJSONBlock(cres.Text)
	if block == "" {
		return res, fmt.Errorf("batchPostMinutes: 没有找到 JSON 块")
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal([]byte(block), &raw); err != nil {
		return res, fmt.Errorf("batchPostMinutes: JSON 根对象解析失败: %w", err)
	}

	// todos
	if todosRaw, ok := raw["todos"]; ok {
		var items []todoItem
		if err := json.Unmarshal(todosRaw, &items); err == nil {
			creator := ""
			for _, it := range items {
				it.Text = strings.TrimSpace(it.Text)
				if it.Text == "" {
					continue
				}
				t := &database.AgentRoomTask{
					ID:         GenID("task"),
					RoomID:     o.roomID,
					Text:       it.Text,
					AssigneeID: it.Assignee,
					CreatorID:  creator,
					Status:     "todo",
				}
				if err := o.repo.CreateTask(t); err != nil {
					logger.Log.Warn().Err(err).Msg("agentroom: batch todos: create task failed")
					continue
				}
				res.Todos = append(res.Todos, TaskFromModel(t))
			}
		} else {
			logger.Log.Warn().Err(err).Msg("agentroom: batch todos: parse failed, skipping")
		}
	}

	// playbook
	if pbRaw, ok := raw["playbook"]; ok {
		var pb ExtractedPlaybook
		if err := json.Unmarshal(pbRaw, &pb); err == nil && strings.TrimSpace(pb.Title) != "" {
			res.Playbook = &pb
		} else if err != nil {
			logger.Log.Warn().Err(err).Msg("agentroom: batch playbook: parse failed, skipping")
		}
	}

	// retro
	if rxRaw, ok := raw["retro"]; ok {
		retro := parseRetroJSON(rxRaw, o)
		if retro != nil {
			res.Retro = retro
		}
	}

	return res, nil
}

// parseRetroJSON —— 共享 GenerateRetro 的 JSON → *Retro 解析逻辑，方便 batch 路径复用。
// 输入可能为 nil / 空对象 / 完整对象；任何 parse 错误返回 nil（不 panic）。
func parseRetroJSON(raw json.RawMessage, o *Orchestrator) *Retro {
	if len(raw) == 0 {
		return nil
	}
	var parsed struct {
		ScoreOverall         int      `json:"scoreOverall"`
		ScoreGoal            int      `json:"scoreGoal"`
		ScoreQuality         int      `json:"scoreQuality"`
		ScoreDecisionClarity int      `json:"scoreDecisionClarity"`
		ScoreEfficiency      int      `json:"scoreEfficiency"`
		OffTopicRate         int      `json:"offTopicRate"`
		Highlights           []string `json:"highlights"`
		Lowlights            []string `json:"lowlights"`
		Summary              string   `json:"summary"`
		NextMeeting          *struct {
			Title  string   `json:"title"`
			Goal   string   `json:"goal"`
			Agenda []string `json:"agenda"`
		} `json:"nextMeeting"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		logger.Log.Warn().Err(err).Msg("agentroom: batch retro: parse failed, skipping")
		return nil
	}
	clamp := func(v int) int {
		if v < 0 {
			return 0
		}
		if v > 100 {
			return 100
		}
		return v
	}
	out := &Retro{
		RoomID:               o.roomID,
		ScoreOverall:         clamp(parsed.ScoreOverall),
		ScoreGoal:            clamp(parsed.ScoreGoal),
		ScoreQuality:         clamp(parsed.ScoreQuality),
		ScoreDecisionClarity: clamp(parsed.ScoreDecisionClarity),
		ScoreEfficiency:      clamp(parsed.ScoreEfficiency),
		OffTopicRate:         clamp(parsed.OffTopicRate),
		Highlights:           trimStringSlice(parsed.Highlights, 3, 120),
		Lowlights:            trimStringSlice(parsed.Lowlights, 3, 120),
		Summary:              trimRunes(parsed.Summary, 800),
		GeneratedAt:          NowMs(),
	}
	if parsed.NextMeeting != nil && strings.TrimSpace(parsed.NextMeeting.Title) != "" {
		out.NextMeetingDraft = &NextMeetingDraft{
			Title:       trimRunes(parsed.NextMeeting.Title, 120),
			Goal:        trimRunes(parsed.NextMeeting.Goal, 400),
			TemplateID:  o.room.TemplateID,
			AgendaItems: trimStringSlice(parsed.NextMeeting.Agenda, 6, 100),
			InviteRoles: roleNames(o.members),
			SuggestedAt: "1 week later",
		}
	}
	return out
}

// CancelCloseout —— 打断正在进行的 Closeout。
// 幂等：没有在跑时 no-op。运行中调用会立即取消当前 LLM 请求（ctx 贯穿到 bridge），
// 剩余步骤检查 ctx.Err() 后标为 skipped。
func (o *Orchestrator) CancelCloseout() {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.closeoutCancel != nil {
		o.closeoutCancel()
		logger.Log.Info().Str("room", o.roomID).Msg("agentroom: closeout canceled by user")
	}
}
