package agentroom

import "strings"

// signal_lexicon.go —— 统一多语言信号词注册表。
//
// 设计：
//   - 所有检测关键词集中定义于此文件，不再分散到各检测函数里。
//   - 每个 SignalCategory 有一组按语言组织的信号词。
//   - 检测函数调用 SignalMatch(category, text) 或 SignalAny(category, text)。
//   - 后续新增语言只需在对应 category 的 phrases 切片里追加，零改动检测函数。
//   - 停用词也统一管理。

// ── SignalCategory ──────────────────────────────────────────────────

// SignalCategory 是信号词类别的类型标签。
type SignalCategory string

const (
	// 态度 / 立场类
	SigChallenging SignalCategory = "challenging" // 挑战 / 反对
	SigSupportive  SignalCategory = "supportive"  // 支持 / 同意
	SigAgreement   SignalCategory = "agreement"   // 共识锁定级同意

	// 情绪升级类（D4 专用，比 SigChallenging 更激烈）
	SigEscalation SignalCategory = "escalation"

	// 提议类
	SigProposal SignalCategory = "proposal"

	// 让步 / 部分同意类
	SigConcession SignalCategory = "concession"

	// 创意类
	SigCreativity SignalCategory = "creativity"

	// 具体性类
	SigConcrete SignalCategory = "concrete"

	// 假设类
	SigAssumption   SignalCategory = "assumption"
	SigVerification SignalCategory = "verification"

	// 决策质量要素
	SigProblemDef  SignalCategory = "problem_def"
	SigAlternative SignalCategory = "alternative"
	SigRisk        SignalCategory = "risk"
)

// ── 信号词条目 ──────────────────────────────────────────────────────

// signalEntry 是一条信号词，带语言标签。
type signalEntry struct {
	lang   string // "zh" | "en" | "ja" | "ko" | ... （后续扩展）
	phrase string // 小写匹配串
}

// signalRegistry 是按 category 索引的全局信号词表。
// 只读；init() 时填充，运行时不变。
var signalRegistry = map[SignalCategory][]signalEntry{}

func init() {
	// ── SigChallenging（挑战 / 反对） ──────────────────
	reg(SigChallenging, "zh",
		"不同意", "反对", "不对", "不行", "问题是", "但是", "然而",
		"漏洞", "风险", "忽略了", "没考虑", "过于乐观", "不现实",
		"质疑", "挑战", "反驳", "拆解", "不成立",
	)
	reg(SigChallenging, "en",
		"disagree", "however", "but ", "wrong", "issue",
		"flaw", "risk", "overlooked", "not realistic",
		"challenge", "rebut", "counter",
	)

	// ── SigSupportive（支持 / 同意） ──────────────────
	reg(SigSupportive, "zh",
		"同意", "赞同", "说得对", "好的", "没错", "确实",
		"支持", "附议", "补充一下", "在此基础上",
	)
	reg(SigSupportive, "en",
		"agree", "right", "exactly", "good point",
		"support", "endorse", "build on",
	)

	// ── SigAgreement（共识锁定级同意，D5 专用） ──────
	reg(SigAgreement, "zh",
		"同意", "赞成", "没问题", "可以", "对的",
		"你说得对", "我支持", "我也这么想", "我认同",
		"正确", "没错",
	)
	reg(SigAgreement, "en",
		"good point", "agree", "i support", "makes sense",
		"exactly", "absolutely",
	)

	// ── SigEscalation（情绪升级，D4 专用） ────────────
	reg(SigEscalation, "zh",
		"完全错误", "你搞错了", "你根本不懂", "这是错的",
		"你的逻辑有问题", "站不住脚", "不可能", "荒谬",
		"你忽略了", "你没考虑", "你的前提就不对",
	)
	reg(SigEscalation, "en",
		"that's wrong", "you're wrong", "completely wrong",
		"nonsense", "ridiculous", "flawed",
	)

	// ── SigProposal（决策提议） ────────────────────────
	reg(SigProposal, "zh",
		"我建议", "我提议", "建议我们", "我的提议是",
		"建议记录决策", "建议结论", "我们定下来",
		"决策建议", "可以这样定", "我建议记录",
	)
	reg(SigProposal, "en",
		"i propose", "i suggest", "my proposal",
		"let's decide", "decision proposal",
	)

	// ── SigCreativity（创意 / 跳跃思维） ──────────────
	reg(SigCreativity, "zh",
		"如果换个角度", "另一种可能", "疯狂一点", "大胆假设",
		"反过来想", "换个思路", "不走寻常", "颠覆", "脑洞",
		"跳出", "打破常规", "假设我们", "想象一下",
		"类比", "好比", "就像", "举个例子", "比方说",
		"灵感", "创意", "新思路", "另辟蹊径",
	)
	reg(SigCreativity, "en",
		"what if", "crazy idea", "imagine", "flip it",
		"outside the box", "analogy", "for example",
		"alternative", "unconventional", "wild thought",
		"brainstorm", "pivot", "reframe",
	)

	// ── SigConcrete（具体性证据） ──────────────────────
	reg(SigConcrete, "zh",
		"数据", "数字", "统计", "%", "百分", "用户量", "转化率",
		"比如", "例如", "举个例子", "就像", "类似于", "类比",
		"案例", "场景", "实际上", "我们之前", "上次",
		"代码", "api", "接口", "sql", "函数", "调用",
	)
	reg(SigConcrete, "en",
		"data", "number", "metric", "percentage", "benchmark",
		"for example", "such as", "like when", "case study",
		"in practice", "real world", "scenario",
		"code", "function", "endpoint", "query",
	)

	// ── SigAssumption（未验证假设） ────────────────────
	reg(SigAssumption, "zh",
		"应该会", "肯定会", "大概率", "一般来说",
		"我猜", "我觉得", "估计", "想必", "理论上",
		"可能", "也许", "大概", "说不定",
		"按常理", "一般而言", "通常来说",
	)
	reg(SigAssumption, "en",
		"probably", "likely", "assume", "i think",
		"i guess", "should be", "supposedly",
		"in theory", "generally", "usually",
	)

	// ── SigVerification（验证 / 事实依据） ─────────────
	reg(SigVerification, "zh",
		"数据显示", "根据", "实测", "验证过", "确认过",
		"有证据", "实际上", "事实是", "调查", "实验",
		"测量", "研究表明", "报告显示",
	)
	reg(SigVerification, "en",
		"data shows", "according to", "verified", "confirmed",
		"evidence", "in fact", "research", "measured",
		"study shows", "report",
	)

	// ── SigProblemDef（问题定义） ──────────────────────
	reg(SigProblemDef, "zh",
		"问题是", "核心问题", "需要解决", "痛点", "根因",
	)
	reg(SigProblemDef, "en",
		"the problem", "root cause", "core issue", "need to solve",
	)

	// ── SigAlternative（备选方案） ──────────────────────
	reg(SigAlternative, "zh",
		"方案一", "方案二", "另一种", "或者", "备选",
		"替代方案", "还有一种", "也可以",
	)
	reg(SigAlternative, "en",
		"option a", "option b", "alternatively", "another approach",
		"we could also", "or we can",
	)

	// ── SigConcession（让步 / 部分同意） ──────────────
	reg(SigConcession, "zh",
		"你说得有道理", "这一点我同意", "确实如此", "承认",
		"你说得对", "在这一点上", "部分同意", "有一定道理",
		"我接受", "合理的",
	)
	reg(SigConcession, "en",
		"fair point", "you're right", "i concede", "i agree on",
		"you have a point", "i'll give you that",
	)

	// ── SigRisk（风险识别） ────────────────────────────
	reg(SigRisk, "zh",
		"风险", "代价", "隐患", "可能失败", "最坏情况",
		"副作用", "损失", "如果出问题",
	)
	reg(SigRisk, "en",
		"risk", "downside", "worst case", "trade-off", "tradeoff",
		"side effect", "if it fails",
	)
}

// reg 把一组同语言信号词注册到指定 category。
func reg(cat SignalCategory, lang string, phrases ...string) {
	for _, p := range phrases {
		signalRegistry[cat] = append(signalRegistry[cat], signalEntry{lang: lang, phrase: strings.ToLower(p)})
	}
}

// ── 查询接口 ────────────────────────────────────────────────────────

// SignalMatch 检查 text 是否包含指定 category 的任一信号词。
// text 应已 strings.ToLower() 过。
func SignalMatch(cat SignalCategory, text string) bool {
	for _, e := range signalRegistry[cat] {
		if strings.Contains(text, e.phrase) {
			return true
		}
	}
	return false
}

// SignalMatchExclude 检查 text 是否包含 cat 的信号词，但不包含 excludeCat 的信号词。
// 常见用法：`SignalMatchExclude(SigSupportive, SigChallenging, text)` ——
// "有支持但无挑战" → 纯支持。
func SignalMatchExclude(cat, excludeCat SignalCategory, text string) bool {
	return SignalMatch(cat, text) && !SignalMatch(excludeCat, text)
}

// SignalCount 统计 text 中命中指定 category 的信号词数量。
// 多条不同信号词同时命中则累加（同一条信号词多次出现只算一次）。
func SignalCount(cat SignalCategory, text string) int {
	count := 0
	for _, e := range signalRegistry[cat] {
		if strings.Contains(text, e.phrase) {
			count++
		}
	}
	return count
}

// ── 停用词 ──────────────────────────────────────────────────────────

// stopWords 是关键词提取时过滤的停用词集。
// 后续新增语言在此追加即可。
var stopWords = map[string]bool{
	// 中文
	"的": true, "了": true, "是": true, "在": true, "和": true,
	"与": true, "对": true, "有": true, "不": true, "这": true,
	"那": true, "我": true, "你": true, "他": true, "它": true,
	"们": true, "会": true, "要": true, "能": true, "可以": true,
	// 英文
	"the": true, "a": true, "an": true, "is": true, "are": true,
	"to": true, "and": true, "or": true, "of": true, "in": true,
	"for": true, "on": true, "at": true, "by": true, "with": true,
	"this": true, "that": true, "we": true, "it": true, "be": true,
}

// IsStopWord 检查一个词是否为停用词。
func IsStopWord(word string) bool {
	return stopWords[strings.ToLower(word)]
}
