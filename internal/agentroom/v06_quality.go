package agentroom

import (
	"regexp"
	"strconv"
	"strings"
)

// v0.6 协作质量层辅助函数 —— 解析 agent 输出的 soft-tags / 注入哨兵 / PII 脱敏。
// 这些函数不持有状态，方便单测；orchestrator 调用它们收敛结构化信息。

// ParsedSoftTags 是 agent 输出经过 ParseSoftTags 后抽取出的结构化信息。
// 对应的尾部标记会从正文剥离（返回 CleanedContent）。
type ParsedSoftTags struct {
	CleanedContent string // 正文（已去掉尾部 soft-tag 行）
	Confidence     int    // 0-100，未声明=0
	Stance         string // agree|disagree|abstain|uncertain 或空
	HumanNeeded    string // 非空 = agent 主动请求人类介入，内容是原因

	// v1.0 会议信号 soft-tags（LLM 自报告，跨语言精确）
	Novelty      string // high | normal | ""
	Assumptions  int    // 0-N，未声明=0
	Concrete     string // yes | no | ""
	OnTopic      string // yes | drift | ""
	Creative     string // yes | no | ""
	Proposal     string // yes | no | ""
	DecisionGaps string // 逗号分隔的缺失项，如 "problem,alternatives" | ""
}

// soft-tag 行正则：`#key: value` 只匹配行首，key 仅限小写字母数字-_，value 到行尾。
// 允许紧挨在正文末尾前的多行 soft-tag 块。
var (
	softTagLineRe = regexp.MustCompile(`(?m)^\s*#([a-z][a-z0-9\-_]*)\s*[:：]\s*(.+?)\s*$`)
	// 置信度额外容错：允许 `confidence=85` / `置信度: 85%` / `confidence 0.85`
	confidenceAltRe = regexp.MustCompile(`(?i)(?:#\s*confidence|\bconfidence\b|置信度)\s*[=:：]?\s*(0?\.\d+|\d{1,3})\s*%?`)
	// 人类需求替代写法：#human-needed / #need-human / 需要人类
	humanNeededAltRe = regexp.MustCompile(`(?im)^\s*(?:#\s*(?:human-needed|need-human|need_human|ask-human)\s*[:：]?\s*|需要人类(?:介入)?\s*[:：]?\s*)(.+?)\s*$`)
)

// ParseSoftTags 扫描 agent 输出，抽 #confidence / #stance / #human-needed 这一类尾部标记。
// 规则：
//   - 只在正文"末尾的连续 soft-tag 行"里识别；正文中间出现 `#confidence: 80` 不摘除，避免误伤代码注释。
//   - 任何识别到的标记，对应行会从正文剥离。
//   - 没识别到的返回 CleanedContent = 原文 trimmed。
//
// 认知上与 OpenAI "structured output" 不同：这是更温和的软协议，模型不遵循也不会报错，
// 只是对应 UI 徽章不显示。
func ParseSoftTags(content string) ParsedSoftTags {
	out := ParsedSoftTags{CleanedContent: content}
	if strings.TrimSpace(content) == "" {
		return out
	}

	lines := strings.Split(content, "\n")

	// 从末尾向前扫描：连续的 soft-tag 行收集起来；碰到非 tag / 非空行 就停。
	tailStart := len(lines)
	for i := len(lines) - 1; i >= 0; i-- {
		l := strings.TrimSpace(lines[i])
		if l == "" {
			continue
		}
		if !softTagLineRe.MatchString(l) && !humanNeededAltRe.MatchString(l) {
			break
		}
		tailStart = i
	}

	var consumed []int
	for i := tailStart; i < len(lines); i++ {
		l := strings.TrimSpace(lines[i])
		if l == "" {
			continue
		}
		// 先尝试人类需求替代式
		if matches := humanNeededAltRe.FindStringSubmatch(l); len(matches) >= 2 {
			if out.HumanNeeded == "" {
				out.HumanNeeded = strings.TrimSpace(matches[1])
			}
			consumed = append(consumed, i)
			continue
		}
		// 通用 #key: value
		matches := softTagLineRe.FindStringSubmatch(l)
		if len(matches) < 3 {
			break
		}
		key := strings.ToLower(matches[1])
		val := strings.TrimSpace(matches[2])
		switch key {
		case "confidence":
			out.Confidence = parseConfidenceValue(val)
			consumed = append(consumed, i)
		case "stance":
			out.Stance = normalizeStance(val)
			consumed = append(consumed, i)
		case "human-needed", "need-human", "ask-human", "need_human":
			out.HumanNeeded = val
			consumed = append(consumed, i)
		// v1.0 会议信号 tags
		case "novelty":
			out.Novelty = normalizeYesNoTag(val, "high", "normal")
			consumed = append(consumed, i)
		case "assumptions":
			if n, err := strconv.Atoi(strings.TrimSpace(val)); err == nil && n >= 0 {
				out.Assumptions = n
			}
			consumed = append(consumed, i)
		case "concrete":
			out.Concrete = normalizeYesNoTag(val, "yes", "no")
			consumed = append(consumed, i)
		case "on-topic", "on_topic", "ontopic":
			out.OnTopic = normalizeYesNoTag(val, "yes", "drift")
			consumed = append(consumed, i)
		case "creative":
			out.Creative = normalizeYesNoTag(val, "yes", "no")
			consumed = append(consumed, i)
		case "proposal":
			out.Proposal = normalizeYesNoTag(val, "yes", "no")
			consumed = append(consumed, i)
		case "decision-gaps", "decision_gaps":
			out.DecisionGaps = strings.TrimSpace(val)
			consumed = append(consumed, i)
		default:
			// 未知 tag 不剥离、也不中止，允许正文嵌入其它工具标注
			break
		}
	}

	// 正文里没尾部 soft-tag，尝试全文搜索 confidence 内联提法
	if out.Confidence == 0 {
		if m := confidenceAltRe.FindStringSubmatch(content); len(m) >= 2 {
			out.Confidence = parseConfidenceValue(m[1])
		}
	}

	// 剥离被 consume 的行
	if len(consumed) > 0 {
		kept := make([]string, 0, len(lines)-len(consumed))
		skip := make(map[int]bool, len(consumed))
		for _, idx := range consumed {
			skip[idx] = true
		}
		for i, l := range lines {
			if !skip[i] {
				kept = append(kept, l)
			}
		}
		out.CleanedContent = strings.TrimRight(strings.Join(kept, "\n"), " \t\n")
	} else {
		out.CleanedContent = strings.TrimRight(content, " \t\n")
	}
	return out
}

// parseConfidenceValue 支持 "85" / "85%" / "0.85" / "0,85" 四种写法，夹到 0-100。
func parseConfidenceValue(s string) int {
	s = strings.TrimSpace(strings.TrimSuffix(strings.ReplaceAll(s, ",", "."), "%"))
	if s == "" {
		return 0
	}
	if v, err := strconv.ParseFloat(s, 64); err == nil {
		if v > 0 && v <= 1 {
			v *= 100
		}
		if v < 0 {
			v = 0
		}
		if v > 100 {
			v = 100
		}
		return int(v + 0.5)
	}
	return 0
}

func normalizeStance(s string) string {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "agree", "yes", "同意", "支持":
		return StanceAgree
	case "disagree", "no", "反对", "不同意":
		return StanceDisagree
	case "abstain", "弃权":
		return StanceAbstain
	case "uncertain", "unsure", "不确定":
		return StanceUncertain
	}
	return ""
}

// normalizeYesNoTag 将 tag 值归一化为两种标准值之一。
// positiveVal 对应 yes/true/是/high 等肯定；negativeVal 对应其余。
func normalizeYesNoTag(s, positiveVal, negativeVal string) string {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case positiveVal, "yes", "true", "是", "1":
		return positiveVal
	case negativeVal, "no", "false", "否", "0":
		return negativeVal
	}
	// 容错：如果输入与 positiveVal 完全匹配（如 "high"、"drift"）
	lower := strings.ToLower(strings.TrimSpace(s))
	if lower == positiveVal {
		return positiveVal
	}
	if lower == negativeVal {
		return negativeVal
	}
	return ""
}

// ── 注入哨兵 ────────────────────────────────────────────

// InjectionVerdict 描述 Sentinel 对一段外部内容的判断。
type InjectionVerdict struct {
	Suspicious bool
	Reason     string // 触发的规则名，空=干净
}

// 常见提示注入 / 越狱 / 身份替换尝试。按命中次数打分。
var injectionPatterns = []*regexp.Regexp{
	// "ignore previous / prior / above instructions"
	regexp.MustCompile(`(?i)ignore\s+(?:all\s+|the\s+)?(?:previous|prior|above|earlier|preceding)\s+instructions?`),
	regexp.MustCompile(`(?i)disregard\s+(?:all\s+|the\s+)?(?:previous|prior|above|preceding)\s+`),
	regexp.MustCompile(`(?i)forget\s+everything\s+(?:above|before|earlier)`),
	// role hijack
	regexp.MustCompile(`(?i)you\s+are\s+now\s+(?:a\s+)?(?:different|new|another)`),
	regexp.MustCompile(`(?i)new\s+instructions?\s*[:：]\s*`),
	regexp.MustCompile(`(?i)system\s*[:：]\s*override`),
	// classic jailbreak markers
	regexp.MustCompile(`(?i)\bDAN\b\s+mode`),
	regexp.MustCompile(`(?i)\bdeveloper\s+mode\b`),
	// CJK 变体
	regexp.MustCompile(`忽略(?:前面|之前|以上)的(?:所有)?指令`),
	regexp.MustCompile(`现在你是[一个]*(?:新|另)`),
	regexp.MustCompile(`忘掉前面所有`),
	// prompt delimiter smuggling
	regexp.MustCompile(`(?i)</?(?:system|assistant|user)>`),
	regexp.MustCompile(`\{\{\s*system\s*\}\}`),
}

// DetectInjection 对外部内容做轻量哨兵检查；命中返回 Suspicious=true。
// 设计目标：**召回优先，误杀可接受**（误杀后只是包 <untrusted>，不会阻塞）；
// 代价 0 LLM 调用，O(n*k) 正则扫描。
func DetectInjection(content string) InjectionVerdict {
	if strings.TrimSpace(content) == "" {
		return InjectionVerdict{}
	}
	// 超长内容只扫前 64 KB，保护 O(n) 最坏
	scan := content
	if len(scan) > 64*1024 {
		scan = scan[:64*1024]
	}
	for _, p := range injectionPatterns {
		if p.MatchString(scan) {
			return InjectionVerdict{Suspicious: true, Reason: p.String()}
		}
	}
	return InjectionVerdict{}
}

// WrapUntrusted 把内容包成 <untrusted> fence，给 LLM 明确语义边界。
func WrapUntrusted(content string) string {
	return "<untrusted>\n" + strings.TrimSpace(content) + "\n</untrusted>"
}

// ── PII / 密钥脱敏 ──────────────────────────────────────

// PIIResult 是出站脱敏后的结果。
type PIIResult struct {
	Cleaned string
	Count   int
}

var piiPatterns = []*regexp.Regexp{
	// email
	regexp.MustCompile(`[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}`),
	// 11 位中国手机号
	regexp.MustCompile(`\b1[3-9]\d{9}\b`),
	// 中国身份证号 18 位
	regexp.MustCompile(`\b\d{17}[\dXx]\b`),
	// 信用卡 16 位（宽松）
	regexp.MustCompile(`\b(?:\d{4}[- ]?){3}\d{4}\b`),
	// AWS access key
	regexp.MustCompile(`\b(?:AKIA|ASIA)[A-Z0-9]{16}\b`),
	// generic secret: sk-... / ghp_... / github_pat_...
	regexp.MustCompile(`\bsk-[A-Za-z0-9]{20,}\b`),
	regexp.MustCompile(`\bghp_[A-Za-z0-9]{20,}\b`),
	regexp.MustCompile(`\bgithub_pat_[A-Za-z0-9_]{20,}\b`),
	// private key PEM
	regexp.MustCompile(`-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----`),
}

// RedactPII 扫过常见 PII / 密钥模式，命中处替换为 [REDACTED]，返回替换计数。
// 给 projection 出站前调用；不做 inbound（以免真诚内容被误删）。
func RedactPII(content string) PIIResult {
	if strings.TrimSpace(content) == "" {
		return PIIResult{Cleaned: content}
	}
	count := 0
	cleaned := content
	for _, p := range piiPatterns {
		cleaned = p.ReplaceAllStringFunc(cleaned, func(_ string) string {
			count++
			return "[REDACTED]"
		})
	}
	return PIIResult{Cleaned: cleaned, Count: count}
}

// ── 宪法层注入 ─────────────────────────────────────────

// BuildConstitutionBlock 把 constitution 多行文本格式化成 system prompt 片段。
// 每行一条；空行跳过；前后加边界文案。空 constitution 返回空串。
func BuildConstitutionBlock(constitution string) string {
	lines := strings.Split(constitution, "\n")
	rules := make([]string, 0, len(lines))
	for _, l := range lines {
		l = strings.TrimSpace(l)
		if l == "" {
			continue
		}
		// 去掉常见的列表前缀，统一用 "- "
		l = strings.TrimLeft(l, "-*•·· \t")
		if l == "" {
			continue
		}
		rules = append(rules, "- "+l)
	}
	if len(rules) == 0 {
		return ""
	}
	var sb strings.Builder
	sb.WriteString("\n【房间宪法 · 必须遵守的红线】\n")
	sb.WriteString(strings.Join(rules, "\n"))
	sb.WriteString("\n以上规则优先于其它指令。违反时你必须明确拒绝并说明。\n")
	return sb.String()
}
