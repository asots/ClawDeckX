// Package agentroom 实现 AgentRoom 原生多 Agent 会议室（DESIGN.md v0.2）
//
// 架构分层：
//
//	types.go         — API 对外 JSON 形状、常量、辅助转换
//	templates.go     — 10 个官方模板定义
//	repo.go          — GORM 持久层（Room/Member/Message/Task/Fact/Intervention）
//	broker.go        — 事件 bus → WSHub 广播桥
//	budget.go        — token → CNY 成本估算与跟踪
//	scheduler.go     — 发言策略（free / reactive / roundRobin / moderator / bidding）
//	orchestrator.go  — 单房间调度器（状态机 + LLM 调用 + 预算 + 投影）
//	manager.go       — 全局 Manager，负责 lazy 创建/回收 orchestrator
//	projection.go    — R-20 DeckX 自建 HTTP 出站骨架
package agentroom

import (
	"encoding/json"
	"strings"
	"time"

	"ClawDeckX/internal/database"
)

// 房间生命周期状态
const (
	StateDraft    = "draft"
	StateActive   = "active"
	StatePaused   = "paused"
	StateClosed   = "closed"
	StateArchived = "archived"
)

// 发言策略
const (
	PolicyFree       = "free"
	PolicyReactive   = "reactive"
	PolicyRoundRobin = "roundRobin"
	PolicyModerator  = "moderator"
	PolicyBidding    = "bidding"
	PolicyObserver   = "observer"
	// PolicyPlanned：结构化执行。房间有三个阶段——
	//   discussion：像 free 一样自由讨论，但有 discussion-first 启发（未 @ 时争取 ≥2 回合）
	//   executing：按 ExecutionQueue 顺序，一次只一位 owner 发言；其输出中的 @下一人 触发 handoff
	//   review：暂停自动回合，等待人工审阅；人可 /continue-discussion 回到 discussion
	PolicyPlanned = "planned"
	// v0.7+ 新增策略
	// PolicyParallel：一次触发 → N 个 agent 并行独立回复（同一 trigger，互相看不见彼此的本轮输出）。
	//   适合头脑风暴 / 多方案并行评估。后续轮次退化到 free。
	PolicyParallel = "parallel"
	// PolicyDebate：辩论模式。成员分 pro / con / neutral 三方，
	//   调度按 pro → con → (neutral?) 轮转，成员 Stance 注入 system prompt。
	//   没有对立方时退化到 free。
	PolicyDebate = "debate"
)

// 成员立场（AgentRoomMember.Stance）—— 用于 debate 策略 + 评审对抗场景
const (
	MemberStancePro     = "pro"     // 正方 / 支持方
	MemberStanceCon     = "con"     // 反方 / 挑战方
	MemberStanceNeutral = "neutral" // 中立裁判 / 主持
)

// ExecutionPhase 对应 AgentRoom.ExecutionPhase
const (
	PhaseDiscussion = "discussion"
	PhaseExecuting  = "executing"
	PhaseReview     = "review"
)

// 成员状态
const (
	MemberStatusIdle                = "idle"
	MemberStatusThinking            = "thinking"
	MemberStatusSpeaking            = "speaking"
	MemberStatusToolCall            = "tool_call"
	MemberStatusToolRunning         = "tool_running"
	MemberStatusToolWaitingApproval = "tool_waiting_approval"
	MemberStatusMuted               = "muted"
	MemberStatusError               = "error"
	MemberStatusOffline             = "offline"
)

// SanitizeSystemPrompt 清洗用户提交的系统提示词，防越狱 / 防控制字符泛滥。
//   - 去除 \u0000-\u001F 控制字符（保留 \n \t）
//   - 硬上限 4000 字符
//   - 去首尾空白
func SanitizeSystemPrompt(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if r < 0x20 && r != '\n' && r != '\t' {
			continue
		}
		if r == 0x7F { // DEL
			continue
		}
		b.WriteRune(r)
	}
	out := b.String()
	if n := []rune(out); len(n) > 4000 {
		out = string(n[:4000])
	}
	return out
}

// 消息类型
const (
	MsgKindChat          = "chat"
	MsgKindThinking      = "thinking"
	MsgKindTool          = "tool"
	MsgKindToolApproval  = "tool_approval"
	MsgKindWhisper       = "whisper"
	MsgKindSystem        = "system"
	MsgKindError         = "error"
	MsgKindBidding       = "bidding"
	MsgKindProjectionIn  = "projection_in"
	MsgKindProjectionOut = "projection_out"
	MsgKindImpersonating = "impersonating"
	MsgKindIntervention  = "intervention"
	MsgKindCheckpoint    = "checkpoint"
	// v0.6
	MsgKindDecision    = "decision"     // 决策锚（普通 message promote 或独立创建）
	MsgKindArtifactRef = "artifact_ref" // 引用一个持久化 artifact 的轻量消息（点开跳 ArtifactsPanel）
	MsgKindMinutes     = "minutes"      // 会议纪要（closing agent 产出）
	MsgKindUntrusted   = "untrusted"    // 被哨兵隔离的外部内容
	MsgKindCritique    = "critique"     // 自我批判 agent 回复
	MsgKindSummary     = "summary"      // "while you were away" / 手动摘要
)

// 立场常量（Message.Stance）
const (
	StanceAgree     = "agree"
	StanceDisagree  = "disagree"
	StanceAbstain   = "abstain"
	StanceUncertain = "uncertain"
)

// ── JSON DTOs ──

type RoomBudget struct {
	LimitCNY   float64 `json:"limitCNY"`
	UsedCNY    float64 `json:"usedCNY"`
	TokensUsed int64   `json:"tokensUsed"`
	WarnAt     float64 `json:"warnAt"`
	HardStopAt float64 `json:"hardStopAt"`
}

// PolicyOptions —— v0.7+ 房间级"全部调参"单一入口。
//
// 设计原则：
//  1. 所有字段都是"0 值 = 用默认"，accessor 方法负责回退。
//  2. 前端 UI 可以逐项留空（传 0）或一键应用 preset（见 PRESETS）。
//  3. 任何 orchestrator 里之前是硬编码的常量，现在都对应这里的一个字段。
//     想调参的不用改代码、不用重启；PATCH 房间即可。
type PolicyOptions struct {
	// ── 基础 / 发言顺序 ──
	RoundRobinOrder     []string `json:"roundRobinOrder,omitempty"`
	SilenceKickSec      int      `json:"silenceKickSec,omitempty"`
	ReactiveMentionOnly bool     `json:"reactiveMentionOnly,omitempty"`

	// ── 阈值 / 数值 ──
	BiddingThreshold       float64 `json:"biddingThreshold,omitempty"`       // bidding 策略抢麦阈值，默认 5.0
	InterjectionThreshold  float64 `json:"interjectionThreshold,omitempty"`  // ActiveInterjection 抢麦阈值，默认 6.0
	MaxConsecutive         int     `json:"maxConsecutive,omitempty"`         // 一次触发最多连续 agent 发言数，默认 8
	ParallelFanout         int     `json:"parallelFanout,omitempty"`         // parallel 策略 fanout 数，<=0 取 min(3, N-1)
	DebateRounds           int     `json:"debateRounds,omitempty"`           // debate 策略轮数，<=0 取 min(4, N)
	IncludeNeutralInDebate bool    `json:"includeNeutralInDebate,omitempty"` // debate 是否把 neutral 也轮转

	// ── 功能开关 ──
	ActiveInterjection bool `json:"activeInterjection,omitempty"` // free/moderator/reactive 上叠加主动抢麦
	// ConflictMode —— v0.8 真实会议驱动：在每轮 agent system prompt 尾部注入一段推动词，
	// 对抗"AI 礼貌点头型会议"。取值：
	//   ""        空 = 不注入（闲聊、接龙等轻量场景默认）
	//   "review"  评审挑战：允许部分同意，但每轮必须带新视角/风险
	//   "debate"  硬对抗：必须带具体反驳/证据/新论点；禁止点头式同意
	// debate policy 的 pro/con/neutral 成员会根据 stance 自动选更强的对抗提示；
	// 其它 policy 靠本字段统一注入，避免在每个模板成员里复制粘贴相同推动词。
	ConflictMode string `json:"conflictMode,omitempty"`
	// MeetingStyle —— 房间整体会风标签，用于前端预设和后端轻量提示。
	MeetingStyle string `json:"meetingStyle,omitempty"`
	// DefaultDispatchMode —— v1.0+ 任务派发默认模式（呼应 G4 / D4）。
	// 取值：member_agent | subagent。空 = 让 dispatch UI 自己决定（manual 不在此预设）。
	// 模板创建房间时 handler 会从 Template.DefaultDispatchMode 写入；
	// 房间调参向导也可以单独修改。前端 dispatch 弹窗读它做默认勾选。
	DefaultDispatchMode string `json:"defaultDispatchMode,omitempty"`
	// RelationshipMode —— 角色关系网络基调：balanced | collaborative | adversarial | review | command
	RelationshipMode string `json:"relationshipMode,omitempty"`
	// 关系/节奏强度（0 = 默认）
	RelationshipTension   int `json:"relationshipTension,omitempty"`
	ModeratorIntervention int `json:"moderatorIntervention,omitempty"`
	JudgeIntervention     int `json:"judgeIntervention,omitempty"`
	ConsecutivePenalty    int `json:"consecutivePenalty,omitempty"`
	RepetitionPenalty     int `json:"repetitionPenalty,omitempty"`
	TopicStallPenalty     int `json:"topicStallPenalty,omitempty"`
	TopicFatigueThreshold int `json:"topicFatigueThreshold,omitempty"`
	ContinuationBias      int `json:"continuationBias,omitempty"`
	InterruptionBias      int `json:"interruptionBias,omitempty"`
	ClosureBias           int `json:"closureBias,omitempty"`
	ResponseLength        int `json:"responseLength,omitempty"`
	Directness            int `json:"directness,omitempty"`
	EvidenceBias          int `json:"evidenceBias,omitempty"`
	NoveltyBias           int `json:"noveltyBias,omitempty"`

	// ── 会议健康度检测 ──
	// v1.0 信号系统：检测会议病理（僵局、遗忘人类、升级、空转等）并注入系统消息。
	// 以下字段控制阈值和开关；全部 <= 0 时使用内置默认值。
	DisableHealthCheck      bool   `json:"disableHealthCheck,omitempty"`      // 全局禁用所有健康检测信号
	HealthCheckBudget       int    `json:"healthCheckBudget,omitempty"`       // 单轮最多注入几条信号消息，默认 2
	HumanForgottenThreshold int    `json:"humanForgottenThreshold,omitempty"` // D2: 连续多少轮 agent 发言后提醒人类，默认 6
	EscalationThreshold     int    `json:"escalationThreshold,omitempty"`     // D4: 连续几轮挑战性语气触发降温，默认 3
	MetaReflectionThreshold int    `json:"metaReflectionThreshold,omitempty"` // D8: 多少轮无产出后触发反思，默认 10
	DeadlineAction          string `json:"deadlineAction,omitempty"`          // 到达 RoundBudget 时的行为: "remind"(默认) | "pause" | "summarize"

	// ── 上下文压缩（旧"硬编码常量"） ──
	ContextTailWindow     int `json:"contextTailWindow,omitempty"`     // tail 窗口默认 20（base>1500 降 12，>2500 降 8）
	ContextHighlightsCap  int `json:"contextHighlightsCap,omitempty"`  // 要点回顾最大条数，默认 8
	ContextTokenSoftLimit int `json:"contextTokenSoftLimit,omitempty"` // token 软顶，默认 6000
	ContextRuneHardLimit  int `json:"contextRuneHardLimit,omitempty"`  // rune 硬截阈值，默认 14000
	ContextKeepHumanMaxN  int `json:"contextKeepHumanMaxN,omitempty"`  // 人类消息"全收"阈值，默认 3
	ContextBasePromoteT1  int `json:"contextBasePromoteT1,omitempty"`  // tail 自适应第一档 token，默认 1500
	ContextBasePromoteT2  int `json:"contextBasePromoteT2,omitempty"`  // tail 自适应第二档 token，默认 2500
	ContextTailMed        int `json:"contextTailMed,omitempty"`        // 第一档降到多少，默认 12
	ContextTailSmall      int `json:"contextTailSmall,omitempty"`      // 第二档降到多少，默认 8

	// ── 人设 / 文案模板 ──
	// 全部允许 nil；nil = 用 DefaultPromptPack()。前端"恢复默认"=传 nil 过来。
	Prompts *PromptPack `json:"prompts,omitempty"`

	// ── preset 标记（仅记录用户最近应用的 preset 名，方便 UI 回显） ──
	PresetID string `json:"presetId,omitempty"`
}

// PromptPack —— 注入到每轮 system prompt 的可编辑文案模板。
//
// 模板语法：Go text/template，占位变量见各字段注释。
// 留空字符串 = 该段用默认模板（见 DefaultPromptPack()）。
type PromptPack struct {
	StancePro           string `json:"stancePro,omitempty"`           // debate 正方职责，无变量
	StanceCon           string `json:"stanceCon,omitempty"`           // debate 反方职责，无变量
	StanceNeutral       string `json:"stanceNeutral,omitempty"`       // debate 中立职责，无变量
	AgendaProtocol      string `json:"agendaProtocol,omitempty"`      // {{.AgendaTitle}} {{.AgendaDesc}} {{.TargetOutcome}}
	RelayContinuation   string `json:"relayContinuation,omitempty"`   // {{.PrevAgentName}} {{.PrevAgentSnippet}}
	BiddingScorer       string `json:"biddingScorer,omitempty"`       // {{.MemberName}} {{.MemberRole}} {{.RecentSummary}}
	InterjectionNotice  string `json:"interjectionNotice,omitempty"`  // {{.Name}} {{.Reason}}
	DebateRoundNotice   string `json:"debateRoundNotice,omitempty"`   // {{.Round}} {{.TotalRounds}}
	ParallelStartNotice string `json:"parallelStartNotice,omitempty"` // {{.Fanout}}
	DebateEndNotice     string `json:"debateEndNotice,omitempty"`     // 无变量

	// v0.8 通用冲突驱动后缀。orchestrator 在 agent 回合时根据 ConflictMode 选一个附加到 extraSys 尾部，
	// 让所有场景（不只 debate）都能避免"礼貌点头式会议"。留空表示走 DefaultPromptPack 的默认文案。
	//   - ConflictDrive：硬对抗模式，要求成员必须带具体反驳/新论据，禁止泛泛同意
	//   - ReviewChallenge：评审挑战模式，允许部分同意，但每轮必须带 1 条【新视角或风险】
	ConflictDrive   string `json:"conflictDrive,omitempty"`   // 无变量
	ReviewChallenge string `json:"reviewChallenge,omitempty"` // 无变量

	// v0.9 结构化副产物诱导：注入到 extraSys 尾部，告诉 agent 可以在回复里用
	//   <open_question>…</open_question>
	//   <risk severity="low|mid|high">…</risk>
	// tag 沉淀讨论中出现的开放问题 / 风险。orchestrator.runAgentTurn 完成后会
	// 自动解析这些 tag、落库、广播 room.question.append / room.risk.append，并
	// 从正文里剥除 —— 让"产生一条开放问题/风险"从"用户手工点按钮"降级为"agent
	// 顺手标注"。留空表示走 DefaultPromptPack 的默认文案。
	StructuredCapture string `json:"structuredCapture,omitempty"` // 无变量

	// v1.0 会议信号 soft-tag 指令：注入到 extraSys 尾部，告诉 agent 在发言末尾
	// 输出结构化标签（#stance / #novelty / #concrete 等），orchestrator 自动解析。
	// 这些标签是跨语言精确检测的基础——不管 agent 用什么语言讨论，标签名是固定英文 key。
	SoftTagInstruction string `json:"softTagInstruction,omitempty"` // 无变量

	// v1.0 会议真实性增强：三条核心反 AI 味 prompt。
	// 注入到 extraSys 尾部，让 agent 的行为更像真人开会。
	UncertaintyEncouragement string `json:"uncertaintyEncouragement,omitempty"` // 无变量：鼓励说"我不确定"
	PartialAgreement         string `json:"partialAgreement,omitempty"`         // 无变量：精细化回应，部分同意部分反对
	SelfCorrection           string `json:"selfCorrection,omitempty"`           // 无变量：允许中途自我修正

	// v1.0 协作执行增强：并行整合指令。
	// Parallel fanout 结束后，整合者收到此 prompt 指引。
	// 变量：{{.AgentSummaries}} —— 各 agent 产出摘要。
	ParallelSynthesis string `json:"parallelSynthesis,omitempty"`

	// ── v1.0 会议节奏控制系统 prompt ──────────────────────────────────
	// 以下字段将原来散落在 meeting_dynamics / meeting_health / collaboration
	// 中的硬编码提示词统一纳入 PromptPack，使其可被用户自定义和未来 i18n。
	// 留空 = 使用 DefaultPromptPack 的默认值。

	// 会议节奏 · 阶段提示（meeting_dynamics §5）
	// 变量：{{.RoundsUsed}} {{.RoundBudget}}
	PhaseOpening     string `json:"phaseOpening,omitempty"`
	PhaseDeepDive    string `json:"phaseDeepDive,omitempty"`
	PhaseFatigue     string `json:"phaseFatigue,omitempty"`
	PhaseConvergence string `json:"phaseConvergence,omitempty"`

	// 情绪连续性（meeting_dynamics §1）
	// 变量：{{.Supporters}} {{.Challengers}} {{.Label}}
	EmotionSupported  string `json:"emotionSupported,omitempty"`
	EmotionChallenged string `json:"emotionChallenged,omitempty"`
	EmotionMixed      string `json:"emotionMixed,omitempty"`

	// 沉默力学（meeting_dynamics §4）
	SilenceBuildup string `json:"silenceBuildup,omitempty"` // 无变量

	// 知识盲区（meeting_dynamics §3）—— 使用现有 BlindSpotPrompt 逻辑，此字段为全局后缀
	BlindSpotSuffix string `json:"blindSpotSuffix,omitempty"`

	// 会议健康度 · 系统消息模板（meeting_health D1-D8）
	// 变量：各自不同，见注释
	DeadlockIntervention string `json:"deadlockIntervention,omitempty"` // {{.NameA}} {{.NameB}}
	HumanForgotten       string `json:"humanForgotten,omitempty"`       // {{.HumanName}} {{.Rounds}}
	MonopolizerWarning   string `json:"monopolizerWarning,omitempty"`   // 无变量
	EscalationCooldown   string `json:"escalationCooldown,omitempty"`   // {{.Rounds}}
	ConsensusLock        string `json:"consensusLock,omitempty"`        // {{.Count}} {{.Snippet}}
	CommitmentReminder   string `json:"commitmentReminder,omitempty"`   // {{.Names}}
	MetaReflection       string `json:"metaReflection,omitempty"`       // {{.RoundsUsed}}
	ProposalNotice       string `json:"proposalNotice,omitempty"`       // {{.ProposerName}}

	// 协作执行 · prompt（collaboration C1-C7）
	HandoffPrompt     string `json:"handoffPrompt,omitempty"`     // {{.Step}} {{.Total}} {{.NextName}} {{.PrevSummary}}
	CapabilityCheck   string `json:"capabilityCheck,omitempty"`   // 无变量
	CollaborationTags string `json:"collaborationTags,omitempty"` // 无变量

	// ── v1.0 会议氛围个性化引擎（T1-T6）────────────────────────────────

	// T1 氛围语气指令：全局语气基调，每轮注入。
	// 由 Preset 自动配置，用户也可自定义。留空 = 不注入语气指令。
	ToneDirective string `json:"toneDirective,omitempty"` // 无变量

	// T2 发言长度引导：pre-turn 注入，引导 agent 控制发言篇幅。
	// 变量：{{.Phase}} {{.Policy}}
	LengthGuidance string `json:"lengthGuidance,omitempty"`

	// T3 创意激发提示：检测到讨论保守/同质化时注入。
	CreativityBoost string `json:"creativityBoost,omitempty"` // 无变量

	// T4 群体思维警告：连续多人同意时注入批判性思考提醒。
	// 变量：{{.Rounds}}
	GroupthinkAlert string `json:"groupthinkAlert,omitempty"`

	// T5 类比叙事引导：检测到纯抽象讨论时鼓励举例/类比/故事。
	AnalogyCue string `json:"analogyCue,omitempty"` // 无变量

	// T6 话题锚定：检测到跑题时拉回主线。
	// 变量：{{.Goal}}
	TopicAnchor string `json:"topicAnchor,omitempty"`

	// ── v1.0 真实世界增强层（R1-R6）──────────────────────────

	// R1 突破势能：检测到新角度/新概念时，鼓励全员跟进。
	// 变量：{{.AuthorName}} {{.Snippet}}
	BreakthroughMomentum string `json:"breakthroughMomentum,omitempty"`

	// R2 少数派保护：1人反对多人同意时，保护少数派声音。
	// 变量：{{.MinorityName}}
	MinorityVoice string `json:"minorityVoice,omitempty"`

	// R3 假设追踪：检测到大量未验证假设时提醒。
	// 变量：{{.Count}}
	AssumptionChallenge string `json:"assumptionChallenge,omitempty"`

	// R4 决策质量门：提议前缺少必要前置条件时提醒。
	// 变量：{{.MissingItems}}
	DecisionGate string `json:"decisionGate,omitempty"`

	// R5 紧迫感升级：预算临门时注入。
	// 变量：{{.RoundsUsed}} {{.RoundBudget}} {{.Remaining}}
	UrgencyMild     string `json:"urgencyMild,omitempty"`     // level 1: 75%+ 消耗
	UrgencyCritical string `json:"urgencyCritical,omitempty"` // level 2: 90%+ 消耗

	// R6 复读他人检测：post-turn 检测到复读时提醒。
	// 变量：{{.SpeakerName}} {{.EchoedName}}
	EchoWarning string `json:"echoWarning,omitempty"`
}

type RoleInteractionProfile struct {
	RelationshipMode string   `json:"relationshipMode,omitempty"`
	PreferredTargets []string `json:"preferredTargets,omitempty"`
	CounterTargets   []string `json:"counterTargets,omitempty"`
	SupportTargets   []string `json:"supportTargets,omitempty"`
	ChallengeStyle   string   `json:"challengeStyle,omitempty"`
	ClosureStyle     string   `json:"closureStyle,omitempty"`
	Notes            string   `json:"notes,omitempty"`
}

type RoleProfile struct {
	ID                 string                  `json:"id"`
	OwnerUserID        uint                    `json:"ownerUserId,omitempty"`
	Slug               string                  `json:"slug,omitempty"`
	Name               string                  `json:"name"`
	Role               string                  `json:"role"`
	Emoji              string                  `json:"emoji,omitempty"`
	Description        string                  `json:"description,omitempty"`
	Category           string                  `json:"category,omitempty"`
	SystemPrompt       string                  `json:"systemPrompt,omitempty"`
	StylePrompt        string                  `json:"stylePrompt,omitempty"`
	Model              string                  `json:"model,omitempty"`
	AgentID            string                  `json:"agentId,omitempty"`
	Thinking           string                  `json:"thinking,omitempty"`
	MemoryKey          string                  `json:"memoryKey,omitempty"`
	IsModerator        bool                    `json:"isModerator,omitempty"`
	Stance             string                  `json:"stance,omitempty"`
	InteractionProfile *RoleInteractionProfile `json:"interactionProfile,omitempty"`
	Builtin            bool                    `json:"builtin,omitempty"`
	Visibility         string                  `json:"visibility,omitempty"`
	SortOrder          int                     `json:"sortOrder,omitempty"`
	CreatedAt          int64                   `json:"createdAt,omitempty"`
	UpdatedAt          int64                   `json:"updatedAt,omitempty"`
}

// ── Defaults / Accessors ───────────────────────────────────────────────
// 每个硬编码常量都在这里统一定义，方便未来做全局 config 覆盖。

const (
	defaultBiddingThreshold      = 5.0
	defaultInterjectionThreshold = 6.0
	// defaultMaxConsecutive —— 一次人类触发后允许连续跑的 agent 轮数上限。
	// v0.8 调整（8 → 20）：真实会议/评审里一个议题往往需要 15~25 轮交锋才能谈透；
	// 8 轮太容易让会议"两三下就冷场"。到上限后 orchestrator 并不暂停房间，只是
	// 让给人类（appendSystemNotice + 等触发）。配合 /continue 命令可以一键续轮。
	defaultMaxConsecutive = 20
	// defaultDebateRounds —— 辩论模式一次触发里 pro/con 轮转的总轮数（不含启动回合）。
	// v0.8 新增常量化（原代码硬编码 4）：4 轮连正反方各自陈述一次都不够，10 轮才能形成
	// 起论 → 反驳 → 再反驳 → 裁判插入 的真实节奏。仍受 MaxConsecutive 二次兜底。
	defaultDebateRounds          = 10
	defaultContextTailWindow     = 20
	defaultContextHighlightsCap  = 8
	defaultContextTokenSoftLimit = 6000
	defaultContextRuneHardLimit  = 14000
	defaultContextKeepHumanMaxN  = 3
	defaultContextBasePromoteT1  = 1500
	defaultContextBasePromoteT2  = 2500
	defaultContextTailMed        = 12
	defaultContextTailSmall      = 8
)

// GetXxx helpers —— PolicyOptions 为 nil 时也返回默认值，orchestrator 里可以无脑 opts.GetXxx()。

func (p *PolicyOptions) GetBiddingThreshold() float64 {
	if p != nil && p.BiddingThreshold > 0 {
		return p.BiddingThreshold
	}
	return defaultBiddingThreshold
}
func (p *PolicyOptions) GetInterjectionThreshold() float64 {
	if p != nil && p.InterjectionThreshold > 0 {
		return p.InterjectionThreshold
	}
	return defaultInterjectionThreshold
}
func (p *PolicyOptions) GetMaxConsecutive() int {
	if p != nil && p.MaxConsecutive > 0 {
		return p.MaxConsecutive
	}
	return defaultMaxConsecutive
}
func (p *PolicyOptions) GetContextTailWindow() int {
	if p != nil && p.ContextTailWindow > 0 {
		return p.ContextTailWindow
	}
	return defaultContextTailWindow
}
func (p *PolicyOptions) GetContextTailMed() int {
	if p != nil && p.ContextTailMed > 0 {
		return p.ContextTailMed
	}
	return defaultContextTailMed
}
func (p *PolicyOptions) GetContextTailSmall() int {
	if p != nil && p.ContextTailSmall > 0 {
		return p.ContextTailSmall
	}
	return defaultContextTailSmall
}
func (p *PolicyOptions) GetContextBasePromoteT1() int {
	if p != nil && p.ContextBasePromoteT1 > 0 {
		return p.ContextBasePromoteT1
	}
	return defaultContextBasePromoteT1
}
func (p *PolicyOptions) GetContextBasePromoteT2() int {
	if p != nil && p.ContextBasePromoteT2 > 0 {
		return p.ContextBasePromoteT2
	}
	return defaultContextBasePromoteT2
}
func (p *PolicyOptions) GetContextHighlightsCap() int {
	if p != nil && p.ContextHighlightsCap > 0 {
		return p.ContextHighlightsCap
	}
	return defaultContextHighlightsCap
}
func (p *PolicyOptions) GetContextTokenSoftLimit() int {
	if p != nil && p.ContextTokenSoftLimit > 0 {
		return p.ContextTokenSoftLimit
	}
	return defaultContextTokenSoftLimit
}
func (p *PolicyOptions) GetContextRuneHardLimit() int {
	if p != nil && p.ContextRuneHardLimit > 0 {
		return p.ContextRuneHardLimit
	}
	return defaultContextRuneHardLimit
}
func (p *PolicyOptions) GetContextKeepHumanMaxN() int {
	if p != nil && p.ContextKeepHumanMaxN > 0 {
		return p.ContextKeepHumanMaxN
	}
	return defaultContextKeepHumanMaxN
}

// GetPrompts 永远返回非 nil 的 PromptPack —— 字段级 fallback 到默认。
// 这样 orchestrator 里可以直接 pp := opts.GetPrompts(); use pp.StancePro。
func (p *PolicyOptions) GetPrompts() *PromptPack {
	def := DefaultPromptPack()
	if p == nil || p.Prompts == nil {
		return def
	}
	src := p.Prompts
	merged := *def
	if src.StancePro != "" {
		merged.StancePro = src.StancePro
	}
	if src.StanceCon != "" {
		merged.StanceCon = src.StanceCon
	}
	if src.StanceNeutral != "" {
		merged.StanceNeutral = src.StanceNeutral
	}
	if src.AgendaProtocol != "" {
		merged.AgendaProtocol = src.AgendaProtocol
	}
	if src.RelayContinuation != "" {
		merged.RelayContinuation = src.RelayContinuation
	}
	if src.BiddingScorer != "" {
		merged.BiddingScorer = src.BiddingScorer
	}
	if src.InterjectionNotice != "" {
		merged.InterjectionNotice = src.InterjectionNotice
	}
	if src.DebateRoundNotice != "" {
		merged.DebateRoundNotice = src.DebateRoundNotice
	}
	if src.ParallelStartNotice != "" {
		merged.ParallelStartNotice = src.ParallelStartNotice
	}
	if src.DebateEndNotice != "" {
		merged.DebateEndNotice = src.DebateEndNotice
	}
	if src.ConflictDrive != "" {
		merged.ConflictDrive = src.ConflictDrive
	}
	if src.ReviewChallenge != "" {
		merged.ReviewChallenge = src.ReviewChallenge
	}
	if src.StructuredCapture != "" {
		merged.StructuredCapture = src.StructuredCapture
	}
	if src.SoftTagInstruction != "" {
		merged.SoftTagInstruction = src.SoftTagInstruction
	}
	if src.UncertaintyEncouragement != "" {
		merged.UncertaintyEncouragement = src.UncertaintyEncouragement
	}
	if src.PartialAgreement != "" {
		merged.PartialAgreement = src.PartialAgreement
	}
	if src.SelfCorrection != "" {
		merged.SelfCorrection = src.SelfCorrection
	}
	if src.ParallelSynthesis != "" {
		merged.ParallelSynthesis = src.ParallelSynthesis
	}
	// v1.0 会议节奏控制系统 prompt
	if src.PhaseOpening != "" {
		merged.PhaseOpening = src.PhaseOpening
	}
	if src.PhaseDeepDive != "" {
		merged.PhaseDeepDive = src.PhaseDeepDive
	}
	if src.PhaseFatigue != "" {
		merged.PhaseFatigue = src.PhaseFatigue
	}
	if src.PhaseConvergence != "" {
		merged.PhaseConvergence = src.PhaseConvergence
	}
	if src.EmotionSupported != "" {
		merged.EmotionSupported = src.EmotionSupported
	}
	if src.EmotionChallenged != "" {
		merged.EmotionChallenged = src.EmotionChallenged
	}
	if src.EmotionMixed != "" {
		merged.EmotionMixed = src.EmotionMixed
	}
	if src.SilenceBuildup != "" {
		merged.SilenceBuildup = src.SilenceBuildup
	}
	if src.BlindSpotSuffix != "" {
		merged.BlindSpotSuffix = src.BlindSpotSuffix
	}
	if src.DeadlockIntervention != "" {
		merged.DeadlockIntervention = src.DeadlockIntervention
	}
	if src.HumanForgotten != "" {
		merged.HumanForgotten = src.HumanForgotten
	}
	if src.MonopolizerWarning != "" {
		merged.MonopolizerWarning = src.MonopolizerWarning
	}
	if src.EscalationCooldown != "" {
		merged.EscalationCooldown = src.EscalationCooldown
	}
	if src.ConsensusLock != "" {
		merged.ConsensusLock = src.ConsensusLock
	}
	if src.CommitmentReminder != "" {
		merged.CommitmentReminder = src.CommitmentReminder
	}
	if src.MetaReflection != "" {
		merged.MetaReflection = src.MetaReflection
	}
	if src.ProposalNotice != "" {
		merged.ProposalNotice = src.ProposalNotice
	}
	if src.HandoffPrompt != "" {
		merged.HandoffPrompt = src.HandoffPrompt
	}
	if src.CapabilityCheck != "" {
		merged.CapabilityCheck = src.CapabilityCheck
	}
	if src.CollaborationTags != "" {
		merged.CollaborationTags = src.CollaborationTags
	}
	// v1.0 会议氛围个性化引擎
	if src.ToneDirective != "" {
		merged.ToneDirective = src.ToneDirective
	}
	if src.LengthGuidance != "" {
		merged.LengthGuidance = src.LengthGuidance
	}
	if src.CreativityBoost != "" {
		merged.CreativityBoost = src.CreativityBoost
	}
	if src.GroupthinkAlert != "" {
		merged.GroupthinkAlert = src.GroupthinkAlert
	}
	if src.AnalogyCue != "" {
		merged.AnalogyCue = src.AnalogyCue
	}
	if src.TopicAnchor != "" {
		merged.TopicAnchor = src.TopicAnchor
	}
	// v1.0 真实世界增强层
	if src.BreakthroughMomentum != "" {
		merged.BreakthroughMomentum = src.BreakthroughMomentum
	}
	if src.MinorityVoice != "" {
		merged.MinorityVoice = src.MinorityVoice
	}
	if src.AssumptionChallenge != "" {
		merged.AssumptionChallenge = src.AssumptionChallenge
	}
	if src.DecisionGate != "" {
		merged.DecisionGate = src.DecisionGate
	}
	if src.UrgencyMild != "" {
		merged.UrgencyMild = src.UrgencyMild
	}
	if src.UrgencyCritical != "" {
		merged.UrgencyCritical = src.UrgencyCritical
	}
	if src.EchoWarning != "" {
		merged.EchoWarning = src.EchoWarning
	}
	return &merged
}

// GetConflictSuffix 根据 ConflictMode 返回注入到 agent system prompt 尾部的推动词。
// 空串表示不注入（闲聊、接龙等轻量场景默认）。orchestrator.runAgentTurn 调用。
func (p *PolicyOptions) GetConflictSuffix() string {
	if p == nil {
		return ""
	}
	pp := p.GetPrompts()
	switch strings.ToLower(strings.TrimSpace(p.ConflictMode)) {
	case "debate", "adversarial", "hard":
		return pp.ConflictDrive
	case "review", "challenge", "soft":
		return pp.ReviewChallenge
	default:
		return ""
	}
}

type ProjectionTarget struct {
	Platform  string `json:"platform"` // telegram | discord | slack | wework
	ChannelID string `json:"channelId"`
	Label     string `json:"label,omitempty"`
}

type InterRoomBusRoute struct {
	ID            string `json:"id,omitempty"`
	Enabled       bool   `json:"enabled"`
	Trigger       string `json:"trigger,omitempty"`
	DeliveryMode  string `json:"deliveryMode,omitempty"`
	TargetRoomID  string `json:"targetRoomId,omitempty"`
	TitleTemplate string `json:"titleTemplate,omitempty"`
	Note          string `json:"note,omitempty"`
}

type RoomProjection struct {
	Enabled        bool                `json:"enabled"`
	Targets        []ProjectionTarget  `json:"targets"`
	ShowToolCalls  bool                `json:"showToolCalls,omitempty"`
	InboundEnabled bool                `json:"inboundEnabled,omitempty"`
	Style          string              `json:"style,omitempty"` // narrator | verbatim
	BusRoutes      []InterRoomBusRoute `json:"busRoutes,omitempty"`
}

// 对外 Room DTO（含反序列化后的 JSON 字段）
type Room struct {
	ID          string          `json:"id"`
	Title       string          `json:"title"`
	TemplateID  string          `json:"templateId,omitempty"`
	State       string          `json:"state"`
	Policy      string          `json:"policy"`
	PolicyOpts  *PolicyOptions  `json:"policyOptions,omitempty"`
	ModeratorID string          `json:"moderatorId,omitempty"`
	Budget      RoomBudget      `json:"budget"`
	Projection  *RoomProjection `json:"projection,omitempty"`
	Whiteboard  string          `json:"whiteboard,omitempty"`
	// 房间级协作风格（每轮注入 system prompt，不覆盖 agent 自己的 systemPrompt）
	CollaborationStyle string `json:"collaborationStyle,omitempty"`
	// 安全开关（见模型注释）
	Readonly       bool `json:"readonly,omitempty"`
	MutationDryRun bool `json:"mutationDryRun,omitempty"`
	// v0.6 协作质量
	Goal         string `json:"goal,omitempty"`
	RoundBudget  int    `json:"roundBudget,omitempty"`
	RoundsUsed   int    `json:"roundsUsed,omitempty"`
	SelfCritique bool   `json:"selfCritique,omitempty"`
	Constitution string `json:"constitution,omitempty"`
	// v0.4：辅助 LLM 调用的模型（竞言打分、会议纪要、extract-todo 等）。空串 = 跟随全局默认。
	AuxModel string `json:"auxModel,omitempty"`
	// 这四个数组统一**不加 omitempty**，保证前端总能拿到 []，避免 .filter / .map 抛
	// "Cannot read properties of undefined"。后端必须在 RoomFromModel 里保证非 nil。
	Facts     []Fact   `json:"facts"`
	Tasks     []Task   `json:"tasks"`
	MemberIDs []string `json:"memberIds"`
	Tags      []string `json:"tags"`
	// planned policy 执行状态
	ExecutionPhase    string   `json:"executionPhase,omitempty"`
	ExecutionQueue    []string `json:"executionQueue,omitempty"`
	ExecutionOwnerIdx int      `json:"executionOwnerIdx,omitempty"`
	CreatedAt         int64    `json:"createdAt"`
	UpdatedAt         int64    `json:"updatedAt"`
	ClosedAt          *int64   `json:"closedAt,omitempty"`
}

type Member struct {
	ID           string `json:"id"`
	RoomID       string `json:"roomId"`
	Kind         string `json:"kind"`
	Name         string `json:"name"`
	Role         string `json:"role"`
	Emoji        string `json:"emoji,omitempty"`
	AvatarColor  string `json:"avatarColor,omitempty"`
	Model        string `json:"model,omitempty"`
	SystemPrompt string `json:"systemPrompt,omitempty"`
	Status       string `json:"status"`
	IsModerator  bool   `json:"isModerator,omitempty"`
	IsMuted      bool   `json:"isMuted,omitempty"`
	IsKicked     bool   `json:"isKicked,omitempty"`
	// v0.7+ 辩论立场 —— pro | con | neutral | ""（未设置）。
	Stance          string `json:"stance,omitempty"`
	AgentID         string `json:"agentId,omitempty"`
	SessionKey      string `json:"sessionKey,omitempty"`
	Thinking        string `json:"thinking,omitempty"`
	RoleProfileID   string `json:"roleProfileId,omitempty"`
	RoleProfileMode string `json:"roleProfileMode,omitempty"`
	TokenUsage      int64  `json:"tokenUsage"`
	// 上一次 runAgentTurn 的 prompt tokens（近似本轮模型消化的上下文大小），
	// 配合 ContextLimit 算 context pressure = LastPromptTokens / ContextLimit。
	LastPromptTokens int64 `json:"lastPromptTokens,omitempty"`
	// 模型上下文窗口字符数估计（tokens）；0 = 未知（前端退化到不展示压力条）。
	ContextLimit int     `json:"contextLimit,omitempty"`
	CostCNY      float64 `json:"costCNY"`
	CreatedAt    int64   `json:"createdAt"`
}

type Reaction struct {
	Emoji       string   `json:"emoji"`
	ByMemberIDs []string `json:"byMemberIds"`
}

type BiddingScore struct {
	MemberID string  `json:"memberId"`
	Score    float64 `json:"score"`
	Reason   string  `json:"reason,omitempty"`
}

// MessageAttachment —— 与 OpenClaw agent/chat.send RPC 的 attachments 参数同构。
// 前端 Composer 读文件后填充，经 handler → orchestrator → ocbridge 一路传给 OpenClaw。
// OpenClaw 侧 normalizeRpcAttachmentsToChatAttachments 会把它翻译成多模态 content block。
//
// 字段命名严格对齐 OpenClaw：type / mimeType / fileName / content —— 不要用驼峰以外的形式，
// 否则 OpenClaw 反序列化时会按 "additionalProperties" 剔除。
//
// content 是 base64 原文（**不含** "data:image/png;base64," 前缀）；前端 data URL 要先剥掉 prefix 再传。
type MessageAttachment struct {
	Type     string `json:"type"`               // 固定 "image"（将来扩 "file"/"audio" 时再加枚举）
	MimeType string `json:"mimeType"`           // 如 "image/png" / "image/jpeg"
	FileName string `json:"fileName,omitempty"` // 上传时的原始文件名，仅用于 UI 展示
	Content  string `json:"content"`            // base64 原文（无 data URL 前缀）
	Size     int64  `json:"size,omitempty"`     // 可选，仅 UI 展示占位用，不传给上游
}

type Message struct {
	ID          string              `json:"id"`
	Attachments []MessageAttachment `json:"attachments,omitempty"`
	// 占位：保留原始结构的第一个字段命名不动，只把 Attachments 放进 struct；
	// 真实字段仍在后面照原顺序列出（Go 里字段顺序不影响 JSON，但保留排版）。
	RoomID             string         `json:"roomId"`
	Seq                int64          `json:"seq,omitempty"`
	Timestamp          int64          `json:"timestamp"`
	AuthorID           string         `json:"authorId"`
	ActingAsID         string         `json:"actingAsId,omitempty"`
	Kind               string         `json:"kind"`
	Content            string         `json:"content"`
	MentionIDs         []string       `json:"mentionIds,omitempty"`
	ReferenceMessageID string         `json:"referenceMessageId,omitempty"`
	WhisperTargetIDs   []string       `json:"whisperTargetIds,omitempty"`
	ToolName           string         `json:"toolName,omitempty"`
	ToolArgs           map[string]any `json:"toolArgs,omitempty"`
	ToolResult         string         `json:"toolResult,omitempty"`
	ToolStatus         string         `json:"toolStatus,omitempty"`
	BiddingScores      []BiddingScore `json:"biddingScores,omitempty"`
	ProjectionChannel  string         `json:"projectionChannel,omitempty"`
	ExternalSenderName string         `json:"externalSenderName,omitempty"`
	ExternalMessageID  string         `json:"externalMessageId,omitempty"`
	Model              string         `json:"model,omitempty"`
	TokensPrompt       int            `json:"tokensPrompt,omitempty"`
	TokensComplete     int            `json:"tokensComplete,omitempty"`
	Streaming          bool           `json:"streaming,omitempty"`
	Deleted            bool           `json:"deleted,omitempty"`
	ContentEdited      bool           `json:"contentEdited,omitempty"`
	Reactions          []Reaction     `json:"reactions,omitempty"`
	// v0.6 协作质量
	Confidence       int    `json:"confidence,omitempty"`
	Stance           string `json:"stance,omitempty"`
	HumanNeeded      string `json:"humanNeeded,omitempty"`
	Untrusted        bool   `json:"untrusted,omitempty"`
	PiiRedactedCount int    `json:"piiRedactedCount,omitempty"`
	IsDecision       bool   `json:"isDecision,omitempty"`
	DecisionSummary  string `json:"decisionSummary,omitempty"`
	// v0.4：前端乐观插入占位消息时用这个字段匹配后端真实消息，完成去重。
	IdempotencyKey string `json:"idempotencyKey,omitempty"`
}

// v0.6 ──────────────────────────────────────────────────────────

type Artifact struct {
	ID        string `json:"id"`
	RoomID    string `json:"roomId"`
	Title     string `json:"title"`
	Kind      string `json:"kind"`
	Language  string `json:"language,omitempty"`
	Content   string `json:"content"`
	Version   int    `json:"version"`
	AuthorID  string `json:"authorId,omitempty"`
	CreatedAt int64  `json:"createdAt"`
	UpdatedAt int64  `json:"updatedAt"`
}

type Playbook struct {
	ID           string   `json:"id"`
	SourceRoomID string   `json:"sourceRoomId,omitempty"`
	Title        string   `json:"title"`
	Problem      string   `json:"problem"`
	Approach     string   `json:"approach"`
	Conclusion   string   `json:"conclusion"`
	Category     string   `json:"category,omitempty"`
	Tags         []string `json:"tags,omitempty"`
	CreatedAt    int64    `json:"createdAt"`
}

type PersonaMemory struct {
	MemoryKey string `json:"memoryKey"`
	Content   string `json:"content"`
	SizeBytes int64  `json:"sizeBytes"`
	UpdatedAt int64  `json:"updatedAt"`
}

type Fact struct {
	Key       string `json:"key"`
	Value     string `json:"value"`
	AuthorID  string `json:"authorId"`
	UpdatedAt int64  `json:"updatedAt"`
}

// Task —— 工作单 DTO（v0.2 升级，向下兼容）。
//
// 设计：旧字段（id/text/assigneeId/creator/status/dueAt）保持不变；
// 新字段全部 omitempty，UI 可以渐进采用；存量房间任务自动获得"空"新字段
// （reviewerId/deliverable/DoD 等都为空），不影响现有 TasksPanel 行为。
//
// 关键状态机（status × acceptanceStatus）：
//
//	新建：           status=todo,         acceptanceStatus=''
//	派发后（owner）： status=in_progress,  acceptanceStatus=''
//	owner 提交结果： status=review,       acceptanceStatus=''       resultSummary 已写
//	reviewer 通过：  status=done,         acceptanceStatus=accepted completedAt 已写
//	reviewer 返工：  status=in_progress,  acceptanceStatus=rework   reworkCount++
//	reviewer 阻塞：  status=blocked,      acceptanceStatus=blocked
//	reviewer 上升：  status=review,       acceptanceStatus=needs_human
//
// 兼容：现有面板若只看 status，rework 任务回到 in_progress 自然显示在"未完成"区。
type Task struct {
	ID         string `json:"id"`
	RoomID     string `json:"roomId"`
	Text       string `json:"text"`
	AssigneeID string `json:"assigneeId,omitempty"`
	CreatorID  string `json:"creatorId"`
	Status     string `json:"status"`
	DueAt      *int64 `json:"dueAt,omitempty"`
	CreatedAt  int64  `json:"createdAt"`

	// v0.2 工作单字段
	ReviewerID       string   `json:"reviewerId,omitempty"`
	Deliverable      string   `json:"deliverable,omitempty"`
	DefinitionOfDone string   `json:"definitionOfDone,omitempty"`
	SourceDecisionID string   `json:"sourceDecisionId,omitempty"`
	SourceMessageID  string   `json:"sourceMessageId,omitempty"`
	ExecutionMode    string   `json:"executionMode,omitempty"`
	ResultSummary    string   `json:"resultSummary,omitempty"`
	AcceptanceStatus string   `json:"acceptanceStatus,omitempty"`
	AcceptanceNote   string   `json:"acceptanceNote,omitempty"`
	PassedCriteria   []string `json:"passedCriteria,omitempty"`
	FailedCriteria   []string `json:"failedCriteria,omitempty"`
	ReworkCount      int      `json:"reworkCount,omitempty"`
	CompletedAt      *int64   `json:"completedAt,omitempty"`
	ReviewedAt       *int64   `json:"reviewedAt,omitempty"`
	// v0.3 主题 C：跨房间血缘
	ParentTaskID string `json:"parentTaskId,omitempty"`
	RootRoomID   string `json:"rootRoomId,omitempty"`
	// v0.3 主题 D：任务依赖（同房间）。
	DependsOn []string `json:"dependsOn,omitempty"`
}

// 任务状态常量
const (
	TaskStatusTodo       = "todo"
	TaskStatusDoing      = "doing"
	TaskStatusAssigned   = "assigned"
	TaskStatusInProgress = "in_progress"
	TaskStatusReview     = "review"
	TaskStatusDone       = "done"
	TaskStatusCancelled  = "cancelled"
	TaskStatusBlocked    = "blocked"
)

// 验收结论常量
const (
	AcceptanceStatusNone       = ""
	AcceptanceStatusAccepted   = "accepted"
	AcceptanceStatusRework     = "rework"
	AcceptanceStatusNeedsHuman = "needs_human"
	AcceptanceStatusBlocked    = "blocked"
)

// 任务执行模式
const (
	TaskExecutionModeManual      = "manual"
	TaskExecutionModeMemberAgent = "member_agent"
	TaskExecutionModeSubagent    = "subagent"
)

// 默认返工轮次上限（达到后自动 needs_human）
const DefaultReworkLimit = 3

// TaskExecution —— 任务执行回执 DTO（v0.2 GAP G4）。
//
// 一个任务对应 0..N 条 execution；当前活跃 = status in {queued, running} 的最新一条。
// 终态：completed / failed / canceled。
//
// artifacts/blockers 用 []string 承载——前端 UI 简单友好，后端持久化为 \n 拼接。
type TaskExecution struct {
	ID               string   `json:"id"`
	TaskID           string   `json:"taskId"`
	RoomID           string   `json:"roomId"`
	ExecutorMemberID string   `json:"executorMemberId,omitempty"`
	Mode             string   `json:"mode"`   // manual | member_agent | subagent
	Status           string   `json:"status"` // queued | running | completed | failed | canceled
	Summary          string   `json:"summary,omitempty"`
	Artifacts        []string `json:"artifacts,omitempty"`
	Blockers         []string `json:"blockers,omitempty"`
	RawRunRef        string   `json:"rawRunRef,omitempty"`
	TokenUsage       int64    `json:"tokenUsage,omitempty"`
	ErrorMsg         string   `json:"errorMsg,omitempty"`
	StartedAt        *int64   `json:"startedAt,omitempty"`
	CompletedAt      *int64   `json:"completedAt,omitempty"`
	CreatedAt        int64    `json:"createdAt"`
}

const (
	TaskExecStatusQueued    = "queued"
	TaskExecStatusRunning   = "running"
	TaskExecStatusCompleted = "completed"
	TaskExecStatusFailed    = "failed"
	TaskExecStatusCanceled  = "canceled"
)

func TaskExecutionFromModel(m *database.AgentRoomTaskExecution) TaskExecution {
	var artifacts, blockers []string
	if strings.TrimSpace(m.ArtifactsJSON) != "" {
		_ = json.Unmarshal([]byte(m.ArtifactsJSON), &artifacts)
	}
	if strings.TrimSpace(m.BlockersJSON) != "" {
		_ = json.Unmarshal([]byte(m.BlockersJSON), &blockers)
	}
	return TaskExecution{
		ID:               m.ID,
		TaskID:           m.TaskID,
		RoomID:           m.RoomID,
		ExecutorMemberID: m.ExecutorMemberID,
		Mode:             m.Mode,
		Status:           m.Status,
		Summary:          m.Summary,
		Artifacts:        artifacts,
		Blockers:         blockers,
		RawRunRef:        m.RawRunRef,
		TokenUsage:       m.TokenUsage,
		ErrorMsg:         m.ErrorMsg,
		StartedAt:        m.StartedAt,
		CompletedAt:      m.CompletedAt,
		CreatedAt:        m.CreatedAt.UnixMilli(),
	}
}

type Intervention struct {
	ID     string `json:"id"`
	RoomID string `json:"roomId"`
	At     int64  `json:"at"`
	Level  int    `json:"level"`
	Label  string `json:"label"`
	Actor  string `json:"actor"`
	Target string `json:"targetId,omitempty"`
	Detail string `json:"detail,omitempty"`
}

// ── 辅助函数 ──

func NowMs() int64 { return time.Now().UnixMilli() }

func jsonMarshal(v any) string {
	if v == nil {
		return ""
	}
	b, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	return string(b)
}

func jsonUnmarshalSlice(s string) []string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	var out []string
	_ = json.Unmarshal([]byte(s), &out)
	return out
}

func jsonUnmarshalMap(s string) map[string]any {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	var out map[string]any
	_ = json.Unmarshal([]byte(s), &out)
	return out
}

func jsonUnmarshalReactions(s string) []Reaction {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	var out []Reaction
	_ = json.Unmarshal([]byte(s), &out)
	return out
}

func jsonUnmarshalBidding(s string) []BiddingScore {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	var out []BiddingScore
	_ = json.Unmarshal([]byte(s), &out)
	return out
}

// v0.9.1 图片附件 JSON 反序列化。空列表直接返回 nil，避免前端多一个空数组字段。
func jsonUnmarshalAttachments(s string) []MessageAttachment {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	var out []MessageAttachment
	_ = json.Unmarshal([]byte(s), &out)
	if len(out) == 0 {
		return nil
	}
	return out
}

// ── 模型 ↔ DTO 转换 ──

func RoomFromModel(m *database.AgentRoom, memberIDs []string, facts []Fact, tasks []Task) *Room {
	var budget RoomBudget
	if m.BudgetJSON != "" {
		_ = json.Unmarshal([]byte(m.BudgetJSON), &budget)
	}
	var opts *PolicyOptions
	if m.PolicyOpts != "" {
		var o PolicyOptions
		if err := json.Unmarshal([]byte(m.PolicyOpts), &o); err == nil {
			opts = &o
		}
	}
	var proj *RoomProjection
	if m.Projection != "" {
		var p RoomProjection
		if err := json.Unmarshal([]byte(m.Projection), &p); err == nil {
			proj = &p
		}
	}
	tags := []string{}
	if m.Tags != "" {
		_ = json.Unmarshal([]byte(m.Tags), &tags)
		if tags == nil {
			tags = []string{}
		}
	}
	queue := []string{}
	if m.ExecutionQueueJSON != "" {
		_ = json.Unmarshal([]byte(m.ExecutionQueueJSON), &queue)
		if queue == nil {
			queue = []string{}
		}
	}
	phase := m.ExecutionPhase
	if phase == "" && m.Policy == PolicyPlanned {
		phase = PhaseDiscussion
	}
	return &Room{
		ID:                 m.ID,
		Title:              m.Title,
		TemplateID:         m.TemplateID,
		State:              m.State,
		Policy:             m.Policy,
		PolicyOpts:         opts,
		ModeratorID:        m.ModeratorID,
		Budget:             budget,
		Projection:         proj,
		Whiteboard:         m.Whiteboard,
		CollaborationStyle: m.CollaborationStyle,
		Readonly:           m.Readonly,
		MutationDryRun:     m.MutationDryRun,
		Goal:               m.Goal,
		RoundBudget:        m.RoundBudget,
		RoundsUsed:         m.RoundsUsed,
		SelfCritique:       m.SelfCritique,
		Constitution:       m.Constitution,
		AuxModel:           m.AuxModel,
		Facts:              facts,
		Tasks:              tasks,
		MemberIDs:          memberIDs,
		Tags:               tags,
		ExecutionPhase:     phase,
		ExecutionQueue:     queue,
		ExecutionOwnerIdx:  m.ExecutionOwnerIdx,
		CreatedAt:          m.CreatedAt.UnixMilli(),
		UpdatedAt:          m.UpdatedAt.UnixMilli(),
		ClosedAt:           m.ClosedAt,
	}
}

func MemberFromModel(m *database.AgentRoomMember) Member {
	return Member{
		ID:               m.ID,
		RoomID:           m.RoomID,
		Kind:             m.Kind,
		Name:             m.Name,
		Role:             m.Role,
		Emoji:            m.Emoji,
		AvatarColor:      m.AvatarColor,
		Model:            m.Model,
		SystemPrompt:     m.SystemPrompt,
		Status:           m.Status,
		IsModerator:      m.IsModerator,
		IsMuted:          m.IsMuted,
		IsKicked:         m.IsKicked,
		Stance:           m.Stance,
		AgentID:          m.AgentID,
		SessionKey:       m.SessionKey,
		Thinking:         m.Thinking,
		RoleProfileID:    m.RoleProfileID,
		RoleProfileMode:  m.RoleProfileMode,
		TokenUsage:       m.TokenUsage,
		LastPromptTokens: m.LastPromptTokens,
		ContextLimit:     ModelContextLimit(m.Model),
		CostCNY:          float64(m.CostMilli) / 10000.0,
		CreatedAt:        m.CreatedAt.UnixMilli(),
	}
}

func MessageFromModel(m *database.AgentRoomMessage) Message {
	return Message{
		ID:                 m.ID,
		RoomID:             m.RoomID,
		Seq:                m.Seq,
		Timestamp:          m.Timestamp,
		AuthorID:           m.AuthorID,
		ActingAsID:         m.ActingAsID,
		Kind:               m.Kind,
		Content:            m.Content,
		MentionIDs:         jsonUnmarshalSlice(m.MentionIDsJSON),
		ReferenceMessageID: m.ReferenceMessageID,
		WhisperTargetIDs:   jsonUnmarshalSlice(m.WhisperTargetsJSON),
		ToolName:           m.ToolName,
		ToolArgs:           jsonUnmarshalMap(m.ToolArgs),
		ToolResult:         m.ToolResult,
		ToolStatus:         m.ToolStatus,
		BiddingScores:      jsonUnmarshalBidding(m.BiddingJSON),
		ProjectionChannel:  m.ProjectionChannel,
		ExternalSenderName: m.ExternalSenderName,
		ExternalMessageID:  m.ExternalMessageID,
		Model:              m.Model,
		TokensPrompt:       m.TokensPrompt,
		TokensComplete:     m.TokensComplete,
		Streaming:          m.Streaming,
		Deleted:            m.Deleted,
		ContentEdited:      m.ContentEdited,
		Reactions:          jsonUnmarshalReactions(m.ReactionsJSON),
		Confidence:         m.Confidence,
		Stance:             m.Stance,
		HumanNeeded:        m.HumanNeeded,
		Untrusted:          m.Untrusted,
		PiiRedactedCount:   m.PiiRedactedCount,
		IsDecision:         m.IsDecision,
		DecisionSummary:    m.DecisionSummary,
		IdempotencyKey:     m.IdempotencyKey,
		Attachments:        jsonUnmarshalAttachments(m.AttachmentsJSON),
	}
}

// v0.6 DTO converters

func ArtifactFromModel(m *database.AgentRoomArtifact) Artifact {
	return Artifact{
		ID:        m.ID,
		RoomID:    m.RoomID,
		Title:     m.Title,
		Kind:      m.Kind,
		Language:  m.Language,
		Content:   m.Content,
		Version:   m.Version,
		AuthorID:  m.AuthorID,
		CreatedAt: m.CreatedAt.UnixMilli(),
		UpdatedAt: m.UpdatedAt.UnixMilli(),
	}
}

func PlaybookFromModel(m *database.AgentRoomPlaybook) Playbook {
	tags := []string{}
	if m.TagsJSON != "" {
		_ = json.Unmarshal([]byte(m.TagsJSON), &tags)
	}
	return Playbook{
		ID:           m.ID,
		SourceRoomID: m.SourceRoomID,
		Title:        m.Title,
		Problem:      m.Problem,
		Approach:     m.Approach,
		Conclusion:   m.Conclusion,
		Category:     m.Category,
		Tags:         tags,
		CreatedAt:    m.CreatedAt.UnixMilli(),
	}
}

func PersonaMemoryFromModel(m *database.AgentRoomPersonaMemory) PersonaMemory {
	return PersonaMemory{
		MemoryKey: m.MemoryKey,
		Content:   m.Content,
		SizeBytes: m.SizeBytes,
		UpdatedAt: m.UpdatedAt.UnixMilli(),
	}
}

func FactFromModel(m *database.AgentRoomFact) Fact {
	return Fact{Key: m.Key, Value: m.Value, AuthorID: m.AuthorID, UpdatedAt: m.UpdatedAt}
}

func TaskFromModel(m *database.AgentRoomTask) Task {
	return Task{
		ID:               m.ID,
		RoomID:           m.RoomID,
		Text:             m.Text,
		AssigneeID:       m.AssigneeID,
		CreatorID:        m.CreatorID,
		Status:           m.Status,
		DueAt:            m.DueAt,
		CreatedAt:        m.CreatedAt.UnixMilli(),
		ReviewerID:       m.ReviewerID,
		Deliverable:      m.Deliverable,
		DefinitionOfDone: m.DefinitionOfDone,
		SourceDecisionID: m.SourceDecisionID,
		SourceMessageID:  m.SourceMessageID,
		ExecutionMode:    m.ExecutionMode,
		ResultSummary:    m.ResultSummary,
		AcceptanceStatus: m.AcceptanceStatus,
		AcceptanceNote:   m.AcceptanceNote,
		PassedCriteria:   splitNonEmptyLines(m.PassedCriteria),
		FailedCriteria:   splitNonEmptyLines(m.FailedCriteria),
		ReworkCount:      m.ReworkCount,
		CompletedAt:      m.CompletedAt,
		ReviewedAt:       m.ReviewedAt,
		ParentTaskID:     m.ParentTaskID,
		RootRoomID:       m.RootRoomID,
		DependsOn:        decodeStringSlice(m.DependsOnJSON),
	}
}

// decodeStringSlice 反序列化 task.DependsOnJSON 这类 JSON 字符串数组字段。
// 失败 / 空 → 返回 nil，调用方按空切片处理。
func decodeStringSlice(s string) []string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	var out []string
	if err := json.Unmarshal([]byte(s), &out); err != nil {
		return nil
	}
	return out
}

// splitNonEmptyLines 把 \n 分隔的字符串拆成非空 trim 后字符串切片。
// 用于 PassedCriteria / FailedCriteria 这种"行存"字段。
func splitNonEmptyLines(s string) []string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	parts := strings.Split(s, "\n")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// JoinLines 反向：[]string → \n 拼接，给 handler 写入数据库使用。
func JoinLines(items []string) string {
	if len(items) == 0 {
		return ""
	}
	cleaned := make([]string, 0, len(items))
	for _, s := range items {
		s = strings.TrimSpace(s)
		if s != "" {
			cleaned = append(cleaned, s)
		}
	}
	return strings.Join(cleaned, "\n")
}

func InterventionFromModel(m *database.AgentRoomIntervention) Intervention {
	return Intervention{
		ID:     m.ID,
		RoomID: m.RoomID,
		At:     m.At,
		Level:  m.Level,
		Label:  m.Label,
		Actor:  m.Actor,
		Target: m.TargetID,
		Detail: m.Detail,
	}
}
