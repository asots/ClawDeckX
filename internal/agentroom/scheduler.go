package agentroom

import (
	"ClawDeckX/internal/database"
	"sort"
	"strings"
)

func repetitionPenalty(memberID string, recent []database.AgentRoomMessage) int {
	texts := make([]string, 0, 3)
	for i := len(recent) - 1; i >= 0 && len(texts) < 3; i-- {
		msg := recent[i]
		if msg.Kind != MsgKindChat || msg.AuthorID != memberID || strings.TrimSpace(msg.Content) == "" {
			continue
		}
		texts = append(texts, normalizeSpeechText(msg.Content))
	}
	if len(texts) < 2 {
		return 0
	}
	penalty := 0
	for i := 1; i < len(texts); i++ {
		if texts[i] == "" || texts[i-1] == "" {
			continue
		}
		overlap := tokenOverlap(texts[i], texts[i-1])
		if overlap >= 0.72 {
			penalty += 2
		} else if overlap >= 0.55 {
			penalty++
		}
	}
	return penalty
}

func topicStallPenalty(memberID string, recent []database.AgentRoomMessage) int {
	texts := make([]string, 0, 3)
	for i := len(recent) - 1; i >= 0 && len(texts) < 3; i-- {
		msg := recent[i]
		if msg.Kind != MsgKindChat || msg.AuthorID != memberID || strings.TrimSpace(msg.Content) == "" {
			continue
		}
		texts = append(texts, normalizeSpeechText(msg.Content))
	}
	if len(texts) < 3 {
		return 0
	}
	shared := sharedTopicTokens(texts)
	if shared >= 5 {
		return 2
	}
	if shared >= 3 {
		return 1
	}
	return 0
}

func sharedTopicTokens(texts []string) int {
	if len(texts) < 2 {
		return 0
	}
	counts := map[string]int{}
	for _, text := range texts {
		seen := map[string]bool{}
		for _, tok := range strings.Fields(text) {
			if len([]rune(tok)) < 2 {
				continue
			}
			if seen[tok] {
				continue
			}
			seen[tok] = true
			counts[tok]++
		}
	}
	shared := 0
	for _, n := range counts {
		if n >= 3 {
			shared++
		}
	}
	return shared
}

func normalizeSpeechText(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	replacer := strings.NewReplacer(
		"，", " ", "。", " ", "！", " ", "？", " ", "：", " ", "；", " ",
		",", " ", ".", " ", "!", " ", "?", " ", ":", " ", ";", " ",
		"（", " ", "）", " ", "(", " ", ")", " ", "\n", " ", "\t", " ",
	)
	s = replacer.Replace(s)
	return strings.Join(strings.Fields(s), " ")
}

func tokenOverlap(a, b string) float64 {
	if a == "" || b == "" {
		return 0
	}
	setA := map[string]bool{}
	setB := map[string]bool{}
	for _, tok := range strings.Fields(a) {
		if len([]rune(tok)) >= 2 {
			setA[tok] = true
		}
	}
	for _, tok := range strings.Fields(b) {
		if len([]rune(tok)) >= 2 {
			setB[tok] = true
		}
	}
	if len(setA) == 0 || len(setB) == 0 {
		return 0
	}
	inter := 0
	for tok := range setA {
		if setB[tok] {
			inter++
		}
	}
	minBase := len(setA)
	if len(setB) < minBase {
		minBase = len(setB)
	}
	if minBase == 0 {
		return 0
	}
	return float64(inter) / float64(minBase)
}

// PickContext 是调度器的输入上下文。
type PickContext struct {
	Room          *database.AgentRoom
	Members       []database.AgentRoomMember  // 已过滤掉 kicked 的 agent（human 也包含，仅用于判断 @ 定向）
	Recent        []database.AgentRoomMessage // 最近 N 条消息（时间升序），用于策略判断
	TriggerMsg    *database.AgentRoomMessage  // 触发本次选主的消息（通常是用户刚发的）
	ForcedNextID  string                      // 若非空，优先强制选这个成员
	RoundRobinIdx int                         // 外部维护的下一位轮次索引
}

func pickLeastRecentlyDominant(candidates []database.AgentRoomMember, recent []database.AgentRoomMessage) string {
	if len(candidates) == 0 {
		return ""
	}
	window := recent
	if len(window) > 8 {
		window = window[len(window)-8:]
	}
	counts := make(map[string]int, len(candidates))
	lastSeenIdx := make(map[string]int, len(candidates))
	for _, c := range candidates {
		counts[c.ID] = 0
		lastSeenIdx[c.ID] = -1
	}
	for i, msg := range window {
		if msg.Kind != MsgKindChat || msg.AuthorID == "" {
			continue
		}
		if _, ok := counts[msg.AuthorID]; !ok {
			continue
		}
		counts[msg.AuthorID]++
		lastSeenIdx[msg.AuthorID] = i
	}
	// v1.0 §4 沉默力学：沉默越久的成员得分越高（SilenceBonus 0-3），
	// 让 scheduler 自然倾向于让旁听多轮的人"蓄力发言"。
	// 实现方式：silenceBonus 越高 → effectivePenalty 越低（减去 bonus），
	// 从而在排序中优先被选中。
	best := candidates[0]
	bestCount := counts[best.ID]
	bestLastIdx := lastSeenIdx[best.ID]
	bestPenalty := repetitionPenalty(best.ID, window) - SilenceBonus(CountSilentTurns(best.ID, recent))
	bestTopicPenalty := topicStallPenalty(best.ID, window)
	for _, c := range candidates[1:] {
		count := counts[c.ID]
		lastIdx := lastSeenIdx[c.ID]
		penalty := repetitionPenalty(c.ID, window) - SilenceBonus(CountSilentTurns(c.ID, recent))
		topicPenalty := topicStallPenalty(c.ID, window)
		if penalty < bestPenalty ||
			(penalty == bestPenalty && topicPenalty < bestTopicPenalty) ||
			(penalty == bestPenalty && topicPenalty == bestTopicPenalty && count < bestCount) ||
			(penalty == bestPenalty && topicPenalty == bestTopicPenalty && count == bestCount && lastIdx < bestLastIdx) {
			best = c
			bestCount = count
			bestLastIdx = lastIdx
			bestPenalty = penalty
			bestTopicPenalty = topicPenalty
		}
	}
	return best.ID
}

func pickFreeNext(agents []database.AgentRoomMember, recent []database.AgentRoomMessage, trigger *database.AgentRoomMessage) string {
	last := lastAgentSpeaker(recent)
	if len(agents) == 1 {
		return agents[0].ID
	}
	if shouldLetLastContinue(recent, trigger) {
		for _, m := range agents {
			if m.ID == last {
				return m.ID
			}
		}
	}
	candidates := make([]database.AgentRoomMember, 0, len(agents))
	for _, m := range agents {
		if m.ID != last {
			candidates = append(candidates, m)
		}
	}
	if len(candidates) == 0 {
		return ""
	}
	return pickLeastRecentlyDominant(candidates, recent)
}

func shouldLetLastContinue(recent []database.AgentRoomMessage, trigger *database.AgentRoomMessage) bool {
	if trigger == nil || strings.TrimSpace(trigger.Content) == "" {
		return false
	}
	text := strings.TrimSpace(trigger.Content)
	if len([]rune(text)) <= 18 {
		return true
	}
	lower := strings.ToLower(text)
	for _, cue := range []string{"继续", "展开", "细说", "具体", "为什么", "怎么", "再说", "接着", "细化", "举例", "继续讲", "往下", "how", "why", "more", "continue"} {
		if strings.Contains(lower, cue) {
			return true
		}
	}
	if len(recent) == 0 {
		return false
	}
	last := recent[len(recent)-1]
	if last.Kind != MsgKindChat || last.AuthorID == "" {
		return false
	}
	return false
}

func pickDebateNeutral(agents []database.AgentRoomMember, recent []database.AgentRoomMessage) string {
	if countRecentDebateExchanges(recent) < 4 {
		return ""
	}
	last := lastAgentSpeaker(recent)
	for _, m := range agents {
		if m.Stance == MemberStanceNeutral && m.ID != last {
			return m.ID
		}
	}
	return ""
}

func countRecentDebateExchanges(recent []database.AgentRoomMessage) int {
	if len(recent) == 0 {
		return 0
	}
	count := 0
	seen := make([]string, 0, 6)
	for i := len(recent) - 1; i >= 0 && count < 6; i-- {
		msg := recent[i]
		if msg.Kind != MsgKindChat || msg.AuthorID == "" {
			continue
		}
		seen = append(seen, msg.AuthorID)
		count++
	}
	if len(seen) < 4 {
		return 0
	}
	sort.Strings(seen)
	unique := 0
	prev := ""
	for _, id := range seen {
		if id != prev {
			unique++
			prev = id
		}
	}
	if unique < 2 {
		return 0
	}
	return count
}

// PickResult 选人结果。
type PickResult struct {
	MemberIDs []string // 本回合应该发言的成员（空 = 无人发言，等下一次触发）
	Rationale string   // 调度解释（debug/日志）
}

// Pick 按策略选发言人。
// 规则（对应 DESIGN.md v0.2 §3.2 + v0.7 扩展）：
//
//	free       — 被 @/指向者优先；否则选一个非人类且非上一说话人的 agent
//	reactive   — 只在被 @ 或 TriggerMsg.MentionIDs 指定时选中
//	roundRobin — 严格按顺序
//	moderator  — 主持人说话 → 由她选；否则只让主持人发一句 orchestrating
//	bidding    — 让所有 agent 先出分（由 orchestrator 打分），最高分者发言
//	observer   — 全员静默
//	parallel   — 一次触发返回多个 agent，上层按 PolicyOptions.ParallelFanout 并行执行
//	debate     — 按成员 Stance 轮转（pro → con → pro → con …），上一说话人立场的对立方优先
func Pick(ctx PickContext) PickResult {
	if ctx.Room == nil {
		return PickResult{}
	}
	// 只读房间：所有 agent 静默，上层不触发任何 LLM 调用；人类仍可发言。
	if ctx.Room.Readonly {
		return PickResult{Rationale: "readonly"}
	}
	agents := filterLiveAgents(ctx.Members)
	if len(agents) == 0 {
		return PickResult{}
	}

	if ctx.ForcedNextID != "" {
		for _, m := range agents {
			if m.ID == ctx.ForcedNextID {
				return PickResult{MemberIDs: []string{m.ID}, Rationale: "forced"}
			}
		}
	}

	policy := ctx.Room.Policy
	if policy == "" {
		policy = PolicyFree
	}

	// @ 指向优先（所有策略都支持显式 @）
	if ctx.TriggerMsg != nil {
		mentionIDs := jsonUnmarshalSlice(ctx.TriggerMsg.MentionIDsJSON)
		if ids := filterAgentIDs(mentionIDs, agents); len(ids) > 0 {
			return PickResult{MemberIDs: ids, Rationale: "mention"}
		}
	}

	switch policy {
	case PolicyObserver:
		return PickResult{}
	case PolicyReactive:
		// reactive 策略：无 @ 则不发言
		return PickResult{}
	case PolicyRoundRobin:
		if len(agents) == 0 {
			return PickResult{}
		}
		idx := ctx.RoundRobinIdx % len(agents)
		if idx < 0 {
			idx = 0
		}
		return PickResult{MemberIDs: []string{agents[idx].ID}, Rationale: "roundRobin"}
	case PolicyModerator:
		moderator := findModerator(agents)
		if ctx.TriggerMsg != nil && ctx.TriggerMsg.AuthorID == moderator {
			// 主持人刚说完 → 让所有 agent 回应（她像 MC）
			others := make([]string, 0, len(agents)-1)
			for _, m := range agents {
				if m.ID != moderator {
					others = append(others, m.ID)
				}
			}
			if len(others) == 0 {
				return PickResult{}
			}
			return PickResult{MemberIDs: others[:1], Rationale: "moderator-dispatch"}
		}
		if moderator != "" {
			return PickResult{MemberIDs: []string{moderator}, Rationale: "moderator-take"}
		}
		// 没主持人则退化到 free
		fallthrough
	case PolicyFree:
		if next := pickFreeNext(agents, ctx.Recent, ctx.TriggerMsg); next != "" {
			return PickResult{MemberIDs: []string{next}, Rationale: "free"}
		}
		return PickResult{MemberIDs: []string{agents[0].ID}, Rationale: "free-fallback"}
	case PolicyBidding:
		// 真正的 bidding 调用由 orchestrator 完成（需 LLM 打分）。
		// 这里返回空，上层据策略分支单独处理。
		return PickResult{Rationale: "bidding-deferred"}
	case PolicyPlanned:
		// planned 策略：executing 阶段由 orchestrator 按队列选 owner，
		// 这里不返回；discussion 阶段退化到类 free + discussion-first 启发，
		// 交给上层 runPlannedDiscussion 处理。
		return PickResult{Rationale: "planned-deferred"}
	case PolicyParallel:
		// 并行策略：返回所有活跃 agent，由 orchestrator 按 PolicyOptions.ParallelFanout
		// 并行执行（上限 = len(agents) 或 fanout，取小）。剔除上一发言人避免 "刚说完又被叫"。
		last := lastAgentSpeaker(ctx.Recent)
		ids := make([]string, 0, len(agents))
		for _, m := range agents {
			if m.ID == last {
				continue
			}
			ids = append(ids, m.ID)
		}
		if len(ids) == 0 {
			// 全部都是上一发言人（单 agent 房间）—— 退化回让那位继续
			ids = []string{agents[0].ID}
		}
		return PickResult{MemberIDs: ids, Rationale: "parallel"}
	case PolicyDebate:
		// 辩论策略：按 Stance 轮转 pro → con → pro → con …；neutral 成员做裁判，
		// 默认不排进对抗（除非 PolicyOptions.IncludeNeutralInDebate）。
		// 上一发言者立场的对立方优先；若对立方无人则退化回 free。
		next := pickDebateNext(agents, ctx.Recent)
		if next != "" {
			return PickResult{MemberIDs: []string{next}, Rationale: "debate"}
		}
		// 两方都缺：退化到 free
		last := lastAgentSpeaker(ctx.Recent)
		candidates := make([]database.AgentRoomMember, 0, len(agents))
		for _, m := range agents {
			if m.ID == last {
				continue
			}
			candidates = append(candidates, m)
		}
		if next := pickLeastRecentlyDominant(candidates, ctx.Recent); next != "" {
			return PickResult{MemberIDs: []string{next}, Rationale: "debate-fallback-free"}
		}
		return PickResult{MemberIDs: []string{agents[0].ID}, Rationale: "debate-fallback-single"}
	}
	return PickResult{}
}

// pickDebateNext 按 Stance 轮转选下一位发言人。
//
//   - 若上一发言者是 pro → 首选 con；反之首选 pro
//   - 若上一发言者是 neutral 或空 → 选 pro（辩论从正方开场最自然）
//   - 所选一方无人 → 返回 ""，上层退化到 free
func pickDebateNext(agents []database.AgentRoomMember, recent []database.AgentRoomMessage) string {
	if neutral := pickDebateNeutral(agents, recent); neutral != "" {
		return neutral
	}
	last := lastAgentSpeaker(recent)
	var lastStance string
	for _, m := range agents {
		if m.ID == last {
			lastStance = m.Stance
			break
		}
	}
	var want string
	switch lastStance {
	case MemberStancePro:
		want = MemberStanceCon
	case MemberStanceCon:
		want = MemberStancePro
	default:
		want = MemberStancePro
	}
	// 在目标立场里找一位不是 last 的
	for _, m := range agents {
		if m.Stance == want && m.ID != last {
			return m.ID
		}
	}
	// 目标立场没找到 → 试试另一方
	alt := MemberStancePro
	if want == MemberStancePro {
		alt = MemberStanceCon
	}
	for _, m := range agents {
		if m.Stance == alt && m.ID != last {
			return m.ID
		}
	}
	return ""
}

// BiddingWinner 选 bidding 中得分最高者。
func BiddingWinner(scores []BiddingScore) string {
	if len(scores) == 0 {
		return ""
	}
	best := scores[0]
	for _, s := range scores[1:] {
		if s.Score > best.Score {
			best = s
		}
	}
	return best.MemberID
}

// ── 辅助 ──

func filterLiveAgents(ms []database.AgentRoomMember) []database.AgentRoomMember {
	out := make([]database.AgentRoomMember, 0, len(ms))
	for _, m := range ms {
		if m.Kind != "agent" || m.IsKicked || m.IsMuted {
			continue
		}
		out = append(out, m)
	}
	return out
}

func findModerator(ms []database.AgentRoomMember) string {
	for _, m := range ms {
		if m.IsModerator {
			return m.ID
		}
	}
	return ""
}

func lastAgentSpeaker(msgs []database.AgentRoomMessage) string {
	for i := len(msgs) - 1; i >= 0; i-- {
		m := msgs[i]
		if m.Kind == MsgKindChat && !strings.HasPrefix(m.AuthorID, "") == false {
			// 上面写反了，保持简单逻辑：取最近一条 chat 消息作者
		}
		if m.Kind == MsgKindChat && m.AuthorID != "" {
			return m.AuthorID
		}
	}
	return ""
}

func filterAgentIDs(ids []string, agents []database.AgentRoomMember) []string {
	valid := make(map[string]bool, len(agents))
	for _, a := range agents {
		valid[a.ID] = true
	}
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		if valid[id] {
			out = append(out, id)
		}
	}
	return out
}
