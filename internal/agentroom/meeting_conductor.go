package agentroom

// meeting_conductor.go — v1.0 会议指挥官（Meeting Conductor）
//
// 架构核心：把散落在 orchestrator 各处的 29 项增强信号统一到一个决策引擎。
//
// 设计原则：
//   1. 单次快照：MeetingSnapshot 在每轮 turn 开始时计算一次，全部信号共享。
//   2. 统一预算：pre-turn 和 post-turn 信号都受预算限制，不会 prompt 爆长。
//   3. 阶段感知：根据 (policy × phase × 会议状态) 三元组决定哪些信号适用。
//   4. 优先级排序：高优先级信号先占位，低优先级在预算满时被跳过。
//   5. 冷却统一：所有信号共用 signalCooldowns map，含 pre-turn prompt 信号。
//
// 数据流：
//
//   orchestrator
//     ├── buildContextPrompt()
//     │     └── snap := ComputeSnapshot(...)
//     │         └── ConductPreTurn(snap, self, cooldowns, opts)  →  context prompt additions
//     │
//     └── runAgentTurn() post-processing
//           └── ConductPostTurn(snap, speakerID, content, cooldowns, opts)  →  PostTurnActions

import (
	"fmt"
	"strings"

	"ClawDeckX/internal/database"
)

// ── MeetingSnapshot ──────────────────────────────────────────────────

// MeetingSnapshot 是单轮 turn 的只读会议状态。计算一次，全局共享。
type MeetingSnapshot struct {
	// 房间级
	Policy         string
	MeetingPhase   string // from CalcMeetingPhase
	ExecutionPhase string // for PolicyPlanned
	RoundsUsed     int
	RoundBudget    int
	Goal           string
	IsReadonly     bool

	// 成员
	Members     []database.AgentRoomMember
	MemberNames map[string]string // ID → Name
	AgentIDs    map[string]bool   // 活跃 agent ID 集
	HumanNames  map[string]string // 人类成员 ID → Name

	// 消息快照
	Recent []database.AgentRoomMessage

	// 产出计数
	FactCount     int
	TaskCount     int
	DecisionCount int
	Facts         []database.AgentRoomFact

	// Planned 执行队列
	ExecQueue    []string
	ExecOwnerIdx int

	// v1.0 当前轮 soft-tag 解析结果（仅 post-turn 使用）。
	// pre-turn 时为零值（当前轮还没输出）；post-turn 由 orchestrator 填入。
	// 检测函数先查 tag → 缺失 fallback 到关键词，实现跨语言精确检测。
	LastSoftTags ParsedSoftTags
}

// ComputeSnapshot 从 room/members/recent 一次性计算完整快照。
func ComputeSnapshot(
	room *database.AgentRoom,
	members []database.AgentRoomMember,
	recent []database.AgentRoomMessage,
	facts []database.AgentRoomFact,
	taskCount int,
) *MeetingSnapshot {
	snap := &MeetingSnapshot{
		Policy:         room.Policy,
		MeetingPhase:   CalcMeetingPhase(room.RoundsUsed, room.RoundBudget),
		ExecutionPhase: room.ExecutionPhase,
		RoundsUsed:     room.RoundsUsed,
		RoundBudget:    room.RoundBudget,
		Goal:           room.Goal,
		IsReadonly:     room.Readonly,
		Members:        members,
		MemberNames:    make(map[string]string, len(members)),
		AgentIDs:       make(map[string]bool),
		HumanNames:     make(map[string]string),
		Recent:         recent,
		FactCount:      len(facts),
		TaskCount:      taskCount,
		Facts:          facts,
		ExecQueue:      parseExecutionQueue(room.ExecutionQueueJSON),
		ExecOwnerIdx:   room.ExecutionOwnerIdx,
	}

	for _, m := range members {
		snap.MemberNames[m.ID] = m.Name
		if m.Kind == "agent" && !m.IsKicked {
			snap.AgentIDs[m.ID] = true
		}
		if m.Kind == "human" && !m.IsKicked {
			name := m.Name
			if name == "" {
				name = m.ID
			}
			snap.HumanNames[m.ID] = name
		}
	}

	// 统计 decision 消息
	for _, m := range recent {
		if m.Kind == MsgKindDecision || m.IsDecision {
			snap.DecisionCount++
		}
	}

	return snap
}

// ── Pre-Turn Conductor ──────────────────────────────────────────────

// preTurnSignal 表示一个 pre-turn prompt 信号（用于优先级排序 + 预算控制）。
type preTurnSignal struct {
	id       string // 信号 ID（用于 cooldown 和日志）
	cooldown int    // 冷却轮次
	priority int    // 越小越高优先级
	content  string // 要注入的 prompt 文本
}

// ConductPreTurn 为指定 agent 计算所有 pre-turn prompt 注入。
// 返回一个完整的字符串，直接 append 到 buildContextPrompt 的 sb 中。
//
// 统一处理：§1-§5 真实感 + D3/D7 健康度 + C1-C7 协作执行。
// 所有信号受预算控制（默认 5 条 pre-turn 信号），按优先级排序。
// 所有提示词文案通过 PromptPack 获取，支持用户自定义。
func ConductPreTurn(snap *MeetingSnapshot, self database.AgentRoomMember, cooldowns map[string]int, opts *PolicyOptions) string {
	if snap.IsReadonly {
		return "" // 只读房间不注入增强信号
	}

	maxSignals := 5 // pre-turn prompt 信号上限
	if opts != nil && opts.HealthCheckBudget > 0 {
		maxSignals = opts.HealthCheckBudget + 3
	}

	// 统一从 PromptPack 获取所有文案
	var pp *PromptPack
	if opts != nil {
		pp = opts.GetPrompts()
	} else {
		pp = DefaultPromptPack()
	}

	var signals []preTurnSignal

	// ── 真实感层（§1-§5）── 优先级 1（核心体验）

	// §5 会议节奏：通过 PromptPack 的 PhaseXxx 字段获取文案
	{
		phase := snap.MeetingPhase
		var phasePrompt string
		switch phase {
		case MeetingPhaseOpening:
			phasePrompt = pp.PhaseOpening
		case MeetingPhaseDeepDive:
			phasePrompt = pp.PhaseDeepDive
		case MeetingPhaseFatigue:
			phasePrompt = pp.PhaseFatigue
		case MeetingPhaseConvergence:
			phasePrompt = pp.PhaseConvergence
		}
		if strings.TrimSpace(phasePrompt) != "" {
			rendered := renderTemplate(phasePrompt, map[string]any{
				"RoundsUsed":  snap.RoundsUsed,
				"RoundBudget": snap.RoundBudget,
			})
			signals = append(signals, preTurnSignal{"S5_phase", 0, 1, "\n" + rendered + "\n"})
		}
	}

	// §1 情绪连续性：通过 PromptPack 的 EmotionXxx 字段获取文案
	// EmotionalState.Label: challenged | supported | pressured | ignored | neutral
	// pressured/ignored 映射到 EmotionMixed 模板
	{
		es := AnalyzeEmotionalState(self.ID, snap.Members, snap.Recent, snap.MemberNames)
		if es.Label != "" && es.Label != "neutral" {
			var tmpl string
			switch es.Label {
			case "supported":
				tmpl = pp.EmotionSupported
			case "challenged":
				tmpl = pp.EmotionChallenged
			case "pressured", "ignored":
				tmpl = pp.EmotionMixed
			}
			if strings.TrimSpace(tmpl) != "" {
				rendered := renderTemplate(tmpl, map[string]any{
					"Detail": es.Detail,
					"Label":  es.Label,
				})
				signals = append(signals, preTurnSignal{"S1_emotion", 0, 1, "\n" + rendered + "\n"})
			}
		}
	}

	// §4 沉默力学：通过 PromptPack.SilenceBuildup 获取文案
	{
		silentTurns := CountSilentTurns(self.ID, snap.Recent)
		if silentTurns >= 4 && strings.TrimSpace(pp.SilenceBuildup) != "" {
			signals = append(signals, preTurnSignal{"S4_silence", 0, 1, "\n" + pp.SilenceBuildup + "\n"})
		}
	}

	// §2 立场漂移（debate only）—— 这个检测逻辑较复杂，仍由 DetectStanceDrift 处理
	if snap.Policy == PolicyDebate && strings.TrimSpace(self.Stance) != "" {
		if drift := DetectStanceDrift(self.ID, self.Stance, snap.Recent); drift != "" {
			signals = append(signals, preTurnSignal{"S2_drift", 0, 2, drift})
		}
	}

	// §3 知识盲区 —— 仍由 BlindSpotPrompt 处理（基于角色关键词匹配）
	if roleLower := strings.ToLower(self.Role); roleLower != "" {
		if prompt := BlindSpotPrompt(roleLower); prompt != "" {
			signals = append(signals, preTurnSignal{"S3_blindspot", 0, 2, prompt})
		}
	}

	// ── 健康度层（D3/D7）── 优先级 3

	// D3 Agent 独占：通过 PromptPack.MonopolizerWarning 获取文案
	if monopolized, monopolizerName, _, _ := DetectMonopolizer(snap.Recent, snap.MemberNames); monopolized {
		if strings.EqualFold(monopolizerName, self.Name) || monopolizerName == self.ID {
			warning := pp.MonopolizerWarning
			if strings.TrimSpace(warning) != "" {
				signals = append(signals, preTurnSignal{"D3_monopolizer", 3, 3, "\n" + warning + "\n"})
			}
		}
	}

	// D7 新成员入场简报
	{
		hasSpokeRecently := false
		for _, rm := range snap.Recent {
			if rm.AuthorID == self.ID && rm.Kind == MsgKindChat && !rm.Deleted {
				hasSpokeRecently = true
				break
			}
		}
		if !hasSpokeRecently && snap.RoundsUsed > 2 {
			factTexts := make([]string, 0, len(snap.Facts))
			for _, f := range snap.Facts {
				factTexts = append(factTexts, f.Key+": "+f.Value)
			}
			currentTopic := strings.TrimSpace(snap.Goal)
			if len([]rune(currentTopic)) > 100 {
				currentTopic = string([]rune(currentTopic)[:100]) + "…"
			}
			var recentSnippets []string
			for i := len(snap.Recent) - 1; i >= 0 && len(recentSnippets) < 3; i-- {
				rm := snap.Recent[i]
				if rm.Deleted || rm.Kind != MsgKindChat {
					continue
				}
				authorName := snap.MemberNames[rm.AuthorID]
				if authorName == "" {
					authorName = rm.AuthorID
				}
				snip := strings.TrimSpace(rm.Content)
				if idx := strings.IndexAny(snip, "\n\r"); idx > 0 {
					snip = snip[:idx]
				}
				if len([]rune(snip)) > 80 {
					snip = string([]rune(snip)[:80]) + "…"
				}
				recentSnippets = append(recentSnippets, authorName+": "+snip)
			}
			briefing := BuildLateJoinerBriefing(
				self.Name, snap.RoundsUsed, factTexts, currentTopic,
				strings.Join(recentSnippets, "\n"),
			)
			signals = append(signals, preTurnSignal{"D7_latejoin", 0, 3, briefing})
		}
	}

	// ── 协作执行层（C1-C7）── 优先级 2（仅 Planned/executing）
	// C1/C6/C3C7 通过 PromptPack 获取文案
	if snap.Policy == PolicyPlanned && snap.ExecutionPhase == PhaseExecuting {
		curIdx := snap.ExecOwnerIdx
		queue := snap.ExecQueue
		if curIdx >= 0 && curIdx < len(queue) && queue[curIdx] == self.ID {
			// C5 进度感知（结构性数据，不适合模板化）
			if tracker := BuildProgressTracker(queue, curIdx, snap.MemberNames, snap.Recent); tracker != "" {
				signals = append(signals, preTurnSignal{"C5_progress", 0, 2, tracker})
			}

			// C2 前任摘要
			var prevSummary string
			if curIdx > 0 {
				prevID := queue[curIdx-1]
				prevName := snap.MemberNames[prevID]
				if prevName == "" {
					prevName = prevID
				}
				prevSummary = BuildPreviousOwnerSummary(prevID, prevName, snap.Recent)
			}

			// C1 结构化交棒：通过 PromptPack.HandoffPrompt 模板
			var nextName string
			if curIdx+1 < len(queue) {
				if n, ok := snap.MemberNames[queue[curIdx+1]]; ok {
					nextName = n
				}
			}
			handoff := renderTemplate(pp.HandoffPrompt, map[string]any{
				"Step":        curIdx + 1,
				"Total":       len(queue),
				"NextName":    nextName,
				"PrevSummary": prevSummary,
			})
			signals = append(signals, preTurnSignal{"C1_handoff", 0, 2, "\n" + handoff + "\n"})

			// C6 能力自查：通过 PromptPack.CapabilityCheck
			if cap := strings.TrimSpace(pp.CapabilityCheck); cap != "" {
				signals = append(signals, preTurnSignal{"C6_capability", 0, 2, "\n" + cap + "\n"})
			}

			// C3+C7 协作 tag 指南：通过 PromptPack.CollaborationTags
			if tags := strings.TrimSpace(pp.CollaborationTags); tags != "" {
				signals = append(signals, preTurnSignal{"C3C7_tags", 0, 2, "\n" + tags + "\n"})
			}
		}
	}

	// ── 氛围个性化层（T1-T6）── 优先级 0/1

	// T1 氛围语气指令：最高优先级，每轮注入
	if tone := strings.TrimSpace(pp.ToneDirective); tone != "" {
		signals = append(signals, preTurnSignal{"T1_tone", 0, 0, "\n" + tone + "\n"})
	}

	// T2 发言长度引导：优先级 1
	if lg := strings.TrimSpace(pp.LengthGuidance); lg != "" {
		rendered := renderTemplate(lg, map[string]any{
			"Phase":  snap.MeetingPhase,
			"Policy": snap.Policy,
		})
		signals = append(signals, preTurnSignal{"T2_length", 0, 1, "\n" + rendered + "\n"})
	}

	// T3 创意激发：检测到保守时注入（cooldown 5 轮）
	if boost := strings.TrimSpace(pp.CreativityBoost); boost != "" {
		if stagnant, _ := DetectCreativityStagnation(snap.Recent, snap.RoundsUsed); stagnant {
			signals = append(signals, preTurnSignal{"T3_creativity", 5, 1, "\n" + boost + "\n"})
		}
	}

	// T5 类比叙事引导：检测到纯抽象时注入（cooldown 4 轮）
	if cue := strings.TrimSpace(pp.AnalogyCue); cue != "" {
		if tooAbstract, _ := DetectAbstractOnly(snap.Recent, snap.RoundsUsed); tooAbstract {
			signals = append(signals, preTurnSignal{"T5_analogy", 4, 2, "\n" + cue + "\n"})
		}
	}

	// T6 话题锚定：检测到跑题时注入（cooldown 6 轮）
	if anchor := strings.TrimSpace(pp.TopicAnchor); anchor != "" {
		if drifted, _ := DetectTopicDrift(snap.Recent, snap.Goal, snap.RoundsUsed); drifted {
			rendered := renderTemplate(anchor, map[string]any{"Goal": snap.Goal})
			signals = append(signals, preTurnSignal{"T6_topic", 6, 2, "\n" + rendered + "\n"})
		}
	}

	// ── 真实世界增强层（R1-R6 pre-turn 部分）── 优先级 1/2

	// R3 假设追踪：检测到大量未验证假设时注入（cooldown 5 轮）
	if tmpl := strings.TrimSpace(pp.AssumptionChallenge); tmpl != "" {
		if tooMany, count := DetectUnverifiedAssumptions(snap.Recent, snap.RoundsUsed); tooMany {
			msg := renderTemplate(tmpl, map[string]any{"Count": count})
			signals = append(signals, preTurnSignal{"R3_assumption", 5, 1, "\n" + msg + "\n"})
		}
	}

	// R5 紧迫感升级：根据预算消耗比注入（每轮判定，不用 cooldown）
	if snap.RoundBudget > 0 {
		urgency := CalcUrgencyLevel(snap.RoundsUsed, snap.RoundBudget)
		remaining := snap.RoundBudget - snap.RoundsUsed
		vars := map[string]any{
			"RoundsUsed":  snap.RoundsUsed,
			"RoundBudget": snap.RoundBudget,
			"Remaining":   remaining,
		}
		switch urgency {
		case 2:
			if tmpl := strings.TrimSpace(pp.UrgencyCritical); tmpl != "" {
				msg := renderTemplate(tmpl, vars)
				signals = append(signals, preTurnSignal{"R5_urgency", 0, 0, "\n" + msg + "\n"})
			}
		case 1:
			if tmpl := strings.TrimSpace(pp.UrgencyMild); tmpl != "" {
				msg := renderTemplate(tmpl, vars)
				signals = append(signals, preTurnSignal{"R5_urgency", 3, 1, "\n" + msg + "\n"})
			}
		}
	}

	// ── 按优先级排序 + 冷却过滤 + 预算截断 ──

	// 稳定排序（保持同优先级内的声明顺序）
	sortSignals(signals)

	var sb strings.Builder
	emitted := 0
	for _, sig := range signals {
		if emitted >= maxSignals {
			break
		}
		// 冷却检查（cooldown 0 表示不限制）
		if sig.cooldown > 0 {
			if lastRound, ok := cooldowns[sig.id]; ok && snap.RoundsUsed-lastRound < sig.cooldown {
				continue
			}
		}
		sb.WriteString(sig.content)
		if sig.cooldown > 0 {
			cooldowns[sig.id] = snap.RoundsUsed
		}
		emitted++
	}
	return sb.String()
}

// sortSignals 按 priority 升序稳定排序。
func sortSignals(signals []preTurnSignal) {
	// 插入排序（信号数 ≤ 15，稳定且零分配）
	for i := 1; i < len(signals); i++ {
		key := signals[i]
		j := i - 1
		for j >= 0 && signals[j].priority > key.priority {
			signals[j+1] = signals[j]
			j--
		}
		signals[j+1] = key
	}
}

// ── Post-Turn Conductor ──────────────────────────────────────────────

// PostTurnActions 是 post-turn 决策的输出。
type PostTurnActions struct {
	SystemMessages []string // 要注入的系统消息（已受预算 + 冷却控制）
	ForceNextIDs   []string // C3 协作求助目标（orchestrator 对每个 ID 调 ForceNext）
	SwitchPhase    string   // C7 重规划目标阶段（非空 = 触发阶段切换）
	ReplanReason   string   // C7 重规划原因（用于日志）
}

// ConductPostTurn 在 agent 发言完成后，统一决定所有后续动作。
//
// 输入：snap（会议快照）, speakerID/speakerName, cleaned（已剥离内容）,
//
//	helpReqs/replanSig（已从 runAgentTurn 解析的 tag）,
//	cooldowns, opts
//
// 输出：PostTurnActions，orchestrator 执行这些 action，不再自己做 if 判断。
func ConductPostTurn(
	snap *MeetingSnapshot,
	speakerID string,
	speakerName string,
	cleaned string,
	helpReqs []HelpRequest,
	replanSig *ReplanSignal,
	cooldowns map[string]int,
	opts *PolicyOptions,
) *PostTurnActions {
	actions := &PostTurnActions{}

	budget := 2
	if opts != nil && opts.HealthCheckBudget > 0 {
		budget = opts.HealthCheckBudget
	}
	disableHealth := opts != nil && opts.DisableHealthCheck
	curRound := snap.RoundsUsed

	// 统一从 PromptPack 获取所有文案
	var pp *PromptPack
	if opts != nil {
		pp = opts.GetPrompts()
	} else {
		pp = DefaultPromptPack()
	}
	tags := snap.LastSoftTags // v1.0 双轨检测：tag 优先 + 关键词 fallback

	// tryEmit 内部函数：冷却 + 预算控制
	tryEmit := func(signalID string, cooldown int, msg string) bool {
		if budget <= 0 || strings.TrimSpace(msg) == "" {
			return false
		}
		if cd, ok := cooldowns[signalID]; ok && curRound-cd < cooldown {
			return false
		}
		cooldowns[signalID] = curRound
		actions.SystemMessages = append(actions.SystemMessages, msg)
		budget--
		return true
	}

	// ── 协作执行层（C3/C7）── 最高优先级，不受 disableHealth 影响

	// C7 动态重规划
	if replanSig != nil && snap.Policy == PolicyPlanned && snap.ExecutionPhase == PhaseExecuting {
		actions.SwitchPhase = PhaseDiscussion
		actions.ReplanReason = replanSig.Reason
		tryEmit("C7_replan", 0, fmt.Sprintf(
			"🔄 %s 请求重新规划：%s\n执行已暂停，回到讨论阶段。请讨论后重新安排执行队列。",
			speakerName, replanSig.Reason))
	}

	// C3 协作求助
	for _, hr := range helpReqs {
		targetID := ResolveHelpTarget(hr.TargetName, snap.Members)
		if targetID == "" || targetID == speakerID {
			continue
		}
		tryEmit("C3_help_"+targetID, 2, fmt.Sprintf("🤝 %s 向 %s 求助：%s", speakerName, hr.TargetName, hr.Question))
		actions.ForceNextIDs = append(actions.ForceNextIDs, targetID)
	}

	// ── 决策流程层 ── 高优先级

	// §8 决策提议检测：tag 优先（#proposal: yes），fallback 关键词
	isProposal := tags.Proposal == "yes" || DetectProposalSignal(cleaned)
	if isProposal {
		msg := renderTemplate(pp.ProposalNotice, map[string]any{"ProposerName": speakerName})
		tryEmit("S8_proposal", 3, msg)
	}

	// ── 真实世界增强层（R1/R2/R4/R6 post-turn 部分）──

	// R1 突破势能（cooldown 4）：tag 优先（#novelty: high），fallback 关键词
	{
		isBreakthrough := tags.Novelty == "high"
		var authorName, snippet string
		if !isBreakthrough {
			isBreakthrough, authorName, snippet = DetectBreakthrough(snap.Recent, snap.MemberNames)
		} else {
			authorName = speakerName
			snippet = cleaned
			if len([]rune(snippet)) > 80 {
				snippet = string([]rune(snippet)[:80]) + "…"
			}
		}
		if isBreakthrough {
			msg := renderTemplate(pp.BreakthroughMomentum, map[string]any{
				"AuthorName": authorName,
				"Snippet":    snippet,
			})
			tryEmit("R1_breakthrough", 4, msg)
		}
	}

	// R2 少数派保护（cooldown 6）：1人反对多人同意且无人回应 → 保护少数派
	if isolated, minorityName, _ := DetectMinorityVoice(snap.Recent, snap.MemberNames); isolated {
		msg := renderTemplate(pp.MinorityVoice, map[string]any{"MinorityName": minorityName})
		tryEmit("R2_minority", 6, msg)
	}

	// R4 决策质量门（cooldown 8）：tag 优先（#decision-gaps），fallback 关键词
	if isProposal {
		var missingItems string
		if gaps := strings.TrimSpace(tags.DecisionGaps); gaps != "" {
			// tag 提供了缺失项，直接用
			missingItems = gaps
		} else {
			// fallback 到关键词检测
			if missing := DecisionQualityCheck(snap.Recent); len(missing) > 0 {
				missingItems = strings.Join(missing, "、")
			}
		}
		if missingItems != "" {
			msg := renderTemplate(pp.DecisionGate, map[string]any{
				"MissingItems": missingItems,
			})
			tryEmit("R4_decision_gate", 8, msg)
		}
	}

	// R6 复读他人（cooldown 3）：最新发言复读了之前他人的观点 → 提醒
	if isEcho, echoedName := DetectEchoOthers(snap.Recent, snap.MemberNames); isEcho {
		msg := renderTemplate(pp.EchoWarning, map[string]any{
			"SpeakerName": speakerName,
			"EchoedName":  echoedName,
		})
		tryEmit("R6_echo", 3, msg)
	}

	// ── 健康度层 ── 受 disableHealth 控制，所有文案通过 PromptPack 模板
	if !disableHealth {
		// D1 论点僵局（cooldown 4）
		if deadlocked, nameA, nameB := DetectArgumentDeadlock(snap.Recent, snap.MemberNames); deadlocked {
			msg := renderTemplate(pp.DeadlockIntervention, map[string]any{"NameA": nameA, "NameB": nameB})
			tryEmit("D1_deadlock", 4, msg)
		}

		// D2 人类被遗忘（cooldown 5）
		{
			threshold := 6
			if opts != nil && opts.HumanForgottenThreshold > 0 {
				threshold = opts.HumanForgottenThreshold
			}
			if forgotten, humanName, rounds := DetectHumanForgotten(snap.Recent, snap.Members, threshold); forgotten {
				msg := renderTemplate(pp.HumanForgotten, map[string]any{"HumanName": humanName, "Rounds": rounds})
				tryEmit("D2_human_forgotten", 5, msg)
			}
		}

		// D4 情绪升级（cooldown 3，仅 debate）
		if snap.Policy == PolicyDebate {
			threshold := 3
			if opts != nil && opts.EscalationThreshold > 0 {
				threshold = opts.EscalationThreshold
			}
			if escalated, rounds := DetectEmotionalEscalation(snap.Recent, threshold); escalated {
				msg := renderTemplate(pp.EscalationCooldown, map[string]any{"Rounds": rounds})
				tryEmit("D4_escalation", 3, msg)
			}
		}

		// D5 共识锁定（cooldown 6）
		if len(snap.AgentIDs) >= 3 {
			if hasConsensus, snippet, count := DetectEmergingConsensus(snap.Recent, snap.AgentIDs, 3); hasConsensus {
				msg := renderTemplate(pp.ConsensusLock, map[string]any{"Count": count, "Snippet": snippet})
				tryEmit("D5_consensus", 6, msg)
			}
		}

		// T4 群体思维警告（cooldown 5）—— 与 D5 互补：D5 锁共识，T4 挑战伪共识
		if groupthink, rounds := DetectGroupthink(snap.Recent, snap.AgentIDs); groupthink {
			msg := renderTemplate(pp.GroupthinkAlert, map[string]any{"Rounds": rounds})
			tryEmit("T4_groupthink", 5, msg)
		}

		// D6 承诺确认（cooldown 3）
		if !DetectProposalSignal(cleaned) && len(snap.Recent) >= 3 {
			for checkIdx := len(snap.Recent) - 3; checkIdx < len(snap.Recent)-1; checkIdx++ {
				if checkIdx < 0 {
					continue
				}
				if DetectProposalSignal(snap.Recent[checkIdx].Content) {
					uncommitted := FindUncommittedMembers(snap.Recent, checkIdx, snap.AgentIDs, snap.Recent[checkIdx].AuthorID)
					if len(uncommitted) > 0 {
						names := make([]string, 0, len(uncommitted))
						for _, uid := range uncommitted {
							n := snap.MemberNames[uid]
							if n == "" {
								n = uid
							}
							names = append(names, n)
						}
						msg := renderTemplate(pp.CommitmentReminder, map[string]any{
							"Names": strings.Join(names, "、"),
						})
						tryEmit("D6_commitment", 3, msg)
					}
					break
				}
			}
		}

		// D8 元过程反思（cooldown 8）
		{
			threshold := 10
			if opts != nil && opts.MetaReflectionThreshold > 0 {
				threshold = opts.MetaReflectionThreshold
			}
			if curRound >= threshold {
				if DetectLowProductivity(curRound, snap.FactCount, snap.TaskCount, snap.DecisionCount, threshold, 1) {
					msg := renderTemplate(pp.MetaReflection, map[string]any{"RoundsUsed": curRound})
					tryEmit("D8_meta_reflection", 8, msg)
				}
			}
		}
	}

	return actions
}
