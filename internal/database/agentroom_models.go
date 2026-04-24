package database

import "time"

// ──────────────────────────────────────────────────────────
// AgentRoom GORM models (DESIGN.md v0.2)
// 所有多值字段（tools/mentionIds/targets/biddingScores 等）序列化为 JSON 字符串列。
// 时间戳统一使用 int64 Unix ms（和前端 Date.now() 对齐），
// 仅 CreatedAt/UpdatedAt 这些 GORM 自动管理字段使用 time.Time。
// ──────────────────────────────────────────────────────────

type AgentRoom struct {
	ID              string `gorm:"primaryKey;size:64"           json:"id"`
	OwnerUserID     uint   `gorm:"index"                         json:"ownerUserId"`
	Title           string `gorm:"size:255;not null"             json:"title"`
	TemplateID      string `gorm:"size:64;index"                 json:"templateId,omitempty"`
	State           string `gorm:"size:16;index;default:'draft'" json:"state"` // draft|active|paused|closed|archived
	Policy          string `gorm:"size:24;default:'free'"        json:"policy"`
	ModeratorID     string `gorm:"size:64"                       json:"moderatorId,omitempty"`
	BudgetJSON      string `gorm:"type:text"                     json:"-"` // RoomBudget
	PolicyOpts      string `gorm:"type:text"                     json:"-"` // PolicyOptions
	Projection      string `gorm:"type:text"                     json:"-"` // RoomProjection
	Whiteboard      string `gorm:"type:text"                     json:"whiteboard,omitempty"`
	Tags            string `gorm:"type:text"                     json:"-"`                         // JSON array
	ParentRoomID    string `gorm:"size:64;index"                 json:"parentRoomId,omitempty"`    // Fork 源房间
	ParentMessageID string `gorm:"size:64"                       json:"parentMessageId,omitempty"` // Fork 切断点
	// 结构化执行（planned policy 专用）
	ExecutionPhase     string `gorm:"size:16;default:'discussion'" json:"executionPhase,omitempty"` // discussion|executing|review
	ExecutionQueueJSON string `gorm:"type:text"                    json:"-"`                        // JSON array of member IDs
	ExecutionOwnerIdx  int    `gorm:"default:0"                    json:"executionOwnerIdx,omitempty"`
	// 房间级协作风格（轻量，自由文本，每轮注入进 system prompt；不与白板混用）
	CollaborationStyle string `gorm:"type:text"                     json:"collaborationStyle,omitempty"`
	// 安全开关：
	//   Readonly=true       → agent 全部静默，scheduler.Pick 返回空；prompt 里注明"只读房间"。
	//   MutationDryRun=true → 不阻止发言，但在 system prompt 声明本房间为演练模式：
	//                         声明会写什么文件/执行什么命令，但不要真正执行工具调用。
	// 两个开关可独立打开/关闭；实现上是 DTO flag + prompt 注入 + Pick 过滤（仅 Readonly）。
	Readonly       bool `gorm:"default:false"                 json:"readonly,omitempty"`
	MutationDryRun bool `gorm:"default:false"                 json:"mutationDryRun,omitempty"`
	// v0.6 ——协作质量层
	Goal         string `gorm:"type:text"                     json:"goal,omitempty"`         // 房间目标一句话
	RoundBudget  int    `gorm:"default:0"                     json:"roundBudget,omitempty"`  // 预期 agent 轮次，0=无限
	RoundsUsed   int    `gorm:"default:0"                     json:"roundsUsed,omitempty"`   // 已消耗 agent 轮次（runAgentTurn 每调一次 +1）
	SelfCritique bool   `gorm:"default:false"                 json:"selfCritique,omitempty"` // 自我批判回合，agent 发言后跑一次轻量 rubric
	Constitution string `gorm:"type:text"                     json:"constitution,omitempty"` // 房间级红线（一行一条，每轮注入 system prompt）
	// AuxModel —— 本房间"辅助 LLM 调用"使用的模型（竞言打分 / 会议纪要 / extract-todo / promote-decision / away-summary 等）。
	// 空 = 跟随全局默认（settings["agentroom.aux_model"]）；全局默认也为空时退化到房间 owner 的首位 member Model。
	// 格式与成员 Model 一致：`provider/model`，如 `metapi/gpt-5.4-mini` / `openai/gpt-4o-mini`。
	AuxModel  string    `gorm:"size:128"                       json:"auxModel,omitempty"`
	ClosedAt  *int64    `json:"closedAt,omitempty"`
	CreatedAt time.Time `gorm:"index"                         json:"-"`
	UpdatedAt time.Time `gorm:"index"                         json:"-"`
}

func (AgentRoom) TableName() string { return "agentroom_rooms" }

type AgentRoomMember struct {
	ID           string `gorm:"primaryKey;size:64"         json:"id"`
	RoomID       string `gorm:"size:64;index;not null"     json:"roomId"`
	Kind         string `gorm:"size:16;not null"           json:"kind"` // agent|human
	Name         string `gorm:"size:128;not null"          json:"name"`
	Role         string `gorm:"size:128"                   json:"role"`
	Emoji        string `gorm:"size:32"                    json:"emoji,omitempty"`
	AvatarColor  string `gorm:"size:16"                    json:"avatarColor,omitempty"`
	Model        string `gorm:"size:128"                   json:"model,omitempty"`
	ToolsJSON    string `gorm:"type:text"                  json:"-"`
	SystemPrompt string `gorm:"type:text"                  json:"systemPrompt,omitempty"`
	Status       string `gorm:"size:32;default:'idle'"     json:"status"`
	IsModerator  bool   `gorm:"default:false"              json:"isModerator,omitempty"`
	IsMuted      bool   `gorm:"default:false"              json:"isMuted,omitempty"`
	IsKicked     bool   `gorm:"default:false"              json:"isKicked,omitempty"`
	// v0.7+ 辩论 / 对抗评审立场 —— "pro" 正方 / "con" 反方 / "neutral" 中立 / ""（未设置）。
	// 与 debate policy 联动：scheduler 据此轮转；prompt 里会注入"你是本场辩论的<正方/反方>"。
	// 对非 debate 房间 stance 仍可设置作为人设提示。
	Stance     string `gorm:"size:16"                    json:"stance,omitempty"`
	TokenUsage int64  `gorm:"default:0"                  json:"tokenUsage"`
	// 上一次 runAgentTurn 的 prompt token 用量（近似 = 本轮喂入模型的上下文大小）。
	// 用于计算 context pressure = LastPromptTokens / modelContextLimit。
	LastPromptTokens int64 `gorm:"default:0"                  json:"lastPromptTokens,omitempty"`
	// v0.6 长期记忆：同一 agent 在不同房间复用同一份 persona memory。
	// memory_key 空 = 不维持跨房间记忆；建议走 "user:{uid}:role:{slug}" 或 "team:{id}:..."。
	MemoryKey string `gorm:"size:128;index"             json:"memoryKey,omitempty"`
	// RoleProfileID —— 角色库来源。房间里的成员始终是实例副本；该字段仅记录它最初来自哪个角色库角色。
	// 空 = 手工自建角色 / 旧数据。
	RoleProfileID string `gorm:"size:64;index"              json:"roleProfileId,omitempty"`
	// RoleProfileMode —— builtin | user | template | custom_snapshot
	RoleProfileMode string `gorm:"size:24"                   json:"roleProfileMode,omitempty"`
	// v0.4 (OpenClaw bridge) —— 绑定到上游 OpenClaw agent 实例。
	// AgentID：gateway agents.list 返回的 agent id（如 "claude" / "gpt5" / 自定义），空 = "default"。
	// SessionKey：该成员在 OpenClaw 侧的持久化 session，约定 "agent:<AgentID>:agentroom:<roomID>:<memberID>"。
	// 成员创建时由 handler 调 bridge.EnsureSession 预建；踢出/删除房间时 DeleteSession。
	// Thinking：传给 OpenClaw agent RPC 的 thinking 级别 off/low/medium/high；空 = 走 agent 默认。
	AgentID    string    `gorm:"size:64;index"              json:"agentId,omitempty"`
	SessionKey string    `gorm:"size:255;index"             json:"sessionKey,omitempty"`
	Thinking   string    `gorm:"size:16"                    json:"thinking,omitempty"`
	CostMilli  int64     `gorm:"default:0"                  json:"-"` // 分厘：cost_cny × 10000，避免浮点累积误差
	CreatedAt  time.Time `json:"-"`
	UpdatedAt  time.Time `json:"-"`
}

func (AgentRoomMember) TableName() string { return "agentroom_members" }

// AgentRoomRoleProfile —— 角色库条目。
// 角色库是可复用定义源；真正加入房间后会复制为 AgentRoomMember 实例。
type AgentRoomRoleProfile struct {
	ID                     string    `gorm:"primaryKey;size:64"               json:"id"`
	OwnerUserID            uint      `gorm:"index"                            json:"ownerUserId"`
	Slug                   string    `gorm:"size:96;index"                    json:"slug"`
	Name                   string    `gorm:"size:128;not null"                json:"name"`
	Role                   string    `gorm:"size:128;not null"                json:"role"`
	Emoji                  string    `gorm:"size:32"                          json:"emoji,omitempty"`
	Description            string    `gorm:"type:text"                        json:"description,omitempty"`
	Category               string    `gorm:"size:64;index"                    json:"category,omitempty"`
	SystemPrompt           string    `gorm:"type:text"                        json:"systemPrompt,omitempty"`
	StylePrompt            string    `gorm:"type:text"                        json:"stylePrompt,omitempty"`
	ToolsJSON              string    `gorm:"type:text"                        json:"-"`
	Model                  string    `gorm:"size:128"                         json:"model,omitempty"`
	AgentID                string    `gorm:"size:64;index"                    json:"agentId,omitempty"`
	Thinking               string    `gorm:"size:16"                          json:"thinking,omitempty"`
	MemoryKey              string    `gorm:"size:128;index"                   json:"memoryKey,omitempty"`
	IsModerator            bool      `gorm:"default:false"                    json:"isModerator,omitempty"`
	Stance                 string    `gorm:"size:16"                          json:"stance,omitempty"`
	InteractionProfileJSON string    `gorm:"type:text"                        json:"-"`
	Builtin                bool      `gorm:"default:false;index"              json:"builtin,omitempty"`
	Visibility             string    `gorm:"size:24;default:'private';index"  json:"visibility,omitempty"`
	SortOrder              int       `gorm:"default:0"                        json:"sortOrder,omitempty"`
	CreatedAt              time.Time `gorm:"index"                            json:"createdAt"`
	UpdatedAt              time.Time `json:"updatedAt"`
}

func (AgentRoomRoleProfile) TableName() string { return "agentroom_role_profiles" }

type AgentRoomMessage struct {
	ID                 string `gorm:"primaryKey;size:64"         json:"id"`
	RoomID             string `gorm:"size:64;index;not null"     json:"roomId"`
	Seq                int64  `gorm:"index"                      json:"seq"` // 手动维护 max+1；复合唯一索引见 uniqueIndex:ux_room_seq
	Timestamp          int64  `gorm:"index;not null"             json:"timestamp"`
	AuthorID           string `gorm:"size:64;index"              json:"authorId"`
	ActingAsID         string `gorm:"size:64"                    json:"actingAsId,omitempty"`
	Kind               string `gorm:"size:24;index;not null"     json:"kind"`
	Content            string `gorm:"type:text"                  json:"content"`
	MentionIDsJSON     string `gorm:"type:text"                  json:"-"`
	ReferenceMessageID string `gorm:"size:64"                    json:"referenceMessageId,omitempty"`
	WhisperTargetsJSON string `gorm:"type:text"                  json:"-"`

	// Idempotency（前端 POST 时携带的 Idempotency-Key）
	// 复合唯一索引：(room_id, idempotency_key) —— 允许空值重复，只对非空值去重
	IdempotencyKey string `gorm:"size:80;uniqueIndex:ux_room_idem,where:idempotency_key != ''" json:"-"`

	// Tool
	ToolName   string `gorm:"size:128"   json:"toolName,omitempty"`
	ToolArgs   string `gorm:"type:text"  json:"-"`
	ToolResult string `gorm:"type:text"  json:"toolResult,omitempty"`
	ToolStatus string `gorm:"size:32"    json:"toolStatus,omitempty"`

	// Bidding
	BiddingJSON string `gorm:"type:text" json:"-"`

	// Projection —— external_message_id 带房间去重（防 webhook 重投）
	ProjectionChannel  string `gorm:"size:32" json:"projectionChannel,omitempty"`
	ExternalSenderName string `gorm:"size:128" json:"externalSenderName,omitempty"`
	ExternalMessageID  string `gorm:"size:128;uniqueIndex:ux_room_ext,where:external_message_id != ''" json:"externalMessageId,omitempty"`

	// Cost snapshot
	Model          string `gorm:"size:128" json:"model,omitempty"`
	TokensPrompt   int    `json:"tokensPrompt,omitempty"`
	TokensComplete int    `json:"tokensComplete,omitempty"`
	CostMilli      int64  `json:"-"`

	Streaming     bool   `gorm:"default:false"  json:"streaming,omitempty"`
	Deleted       bool   `gorm:"default:false"  json:"deleted,omitempty"`
	ContentEdited bool   `gorm:"default:false"  json:"contentEdited,omitempty"`
	OriginalBody  string `gorm:"type:text"      json:"-"` // 编辑前原文 (for audit)
	ReactionsJSON string `gorm:"type:text"      json:"-"` // Reaction[]
	ReadReceipts  string `gorm:"type:text"      json:"-"` // map memberId→ts

	// v0.6 协作质量 soft-tags
	// 置信度 0-100；orchestrator 解析 agent 输出尾部 `#confidence: N` 或 结构化内联语义。
	Confidence int `gorm:"default:0"        json:"confidence,omitempty"`
	// 立场（仅对已存在的 decision 有意义）：用 ReferenceMessageID 联向评价的 decision。
	// 值：agree | disagree | abstain | uncertain
	Stance string `gorm:"size:16"          json:"stance,omitempty"`
	// 人类需求软标记，非空 ≈ "我目前停不下去，需要人类介入"；会触发 intervention + UI banner。
	HumanNeeded string `gorm:"type:text"   json:"humanNeeded,omitempty"`
	// 注入哨兵：外部资料 / 投影 inbound 内容命中可疑模式 → 标为 untrusted，prompt 封 fence。
	Untrusted bool `gorm:"default:false"     json:"untrusted,omitempty"`
	// 出站投影前命中的 PII 脱敏计数；>0 表示 UI 上显示“已脱敏 N 处”徽章。
	PiiRedactedCount int `gorm:"default:0"   json:"piiRedactedCount,omitempty"`
	// 决策锚：消息 promote 为 decision 后置为 true；DecisionSummary 是人或 closing agent 归纳的一行摘要。
	IsDecision      bool   `gorm:"default:false;index" json:"isDecision,omitempty"`
	DecisionSummary string `gorm:"type:text"           json:"decisionSummary,omitempty"`

	// v0.9.1 图片附件 —— 与 OpenClaw chat.send/agent RPC 的 attachments 参数同构：
	//   [{type:"image", mimeType:"image/png", fileName:"x.png", content:"<base64 raw>"}, ...]
	// 用 JSON 字符串单列存储，AutoMigrate 新增一列即可（GORM type:text ≈ SQLite TEXT，容量足够）。
	// 外部暴露在 Message.Attachments（types.go），前端据此在消息气泡里渲染缩略图。
	AttachmentsJSON string `gorm:"type:text" json:"-"`
}

func (AgentRoomMessage) TableName() string { return "agentroom_messages" }

type AgentRoomFact struct {
	RoomID    string    `gorm:"primaryKey;size:64"    json:"roomId"`
	Key       string    `gorm:"primaryKey;size:128"   json:"key"`
	Value     string    `gorm:"type:text"             json:"value"`
	AuthorID  string    `gorm:"size:64"               json:"authorId"`
	UpdatedAt int64     `json:"updatedAt"`
	CreatedAt time.Time `json:"-"`
}

func (AgentRoomFact) TableName() string { return "agentroom_facts" }

type AgentRoomTask struct {
	ID         string    `gorm:"primaryKey;size:64"       json:"id"`
	RoomID     string    `gorm:"size:64;index;not null"   json:"roomId"`
	Text       string    `gorm:"type:text;not null"       json:"text"`
	AssigneeID string    `gorm:"size:64;index"            json:"assigneeId,omitempty"`
	CreatorID  string    `gorm:"size:64"                  json:"creatorId"`
	Status     string    `gorm:"size:16;default:'todo'"   json:"status"`
	DueAt      *int64    `json:"dueAt,omitempty"`
	CreatedAt  time.Time `gorm:"index"                    json:"-"`
	UpdatedAt  time.Time `json:"-"`
}

func (AgentRoomTask) TableName() string { return "agentroom_tasks" }

type AgentRoomIntervention struct {
	ID        string    `gorm:"primaryKey;size:64"       json:"id"`
	RoomID    string    `gorm:"size:64;index;not null"   json:"roomId"`
	At        int64     `gorm:"index"                    json:"at"`
	Level     int       `json:"level"` // 1..6
	Label     string    `gorm:"size:128"                 json:"label"`
	Actor     string    `gorm:"size:64"                  json:"actor"`
	TargetID  string    `gorm:"size:64"                  json:"targetId,omitempty"`
	Detail    string    `gorm:"type:text"                json:"detail,omitempty"`
	CreatedAt time.Time `json:"-"`
}

func (AgentRoomIntervention) TableName() string { return "agentroom_interventions" }

// AgentRoomAudit —— AgentRoom 专属的管理员操作审计流水。
// 与通用 AuditLog 分离，避免污染全局审计；保留原 AuditLog 作 ClawDeckX 账户级记录。
type AgentRoomAudit struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	RoomID    string    `gorm:"size:64;index;not null" json:"roomId"`
	UserID    uint      `gorm:"index" json:"userId"`
	Action    string    `gorm:"size:48;index;not null" json:"action"` // delete|fork|kick|mute|emergency_stop|...
	TargetID  string    `gorm:"size:64" json:"targetId,omitempty"`
	Detail    string    `gorm:"type:text" json:"detail,omitempty"`
	IP        string    `gorm:"size:64" json:"ip"`
	CreatedAt time.Time `gorm:"index" json:"createdAt"`
}

func (AgentRoomAudit) TableName() string { return "agentroom_audits" }

// AgentRoomDoc —— 房间级 RAG 文档元数据。
// 用户上传的 md/txt 文件按标题 + 分段 chunks 存储；配合 FTS5 复用实现检索。
// 一期只支持 md/txt，不做 embedding / PDF（延后 v0.6 + ）。
type AgentRoomDoc struct {
	ID         string    `gorm:"primaryKey;size:64"       json:"id"`
	RoomID     string    `gorm:"size:64;index;not null"   json:"roomId"`
	Title      string    `gorm:"size:255;not null"        json:"title"`
	SizeBytes  int64     `json:"sizeBytes"`
	ChunkCnt   int       `gorm:"default:0"                json:"chunkCount"`
	Mime       string    `gorm:"size:64"                  json:"mime,omitempty"`
	UploaderID uint      `gorm:"index"                    json:"uploaderId"`
	CreatedAt  time.Time `gorm:"index"                    json:"createdAt"`
}

func (AgentRoomDoc) TableName() string { return "agentroom_docs" }

// AgentRoomDocChunk —— 文档切片，FTS5 的实际索引对象。
// 每个 chunk 由切分器（markdown heading / 连续段落 / 500-800 字）产生。
type AgentRoomDocChunk struct {
	ID        string    `gorm:"primaryKey;size:64"       json:"id"`
	DocID     string    `gorm:"size:64;index;not null"   json:"docId"`
	RoomID    string    `gorm:"size:64;index;not null"   json:"roomId"`
	Seq       int       `gorm:"index"                    json:"seq"`
	Heading   string    `gorm:"size:255"                 json:"heading,omitempty"`
	Content   string    `gorm:"type:text;not null"       json:"content"`
	CreatedAt time.Time `json:"-"`
}

func (AgentRoomDocChunk) TableName() string { return "agentroom_doc_chunks" }

// AgentRoomArtifact —— v0.6 交付物一等公民。
// 和 Message(kind=artifact) 区别：Message 是讨论里的引用/流，Artifact 是可持续演进的真实文件，有版本号、类型、可下载。
// 典型场景：PRD.md / main.go / slides.md / spec.json。
type AgentRoomArtifact struct {
	ID        string    `gorm:"primaryKey;size:64"       json:"id"`
	RoomID    string    `gorm:"size:64;index;not null"   json:"roomId"`
	Title     string    `gorm:"size:255;not null"        json:"title"`
	Kind      string    `gorm:"size:32;default:'markdown'" json:"kind"`             // markdown|code|json|text
	Language  string    `gorm:"size:32"                  json:"language,omitempty"` // code 时的 language hint
	Content   string    `gorm:"type:text"                json:"content"`
	Version   int       `gorm:"default:1"                json:"version"`
	AuthorID  string    `gorm:"size:64"                  json:"authorId,omitempty"`
	CreatedAt time.Time `gorm:"index"                    json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

func (AgentRoomArtifact) TableName() string { return "agentroom_artifacts" }

// AgentRoomPlaybook —— v0.6/v0.7 可复用的"方法论卡"。
// 四段结构（problem / approach / conclusion）+ 结构化步骤 checklist + tags。
// v0.7 闭环：
//   - 房间 Close 时自动生成
//   - 用户可在 Playbook Studio 编辑任意字段
//   - 新建房间 wizard 会按 Goal 关键词推荐相关 Playbook，可一键注入
//   - 注入时 usage_count++，并把 room 附到 applied_room_ids 里做双向血缘
type AgentRoomPlaybook struct {
	ID           string `gorm:"primaryKey;size:64"       json:"id"`
	OwnerUserID  uint   `gorm:"index"                    json:"ownerUserId"`
	SourceRoomID string `gorm:"size:64;index"            json:"sourceRoomId,omitempty"`
	Title        string `gorm:"size:255;not null"        json:"title"`
	Problem      string `gorm:"type:text"                json:"problem"`
	Approach     string `gorm:"type:text"                json:"approach"`
	Conclusion   string `gorm:"type:text"                json:"conclusion"`
	Category     string `gorm:"size:64;index"            json:"category,omitempty"`
	TagsJSON     string `gorm:"type:text"                json:"-"`
	// v0.7：可重用性
	AppliesToJSON    string    `gorm:"type:text"                json:"-"` // []string, 模板 ID 或关键词
	StepsJSON        string    `gorm:"type:text"                json:"-"` // []PlaybookStep，结构化步骤
	UsageCount       int       `gorm:"default:0"                json:"usageCount"`
	AppliedRoomsJSON string    `gorm:"type:text"                json:"-"` // []string, 使用过此卡的房间 ID
	Version          int       `gorm:"default:1"                json:"version"`
	IsFavorite       bool      `gorm:"default:false;index"      json:"isFavorite,omitempty"`
	CreatedAt        time.Time `gorm:"index"                 json:"createdAt"`
	UpdatedAt        time.Time `                             json:"updatedAt"`
}

func (AgentRoomPlaybook) TableName() string { return "agentroom_playbooks" }

// ──────────────── v0.7 真实会议环节 ────────────────

// AgentRoomAgendaItem —— 议程项。一个房间可有多个，按 Seq 升序推进。
// 每项有独立的 TargetOutcome 和小结；房间级 Policy 在议程内仍生效，但可以被
// AgendaItem.Policy 覆盖（例如发散项用 bidding，收敛项用 moderator）。
type AgentRoomAgendaItem struct {
	ID              string    `gorm:"primaryKey;size:64"       json:"id"`
	RoomID          string    `gorm:"size:64;index;not null"   json:"roomId"`
	Seq             int       `gorm:"index;not null"           json:"seq"`
	Title           string    `gorm:"size:255;not null"        json:"title"`
	Description     string    `gorm:"type:text"                json:"description,omitempty"`
	TargetOutcome   string    `gorm:"type:text"                json:"targetOutcome,omitempty"`
	Policy          string    `gorm:"size:24"                  json:"policy,omitempty"`      // 空 = 继承房间 policy
	RoundBudget     int       `gorm:"default:0"                json:"roundBudget,omitempty"` // 0 = 不限
	RoundsUsed      int       `gorm:"default:0"                json:"roundsUsed"`
	Status          string    `gorm:"size:16;default:'pending';index" json:"status"` // pending|active|parked|done|skipped
	AssigneeIDsJSON string    `gorm:"type:text"                json:"-"`
	Outcome         string    `gorm:"type:text"                json:"outcome,omitempty"` // 本项小结（AI 生成）
	StartedAt       *int64    `                                json:"startedAt,omitempty"`
	EndedAt         *int64    `                                json:"endedAt,omitempty"`
	CreatedAt       time.Time `gorm:"index"                 json:"createdAt"`
	UpdatedAt       time.Time `                             json:"updatedAt"`
}

func (AgentRoomAgendaItem) TableName() string { return "agentroom_agenda_items" }

// AgentRoomOpenQuestion —— 悬挂的未回答问题。讨论跑到后面再回头填答案。
type AgentRoomOpenQuestion struct {
	ID              string    `gorm:"primaryKey;size:64"       json:"id"`
	RoomID          string    `gorm:"size:64;index;not null"   json:"roomId"`
	AgendaItemID    string    `gorm:"size:64;index"            json:"agendaItemId,omitempty"`
	Text            string    `gorm:"type:text;not null"       json:"text"`
	RaisedByID      string    `gorm:"size:64"                  json:"raisedById,omitempty"`
	Status          string    `gorm:"size:16;default:'open';index" json:"status"` // open|answered|deferred
	AnswerMessageID string    `gorm:"size:64"                  json:"answerMessageId,omitempty"`
	AnswerText      string    `gorm:"type:text"                json:"answerText,omitempty"`
	CreatedAt       time.Time `gorm:"index"                 json:"createdAt"`
	UpdatedAt       time.Time `                             json:"updatedAt"`
}

func (AgentRoomOpenQuestion) TableName() string { return "agentroom_open_questions" }

// AgentRoomParkingLot —— 跑题想法临时存放点。
type AgentRoomParkingLot struct {
	ID         string    `gorm:"primaryKey;size:64"       json:"id"`
	RoomID     string    `gorm:"size:64;index;not null"   json:"roomId"`
	Text       string    `gorm:"type:text;not null"       json:"text"`
	RaisedByID string    `gorm:"size:64"                  json:"raisedById,omitempty"`
	Resolution string    `gorm:"size:24;default:'pending';index" json:"resolution"` // pending|discarded|task|next-meeting
	CreatedAt  time.Time `gorm:"index"                 json:"createdAt"`
	UpdatedAt  time.Time `                             json:"updatedAt"`
}

func (AgentRoomParkingLot) TableName() string { return "agentroom_parking_lot" }

// AgentRoomRisk —— 讨论中识别的风险/阻塞。
type AgentRoomRisk struct {
	ID        string    `gorm:"primaryKey;size:64"       json:"id"`
	RoomID    string    `gorm:"size:64;index;not null"   json:"roomId"`
	Text      string    `gorm:"type:text;not null"       json:"text"`
	Severity  string    `gorm:"size:16;default:'mid';index" json:"severity"` // low|mid|high
	OwnerID   string    `gorm:"size:64"                  json:"ownerId,omitempty"`
	Status    string    `gorm:"size:16;default:'open';index" json:"status"` // open|mitigated|accepted
	CreatedAt time.Time `gorm:"index"                 json:"createdAt"`
	UpdatedAt time.Time `                             json:"updatedAt"`
}

func (AgentRoomRisk) TableName() string { return "agentroom_risks" }

// AgentRoomVote —— 投票原语。
// Mode：majority（过半）/ unanimous（全票）/ ranked（投票排序，此版只支持 majority 和 unanimous）。
type AgentRoomVote struct {
	ID           string    `gorm:"primaryKey;size:64"       json:"id"`
	RoomID       string    `gorm:"size:64;index;not null"   json:"roomId"`
	AgendaItemID string    `gorm:"size:64;index"             json:"agendaItemId,omitempty"`
	Question     string    `gorm:"type:text;not null"       json:"question"`
	OptionsJSON  string    `gorm:"type:text;not null"       json:"-"`
	Mode         string    `gorm:"size:16;default:'majority'" json:"mode"`
	VoterIDsJSON string    `gorm:"type:text"                json:"-"`
	Status       string    `gorm:"size:16;default:'open';index" json:"status"`       // open|closed
	Result       string    `gorm:"type:text"                json:"result,omitempty"` // 得票最高的选项
	InitiatorID  string    `gorm:"size:64"                  json:"initiatorId,omitempty"`
	ClosedAt     *int64    `                                json:"closedAt,omitempty"`
	CreatedAt    time.Time `gorm:"index"                 json:"createdAt"`
	UpdatedAt    time.Time `                             json:"updatedAt"`
}

func (AgentRoomVote) TableName() string { return "agentroom_votes" }

// AgentRoomVoteBallot —— 一次投票下的一张票。
type AgentRoomVoteBallot struct {
	VoteID    string    `gorm:"primaryKey;size:64"       json:"voteId"`
	VoterID   string    `gorm:"primaryKey;size:64"       json:"voterId"`
	Choice    string    `gorm:"size:255;not null"        json:"choice"`
	Rationale string    `gorm:"type:text"                json:"rationale,omitempty"`
	CreatedAt time.Time `                                json:"createdAt"`
}

func (AgentRoomVoteBallot) TableName() string { return "agentroom_vote_ballots" }

// AgentRoomRetro —— 会议复盘评分（房间关闭后自动生成，人也可编辑）。
// 评分维度：目标达成 / 讨论质量 / 决策明确度 / 效率 / 跑题率（越低越好）。
type AgentRoomRetro struct {
	RoomID               string    `gorm:"primaryKey;size:64"       json:"roomId"`
	ScoreOverall         int       `gorm:"default:0"                json:"scoreOverall"` // 1-100
	ScoreGoal            int       `gorm:"default:0"                json:"scoreGoal"`
	ScoreQuality         int       `gorm:"default:0"                json:"scoreQuality"`
	ScoreDecisionClarity int       `gorm:"default:0"                json:"scoreDecisionClarity"`
	ScoreEfficiency      int       `gorm:"default:0"                json:"scoreEfficiency"`
	OffTopicRate         int       `gorm:"default:0"                json:"offTopicRate"` // 0-100
	HighlightsJSON       string    `gorm:"type:text"                json:"-"`
	LowlightsJSON        string    `gorm:"type:text"                json:"-"`
	Summary              string    `gorm:"type:text"                json:"summary,omitempty"`
	NextMeetingDraftJSON string    `gorm:"type:text"                json:"-"` // NextMeetingDraft
	OutcomeArtifactID    string    `gorm:"size:64"                  json:"outcomeArtifactId,omitempty"`
	MinutesArtifactID    string    `gorm:"size:64"                  json:"minutesArtifactId,omitempty"`
	PlaybookID           string    `gorm:"size:64"                  json:"playbookId,omitempty"`
	GeneratedAt          int64     `gorm:"index"                    json:"generatedAt"`
	CreatedAt            time.Time `                             json:"-"`
	UpdatedAt            time.Time `                             json:"updatedAt"`
}

func (AgentRoomRetro) TableName() string { return "agentroom_retros" }

// AgentRoomPersonaMemory —— v0.6 角色级长期记忆。
// 按 memory_key 索引（AgentRoomMember.MemoryKey）；同一 agent 跨房间复用。
// 内容是自由文本 markdown，代表"这个角色积累下来的偏好、黑话、犯过的错"。
// 房间关闭时由 closing agent 蒸馏追加；人可手动编辑。
type AgentRoomPersonaMemory struct {
	MemoryKey   string    `gorm:"primaryKey;size:128"      json:"memoryKey"`
	OwnerUserID uint      `gorm:"index"                    json:"ownerUserId"`
	Content     string    `gorm:"type:text"                json:"content"`
	SizeBytes   int64     `json:"sizeBytes"`
	UpdatedAt   time.Time `gorm:"index"                   json:"updatedAt"`
	CreatedAt   time.Time `json:"-"`
}

func (AgentRoomPersonaMemory) TableName() string { return "agentroom_persona_memory" }
