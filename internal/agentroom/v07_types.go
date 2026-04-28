package agentroom

import (
	"encoding/json"
	"strings"

	"ClawDeckX/internal/database"
)

// v0.7 真实会议环节 DTO —— 对外 JSON 一等公民。
// 设计原则：
//   - 每个实体都提供 FromModel 转换函数，保证 JSON 输出稳定（空数组用 []，不是 null）
//   - 时间戳统一用 int64 Unix ms
//   - JSON 数组 / 对象字段统一通过 Unmarshal 解出，保证前端直接 .map/.filter 不炸

// ─────────── Playbook 结构化步骤 ───────────

// PlaybookStep —— 一个方法论卡里的可勾选步骤。
type PlaybookStep struct {
	ID      string `json:"id"`
	Text    string `json:"text"`
	Checked bool   `json:"checked,omitempty"`
	Note    string `json:"note,omitempty"`
}

// ─────────── Agenda ───────────

type AgendaItem struct {
	ID            string   `json:"id"`
	RoomID        string   `json:"roomId"`
	Seq           int      `json:"seq"`
	Title         string   `json:"title"`
	Description   string   `json:"description,omitempty"`
	TargetOutcome string   `json:"targetOutcome,omitempty"`
	Policy        string   `json:"policy,omitempty"`
	RoundBudget   int      `json:"roundBudget,omitempty"`
	RoundsUsed    int      `json:"roundsUsed"`
	Status        string   `json:"status"`
	AssigneeIDs   []string `json:"assigneeIds"`
	Outcome       string   `json:"outcome,omitempty"`
	StartedAt     *int64   `json:"startedAt,omitempty"`
	EndedAt       *int64   `json:"endedAt,omitempty"`
	CreatedAt     int64    `json:"createdAt"`
	UpdatedAt     int64    `json:"updatedAt"`
}

// 议程状态
const (
	AgendaStatusPending = "pending"
	AgendaStatusActive  = "active"
	AgendaStatusParked  = "parked"
	AgendaStatusDone    = "done"
	AgendaStatusSkipped = "skipped"
)

func AgendaItemFromModel(m *database.AgentRoomAgendaItem) AgendaItem {
	assignees := []string{}
	if m.AssigneeIDsJSON != "" {
		_ = json.Unmarshal([]byte(m.AssigneeIDsJSON), &assignees)
	}
	return AgendaItem{
		ID:            m.ID,
		RoomID:        m.RoomID,
		Seq:           m.Seq,
		Title:         m.Title,
		Description:   m.Description,
		TargetOutcome: m.TargetOutcome,
		Policy:        m.Policy,
		RoundBudget:   m.RoundBudget,
		RoundsUsed:    m.RoundsUsed,
		Status:        m.Status,
		AssigneeIDs:   assignees,
		Outcome:       m.Outcome,
		StartedAt:     m.StartedAt,
		EndedAt:       m.EndedAt,
		CreatedAt:     m.CreatedAt.UnixMilli(),
		UpdatedAt:     m.UpdatedAt.UnixMilli(),
	}
}

// ─────────── OpenQuestion / ParkingLot / Risk ───────────

type OpenQuestion struct {
	ID              string `json:"id"`
	RoomID          string `json:"roomId"`
	AgendaItemID    string `json:"agendaItemId,omitempty"`
	Text            string `json:"text"`
	RaisedByID      string `json:"raisedById,omitempty"`
	Status          string `json:"status"`
	AnswerMessageID string `json:"answerMessageId,omitempty"`
	AnswerText      string `json:"answerText,omitempty"`
	CreatedAt       int64  `json:"createdAt"`
	UpdatedAt       int64  `json:"updatedAt"`
}

func OpenQuestionFromModel(m *database.AgentRoomOpenQuestion) OpenQuestion {
	return OpenQuestion{
		ID: m.ID, RoomID: m.RoomID, AgendaItemID: m.AgendaItemID,
		Text: m.Text, RaisedByID: m.RaisedByID, Status: m.Status,
		AnswerMessageID: m.AnswerMessageID, AnswerText: m.AnswerText,
		CreatedAt: m.CreatedAt.UnixMilli(), UpdatedAt: m.UpdatedAt.UnixMilli(),
	}
}

type ParkingLotItem struct {
	ID         string `json:"id"`
	RoomID     string `json:"roomId"`
	Text       string `json:"text"`
	RaisedByID string `json:"raisedById,omitempty"`
	Resolution string `json:"resolution"`
	CreatedAt  int64  `json:"createdAt"`
	UpdatedAt  int64  `json:"updatedAt"`
}

func ParkingLotItemFromModel(m *database.AgentRoomParkingLot) ParkingLotItem {
	return ParkingLotItem{
		ID: m.ID, RoomID: m.RoomID, Text: m.Text, RaisedByID: m.RaisedByID,
		Resolution: m.Resolution, CreatedAt: m.CreatedAt.UnixMilli(), UpdatedAt: m.UpdatedAt.UnixMilli(),
	}
}

type Risk struct {
	ID           string `json:"id"`
	RoomID       string `json:"roomId"`
	Text         string `json:"text"`
	Severity     string `json:"severity"`
	OwnerID      string `json:"ownerId,omitempty"`
	Status       string `json:"status"`
	ParentRiskID string `json:"parentRiskId,omitempty"` // v0.3 主题 C：跨房间血缘
	CreatedAt    int64  `json:"createdAt"`
	UpdatedAt    int64  `json:"updatedAt"`
}

func RiskFromModel(m *database.AgentRoomRisk) Risk {
	return Risk{
		ID: m.ID, RoomID: m.RoomID, Text: m.Text, Severity: m.Severity,
		OwnerID: m.OwnerID, Status: m.Status,
		ParentRiskID: m.ParentRiskID,
		CreatedAt:    m.CreatedAt.UnixMilli(), UpdatedAt: m.UpdatedAt.UnixMilli(),
	}
}

// ─────────── Vote ───────────

type Vote struct {
	ID           string       `json:"id"`
	RoomID       string       `json:"roomId"`
	AgendaItemID string       `json:"agendaItemId,omitempty"`
	Question     string       `json:"question"`
	Options      []string     `json:"options"`
	Mode         string       `json:"mode"`
	VoterIDs     []string     `json:"voterIds"`
	Status       string       `json:"status"`
	Result       string       `json:"result,omitempty"`
	InitiatorID  string       `json:"initiatorId,omitempty"`
	Ballots      []VoteBallot `json:"ballots"`
	ClosedAt     *int64       `json:"closedAt,omitempty"`
	CreatedAt    int64        `json:"createdAt"`
	UpdatedAt    int64        `json:"updatedAt"`
}

type VoteBallot struct {
	VoteID    string `json:"voteId"`
	VoterID   string `json:"voterId"`
	Choice    string `json:"choice"`
	Rationale string `json:"rationale,omitempty"`
	CreatedAt int64  `json:"createdAt"`
}

func VoteFromModel(m *database.AgentRoomVote, ballots []database.AgentRoomVoteBallot) Vote {
	opts := []string{}
	if m.OptionsJSON != "" {
		_ = json.Unmarshal([]byte(m.OptionsJSON), &opts)
	}
	voters := []string{}
	if m.VoterIDsJSON != "" {
		_ = json.Unmarshal([]byte(m.VoterIDsJSON), &voters)
	}
	bs := make([]VoteBallot, 0, len(ballots))
	for _, b := range ballots {
		bs = append(bs, VoteBallot{
			VoteID: b.VoteID, VoterID: b.VoterID, Choice: b.Choice,
			Rationale: b.Rationale, CreatedAt: b.CreatedAt.UnixMilli(),
		})
	}
	return Vote{
		ID: m.ID, RoomID: m.RoomID, AgendaItemID: m.AgendaItemID,
		Question: m.Question, Options: opts, Mode: m.Mode, VoterIDs: voters,
		Status: m.Status, Result: m.Result, InitiatorID: m.InitiatorID,
		Ballots:   bs,
		ClosedAt:  m.ClosedAt,
		CreatedAt: m.CreatedAt.UnixMilli(), UpdatedAt: m.UpdatedAt.UnixMilli(),
	}
}

const (
	VoteModeMajority  = "majority"
	VoteModeUnanimous = "unanimous"
	VoteStatusOpen    = "open"
	VoteStatusClosed  = "closed"
)

// ─────────── Retro / NextMeeting ───────────

type NextMeetingDraft struct {
	Title       string   `json:"title"`
	Goal        string   `json:"goal"`
	TemplateID  string   `json:"templateId,omitempty"`
	AgendaItems []string `json:"agendaItems"`
	InviteRoles []string `json:"inviteRoles"`
	SuggestedAt string   `json:"suggestedAt,omitempty"` // e.g. "1 week later"

	// v0.2 GAP G6：结构化继承字段。让续会能精确引用源会的工作单 / 风险，
	// 而不只是 LLM 生成的纯文本议程。前端 CreateRoomWizard 收到 draft 后可：
	//   - 顶部展示"续自 [源房间]"
	//   - 列出未完成任务 / 返工任务 / 风险，让用户勾选哪些带入新房间
	// 无相关项时为空数组（保持 JSON 形状稳定）。
	SourceRoomID      string   `json:"sourceRoomId,omitempty"`
	UnfinishedTaskIDs []string `json:"unfinishedTaskIds"`
	ReworkTaskIDs     []string `json:"reworkTaskIds"`
	RiskIDs           []string `json:"riskIds"`
}

type Retro struct {
	RoomID               string            `json:"roomId"`
	ScoreOverall         int               `json:"scoreOverall"`
	ScoreGoal            int               `json:"scoreGoal"`
	ScoreQuality         int               `json:"scoreQuality"`
	ScoreDecisionClarity int               `json:"scoreDecisionClarity"`
	ScoreEfficiency      int               `json:"scoreEfficiency"`
	OffTopicRate         int               `json:"offTopicRate"`
	Highlights           []string          `json:"highlights"`
	Lowlights            []string          `json:"lowlights"`
	Summary              string            `json:"summary,omitempty"`
	NextMeetingDraft     *NextMeetingDraft `json:"nextMeetingDraft,omitempty"`
	OutcomeArtifactID    string            `json:"outcomeArtifactId,omitempty"`
	MinutesArtifactID    string            `json:"minutesArtifactId,omitempty"`
	PlaybookID           string            `json:"playbookId,omitempty"`
	GeneratedAt          int64             `json:"generatedAt"`
	UpdatedAt            int64             `json:"updatedAt"`
}

func RetroFromModel(m *database.AgentRoomRetro) Retro {
	hi := []string{}
	lo := []string{}
	if m.HighlightsJSON != "" {
		_ = json.Unmarshal([]byte(m.HighlightsJSON), &hi)
	}
	if m.LowlightsJSON != "" {
		_ = json.Unmarshal([]byte(m.LowlightsJSON), &lo)
	}
	var nmd *NextMeetingDraft
	if strings.TrimSpace(m.NextMeetingDraftJSON) != "" {
		var d NextMeetingDraft
		if err := json.Unmarshal([]byte(m.NextMeetingDraftJSON), &d); err == nil {
			nmd = &d
		}
	}
	return Retro{
		RoomID: m.RoomID, ScoreOverall: m.ScoreOverall, ScoreGoal: m.ScoreGoal,
		ScoreQuality: m.ScoreQuality, ScoreDecisionClarity: m.ScoreDecisionClarity,
		ScoreEfficiency: m.ScoreEfficiency, OffTopicRate: m.OffTopicRate,
		Highlights: hi, Lowlights: lo, Summary: m.Summary,
		NextMeetingDraft:  nmd,
		OutcomeArtifactID: m.OutcomeArtifactID, MinutesArtifactID: m.MinutesArtifactID,
		PlaybookID: m.PlaybookID, GeneratedAt: m.GeneratedAt,
		UpdatedAt: m.UpdatedAt.UnixMilli(),
	}
}

// ─────────── Playbook 扩展 DTO (v0.7) ───────────

// PlaybookV7 —— 在 v0.6 的 Playbook 基础上增加 tags/appliesTo/steps/usage 字段。
// 原 Playbook 保留向下兼容；前端新版经验库使用 PlaybookV7 完整结构。
type PlaybookV7 struct {
	ID           string         `json:"id"`
	OwnerUserID  uint           `json:"ownerUserId"`
	SourceRoomID string         `json:"sourceRoomId,omitempty"`
	Title        string         `json:"title"`
	Problem      string         `json:"problem"`
	Approach     string         `json:"approach"`
	Conclusion   string         `json:"conclusion"`
	Category     string         `json:"category,omitempty"`
	Tags         []string       `json:"tags"`
	AppliesTo    []string       `json:"appliesTo"`
	Steps        []PlaybookStep `json:"steps"`
	UsageCount   int            `json:"usageCount"`
	AppliedRooms []string       `json:"appliedRooms"`
	Version      int            `json:"version"`
	IsFavorite   bool           `json:"isFavorite,omitempty"`
	CreatedAt    int64          `json:"createdAt"`
	UpdatedAt    int64          `json:"updatedAt"`
}

func PlaybookV7FromModel(m *database.AgentRoomPlaybook) PlaybookV7 {
	tags := []string{}
	if m.TagsJSON != "" {
		_ = json.Unmarshal([]byte(m.TagsJSON), &tags)
	}
	applies := []string{}
	if m.AppliesToJSON != "" {
		_ = json.Unmarshal([]byte(m.AppliesToJSON), &applies)
	}
	steps := []PlaybookStep{}
	if m.StepsJSON != "" {
		_ = json.Unmarshal([]byte(m.StepsJSON), &steps)
	}
	rooms := []string{}
	if m.AppliedRoomsJSON != "" {
		_ = json.Unmarshal([]byte(m.AppliedRoomsJSON), &rooms)
	}
	v := m.Version
	if v == 0 {
		v = 1
	}
	return PlaybookV7{
		ID: m.ID, OwnerUserID: m.OwnerUserID, SourceRoomID: m.SourceRoomID,
		Title: m.Title, Problem: m.Problem, Approach: m.Approach, Conclusion: m.Conclusion,
		Category: m.Category, Tags: tags, AppliesTo: applies, Steps: steps,
		UsageCount: m.UsageCount, AppliedRooms: rooms, Version: v,
		IsFavorite: m.IsFavorite,
		CreatedAt:  m.CreatedAt.UnixMilli(), UpdatedAt: m.UpdatedAt.UnixMilli(),
	}
}

// marshalStringSliceNullable —— JSON 编码 []string；空返回空字符串以让列保持 NULL 友好。
func marshalStringSliceNullable(s []string) string {
	if len(s) == 0 {
		return ""
	}
	b, _ := json.Marshal(s)
	return string(b)
}

func marshalStepsNullable(s []PlaybookStep) string {
	if len(s) == 0 {
		return ""
	}
	b, _ := json.Marshal(s)
	return string(b)
}

// ─────────── OutcomeBundle ───────────

// OutcomeBundle —— 关闭仪式产出的打包物。以 Artifact kind="outcome_bundle" 存储。
// Content 里是完整 markdown；Metadata 是结构化引用（纪要 ID / todo ID 列表 / 决策 ID 列表 / playbook ID）。
type OutcomeBundle struct {
	RoomID            string   `json:"roomId"`
	Title             string   `json:"title"`
	GeneratedAt       int64    `json:"generatedAt"`
	MinutesArtifactID string   `json:"minutesArtifactId,omitempty"`
	BundleArtifactID  string   `json:"bundleArtifactId,omitempty"`
	PlaybookID        string   `json:"playbookId,omitempty"`
	TaskIDs           []string `json:"taskIds"`
	DecisionIDs       []string `json:"decisionIds"`
	AgendaOutcomes    []string `json:"agendaOutcomes"`
	Retro             *Retro   `json:"retro,omitempty"`
	MarkdownBody      string   `json:"markdownBody,omitempty"` // 完整 md，前端可直接渲染
}
