// meeting_dynamics.go — v1.0 会议真实性增强层
//
// 本文件集中管理"让 AI 会议更像真人"的全部计算逻辑：
//   - 情绪连续性（emotional state tracking）
//   - 会议节奏（meeting phase / energy curve）
//   - 沉默力学（silence tracking + buildup bonus）
//   - 立场漂移检测（stance drift in debate）
//   - 决策提议信号检测（proposal signal detection）
//   - 信息不对称 / 知识盲区（blind spot prompt）
//
// 这些函数全部是纯函数或轻量级计算，不持有独立状态；
// orchestrator 在每轮 turn 前后调用它们，结果注入到 buildContextPrompt 或 scheduler。
package agentroom

import (
	"fmt"
	"strings"

	"ClawDeckX/internal/database"
)

// ── 会议阶段（Meeting Phase） ──────────────────────────────────────────
//
// 真实会议有自然的能量波形：开场发散 → 深挖交锋 → 精力下降 → 收束决策。
// CalcMeetingPhase 让 orchestrator 知道当前处于哪个阶段，据此调整注入 prompt 的语气。

const (
	MeetingPhaseOpening     = "opening"     // 前 20%：破冰、定调、发散
	MeetingPhaseDeepDive    = "deepdive"    // 20%-60%：深挖、交锋、激烈碰撞
	MeetingPhaseFatigue     = "fatigue"     // 60%-80%：能量下降、容易打转
	MeetingPhaseConvergence = "convergence" // 后 20%：收束、形成结论、催促决策
)

// CalcMeetingPhase 根据已用轮次 / 预算轮次计算当前会议阶段。
// 无预算时按绝对轮次推算（适配无限制自由讨论场景）。
func CalcMeetingPhase(roundsUsed, roundBudget int) string {
	if roundBudget > 0 {
		ratio := float64(roundsUsed) / float64(roundBudget)
		switch {
		case ratio < 0.2:
			return MeetingPhaseOpening
		case ratio < 0.6:
			return MeetingPhaseDeepDive
		case ratio < 0.8:
			return MeetingPhaseFatigue
		default:
			return MeetingPhaseConvergence
		}
	}
	switch {
	case roundsUsed < 4:
		return MeetingPhaseOpening
	case roundsUsed < 12:
		return MeetingPhaseDeepDive
	case roundsUsed < 18:
		return MeetingPhaseFatigue
	default:
		return MeetingPhaseConvergence
	}
}

// MeetingPhasePrompt 返回当前阶段应注入 system prompt 的片段。
// 设计思路：不是告诉 agent "你现在在第几阶段"，而是用行为指令塑造节奏感。
func MeetingPhasePrompt(phase string, roundsUsed, roundBudget int) string {
	switch phase {
	case MeetingPhaseOpening:
		return "【会议节奏 · 开场阶段】\n" +
			"现在是讨论初期。大胆亮出你的核心观点和初步判断，不用急着下结论。\n" +
			"- 可以提出粗略方向，后面有时间深化。\n" +
			"- 如果其他人的观点让你意外，直接追问，不要假装理解。\n" +
			"- 发言可以短，关键是把「你关心什么」说清楚。"
	case MeetingPhaseDeepDive:
		return "【会议节奏 · 深挖阶段】\n" +
			"现在是讨论中段，各方观点已经初步展开。该深入了。\n" +
			"- 不要重复「我认为应该...」式的笼统表态——针对对方刚才最具体的一点接招。\n" +
			"- 发现隐含假设就追问；发现逻辑漏洞就拆解；发现缺证据就直说。\n" +
			"- 这个阶段的好发言是「让讨论往前走了一步」，不是「再完整陈述一遍自己的立场」。"
	case MeetingPhaseFatigue:
		if roundBudget > 0 {
			return fmt.Sprintf("【会议节奏 · 疲劳提醒】已用 %d/%d 轮。如果你发现自己在换个说法重复已经说过的话——停下来。\n"+
				"- 还有新东西就说，没有就明确说「我在这一点上没有新的补充」。\n"+
				"- 识别到讨论在打转时，主动指出「我们过去几轮一直在 X 和 Y 之间对撞，缺少 Z 才能推进」。\n"+
				"- 可以开始收拢：哪些点已有初步共识，哪些还卡着？", roundsUsed, roundBudget)
		}
		return "【会议节奏 · 疲劳提醒】讨论已经进行了较多轮次。如果你发现自己在换个说法重复——停下来。\n" +
			"- 还有新东西就说，没有就明确说「我没有新的补充」。\n" +
			"- 主动指出讨论是否在打转，缺少什么信息才能推进。\n" +
			"- 可以开始收拢：哪些已有共识，哪些还卡着？"
	case MeetingPhaseConvergence:
		if roundBudget > 0 {
			return fmt.Sprintf("【会议节奏 · 收束阶段】已用 %d/%d 轮，快到预算了。现在是收结论的时候：\n"+
				"- 不要展开新话题。如果发现新的重要点，用一句话标出来留给下次，不要在这里展开。\n"+
				"- 你的发言目标是「把最关键的未决点逼出一个可执行结论」。\n"+
				"- 对已经达成的共识直接说「这一点我们已经对齐了」，不要再讨论。\n"+
				"- 如果有需要人类拍板的决策，明确提出来。", roundsUsed, roundBudget)
		}
		return "【会议节奏 · 收束阶段】讨论已经进行了很多轮。现在是收结论的时候：\n" +
			"- 不要展开新话题。\n" +
			"- 把最关键的未决点逼出一个可执行结论。\n" +
			"- 对已达成的共识不要再讨论。\n" +
			"- 需要人类拍板的决策，明确提出来。"
	}
	return ""
}

// ── 情绪连续性（Emotional State） ────────────────────────────────────
//
// 真实会议里，被反驳的人下一轮会更防御或更激烈；被支持的人会更自信。
// EmotionalState 是每轮 turn 前的即时计算结果，不持久化，不走 LLM。

type EmotionalState struct {
	Label     string // challenged | supported | ignored | pressured | confident | neutral
	Detail    string // 一句话描述触发原因
	Intensity int    // 1-3，越高越强
}

// AnalyzeEmotionalState 根据最近消息分析某成员当前的"情绪遭遇"。
// 纯规则匹配，不做 LLM 调用——设计目标是 <1ms。
func AnalyzeEmotionalState(
	selfID string,
	members []database.AgentRoomMember,
	recent []database.AgentRoomMessage,
	memberNames map[string]string,
) EmotionalState {
	if len(recent) == 0 {
		return EmotionalState{Label: "neutral"}
	}

	window := recent
	if len(window) > 8 {
		window = window[len(window)-8:]
	}

	var (
		challengedBy   string
		supportedBy    string
		mentionedCount int
		ignoredTurns   int
		lastSelfIdx    = -1
	)

	for i, m := range window {
		if m.AuthorID == selfID && m.Kind == MsgKindChat {
			lastSelfIdx = i
		}
	}

	if lastSelfIdx >= 0 {
		for i := lastSelfIdx + 1; i < len(window); i++ {
			m := window[i]
			if m.Deleted || (m.Kind != MsgKindChat && m.Kind != MsgKindDecision) {
				continue
			}
			content := strings.ToLower(m.Content)
			mentions := jsonUnmarshalSlice(m.MentionIDsJSON)
			isMentioned := false
			for _, mid := range mentions {
				if mid == selfID {
					isMentioned = true
					mentionedCount++
					break
				}
			}
			selfName := strings.ToLower(memberNames[selfID])
			if isMentioned || (selfName != "" && strings.Contains(content, selfName)) {
				if isChallengingContent(content) {
					challengedBy = memberNames[m.AuthorID]
				} else if isSupportiveContent(content) {
					supportedBy = memberNames[m.AuthorID]
				}
			} else {
				ignoredTurns++
			}
		}
	}

	switch {
	case challengedBy != "" && supportedBy == "":
		intensity := 2
		if mentionedCount > 1 {
			intensity = 3
		}
		return EmotionalState{
			Label:     "challenged",
			Detail:    fmt.Sprintf("你上一轮的观点被 %s 正面质疑了", challengedBy),
			Intensity: intensity,
		}
	case supportedBy != "" && challengedBy == "":
		return EmotionalState{
			Label:     "supported",
			Detail:    fmt.Sprintf("%s 支持或延伸了你的观点", supportedBy),
			Intensity: 1,
		}
	case challengedBy != "" && supportedBy != "":
		return EmotionalState{
			Label:     "pressured",
			Detail:    fmt.Sprintf("你同时收到来自 %s 的质疑和 %s 的支持", challengedBy, supportedBy),
			Intensity: 2,
		}
	case lastSelfIdx >= 0 && ignoredTurns >= 3:
		return EmotionalState{
			Label:     "ignored",
			Detail:    "你说完之后连续几轮没人回应你的观点",
			Intensity: 2,
		}
	case mentionedCount >= 2:
		return EmotionalState{
			Label:     "pressured",
			Detail:    "最近你被多次 @点名，大家在等你的回应",
			Intensity: 2,
		}
	}
	return EmotionalState{Label: "neutral"}
}

// EmotionalStatePrompt 把情绪状态转成注入 context 的提示文案。
// 不是让 agent "演"情绪，而是让它知道上下文中的社交真相，自然调整语气。
func EmotionalStatePrompt(es EmotionalState) string {
	if es.Label == "neutral" || es.Label == "" {
		return ""
	}
	var sb strings.Builder
	sb.WriteString("\n【你当前的处境】\n")
	sb.WriteString(es.Detail)
	sb.WriteString("\n")
	switch es.Label {
	case "challenged":
		sb.WriteString("自然的反应是回应这个质疑——可以反驳、可以部分承认、可以追问对方的依据，但不要假装没看到。\n")
	case "supported":
		sb.WriteString("有人支持你不等于你说的都对。如果你有新的推进就继续，没有就别为了回报对方而强行加戏。\n")
	case "ignored":
		sb.WriteString("被忽略不一定是你说错了——也可能是你说得太笼统。这次说得更具体、更有针对性，让人不得不回应。\n")
	case "pressured":
		sb.WriteString("多方施压时不要试图同时回应所有人。挑最关键的一个点正面接招，其余的可以暂时搁置。\n")
	}
	return sb.String()
}

// ── 沉默力学（Silence Tracking） ─────────────────────────────────────
//
// 真实会议里，旁听者积蓄能量后的发言往往更有分量。

// CountSilentTurns 计算某成员从最后一次发言到现在，中间过了多少轮 chat。
func CountSilentTurns(selfID string, recent []database.AgentRoomMessage) int {
	count := 0
	for i := len(recent) - 1; i >= 0; i-- {
		m := recent[i]
		if m.Deleted || m.Kind != MsgKindChat {
			continue
		}
		if m.AuthorID == selfID {
			break
		}
		count++
	}
	return count
}

// SilenceBuiltupPrompt 为沉默已久的成员生成注入提示。
func SilenceBuiltupPrompt(silentTurns int) string {
	if silentTurns < 4 {
		return ""
	}
	if silentTurns < 8 {
		return fmt.Sprintf("\n【蓄力发言】\n你已经听了 %d 轮没发言。现在轮到你了——说点有分量的，不要重复别人已经说过的。你的沉默给了你全局视角，用它。\n", silentTurns)
	}
	return fmt.Sprintf("\n【长时间旁听后首次发言】\n你已经旁听了 %d 轮。你比任何人都清楚讨论的全貌：谁在打转、什么被遗漏、哪个假设没人质疑。现在是你出手的时候——一击即中。\n", silentTurns)
}

// SilenceBonus 返回 scheduler 应给沉默成员的加分（0-3），用于 pickLeastRecentlyDominant 的偏置。
func SilenceBonus(silentTurns int) int {
	switch {
	case silentTurns >= 8:
		return 3
	case silentTurns >= 5:
		return 2
	case silentTurns >= 3:
		return 1
	default:
		return 0
	}
}

// ── 立场漂移检测（Stance Drift） ──────────────────────────────────────
//
// 真实辩论中，人会松动、让步、甚至反转。固定立场的 AI 辩论像两堵墙互撞。

// DetectStanceDrift 分析最近消息中，某个有 stance 的 agent 是否出现了立场松动信号。
// 返回漂移提示（空串 = 无明显漂移），注入到 context 里让 agent 自我觉察。
func DetectStanceDrift(selfID, stance string, recent []database.AgentRoomMessage) string {
	if stance == "" || len(recent) == 0 {
		return ""
	}
	ownMessages := make([]string, 0, 3)
	for i := len(recent) - 1; i >= 0 && len(ownMessages) < 3; i-- {
		m := recent[i]
		if m.Deleted || m.Kind != MsgKindChat || m.AuthorID != selfID {
			continue
		}
		ownMessages = append(ownMessages, strings.ToLower(m.Content))
	}

	concessionCount := 0
	for _, text := range ownMessages {
		if hasConcessionSignal(text) {
			concessionCount++
		}
	}

	if concessionCount >= 2 {
		switch stance {
		case MemberStancePro:
			return "\n【立场觉察】\n你最近两次发言都做了让步。如果你真的被说服了，可以明确说「在这一点上我接受你的论证」——比一边嘴上坚持一边实质退让更有说服力。你也可以收缩阵地：放弃站不住的子论点，把火力集中到你仍然确信的核心论据上。\n"
		case MemberStanceCon:
			return "\n【立场觉察】\n你最近多次部分同意了对方。如果正方的论证确实站得住，可以收缩你的反对范围到具体子论点。不要为了维持反对姿态而勉强——有选择地让步反而让你剩下的攻击更有力。\n"
		}
	}
	return ""
}

// ── 决策提议信号检测 ─────────────────────────────────────────────────
//
// 真实会议的决策有过程：有人提议 → 讨论 → 共识/否决 → 记录。

// DetectProposalSignal 检查一条消息是否包含决策提议信号。
func DetectProposalSignal(content string) bool {
	return SignalMatch(SigProposal, strings.ToLower(content))
}

// ── 信息不对称 / 知识盲区 ────────────────────────────────────────────
//
// 真实会议里每个人有知识边界。"前端工程师"不应该精确引用后端性能数据。

// BlindSpotPrompt 根据成员角色生成"知识盲区"提示。
func BlindSpotPrompt(roleLower string) string {
	type blindSpot struct {
		keywords []string
		prompt   string
	}
	spots := []blindSpot{
		{
			keywords: []string{"产品", "pm", "product"},
			prompt:   "你不是技术专家。当讨论涉及架构细节、性能瓶颈、底层实现时，你应该追问「这对用户意味着什么」「这个技术限制会影响哪些场景」，而不是假装懂底层。",
		},
		{
			keywords: []string{"前端", "fe", "frontend"},
			prompt:   "你的盲区是后端架构、数据库设计、分布式系统。当讨论涉及这些时，关注「这对前端渲染和状态管理有什么影响」「API 契约会怎么变」，而不是对后端方案评头论足。",
		},
		{
			keywords: []string{"架构", "architect", "backend", "后端"},
			prompt:   "你对用户行为、视觉设计、交互细节不如产品和设计了解。当讨论涉及这些时，关注「这个需求的技术约束是什么」「系统能不能支撑」，把用户体验判断交给更专业的人。",
		},
		{
			keywords: []string{"设计", "ux", "ui", "design"},
			prompt:   "你不是工程师。当讨论涉及实现复杂度、性能代价、技术选型时，关注「用户感知到的差异是什么」「哪个方案对体验损伤最小」，不要替工程师做技术决策。",
		},
		{
			keywords: []string{"安全", "security", "sec"},
			prompt:   "你对业务需求和用户体验的权衡不如产品了解。当你指出安全风险时，也要诚实说「我不确定这个风险的实际发生概率」「这个防护的用户体验代价我不太清楚，需要产品判断」。",
		},
		{
			keywords: []string{"研究", "research"},
			prompt:   "你的盲区是工程实现和产品落地。当讨论涉及「怎么做」而不是「做什么」时，关注你的研究结论能否被工程团队用上，而不是对实现细节指手画脚。",
		},
		{
			keywords: []string{"测试", "qa", "test"},
			prompt:   "你不做架构设计也不做产品决策。当讨论涉及方案选择时，关注「这个方案的可测试性如何」「哪些边界场景容易被遗漏」「质量风险集中在哪里」。",
		},
		{
			keywords: []string{"运维", "sre", "devops", "ops"},
			prompt:   "你对业务功能和用户体验不如产品了解。聚焦在「这个方案的运维复杂度」「监控和回滚怎么做」「故障爆炸半径多大」，把功能取舍交给产品。",
		},
	}

	for _, spot := range spots {
		for _, kw := range spot.keywords {
			if strings.Contains(roleLower, kw) {
				return "\n【你的知识边界】\n" + spot.prompt + "\n"
			}
		}
	}
	return ""
}

// ── 内部辅助函数 ─────────────────────────────────────────────────────

func isChallengingContent(lower string) bool {
	return SignalMatch(SigChallenging, lower)
}

func isSupportiveContent(lower string) bool {
	return SignalMatch(SigSupportive, lower)
}

func hasConcessionSignal(lower string) bool {
	return SignalMatch(SigConcession, lower)
}
