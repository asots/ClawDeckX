// meeting_atmosphere.go — v1.0 会议氛围个性化引擎
//
// 本文件集中管理"让 AI 会议更有个性"的检测 + 数据逻辑：
//   - T1 氛围语气（ToneDirective）：根据 preset 自动注入语气基调
//   - T2 发言长度引导（LengthGuidance）：根据阶段 + 策略动态调整
//   - T3 创意激发（CreativityBoost）：检测讨论保守/同质化时激发跳跃思维
//   - T4 群体思维警告（GroupthinkAlert）：连续多人同意时注入批判性思考提醒
//   - T5 类比叙事引导（AnalogyCue）：检测纯抽象讨论时鼓励举例/类比/故事
//   - T6 话题锚定（TopicAnchor）：检测跑题时拉回主线
//
// 所有函数都是纯函数，不持有状态。conductor 在 pre-turn / post-turn 调用。
package agentroom

import (
	"strings"

	"ClawDeckX/internal/database"
)

// ── T3 创意保守检测 ──────────────────────────────────────────────────
//
// 真实头脑风暴的最大杀手是"安全发言"——所有人都在说正确但显而易见的话。
// 检测最近 N 条消息是否缺乏跳跃性、新颖性信号。

// DetectCreativityStagnation 检查最近消息是否缺乏新意。
// 判断逻辑：最近 6 条 chat 中，如果没有出现任何创意信号词，判定为停滞。
// 返回 (stagnant, rounds) — stagnant=true 表示需要激发。
func DetectCreativityStagnation(recent []database.AgentRoomMessage, roundsUsed int) (bool, int) {
	if roundsUsed < 4 {
		return false, 0 // 开场阶段不判定
	}

	chats := filterRecentChats(recent, 6)
	if len(chats) < 4 {
		return false, 0
	}

	creativitySignals := 0
	for _, m := range chats {
		lower := strings.ToLower(m.Content)
		if hasCreativitySignal(lower) {
			creativitySignals++
		}
	}

	// 6 条里 0 条有创意信号 → 停滞
	if creativitySignals == 0 {
		return true, len(chats)
	}
	return false, 0
}

// hasCreativitySignal 检查文本是否包含创意/跳跃性思维信号。
func hasCreativitySignal(lower string) bool {
	return SignalMatch(SigCreativity, lower)
}

// ── T4 群体思维检测 ──────────────────────────────────────────────────
//
// D5 检测共识并锁定是好事，但如果所有人都在"点头"——这不叫共识，这叫群体思维。
// 真正的好决策需要有人唱反调。

// DetectGroupthink 检查最近消息是否出现连续同意模式。
// 返回 (groupthink, consecutiveAgrees) — true 表示需要注入批判提醒。
//
// v1.0 双轨检测：优先用 DB msg.Stance（来自 #stance tag），fallback 到关键词。
func DetectGroupthink(recent []database.AgentRoomMessage, agentIDs map[string]bool) (bool, int) {
	chats := filterRecentChats(recent, 8)
	if len(chats) < 4 {
		return false, 0
	}

	// 从最新往前扫，计算连续"同意性"消息
	consecutive := 0
	distinctAuthors := map[string]bool{}
	for i := len(chats) - 1; i >= 0; i-- {
		m := chats[i]
		supportive := false
		if m.Stance == StanceAgree {
			supportive = true // tag 优先
		} else if m.Stance == "" {
			// tag 缺失 → fallback 到关键词
			lower := strings.ToLower(m.Content)
			supportive = isSupportiveContent(lower) && !isChallengingContent(lower)
		}
		if supportive {
			consecutive++
			if agentIDs[m.AuthorID] {
				distinctAuthors[m.AuthorID] = true
			}
		} else {
			break // 遇到非同意的就停
		}
	}

	// 连续 4+ 条同意性消息 且 来自 3+ 不同成员 → 群体思维
	if consecutive >= 4 && len(distinctAuthors) >= 3 {
		return true, consecutive
	}
	return false, 0
}

// ── T5 抽象讨论检测 ──────────────────────────────────────────────────
//
// 纯理论交锋容易脱离实际。检测最近消息是否缺乏具体例子/类比/数据。

// DetectAbstractOnly 检查最近消息是否全是抽象讨论，缺乏具体实例。
// 返回 (tooAbstract, rounds)。
func DetectAbstractOnly(recent []database.AgentRoomMessage, roundsUsed int) (bool, int) {
	if roundsUsed < 6 {
		return false, 0
	}

	chats := filterRecentChats(recent, 6)
	if len(chats) < 4 {
		return false, 0
	}

	concreteCount := 0
	for _, m := range chats {
		lower := strings.ToLower(m.Content)
		if hasConcreteSignal(lower) {
			concreteCount++
		}
	}

	// 6 条里 ≤1 条有具体信号 → 太抽象
	if concreteCount <= 1 {
		return true, len(chats)
	}
	return false, 0
}

func hasConcreteSignal(lower string) bool {
	return SignalMatch(SigConcrete, lower)
}

// ── T6 跑题检测 ──────────────────────────────────────────────────────
//
// 会议有明确目标/议题时，检测最近发言是否偏离主题。

// DetectTopicDrift 简单检测：如果房间有 Goal 且最近 4 条消息都不包含目标关键词，判定为跑题。
// 返回 (drifted, rounds)。
func DetectTopicDrift(recent []database.AgentRoomMessage, goal string, roundsUsed int) (bool, int) {
	if roundsUsed < 4 || strings.TrimSpace(goal) == "" {
		return false, 0
	}

	// 从 goal 中提取关键词（简单分词：按空格/标点拆分，取 ≥2 字符的词）
	goalKeywords := extractKeywords(goal)
	if len(goalKeywords) == 0 {
		return false, 0
	}

	chats := filterRecentChats(recent, 4)
	if len(chats) < 3 {
		return false, 0
	}

	// 检查最近 4 条是否有任何一条包含目标关键词
	for _, m := range chats {
		lower := strings.ToLower(m.Content)
		for _, kw := range goalKeywords {
			if strings.Contains(lower, kw) {
				return false, 0 // 有人还在聊主题
			}
		}
	}

	return true, len(chats)
}

// ── R1 突破势能检测 ──────────────────────────────────────────────────
//
// 真实会议中，有人提出全新角度时能量陡增。如果没人跟进，突破就沉没了。
// 检测最新消息是否引入了之前 N 条都未出现过的新概念。

// DetectBreakthrough 检查最新 1 条消息是否引入了前 8 条都不含的新概念。
// 返回 (breakthrough, authorName, novelSnippet)。
func DetectBreakthrough(recent []database.AgentRoomMessage, memberNames map[string]string) (bool, string, string) {
	chats := filterRecentChats(recent, 9) // 最新 1 条 + 前 8 条比对
	if len(chats) < 5 {
		return false, "", "" // 太少轮次不判定
	}

	latest := chats[len(chats)-1]
	latestKW := extractKeywords(latest.Content)
	if len(latestKW) < 2 {
		return false, "", ""
	}

	// 收集前 N-1 条的关键词池
	oldPool := map[string]bool{}
	for i := 0; i < len(chats)-1; i++ {
		for _, kw := range extractKeywords(chats[i].Content) {
			oldPool[kw] = true
		}
	}

	// 计算最新消息中有多少关键词是全新的
	novelCount := 0
	var novelSample string
	for _, kw := range latestKW {
		if !oldPool[kw] {
			novelCount++
			if novelSample == "" {
				novelSample = kw
			}
		}
	}

	// 全新关键词占比 ≥ 60% → 判定为突破性发言
	if len(latestKW) > 0 && float64(novelCount)/float64(len(latestKW)) >= 0.6 {
		name := memberNames[latest.AuthorID]
		if name == "" {
			name = latest.AuthorID
		}
		snippet := latest.Content
		if len([]rune(snippet)) > 80 {
			snippet = string([]rune(snippet)[:80]) + "…"
		}
		return true, name, snippet
	}
	return false, "", ""
}

// ── R2 少数派保护检测 ────────────────────────────────────────────────
//
// T4 检测"全员同意"，但更危险的是"多数人同意、1人反对却被忽略"。
// 那个少数派往往看到了别人没看到的风险。

// DetectMinorityVoice 检查最近消息中是否存在少数派观点被忽略。
// 返回 (isolated, minorityName, stance)。
//
// v1.0 双轨检测：优先使用 DB 存储的 msg.Stance（来自 LLM #stance tag，跨语言精确），
// 未提供时 fallback 到关键词检测。
func DetectMinorityVoice(recent []database.AgentRoomMessage, memberNames map[string]string) (bool, string, string) {
	chats := filterRecentChats(recent, 8)
	if len(chats) < 5 {
		return false, "", ""
	}

	// 统计每个人最近发言的态度：优先用 DB Stance（tag 来源），fallback 关键词
	stances := map[string]string{} // authorID → "support" | "challenge" | "neutral"
	for _, m := range chats {
		switch m.Stance {
		case StanceAgree:
			stances[m.AuthorID] = "support"
		case StanceDisagree:
			stances[m.AuthorID] = "challenge"
		case StanceAbstain, StanceUncertain:
			// 已有 tag 但非支持/反对，不覆盖
		default:
			// tag 缺失 → fallback 到关键词
			lower := strings.ToLower(m.Content)
			if isChallengingContent(lower) && !isSupportiveContent(lower) {
				stances[m.AuthorID] = "challenge"
			} else if isSupportiveContent(lower) && !isChallengingContent(lower) {
				stances[m.AuthorID] = "support"
			}
		}
	}

	supporters := 0
	challengers := 0
	var challengerID string
	for id, s := range stances {
		switch s {
		case "support":
			supporters++
		case "challenge":
			challengers++
			challengerID = id
		}
	}

	// 3+ 支持、仅 1 人挑战 → 少数派被孤立
	if supporters >= 3 && challengers == 1 {
		name := memberNames[challengerID]
		if name == "" {
			name = challengerID
		}
		// 检查少数派最近的观点是否被任何人正面回应
		responded := false
		for i := len(chats) - 1; i >= 0; i-- {
			m := chats[i]
			if m.AuthorID == challengerID {
				continue
			}
			lower := strings.ToLower(m.Content)
			if strings.Contains(lower, strings.ToLower(name)) {
				responded = true
				break
			}
		}
		if !responded {
			return true, name, "反对"
		}
	}
	return false, "", ""
}

// ── R3 隐含假设检测 ──────────────────────────────────────────────────
//
// 讨论中充满"用户肯定会…""市场应该…""技术上没问题…"这类未经验证的假设。
// 检测最近消息中是否存在大量假设性语言但缺少验证。

// DetectUnverifiedAssumptions 检查最近消息中假设性语言的密度。
// 返回 (tooMany, count)。
func DetectUnverifiedAssumptions(recent []database.AgentRoomMessage, roundsUsed int) (bool, int) {
	if roundsUsed < 4 {
		return false, 0
	}
	chats := filterRecentChats(recent, 6)
	if len(chats) < 3 {
		return false, 0
	}

	assumptionCount := 0
	verificationCount := 0
	for _, m := range chats {
		lower := strings.ToLower(m.Content)
		if hasAssumptionSignal(lower) {
			assumptionCount++
		}
		if hasVerificationSignal(lower) {
			verificationCount++
		}
	}

	// 假设 ≥ 3 且验证 = 0 → 需要追问
	if assumptionCount >= 3 && verificationCount == 0 {
		return true, assumptionCount
	}
	return false, 0
}

func hasAssumptionSignal(lower string) bool {
	return SignalMatch(SigAssumption, lower)
}

func hasVerificationSignal(lower string) bool {
	return SignalMatch(SigVerification, lower)
}

// ── R4 决策质量门 ────────────────────────────────────────────────────
//
// 真实决策前应满足最低质量标准：问题明确、有备选方案、风险已识别。
// 在 §8 ProposalSignal 之后，检查前几轮是否覆盖了这三项。

// DecisionQualityCheck 检查提议前的讨论是否满足最低决策质量。
// 返回缺失的维度列表。
func DecisionQualityCheck(recent []database.AgentRoomMessage) []string {
	chats := filterRecentChats(recent, 12)
	if len(chats) < 3 {
		return nil
	}

	hasProblemDef := false
	hasAlternative := false
	hasRiskIdent := false

	for _, m := range chats {
		lower := strings.ToLower(m.Content)
		if !hasProblemDef && hasProblemDefinition(lower) {
			hasProblemDef = true
		}
		if !hasAlternative && hasAlternativeOption(lower) {
			hasAlternative = true
		}
		if !hasRiskIdent && hasRiskIdentification(lower) {
			hasRiskIdent = true
		}
	}

	var missing []string
	if !hasProblemDef {
		missing = append(missing, "问题定义")
	}
	if !hasAlternative {
		missing = append(missing, "备选方案")
	}
	if !hasRiskIdent {
		missing = append(missing, "风险识别")
	}
	return missing
}

func hasProblemDefinition(lower string) bool {
	return SignalMatch(SigProblemDef, lower)
}

func hasAlternativeOption(lower string) bool {
	return SignalMatch(SigAlternative, lower)
}

func hasRiskIdentification(lower string) bool {
	return SignalMatch(SigRisk, lower)
}

// ── R5 紧迫感升级 ────────────────────────────────────────────────────
//
// 真实会议中"还剩5分钟"让行为剧变。四阶段的 convergence 是平滑过渡，
// 但缺少"临门一脚"的紧迫注入。

// CalcUrgencyLevel 根据预算消耗比返回紧迫级别。
// 0 = 无紧迫, 1 = 中度提醒, 2 = 高度紧迫。
func CalcUrgencyLevel(roundsUsed, roundBudget int) int {
	if roundBudget <= 0 {
		return 0
	}
	ratio := float64(roundsUsed) / float64(roundBudget)
	remaining := roundBudget - roundsUsed
	switch {
	case ratio >= 0.9 || remaining <= 2:
		return 2 // 最后 10% 或最后 2 轮
	case ratio >= 0.75 || remaining <= 4:
		return 1 // 最后 25% 或最后 4 轮
	default:
		return 0
	}
}

// ── R6 复读他人检测 ──────────────────────────────────────────────────
//
// scheduler 的 repetitionPenalty 检测自我重复。
// 但另一种病理是：A 在第20轮说了 B 在第5轮就说过的话——这不是自我重复，而是信息冗余。

// DetectEchoOthers 检查最新一条消息是否高度复读之前其他人的某条消息。
// 返回 (isEcho, echoAuthorName)。
func DetectEchoOthers(recent []database.AgentRoomMessage, memberNames map[string]string) (bool, string) {
	chats := filterRecentChats(recent, 10)
	if len(chats) < 4 {
		return false, ""
	}

	latest := chats[len(chats)-1]
	latestNorm := normalizeSpeechText(latest.Content)
	if latestNorm == "" {
		return false, ""
	}

	// 和之前其他人的消息比对
	for i := 0; i < len(chats)-1; i++ {
		m := chats[i]
		if m.AuthorID == latest.AuthorID {
			continue // 自我重复由 scheduler 处理
		}
		otherNorm := normalizeSpeechText(m.Content)
		if otherNorm == "" {
			continue
		}
		if tokenOverlap(latestNorm, otherNorm) >= 0.65 {
			name := memberNames[m.AuthorID]
			if name == "" {
				name = m.AuthorID
			}
			return true, name
		}
	}
	return false, ""
}

// extractKeywords 从一段文本中提取有意义的关键词（≥2 字符，去除停用词）。
func extractKeywords(text string) []string {
	lower := strings.ToLower(text)
	// 简单分词
	replacer := strings.NewReplacer(
		"，", " ", "。", " ", "、", " ", "；", " ", "：", " ",
		"！", " ", "？", " ", "（", " ", "）", " ",
		",", " ", ".", " ", ";", " ", ":", " ",
		"!", " ", "?", " ", "(", " ", ")", " ",
		"\n", " ", "\r", " ", "\t", " ",
	)
	normalized := replacer.Replace(lower)
	words := strings.Fields(normalized)

	stopWords := stopWords // 统一停用词表（来自 signal_lexicon.go）

	var keywords []string
	seen := map[string]bool{}
	for _, w := range words {
		w = strings.TrimSpace(w)
		if len([]rune(w)) < 2 || stopWords[w] || seen[w] {
			continue
		}
		seen[w] = true
		keywords = append(keywords, w)
		if len(keywords) >= 8 { // 最多取 8 个关键词
			break
		}
	}
	return keywords
}
