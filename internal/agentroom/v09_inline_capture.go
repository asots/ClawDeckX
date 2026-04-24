package agentroom

import (
	"regexp"
	"strings"

	"ClawDeckX/internal/database"
	"ClawDeckX/internal/logger"
)

// v0.9 结构化副产物 inline capture —— 让 agent 在自然对话中用 XML-like tag
// 标注"新发现的开放问题 / 风险"，orchestrator 完成一轮发言后自动：
//   1) 从 message content 里提取所有 <open_question> / <risk> tag
//   2) 去重（本房间同文本已有的忽略，同批内重复也忽略）
//   3) 写入 OpenQuestion / Risk 表，作者归属为发言 agent
//   4) 广播 room.question.append / room.risk.append —— 前端面板实时刷新 + 未读绿点
//   5) 把 tag 从正文剥离 —— 用户看到的仍是自然对话
//
// 诱导文本见 PromptPack.StructuredCapture（默认在 prompts.go 的
// defaultStructuredCapturePlain），每轮注入到 extraSys 尾部。
//
// 这条路径和 ExtractOpenQuestions / ExtractRisks 按钮是互补的：
//   - inline capture：agent 当下顺手标，0 成本，自然流；默认开启。
//   - extract 按钮：人手动触发，扫最近 60 条做批量 LLM 抽取，用于"回头补扫"或
//     agent 没配合 tag 时的保底。

var (
	// tag 文本允许多行（(?s)），前后允许空白。
	openQuestionTagRE = regexp.MustCompile(`(?s)<open_question>\s*(.+?)\s*</open_question>`)

	// risk 的 severity 属性可选，允许有无引号 / 单双引号。
	riskTagRE = regexp.MustCompile(
		`(?si)<risk(?:\s+severity\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?\s*>\s*(.+?)\s*</risk>`,
	)
)

// InlineCaptures 是一次发言里提取到的结构化副产物集合 + 剥离 tag 后的正文。
type InlineCaptures struct {
	OpenQuestions []string
	Risks         []InlineRisk
	Cleaned       string // tag 剥离后的正文；上游用这个 overwrite message.content
}

type InlineRisk struct {
	Text     string
	Severity string // "low" | "mid" | "high"
}

// HasAny reports 本次发言里是否捕获到任何副产物。
func (c InlineCaptures) HasAny() bool {
	return len(c.OpenQuestions) > 0 || len(c.Risks) > 0
}

// parseInlineCaptures 从 agent 正文里提取 tag；参数 content 一般是 ParseSoftTags
// 剥过 #confidence / #stance 之后的结果，这里再做一轮剥离。
func parseInlineCaptures(content string) InlineCaptures {
	out := InlineCaptures{Cleaned: content}

	for _, m := range openQuestionTagRE.FindAllStringSubmatch(content, -1) {
		if text := strings.TrimSpace(m[1]); text != "" {
			out.OpenQuestions = append(out.OpenQuestions, text)
		}
	}
	for _, m := range riskTagRE.FindAllStringSubmatch(content, -1) {
		// severity 捕获组三选一（双引号 / 单引号 / 无引号）
		sevRaw := firstNonEmpty(m[1], m[2], m[3])
		text := strings.TrimSpace(m[4])
		if text == "" {
			continue
		}
		out.Risks = append(out.Risks, InlineRisk{
			Text:     text,
			Severity: normalizeRiskSeverity(sevRaw),
		})
	}

	// 正文剥离：先剥 open_question 再剥 risk（顺序不重要，两类 tag 不会嵌套）。
	stripped := openQuestionTagRE.ReplaceAllString(content, "")
	stripped = riskTagRE.ReplaceAllString(stripped, "")
	// tag 往往独占一行或前后有分隔，剥后可能留下一串空行；折叠成最多一个空行。
	stripped = collapseBlankLines(stripped)
	out.Cleaned = strings.TrimSpace(stripped)
	return out
}

// commitInlineCaptures 把 parseInlineCaptures 的结果落库 + 广播。
//
// 错误策略：单条失败只 Debug 日志跳过，不中断。主对话流已经完成，副产物抽取失败
// 不该让用户看到 toast 或消息改错。
func (o *Orchestrator) commitInlineCaptures(caps InlineCaptures, authorID string) {
	if !caps.HasAny() {
		return
	}

	// 同房间现存文本的小写集合，用作一次性去重；避免 agent 重复 tag 同一事项
	// 连续被写多份。大小一般 O(10)，一次 List 足够。
	existingQ := lowercasedSet(o.existingQuestionTexts())
	existingR := lowercasedSet(o.existingRiskTexts())

	// 本批内也去重
	batchSeen := map[string]bool{}

	for _, text := range caps.OpenQuestions {
		key := strings.ToLower(strings.TrimSpace(text))
		if key == "" || batchSeen["q:"+key] || existingQ[key] {
			continue
		}
		batchSeen["q:"+key] = true
		q := &database.AgentRoomOpenQuestion{
			RoomID:     o.roomID,
			Text:       text,
			RaisedByID: authorID,
		}
		if err := o.repo.CreateOpenQuestion(q); err != nil {
			logger.Log.Debug().Err(err).Str("room", o.roomID).Msg("agentroom: inline open_question write failed")
			continue
		}
		o.broker.Emit(o.roomID, "room.question.append", map[string]any{
			"roomId": o.roomID, "question": OpenQuestionFromModel(q),
		})
	}

	for _, rk := range caps.Risks {
		key := strings.ToLower(strings.TrimSpace(rk.Text))
		if key == "" || batchSeen["r:"+key] || existingR[key] {
			continue
		}
		batchSeen["r:"+key] = true
		k := &database.AgentRoomRisk{
			RoomID:   o.roomID,
			Text:     rk.Text,
			Severity: rk.Severity,
			OwnerID:  authorID,
		}
		if err := o.repo.CreateRisk(k); err != nil {
			logger.Log.Debug().Err(err).Str("room", o.roomID).Msg("agentroom: inline risk write failed")
			continue
		}
		o.broker.Emit(o.roomID, "room.risk.append", map[string]any{
			"roomId": o.roomID, "risk": RiskFromModel(k),
		})
	}
}

// existingQuestionTexts / existingRiskTexts —— 去重用的"本房间已有 text"快照。
// 失败返回 nil，调用方把它当空 set 用，去重就失效但不崩。
func (o *Orchestrator) existingQuestionTexts() []string {
	list, err := o.repo.ListOpenQuestions(o.roomID)
	if err != nil {
		return nil
	}
	out := make([]string, 0, len(list))
	for _, q := range list {
		out = append(out, q.Text)
	}
	return out
}
func (o *Orchestrator) existingRiskTexts() []string {
	list, err := o.repo.ListRisks(o.roomID)
	if err != nil {
		return nil
	}
	out := make([]string, 0, len(list))
	for _, k := range list {
		out = append(out, k.Text)
	}
	return out
}

// ── 小工具 ──

func normalizeRiskSeverity(s string) string {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "low", "minor":
		return "low"
	case "high", "critical", "severe":
		return "high"
	default:
		// 空 / "medium" / "middle" / "normal" 等均归一化到 mid —— 前端 UI 枚举。
		return "mid"
	}
}

func firstNonEmpty(ss ...string) string {
	for _, s := range ss {
		if strings.TrimSpace(s) != "" {
			return s
		}
	}
	return ""
}

func lowercasedSet(in []string) map[string]bool {
	out := make(map[string]bool, len(in))
	for _, s := range in {
		key := strings.ToLower(strings.TrimSpace(s))
		if key != "" {
			out[key] = true
		}
	}
	return out
}

// collapseBlankLines 把 3+ 个连续换行折叠成 2 个（保留段落分隔，但避免 tag 剥离
// 在正文中间留大段空行）。
var blankLinesRE = regexp.MustCompile(`\n{3,}`)

func collapseBlankLines(s string) string {
	return blankLinesRE.ReplaceAllString(s, "\n\n")
}
