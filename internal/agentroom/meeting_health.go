package agentroom

// meeting_health.go — v1.0 会议健康度检测层
//
// 会议会"生病"：打转、独占、升级、失焦、遗忘人类。
// 本文件集中管理"检测会议病理并给出干预信号"的全部纯函数。
// orchestrator 在每轮 turn 前/后调用这些函数，决定是否注入系统消息或调整 prompt。

import (
	"fmt"
	"strings"

	"ClawDeckX/internal/database"
)

// ── D1 论点僵局检测（Argument Deadlock） ────────────────────────────
//
// scheduler 的 repetitionPenalty 只检测单人自我重复。
// 但更常见的病理是"双人乒乓"：A 和 B 用几乎相同的论点互相回怼 3+ 轮，
// 没有任何新信息进入——这是最浪费 token 的模式。

// DetectArgumentDeadlock 检查最近消息中是否存在两人论点乒乓。
// 返回 (deadlocked, personA, personB)。deadlocked=true 表示需要系统介入。
func DetectArgumentDeadlock(recent []database.AgentRoomMessage, memberNames map[string]string) (bool, string, string) {
	// 取最近 8 条 chat（足够覆盖 4 个来回）
	chats := filterRecentChats(recent, 8)
	if len(chats) < 4 {
		return false, "", ""
	}

	// 统计最近消息中最活跃的两个人
	freq := map[string]int{}
	for _, m := range chats {
		freq[m.AuthorID]++
	}

	// 找出出现最多的两人
	var top1, top2 string
	var cnt1, cnt2 int
	for id, cnt := range freq {
		if cnt > cnt1 {
			top2, cnt2 = top1, cnt1
			top1, cnt1 = id, cnt
		} else if cnt > cnt2 {
			top2, cnt2 = id, cnt
		}
	}
	if cnt1 < 2 || cnt2 < 2 {
		return false, "", ""
	}

	// 提取这两人各自的最近发言文本
	textsA := extractMemberTexts(chats, top1, 3)
	textsB := extractMemberTexts(chats, top2, 3)
	if len(textsA) < 2 || len(textsB) < 2 {
		return false, "", ""
	}

	// 检测 A 的发言之间是否高度重复 + B 的发言之间是否高度重复
	// 如果两人都在自我重复（overlap >= 0.55），则认为是乒乓僵局
	overlapA := tokenOverlap(textsA[0], textsA[1])
	overlapB := tokenOverlap(textsB[0], textsB[1])

	if overlapA >= 0.50 && overlapB >= 0.50 {
		nameA := memberNames[top1]
		if nameA == "" {
			nameA = top1
		}
		nameB := memberNames[top2]
		if nameB == "" {
			nameB = top2
		}
		return true, nameA, nameB
	}
	return false, "", ""
}

// DeadlockInterventionMessage 生成论点僵局时的系统介入消息。
func DeadlockInterventionMessage(nameA, nameB string) string {
	return fmt.Sprintf(
		"⚠️ %s 和 %s 的讨论似乎在重复。请：\n"+
			"1. 提出**新论据**或**新证据**来支持你的立场\n"+
			"2. 或者承认对方在某个子论点上是对的，缩小分歧范围\n"+
			"3. 或者建议做决策——继续重复不会产生新信息",
		nameA, nameB,
	)
}

// ── D2 人类被遗忘（Human Forgotten） ────────────────────────────────
//
// Agent 们聊得热火朝天，人类用户 10 轮没说话——没人邀请他。

// DetectHumanForgotten 检查人类是否被遗忘。
// 返回 (forgotten, humanName, roundsSinceHuman)。
func DetectHumanForgotten(recent []database.AgentRoomMessage, members []database.AgentRoomMember, threshold int) (bool, string, int) {
	if threshold <= 0 {
		threshold = 6 // 默认连续 6 轮 agent 发言后提醒
	}

	// 找出人类成员
	humanIDs := map[string]string{} // id → name
	for _, m := range members {
		if m.Kind == "human" && !m.IsKicked {
			name := m.Name
			if name == "" {
				name = m.ID
			}
			humanIDs[m.ID] = name
		}
	}
	if len(humanIDs) == 0 {
		return false, "", 0
	}

	// 从最近消息末尾倒数，计算连续 agent 发言轮数
	agentRounds := 0
	for i := len(recent) - 1; i >= 0; i-- {
		m := recent[i]
		if m.Deleted || (m.Kind != MsgKindChat && m.Kind != MsgKindWhisper) {
			continue
		}
		if _, isHuman := humanIDs[m.AuthorID]; isHuman {
			break // 找到人类发言，停止计数
		}
		// 也包括 nudge 作者
		if strings.HasPrefix(m.AuthorID, "human:") {
			break
		}
		agentRounds++
	}

	if agentRounds < threshold {
		return false, "", agentRounds
	}

	// 返回第一个人类的名字
	for _, name := range humanIDs {
		return true, name, agentRounds
	}
	return false, "", agentRounds
}

// HumanForgottenMessage 生成邀请人类发言的系统消息。
func HumanForgottenMessage(humanName string, rounds int) string {
	return fmt.Sprintf(
		"💭 已经连续 %d 轮 agent 讨论了。@%s 你对目前的讨论有什么看法？"+
			"你可以随时插话、提出新方向、或者点 ▶ 继续会议 让 agent 继续。",
		rounds, humanName,
	)
}

// ── D3 Agent 独占检测（Agent Monopolizing） ─────────────────────────
//
// 单个 agent 写了 2000 字，其他 agent 只写 200 字——篇幅不对等。

// DetectMonopolizer 检查最近消息中是否有 agent 的篇幅远超平均值。
// 返回 (monopolized, agentName, avgLen, agentLen)。
func DetectMonopolizer(recent []database.AgentRoomMessage, memberNames map[string]string) (bool, string, int, int) {
	// 统计每个 agent 最近一条发言的长度
	lastLen := map[string]int{} // authorID → rune count
	for _, m := range recent {
		if m.Deleted || m.Kind != MsgKindChat || strings.TrimSpace(m.Content) == "" {
			continue
		}
		lastLen[m.AuthorID] = len([]rune(m.Content))
	}
	if len(lastLen) < 2 {
		return false, "", 0, 0
	}

	// 计算平均值
	total := 0
	for _, l := range lastLen {
		total += l
	}
	avg := total / len(lastLen)
	if avg < 100 {
		return false, "", avg, 0 // 都很短，不算独占
	}

	// 找出篇幅最长的
	var maxID string
	var maxLen int
	for id, l := range lastLen {
		if l > maxLen {
			maxID = id
			maxLen = l
		}
	}

	// 如果最长者超过平均值的 3 倍，认为是独占
	if maxLen >= avg*3 && maxLen >= 600 {
		name := memberNames[maxID]
		if name == "" {
			name = maxID
		}
		return true, name, avg, maxLen
	}
	return false, "", avg, maxLen
}

// MonopolizerPrompt 生成篇幅约束 prompt（注入到 agent 的 context 中）。
func MonopolizerPrompt(agentName string) string {
	return fmt.Sprintf(
		"\n【篇幅提醒】你上一次发言明显长于其他成员。这不是演讲——是讨论。" +
			"请控制在 300 字以内，把核心观点说清楚就好。" +
			"如果内容确实复杂，分成多轮说，给其他人回应的机会。\n",
	)
}

// ── D4 情绪升级熔断（Emotional Escalation Circuit Breaker） ────────
//
// Debate 中连续 3+ 轮互相 challenge，需要降温。

// challengeSignals 已迁移到 signal_lexicon.go 的 SigEscalation category。
// 保留变量名作为空切片，避免外部引用报错（内部已不使用）。
var challengeSignals []string // deprecated: use SignalMatch(SigEscalation, text)

// DetectEmotionalEscalation 检查最近消息中是否出现连续挑战性语气。
// 返回 (escalated, consecutiveChallenges)。
func DetectEmotionalEscalation(recent []database.AgentRoomMessage, threshold int) (bool, int) {
	if threshold <= 0 {
		threshold = 3
	}

	// v1.0 双轨：优先用 DB msg.Stance（来自 #stance tag），fallback 到统一信号词表
	chats := filterRecentChats(recent, 6)
	consecutive := 0
	for i := len(chats) - 1; i >= 0; i-- {
		m := chats[i]
		challenging := false
		if m.Stance == StanceDisagree {
			challenging = true // tag 优先
		} else if m.Stance == "" {
			// tag 缺失 → fallback 到统一信号词表
			challenging = SignalMatch(SigEscalation, strings.ToLower(m.Content))
		}
		if challenging {
			consecutive++
		} else {
			break
		}
	}
	return consecutive >= threshold, consecutive
}

// EscalationCooldownMessage 生成降温系统消息。
func EscalationCooldownMessage(rounds int) string {
	return fmt.Sprintf(
		"🌡️ 连续 %d 轮出现了较强的对抗性语气。请各位：\n"+
			"- 回到**事实和数据**层面讨论，避免评价对方的判断力\n"+
			"- 尝试复述对方观点（「你的意思是…对吗？」）确保没有误解\n"+
			"- 如果在某个子论点上确实无法达成一致，可以标记为分歧点继续往下推",
		rounds,
	)
}

// ── D5 共识自动锁定（Consensus Locking） ────────────────────────────
//
// 当 3+ 个 agent 在最近消息中对同一个论点表示同意，自动锁定该共识。

// agreementSignals 已迁移到 signal_lexicon.go 的 SigAgreement category。
var agreementSignals []string // deprecated: use SignalMatch(SigAgreement, text)

// DetectEmergingConsensus 检查最近消息中是否有多人同意同一个论点。
// 返回 (hasConsensus, topicSnippet, agreedCount)。
func DetectEmergingConsensus(recent []database.AgentRoomMessage, agentIDs map[string]bool, minAgree int) (bool, string, int) {
	if minAgree <= 0 {
		minAgree = 3
	}

	chats := filterRecentChats(recent, 12)
	if len(chats) < minAgree {
		return false, "", 0
	}

	// 统计最近哪些 agent 在表示同意（不同 author）
	// v1.0 双轨：优先用 DB msg.Stance（来自 #stance tag），fallback 到统一信号词表
	agreedAuthors := map[string]bool{}
	var firstAgreeContent string
	for _, m := range chats {
		if !agentIDs[m.AuthorID] {
			continue
		}
		isAgreeing := false
		if m.Stance == StanceAgree {
			isAgreeing = true // tag 优先
		} else if m.Stance == "" {
			// tag 缺失 → fallback 到统一信号词表
			isAgreeing = SignalMatch(SigAgreement, strings.ToLower(m.Content))
		}
		if isAgreeing {
			agreedAuthors[m.AuthorID] = true
			if firstAgreeContent == "" {
				firstAgreeContent = m.Content
			}
		}
	}

	if len(agreedAuthors) < minAgree {
		return false, "", len(agreedAuthors)
	}

	// 提取共识主题：用第一条同意消息的首行作为摘要
	snippet := strings.TrimSpace(firstAgreeContent)
	if idx := strings.IndexAny(snippet, "\n\r"); idx > 0 {
		snippet = snippet[:idx]
	}
	if len([]rune(snippet)) > 100 {
		snippet = string([]rune(snippet)[:100]) + "…"
	}

	return true, snippet, len(agreedAuthors)
}

// ConsensusLockMessage 生成共识锁定系统消息。
func ConsensusLockMessage(count int, snippet string) string {
	return fmt.Sprintf(
		"🔒 %d 位成员对以下方向达成共识，已标记为已决——后续无需再讨论此点：\n「%s」\n"+
			"如有新信息推翻此共识，请明确说明原因。",
		count, snippet,
	)
}

// ── D6 决策后承诺确认（Post-Decision Commitment） ─────────────────
//
// Proposal 后有人同意有人没表态——追踪谁还没表态。

// FindUncommittedMembers 在 proposal 发出后扫描后续消息，找出还没表态的 agent。
// proposalIdx: proposal 消息在 recent 中的索引。
func FindUncommittedMembers(recent []database.AgentRoomMessage, proposalIdx int, agentIDs map[string]bool, proposerID string) []string {
	if proposalIdx < 0 || proposalIdx >= len(recent) {
		return nil
	}

	// 扫描 proposal 之后的消息，记录已表态的 agent
	responded := map[string]bool{proposerID: true} // 提议者默认已表态
	for i := proposalIdx + 1; i < len(recent); i++ {
		m := recent[i]
		if m.Deleted || m.Kind != MsgKindChat || !agentIDs[m.AuthorID] {
			continue
		}
		responded[m.AuthorID] = true
	}

	// 找出还没表态的
	var uncommitted []string
	for id := range agentIDs {
		if !responded[id] {
			uncommitted = append(uncommitted, id)
		}
	}
	return uncommitted
}

// CommitmentReminderMessage 生成催促未表态成员的系统消息。
func CommitmentReminderMessage(uncommittedNames []string) string {
	return fmt.Sprintf(
		"📢 以下成员尚未对刚才的提议表态：%s\n请快速表态：同意 / 反对 / 有条件同意。",
		strings.Join(uncommittedNames, "、"),
	)
}

// ── D7 新成员入场简报（Late Joiner Briefing） ─────────────────────
//
// 中途加入的成员需要快速了解会议进展。

// BuildLateJoinerBriefing 为新加入的成员生成会议摘要 prompt。
// facts: 已确认的事实列表，decisions: 已做的决策，currentTopic: 当前讨论主题。
func BuildLateJoinerBriefing(
	memberName string,
	roundsUsed int,
	facts []string,
	currentTopic string,
	recentSummary string,
) string {
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("\n【会议简报 · 写给 %s】\n", memberName))
	sb.WriteString(fmt.Sprintf("本次会议已进行了 %d 轮。\n", roundsUsed))

	if len(facts) > 0 {
		sb.WriteString("\n已确认的要点：\n")
		for i, f := range facts {
			if i >= 5 {
				sb.WriteString(fmt.Sprintf("  …及另外 %d 项\n", len(facts)-5))
				break
			}
			sb.WriteString(fmt.Sprintf("  • %s\n", f))
		}
	}

	if currentTopic != "" {
		sb.WriteString(fmt.Sprintf("\n当前讨论焦点：%s\n", currentTopic))
	}

	if recentSummary != "" {
		sb.WriteString(fmt.Sprintf("\n最近动态：%s\n", recentSummary))
	}

	sb.WriteString("\n你可以直接加入讨论。如果需要更多背景，请提问而不是猜测。\n")
	return sb.String()
}

// ── D8 元过程反思（Meta-Process Reflection） ────────────────────────
//
// 会议跑了很多轮但没产出——需要有人喊停反思。

// DetectLowProductivity 检查会议是否在空转。
// 条件：rounds >= threshold 且 factCount + decisionCount < minOutput。
func DetectLowProductivity(roundsUsed, factCount, taskCount, decisionMsgCount, threshold, minOutput int) bool {
	if threshold <= 0 {
		threshold = 10 // 默认 10 轮后开始检查
	}
	if minOutput <= 0 {
		minOutput = 1 // 至少应有 1 项产出
	}
	if roundsUsed < threshold {
		return false
	}
	totalOutput := factCount + taskCount + decisionMsgCount
	return totalOutput < minOutput
}

// MetaReflectionMessage 生成元过程反思系统消息。
func MetaReflectionMessage(roundsUsed int) string {
	return fmt.Sprintf(
		"🔍 会议已进行 %d 轮，但尚未产出明确的结论、事实或待办。建议各位思考：\n"+
			"- 我们是否在讨论正确的问题？\n"+
			"- 是否需要缩小讨论范围，先解决一个子问题？\n"+
			"- 是否有人可以提出一个具体的提案来推动决策？\n"+
			"如果觉得讨论方向对但还需要深入，可以忽略此提示继续。",
		roundsUsed,
	)
}

// ── 通用工具函数 ──────────────────────────────────────────────────

func filterRecentChats(recent []database.AgentRoomMessage, maxN int) []database.AgentRoomMessage {
	out := make([]database.AgentRoomMessage, 0, maxN)
	for i := len(recent) - 1; i >= 0 && len(out) < maxN; i-- {
		m := recent[i]
		if m.Deleted || m.Kind != MsgKindChat || strings.TrimSpace(m.Content) == "" {
			continue
		}
		out = append(out, m)
	}
	// 翻转为时间正序
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out
}

func extractMemberTexts(chats []database.AgentRoomMessage, memberID string, maxN int) []string {
	out := make([]string, 0, maxN)
	for i := len(chats) - 1; i >= 0 && len(out) < maxN; i-- {
		if chats[i].AuthorID == memberID {
			out = append(out, normalizeSpeechText(chats[i].Content))
		}
	}
	return out
}
