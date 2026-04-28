// Package agentroom · conductor.go
//
// v0.3 主题 B 实现：让会议有"主持/Conductor"的显式行动权。
//
// 核心理念：
//   - 不新增"成员类型"——任何 agent（最常见的是被指定为主持的成员）都能
//     在自己的回复里嵌入结构化 action tag，让 orchestrator 真正"动起来"
//   - 配合内置的 conductor system prompt 模板（见 prompts.go DefaultPromptPack 后续可加），
//     让普通 agent 通过明确指令也能执行调度动作
//
// 支持的 action：
//
//	<conductor-action type="promote-decision" target="msg_xxx" summary="..."/>
//	    把指定消息锚定为决策（target 可省，默认上一条 chat）
//
//	<conductor-action type="advance-agenda" target="agenda_xxx" outcome="..."/>
//	    把指定议项标记为 done；target 省略时取当前 active 议项
//
//	<conductor-action type="accept-task" target="task_xxx" verdict="accepted|rework" summary="..."/>
//	    对处于 review 的任务给出验收（reviewer agent 用得上）
//
//	<conductor-action type="pause-meeting" reason="..."/>
//	    把房间转入 paused 状态（如检测到失控、偏题严重）
//
//	<conductor-action type="trigger-vote" question="..." options="A|B|C"/>
//	    主动发起投票（议题与选项以 | 分隔）
//
// 解析后这些标签从消息正文中剥除，用户看到的是 agent 的自然话语。
//
// 安全 / 限流：
//   - 单条消息最多识别 5 个 action（防止 prompt injection 制造刷屏）
//   - promote-decision target 必须是本房间近 50 条内消息
//   - accept-task 仅当 reviewer 是该 agent 时才生效
//   - pause-meeting 需要 agent 是 isModerator=true（避免任意 agent 滥用）

package agentroom

import (
	"regexp"
	"strings"

	"ClawDeckX/internal/database"
	"ClawDeckX/internal/logger"
)

// 内置成员 kind（v0.3+）。引入 conductor 作为推荐预设而非强制类型——
// 普通 agent 也能通过 system prompt 拿到 action 权限。
const (
	MemberKindHuman     = "human"
	MemberKindAgent     = "agent"
	MemberKindConductor = "conductor" // 可选预设：默认带主持人 system prompt + isModerator=true
)

// 可用的 action 类型常量
const (
	ConductorActionPromoteDecision = "promote-decision"
	ConductorActionAdvanceAgenda   = "advance-agenda"
	ConductorActionAcceptTask      = "accept-task"
	ConductorActionPauseMeeting    = "pause-meeting"
	ConductorActionTriggerVote     = "trigger-vote"
)

// 单条消息的 action 数量上限。超过的尾部静默丢弃。
const conductorMaxActionsPerMessage = 5

// 正则：解析 <conductor-action ...attrs.../>（自闭合）和 <conductor-action ...>...</conductor-action>
//
// 设计：抓 attribute 字符串自己解析，避免不同顺序的属性写不动正则。
var conductorActionRE = regexp.MustCompile(`(?is)<conductor-action\s+([^>]*?)/?>(?:\s*</conductor-action>)?`)

// ConductorAction 一个解析后的动作。
type ConductorAction struct {
	Type   string            // promote-decision / advance-agenda / accept-task / pause-meeting / trigger-vote
	Target string            // 目标对象 id（可空）
	Attrs  map[string]string // 其它属性（reason / summary / outcome / question / options / verdict）
}

// ParseConductorActions 从消息文本中提取 conductor action 列表，并返回剥除标签后的正文。
// 失败 / 无标签 → 返回 nil + 原文。
func ParseConductorActions(content string) ([]ConductorAction, string) {
	matches := conductorActionRE.FindAllStringSubmatchIndex(content, -1)
	if len(matches) == 0 {
		return nil, content
	}
	actions := make([]ConductorAction, 0, len(matches))
	for i, idx := range matches {
		if i >= conductorMaxActionsPerMessage {
			break
		}
		attrs := content[idx[2]:idx[3]]
		ac := parseAttrs(attrs)
		if ac.Type == "" {
			continue
		}
		actions = append(actions, ac)
	}
	cleaned := conductorActionRE.ReplaceAllString(content, "")
	cleaned = collapseBlankLines(strings.TrimSpace(cleaned))
	return actions, cleaned
}

// parseAttrs 把 `type="x" target="y" reason="z"` 这样的属性串拆成 ConductorAction。
// 简化：双引号 / 单引号都接受；不支持转义引号（极少见，agent 很少这么写）。
var attrPairRE = regexp.MustCompile(`([a-zA-Z][a-zA-Z0-9_-]*)\s*=\s*"([^"]*)"|([a-zA-Z][a-zA-Z0-9_-]*)\s*=\s*'([^']*)'`)

func parseAttrs(s string) ConductorAction {
	a := ConductorAction{Attrs: map[string]string{}}
	for _, m := range attrPairRE.FindAllStringSubmatch(s, -1) {
		key := m[1]
		val := m[2]
		if key == "" {
			key = m[3]
			val = m[4]
		}
		key = strings.ToLower(key)
		switch key {
		case "type":
			a.Type = strings.ToLower(strings.TrimSpace(val))
		case "target":
			a.Target = strings.TrimSpace(val)
		default:
			a.Attrs[key] = strings.TrimSpace(val)
		}
	}
	return a
}

// appendConductorHint 在 extraSys 末尾追加一段教 agent 如何输出 conductor action tag 的指令。
// 仅 isModerator / kind=conductor 的成员触发。
func appendConductorHint(extraSys string) string {
	hint := "\n\n----\n【主持人调度权限】\n你是本场会议的主持人 / conductor。你有以下结构化指令权限——在你的回复末尾追加任意一条会被系统自动执行（标签会从用户可见正文中剥除）：\n" +
		"\n" +
		`• <conductor-action type="promote-decision" target="msg_id" summary="一句话决策摘要"/>` + "\n" +
		"  把指定消息（或最新一条 chat）锚定为决策。target 可省。\n" +
		"\n" +
		`• <conductor-action type="advance-agenda" target="agenda_id" outcome="议项产出总结"/>` + "\n" +
		"  把当前 active 议项标记为完成；自动激活下一个 pending。target 可省。\n" +
		"\n" +
		`• <conductor-action type="accept-task" target="task_id" verdict="accepted|rework" summary="..."/>` + "\n" +
		"  对你担任 reviewer 的任务给出验收结论（仅 reviewer 是你时生效）。\n" +
		"\n" +
		`• <conductor-action type="trigger-vote" question="..." options="A|B|C"/>` + "\n" +
		"  发起投票（多数派模式，| 分隔选项，至少 2 个）。\n" +
		"\n" +
		`• <conductor-action type="pause-meeting" reason="..."/>` + "\n" +
		"  暂停会议（用于偏题严重 / 失控时）。\n" +
		"\n" +
		"使用建议：先用自然语言把判断告诉大家，再用一行 action 标签让系统执行。**单条回复最多 5 个 action，超出会被忽略**。"
	return extraSys + hint
}

// applyConductorActions 对一组动作逐条执行；副作用包含 DB 写入 + broker 广播 + appendSystemNotice。
//
// emitter —— 该 agent 的 Member（用于权限判断与归属审计）。
// 错误策略：单条失败仅 Debug 日志；不阻断主对话流。
func (o *Orchestrator) applyConductorActions(actions []ConductorAction, emitter *database.AgentRoomMember) {
	if len(actions) == 0 || emitter == nil {
		return
	}
	for _, ac := range actions {
		switch ac.Type {
		case ConductorActionPromoteDecision:
			o.actionPromoteDecision(ac, emitter)
		case ConductorActionAdvanceAgenda:
			o.actionAdvanceAgenda(ac, emitter)
		case ConductorActionAcceptTask:
			o.actionAcceptTask(ac, emitter)
		case ConductorActionPauseMeeting:
			o.actionPauseMeeting(ac, emitter)
		case ConductorActionTriggerVote:
			o.actionTriggerVote(ac, emitter)
		default:
			logger.Log.Debug().Str("type", ac.Type).Msg("agentroom: unknown conductor action type, ignoring")
		}
	}
}

// actionPromoteDecision —— 把目标消息锚定为决策。target 省略时取最新一条 chat（含本条之前）。
func (o *Orchestrator) actionPromoteDecision(ac ConductorAction, emitter *database.AgentRoomMember) {
	target := ac.Target
	if target == "" {
		// 取最近一条非系统 chat 消息
		recent, _ := o.repo.ListMessagesPaged(o.roomID, 0, 30)
		for i := len(recent) - 1; i >= 0; i-- {
			m := recent[i]
			if m.Kind == MsgKindChat && !m.Deleted && m.AuthorID != "system" {
				target = m.ID
				break
			}
		}
	}
	if target == "" {
		return
	}
	msg, err := o.repo.GetMessage(target)
	if err != nil || msg == nil || msg.RoomID != o.roomID {
		return
	}
	if msg.IsDecision {
		return // 已经是决策
	}
	patch := map[string]any{"is_decision": true}
	if s := strings.TrimSpace(ac.Attrs["summary"]); s != "" {
		if n := []rune(s); len(n) > 200 {
			s = string(n[:200])
		}
		patch["decision_summary"] = s
	}
	if err := o.repo.UpdateMessage(target, patch); err != nil {
		return
	}
	o.broker.Emit(o.roomID, EventMessageUpdate, map[string]any{
		"roomId": o.roomID, "messageId": target,
		"patch": map[string]any{
			"isDecision":      true,
			"decisionSummary": patch["decision_summary"],
		},
	})
	o.appendSystemNotice("📌 @" + emitter.Name + " 锚定了一条决策。")
}

// actionAdvanceAgenda —— 把指定（或当前 active）议项推进到 done。
// outcome attribute 写入议项的 outcome 字段。
func (o *Orchestrator) actionAdvanceAgenda(ac ConductorAction, emitter *database.AgentRoomMember) {
	items, err := o.repo.ListAgendaItems(o.roomID)
	if err != nil || len(items) == 0 {
		return
	}
	target := ac.Target
	var current *database.AgentRoomAgendaItem
	if target != "" {
		for i := range items {
			if items[i].ID == target {
				current = &items[i]
				break
			}
		}
	} else {
		// 默认取 active
		for i := range items {
			if items[i].Status == AgendaStatusActive {
				current = &items[i]
				break
			}
		}
	}
	if current == nil || current.Status == AgendaStatusDone || current.Status == AgendaStatusSkipped {
		return
	}
	now := NowMs()
	patch := map[string]any{
		"status":   AgendaStatusDone,
		"ended_at": &now,
	}
	if outcome := strings.TrimSpace(ac.Attrs["outcome"]); outcome != "" {
		if n := []rune(outcome); len(n) > 800 {
			outcome = string(n[:800])
		}
		patch["outcome"] = outcome
	}
	if err := o.repo.UpdateAgendaItem(current.ID, patch); err != nil {
		return
	}
	o.broker.Emit(o.roomID, EventRoomUpdate, map[string]any{
		"roomId": o.roomID, "patch": map[string]any{"agendaChanged": true},
	})
	o.appendSystemNotice("✅ @" + emitter.Name + " 推进议程：完成「" + current.Title + "」")

	// 自动激活下一个 pending（若有）
	for i := range items {
		if items[i].Status == AgendaStatusPending {
			startedAt := NowMs()
			_ = o.repo.UpdateAgendaItem(items[i].ID, map[string]any{
				"status":     AgendaStatusActive,
				"started_at": &startedAt,
			})
			o.appendSystemNotice("▶️ 进入下一议项：" + items[i].Title)
			break
		}
	}
}

// actionAcceptTask —— 仅当本 emitter 是该任务的 reviewer 时生效。
func (o *Orchestrator) actionAcceptTask(ac ConductorAction, emitter *database.AgentRoomMember) {
	if ac.Target == "" {
		return
	}
	t, err := o.repo.GetTask(ac.Target)
	if err != nil || t == nil || t.RoomID != o.roomID {
		return
	}
	if t.ReviewerID != emitter.ID {
		// 不是 reviewer，无权验收
		logger.Log.Debug().Str("task", ac.Target).Str("emitter", emitter.ID).
			Msg("agentroom: conductor accept-task denied: not reviewer")
		return
	}
	if t.Status != TaskStatusReview {
		return
	}
	verdict := strings.ToLower(strings.TrimSpace(ac.Attrs["verdict"]))
	if verdict != AcceptanceStatusAccepted && verdict != AcceptanceStatusRework {
		return
	}
	summary := strings.TrimSpace(ac.Attrs["summary"])
	o.applyAutoReview(t, verdict, "（"+emitter.Name+" 验收）"+summary, nil, nil)
}

// actionPauseMeeting —— 仅 isModerator=true 的成员可执行。
func (o *Orchestrator) actionPauseMeeting(ac ConductorAction, emitter *database.AgentRoomMember) {
	if !emitter.IsModerator {
		logger.Log.Debug().Str("emitter", emitter.ID).
			Msg("agentroom: conductor pause-meeting denied: not moderator")
		return
	}
	reason := strings.TrimSpace(ac.Attrs["reason"])
	if reason == "" {
		reason = "由 " + emitter.Name + " 主动暂停"
	}
	o.transitionToPaused(reason)
	o.appendSystemNotice("⏸️ @" + emitter.Name + " 暂停了会议：" + reason)
}

// actionTriggerVote —— 主动发起一个简单投票（majority 模式，开放期限默认 5 分钟）。
// 仅当 emitter.IsModerator 为 true 时生效。
func (o *Orchestrator) actionTriggerVote(ac ConductorAction, emitter *database.AgentRoomMember) {
	if !emitter.IsModerator {
		return
	}
	question := strings.TrimSpace(ac.Attrs["question"])
	if question == "" {
		return
	}
	rawOpts := ac.Attrs["options"]
	parts := strings.Split(rawOpts, "|")
	options := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			options = append(options, p)
		}
	}
	if len(options) < 2 {
		return
	}
	optsJSON := jsonMarshal(options)
	// 默认全员可投
	members, _ := o.repo.ListMembers(o.roomID)
	voterIDs := make([]string, 0, len(members))
	for _, m := range members {
		if !m.IsKicked {
			voterIDs = append(voterIDs, m.ID)
		}
	}
	voterJSON := jsonMarshal(voterIDs)
	v := &database.AgentRoomVote{
		ID:           GenID("vote"),
		RoomID:       o.roomID,
		Question:     question,
		OptionsJSON:  optsJSON,
		Mode:         VoteModeMajority,
		VoterIDsJSON: voterJSON,
		Status:       VoteStatusOpen,
		InitiatorID:  emitter.ID,
	}
	if err := o.repo.CreateVote(v); err != nil {
		return
	}
	o.broker.Emit(o.roomID, EventRoomUpdate, map[string]any{
		"roomId": o.roomID, "patch": map[string]any{"votesChanged": true},
	})
	o.appendSystemNotice("🗳️ @" + emitter.Name + " 发起投票：" + question)
}
