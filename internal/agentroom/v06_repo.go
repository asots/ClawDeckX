package agentroom

import (
	"encoding/json"
	"errors"
	"time"

	"gorm.io/gorm"

	"ClawDeckX/internal/database"
)

// v0.6 Repo 方法 —— Artifact / Playbook / PersonaMemory / Decision promote。
// 所有函数都是 Repo 方法集的扩展；保持与 repo.go 相同的风格（gorm 直接操作）。

// ── Artifact ──

func (r *Repo) CreateArtifact(a *database.AgentRoomArtifact) error {
	if a.ID == "" {
		a.ID = GenID("art")
	}
	if a.Kind == "" {
		a.Kind = "markdown"
	}
	if a.Version == 0 {
		a.Version = 1
	}
	return database.DB.Create(a).Error
}

func (r *Repo) UpdateArtifact(id string, patch map[string]any) error {
	patch["updated_at"] = time.Now()
	return database.DB.Model(&database.AgentRoomArtifact{}).Where("id = ?", id).Updates(patch).Error
}

func (r *Repo) GetArtifact(id string) (*database.AgentRoomArtifact, error) {
	var a database.AgentRoomArtifact
	if err := database.DB.First(&a, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &a, nil
}

func (r *Repo) ListArtifacts(roomID string) ([]database.AgentRoomArtifact, error) {
	var as []database.AgentRoomArtifact
	return as, database.DB.Where("room_id = ?", roomID).Order("updated_at DESC").Find(&as).Error
}

func (r *Repo) DeleteArtifact(id string) error {
	return database.DB.Delete(&database.AgentRoomArtifact{}, "id = ?", id).Error
}

// ── Decision promote ──
//
// 给现有 message 打上 is_decision + summary。如果传空 summary 则不更新 summary。
func (r *Repo) PromoteMessageToDecision(messageID, summary string) error {
	patch := map[string]any{"is_decision": true, "kind": MsgKindDecision}
	if summary != "" {
		patch["decision_summary"] = summary
	}
	return database.DB.Model(&database.AgentRoomMessage{}).
		Where("id = ?", messageID).Updates(patch).Error
}

// DemoteDecision 撤销决策锚标记（回到 chat 类型）。
func (r *Repo) DemoteDecision(messageID string) error {
	return database.DB.Model(&database.AgentRoomMessage{}).
		Where("id = ?", messageID).
		Updates(map[string]any{"is_decision": false, "kind": MsgKindChat, "decision_summary": ""}).Error
}

// ListDecisions 返回房间内所有 is_decision=true 的消息，按 seq 升序。
func (r *Repo) ListDecisions(roomID string) ([]database.AgentRoomMessage, error) {
	var ms []database.AgentRoomMessage
	return ms, database.DB.Where("room_id = ? AND is_decision = ?", roomID, true).
		Order("seq ASC").Find(&ms).Error
}

// ── Playbook ──

func (r *Repo) CreatePlaybook(p *database.AgentRoomPlaybook) error {
	if p.ID == "" {
		p.ID = GenID("pb")
	}
	return database.DB.Create(p).Error
}

func (r *Repo) ListPlaybooks(ownerUserID uint) ([]database.AgentRoomPlaybook, error) {
	var ps []database.AgentRoomPlaybook
	q := database.DB.Order("created_at DESC")
	if ownerUserID > 0 {
		q = q.Where("owner_user_id = ?", ownerUserID)
	}
	return ps, q.Find(&ps).Error
}

func (r *Repo) GetPlaybook(id string) (*database.AgentRoomPlaybook, error) {
	var p database.AgentRoomPlaybook
	if err := database.DB.First(&p, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &p, nil
}

func (r *Repo) DeletePlaybook(id string) error {
	return database.DB.Delete(&database.AgentRoomPlaybook{}, "id = ?", id).Error
}

func (r *Repo) UpdatePlaybook(id string, patch map[string]any) error {
	return database.DB.Model(&database.AgentRoomPlaybook{}).Where("id = ?", id).Updates(patch).Error
}

// MarshalPlaybookTags helper
func MarshalPlaybookTags(tags []string) string {
	if len(tags) == 0 {
		return ""
	}
	b, _ := json.Marshal(tags)
	return string(b)
}

// ── PersonaMemory ──

func (r *Repo) GetPersonaMemory(memoryKey string) (*database.AgentRoomPersonaMemory, error) {
	if memoryKey == "" {
		return nil, nil
	}
	var m database.AgentRoomPersonaMemory
	if err := database.DB.First(&m, "memory_key = ?", memoryKey).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &m, nil
}

// UpsertPersonaMemory 写入或覆盖；content 太大会被截断到 64 KB（runes）防爆。
func (r *Repo) UpsertPersonaMemory(memoryKey string, ownerUserID uint, content string) error {
	if memoryKey == "" {
		return errors.New("memoryKey required")
	}
	// 截断
	runes := []rune(content)
	if len(runes) > 64*1024 {
		runes = runes[:64*1024]
		content = string(runes) + "\n…(truncated)"
	}
	now := time.Now()
	m := &database.AgentRoomPersonaMemory{
		MemoryKey:   memoryKey,
		OwnerUserID: ownerUserID,
		Content:     content,
		SizeBytes:   int64(len(content)),
		UpdatedAt:   now,
		CreatedAt:   now,
	}
	return database.DB.Save(m).Error
}

func (r *Repo) AppendPersonaMemory(memoryKey string, ownerUserID uint, addition string) error {
	existing, err := r.GetPersonaMemory(memoryKey)
	if err != nil {
		return err
	}
	merged := addition
	if existing != nil && existing.Content != "" {
		merged = existing.Content + "\n\n" + addition
	}
	return r.UpsertPersonaMemory(memoryKey, ownerUserID, merged)
}

func (r *Repo) DeletePersonaMemory(memoryKey string) error {
	return database.DB.Delete(&database.AgentRoomPersonaMemory{}, "memory_key = ?", memoryKey).Error
}

func (r *Repo) ListPersonaMemories(ownerUserID uint) ([]database.AgentRoomPersonaMemory, error) {
	var ms []database.AgentRoomPersonaMemory
	q := database.DB.Order("updated_at DESC")
	if ownerUserID > 0 {
		q = q.Where("owner_user_id = ?", ownerUserID)
	}
	return ms, q.Find(&ms).Error
}

// IncrementRoundsUsed 原子 +1；配合 RoundBudget 决定是否触发收敛提示。
func (r *Repo) IncrementRoundsUsed(roomID string) error {
	return database.DB.Model(&database.AgentRoom{}).
		Where("id = ?", roomID).
		UpdateColumn("rounds_used", gorm.Expr("rounds_used + 1")).Error
}
