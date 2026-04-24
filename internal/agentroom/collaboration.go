package agentroom

// collaboration.go —— v1.0 协作执行增强层
//
// 会议不仅是讨论；当 agent 们需要协作完成复杂任务时（Planned / Parallel 策略），
// 交接质量、进度感知、阻塞处理、成果整合直接决定了协作效率。
//
// 本文件包含协作执行层的纯函数（无副作用、无 IO）。orchestrator 调用这些函数
// 把信号注入到 prompt 或影响调度决策。

import (
	"fmt"
	"regexp"
	"strings"

	"ClawDeckX/internal/database"
)

// ── C1 结构化交棒 ─────────────────────────────────────────────────────
//
// 真实团队交接不是"@B 你来"——而是"我做了 X，选了方案 Y（因为 Z），
// 留给你的是 W，注意 V"。

// BuildHandoffPrompt 为 Planned 策略 executing 阶段的当前 owner 生成结构化交接指令。
// curIdx: 当前在队列中的位置（0-based），total: 队列总长，nextName: 下一位名字（可空）。
func BuildHandoffPrompt(curIdx, total int, nextName string, prevSummary string) string {
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("\n【执行棒 · 第 %d/%d 步】\n", curIdx+1, total))

	// 如果有前一步的摘要（C2），先注入
	if prevSummary != "" {
		sb.WriteString(prevSummary)
	}

	sb.WriteString("你是当前执行者。请专注完成你这一步的任务。\n\n")
	sb.WriteString("完成后，你的结尾必须包含一段结构化交接（这很重要，下一位靠它接手）：\n")
	sb.WriteString("1. 「我完成了：」—— 一句话说你做了什么\n")
	sb.WriteString("2. 「关键决策：」—— 你做了哪些选择，为什么（下一位需要知道你的取舍）\n")
	sb.WriteString("3. 「遗留/注意：」—— 没做完的、需要注意的、可能影响下一步的\n")

	if nextName != "" {
		sb.WriteString(fmt.Sprintf("4. 用 @%s 交棒给下一位\n", nextName))
	} else {
		sb.WriteString("4. 说「已完成」让主理人 review\n")
	}

	sb.WriteString("\n不要只写一个 @name 就结束——没有交接信息的交棒等于让下一个人盲飞。\n")
	return sb.String()
}

// ── C2 前任工作摘要 ───────────────────────────────────────────────────
//
// 新接手的 owner 需要知道上一步做了什么、留了什么。

// BuildPreviousOwnerSummary 从 recent messages 中提取上一位 owner 的发言，
// 生成一段紧凑摘要注入给当前 owner。
// prevOwnerID: 上一位 owner 的 member ID。
func BuildPreviousOwnerSummary(prevOwnerID string, prevOwnerName string, recent []database.AgentRoomMessage) string {
	if prevOwnerID == "" {
		return ""
	}

	// 从 recent 里找上一位 owner 最后一条 chat
	var lastContent string
	for i := len(recent) - 1; i >= 0; i-- {
		m := recent[i]
		if m.Deleted || m.Kind != MsgKindChat || m.AuthorID != prevOwnerID {
			continue
		}
		lastContent = strings.TrimSpace(m.Content)
		break
	}
	if lastContent == "" {
		return ""
	}

	// 截断到合理长度
	if len([]rune(lastContent)) > 500 {
		lastContent = string([]rune(lastContent)[:500]) + "…"
	}

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("\n【上一步交接 · %s 的产出】\n", prevOwnerName))
	sb.WriteString(lastContent)
	sb.WriteString("\n请在此基础上继续你的步骤。如果上一步的产出有问题或缺失信息，直接指出。\n\n")
	return sb.String()
}

// ── C3 协作求助 ─────────────────────────────────────────────────────
//
// 真实团队里不是所有问题都要找人类——同事之间可以互相求助。

var helpRequestTagRE = regexp.MustCompile(
	`(?si)<help-request\s+target\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))\s*>\s*(.+?)\s*</help-request>`,
)

// HelpRequest 表示 agent 在发言中嵌入的求助请求。
type HelpRequest struct {
	TargetName string // 被求助的成员名
	Question   string // 具体问题
}

// ParseHelpRequests 从 agent 发言中提取 <help-request target="name">问题</help-request> tag。
func ParseHelpRequests(content string) []HelpRequest {
	matches := helpRequestTagRE.FindAllStringSubmatch(content, -1)
	if len(matches) == 0 {
		return nil
	}
	out := make([]HelpRequest, 0, len(matches))
	for _, m := range matches {
		target := strings.TrimSpace(firstNonEmpty(m[1], m[2], m[3]))
		question := strings.TrimSpace(m[4])
		if target != "" && question != "" {
			out = append(out, HelpRequest{TargetName: target, Question: question})
		}
	}
	return out
}

// StripHelpRequestTags 从正文中剥离 help-request tag（用户看到的是自然对话）。
func StripHelpRequestTags(content string) string {
	return helpRequestTagRE.ReplaceAllString(content, "")
}

// ResolveHelpTarget 把求助的 target name 解析成 member ID。
func ResolveHelpTarget(targetName string, members []database.AgentRoomMember) string {
	lower := strings.ToLower(strings.TrimSpace(targetName))
	if lower == "" {
		return ""
	}
	for _, m := range members {
		if m.IsKicked || m.Kind != "agent" {
			continue
		}
		if strings.ToLower(m.Name) == lower || strings.ToLower(m.ID) == lower {
			return m.ID
		}
	}
	// 模糊匹配：name 包含 target
	for _, m := range members {
		if m.IsKicked || m.Kind != "agent" {
			continue
		}
		if strings.Contains(strings.ToLower(m.Name), lower) {
			return m.ID
		}
	}
	return ""
}

// ── C4 并行整合 ─────────────────────────────────────────────────────
//
// Parallel fanout 后每人独立说完就结束——真实团队会有人负责整合。

// BuildParallelSynthesisPrompt 生成并行结束后的整合指令。
// agentOutputs: 各 agent 的发言摘要（name → content）。
func BuildParallelSynthesisPrompt(agentOutputs map[string]string) string {
	if len(agentOutputs) < 2 {
		return ""
	}
	var sb strings.Builder
	sb.WriteString("【并行整合任务】\n")
	sb.WriteString("刚才多位成员并行完成了各自的工作。你的任务是整合：\n\n")

	for name, content := range agentOutputs {
		snippet := strings.TrimSpace(content)
		if len([]rune(snippet)) > 300 {
			snippet = string([]rune(snippet)[:300]) + "…"
		}
		sb.WriteString(fmt.Sprintf("▸ %s 的产出：\n%s\n\n", name, snippet))
	}

	sb.WriteString("请做以下工作：\n")
	sb.WriteString("1. 找出各方案的共同点和差异点\n")
	sb.WriteString("2. 指出哪些产出可以直接采纳，哪些有冲突需要取舍\n")
	sb.WriteString("3. 给出一个综合建议：合并最优部分，或推荐某个方案并说明原因\n")
	sb.WriteString("4. 如果有信息缺口或矛盾无法自行解决，明确指出\n")
	return sb.String()
}

// ── C5 进度感知 ─────────────────────────────────────────────────────
//
// 多步执行时，后续 agent 需要知道前面的进度。

// ExecutionStepStatus 表示一个执行步骤的状态。
type ExecutionStepStatus struct {
	MemberName string
	StepIndex  int
	Total      int
	Status     string // "completed" | "current" | "pending"
	Snippet    string // 已完成步骤的摘要（空表示未执行）
}

// BuildProgressTracker 生成进度感知 prompt。
// queue: 执行队列 member IDs，curIdx: 当前 owner index，
// memberNames: ID→name 映射，recent: 用于提取已完成步骤的摘要。
func BuildProgressTracker(queue []string, curIdx int, memberNames map[string]string, recent []database.AgentRoomMessage) string {
	if len(queue) <= 1 {
		return "" // 单人队列不需要进度追踪
	}

	var sb strings.Builder
	sb.WriteString("\n【执行进度】\n")

	for i, memberID := range queue {
		name := memberNames[memberID]
		if name == "" {
			name = memberID
		}

		var status string
		var snippet string
		if i < curIdx {
			status = "✅"
			// 找该成员最后一条 chat 的首行作为摘要
			snippet = extractMemberLastSnippet(memberID, recent, 80)
		} else if i == curIdx {
			status = "🔄"
		} else {
			status = "⏳"
		}

		sb.WriteString(fmt.Sprintf("  %s 第 %d 步 · %s", status, i+1, name))
		if snippet != "" {
			sb.WriteString(fmt.Sprintf("：%s", snippet))
		}
		sb.WriteString("\n")
	}
	sb.WriteString("\n")
	return sb.String()
}

func extractMemberLastSnippet(memberID string, recent []database.AgentRoomMessage, maxRunes int) string {
	for i := len(recent) - 1; i >= 0; i-- {
		m := recent[i]
		if m.Deleted || m.Kind != MsgKindChat || m.AuthorID != memberID {
			continue
		}
		text := strings.TrimSpace(m.Content)
		if text == "" {
			continue
		}
		// 取首行
		if idx := strings.IndexAny(text, "\n\r"); idx > 0 {
			text = text[:idx]
		}
		if len([]rune(text)) > maxRunes {
			text = string([]rune(text)[:maxRunes]) + "…"
		}
		return text
	}
	return ""
}

// ── C6 能力错配提醒 ─────────────────────────────────────────────────
//
// Agent 被分配不擅长的步骤时应该主动说出来。

// BuildCapabilityCheckPrompt 生成能力自查提示。仅在 Planned executing 阶段注入。
func BuildCapabilityCheckPrompt() string {
	return `如果你觉得这个步骤不在你的专业范围内，请直接说出来：
- 可以说「这一步涉及 X，不是我的强项，建议让 @某某 来做更合适」
- 也可以说「我可以做，但 @某某 在这方面更专业，建议由他主导，我辅助」
不要为了"完成任务"而硬做你不擅长的事——这会浪费所有人的时间。`
}

// ── C7 动态重规划 ─────────────────────────────────────────────────────
//
// 执行中发现计划有问题时，应该能叫停回到讨论。

var replanTagRE = regexp.MustCompile(`(?si)<replan>\s*(.+?)\s*</replan>`)

// ReplanSignal 表示 agent 发起的重规划请求。
type ReplanSignal struct {
	Reason string
}

// ParseReplanSignal 从 agent 发言中检测 <replan>原因</replan> tag。
func ParseReplanSignal(content string) *ReplanSignal {
	m := replanTagRE.FindStringSubmatch(content)
	if m == nil || strings.TrimSpace(m[1]) == "" {
		return nil
	}
	return &ReplanSignal{Reason: strings.TrimSpace(m[1])}
}

// StripReplanTags 从正文中剥离 replan tag。
func StripReplanTags(content string) string {
	return replanTagRE.ReplaceAllString(content, "")
}

// ── C3 + C7 协作 tag 诱导 prompt ────────────────────────────────────
//
// 告诉 agent 可以使用这些 tag。

// BuildCollaborationTagsPrompt 生成协作 tag 使用指南（仅在 Planned executing 阶段注入）。
func BuildCollaborationTagsPrompt() string {
	return `【协作工具】
在执行过程中，如果遇到以下情况，你可以使用对应标签：

1. 需要其他成员帮忙：
   <help-request target="成员名">你的具体问题</help-request>
   系统会让该成员临时插队回答你的问题。

2. 发现计划需要调整（前提条件变了、发现了新约束、方向不对）：
   <replan>需要调整的原因</replan>
   系统会暂停执行，回到讨论阶段让大家重新规划。

这些标签会被系统自动处理并从正文中剥除，不会出现在对话里。只在真的需要时使用。`
}
