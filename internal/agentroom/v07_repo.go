package agentroom

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"gorm.io/gorm"

	"ClawDeckX/internal/database"
)

// v0.7 Repo 扩展 —— Agenda / OpenQuestion / ParkingLot / Risk / Vote / Retro
// + Playbook 结构化增强（tags / appliesTo / steps / usage 血缘 / 全文搜索）。
//
// 设计原则：
//   - 所有列表查询按 seq/created_at 升序（议程）或降序（风险/问题），方便前端直接渲染
//   - CRUD 保持 idempotent：同一 ID 重复 upsert 不炸
//   - 跨事务只在 Closeout 这种有原子性要求的流程里用；其它普通 CRUD 不套事务

// ═══════════════ Agenda ═══════════════

func (r *Repo) CreateAgendaItem(a *database.AgentRoomAgendaItem) error {
	if a.ID == "" {
		a.ID = GenID("ag")
	}
	if a.Status == "" {
		a.Status = AgendaStatusPending
	}
	if a.Seq == 0 {
		// 自动 seq = 当前最大 + 1
		var maxSeq int
		_ = database.DB.Model(&database.AgentRoomAgendaItem{}).
			Where("room_id = ?", a.RoomID).
			Select("COALESCE(MAX(seq), 0)").Scan(&maxSeq).Error
		a.Seq = maxSeq + 1
	}
	return database.DB.Create(a).Error
}

func (r *Repo) ListAgendaItems(roomID string) ([]database.AgentRoomAgendaItem, error) {
	var as []database.AgentRoomAgendaItem
	return as, database.DB.Where("room_id = ?", roomID).Order("seq ASC").Find(&as).Error
}

func (r *Repo) GetAgendaItem(id string) (*database.AgentRoomAgendaItem, error) {
	var a database.AgentRoomAgendaItem
	if err := database.DB.First(&a, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &a, nil
}

func (r *Repo) UpdateAgendaItem(id string, patch map[string]any) error {
	patch["updated_at"] = time.Now()
	return database.DB.Model(&database.AgentRoomAgendaItem{}).Where("id = ?", id).Updates(patch).Error
}

func (r *Repo) DeleteAgendaItem(id string) error {
	return database.DB.Delete(&database.AgentRoomAgendaItem{}, "id = ?", id).Error
}

// ReorderAgendaItems 按传入顺序重写 seq（1-indexed）。
func (r *Repo) ReorderAgendaItems(roomID string, orderedIDs []string) error {
	return database.DB.Transaction(func(tx *gorm.DB) error {
		for i, id := range orderedIDs {
			if err := tx.Model(&database.AgentRoomAgendaItem{}).
				Where("id = ? AND room_id = ?", id, roomID).
				Updates(map[string]any{"seq": i + 1, "updated_at": time.Now()}).Error; err != nil {
				return fmt.Errorf("reorder %s: %w", id, err)
			}
		}
		return nil
	})
}

// GetActiveAgendaItem 找出当前 active 的项；没有则返回第一个 pending。nil 表示议程为空或全部完成。
func (r *Repo) GetActiveAgendaItem(roomID string) (*database.AgentRoomAgendaItem, error) {
	var a database.AgentRoomAgendaItem
	err := database.DB.Where("room_id = ? AND status = ?", roomID, AgendaStatusActive).
		Order("seq ASC").First(&a).Error
	if err == nil {
		return &a, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}
	// 退化：找第一个 pending
	err = database.DB.Where("room_id = ? AND status = ?", roomID, AgendaStatusPending).
		Order("seq ASC").First(&a).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &a, err
}

// ═══════════════ OpenQuestion ═══════════════

func (r *Repo) CreateOpenQuestion(q *database.AgentRoomOpenQuestion) error {
	if q.ID == "" {
		q.ID = GenID("oq")
	}
	if q.Status == "" {
		q.Status = "open"
	}
	return database.DB.Create(q).Error
}

func (r *Repo) ListOpenQuestions(roomID string) ([]database.AgentRoomOpenQuestion, error) {
	var qs []database.AgentRoomOpenQuestion
	return qs, database.DB.Where("room_id = ?", roomID).Order("created_at DESC").Find(&qs).Error
}

func (r *Repo) UpdateOpenQuestion(id string, patch map[string]any) error {
	patch["updated_at"] = time.Now()
	return database.DB.Model(&database.AgentRoomOpenQuestion{}).Where("id = ?", id).Updates(patch).Error
}

func (r *Repo) DeleteOpenQuestion(id string) error {
	return database.DB.Delete(&database.AgentRoomOpenQuestion{}, "id = ?", id).Error
}

// ═══════════════ ParkingLot ═══════════════

func (r *Repo) CreateParkingLotItem(p *database.AgentRoomParkingLot) error {
	if p.ID == "" {
		p.ID = GenID("pk")
	}
	if p.Resolution == "" {
		p.Resolution = "pending"
	}
	return database.DB.Create(p).Error
}

func (r *Repo) ListParkingLot(roomID string) ([]database.AgentRoomParkingLot, error) {
	var ps []database.AgentRoomParkingLot
	return ps, database.DB.Where("room_id = ?", roomID).Order("created_at DESC").Find(&ps).Error
}

func (r *Repo) UpdateParkingLotItem(id string, patch map[string]any) error {
	patch["updated_at"] = time.Now()
	return database.DB.Model(&database.AgentRoomParkingLot{}).Where("id = ?", id).Updates(patch).Error
}

func (r *Repo) DeleteParkingLotItem(id string) error {
	return database.DB.Delete(&database.AgentRoomParkingLot{}, "id = ?", id).Error
}

// ═══════════════ Risk ═══════════════

func (r *Repo) CreateRisk(k *database.AgentRoomRisk) error {
	if k.ID == "" {
		k.ID = GenID("rk")
	}
	if k.Severity == "" {
		k.Severity = "mid"
	}
	if k.Status == "" {
		k.Status = "open"
	}
	return database.DB.Create(k).Error
}

func (r *Repo) ListRisks(roomID string) ([]database.AgentRoomRisk, error) {
	var ks []database.AgentRoomRisk
	return ks, database.DB.Where("room_id = ?", roomID).
		Order("CASE severity WHEN 'high' THEN 1 WHEN 'mid' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, created_at DESC").
		Find(&ks).Error
}

func (r *Repo) UpdateRisk(id string, patch map[string]any) error {
	patch["updated_at"] = time.Now()
	return database.DB.Model(&database.AgentRoomRisk{}).Where("id = ?", id).Updates(patch).Error
}

func (r *Repo) DeleteRisk(id string) error {
	return database.DB.Delete(&database.AgentRoomRisk{}, "id = ?", id).Error
}

// ═══════════════ Vote ═══════════════

func (r *Repo) CreateVote(v *database.AgentRoomVote) error {
	if v.ID == "" {
		v.ID = GenID("vt")
	}
	if v.Mode == "" {
		v.Mode = VoteModeMajority
	}
	if v.Status == "" {
		v.Status = VoteStatusOpen
	}
	return database.DB.Create(v).Error
}

func (r *Repo) ListVotes(roomID string) ([]database.AgentRoomVote, error) {
	var vs []database.AgentRoomVote
	return vs, database.DB.Where("room_id = ?", roomID).Order("created_at DESC").Find(&vs).Error
}

func (r *Repo) GetVote(id string) (*database.AgentRoomVote, error) {
	var v database.AgentRoomVote
	if err := database.DB.First(&v, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &v, nil
}

func (r *Repo) UpdateVote(id string, patch map[string]any) error {
	patch["updated_at"] = time.Now()
	return database.DB.Model(&database.AgentRoomVote{}).Where("id = ?", id).Updates(patch).Error
}

func (r *Repo) DeleteVote(id string) error {
	return database.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Delete(&database.AgentRoomVoteBallot{}, "vote_id = ?", id).Error; err != nil {
			return err
		}
		return tx.Delete(&database.AgentRoomVote{}, "id = ?", id).Error
	})
}

// UpsertBallot 同一 voter 重投覆盖旧票；投票关闭后拒绝。
func (r *Repo) UpsertBallot(b *database.AgentRoomVoteBallot) error {
	// 先看投票是否还开着
	vote, err := r.GetVote(b.VoteID)
	if err != nil {
		return err
	}
	if vote == nil {
		return errors.New("投票不存在")
	}
	if vote.Status != VoteStatusOpen {
		return errors.New("投票已关闭")
	}
	// 可选：校验 voter 在 voter_ids 里（空 voter_ids 表示全体 agent 都可投）
	if strings.TrimSpace(vote.VoterIDsJSON) != "" {
		var voters []string
		_ = json.Unmarshal([]byte(vote.VoterIDsJSON), &voters)
		ok := len(voters) == 0
		for _, v := range voters {
			if v == b.VoterID {
				ok = true
				break
			}
		}
		if !ok {
			return errors.New("你没有本次投票权限")
		}
	}
	return database.DB.Save(b).Error
}

func (r *Repo) ListBallots(voteID string) ([]database.AgentRoomVoteBallot, error) {
	var bs []database.AgentRoomVoteBallot
	return bs, database.DB.Where("vote_id = ?", voteID).Order("created_at ASC").Find(&bs).Error
}

// TallyVote —— 关票并计算结果。majority = 得票最多（平票 → 多个以 "/" 拼）；unanimous = 全票同一选项否则为空。
func (r *Repo) TallyVote(id string) (string, error) {
	v, err := r.GetVote(id)
	if err != nil || v == nil {
		return "", errors.New("投票不存在")
	}
	ballots, err := r.ListBallots(id)
	if err != nil {
		return "", err
	}
	if len(ballots) == 0 {
		_ = r.UpdateVote(id, map[string]any{"status": VoteStatusClosed, "result": "", "closed_at": NowMsPtr()})
		return "", nil
	}
	counts := map[string]int{}
	for _, b := range ballots {
		counts[b.Choice]++
	}
	result := ""
	switch v.Mode {
	case VoteModeUnanimous:
		if len(counts) == 1 {
			for k := range counts {
				result = k
			}
		}
	default: // majority
		maxV := 0
		tops := []string{}
		for k, cnt := range counts {
			if cnt > maxV {
				maxV = cnt
				tops = []string{k}
			} else if cnt == maxV {
				tops = append(tops, k)
			}
		}
		result = strings.Join(tops, " / ")
	}
	closed := NowMsPtr()
	_ = r.UpdateVote(id, map[string]any{"status": VoteStatusClosed, "result": result, "closed_at": closed})
	return result, nil
}

// ═══════════════ Retro ═══════════════

func (r *Repo) UpsertRetro(ret *database.AgentRoomRetro) error {
	ret.UpdatedAt = time.Now()
	return database.DB.Save(ret).Error
}

func (r *Repo) GetRetro(roomID string) (*database.AgentRoomRetro, error) {
	var ret database.AgentRoomRetro
	if err := database.DB.First(&ret, "room_id = ?", roomID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &ret, nil
}

func (r *Repo) ListRetros(ownerUserID uint) ([]struct {
	database.AgentRoomRetro
	RoomTitle string
	RoomGoal  string
}, error) {
	type row struct {
		database.AgentRoomRetro
		RoomTitle string `gorm:"column:room_title"`
		RoomGoal  string `gorm:"column:room_goal"`
	}
	var rs []row
	q := database.DB.Table("agentroom_retros AS r").
		Select("r.*, rm.title AS room_title, rm.goal AS room_goal").
		Joins("JOIN agentroom_rooms rm ON rm.id = r.room_id").
		Order("r.generated_at DESC")
	if ownerUserID > 0 {
		q = q.Where("rm.owner_user_id = ?", ownerUserID)
	}
	if err := q.Find(&rs).Error; err != nil {
		return nil, err
	}
	out := make([]struct {
		database.AgentRoomRetro
		RoomTitle string
		RoomGoal  string
	}, 0, len(rs))
	for _, x := range rs {
		out = append(out, struct {
			database.AgentRoomRetro
			RoomTitle string
			RoomGoal  string
		}{AgentRoomRetro: x.AgentRoomRetro, RoomTitle: x.RoomTitle, RoomGoal: x.RoomGoal})
	}
	return out, nil
}

// ═══════════════ Playbook v0.7 扩展 ═══════════════

// UpdatePlaybookV7 —— 结构化更新 v0.7 字段；version 自增。
// patch 里可包含任意 Model 字段；特殊字段 tags/appliesTo/steps/appliedRooms 由调用者先 marshal 好。
func (r *Repo) UpdatePlaybookV7(id string, patch map[string]any) error {
	// version++
	patch["version"] = gorm.Expr("version + 1")
	patch["updated_at"] = time.Now()
	return database.DB.Model(&database.AgentRoomPlaybook{}).Where("id = ?", id).Updates(patch).Error
}

// IncPlaybookUsage —— 原子 usage_count++ 且 append room 到 applied_rooms_json。
// 前后不一致的风险（两个并发 apply 同一 playbook 同一 room）无伤大雅，usage_count++ 有意义即可。
func (r *Repo) IncPlaybookUsage(playbookID, roomID string) error {
	return database.DB.Transaction(func(tx *gorm.DB) error {
		var p database.AgentRoomPlaybook
		if err := tx.First(&p, "id = ?", playbookID).Error; err != nil {
			return err
		}
		rooms := []string{}
		if p.AppliedRoomsJSON != "" {
			_ = json.Unmarshal([]byte(p.AppliedRoomsJSON), &rooms)
		}
		seen := false
		for _, rID := range rooms {
			if rID == roomID {
				seen = true
				break
			}
		}
		if !seen && roomID != "" {
			rooms = append(rooms, roomID)
		}
		appliedJSON := ""
		if len(rooms) > 0 {
			b, _ := json.Marshal(rooms)
			appliedJSON = string(b)
		}
		return tx.Model(&database.AgentRoomPlaybook{}).Where("id = ?", playbookID).Updates(map[string]any{
			"usage_count":        gorm.Expr("usage_count + 1"),
			"applied_rooms_json": appliedJSON,
			"updated_at":         time.Now(),
		}).Error
	})
}

// SearchPlaybooks —— 按关键词在 title/problem/approach/conclusion/tags/appliesTo 中做 LIKE 检索。
// 轻量实现，不上 FTS5（SQLite FTS5 触发器维护成本大，此处表量有限）；限 50 条。
func (r *Repo) SearchPlaybooks(ownerUserID uint, query string, limit int) ([]database.AgentRoomPlaybook, error) {
	if limit <= 0 {
		limit = 50
	}
	var ps []database.AgentRoomPlaybook
	q := database.DB.Order("usage_count DESC, updated_at DESC").Limit(limit)
	if ownerUserID > 0 {
		q = q.Where("owner_user_id = ?", ownerUserID)
	}
	kw := strings.TrimSpace(query)
	if kw != "" {
		like := "%" + kw + "%"
		q = q.Where("title LIKE ? OR problem LIKE ? OR approach LIKE ? OR conclusion LIKE ? OR tags_json LIKE ? OR applies_to_json LIKE ?",
			like, like, like, like, like, like)
	}
	return ps, q.Find(&ps).Error
}

// NowMsPtr 辅助：返回 *int64，便于给 GORM 可空列填值。
func NowMsPtr() *int64 {
	v := NowMs()
	return &v
}

// ═══════════════ DeleteRoom 扩展清理 ═══════════════

// DeleteRoomV7 —— 额外清理 v0.7 子表。主 DeleteRoom 保持原签名；这里做补充清理。
// 调用时机：DeleteRoom 内事务里 hook 调用（见 repo.go 注释），或独立调用用于遗留清理。
func (r *Repo) DeleteRoomV7Aux(tx *gorm.DB, roomID string) error {
	use := tx
	if use == nil {
		use = database.DB
	}
	tables := []struct {
		m any
		n string
	}{
		{&database.AgentRoomAgendaItem{}, "agenda"},
		{&database.AgentRoomOpenQuestion{}, "open_questions"},
		{&database.AgentRoomParkingLot{}, "parking"},
		{&database.AgentRoomRisk{}, "risks"},
		{&database.AgentRoomVoteBallot{}, "vote_ballots"},
		{&database.AgentRoomVote{}, "votes"},
		{&database.AgentRoomRetro{}, "retro"},
	}
	for _, t := range tables {
		if err := use.Delete(t.m, "room_id = ?", roomID).Error; err != nil {
			return fmt.Errorf("delete %s: %w", t.n, err)
		}
	}
	return nil
}
