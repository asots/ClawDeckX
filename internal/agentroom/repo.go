package agentroom

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"ClawDeckX/internal/database"
	"ClawDeckX/internal/logger"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// Repo 封装 AgentRoom 的 GORM 持久层。所有方法都使用全局 database.DB。
type Repo struct{}

func NewRepo() *Repo { return &Repo{} }

// SanitizeLegacyMemberModels 一次性迁移：清空 agentroom_members.model 中历史模板遗留的
// 硬编码模型名（claude-sonnet-4.5 / claude-opus-4 / claude-haiku-4）。这些值在 OpenClaw
// 侧并不存在，会导致 agent 返回空回复。清空后成员会自动使用所在 agent 的默认模型。
//
// 幂等：已经为空或不在列表中的行不动；只会更新到当前 DB 里存在的遗留脏数据。
func (r *Repo) SanitizeLegacyMemberModels() (int64, error) {
	legacy := []string{"claude-sonnet-4.5", "claude-sonnet-4", "claude-opus-4", "claude-haiku-4"}
	res := database.DB.Model(&database.AgentRoomMember{}).
		Where("model IN ?", legacy).
		Update("model", "")
	if res.Error != nil {
		return 0, res.Error
	}
	return res.RowsAffected, nil
}

// ── ID ──

func GenID(prefix string) string {
	b := make([]byte, 10)
	_, _ = rand.Read(b)
	return prefix + "_" + hex.EncodeToString(b)
}

// ── Room ──

func (r *Repo) CreateRoom(m *database.AgentRoom) error {
	return database.DB.Create(m).Error
}

func (r *Repo) GetRoom(id string) (*database.AgentRoom, error) {
	var m database.AgentRoom
	if err := database.DB.First(&m, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &m, nil
}

func (r *Repo) UpdateRoom(id string, patch map[string]any) error {
	patch["updated_at"] = time.Now()
	return database.DB.Model(&database.AgentRoom{}).Where("id = ?", id).Updates(patch).Error
}

func (r *Repo) ListRooms(ownerUserID uint) ([]database.AgentRoom, error) {
	var rs []database.AgentRoom
	q := database.DB.Order("updated_at DESC")
	if ownerUserID > 0 {
		q = q.Where("owner_user_id = ? OR owner_user_id = 0", ownerUserID)
	}
	return rs, q.Find(&rs).Error
}

func (r *Repo) UpsertRoleProfile(m *database.AgentRoomRoleProfile) error {
	return database.DB.Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "id"}},
		DoUpdates: clause.AssignmentColumns([]string{
			"owner_user_id", "slug", "name", "role", "emoji", "description", "category",
			"system_prompt", "style_prompt", "model", "agent_id", "thinking",
			"memory_key", "is_moderator", "stance", "interaction_profile_json", "builtin",
			"visibility", "sort_order", "updated_at",
		}),
	}).Create(m).Error
}

func (r *Repo) CountBuiltInRoleProfiles() (int64, error) {
	var count int64
	err := database.DB.Model(&database.AgentRoomRoleProfile{}).Where("builtin = ?", true).Count(&count).Error
	return count, err
}

func (r *Repo) SeedBuiltInRoleProfiles(items []database.AgentRoomRoleProfile) error {
	for i := range items {
		items[i].Builtin = true
		items[i].OwnerUserID = 0
		if items[i].Visibility == "" {
			items[i].Visibility = "shared"
		}
		if err := r.UpsertRoleProfile(&items[i]); err != nil {
			return err
		}
	}
	return nil
}

func (r *Repo) CreateRoleProfile(m *database.AgentRoomRoleProfile) error {
	return database.DB.Create(m).Error
}

func (r *Repo) UpdateRoleProfile(id string, ownerUserID uint, patch map[string]any) error {
	patch["updated_at"] = time.Now()
	q := database.DB.Model(&database.AgentRoomRoleProfile{}).Where("id = ?", id)
	if ownerUserID > 0 {
		q = q.Where("owner_user_id = ? OR builtin = ?", ownerUserID, true)
	}
	return q.Updates(patch).Error
}

func (r *Repo) DeleteRoleProfile(id string, ownerUserID uint) error {
	q := database.DB.Where("id = ?", id)
	if ownerUserID > 0 {
		q = q.Where("owner_user_id = ? AND builtin = ?", ownerUserID, false)
	}
	return q.Delete(&database.AgentRoomRoleProfile{}).Error
}

func (r *Repo) GetRoleProfile(id string, ownerUserID uint) (*database.AgentRoomRoleProfile, error) {
	var m database.AgentRoomRoleProfile
	q := database.DB.Where("id = ?", id)
	if ownerUserID > 0 {
		q = q.Where("owner_user_id = ? OR builtin = ?", ownerUserID, true)
	}
	if err := q.First(&m).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &m, nil
}

func (r *Repo) ListRoleProfiles(ownerUserID uint, category string) ([]database.AgentRoomRoleProfile, error) {
	var items []database.AgentRoomRoleProfile
	q := database.DB.Order("builtin DESC, sort_order ASC, updated_at DESC")
	if ownerUserID > 0 {
		q = q.Where("owner_user_id = ? OR builtin = ?", ownerUserID, true)
	}
	if category != "" {
		q = q.Where("category = ?", category)
	}
	return items, q.Find(&items).Error
}

// DeleteRoom 事务级删除房间及所有关联数据。
//
// 关键点：
//  1. 先删所有子表，最后删父表（AgentRoom） —— 避免将来启用外键约束时失败；
//     也方便中间任一步骤失败时不会出现"父没了、子残留"的幽灵数据。
//  2. 必须覆盖所有与 room_id 关联的表，否则会命中 FTS5 触发器残留 / 唯一约束冲突
//     导致"数据库查询失败"。
//  3. 每步 error 用 fmt.Errorf 注明来源表名，便于定位哪一步挂了。
//
// 自愈策略（v0.7+）：
//
//	删消息时会触发 FTS5 `agentroom_msg_ad` 触发器；如果 FTS5 shadow 表坏了，
//	整个事务会返回 SQLITE_CORRUPT_VTAB (267, "database disk image is malformed")。
//	之前用户要手动重启才能恢复。现在：第一次失败如果判定是 FTS 损坏，自动
//	调 HardResetMessagesFTS() 重建 FTS，然后重试一次 —— 99% 的场景用户感知不到错误。
func (r *Repo) DeleteRoom(id string) error {
	err := r.deleteRoomTx(id)
	if err == nil {
		return nil
	}
	// 仅在 FTS 损坏类错误上自愈 + 重试一次；其它错误（外键、IO 等）原样返回。
	// 不做多次重试，避免把一个无法恢复的数据库打到 100% CPU。
	if !IsFTSCorruptError(err) {
		return err
	}
	logger.Log.Warn().Err(err).Str("room_id", id).Msg("agentroom: delete room hit corrupt FTS, trying hard reset")
	if resetErr := HardResetMessagesFTS(); resetErr != nil {
		logger.Log.Warn().Err(resetErr).Str("room_id", id).Msg("agentroom: hard reset during delete failed, falling back to FTS-bypass delete")
		fallbackErr := r.deleteRoomBypassingFTS(id)
		if fallbackErr != nil {
			return fmt.Errorf("%w; FTS hard-reset also failed: %v; FTS-bypass delete also failed: %v", err, resetErr, fallbackErr)
		}
		logger.Log.Warn().Str("room_id", id).Msg("agentroom: room deleted via FTS-bypass fallback after hard reset failure")
		return nil
	}
	logger.Log.Info().Str("room_id", id).Msg("agentroom: hard reset complete during delete, retrying room deletion")
	// 重建完 FTS 后再试一次
	retryErr := r.deleteRoomTx(id)
	if retryErr == nil {
		logger.Log.Info().Str("room_id", id).Msg("agentroom: room delete succeeded after FTS hard reset")
		return nil
	}
	if !IsFTSCorruptError(retryErr) {
		return retryErr
	}
	logger.Log.Warn().Err(retryErr).Str("room_id", id).Msg("agentroom: room delete still hits corrupt FTS after reset, falling back to FTS-bypass delete")
	return r.deleteRoomBypassingFTS(id)
}

// deleteRoomTx 真正的删除事务，从 DeleteRoom 拆出来方便"失败 → 重置 FTS → 再调一次"。
func (r *Repo) deleteRoomTx(id string) error {
	return database.DB.Transaction(func(tx *gorm.DB) error {
		// 消息：先删（FTS5 触发器 agentroom_msg_ad 会同步维护全文索引）
		if err := tx.Delete(&database.AgentRoomMessage{}, "room_id = ?", id).Error; err != nil {
			return fmt.Errorf("delete messages: %w", err)
		}
		if err := tx.Delete(&database.AgentRoomMember{}, "room_id = ?", id).Error; err != nil {
			return fmt.Errorf("delete members: %w", err)
		}
		if err := tx.Delete(&database.AgentRoomFact{}, "room_id = ?", id).Error; err != nil {
			return fmt.Errorf("delete facts: %w", err)
		}
		if err := tx.Delete(&database.AgentRoomTask{}, "room_id = ?", id).Error; err != nil {
			return fmt.Errorf("delete tasks: %w", err)
		}
		if err := tx.Delete(&database.AgentRoomIntervention{}, "room_id = ?", id).Error; err != nil {
			return fmt.Errorf("delete interventions: %w", err)
		}
		// v0.6 补齐：artifacts / docs / doc_chunks / audits / playbooks。
		// 先删 doc_chunks（依赖 doc_id）再删 docs。
		if err := tx.Delete(&database.AgentRoomDocChunk{}, "room_id = ?", id).Error; err != nil {
			return fmt.Errorf("delete doc_chunks: %w", err)
		}
		if err := tx.Delete(&database.AgentRoomDoc{}, "room_id = ?", id).Error; err != nil {
			return fmt.Errorf("delete docs: %w", err)
		}
		if err := tx.Delete(&database.AgentRoomArtifact{}, "room_id = ?", id).Error; err != nil {
			return fmt.Errorf("delete artifacts: %w", err)
		}
		if err := tx.Delete(&database.AgentRoomAudit{}, "room_id = ?", id).Error; err != nil {
			return fmt.Errorf("delete audits: %w", err)
		}
		// Playbook 用 source_room_id 关联源房间（便于跨房复用）。
		// 删房间时把「从此房产生」的 playbook 一并清掉，防止引用死指针。
		if err := tx.Delete(&database.AgentRoomPlaybook{}, "source_room_id = ?", id).Error; err != nil {
			return fmt.Errorf("delete playbooks: %w", err)
		}
		// 最后删父表
		if err := tx.Delete(&database.AgentRoom{}, "id = ?", id).Error; err != nil {
			return fmt.Errorf("delete room: %w", err)
		}
		return nil
	})
}

func (r *Repo) deleteRoomBypassingFTS(id string) error {
	logger.Log.Warn().Str("room_id", id).Msg("agentroom: starting FTS-bypass room delete")
	if err := DropMessagesFTSTriggers(); err != nil {
		return fmt.Errorf("drop message fts triggers: %w", err)
	}
	deleteErr := r.deleteRoomTx(id)
	rebuildErr := EnsureFTS()
	if deleteErr != nil {
		if rebuildErr != nil {
			return fmt.Errorf("%w; ensure FTS after bypass delete failed: %v", deleteErr, rebuildErr)
		}
		return deleteErr
	}
	if rebuildErr != nil {
		return fmt.Errorf("room deleted but ensure FTS after bypass delete failed: %w", rebuildErr)
	}
	logger.Log.Warn().Str("room_id", id).Msg("agentroom: FTS-bypass room delete complete and FTS rebuilt")
	return nil
}

// ── Member ──

func (r *Repo) CreateMember(m *database.AgentRoomMember) error {
	return database.DB.Create(m).Error
}

func (r *Repo) UpdateMember(id string, patch map[string]any) error {
	patch["updated_at"] = time.Now()
	return database.DB.Model(&database.AgentRoomMember{}).Where("id = ?", id).Updates(patch).Error
}

func (r *Repo) ListMembers(roomID string) ([]database.AgentRoomMember, error) {
	var ms []database.AgentRoomMember
	return ms, database.DB.Where("room_id = ?", roomID).Order("created_at ASC").Find(&ms).Error
}

func (r *Repo) GetMember(id string) (*database.AgentRoomMember, error) {
	var m database.AgentRoomMember
	if err := database.DB.First(&m, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &m, nil
}

// DeleteMember 真删除单个成员。cascade=true 时连带删除该成员发出的所有消息，
// cascade=false 时仅删除成员记录、保留历史消息（消息的 authorId 仍然指向已删除的成员 ID，
// 前端会用灰化展示，类似"已退出成员"）。
// 同时清理该成员被分配到的 tasks（assignee_id 置空，不删 task）。
func (r *Repo) DeleteMember(id string, cascade bool) error {
	return database.DB.Transaction(func(tx *gorm.DB) error {
		if cascade {
			if err := tx.Delete(&database.AgentRoomMessage{}, "author_id = ?", id).Error; err != nil {
				return fmt.Errorf("delete member messages: %w", err)
			}
		}
		// 被此成员指派的 tasks → 解除 assignee（不删 task）
		if err := tx.Model(&database.AgentRoomTask{}).Where("assignee_id = ?", id).
			Update("assignee_id", "").Error; err != nil {
			return fmt.Errorf("unassign tasks: %w", err)
		}
		if err := tx.Delete(&database.AgentRoomMember{}, "id = ?", id).Error; err != nil {
			return fmt.Errorf("delete member: %w", err)
		}
		return nil
	})
}

// ── Message ──

func (r *Repo) CreateMessage(m *database.AgentRoomMessage) error {
	if m.ID == "" {
		m.ID = GenID("msg")
	}
	if m.Timestamp == 0 {
		m.Timestamp = NowMs()
	}
	// 手动维护 seq（GORM SQLite 对非 PK 列的 autoincrement 不生效）
	if m.Seq == 0 && m.RoomID != "" {
		m.Seq = r.NextMessageSeq(m.RoomID)
	}
	return database.DB.Create(m).Error
}

func (r *Repo) UpdateMessage(id string, patch map[string]any) error {
	return database.DB.Model(&database.AgentRoomMessage{}).Where("id = ?", id).Updates(patch).Error
}

func (r *Repo) GetMessage(id string) (*database.AgentRoomMessage, error) {
	var m database.AgentRoomMessage
	if err := database.DB.First(&m, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &m, nil
}

// ListMessages 按时间顺序返回某房间的消息。若 afterSeq > 0 则只返回其之后的。
func (r *Repo) ListMessages(roomID string, afterSeq int64, limit int) ([]database.AgentRoomMessage, error) {
	var ms []database.AgentRoomMessage
	q := database.DB.Where("room_id = ?", roomID).Order("seq ASC")
	if afterSeq > 0 {
		q = q.Where("seq > ?", afterSeq)
	}
	if limit > 0 {
		q = q.Limit(limit)
	}
	return ms, q.Find(&ms).Error
}

// ── Fact ──

func (r *Repo) UpsertFact(f *database.AgentRoomFact) error {
	f.UpdatedAt = NowMs()
	return database.DB.Exec(
		"INSERT INTO agentroom_facts (room_id, key, value, author_id, updated_at, created_at) "+
			"VALUES (?, ?, ?, ?, ?, ?) "+
			"ON CONFLICT(room_id, key) DO UPDATE SET value=excluded.value, author_id=excluded.author_id, updated_at=excluded.updated_at",
		f.RoomID, f.Key, f.Value, f.AuthorID, f.UpdatedAt, time.Now(),
	).Error
}

func (r *Repo) DeleteFact(roomID, key string) error {
	return database.DB.Delete(&database.AgentRoomFact{}, "room_id = ? AND key = ?", roomID, key).Error
}

func (r *Repo) ListFacts(roomID string) ([]database.AgentRoomFact, error) {
	var fs []database.AgentRoomFact
	return fs, database.DB.Where("room_id = ?", roomID).Order("updated_at DESC").Find(&fs).Error
}

// ── Task ──

func (r *Repo) CreateTask(t *database.AgentRoomTask) error {
	if t.ID == "" {
		t.ID = GenID("task")
	}
	return database.DB.Create(t).Error
}

func (r *Repo) UpdateTask(id string, patch map[string]any) error {
	patch["updated_at"] = time.Now()
	return database.DB.Model(&database.AgentRoomTask{}).Where("id = ?", id).Updates(patch).Error
}

func (r *Repo) ListTasks(roomID string) ([]database.AgentRoomTask, error) {
	var ts []database.AgentRoomTask
	return ts, database.DB.Where("room_id = ?", roomID).Order("created_at ASC").Find(&ts).Error
}

func (r *Repo) DeleteTask(id string) error {
	return database.DB.Delete(&database.AgentRoomTask{}, "id = ?", id).Error
}

// ── TaskExecution（v0.2 GAP G4）──

func (r *Repo) CreateTaskExecution(e *database.AgentRoomTaskExecution) error {
	if e.ID == "" {
		e.ID = GenID("texe")
	}
	return database.DB.Create(e).Error
}

func (r *Repo) UpdateTaskExecution(id string, patch map[string]any) error {
	patch["updated_at"] = time.Now()
	return database.DB.Model(&database.AgentRoomTaskExecution{}).Where("id = ?", id).Updates(patch).Error
}

func (r *Repo) GetTaskExecution(id string) (*database.AgentRoomTaskExecution, error) {
	var e database.AgentRoomTaskExecution
	if err := database.DB.First(&e, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &e, nil
}

// ListTaskExecutions 返回某任务的全部执行记录，按 created_at 升序（旧 → 新）。
func (r *Repo) ListTaskExecutions(taskID string) ([]database.AgentRoomTaskExecution, error) {
	var es []database.AgentRoomTaskExecution
	return es, database.DB.Where("task_id = ?", taskID).Order("created_at ASC").Find(&es).Error
}

// FindActiveTaskExecution 返回最新一条非终态 execution（queued/running），无则 nil。
func (r *Repo) FindActiveTaskExecution(taskID string) (*database.AgentRoomTaskExecution, error) {
	var e database.AgentRoomTaskExecution
	err := database.DB.Where("task_id = ? AND status IN ?", taskID, []string{"queued", "running"}).
		Order("created_at DESC").Limit(1).First(&e).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &e, nil
}

// ResetStaleStreaming 把所有 streaming=true 的消息重置为 false（启动时调用）。
// 避免 DeckX 半途崩溃/重启后有"永远在说话"的消息。
func (r *Repo) ResetStaleStreaming() (int64, error) {
	res := database.DB.Model(&database.AgentRoomMessage{}).
		Where("streaming = ?", true).
		Updates(map[string]any{"streaming": false})
	return res.RowsAffected, res.Error
}

// ListChildRooms 返回 parentRoomID = 给定 id 的所有房间（v0.3 主题 C：跨房间血缘）。
func (r *Repo) ListChildRooms(parentRoomID string) ([]database.AgentRoom, error) {
	if parentRoomID == "" {
		return nil, nil
	}
	var rs []database.AgentRoom
	err := database.DB.Where("parent_room_id = ?", parentRoomID).
		Order("created_at DESC").Find(&rs).Error
	return rs, err
}

// ListTasksByParent 返回所有 parent_task_id = 给定 id 的任务（v0.3 主题 C：跨房间血缘）。
func (r *Repo) ListTasksByParent(parentTaskID string) ([]database.AgentRoomTask, error) {
	if parentTaskID == "" {
		return nil, nil
	}
	var ts []database.AgentRoomTask
	err := database.DB.Where("parent_task_id = ?", parentTaskID).
		Order("created_at ASC").Find(&ts).Error
	return ts, err
}

// ListActiveRoomIDs 返回所有 state='active' 的房间 ID（启动时 warm-up 用）。
func (r *Repo) ListActiveRoomIDs() ([]string, error) {
	var ids []string
	err := database.DB.Model(&database.AgentRoom{}).
		Where("state = ?", StateActive).
		Pluck("id", &ids).Error
	return ids, err
}

// NextMessageSeq 返回房间内 seq 的下一个值（max+1）。
// GORM SQLite autoincrement 对非 PK 列不生效，手动维护。
func (r *Repo) NextMessageSeq(roomID string) int64 {
	var max int64
	database.DB.Model(&database.AgentRoomMessage{}).
		Where("room_id = ?", roomID).
		Select("COALESCE(MAX(seq), 0)").
		Scan(&max)
	return max + 1
}

func (r *Repo) GetTask(id string) (*database.AgentRoomTask, error) {
	var t database.AgentRoomTask
	if err := database.DB.First(&t, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &t, nil
}

// ListMessagesPaged 分页查询：向前（更早）取 limit 条。beforeSeq <= 0 时取最新的 limit 条。
// 返回值按 seq ASC。
func (r *Repo) ListMessagesPaged(roomID string, beforeSeq int64, limit int) ([]database.AgentRoomMessage, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	var ms []database.AgentRoomMessage
	q := database.DB.Where("room_id = ?", roomID)
	if beforeSeq > 0 {
		q = q.Where("seq < ?", beforeSeq)
	}
	if err := q.Order("seq DESC").Limit(limit).Find(&ms).Error; err != nil {
		return nil, err
	}
	for i, j := 0, len(ms)-1; i < j; i, j = i+1, j-1 {
		ms[i], ms[j] = ms[j], ms[i]
	}
	return ms, nil
}

// FindMessageByIdempotency 返回同 room 下同 idempotencyKey 的已落盘消息（若存在）。
func (r *Repo) FindMessageByIdempotency(roomID, key string) (*database.AgentRoomMessage, error) {
	if roomID == "" || key == "" {
		return nil, nil
	}
	var m database.AgentRoomMessage
	err := database.DB.Where("room_id = ? AND idempotency_key = ?", roomID, key).
		Limit(1).First(&m).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &m, nil
}

// FindMessageByExternalID 返回同 room 下同 externalMessageID 的已落盘 projection_in（若存在）。
func (r *Repo) FindMessageByExternalID(roomID, extID string) (*database.AgentRoomMessage, error) {
	if roomID == "" || extID == "" {
		return nil, nil
	}
	var m database.AgentRoomMessage
	err := database.DB.Where("room_id = ? AND external_message_id = ?", roomID, extID).
		Limit(1).First(&m).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &m, nil
}

// ── Audit ──

func (r *Repo) CreateAudit(a *database.AgentRoomAudit) error {
	return database.DB.Create(a).Error
}

// ListAudits 列出房间的审计日志（按时间倒序）。limit<=0 时返回全部（最多 500 条防爆）。
func (r *Repo) ListAudits(roomID string, limit int) ([]database.AgentRoomAudit, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	var as []database.AgentRoomAudit
	return as, database.DB.Where("room_id = ?", roomID).
		Order("created_at DESC").Limit(limit).Find(&as).Error
}

// ── Intervention ──

func (r *Repo) CreateIntervention(iv *database.AgentRoomIntervention) error {
	if iv.ID == "" {
		iv.ID = GenID("iv")
	}
	if iv.At == 0 {
		iv.At = NowMs()
	}
	return database.DB.Create(iv).Error
}

func (r *Repo) ListInterventions(roomID string) ([]database.AgentRoomIntervention, error) {
	var ivs []database.AgentRoomIntervention
	return ivs, database.DB.Where("room_id = ?", roomID).Order("at ASC").Find(&ivs).Error
}

// ── 快照（构建对外 Room DTO）──

func (r *Repo) RoomSnapshot(roomID string) (*Room, error) {
	m, err := r.GetRoom(roomID)
	if err != nil || m == nil {
		if m == nil {
			return nil, fmt.Errorf("room not found: %s", roomID)
		}
		return nil, err
	}
	members, err := r.ListMembers(roomID)
	if err != nil {
		return nil, err
	}
	memberIDs := make([]string, 0, len(members))
	for _, mm := range members {
		memberIDs = append(memberIDs, mm.ID)
	}
	factModels, err := r.ListFacts(roomID)
	if err != nil {
		return nil, err
	}
	facts := make([]Fact, 0, len(factModels))
	for i := range factModels {
		facts = append(facts, FactFromModel(&factModels[i]))
	}
	taskModels, err := r.ListTasks(roomID)
	if err != nil {
		return nil, err
	}
	tasks := make([]Task, 0, len(taskModels))
	for i := range taskModels {
		tasks = append(tasks, TaskFromModel(&taskModels[i]))
	}
	return RoomFromModel(m, memberIDs, facts, tasks), nil
}

// ── Schedule（v1.0 定时会议）──

func (r *Repo) CreateSchedule(s *database.AgentRoomSchedule) error {
	if s.ID == "" {
		s.ID = GenID("sched")
	}
	return database.DB.Create(s).Error
}

func (r *Repo) GetSchedule(id string) (*database.AgentRoomSchedule, error) {
	var s database.AgentRoomSchedule
	if err := database.DB.First(&s, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &s, nil
}

func (r *Repo) ListSchedules(ownerUserID uint) ([]database.AgentRoomSchedule, error) {
	var ss []database.AgentRoomSchedule
	return ss, database.DB.Where("owner_user_id = ?", ownerUserID).Order("created_at DESC").Find(&ss).Error
}

func (r *Repo) UpdateSchedule(id string, patch map[string]any) error {
	return database.DB.Model(&database.AgentRoomSchedule{}).Where("id = ?", id).Updates(patch).Error
}

func (r *Repo) DeleteSchedule(id string) error {
	return database.DB.Delete(&database.AgentRoomSchedule{}, "id = ?", id).Error
}

func (r *Repo) ListDueSchedules(now time.Time) ([]database.AgentRoomSchedule, error) {
	var ss []database.AgentRoomSchedule
	return ss, database.DB.Where("enabled = ? AND next_run_at IS NOT NULL AND next_run_at <= ? AND (last_status IS NULL OR last_status != ?)", true, now, "running").Find(&ss).Error
}
