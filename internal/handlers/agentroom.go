// AgentRoom REST handlers —— 对接前端 web/windows/AgentRoom/service.ts
// 所有路由挂在 /api/v1/agentroom/* 下，由 AuthMiddleware 保护。
// WS 实时事件通过全局 WSHub 的 agentroom:{roomId} 频道推送。
package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"ClawDeckX/internal/agentroom"
	"ClawDeckX/internal/database"
	"ClawDeckX/internal/web"
)

type AgentRoomHandler struct {
	repo      *agentroom.Repo
	manager   *agentroom.Manager
	scheduler *agentroom.RoomScheduler
	// 每房间发言速率限制：简单 token bucket（per-room，非 per-user）。
	rateLim *agentroom.RoomRateLimiter
}

func (h *AgentRoomHandler) SetScheduler(s *agentroom.RoomScheduler) {
	h.scheduler = s
}

// ReplayBlueprint 是 RoomScheduler.BlueprintReplayFn 的实现：将存储在 schedule 中
// 的 createRoomRequest JSON 反序列化并通过 buildRoomFromRequest 重建房间。
func (h *AgentRoomHandler) ReplayBlueprint(ctx context.Context, ownerUserID uint, blueprintJSON []byte) (string, error) {
	var req createRoomRequest
	if err := json.Unmarshal(blueprintJSON, &req); err != nil {
		return "", fmt.Errorf("decode blueprint: %w", err)
	}
	roomID, appErr := h.buildRoomFromRequest(ctx, ownerUserID, req)
	if appErr != nil {
		return "", fmt.Errorf("%s: %s", appErr.Code, appErr.Message)
	}
	return roomID, nil
}

func NewAgentRoomHandler(repo *agentroom.Repo, mgr *agentroom.Manager) *AgentRoomHandler {
	return &AgentRoomHandler{
		repo:    repo,
		manager: mgr,
		rateLim: agentroom.NewRoomRateLimiter(agentroom.RateLimitConfig{
			Burst:     5,  // 5 条内可突发
			PerMinute: 20, // 稳态每分钟 20 条
		}),
	}
}

func collectRoomSessionKeys(roomID string, members []database.AgentRoomMember) []string {
	keys := make([]string, 0, len(members)*2)
	seen := make(map[string]struct{}, len(members)*2)
	for _, mm := range members {
		if mm.Kind != "agent" {
			continue
		}
		agentID := strings.TrimSpace(mm.AgentID)
		if agentID == "" {
			agentID = "main"
		}
		mainKey := agentroom.SessionKeyFor(agentID, roomID, mm.ID)
		if _, ok := seen[mainKey]; !ok {
			seen[mainKey] = struct{}{}
			keys = append(keys, mainKey)
		}
		if key := strings.TrimSpace(mm.SessionKey); key != "" {
			if _, ok := seen[key]; !ok {
				seen[key] = struct{}{}
				keys = append(keys, key)
			}
		}
		auxKey := "agent:" + agentID + ":agentroom-aux:" + roomID
		if _, ok := seen[auxKey]; !ok {
			seen[auxKey] = struct{}{}
			keys = append(keys, auxKey)
		}
	}
	return keys
}

func deleteGatewaySessions(bridge *agentroom.Bridge, keys []string) int {
	if bridge == nil || !bridge.IsAvailable() || len(keys) == 0 {
		return 0
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	deleted := 0
	for _, key := range keys {
		if strings.TrimSpace(key) == "" {
			continue
		}
		if err := bridge.DeleteSession(ctx, key); err == nil {
			deleted++
		}
	}
	return deleted
}

func deleteGatewaySessionsAsync(bridge *agentroom.Bridge, keys []string) {
	if bridge == nil || !bridge.IsAvailable() || len(keys) == 0 {
		return
	}
	go func(sessionKeys []string) {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		for _, key := range sessionKeys {
			_ = bridge.DeleteSession(ctx, key)
		}
	}(append([]string(nil), keys...))
}

// authorizeRoom 检查调用者是否有权限访问指定房间。
// 返回 (*Room, true) 表示通过；(nil, false) 表示已写入 403/404 响应，调用方应直接 return。
//
// 规则：OwnerUserID==0 视为系统房间（demo），任何登录用户可访问；
//
//	其它房间必须 OwnerUserID == 当前 uid。
func (h *AgentRoomHandler) authorizeRoom(w http.ResponseWriter, r *http.Request, roomID string) (*database.AgentRoom, bool) {
	if roomID == "" {
		web.FailErr(w, r, web.ErrInvalidParam)
		return nil, false
	}
	room, err := h.repo.GetRoom(roomID)
	if err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return nil, false
	}
	if room == nil {
		web.FailErr(w, r, web.ErrNotFound)
		return nil, false
	}
	uid := web.GetUserID(r)
	if room.OwnerUserID != 0 && room.OwnerUserID != uid {
		web.Fail(w, r, "FORBIDDEN", "access denied", http.StatusForbidden)
		return nil, false
	}
	return room, true
}

// authorizeRoomByMessageID / authorizeRoomByMemberID / authorizeRoomByTaskID
// 在操作子资源前把 roomID 查出来再校验。

func (h *AgentRoomHandler) authorizeByMessage(w http.ResponseWriter, r *http.Request, mid string) (*database.AgentRoom, string, bool) {
	msg, err := h.repo.GetMessage(mid)
	if err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return nil, "", false
	}
	if msg == nil {
		web.FailErr(w, r, web.ErrNotFound)
		return nil, "", false
	}
	room, ok := h.authorizeRoom(w, r, msg.RoomID)
	if !ok {
		return nil, "", false
	}
	return room, msg.RoomID, true
}

func (h *AgentRoomHandler) authorizeByMember(w http.ResponseWriter, r *http.Request, mid string) (*database.AgentRoomMember, bool) {
	m, err := h.repo.GetMember(mid)
	if err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return nil, false
	}
	if m == nil {
		web.FailErr(w, r, web.ErrNotFound)
		return nil, false
	}
	if _, ok := h.authorizeRoom(w, r, m.RoomID); !ok {
		return nil, false
	}
	return m, true
}

// audit 在房间维度落一条操作审计。action 如 "delete", "fork", "kick", "emergency_stop"。
// 失败只打 log，不影响主流程。
func (h *AgentRoomHandler) audit(r *http.Request, roomID, action, targetID, detail string) {
	uid := web.GetUserID(r)
	ip := r.Header.Get("X-Forwarded-For")
	if ip == "" {
		ip = r.RemoteAddr
	}
	_ = h.repo.CreateAudit(&database.AgentRoomAudit{
		RoomID:    roomID,
		UserID:    uid,
		Action:    action,
		TargetID:  targetID,
		Detail:    detail,
		IP:        ip,
		CreatedAt: time.Now(),
	})
}

// ─────────────────────────────── 模板 ───────────────────────────────

func (h *AgentRoomHandler) ListTemplates(w http.ResponseWriter, r *http.Request) {
	web.OK(w, r, agentroom.Templates())
}

type roleProfileRequest struct {
	Name               string                            `json:"name"`
	Role               string                            `json:"role"`
	Slug               string                            `json:"slug,omitempty"`
	Emoji              string                            `json:"emoji,omitempty"`
	Description        string                            `json:"description,omitempty"`
	Category           string                            `json:"category,omitempty"`
	SystemPrompt       string                            `json:"systemPrompt,omitempty"`
	StylePrompt        string                            `json:"stylePrompt,omitempty"`
	Model              string                            `json:"model,omitempty"`
	AgentID            string                            `json:"agentId,omitempty"`
	Thinking           string                            `json:"thinking,omitempty"`
	MemoryKey          string                            `json:"memoryKey,omitempty"`
	IsModerator        bool                              `json:"isModerator,omitempty"`
	Stance             string                            `json:"stance,omitempty"`
	InteractionProfile *agentroom.RoleInteractionProfile `json:"interactionProfile,omitempty"`
	Visibility         string                            `json:"visibility,omitempty"`
	SortOrder          int                               `json:"sortOrder,omitempty"`
}

func roleProfileFromModel(m *database.AgentRoomRoleProfile) agentroom.RoleProfile {
	var interaction *agentroom.RoleInteractionProfile
	if strings.TrimSpace(m.InteractionProfileJSON) != "" {
		var v agentroom.RoleInteractionProfile
		if err := json.Unmarshal([]byte(m.InteractionProfileJSON), &v); err == nil {
			interaction = &v
		}
	}
	return agentroom.RoleProfile{
		ID:                 m.ID,
		OwnerUserID:        m.OwnerUserID,
		Slug:               m.Slug,
		Name:               m.Name,
		Role:               m.Role,
		Emoji:              m.Emoji,
		Description:        m.Description,
		Category:           m.Category,
		SystemPrompt:       m.SystemPrompt,
		StylePrompt:        m.StylePrompt,
		Model:              m.Model,
		AgentID:            m.AgentID,
		Thinking:           m.Thinking,
		MemoryKey:          m.MemoryKey,
		IsModerator:        m.IsModerator,
		Stance:             m.Stance,
		InteractionProfile: interaction,
		Builtin:            m.Builtin,
		Visibility:         m.Visibility,
		SortOrder:          m.SortOrder,
		CreatedAt:          m.CreatedAt.UnixMilli(),
		UpdatedAt:          m.UpdatedAt.UnixMilli(),
	}
}

func (h *AgentRoomHandler) ListRoleProfiles(w http.ResponseWriter, r *http.Request) {
	uid := web.GetUserID(r)
	category := strings.TrimSpace(r.URL.Query().Get("category"))
	items, err := h.repo.ListRoleProfiles(uid, category)
	if err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	out := make([]agentroom.RoleProfile, 0, len(items))
	for i := range items {
		out = append(out, roleProfileFromModel(&items[i]))
	}
	web.OK(w, r, out)
}

func (h *AgentRoomHandler) CreateRoleProfile(w http.ResponseWriter, r *http.Request) {
	var req roleProfileRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	if strings.TrimSpace(req.Name) == "" || strings.TrimSpace(req.Role) == "" {
		web.FailErr(w, r, web.ErrInvalidParam)
		return
	}
	interactionJSON := ""
	if req.InteractionProfile != nil {
		if b, err := json.Marshal(req.InteractionProfile); err == nil {
			interactionJSON = string(b)
		}
	}
	m := &database.AgentRoomRoleProfile{
		ID:                     agentroom.GenID("role"),
		OwnerUserID:            web.GetUserID(r),
		Slug:                   strings.TrimSpace(req.Slug),
		Name:                   strings.TrimSpace(req.Name),
		Role:                   strings.TrimSpace(req.Role),
		Emoji:                  strings.TrimSpace(req.Emoji),
		Description:            strings.TrimSpace(req.Description),
		Category:               strings.TrimSpace(req.Category),
		SystemPrompt:           agentroom.SanitizeSystemPrompt(req.SystemPrompt),
		StylePrompt:            agentroom.SanitizeSystemPrompt(req.StylePrompt),
		Model:                  strings.TrimSpace(req.Model),
		AgentID:                strings.TrimSpace(req.AgentID),
		Thinking:               strings.TrimSpace(req.Thinking),
		MemoryKey:              strings.TrimSpace(req.MemoryKey),
		IsModerator:            req.IsModerator,
		Stance:                 strings.TrimSpace(req.Stance),
		InteractionProfileJSON: interactionJSON,
		Visibility:             strings.TrimSpace(req.Visibility),
		SortOrder:              req.SortOrder,
	}
	if err := h.repo.CreateRoleProfile(m); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	web.OK(w, r, roleProfileFromModel(m))
}

func (h *AgentRoomHandler) UpdateRoleProfile(w http.ResponseWriter, r *http.Request) {
	id := pathID(r, "/api/v1/agentroom/role-profiles/")
	var req roleProfileRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	patch := map[string]any{}
	patch["slug"] = strings.TrimSpace(req.Slug)
	patch["name"] = strings.TrimSpace(req.Name)
	patch["role"] = strings.TrimSpace(req.Role)
	patch["emoji"] = strings.TrimSpace(req.Emoji)
	patch["description"] = strings.TrimSpace(req.Description)
	patch["category"] = strings.TrimSpace(req.Category)
	patch["system_prompt"] = agentroom.SanitizeSystemPrompt(req.SystemPrompt)
	patch["style_prompt"] = agentroom.SanitizeSystemPrompt(req.StylePrompt)
	patch["model"] = strings.TrimSpace(req.Model)
	patch["agent_id"] = strings.TrimSpace(req.AgentID)
	patch["thinking"] = strings.TrimSpace(req.Thinking)
	patch["memory_key"] = strings.TrimSpace(req.MemoryKey)
	patch["is_moderator"] = req.IsModerator
	patch["stance"] = strings.TrimSpace(req.Stance)
	patch["visibility"] = strings.TrimSpace(req.Visibility)
	patch["sort_order"] = req.SortOrder
	if req.InteractionProfile != nil {
		if b, err := json.Marshal(req.InteractionProfile); err == nil {
			patch["interaction_profile_json"] = string(b)
		}
	} else {
		patch["interaction_profile_json"] = ""
	}
	if err := h.repo.UpdateRoleProfile(id, web.GetUserID(r), patch); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	m, err := h.repo.GetRoleProfile(id, web.GetUserID(r))
	if err != nil || m == nil {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	web.OK(w, r, roleProfileFromModel(m))
}

func (h *AgentRoomHandler) DeleteRoleProfile(w http.ResponseWriter, r *http.Request) {
	id := pathID(r, "/api/v1/agentroom/role-profiles/")
	if err := h.repo.DeleteRoleProfile(id, web.GetUserID(r)); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	web.OK(w, r, map[string]any{"status": "ok"})
}

// ListPresets —— GET /api/v1/agentroom/presets
// 返回房间调参预设列表（chat / deep / debate / brainstorm / planning）+ 每个预设应用后的参数预览。
// 前端 RoomTuningModal 首屏展示。
func (h *AgentRoomHandler) ListPresets(w http.ResponseWriter, r *http.Request) {
	web.OK(w, r, agentroom.ListPresetMetas())
}

// GetPromptDefaults —— GET /api/v1/agentroom/prompt-defaults
// 返回默认 PromptPack（全字段）供前端"恢复默认"按钮和占位符使用。
// 不需要 roomID：默认模板是系统级的。
func (h *AgentRoomHandler) GetPromptDefaults(w http.ResponseWriter, r *http.Request) {
	web.OK(w, r, agentroom.DefaultPromptPack())
}

// AdminRebuildFTS —— POST /api/v1/agentroom/admin/fts/rebuild
// 管理员手动触发 FTS5 hard reset（drop 虚表 + 触发器 → 重建 → backfill）。
// 使用场景：
//   - 用户删房间反复命中 "database disk image is malformed (267)"，自动自愈也失败
//   - 运维在怀疑 FTS 损坏时主动"岛治"
//   - 从备份恢复后索引滞后
//
// 受 RequireAdmin 保护 —— 重建会短暂占用写锁，且期间搜索会返回空结果。
func (h *AgentRoomHandler) AdminRebuildFTS(w http.ResponseWriter, r *http.Request) {
	if err := agentroom.HardResetMessagesFTS(); err != nil {
		web.Fail(w, r, web.ErrDBQuery.Code, fmt.Sprintf("FTS rebuild failed: %v", err), web.ErrDBQuery.HTTPStatus)
		return
	}
	h.audit(r, "", "admin.fts.rebuild", "", "messages FTS hard reset complete")
	web.OK(w, r, map[string]string{"status": "ok"})
}

// AdminMetrics 以 Prometheus text exposition 格式输出 agentroom 子系统的运行时指标。
// 受 RequireAdmin 保护；Prometheus 抓取器应使用 admin 账号凭据或 API token。
// Content-Type: text/plain; version=0.0.4
func (h *AgentRoomHandler) AdminMetrics(w http.ResponseWriter, r *http.Request) {
	// 实时刷新 room 计数 gauge
	rooms, _ := h.repo.ListRooms(0) // uid=0 返回所有房间
	total := len(rooms)
	active := 0
	for _, rm := range rooms {
		if rm.State == agentroom.StateActive {
			active++
		}
	}
	agentroom.MetricRoomCounts(total, active)

	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	agentroom.WriteMetrics(w)
}

// ─────────────────────────────── 投影入站 ───────────────────────────────
//
// POST /api/v1/agentroom/projection/inbound
// 外部 IM webhook 把消息回推到 DeckX 的端点；DeckX 创建一条 projection_in 消息并广播。
// 仅房间所有者的会话生效；payload 必须带匹配的 roomId 与 projection.enabled=true。
type projectionInboundRequest struct {
	RoomID            string `json:"roomId"`
	Platform          string `json:"platform"`
	ChannelID         string `json:"channelId"`
	ExternalSender    string `json:"externalSender"`
	ExternalMessageID string `json:"externalMessageId"`
	Content           string `json:"content"`
}

func (h *AgentRoomHandler) ProjectionInbound(w http.ResponseWriter, r *http.Request) {
	var req projectionInboundRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	if req.RoomID == "" || strings.TrimSpace(req.Content) == "" {
		web.FailErr(w, r, web.ErrInvalidParam)
		return
	}
	// 投影入站目前仅做 owner 鉴权（通过 session cookie）；未来可改为 token 白名单
	room, ok := h.authorizeRoom(w, r, req.RoomID)
	if !ok {
		return
	}
	// 必须启用投影且入站开关开启
	var proj agentroom.RoomProjection
	_ = json.Unmarshal([]byte(room.Projection), &proj)
	if !proj.Enabled || !proj.InboundEnabled {
		web.Fail(w, r, "PROJECTION_DISABLED", "projection inbound is not enabled for this room", http.StatusForbidden)
		return
	}
	if len([]rune(req.Content)) > 8000 {
		web.Fail(w, r, "CONTENT_TOO_LONG", "message exceeds 8000 characters", http.StatusBadRequest)
		return
	}
	// 去重：同房间同 externalMessageId 已入库则幂等返回
	if req.ExternalMessageID != "" {
		if existing, _ := h.repo.FindMessageByExternalID(req.RoomID, req.ExternalMessageID); existing != nil {
			web.OK(w, r, map[string]any{"status": "dedup", "messageId": existing.ID})
			return
		}
	}
	msg := &database.AgentRoomMessage{
		ID:                 agentroom.GenID("msg"),
		RoomID:             req.RoomID,
		Timestamp:          agentroom.NowMs(),
		Kind:               agentroom.MsgKindProjectionIn,
		Content:            req.Content,
		ProjectionChannel:  req.Platform,
		ExternalSenderName: req.ExternalSender,
		ExternalMessageID:  req.ExternalMessageID,
	}
	if err := h.repo.CreateMessage(msg); err != nil {
		// 唯一约束竞态：再查一次返回已有
		if req.ExternalMessageID != "" {
			if existing, _ := h.repo.FindMessageByExternalID(req.RoomID, req.ExternalMessageID); existing != nil {
				web.OK(w, r, map[string]any{"status": "dedup", "messageId": existing.ID})
				return
			}
		}
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	h.broker().Emit(req.RoomID, agentroom.EventMessageAppend, map[string]any{
		"roomId":  req.RoomID,
		"message": agentroom.MessageFromModel(msg),
	})
	// 触发 agent 响应：把这条消息当成外部人类发言喂给 orchestrator
	if room.State == agentroom.StateActive {
		h.manager.Get(req.RoomID).PostUserMessage(
			"projection:"+req.Platform, // pseudo authorId
			req.Content,
			nil, nil, "", "", "",
			nil, // v0.9.1：投影入站消息目前不支持附件
		)
	}
	web.OK(w, r, map[string]any{"status": "ok", "messageId": msg.ID})
}

// ─────────────────────────────── 房间 CRUD ───────────────────────────────

func (h *AgentRoomHandler) ListRooms(w http.ResponseWriter, r *http.Request) {
	uid := web.GetUserID(r)
	rooms, err := h.repo.ListRooms(uid)
	if err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	out := make([]*agentroom.Room, 0, len(rooms))
	for i := range rooms {
		snap, err := h.repo.RoomSnapshot(rooms[i].ID)
		if err != nil {
			continue
		}
		out = append(out, snap)
	}
	web.OK(w, r, out)
}

func (h *AgentRoomHandler) GetRoom(w http.ResponseWriter, r *http.Request) {
	id := pathID(r, "/api/v1/agentroom/rooms/")
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	snap, err := h.repo.RoomSnapshot(id)
	if err != nil {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	web.OK(w, r, snap)
}

type templateMemberOverride struct {
	RoleID   string `json:"roleId"`
	AgentID  string `json:"agentId,omitempty"`
	Thinking string `json:"thinking,omitempty"`
	Model    string `json:"model,omitempty"`
}

// ─────────────────────────────── 全局设置 ───────────────────────────────
//
// GET  /api/v1/agentroom/settings      → { auxModel }
// PUT  /api/v1/agentroom/settings      body: { auxModel }  → { auxModel }
//
// 只有一个 key —— 辅助 LLM 默认模型。以后要加"房间默认预算"等全局项时扩这张表即可。
// 不是 admin-only：每个用户都能选自己偏好的辅助模型；SettingRepo 目前是单租户（全局共享）。
// 若未来引入多用户，需要把 key 加上 user id 前缀。
type agentRoomSettingsDTO struct {
	AuxModel string `json:"auxModel"`
}

func (h *AgentRoomHandler) GetSettings(w http.ResponseWriter, r *http.Request) {
	web.OK(w, r, agentRoomSettingsDTO{
		AuxModel: strings.TrimSpace(readAgentRoomAuxModelSettingOrEmpty()),
	})
}

func (h *AgentRoomHandler) UpdateSettings(w http.ResponseWriter, r *http.Request) {
	var req agentRoomSettingsDTO
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	// 允许置空（""）—— 用户明确想取消全局默认
	if err := agentroom.WriteAgentRoomAuxModelSetting(strings.TrimSpace(req.AuxModel)); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	web.OK(w, r, agentRoomSettingsDTO{AuxModel: strings.TrimSpace(req.AuxModel)})
}

// readAgentRoomAuxModelSettingOrEmpty 读取全局默认 aux model，handler 层简单封装
// （agentroom 包内部已有同名私有函数，这里保持 handler 包独立不直接引用）
func readAgentRoomAuxModelSettingOrEmpty() string {
	repo := database.NewSettingRepo()
	v, err := repo.Get(agentroom.SettingKeyAuxModel)
	if err != nil {
		return ""
	}
	return v
}

type createRoomRequest struct {
	Kind          string                     `json:"kind"` // template | custom
	TemplateID    string                     `json:"templateId,omitempty"`
	Title         string                     `json:"title,omitempty"`
	Goal          string                     `json:"goal,omitempty"`
	Members       []agentroom.TemplateMember `json:"members,omitempty"`
	Policy        string                     `json:"policy,omitempty"`
	BudgetCNY     float64                    `json:"budgetCNY,omitempty"`
	InitialPrompt string                     `json:"initialPrompt,omitempty"`
	// v0.4：房间级"辅助模型"——竞言打分 / 会议纪要 / extract-todo 等走这个，
	// 以便用廉价模型做短判断省成本。空 = 跟随全局默认（settings["agentroom.aux_model"]）。
	AuxModel string `json:"auxModel,omitempty"`
	// v0.4：模板路径可按 roleId 覆盖每个成员的 agent / thinking / model。
	MemberOverrides []templateMemberOverride `json:"memberOverrides,omitempty"`
	// v0.8：建房时直接带 PolicyOptions 覆盖（会在 preset 应用后 merge 进去）。
	// 常见用途：CreateRoomWizard 里选"冲突驱动模式"等。留空 = 跟 preset。
	PolicyOptions *agentroom.PolicyOptions `json:"policyOptions,omitempty"`
	// v1.0+：用户在向导第 3 步勾掉的初始任务下标（0-based），种子化时跳过。
	// 仅 template 路径有效；为空 / nil 时全部种子化。
	DisabledInitialTaskIndices []int `json:"disabledInitialTaskIndices,omitempty"`
	// v1.0+：AI 建会 / 自定义路径可直接带初始任务清单。
	// 与模板不同的是，executorRole / reviewerRole 是角色名（非 roleId），handler 用名称匹配 member。
	InitialTasks []initialTaskSpec `json:"initialTasks,omitempty"`
}

type initialTaskSpec struct {
	Text             string `json:"text"`
	Deliverable      string `json:"deliverable,omitempty"`
	DefinitionOfDone string `json:"definitionOfDone,omitempty"`
	ExecutorRole     string `json:"executorRole,omitempty"`
	ReviewerRole     string `json:"reviewerRole,omitempty"`
	DependsOnIndices []int  `json:"dependsOnIndices,omitempty"`
}

type resolvedMemberSpec struct {
	Member          agentroom.TemplateMember
	RoleProfileID   string
	RoleProfileMode string
}

func (h *AgentRoomHandler) CreateRoom(w http.ResponseWriter, r *http.Request) {
	var req createRoomRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	roomID, appErr := h.buildRoomFromRequest(r.Context(), web.GetUserID(r), req)
	if appErr != nil {
		web.FailErr(w, r, appErr)
		return
	}
	snap, _ := h.repo.RoomSnapshot(roomID)
	web.OK(w, r, snap)
}

// buildRoomFromRequest 是 CreateRoom 的可复用核心逻辑。
// 既给 HTTP 入口用，也给 RoomScheduler 在定时触发时用（blueprint 重放）。
// 返回创建的 roomID。失败时返回结构化 AppError；调用方决定如何回写响应。
func (h *AgentRoomHandler) buildRoomFromRequest(ctx context.Context, ownerUserID uint, req createRoomRequest) (string, *web.AppError) {
	var (
		roomID  = agentroom.GenID("room")
		members []resolvedMemberSpec
		policy  = "free"
		budget  = 10.0
		title   = strings.TrimSpace(req.Title)
		tplID   = ""
		facts   []agentroom.Fact
		// policyOpts —— 模板带 PresetID 时预填；最终 marshal 到 AgentRoom.PolicyOpts 列。
		// 空结构（PresetID 未落）→ 存空串，orchestrator 通过 GetXxx() 回退到默认。
		policyOpts agentroom.PolicyOptions
		hasOpts    bool
		// v1.0+：从模板里捕获 InitialWhiteboard / InitialTasks，给后续 roomModel 写入与 task 种子用。
		tplInitialWhiteboard string
		tplInitialTasks      []agentroom.TemplateTask
		tplMembers           []agentroom.TemplateMember
	)

	if req.Kind == "template" || req.TemplateID != "" {
		tpl := agentroom.FindTemplate(req.TemplateID)
		if tpl == nil {
			return "", &web.AppError{Code: "TEMPLATE_NOT_FOUND", Message: "template not found", HTTPStatus: http.StatusBadRequest}
		}
		// 深拷贝模板 members（避免污染全局模板）并按 roleId 应用 overrides。
		overrideByRole := make(map[string]templateMemberOverride, len(req.MemberOverrides))
		for _, o := range req.MemberOverrides {
			if rid := strings.TrimSpace(o.RoleID); rid != "" {
				overrideByRole[rid] = o
			}
		}
		members = make([]resolvedMemberSpec, len(tpl.Members))
		for i, m := range tpl.Members {
			members[i] = resolvedMemberSpec{Member: m, RoleProfileID: strings.TrimSpace(m.RoleProfileID), RoleProfileMode: "template"}
			if ov, ok := overrideByRole[m.RoleID]; ok {
				if v := strings.TrimSpace(ov.AgentID); v != "" {
					members[i].Member.AgentID = v
				}
				if v := strings.TrimSpace(ov.Thinking); v != "" {
					members[i].Member.Thinking = v
				}
				if v := strings.TrimSpace(ov.Model); v != "" {
					members[i].Member.Model = v
				}
			}
		}
		policy = tpl.DefaultPolicy
		budget = tpl.BudgetCNY
		tplID = tpl.ID
		if title == "" {
			title = tpl.Name
		}
		// v0.7+ 开箱即用：模板若带 PresetID，直接应用到 PolicyOpts，
		// 这样新手建完房间不用再进"房间调参向导"就有合理默认（bidding 阈值、tail 窗口、
		// debate 轮数等），效果等价于向导里手动点同名 preset 卡。
		if tpl.PresetID != "" {
			agentroom.ApplyPreset(&policyOpts, tpl.PresetID)
			hasOpts = true
		}
		// v1.0+：模板的派发模式偏好写入 PolicyOpts，前端 dispatch 弹窗读它预选。
		if v := strings.TrimSpace(tpl.DefaultDispatchMode); v != "" {
			policyOpts.DefaultDispatchMode = v
			hasOpts = true
		}
		for k, v := range tpl.InitialFacts {
			facts = append(facts, agentroom.Fact{Key: k, Value: v, AuthorID: "system", UpdatedAt: agentroom.NowMs()})
		}
		// v1.0+：捕获模板的初始白板 / 初始任务清单，待 roomModel 创建 + 成员落库后再用。
		tplInitialWhiteboard = tpl.InitialWhiteboard
		tplInitialTasks = tpl.InitialTasks
		tplMembers = tpl.Members
	} else if req.Kind == "custom" {
		if title == "" || len(req.Members) == 0 {
			return "", &web.AppError{Code: "INVALID_PARAM", Message: "title and members are required", HTTPStatus: http.StatusBadRequest}
		}
		members = make([]resolvedMemberSpec, 0, len(req.Members))
		for _, spec := range req.Members {
			resolved := resolvedMemberSpec{Member: spec, RoleProfileID: strings.TrimSpace(spec.RoleProfileID), RoleProfileMode: "custom_snapshot"}
			if resolved.RoleProfileID != "" {
				profile, err := h.repo.GetRoleProfile(resolved.RoleProfileID, ownerUserID)
				if err != nil {
					return "", web.ErrDBQuery
				}
				if profile == nil {
					return "", &web.AppError{Code: "ROLE_PROFILE_NOT_FOUND", Message: "role profile not found", HTTPStatus: http.StatusBadRequest}
				}
				resolved.Member.Role = firstNonEmpty(strings.TrimSpace(spec.Role), profile.Role, profile.Name)
				resolved.Member.RoleID = firstNonEmpty(strings.TrimSpace(spec.RoleID), profile.Slug, profile.ID)
				resolved.Member.Emoji = firstNonEmpty(strings.TrimSpace(spec.Emoji), profile.Emoji)
				resolved.Member.Model = firstNonEmpty(strings.TrimSpace(spec.Model), profile.Model)
				resolved.Member.SystemPrompt = firstNonEmpty(strings.TrimSpace(spec.SystemPrompt), profile.SystemPrompt)
				resolved.Member.IsModerator = spec.IsModerator || profile.IsModerator
				resolved.Member.Stance = firstNonEmpty(strings.TrimSpace(spec.Stance), profile.Stance)
				resolved.Member.AgentID = firstNonEmpty(strings.TrimSpace(spec.AgentID), profile.AgentID)
				resolved.Member.Thinking = firstNonEmpty(strings.TrimSpace(spec.Thinking), profile.Thinking)
				resolved.RoleProfileMode = map[bool]string{true: "builtin", false: "user"}[profile.Builtin]
			}
			members = append(members, resolved)
		}
		if req.Policy != "" {
			policy = req.Policy
		}
		if req.BudgetCNY > 0 {
			budget = req.BudgetCNY
		}
		if strings.TrimSpace(req.Goal) != "" {
			facts = append(facts, agentroom.Fact{Key: "目标", Value: req.Goal, AuthorID: "system", UpdatedAt: agentroom.NowMs()})
		}
		// v1.0+：AI 建会 / 自定义路径也可带初始任务。
		// 转成 TemplateTask（用 role name 当 ExecutorRoleID），复用模板种子化逻辑。
		if len(req.InitialTasks) > 0 {
			for _, it := range req.InitialTasks {
				tplInitialTasks = append(tplInitialTasks, agentroom.TemplateTask{
					Text:             it.Text,
					Deliverable:      it.Deliverable,
					DefinitionOfDone: it.DefinitionOfDone,
					ExecutorRoleID:   it.ExecutorRole,
					ReviewerRoleID:   it.ReviewerRole,
					DependsOnIndices: it.DependsOnIndices,
				})
			}
			// 用 members 的 Role name 做 roleId → memberId 映射的 key
			for i := range members {
				if members[i].Member.RoleID == "" {
					members[i].Member.RoleID = members[i].Member.Role
				}
			}
			tplMembers = make([]agentroom.TemplateMember, len(members))
			for i, m := range members {
				tplMembers[i] = m.Member
			}
		}
	} else {
		return "", &web.AppError{Code: "INVALID_PARAM", Message: "kind must be 'template' or 'custom'", HTTPStatus: http.StatusBadRequest}
	}

	// v0.8：Wizard 传入的 policyOptions 叠加到 preset 之上（用户显式选择 > 模板默认）。
	// 只挑"Wizard 能覆盖"的字段，避免整份 PolicyOptions 盲目覆盖把 preset 清空。
	// 目前：conflictMode（其它字段未来按需要加）。
	if req.PolicyOptions != nil {
		if v := strings.TrimSpace(req.PolicyOptions.ConflictMode); v != "" {
			policyOpts.ConflictMode = v
			hasOpts = true
		}
	}

	uid := ownerUserID

	budgetJSON, _ := json.Marshal(agentroom.RoomBudget{
		LimitCNY:   budget,
		UsedCNY:    0,
		TokensUsed: 0,
		WarnAt:     0.7,
		HardStopAt: 1.0,
	})
	// 把模板应用的 preset 序列化写入 AgentRoom.PolicyOpts（text/JSON 列）。
	// 走同一个 JSON schema，和用户后续在"房间调参向导"里保存时完全一致。
	var policyOptsJSON string
	if hasOpts {
		if b, err := json.Marshal(&policyOpts); err == nil {
			policyOptsJSON = string(b)
		}
	}
	roomModel := &database.AgentRoom{
		ID:          roomID,
		OwnerUserID: uid,
		Title:       title,
		TemplateID:  tplID,
		State:       agentroom.StateActive,
		Policy:      policy,
		BudgetJSON:  string(budgetJSON),
		PolicyOpts:  policyOptsJSON,
		Whiteboard:  tplInitialWhiteboard,
		AuxModel:    strings.TrimSpace(req.AuxModel),
	}
	if err := h.repo.CreateRoom(roomModel); err != nil {
		return "", web.ErrDBQuery
	}

	// 插入成员 + 预建 OpenClaw session（v0.4 Bridge 接入）
	bridge := h.manager.Bridge()
	// v0.4：成员未指定 agentId 时，从 OpenClaw agents.list 的 defaultId 取默认值
	// （通常是 "main"），避免硬编码 "default" 让 gateway 自动创建幽灵 agent。
	fallbackAgent := "main"
	if bridge != nil {
		fallbackAgent = bridge.DefaultAgentID(ctx)
	}
	for i, resolved := range members {
		spec := resolved.Member
		memberID := fmt.Sprintf("%s_m%d", roomID, i)
		agentID := strings.TrimSpace(spec.AgentID)
		if agentID == "" {
			agentID = fallbackAgent
		}
		sessionKey := agentroom.SessionKeyFor(agentID, roomID, memberID)
		m := &database.AgentRoomMember{
			ID:           memberID,
			RoomID:       roomID,
			Kind:         "agent",
			Name:         spec.Role,
			Role:         spec.Role,
			Emoji:        spec.Emoji,
			Model:        spec.Model,
			SystemPrompt: agentroom.SanitizeSystemPrompt(spec.SystemPrompt),
			Status:       agentroom.MemberStatusIdle,
			IsModerator:  spec.IsModerator,
			// Stance 模板预置（debate / 对抗评审场景），其它模板留空。
			// debate scheduler 需要 pro/con 非空才会真正走辩论轮转，否则退化到 free。
			Stance:          spec.Stance,
			RoleProfileID:   resolved.RoleProfileID,
			RoleProfileMode: resolved.RoleProfileMode,
			AgentID:         agentID,
			SessionKey:      sessionKey,
			Thinking:        spec.Thinking,
		}
		if err := h.repo.CreateMember(m); err != nil {
			return "", web.ErrDBQuery
		}
		// 预建 OpenClaw session（best-effort；gateway 未就绪时成员仍可落库，
		// 下一次发言尝试时会再 try）。
		if bridge != nil && bridge.IsAvailable() {
			if err := bridge.EnsureSession(ctx, agentroom.EnsureSessionParams{
				Key:          sessionKey,
				AgentID:      agentID,
				Model:        spec.Model,
				Thinking:     spec.Thinking,
				Label:        fmt.Sprintf("AgentRoom · %s · %s", title, spec.Role),
				SystemPrompt: spec.SystemPrompt,
			}); err != nil {
				// 非致命：落库已成功，session 会在首次发言时重试
				_ = err
			}
		}
		if spec.IsModerator && roomModel.ModeratorID == "" {
			roomModel.ModeratorID = m.ID
		}
	}
	// 人类 You
	you := &database.AgentRoomMember{
		ID:     fmt.Sprintf("%s_you", roomID),
		RoomID: roomID,
		Kind:   "human",
		Name:   "You",
		Role:   "Owner",
		Emoji:  "🧑",
		Status: agentroom.MemberStatusIdle,
	}
	_ = h.repo.CreateMember(you)

	if roomModel.ModeratorID != "" {
		_ = h.repo.UpdateRoom(roomID, map[string]any{"moderator_id": roomModel.ModeratorID})
	}

	// 事实
	for _, f := range facts {
		_ = h.repo.UpsertFact(&database.AgentRoomFact{
			RoomID: roomID, Key: f.Key, Value: f.Value, AuthorID: f.AuthorID,
		})
	}

	// v1.0+：模板/AI 初始任务清单（呼应 G3 验收 / G4 派发 / D1 依赖 DAG）。
	// 按下标顺序 insert，dependsOn 用前面已落库的 task id 解析。
	// 用户在向导第 3 步勾掉的下标会跳过种子化（保留下标对齐让 dependsOn 仍能解析）。
	var seeded []seededTask
	if len(tplInitialTasks) > 0 {
		disabled := make(map[int]bool, len(req.DisabledInitialTaskIndices))
		for _, i := range req.DisabledInitialTaskIndices {
			disabled[i] = true
		}
		seeded = seedInitialTasksFromTemplate(h.repo, roomID, you.ID, tplInitialTasks, tplMembers, members, disabled)
	}

	// 启动 orchestrator
	orch := h.manager.Get(roomID)

	// v1.0+：无依赖的种子任务自动派发（用户无需逐个手动点击「派发」）。
	// dispatchMode 优先取 policyOpts.DefaultDispatchMode，否则 member_agent。
	if len(seeded) > 0 && orch != nil {
		dm := strings.TrimSpace(policyOpts.DefaultDispatchMode)
		autoDispatchSeededTasks(h.repo, seeded, roomID, dm, orch)
	}

	// 初始 prompt 作为人类消息投递
	if strings.TrimSpace(req.InitialPrompt) != "" {
		orch.PostUserMessage(you.ID, req.InitialPrompt, nil, nil, "", "", "", nil)
	}

	return roomID, nil
}

func (h *AgentRoomHandler) UpdateRoom(w http.ResponseWriter, r *http.Request) {
	id := pathID(r, "/api/v1/agentroom/rooms/")
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	patch := map[string]any{}
	if v, ok := body["title"].(string); ok {
		patch["title"] = v
	}
	if v, ok := body["state"].(string); ok {
		patch["state"] = v
		if v == agentroom.StateClosed || v == agentroom.StateArchived {
			now := agentroom.NowMs()
			patch["closed_at"] = &now
		}
	}
	if v, ok := body["policy"].(string); ok {
		patch["policy"] = v
	}
	if v, ok := body["whiteboard"].(string); ok {
		patch["whiteboard"] = v
	}
	if v, ok := body["projection"]; ok {
		b, _ := json.Marshal(v)
		patch["projection"] = string(b)
	}
	if v, ok := body["budget"]; ok {
		b, _ := json.Marshal(v)
		patch["budget_json"] = string(b)
	}
	if v, ok := body["policyOptions"]; ok {
		b, _ := json.Marshal(v)
		patch["policy_opts"] = string(b)
	}
	if v, ok := body["collaborationStyle"].(string); ok {
		patch["collaboration_style"] = agentroom.SanitizeSystemPrompt(v)
	}
	if v, ok := body["readonly"].(bool); ok {
		patch["readonly"] = v
	}
	if v, ok := body["mutationDryRun"].(bool); ok {
		patch["mutation_dry_run"] = v
	}
	// v0.6 协作质量字段
	if v, ok := body["goal"].(string); ok {
		patch["goal"] = agentroom.SanitizeSystemPrompt(v)
	}
	if v, ok := body["roundBudget"].(float64); ok {
		patch["round_budget"] = int(v)
	}
	if v, ok := body["selfCritique"].(bool); ok {
		patch["self_critique"] = v
	}
	if v, ok := body["constitution"].(string); ok {
		patch["constitution"] = agentroom.SanitizeSystemPrompt(v)
	}
	if v, ok := body["auxModel"].(string); ok {
		patch["aux_model"] = strings.TrimSpace(v)
	}
	if len(patch) == 0 {
		web.FailErr(w, r, web.ErrInvalidParam)
		return
	}
	if err := h.repo.UpdateRoom(id, patch); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	// v0.9.2：广播 room.update WS 事件，让所有连接的前端（含自身 useRoom hook）实时同步。
	// 原先只存 DB + 返回 HTTP 响应，但前端 room state 完全靠 WS 事件驱动，
	// 导致 policy/title/whiteboard 等字段改完后 UI 不更新。
	// 注意：state→paused 会由 orchestrator 的 Pause/EmergencyStop 再推一次，小幅重复无害。
	{
		wsPatch := map[string]any{}
		for _, k := range []string{
			"title", "state", "policy", "whiteboard", "goal",
			"auxModel", "collaborationStyle", "readonly", "mutationDryRun",
			"selfCritique", "constitution",
		} {
			if v, ok := body[k]; ok {
				wsPatch[k] = v
			}
		}
		if v, ok := body["roundBudget"].(float64); ok {
			wsPatch["roundBudget"] = int(v)
		}
		if v, ok := body["policyOptions"]; ok {
			wsPatch["policyOptions"] = v
		}
		if v, ok := body["budget"]; ok {
			wsPatch["budget"] = v
		}
		if v, ok := body["projection"]; ok {
			wsPatch["projection"] = v
		}
		if len(wsPatch) > 0 {
			h.broker().Emit(id, agentroom.EventRoomUpdate, map[string]any{
				"roomId": id,
				"patch":  wsPatch,
			})
		}
	}
	// v0.8+ 暂停修复：state → paused 时必须走 Pause()，它会真正 cancel 当前 in-flight turn
	// 并把 agent 状态回拉到 idle；否则正在思考/打字的 agent 会继续直到 LLM 自然结束。
	// 其余场景（含 paused → active 恢复）走 RefreshState 即可。
	if v, ok := body["state"].(string); ok && v == agentroom.StatePaused {
		orch := h.manager.Get(id)
		orch.AbortCurrentTurn()
		orch.Pause("user toggled pause")
	} else {
		h.manager.Get(id).RefreshState()
	}

	snap, _ := h.repo.RoomSnapshot(id)
	web.OK(w, r, snap)
}

func (h *AgentRoomHandler) DeleteRoom(w http.ResponseWriter, r *http.Request) {
	id := pathID(r, "/api/v1/agentroom/rooms/")
	room, ok := h.authorizeRoom(w, r, id)
	if !ok {
		return
	}
	// 先收集所有 agent 成员的 session key，用于清理 OpenClaw 侧 session。
	members, _ := h.repo.ListMembers(id)
	sessionKeys := collectRoomSessionKeys(id, members)
	h.manager.Drop(id)
	if err := h.repo.DeleteRoom(id); err != nil {
		// 把真实 DB 错误带进响应 —— 方便定位是哪个子表删除失败（repo.DeleteRoom 每步都带了前缀）。
		web.Fail(w, r, web.ErrDBQuery.Code, fmt.Sprintf("%s: %v", web.ErrDBQuery.Message, err), web.ErrDBQuery.HTTPStatus)
		return
	}
	// v0.4 best-effort 清理 OpenClaw session（不阻塞响应）。
	deleteGatewaySessionsAsync(h.manager.Bridge(), sessionKeys)
	h.rateLim.Reset(id)
	h.audit(r, id, "delete", "", fmt.Sprintf("title=%s,sessions=%d", room.Title, len(sessionKeys)))
	web.OK(w, r, map[string]any{"status": "ok", "purged": len(sessionKeys)})
}

// PurgeSessions —— 仅清理房间成员的 OpenClaw gateway session（释放上游 transcript/资源），
// 不删 DB 任何数据：房间、消息、纪要、议程、playbook、白板、facts 全部保留。
//
// 使用场景：用户"关闭会议"后一段时间，明确不再 resume 这个房间，只想回收 gateway 侧资源，
// 但仍要能查阅本地会议记录。语义上等同 DeleteRoom 的后半段（session 清理），没有 DB 破坏性。
//
// POST /api/v1/agentroom/rooms/{id}/purge-sessions
func (h *AgentRoomHandler) PurgeSessions(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/purge-sessions")
	room, ok := h.authorizeRoom(w, r, id)
	if !ok {
		return
	}
	members, _ := h.repo.ListMembers(id)
	sessionKeys := collectRoomSessionKeys(id, members)
	// v0.9.1：这里改为同步删除。
	// 原先异步 fire-and-forget，HTTP 200 返回时 gateway 侧未必删完；用户马上切到"AI 会话"
	// 窗口会误以为"没删"。Closeout 勾选“产出后删除房间会话记录”时也需要一个可 await 的真完成点。
	// 不在此处 UpdateMember 清空 SessionKey —— 保留 key 让用户再次"继续会议"时可以凭旧 key
	// 触发 gateway 自动重建 session（EnsureSession 幂等）。
	deleted := deleteGatewaySessions(h.manager.Bridge(), sessionKeys)
	h.audit(r, id, "purge_sessions", "", fmt.Sprintf("title=%s,count=%d,deleted=%d", room.Title, len(sessionKeys), deleted))
	web.OK(w, r, map[string]any{"status": "ok", "purged": deleted, "keys": len(sessionKeys)})
}

// ─────────────────────────────── 消息 ───────────────────────────────

func (h *AgentRoomHandler) ListMessages(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/messages")
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	// 分页：?limit=<n>&before=<seq>
	// before>0 时取该 seq 之前的 limit 条；before=0 时取最新 limit 条（默认 200）。
	limit := 200
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 500 {
			limit = n
		}
	}
	var before int64
	if v := r.URL.Query().Get("before"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 {
			before = n
		}
	}
	var msgs []database.AgentRoomMessage
	var err error
	if before > 0 || r.URL.Query().Get("paged") == "1" {
		msgs, err = h.repo.ListMessagesPaged(id, before, limit)
	} else {
		msgs, err = h.repo.ListMessages(id, 0, limit)
	}
	if err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	uid := web.GetUserID(r)
	out := make([]agentroom.Message, 0, len(msgs))
	for i := range msgs {
		m := agentroom.MessageFromModel(&msgs[i])
		// Whisper 防窃听：请求者若不是 room owner（当前唯一的人类身份），
		// 把 content/mentionIds/whisperTargetIds/reactions 清掉，只留元数据保持时间线完整。
		// authorizeRoom 已经把非 owner 拒之门外；此处作为 defense-in-depth，未来多用户扩展时自动生效。
		room, _ := h.repo.GetRoom(id)
		if m.Kind == "whisper" && room != nil && room.OwnerUserID != 0 && room.OwnerUserID != uid {
			m.Content = "[whisper]"
			m.MentionIDs = nil
			m.WhisperTargetIDs = nil
			m.Reactions = nil
		}
		out = append(out, m)
	}
	web.OK(w, r, out)
}

// SearchMessages —— FTS5 全文检索。
// GET /api/v1/agentroom/rooms/{id}/search?q=<query>&limit=<n>
// 返回匹配消息（按 rank 排序），limit 默认 50、最大 200。
func (h *AgentRoomHandler) SearchMessages(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/search")
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		web.OK(w, r, []agentroom.Message{})
		return
	}
	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 200 {
			limit = n
		}
	}
	msgs, err := h.repo.SearchMessages(id, q, limit)
	if err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	out := make([]agentroom.Message, 0, len(msgs))
	for i := range msgs {
		out = append(out, agentroom.MessageFromModel(&msgs[i]))
	}
	web.OK(w, r, out)
}

type postMessageRequest struct {
	AuthorID           string                        `json:"authorId"`
	Content            string                        `json:"content"`
	Attachments        []agentroom.MessageAttachment `json:"attachments,omitempty"`
	MentionIDs         []string                      `json:"mentionIds,omitempty"`
	WhisperTargetIDs   []string                      `json:"whisperTargetIds,omitempty"`
	ActingAsID         string                        `json:"actingAsId,omitempty"`
	ReferenceMessageID string                        `json:"referenceMessageId,omitempty"`
	IdempotencyKey     string                        `json:"idempotencyKey,omitempty"`
}

func (h *AgentRoomHandler) PostMessage(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/messages")
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	if !h.rateLim.Allow(id) {
		agentroom.MetricRateLimitReject()
		web.FailErr(w, r, web.ErrRateLimited)
		return
	}
	var req postMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	// v0.9.1：允许"只附图片、无文字"的消息。AuthorID 仍必填。
	if req.AuthorID == "" {
		web.FailErr(w, r, web.ErrInvalidParam)
		return
	}
	if strings.TrimSpace(req.Content) == "" && len(req.Attachments) == 0 {
		web.FailErr(w, r, web.ErrInvalidParam)
		return
	}
	// 消息内容长度硬上限：8k 字符，防止把整篇文档塞进来把 token 爆掉。
	if len([]rune(req.Content)) > 8000 {
		web.Fail(w, r, "CONTENT_TOO_LONG", "message exceeds 8000 characters", http.StatusBadRequest)
		return
	}
	// v0.9.1：附件容量约束 —— 最多 4 张；单张 base64 不超过 2.2MB（原文件 ≈ 1.6MB）；
	// 总量不超过 8MB，避免整条消息 row 把 SQLite 撑得过大。超过任一上限给明确错误码。
	const maxAttachmentCount = 4
	const maxAttachmentBytes = 2_200_000
	const maxAttachmentsTotalBytes = 8_000_000
	if len(req.Attachments) > maxAttachmentCount {
		web.Fail(w, r, "TOO_MANY_ATTACHMENTS", "at most 4 attachments per message", http.StatusBadRequest)
		return
	}
	var totalAttach int
	for i := range req.Attachments {
		a := &req.Attachments[i]
		if a.Type == "" {
			a.Type = "image"
		}
		if a.Type != "image" {
			web.Fail(w, r, "ATTACHMENT_TYPE_UNSUPPORTED", "only image attachments are supported", http.StatusBadRequest)
			return
		}
		if a.Content == "" {
			web.Fail(w, r, "ATTACHMENT_EMPTY", "attachment content is empty", http.StatusBadRequest)
			return
		}
		if len(a.Content) > maxAttachmentBytes {
			web.Fail(w, r, "ATTACHMENT_TOO_LARGE", "one attachment exceeds 2.2MB", http.StatusBadRequest)
			return
		}
		totalAttach += len(a.Content)
	}
	if totalAttach > maxAttachmentsTotalBytes {
		web.Fail(w, r, "ATTACHMENTS_TOTAL_TOO_LARGE", "attachments total exceeds 8MB", http.StatusBadRequest)
		return
	}
	// 幂等键：优先 body（方便 JSON 测试），其次 Header
	idemKey := strings.TrimSpace(req.IdempotencyKey)
	if idemKey == "" {
		idemKey = strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	}
	if len(idemKey) > 80 {
		idemKey = idemKey[:80]
	}
	// 立即模拟幂等命中：如果已有同键消息，直接返回该消息，不再触发 orchestrator
	if idemKey != "" {
		if existing, _ := h.repo.FindMessageByIdempotency(id, idemKey); existing != nil {
			web.OK(w, r, map[string]any{"status": "dedup", "messageId": existing.ID})
			return
		}
	}
	orch := h.manager.Get(id)
	orch.PostUserMessage(req.AuthorID, req.Content, req.MentionIDs, req.WhisperTargetIDs, req.ActingAsID, req.ReferenceMessageID, idemKey, req.Attachments)
	web.OK(w, r, map[string]any{"status": "ok"})
}

type editMessageRequest struct {
	Content string `json:"content"`
}

func (h *AgentRoomHandler) EditMessage(w http.ResponseWriter, r *http.Request) {
	mid := pathIDLast(r, "/api/v1/agentroom/messages/")
	_, _, authOK := h.authorizeByMessage(w, r, mid)
	if !authOK {
		return
	}
	var req editMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	orig, err := h.repo.GetMessage(mid)
	if err != nil || orig == nil {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	if len([]rune(req.Content)) > 8000 {
		web.Fail(w, r, "CONTENT_TOO_LONG", "message exceeds 8000 characters", http.StatusBadRequest)
		return
	}
	patch := map[string]any{
		"content":        req.Content,
		"content_edited": true,
	}
	if orig.OriginalBody == "" {
		patch["original_body"] = orig.Content
	}
	if err := h.repo.UpdateMessage(mid, patch); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	msg, _ := h.repo.GetMessage(mid)
	if msg != nil {
		broadcast := map[string]any{
			"roomId":    orig.RoomID,
			"messageId": mid,
			"patch":     map[string]any{"content": req.Content, "contentEdited": true},
		}
		h.broker().Emit(orig.RoomID, agentroom.EventMessageUpdate, broadcast)
	}
	web.OK(w, r, map[string]any{"status": "ok"})
}

func (h *AgentRoomHandler) DeleteMessage(w http.ResponseWriter, r *http.Request) {
	mid := pathIDLast(r, "/api/v1/agentroom/messages/")
	_, _, authOK := h.authorizeByMessage(w, r, mid)
	if !authOK {
		return
	}
	orig, err := h.repo.GetMessage(mid)
	if err != nil || orig == nil {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	if err := h.repo.UpdateMessage(mid, map[string]any{"deleted": true}); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	h.broker().Emit(orig.RoomID, agentroom.EventMessageUpdate, map[string]any{
		"roomId":    orig.RoomID,
		"messageId": mid,
		"patch":     map[string]any{"deleted": true},
	})
	web.OK(w, r, map[string]any{"status": "ok"})
}

type reactRequest struct {
	Emoji    string `json:"emoji"`
	MemberID string `json:"memberId"`
}

func (h *AgentRoomHandler) ReactMessage(w http.ResponseWriter, r *http.Request) {
	// path: /api/v1/agentroom/messages/{mid}/react
	mid := pathIDBetween(r, "/api/v1/agentroom/messages/", "/react")
	_, _, authOK := h.authorizeByMessage(w, r, mid)
	if !authOK {
		return
	}
	var req reactRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Emoji == "" || req.MemberID == "" {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	orig, err := h.repo.GetMessage(mid)
	if err != nil || orig == nil {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	var reactions []agentroom.Reaction
	if orig.ReactionsJSON != "" {
		_ = json.Unmarshal([]byte(orig.ReactionsJSON), &reactions)
	}
	found := false
	for i := range reactions {
		if reactions[i].Emoji == req.Emoji {
			hasMember := false
			for _, mm := range reactions[i].ByMemberIDs {
				if mm == req.MemberID {
					hasMember = true
					break
				}
			}
			if hasMember {
				// toggle off
				filtered := reactions[i].ByMemberIDs[:0]
				for _, mm := range reactions[i].ByMemberIDs {
					if mm != req.MemberID {
						filtered = append(filtered, mm)
					}
				}
				reactions[i].ByMemberIDs = filtered
			} else {
				reactions[i].ByMemberIDs = append(reactions[i].ByMemberIDs, req.MemberID)
			}
			found = true
			break
		}
	}
	if !found {
		reactions = append(reactions, agentroom.Reaction{Emoji: req.Emoji, ByMemberIDs: []string{req.MemberID}})
	}
	// 去掉空 emoji
	cleaned := reactions[:0]
	for _, rc := range reactions {
		if len(rc.ByMemberIDs) > 0 {
			cleaned = append(cleaned, rc)
		}
	}
	b, _ := json.Marshal(cleaned)
	if err := h.repo.UpdateMessage(mid, map[string]any{"reactions_json": string(b)}); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	h.broker().Emit(orig.RoomID, agentroom.EventMessageUpdate, map[string]any{
		"roomId":    orig.RoomID,
		"messageId": mid,
		"patch":     map[string]any{"reactions": cleaned},
	})
	web.OK(w, r, map[string]any{"status": "ok"})
}

// ─────────────────────────────── 成员 ───────────────────────────────

func (h *AgentRoomHandler) ListMembers(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/members")
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	ms, err := h.repo.ListMembers(id)
	if err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	out := make([]agentroom.Member, 0, len(ms))
	for i := range ms {
		out = append(out, agentroom.MemberFromModel(&ms[i]))
	}
	web.OK(w, r, out)
}

type memberActionRequest struct {
	Action string `json:"action"` // kick | mute | unmute | set_model | set_agent | set_thinking | set_system_prompt
	Model  string `json:"model,omitempty"`
	// v0.4：切换 agent / thinking 时需要同步 OpenClaw session。
	AgentID  string `json:"agentId,omitempty"`
	Thinking string `json:"thinking,omitempty"` // off|low|medium|high
	// v0.8：set_system_prompt 时用。空字符串 = 回退模板/默认提示词。
	SystemPrompt string `json:"systemPrompt,omitempty"`
}

func (h *AgentRoomHandler) MemberAction(w http.ResponseWriter, r *http.Request) {
	// path: /api/v1/agentroom/members/{mid}/action
	mid := pathIDBetween(r, "/api/v1/agentroom/members/", "/action")
	m, ok := h.authorizeByMember(w, r, mid)
	if !ok {
		return
	}
	var req memberActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	// DB patch 用 GORM 列名（snake_case）；WS wirePatch 走前端 Member type 的 camelCase。
	// 两者必须分开 —— 之前用同一个 map，导致前端 setMembers({...m, ...patch}) 合入的是 is_kicked / agent_id 等异字段，
	// UI 仍读 m.isKicked / m.agentId 保持 stale，直到手动 refetch 才同步。
	patch := map[string]any{}
	wirePatch := map[string]any{}
	// 是否需要在本次请求后 patch OpenClaw session —— 仅 set_model / set_agent / set_thinking 需要。
	type sessionSyncPlan struct {
		newKey       string
		agentID      string
		model        string
		thinking     string
		systemPrompt string
	}
	var syncPlan *sessionSyncPlan

	switch req.Action {
	case "kick":
		patch["is_kicked"] = true
		wirePatch["isKicked"] = true
	case "unkick":
		patch["is_kicked"] = false
		wirePatch["isKicked"] = false
	case "mute":
		patch["is_muted"] = true
		patch["status"] = agentroom.MemberStatusMuted
		wirePatch["isMuted"] = true
		wirePatch["status"] = agentroom.MemberStatusMuted
	case "unmute":
		patch["is_muted"] = false
		patch["status"] = agentroom.MemberStatusIdle
		wirePatch["isMuted"] = false
		wirePatch["status"] = agentroom.MemberStatusIdle
	case "set_model":
		// 空字符串表示“清除成员级模型覆盖，回退到 agent 默认模型”。
		// 这与 thinking/system_prompt 的空值语义保持一致：空 = inherit/reset。
		patch["model"] = req.Model
		wirePatch["model"] = req.Model
		syncPlan = &sessionSyncPlan{
			newKey:       m.SessionKey,
			agentID:      m.AgentID,
			model:        req.Model,
			thinking:     m.Thinking,
			systemPrompt: m.SystemPrompt,
		}
	case "set_thinking":
		// 空字符串表示"恢复 agent 默认"；直接透传给 OpenClaw。
		patch["thinking"] = req.Thinking
		wirePatch["thinking"] = req.Thinking
		syncPlan = &sessionSyncPlan{
			newKey:       m.SessionKey,
			agentID:      m.AgentID,
			model:        m.Model,
			thinking:     req.Thinking,
			systemPrompt: m.SystemPrompt,
		}
	case "set_system_prompt":
		// v0.8：编辑角色 SystemPrompt。需同步到 OpenClaw session让下一轮发言立刻生效。
		// SanitizeSystemPrompt 统一 行尾去空/限长等执行，避免微妈流做攻击向量。
		newPrompt := agentroom.SanitizeSystemPrompt(req.SystemPrompt)
		patch["system_prompt"] = newPrompt
		wirePatch["systemPrompt"] = newPrompt
		syncPlan = &sessionSyncPlan{
			newKey:       m.SessionKey,
			agentID:      m.AgentID,
			model:        m.Model,
			thinking:     m.Thinking,
			systemPrompt: newPrompt,
		}
	case "set_agent":
		// 切换 agent 会改变 session key（key 里含 agentID），等同"换个 agent 开新会话"。
		// 旧 session 不主动删除，留给 OpenClaw session gc 自然回收，避免用户意外丢失历史。
		newAgent := strings.TrimSpace(req.AgentID)
		if newAgent == "" {
			// v0.4：用 OpenClaw 的 defaultId（通常 "main"）而非硬编码 "default"，
			// 避免触发 gateway 自动创建幽灵 agent。
			if bridge := h.manager.Bridge(); bridge != nil {
				newAgent = bridge.DefaultAgentID(r.Context())
			} else {
				newAgent = "main"
			}
		}
		newKey := agentroom.SessionKeyFor(newAgent, m.RoomID, m.ID)
		patch["agent_id"] = newAgent
		patch["session_key"] = newKey
		wirePatch["agentId"] = newAgent
		wirePatch["sessionKey"] = newKey
		syncPlan = &sessionSyncPlan{
			newKey:       newKey,
			agentID:      newAgent,
			model:        m.Model,
			thinking:     m.Thinking,
			systemPrompt: m.SystemPrompt,
		}
	default:
		web.FailErr(w, r, web.ErrInvalidParam)
		return
	}
	if err := h.repo.UpdateMember(mid, patch); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}

	// 同步到 OpenClaw session —— best-effort。失败不回滚 DB（下一次发言再重试 EnsureSession）。
	if syncPlan != nil {
		if bridge := h.manager.Bridge(); bridge != nil && bridge.IsAvailable() {
			_ = bridge.EnsureSession(r.Context(), agentroom.EnsureSessionParams{
				Key:          syncPlan.newKey,
				AgentID:      syncPlan.agentID,
				Model:        syncPlan.model,
				Thinking:     syncPlan.thinking,
				Label:        fmt.Sprintf("AgentRoom · %s", m.Name),
				SystemPrompt: syncPlan.systemPrompt,
			})
		}
	}

	h.broker().Emit(m.RoomID, agentroom.EventMemberUpdate, map[string]any{
		"roomId":   m.RoomID,
		"memberId": mid,
		"patch":    wirePatch,
	})
	h.audit(r, m.RoomID, "member."+req.Action, mid, "name="+m.Name)
	web.OK(w, r, map[string]any{"status": "ok"})
}

// ─────────────────── 添加 / 真删除成员 ───────────────────────

type addMemberRequest struct {
	Role          string `json:"role"`
	Emoji         string `json:"emoji,omitempty"`
	Model         string `json:"model,omitempty"`
	AgentID       string `json:"agentId,omitempty"`
	Thinking      string `json:"thinking,omitempty"`
	SystemPrompt  string `json:"systemPrompt,omitempty"`
	IsModerator   bool   `json:"isModerator,omitempty"`
	Stance        string `json:"stance,omitempty"`
	RoleProfileID string `json:"roleProfileId,omitempty"`
}

// AddMember —— POST /api/v1/agentroom/rooms/{id}/members
// 向已有房间动态添加一个 agent 成员。复用 CreateRoom 中的 session 预建逻辑。
func (h *AgentRoomHandler) AddMember(w http.ResponseWriter, r *http.Request) {
	roomID := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/members")
	room, ok := h.authorizeRoom(w, r, roomID)
	if !ok {
		return
	}
	var req addMemberRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	role := strings.TrimSpace(req.Role)
	if role == "" {
		web.Fail(w, r, "INVALID_PARAM", "role is required", http.StatusBadRequest)
		return
	}

	bridge := h.manager.Bridge()
	fallbackAgent := "main"
	if bridge != nil {
		fallbackAgent = bridge.DefaultAgentID(r.Context())
	}
	agentID := strings.TrimSpace(req.AgentID)
	if agentID == "" {
		agentID = fallbackAgent
	}

	// 获取当前成员数以生成 memberID 索引
	existingMembers, _ := h.repo.ListMembers(roomID)
	memberIdx := len(existingMembers)
	memberID := fmt.Sprintf("%s_m%d", roomID, memberIdx)
	// 如果 ID 冲突（理论上罕见），追加随机后缀
	for _, em := range existingMembers {
		if em.ID == memberID {
			memberID = agentroom.GenID("mem")
			break
		}
	}

	sessionKey := agentroom.SessionKeyFor(agentID, roomID, memberID)
	// 角色档案解析
	rpID := strings.TrimSpace(req.RoleProfileID)
	rpMode := ""
	if rpID != "" {
		profile, err := h.repo.GetRoleProfile(rpID, web.GetUserID(r))
		if err != nil {
			web.FailErr(w, r, web.ErrDBQuery)
			return
		}
		if profile != nil {
			role = firstNonEmpty(role, profile.Role, profile.Name)
			req.Emoji = firstNonEmpty(strings.TrimSpace(req.Emoji), profile.Emoji)
			req.Model = firstNonEmpty(strings.TrimSpace(req.Model), profile.Model)
			req.SystemPrompt = firstNonEmpty(strings.TrimSpace(req.SystemPrompt), profile.SystemPrompt)
			req.IsModerator = req.IsModerator || profile.IsModerator
			req.Stance = firstNonEmpty(strings.TrimSpace(req.Stance), profile.Stance)
			agentID = firstNonEmpty(agentID, profile.AgentID)
			req.Thinking = firstNonEmpty(strings.TrimSpace(req.Thinking), profile.Thinking)
			rpMode = map[bool]string{true: "builtin", false: "user"}[profile.Builtin]
		}
	}

	m := &database.AgentRoomMember{
		ID:              memberID,
		RoomID:          roomID,
		Kind:            "agent",
		Name:            role,
		Role:            role,
		Emoji:           strings.TrimSpace(req.Emoji),
		Model:           strings.TrimSpace(req.Model),
		SystemPrompt:    agentroom.SanitizeSystemPrompt(req.SystemPrompt),
		Status:          agentroom.MemberStatusIdle,
		IsModerator:     req.IsModerator,
		Stance:          strings.TrimSpace(req.Stance),
		RoleProfileID:   rpID,
		RoleProfileMode: rpMode,
		AgentID:         agentID,
		SessionKey:      sessionKey,
		Thinking:        strings.TrimSpace(req.Thinking),
	}
	if err := h.repo.CreateMember(m); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}

	// 预建 OpenClaw session（best-effort）
	if bridge != nil && bridge.IsAvailable() {
		_ = bridge.EnsureSession(r.Context(), agentroom.EnsureSessionParams{
			Key:          sessionKey,
			AgentID:      agentID,
			Model:        m.Model,
			Thinking:     m.Thinking,
			Label:        fmt.Sprintf("AgentRoom · %s · %s", room.Title, role),
			SystemPrompt: m.SystemPrompt,
		})
	}

	// 通知 orchestrator 刷新成员列表
	if orch := h.manager.GetIfExists(roomID); orch != nil {
		orch.RefreshMembers()
	}

	// 广播 member.added
	memberDTO := agentroom.MemberFromModel(m)
	h.broker().Emit(roomID, agentroom.EventMemberAdded, map[string]any{
		"roomId": roomID,
		"member": memberDTO,
	})
	h.audit(r, roomID, "member.add", memberID, "role="+role)
	web.OK(w, r, memberDTO)
}

// RemoveMember —— DELETE /api/v1/agentroom/members/{mid}?cascade=true|false
// 真删除成员。前端需先弹确认框让用户选择是否级联删除消息。
func (h *AgentRoomHandler) RemoveMember(w http.ResponseWriter, r *http.Request) {
	mid := strings.TrimPrefix(r.URL.Path, "/api/v1/agentroom/members/")
	mid = strings.TrimSuffix(mid, "/")
	m, ok := h.authorizeByMember(w, r, mid)
	if !ok {
		return
	}
	// 不允许删除人类成员（"You"）
	if m.Kind == "human" {
		web.Fail(w, r, "CANNOT_DELETE_HUMAN", "cannot delete human member", http.StatusBadRequest)
		return
	}

	cascade := r.URL.Query().Get("cascade") == "true"

	// 先清理 gateway session
	if key := strings.TrimSpace(m.SessionKey); key != "" {
		bridge := h.manager.Bridge()
		if bridge != nil && bridge.IsAvailable() {
			ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
			defer cancel()
			_ = bridge.DeleteSession(ctx, key)
		}
	}

	if err := h.repo.DeleteMember(mid, cascade); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}

	// 通知 orchestrator 刷新成员列表
	if orch := h.manager.GetIfExists(m.RoomID); orch != nil {
		orch.RefreshMembers()
	}

	// 广播 member.removed
	h.broker().Emit(m.RoomID, agentroom.EventMemberRemoved, map[string]any{
		"roomId":   m.RoomID,
		"memberId": mid,
		"cascade":  cascade,
	})
	h.audit(r, m.RoomID, "member.remove", mid, fmt.Sprintf("name=%s cascade=%v", m.Name, cascade))
	web.OK(w, r, map[string]any{"status": "ok", "cascade": cascade})
}

// ─────────────────────────────── 事实 ───────────────────────────────

type factRequest struct {
	Key      string `json:"key"`
	Value    string `json:"value"`
	AuthorID string `json:"authorId"`
}

func (h *AgentRoomHandler) UpsertFact(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/facts")
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	var req factRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Key == "" {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	f := &database.AgentRoomFact{
		RoomID: id, Key: req.Key, Value: req.Value, AuthorID: req.AuthorID,
	}
	if err := h.repo.UpsertFact(f); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	h.broker().Emit(id, agentroom.EventRoomUpdate, map[string]any{
		"roomId": id,
		"patch":  map[string]any{"factsChanged": true},
	})
	web.OK(w, r, map[string]any{"status": "ok"})
}

func (h *AgentRoomHandler) DeleteFact(w http.ResponseWriter, r *http.Request) {
	// path: /api/v1/agentroom/rooms/{id}/facts/{key}
	rest := strings.TrimPrefix(r.URL.Path, "/api/v1/agentroom/rooms/")
	parts := strings.SplitN(rest, "/", 3)
	if len(parts) < 3 || parts[1] != "facts" {
		web.FailErr(w, r, web.ErrInvalidParam)
		return
	}
	id, key := parts[0], parts[2]
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	if err := h.repo.DeleteFact(id, key); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	h.broker().Emit(id, agentroom.EventRoomUpdate, map[string]any{
		"roomId": id,
		"patch":  map[string]any{"factsChanged": true},
	})
	web.OK(w, r, map[string]any{"status": "ok"})
}

// ─────────────────────────────── 任务 ───────────────────────────────

type taskRequest struct {
	Text       string `json:"text"`
	AssigneeID string `json:"assigneeId,omitempty"`
	CreatorID  string `json:"creatorId"`
	Status     string `json:"status,omitempty"`
	DueAt      *int64 `json:"dueAt,omitempty"`

	// v0.2 工作单字段（GAP G1）
	ReviewerID       string `json:"reviewerId,omitempty"`
	Deliverable      string `json:"deliverable,omitempty"`
	DefinitionOfDone string `json:"definitionOfDone,omitempty"`
	SourceDecisionID string `json:"sourceDecisionId,omitempty"`
	SourceMessageID  string `json:"sourceMessageId,omitempty"`
	ExecutionMode    string `json:"executionMode,omitempty"`

	// v0.3 主题 D：任务依赖（同房间）
	DependsOn []string `json:"dependsOn,omitempty"`
}

func (h *AgentRoomHandler) CreateTask(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/tasks")
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	var req taskRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Text == "" {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	status := req.Status
	if status == "" {
		status = agentroom.TaskStatusTodo
	}
	t := &database.AgentRoomTask{
		RoomID: id, Text: req.Text, AssigneeID: req.AssigneeID,
		CreatorID: req.CreatorID, Status: status, DueAt: req.DueAt,
		ReviewerID:       req.ReviewerID,
		Deliverable:      req.Deliverable,
		DefinitionOfDone: req.DefinitionOfDone,
		SourceDecisionID: req.SourceDecisionID,
		SourceMessageID:  req.SourceMessageID,
		ExecutionMode:    req.ExecutionMode,
	}
	if len(req.DependsOn) > 0 {
		// v0.3 主题 D：DAG 校验。前置任务必须同房间，禁止自引用 / 重复 id。
		filtered, err := h.validateAndCleanDeps(id, "", req.DependsOn)
		if err != nil {
			web.Fail(w, r, "INVALID_DEPS", err.Error(), http.StatusBadRequest)
			return
		}
		if b, _ := json.Marshal(filtered); len(filtered) > 0 {
			t.DependsOnJSON = string(b)
		}
	}
	if err := h.repo.CreateTask(t); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	h.broker().Emit(id, agentroom.EventRoomUpdate, map[string]any{
		"roomId": id, "patch": map[string]any{"tasksChanged": true},
	})
	web.OK(w, r, agentroom.TaskFromModel(t))
}

func (h *AgentRoomHandler) UpdateTask(w http.ResponseWriter, r *http.Request) {
	tid := pathIDLast(r, "/api/v1/agentroom/tasks/")
	if tid == "" {
		web.FailErr(w, r, web.ErrInvalidParam)
		return
	}
	// 鉴权：按 task 查到 room
	t, err := h.repo.GetTask(tid)
	if err != nil || t == nil {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	roomID := t.RoomID
	if _, ok := h.authorizeRoom(w, r, roomID); !ok {
		return
	}
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	patch := map[string]any{}
	if v, ok := body["status"].(string); ok {
		patch["status"] = v
		// 自动维护 completedAt：进入 done 写入；离开 done 清空
		if v == agentroom.TaskStatusDone && t.CompletedAt == nil {
			now := agentroom.NowMs()
			patch["completed_at"] = &now
		} else if v != agentroom.TaskStatusDone && t.CompletedAt != nil {
			patch["completed_at"] = nil
		}
	}
	if v, ok := body["text"].(string); ok {
		patch["text"] = v
	}
	if v, ok := body["assigneeId"].(string); ok {
		patch["assignee_id"] = v
	}
	if v, ok := body["reviewerId"].(string); ok {
		patch["reviewer_id"] = v
	}
	if v, ok := body["deliverable"].(string); ok {
		patch["deliverable"] = v
	}
	if v, ok := body["definitionOfDone"].(string); ok {
		patch["definition_of_done"] = v
	}
	if v, ok := body["executionMode"].(string); ok {
		patch["execution_mode"] = v
	}
	if v, ok := body["resultSummary"].(string); ok {
		patch["result_summary"] = v
	}
	if v, ok := body["dueAt"].(float64); ok {
		dv := int64(v)
		patch["due_at"] = &dv
	} else if _, present := body["dueAt"]; present {
		// 显式传 null 可清除截止
		patch["due_at"] = nil
	}
	// v0.3 主题 D：任务依赖更新
	if rawDeps, present := body["dependsOn"]; present {
		ids := []string{}
		if arr, ok := rawDeps.([]any); ok {
			for _, x := range arr {
				if s, ok := x.(string); ok {
					ids = append(ids, s)
				}
			}
		}
		filtered, err := h.validateAndCleanDeps(roomID, tid, ids)
		if err != nil {
			web.Fail(w, r, "INVALID_DEPS", err.Error(), http.StatusBadRequest)
			return
		}
		if len(filtered) == 0 {
			patch["depends_on_json"] = ""
		} else if b, _ := json.Marshal(filtered); len(b) > 0 {
			patch["depends_on_json"] = string(b)
		}
	}
	if err := h.repo.UpdateTask(tid, patch); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	// 广播任务变更
	h.broker().Emit(roomID, agentroom.EventRoomUpdate, map[string]any{
		"roomId": roomID, "patch": map[string]any{"tasksChanged": true},
	})
	web.OK(w, r, map[string]any{"status": "ok"})
}

// ── v0.2 GAP G2：决策一键转任务 ─────────────────────────────────────────
//
// POST /api/v1/agentroom/rooms/{id}/tasks/promote-decision
//
// Body:
//
//	{
//	  "messageId": "msg_xxx",          // 必填：来源决策消息（必须 isDecision=true）
//	  "text":      "...",              // 选填：自定义任务描述；默认用 decisionSummary 或消息内容前 200 字
//	  "assigneeId": "mem_xxx",         // 选填：默认空
//	  "reviewerId": "mem_yyy",         // 选填
//	  "creatorId":  "mem_human",       // 必填：当前用户成员 id
//	  "deliverable": "...",            // 选填
//	  "definitionOfDone": "...",       // 选填
//	}
//
// 返回新 Task DTO（含 sourceDecisionId 已设置）。
func (h *AgentRoomHandler) PromoteDecisionToTask(w http.ResponseWriter, r *http.Request) {
	roomID := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/tasks/promote-decision")
	if _, ok := h.authorizeRoom(w, r, roomID); !ok {
		return
	}
	var req struct {
		MessageID        string `json:"messageId"`
		Text             string `json:"text"`
		AssigneeID       string `json:"assigneeId"`
		ReviewerID       string `json:"reviewerId"`
		CreatorID        string `json:"creatorId"`
		Deliverable      string `json:"deliverable"`
		DefinitionOfDone string `json:"definitionOfDone"`
		DueAt            *int64 `json:"dueAt"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.MessageID == "" {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	msg, err := h.repo.GetMessage(req.MessageID)
	if err != nil || msg == nil || msg.RoomID != roomID {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	if !msg.IsDecision {
		web.Fail(w, r, "NOT_A_DECISION", "message is not anchored as decision", http.StatusBadRequest)
		return
	}
	text := strings.TrimSpace(req.Text)
	if text == "" {
		text = strings.TrimSpace(msg.DecisionSummary)
	}
	if text == "" {
		text = strings.TrimSpace(msg.Content)
		if n := []rune(text); len(n) > 200 {
			text = string(n[:200]) + "…"
		}
	}
	if text == "" {
		web.Fail(w, r, "EMPTY_TEXT", "cannot derive task text from decision", http.StatusBadRequest)
		return
	}
	t := &database.AgentRoomTask{
		RoomID:           roomID,
		Text:             text,
		AssigneeID:       req.AssigneeID,
		ReviewerID:       req.ReviewerID,
		CreatorID:        req.CreatorID,
		Status:           agentroom.TaskStatusTodo,
		DueAt:            req.DueAt,
		Deliverable:      req.Deliverable,
		DefinitionOfDone: req.DefinitionOfDone,
		SourceDecisionID: req.MessageID,
	}
	if err := h.repo.CreateTask(t); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	h.audit(r, roomID, "task.promote_from_decision", req.MessageID, t.ID)
	h.broker().Emit(roomID, agentroom.EventRoomUpdate, map[string]any{
		"roomId": roomID, "patch": map[string]any{"tasksChanged": true},
	})
	web.OK(w, r, agentroom.TaskFromModel(t))
}

// ── v0.2 GAP G3：任务验收 / 返工 ───────────────────────────────────────
//
// POST /api/v1/agentroom/tasks/{tid}/accept
//
// Body:
//
//	{
//	  "status":            "accepted|rework|needs_human|blocked",
//	  "summary":           "...",                 // 验收总结（写入 acceptance_note）
//	  "passedCriteria":    ["..."],               // 已达标 DoD 项
//	  "failedCriteria":    ["..."],               // 未达标 DoD 项
//	  "reworkInstructions":"..."                  // rework 时建议同时填写，并入 acceptance_note
//	}
//
// 状态流转：
//
//	accepted    → status=done,    completed_at=now
//	rework      → status=in_progress, rework_count++; 若 ≥ DefaultReworkLimit 自动升 needs_human
//	needs_human → status=review（保持），同时记录 acceptance_status=needs_human
//	blocked     → status=blocked
func (h *AgentRoomHandler) AcceptTask(w http.ResponseWriter, r *http.Request) {
	// path: /api/v1/agentroom/tasks/{tid}/accept
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/agentroom/tasks/")
	tid := strings.TrimSuffix(path, "/accept")
	if tid == "" || strings.Contains(tid, "/") {
		web.FailErr(w, r, web.ErrInvalidParam)
		return
	}
	t, err := h.repo.GetTask(tid)
	if err != nil || t == nil {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	if _, ok := h.authorizeRoom(w, r, t.RoomID); !ok {
		return
	}
	var req struct {
		Status             string   `json:"status"`
		Summary            string   `json:"summary"`
		PassedCriteria     []string `json:"passedCriteria"`
		FailedCriteria     []string `json:"failedCriteria"`
		ReworkInstructions string   `json:"reworkInstructions"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	accept := strings.ToLower(strings.TrimSpace(req.Status))
	now := agentroom.NowMs()
	patch := map[string]any{
		"acceptance_status": accept,
		"acceptance_note":   strings.TrimSpace(req.Summary),
		"passed_criteria":   agentroom.JoinLines(req.PassedCriteria),
		"failed_criteria":   agentroom.JoinLines(req.FailedCriteria),
		"reviewed_at":       &now,
	}
	switch accept {
	case agentroom.AcceptanceStatusAccepted:
		patch["status"] = agentroom.TaskStatusDone
		patch["completed_at"] = &now
	case agentroom.AcceptanceStatusRework:
		newCount := t.ReworkCount + 1
		patch["rework_count"] = newCount
		instructions := strings.TrimSpace(req.ReworkInstructions)
		if instructions != "" {
			note := patch["acceptance_note"].(string)
			if note != "" {
				note += "\n\n"
			}
			note += "返工要求：" + instructions
			patch["acceptance_note"] = note
		}
		if newCount >= agentroom.DefaultReworkLimit {
			patch["acceptance_status"] = agentroom.AcceptanceStatusNeedsHuman
			patch["status"] = agentroom.TaskStatusReview
		} else {
			patch["status"] = agentroom.TaskStatusInProgress
		}
	case agentroom.AcceptanceStatusNeedsHuman:
		patch["status"] = agentroom.TaskStatusReview
	case agentroom.AcceptanceStatusBlocked:
		patch["status"] = agentroom.TaskStatusBlocked
	default:
		web.Fail(w, r, "INVALID_ACCEPTANCE_STATUS",
			"acceptance status must be accepted|rework|needs_human|blocked",
			http.StatusBadRequest)
		return
	}
	if err := h.repo.UpdateTask(tid, patch); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	newT, _ := h.repo.GetTask(tid)
	h.audit(r, t.RoomID, "task.accept", tid, accept)
	h.broker().Emit(t.RoomID, agentroom.EventRoomUpdate, map[string]any{
		"roomId": t.RoomID, "patch": map[string]any{"tasksChanged": true},
	})
	// v1.0+：accepted → 自动推进依赖链下游任务
	if accept == agentroom.AcceptanceStatusAccepted {
		if orch := h.manager.GetIfExists(t.RoomID); orch != nil {
			orch.TryDispatchDependents(tid)
		}
	}
	if newT == nil {
		web.OK(w, r, map[string]any{"status": "ok"})
		return
	}
	web.OK(w, r, agentroom.TaskFromModel(newT))
}

// ── v0.2 GAP G4：任务执行派发与回执 ─────────────────────────────────────
//
// API:
//
//	POST /api/v1/agentroom/rooms/{rid}/tasks/{tid}/dispatch
//	     body: { mode: "manual|member_agent|subagent", executorMemberId?: "..." }
//	     → 创建一条 queued execution；任务状态推进到 in_progress
//	     → mode=member_agent/subagent 时同步在房间发系统通知 @executor 让其接手
//
//	GET  /api/v1/agentroom/tasks/{tid}/executions             → 列出该任务全部执行历史
//	POST /api/v1/agentroom/executions/{eid}/submit-result     → 完成执行，写入摘要/产物
//	     body: { summary, artifacts?: [...], blockers?: [...] }
//	     → execution=completed；任务自动 status=review + result_summary 同步
//	POST /api/v1/agentroom/executions/{eid}/cancel
//	     body: { reason? }
//	     → execution=canceled；任务退回 todo（如果当前还在 in_progress）

// helper：拿房间的 broker 来发广播 + appendSystemNotice
func (h *AgentRoomHandler) postSystemNotice(roomID, text string) {
	msg := &database.AgentRoomMessage{
		ID:        agentroom.GenID("msg"),
		RoomID:    roomID,
		Timestamp: agentroom.NowMs(),
		AuthorID:  "system",
		Kind:      agentroom.MsgKindSystem,
		Content:   text,
	}
	if err := h.repo.CreateMessage(msg); err != nil {
		return
	}
	h.broker().Emit(roomID, agentroom.EventMessageAppend, map[string]any{
		"roomId": roomID, "message": agentroom.MessageFromModel(msg),
	})
}

// DispatchTask —— POST /rooms/{rid}/tasks/{tid}/dispatch
func (h *AgentRoomHandler) DispatchTask(w http.ResponseWriter, r *http.Request) {
	// path: /api/v1/agentroom/rooms/{rid}/tasks/{tid}/dispatch
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/agentroom/rooms/")
	parts := strings.Split(strings.TrimSuffix(path, "/dispatch"), "/")
	if len(parts) != 3 || parts[1] != "tasks" {
		web.FailErr(w, r, web.ErrInvalidParam)
		return
	}
	roomID := parts[0]
	tid := parts[2]
	if _, ok := h.authorizeRoom(w, r, roomID); !ok {
		return
	}
	t, err := h.repo.GetTask(tid)
	if err != nil || t == nil || t.RoomID != roomID {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	var req struct {
		Mode             string `json:"mode"`
		ExecutorMemberID string `json:"executorMemberId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	mode := strings.ToLower(strings.TrimSpace(req.Mode))
	switch mode {
	case agentroom.TaskExecutionModeManual,
		agentroom.TaskExecutionModeMemberAgent,
		agentroom.TaskExecutionModeSubagent:
		// ok
	default:
		web.Fail(w, r, "INVALID_MODE",
			"mode must be manual|member_agent|subagent",
			http.StatusBadRequest)
		return
	}
	executor := strings.TrimSpace(req.ExecutorMemberID)
	if executor == "" {
		// 默认用 task.assigneeId
		executor = t.AssigneeID
	}
	if (mode == agentroom.TaskExecutionModeMemberAgent || mode == agentroom.TaskExecutionModeSubagent) && executor == "" {
		web.Fail(w, r, "EXECUTOR_REQUIRED",
			"member_agent / subagent dispatch requires executorMemberId or task.assigneeId",
			http.StatusBadRequest)
		return
	}
	// v0.3 主题 D：依赖 DAG 拦截。任何模式（含 manual）派发前都校验。
	// 全部 done 才放行；存在未完成依赖时回 DEP_NOT_READY，前端可显示阻塞链。
	if deps := agentroom.TaskFromModel(t).DependsOn; len(deps) > 0 {
		blocking := []map[string]any{}
		for _, depID := range deps {
			dep, _ := h.repo.GetTask(depID)
			if dep == nil || dep.RoomID != roomID {
				continue // 跨房间或已删除：保守跳过，不阻塞
			}
			if dep.Status != agentroom.TaskStatusDone {
				blocking = append(blocking, map[string]any{
					"id": dep.ID, "text": dep.Text, "status": dep.Status,
				})
			}
		}
		if len(blocking) > 0 {
			web.FailWith(w, r, "DEP_NOT_READY",
				"task has unfinished dependencies",
				http.StatusConflict,
				map[string]any{"blocking": blocking})
			return
		}
	}
	// 关闭已存在的活跃 execution，避免并行
	if active, _ := h.repo.FindActiveTaskExecution(tid); active != nil {
		_ = h.repo.UpdateTaskExecution(active.ID, map[string]any{
			"status":       agentroom.TaskExecStatusCanceled,
			"completed_at": ptrInt64(agentroom.NowMs()),
			"error_msg":    "superseded by new dispatch",
		})
	}
	now := agentroom.NowMs()
	exe := &database.AgentRoomTaskExecution{
		TaskID:           tid,
		RoomID:           roomID,
		ExecutorMemberID: executor,
		Mode:             mode,
		Status:           agentroom.TaskExecStatusQueued,
		StartedAt:        &now,
	}
	if err := h.repo.CreateTaskExecution(exe); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	// 任务状态推进到 in_progress（保持向下兼容：原 todo/doing 都进 in_progress）
	patch := map[string]any{}
	if t.Status == agentroom.TaskStatusTodo ||
		t.Status == agentroom.TaskStatusDoing ||
		t.Status == agentroom.TaskStatusAssigned {
		patch["status"] = agentroom.TaskStatusInProgress
	}
	if t.AssigneeID == "" && executor != "" {
		patch["assignee_id"] = executor
	}
	if t.ExecutionMode == "" {
		patch["execution_mode"] = mode
	}
	if len(patch) > 0 {
		_ = h.repo.UpdateTask(tid, patch)
	}
	// v0.3 主题 A：agent / subagent 模式 → 交给 orchestrator 真实运行；
	// manual 模式不动（execution 保持 queued，等用户在 UI 提交结果）。
	if mode == agentroom.TaskExecutionModeMemberAgent || mode == agentroom.TaskExecutionModeSubagent {
		orch := h.manager.GetIfExists(roomID)
		if orch == nil {
			// 房间未加载（比如 paused 或刚启动），尝试懒启动
			orch = h.manager.Get(roomID)
		}
		if orch != nil {
			// 异步派发：handler 立即返回 queued execution；真实跑动在 orchestrator loop 里
			orch.DispatchTaskAsAgent(tid, exe.ID, executor, mode)
		}
	}
	h.audit(r, roomID, "task.dispatch", tid, exe.ID)
	h.broker().Emit(roomID, agentroom.EventRoomUpdate, map[string]any{
		"roomId": roomID, "patch": map[string]any{"tasksChanged": true},
	})
	web.OK(w, r, agentroom.TaskExecutionFromModel(exe))
}

// ListTaskExecutions —— GET /tasks/{tid}/executions
func (h *AgentRoomHandler) ListTaskExecutions(w http.ResponseWriter, r *http.Request) {
	// path: /api/v1/agentroom/tasks/{tid}/executions
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/agentroom/tasks/")
	tid := strings.TrimSuffix(path, "/executions")
	if tid == "" || strings.Contains(tid, "/") {
		web.FailErr(w, r, web.ErrInvalidParam)
		return
	}
	t, err := h.repo.GetTask(tid)
	if err != nil || t == nil {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	if _, ok := h.authorizeRoom(w, r, t.RoomID); !ok {
		return
	}
	es, err := h.repo.ListTaskExecutions(tid)
	if err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	out := make([]agentroom.TaskExecution, 0, len(es))
	for i := range es {
		out = append(out, agentroom.TaskExecutionFromModel(&es[i]))
	}
	web.OK(w, r, out)
}

// SubmitExecutionResult —— POST /executions/{eid}/submit-result
func (h *AgentRoomHandler) SubmitExecutionResult(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/agentroom/executions/")
	eid := strings.TrimSuffix(path, "/submit-result")
	if eid == "" || strings.Contains(eid, "/") {
		web.FailErr(w, r, web.ErrInvalidParam)
		return
	}
	exe, err := h.repo.GetTaskExecution(eid)
	if err != nil || exe == nil {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	if _, ok := h.authorizeRoom(w, r, exe.RoomID); !ok {
		return
	}
	var req struct {
		Summary   string   `json:"summary"`
		Artifacts []string `json:"artifacts"`
		Blockers  []string `json:"blockers"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	now := agentroom.NowMs()
	artifactsJSON, _ := json.Marshal(req.Artifacts)
	blockersJSON, _ := json.Marshal(req.Blockers)
	exePatch := map[string]any{
		"status":         agentroom.TaskExecStatusCompleted,
		"summary":        strings.TrimSpace(req.Summary),
		"artifacts_json": string(artifactsJSON),
		"blockers_json":  string(blockersJSON),
		"completed_at":   &now,
	}
	if err := h.repo.UpdateTaskExecution(eid, exePatch); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	// 同步任务：result_summary + status=review（让 reviewer 接手）
	taskPatch := map[string]any{
		"result_summary": strings.TrimSpace(req.Summary),
		"status":         agentroom.TaskStatusReview,
	}
	_ = h.repo.UpdateTask(exe.TaskID, taskPatch)
	h.audit(r, exe.RoomID, "task.execution.complete", exe.TaskID, eid)
	h.broker().Emit(exe.RoomID, agentroom.EventRoomUpdate, map[string]any{
		"roomId": exe.RoomID, "patch": map[string]any{"tasksChanged": true},
	})
	newExe, _ := h.repo.GetTaskExecution(eid)
	if newExe == nil {
		web.OK(w, r, map[string]any{"status": "ok"})
		return
	}
	web.OK(w, r, agentroom.TaskExecutionFromModel(newExe))
}

// CancelExecution —— POST /executions/{eid}/cancel
func (h *AgentRoomHandler) CancelExecution(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/agentroom/executions/")
	eid := strings.TrimSuffix(path, "/cancel")
	if eid == "" || strings.Contains(eid, "/") {
		web.FailErr(w, r, web.ErrInvalidParam)
		return
	}
	exe, err := h.repo.GetTaskExecution(eid)
	if err != nil || exe == nil {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	if _, ok := h.authorizeRoom(w, r, exe.RoomID); !ok {
		return
	}
	var req struct {
		Reason string `json:"reason"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	now := agentroom.NowMs()
	patch := map[string]any{
		"status":       agentroom.TaskExecStatusCanceled,
		"completed_at": &now,
	}
	if reason := strings.TrimSpace(req.Reason); reason != "" {
		patch["error_msg"] = reason
	}
	if err := h.repo.UpdateTaskExecution(eid, patch); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	// 任务回退到 todo（前提：当前还在 in_progress）
	if t, _ := h.repo.GetTask(exe.TaskID); t != nil && t.Status == agentroom.TaskStatusInProgress {
		_ = h.repo.UpdateTask(t.ID, map[string]any{"status": agentroom.TaskStatusTodo})
	}
	h.audit(r, exe.RoomID, "task.execution.cancel", exe.TaskID, eid)
	h.broker().Emit(exe.RoomID, agentroom.EventRoomUpdate, map[string]any{
		"roomId": exe.RoomID, "patch": map[string]any{"tasksChanged": true},
	})
	newExe, _ := h.repo.GetTaskExecution(eid)
	if newExe == nil {
		web.OK(w, r, map[string]any{"status": "ok"})
		return
	}
	web.OK(w, r, agentroom.TaskExecutionFromModel(newExe))
}

func ptrInt64(v int64) *int64 { return &v }

// ─────────────────────────────── 干预事件 ───────────────────────────────

func (h *AgentRoomHandler) GetMetrics(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/metrics")
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	members, err := h.repo.ListMembers(id)
	if err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	msgs, err := h.repo.ListMessages(id, 0, 0)
	if err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	web.OK(w, r, agentroom.ComputeMetrics(members, msgs))
}

func (h *AgentRoomHandler) ListInterventions(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/interventions")
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	ivs, err := h.repo.ListInterventions(id)
	if err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	out := make([]agentroom.Intervention, 0, len(ivs))
	for i := range ivs {
		out = append(out, agentroom.InterventionFromModel(&ivs[i]))
	}
	web.OK(w, r, out)
}

// ─────────────────────────────── 干预动作 ───────────────────────────────

type forceNextRequest struct {
	MemberID string `json:"memberId"`
}

func (h *AgentRoomHandler) ForceNext(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/force-next")
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	var req forceNextRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	h.manager.Get(id).ForceNext(req.MemberID)
	_ = h.repo.CreateIntervention(&database.AgentRoomIntervention{
		RoomID: id, Level: 2, Label: "force-next", Actor: "human", TargetID: req.MemberID,
	})
	web.OK(w, r, map[string]any{"status": "ok"})
}

type emergencyStopRequest struct {
	Reason string `json:"reason,omitempty"`
}

func (h *AgentRoomHandler) EmergencyStop(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/emergency-stop")
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	var req emergencyStopRequest
	_ = json.NewDecoder(r.Body).Decode(&req)
	orch := h.manager.Get(id)
	orch.AbortCurrentTurn()
	orch.EmergencyStop(req.Reason)
	h.audit(r, id, "emergency_stop", "", req.Reason)
	web.OK(w, r, map[string]any{"status": "ok"})
}

// Fork 房间
type forkRequest struct {
	FromMessageID string `json:"fromMessageId"`
	ResetPolicy   bool   `json:"resetPolicy,omitempty"`
}

func (h *AgentRoomHandler) ForkRoom(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/fork")
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	var req forkRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	src, err := h.repo.GetRoom(id)
	if err != nil || src == nil {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	newID := agentroom.GenID("room_fork")
	// 重置预算使用量（fork 是新账本）
	budgetJSON := resetBudgetUsed(src.BudgetJSON)
	cloned := &database.AgentRoom{
		ID:              newID,
		OwnerUserID:     src.OwnerUserID,
		Title:           src.Title + " · Fork",
		TemplateID:      src.TemplateID,
		State:           agentroom.StatePaused, // fork 默认暂停，等用户手动恢复
		Policy:          src.Policy,
		BudgetJSON:      budgetJSON,
		Projection:      "", // fork 默认不继承投影（避免双发）
		Whiteboard:      src.Whiteboard,
		ParentRoomID:    id,
		ParentMessageID: req.FromMessageID,
		// v1.0 复用房间级配置（resetPolicy=true 时清空）
		Goal:               src.Goal,
		RoundBudget:        src.RoundBudget,
		CollaborationStyle: src.CollaborationStyle,
		AuxModel:           src.AuxModel,
		Constitution:       src.Constitution,
		SelfCritique:       src.SelfCritique,
	}
	if req.ResetPolicy {
		cloned.PolicyOpts = ""
		cloned.Goal = ""
		cloned.RoundBudget = 0
		cloned.CollaborationStyle = ""
	} else {
		cloned.PolicyOpts = src.PolicyOpts
	}
	if err := h.repo.CreateRoom(cloned); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	// 克隆成员（token 用量清零）
	memberIDMap := map[string]string{} // 旧 ID → 新 ID
	srcMembers, _ := h.repo.ListMembers(id)
	for _, m := range srcMembers {
		oldID := m.ID
		m.ID = fmt.Sprintf("%s_%s", newID, strings.TrimPrefix(m.ID, fmt.Sprintf("%s_", id)))
		memberIDMap[oldID] = m.ID
		m.RoomID = newID
		m.TokenUsage = 0
		m.CostMilli = 0
		m.Status = agentroom.MemberStatusIdle
		_ = h.repo.CreateMember(&m)
	}
	// 克隆事实
	srcFacts, _ := h.repo.ListFacts(id)
	for _, f := range srcFacts {
		_ = h.repo.UpsertFact(&database.AgentRoomFact{
			RoomID: newID, Key: f.Key, Value: f.Value, AuthorID: f.AuthorID,
		})
	}
	// 克隆任务
	srcTasks, _ := h.repo.ListTasks(id)
	for _, t := range srcTasks {
		t.ID = agentroom.GenID("task")
		t.RoomID = newID
		if nid, ok := memberIDMap[t.AssigneeID]; ok {
			t.AssigneeID = nid
		}
		if nid, ok := memberIDMap[t.CreatorID]; ok {
			t.CreatorID = nid
		}
		_ = h.repo.CreateTask(&t)
	}
	// 克隆消息至 fork 点（含该点）
	srcMsgs, _ := h.repo.ListMessages(id, 0, 0)
	for i := range srcMsgs {
		clone := srcMsgs[i]
		reachedFork := srcMsgs[i].ID == req.FromMessageID
		clone.ID = agentroom.GenID("msg")
		clone.RoomID = newID
		clone.Seq = 0           // 由 CreateMessage 内的 NextMessageSeq 计算
		clone.Streaming = false // fork 后不继承流式状态
		if nid, ok := memberIDMap[clone.AuthorID]; ok {
			clone.AuthorID = nid
		}
		if nid, ok := memberIDMap[clone.ActingAsID]; ok {
			clone.ActingAsID = nid
		}
		// ReferenceMessageID 指向的是旧房间的 msg，克隆后失效；清空以免悬空
		clone.ReferenceMessageID = ""
		if err := h.repo.CreateMessage(&clone); err != nil {
			break
		}
		if reachedFork {
			break
		}
	}
	h.manager.Get(newID)
	h.audit(r, id, "fork", newID, "from="+req.FromMessageID)
	snap, _ := h.repo.RoomSnapshot(newID)
	web.OK(w, r, snap)
}

// ─────────────────────────────── Planned 执行编排 ───────────────────────────────

// setExecutionQueueRequest —— POST /rooms/{id}/execution/queue
type setExecutionQueueRequest struct {
	Queue []string `json:"queue"`
}

// SetExecutionQueueHandler 保存执行队列（不触发执行）。
func (h *AgentRoomHandler) SetExecutionQueueHandler(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/execution/queue")
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	var req setExecutionQueueRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	// 硬上限：队列长度 ≤ 16，去重在 orchestrator 侧做（基于 live agents）
	if len(req.Queue) > 16 {
		web.Fail(w, r, "INVALID_PARAM", "queue too long (max 16)", http.StatusBadRequest)
		return
	}
	h.manager.Get(id).SetExecutionQueue(req.Queue)
	h.audit(r, id, "exec.queue", "", fmt.Sprintf("len=%d", len(req.Queue)))
	web.OK(w, r, map[string]any{"status": "ok"})
}

// StartExecutionHandler —— POST /rooms/{id}/execution/start
func (h *AgentRoomHandler) StartExecutionHandler(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/execution/start")
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	h.manager.Get(id).StartExecution()
	h.audit(r, id, "exec.start", "", "")
	web.OK(w, r, map[string]any{"status": "ok"})
}

// ContinueDiscussionHandler —— POST /rooms/{id}/execution/continue
func (h *AgentRoomHandler) ContinueDiscussionHandler(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/execution/continue")
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	h.manager.Get(id).ContinueDiscussion()
	h.audit(r, id, "exec.continue", "", "")
	web.OK(w, r, map[string]any{"status": "ok"})
}

// NudgeHandler —— POST /rooms/{id}/nudge  {"text":"（继续）"}
//
// v0.8 引入：当 MaxConsecutive 打满 orchestrator 让位给人后，用户不想手打一整句话，
// 只想"再跑一轮"。NudgeHandler 插入一条 human:nudge chat 消息 → 清零连续计数 → 触发下一轮。
// 比"改 state=active"的重活更轻；UI 里通常挂在房间工具栏的"▶ 继续会议"按钮上。
func (h *AgentRoomHandler) NudgeHandler(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/nudge")
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	var req struct {
		Text string `json:"text"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req) // 空 body 合法，Nudge 会填默认文案
	h.manager.Get(id).Nudge(req.Text)
	h.audit(r, id, "room.nudge", "", req.Text)
	web.OK(w, r, map[string]any{"status": "ok"})
}

// UploadDoc —— 房间级文档上传（RAG 一期）。
// multipart/form-data：字段 "file"（必填）+ "title"（可选，默认 filename）
// 仅接受 text/markdown 和 text/plain；大小 ≤ 1 MB；chunks ≤ 200。
func (h *AgentRoomHandler) UploadDoc(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/docs")
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	if err := r.ParseMultipartForm(2 * agentroom.MaxDocBytes); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	file, fh, err := r.FormFile("file")
	if err != nil {
		web.Fail(w, r, "INVALID_PARAM", "missing 'file' field", http.StatusBadRequest)
		return
	}
	defer file.Close()
	if fh.Size > agentroom.MaxDocBytes {
		web.Fail(w, r, "CONTENT_TOO_LONG", "file too large (max 1 MB)", http.StatusBadRequest)
		return
	}
	lower := strings.ToLower(fh.Filename)
	if !(strings.HasSuffix(lower, ".md") || strings.HasSuffix(lower, ".markdown") || strings.HasSuffix(lower, ".txt")) {
		web.Fail(w, r, "UNSUPPORTED_MIME", "only .md / .markdown / .txt accepted", http.StatusBadRequest)
		return
	}
	body := make([]byte, fh.Size)
	if _, err := io.ReadFull(file, body); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	title := strings.TrimSpace(r.FormValue("title"))
	if title == "" {
		title = fh.Filename
	}
	chunks := agentroom.ChunkMarkdown(string(body))
	if len(chunks) == 0 {
		web.Fail(w, r, "EMPTY_DOC", "document has no extractable content", http.StatusBadRequest)
		return
	}
	mime := "text/plain"
	if strings.HasSuffix(lower, ".md") || strings.HasSuffix(lower, ".markdown") {
		mime = "text/markdown"
	}
	doc := &database.AgentRoomDoc{
		RoomID:     id,
		Title:      title,
		SizeBytes:  fh.Size,
		Mime:       mime,
		UploaderID: web.GetUserID(r),
	}
	if err := h.repo.CreateDoc(doc, chunks); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	h.audit(r, id, "doc.upload", doc.ID, fmt.Sprintf("title=%s size=%d chunks=%d", title, fh.Size, len(chunks)))
	web.OK(w, r, doc)
}

// ListDocs —— GET /rooms/{id}/docs
func (h *AgentRoomHandler) ListDocs(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/docs")
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	docs, err := h.repo.ListDocs(id)
	if err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	web.OK(w, r, docs)
}

// DeleteDoc —— DELETE /rooms/{id}/docs/{docId}
func (h *AgentRoomHandler) DeleteDoc(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/v1/agentroom/rooms/")
	parts := strings.SplitN(rest, "/", 3)
	if len(parts) < 3 || parts[1] != "docs" {
		web.FailErr(w, r, web.ErrInvalidParam)
		return
	}
	id := parts[0]
	docID := parts[2]
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	if err := h.repo.DeleteDoc(id, docID); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	h.audit(r, id, "doc.delete", docID, "")
	web.OK(w, r, map[string]any{"status": "ok"})
}

// ListAudits 返回房间的审计流水。
func (h *AgentRoomHandler) ListAudits(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/audits")
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	limit := 200
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 500 {
			limit = n
		}
	}
	as, err := h.repo.ListAudits(id, limit)
	if err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	web.OK(w, r, as)
}

// ExportRoom 返回房间的完整可移植快照。?format=json|markdown 选择格式。
// Markdown 对人类友好，JSON 对机器友好（可用作备份/导入）。
func (h *AgentRoomHandler) ExportRoom(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/export")
	room, ok := h.authorizeRoom(w, r, id)
	if !ok {
		return
	}
	format := r.URL.Query().Get("format")
	if format == "" {
		format = "json"
	}
	members, _ := h.repo.ListMembers(id)
	msgs, _ := h.repo.ListMessages(id, 0, 0)
	facts, _ := h.repo.ListFacts(id)
	tasks, _ := h.repo.ListTasks(id)
	interventions, _ := h.repo.ListInterventions(id)

	memberName := map[string]string{}
	for _, m := range members {
		memberName[m.ID] = m.Name
	}

	filenameBase := strings.ReplaceAll(strings.TrimSpace(room.Title), "/", "_")
	if filenameBase == "" {
		filenameBase = id
	}

	if format == "markdown" || format == "md" {
		var sb strings.Builder
		fmt.Fprintf(&sb, "# %s\n\n", room.Title)
		fmt.Fprintf(&sb, "- **Room ID**: `%s`\n- **Policy**: %s\n- **State**: %s\n- **Members**: %d\n\n",
			id, room.Policy, room.State, len(members))
		if room.Whiteboard != "" {
			fmt.Fprintf(&sb, "## 白板\n\n%s\n\n", room.Whiteboard)
		}
		if len(facts) > 0 {
			sb.WriteString("## 共享事实\n\n")
			for _, f := range facts {
				fmt.Fprintf(&sb, "- **%s**: %s\n", f.Key, f.Value)
			}
			sb.WriteString("\n")
		}
		if len(tasks) > 0 {
			sb.WriteString("## 任务\n\n")
			for _, t := range tasks {
				fmt.Fprintf(&sb, "- [%s] %s (assignee: %s)\n", t.Status, t.Text, memberName[t.AssigneeID])
			}
			sb.WriteString("\n")
		}
		sb.WriteString("## 成员\n\n")
		for _, m := range members {
			fmt.Fprintf(&sb, "- %s %s (%s / %s)\n", m.Emoji, m.Name, m.Role, m.Model)
		}
		sb.WriteString("\n## 时间线\n\n")
		for _, m := range msgs {
			if m.Deleted || m.Kind == agentroom.MsgKindBidding {
				continue
			}
			name := memberName[m.AuthorID]
			if name == "" {
				name = m.AuthorID
			}
			ts := time.UnixMilli(m.Timestamp).Format("15:04:05")
			fmt.Fprintf(&sb, "**[%s] %s** (%s):\n\n%s\n\n---\n\n", ts, name, m.Kind, m.Content)
		}
		if len(interventions) > 0 {
			sb.WriteString("## 干预记录\n\n")
			for _, iv := range interventions {
				ts := time.UnixMilli(iv.At).Format("2006-01-02 15:04:05")
				fmt.Fprintf(&sb, "- [L%d] %s · %s · %s\n", iv.Level, ts, iv.Label, iv.Detail)
			}
		}
		w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.md"`, filenameBase))
		_, _ = w.Write([]byte(sb.String()))
		return
	}

	// 默认 JSON
	payload := map[string]any{
		"room":          room,
		"members":       members,
		"messages":      msgs,
		"facts":         facts,
		"tasks":         tasks,
		"interventions": interventions,
		"exportedAt":    time.Now().UnixMilli(),
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.json"`, filenameBase))
	_ = json.NewEncoder(w).Encode(payload)
}

// resetBudgetUsed 把预算 JSON 中的 usedCNY / tokensUsed 清零。
func resetBudgetUsed(raw string) string {
	if raw == "" {
		return raw
	}
	var b map[string]any
	if err := json.Unmarshal([]byte(raw), &b); err != nil {
		return raw
	}
	b["usedCNY"] = 0
	b["tokensUsed"] = 0
	out, _ := json.Marshal(b)
	return string(out)
}

// ─────────────────────────────── 子树路由分发 ───────────────────────────────
// 因 ClawDeckX 的 Router 基于 http.ServeMux 的前缀子树匹配，这里提供 4 个总入口：
//   /api/v1/agentroom/rooms/     → RoomsRouter
//   /api/v1/agentroom/messages/  → MessagesRouter
//   /api/v1/agentroom/members/   → MembersRouter
//   /api/v1/agentroom/tasks/     → TasksRouter

// RoomsRouter 分发 /api/v1/agentroom/rooms 及其子路径。
func (h *AgentRoomHandler) RoomsRouter(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/agentroom/rooms")
	path = strings.TrimPrefix(path, "/")
	// path 形态：空 / "{id}" / "{id}/messages" / "{id}/members" / "{id}/facts" / "{id}/facts/{key}" /
	//   "{id}/tasks" / "{id}/interventions" / "{id}/force-next" / "{id}/emergency-stop" / "{id}/fork"

	// /api/v1/agentroom/rooms
	if path == "" {
		switch r.Method {
		case http.MethodGet:
			h.ListRooms(w, r)
		case http.MethodPost:
			h.CreateRoom(w, r)
		default:
			web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)
		}
		return
	}
	parts := strings.Split(path, "/")
	id := parts[0]
	if id == "" {
		web.FailErr(w, r, web.ErrInvalidParam)
		return
	}
	// /api/v1/agentroom/rooms/{id}
	if len(parts) == 1 {
		switch r.Method {
		case http.MethodGet:
			h.GetRoom(w, r)
		case http.MethodPut, http.MethodPatch:
			h.UpdateRoom(w, r)
		case http.MethodDelete:
			h.DeleteRoom(w, r)
		default:
			web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)
		}
		return
	}
	// 带子资源
	sub := parts[1]
	switch sub {
	case "messages":
		switch r.Method {
		case http.MethodGet:
			h.ListMessages(w, r)
		case http.MethodPost:
			h.PostMessage(w, r)
		default:
			web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)
		}
	case "members":
		switch r.Method {
		case http.MethodGet:
			h.ListMembers(w, r)
		case http.MethodPost:
			h.AddMember(w, r)
		default:
			web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)
		}
	case "facts":
		if len(parts) == 2 && r.Method == http.MethodPost {
			h.UpsertFact(w, r)
			return
		}
		if len(parts) == 3 && r.Method == http.MethodDelete {
			h.DeleteFact(w, r)
			return
		}
		web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)
	case "tasks":
		// /rooms/{id}/tasks                       POST → CreateTask
		// /rooms/{id}/tasks/promote-decision      POST → PromoteDecisionToTask
		// /rooms/{id}/tasks/{tid}/dispatch        POST → DispatchTask
		if len(parts) == 2 && r.Method == http.MethodPost {
			h.CreateTask(w, r)
			return
		}
		if len(parts) == 3 && parts[2] == "promote-decision" && r.Method == http.MethodPost {
			h.PromoteDecisionToTask(w, r)
			return
		}
		if len(parts) == 4 && parts[3] == "dispatch" && r.Method == http.MethodPost {
			h.DispatchTask(w, r)
			return
		}
		web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)
	case "interventions":
		if r.Method == http.MethodGet {
			h.ListInterventions(w, r)
			return
		}
		web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)
	case "metrics":
		if r.Method == http.MethodGet {
			h.GetMetrics(w, r)
			return
		}
		web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)
	case "lineage":
		if r.Method == http.MethodGet {
			h.RoomLineage(w, r)
			return
		}
		web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)
	case "clone-from":
		// /rooms/{newId}/clone-from/{sourceId}
		if len(parts) == 3 && r.Method == http.MethodPost {
			h.CloneFromRoom(w, r)
			return
		}
		web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)
	case "force-next":
		if r.Method == http.MethodPost {
			h.ForceNext(w, r)
			return
		}
		web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)
	case "emergency-stop":
		if r.Method == http.MethodPost {
			h.EmergencyStop(w, r)
			return
		}
		web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)
	case "nudge":
		if r.Method == http.MethodPost {
			h.NudgeHandler(w, r)
			return
		}
		web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)
	case "purge-sessions":
		// v0.8：仅清理 gateway 侧 session，不动 DB。UI 入口：关闭会议后下拉里的"清理 AI 会话"。
		if r.Method == http.MethodPost {
			h.PurgeSessions(w, r)
			return
		}
		web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)
	case "fork":
		if r.Method == http.MethodPost {
			h.ForkRoom(w, r)
			return
		}
		web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)
	case "audits":
		if r.Method == http.MethodGet {
			h.ListAudits(w, r)
			return
		}
		web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)
	case "export":
		if r.Method == http.MethodGet {
			h.ExportRoom(w, r)
			return
		}
		web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)
	case "search":
		if r.Method == http.MethodGet {
			h.SearchMessages(w, r)
			return
		}
		web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)
	case "execution":
		// rooms/{id}/execution/{action}
		if len(parts) != 3 || r.Method != http.MethodPost {
			web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		switch parts[2] {
		case "queue":
			h.SetExecutionQueueHandler(w, r)
		case "start":
			h.StartExecutionHandler(w, r)
		case "continue":
			h.ContinueDiscussionHandler(w, r)
		default:
			web.FailErr(w, r, web.ErrNotFound)
		}
		return
	case "docs":
		// 子资源路径形态：
		//   rooms/{id}/docs          POST=upload, GET=list
		//   rooms/{id}/docs/{docId}  DELETE=remove
		if len(parts) == 2 {
			switch r.Method {
			case http.MethodGet:
				h.ListDocs(w, r)
				return
			case http.MethodPost:
				h.UploadDoc(w, r)
				return
			}
			web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if len(parts) == 3 && r.Method == http.MethodDelete {
			h.DeleteDoc(w, r)
			return
		}
		web.FailErr(w, r, web.ErrNotFound)

	// v0.6 ──────────────────────────────────────────
	case "decisions":
		if r.Method == http.MethodGet {
			h.ListDecisions(w, r)
			return
		}
		web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)

	case "artifacts":
		if r.Method == http.MethodGet {
			h.ListArtifacts(w, r)
			return
		}
		if r.Method == http.MethodPost {
			h.CreateArtifact(w, r)
			return
		}
		web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)

	case "close":
		// rooms/{id}/close            → POST 仅关闭（不跑流水线）v0.9.1
		// rooms/{id}/close/synthesize → POST 旧 v0.6 synthesize 入口（遗留）
		if len(parts) == 2 && r.Method == http.MethodPost {
			h.CloseOnly(w, r)
			return
		}
		if len(parts) == 3 && parts[2] == "synthesize" && r.Method == http.MethodPost {
			h.SynthesizeMinutes(w, r)
			return
		}
		web.FailErr(w, r, web.ErrNotFound)

	case "extract-todo":
		if r.Method == http.MethodPost {
			h.ExtractTodo(w, r)
			return
		}
		web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)

	case "extract-questions":
		if r.Method == http.MethodPost {
			h.ExtractQuestions(w, r)
			return
		}
		web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)

	case "extract-risks":
		if r.Method == http.MethodPost {
			h.ExtractRisks(w, r)
			return
		}
		web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)

	case "ask-all":
		if r.Method == http.MethodPost {
			h.AskAll(w, r)
			return
		}
		web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)

	case "playbooks":
		// rooms/{id}/playbooks/{pid}/apply
		if len(parts) == 4 && parts[3] == "apply" && r.Method == http.MethodPost {
			h.ApplyPlaybook(w, r)
			return
		}
		web.FailErr(w, r, web.ErrNotFound)

	// ═══════════════ v0.7 真实会议环节 ═══════════════

	case "closeout":
		// rooms/{id}/closeout            → POST 启动流水线
		// rooms/{id}/closeout/cancel     → POST 取消正在跑的流水线
		if len(parts) == 3 && parts[2] == "cancel" && r.Method == http.MethodPost {
			h.CloseoutCancel(w, r)
			return
		}
		if len(parts) == 2 && r.Method == http.MethodPost {
			h.Closeout(w, r)
			return
		}
		web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)

	case "reopen":
		// rooms/{id}/reopen → POST 把 closed 房间重启为 paused
		if len(parts) == 2 && r.Method == http.MethodPost {
			h.Reopen(w, r)
			return
		}
		web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)

	case "outcome":
		if r.Method == http.MethodGet {
			h.GetOutcome(w, r)
			return
		}
		web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)

	case "retro":
		// rooms/{id}/retro → GET/PUT
		// rooms/{id}/retro/regenerate → POST
		if len(parts) == 2 {
			switch r.Method {
			case http.MethodGet:
				h.GetRetro(w, r)
				return
			case http.MethodPut, http.MethodPatch:
				h.UpdateRetro(w, r)
				return
			}
			web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if len(parts) == 3 && parts[2] == "regenerate" && r.Method == http.MethodPost {
			h.RegenerateRetro(w, r)
			return
		}
		web.FailErr(w, r, web.ErrNotFound)

	case "agenda":
		// rooms/{id}/agenda → GET/POST
		// rooms/{id}/agenda/advance → POST
		// rooms/{id}/agenda/reorder → POST
		if len(parts) == 2 {
			switch r.Method {
			case http.MethodGet:
				h.ListAgenda(w, r)
				return
			case http.MethodPost:
				h.CreateAgenda(w, r)
				return
			}
			web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if len(parts) == 3 && r.Method == http.MethodPost {
			switch parts[2] {
			case "advance":
				h.AdvanceAgenda(w, r)
				return
			case "reorder":
				h.ReorderAgenda(w, r)
				return
			}
		}
		web.FailErr(w, r, web.ErrNotFound)

	case "questions":
		if r.Method == http.MethodGet {
			h.ListQuestions(w, r)
			return
		}
		if r.Method == http.MethodPost {
			h.CreateQuestion(w, r)
			return
		}
		web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)

	case "parking":
		if r.Method == http.MethodGet {
			h.ListParking(w, r)
			return
		}
		if r.Method == http.MethodPost {
			h.CreateParking(w, r)
			return
		}
		web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)

	case "risks":
		if r.Method == http.MethodGet {
			h.ListRisks(w, r)
			return
		}
		if r.Method == http.MethodPost {
			h.CreateRisk(w, r)
			return
		}
		web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)

	case "votes":
		if r.Method == http.MethodGet {
			h.ListVotes(w, r)
			return
		}
		if r.Method == http.MethodPost {
			h.CreateVote(w, r)
			return
		}
		web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)

	default:
		web.FailErr(w, r, web.ErrNotFound)
	}
}

// ─────────────── v0.7 顶层子树路由 ───────────────

// AgendaItemsRouter —— /api/v1/agentroom/agenda-items/{aid}[/park]
func (h *AgentRoomHandler) AgendaItemsRouter(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/agentroom/agenda-items"), "/")
	if rest == "" {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	parts := strings.Split(rest, "/")
	if len(parts) == 1 {
		switch r.Method {
		case http.MethodPut, http.MethodPatch:
			h.UpdateAgendaItem(w, r)
			return
		case http.MethodDelete:
			h.DeleteAgendaItem(w, r)
			return
		}
		web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if len(parts) == 2 && parts[1] == "park" && r.Method == http.MethodPost {
		h.ParkAgendaItem(w, r)
		return
	}
	web.FailErr(w, r, web.ErrNotFound)
}

// QuestionsRouter —— /api/v1/agentroom/questions/{qid}
func (h *AgentRoomHandler) QuestionsRouter(w http.ResponseWriter, r *http.Request) {
	qid := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/agentroom/questions"), "/")
	if qid == "" {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	switch r.Method {
	case http.MethodPut, http.MethodPatch:
		h.UpdateQuestion(w, r)
	case http.MethodDelete:
		h.DeleteQuestion(w, r)
	default:
		web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)
	}
}

// ParkingRouter —— /api/v1/agentroom/parking/{pid}
func (h *AgentRoomHandler) ParkingRouter(w http.ResponseWriter, r *http.Request) {
	pid := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/agentroom/parking"), "/")
	if pid == "" {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	switch r.Method {
	case http.MethodPut, http.MethodPatch:
		h.UpdateParking(w, r)
	case http.MethodDelete:
		h.DeleteParking(w, r)
	default:
		web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)
	}
}

// RisksRouter —— /api/v1/agentroom/risks/{rkid}
func (h *AgentRoomHandler) RisksRouter(w http.ResponseWriter, r *http.Request) {
	rkid := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/agentroom/risks"), "/")
	if rkid == "" {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	switch r.Method {
	case http.MethodPut, http.MethodPatch:
		h.UpdateRisk(w, r)
	case http.MethodDelete:
		h.DeleteRisk(w, r)
	default:
		web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)
	}
}

// VotesRouter —— /api/v1/agentroom/votes/{vid}[/ballot|/tally]
func (h *AgentRoomHandler) VotesRouter(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/agentroom/votes"), "/")
	if rest == "" {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	parts := strings.Split(rest, "/")
	if len(parts) == 1 {
		switch r.Method {
		case http.MethodGet:
			h.GetVote(w, r)
			return
		case http.MethodDelete:
			h.DeleteVote(w, r)
			return
		}
		web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if len(parts) == 2 && r.Method == http.MethodPost {
		switch parts[1] {
		case "ballot":
			h.UpsertBallot(w, r)
			return
		case "tally":
			h.TallyVote(w, r)
			return
		}
	}
	web.FailErr(w, r, web.ErrNotFound)
}

// RetrosRouter —— /api/v1/agentroom/retros —— dashboard list
func (h *AgentRoomHandler) RetrosRouter(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		h.ListRetros(w, r)
		return
	}
	web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)
}

// MessagesRouter 分发 /api/v1/agentroom/messages/{mid}[/react]。
func (h *AgentRoomHandler) MessagesRouter(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/agentroom/messages")
	path = strings.TrimPrefix(path, "/")
	if path == "" {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	parts := strings.Split(path, "/")
	if len(parts) == 1 {
		switch r.Method {
		case http.MethodPut, http.MethodPatch:
			h.EditMessage(w, r)
		case http.MethodDelete:
			h.DeleteMessage(w, r)
		default:
			web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)
		}
		return
	}
	if len(parts) == 2 && parts[1] == "react" && r.Method == http.MethodPost {
		h.ReactMessage(w, r)
		return
	}
	// v0.6 ── promote-decision / rerun
	if len(parts) == 2 && parts[1] == "promote-decision" {
		switch r.Method {
		case http.MethodPost:
			h.PromoteDecision(w, r)
			return
		case http.MethodDelete:
			h.DemoteDecision(w, r)
			return
		}
		web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if len(parts) == 2 && parts[1] == "rerun" && r.Method == http.MethodPost {
		h.RerunMessage(w, r)
		return
	}
	// v0.3 主题 D：决策撤回前的影响分析
	if len(parts) == 2 && parts[1] == "decision-impact" && r.Method == http.MethodGet {
		h.DecisionImpact(w, r)
		return
	}
	web.FailErr(w, r, web.ErrNotFound)
}

// ArtifactsRouter 分发 /api/v1/agentroom/artifacts/{aid} (v0.6 独立子树，room 内的列表/创建走 RoomsRouter)。
func (h *AgentRoomHandler) ArtifactsRouter(w http.ResponseWriter, r *http.Request) {
	aid := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/agentroom/artifacts"), "/")
	if aid == "" {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	switch r.Method {
	case http.MethodPut, http.MethodPatch:
		h.UpdateArtifact(w, r)
	case http.MethodDelete:
		h.DeleteArtifact(w, r)
	default:
		web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)
	}
}

// PlaybooksRouter 分发 /api/v1/agentroom/playbooks[/...]。
//
// v0.7 扩展：
//
//	GET  /playbooks            → ListPlaybooksV7（结构化）
//	GET  /playbooks/search     → 搜索（q / limit）
//	GET  /playbooks/recommend  → 按 goal/templateId 打分推荐（新房间 wizard 用）
//	GET  /playbooks/{id}       → PlaybookV7 详情
//	PUT  /playbooks/{id}       → 结构化编辑（version++）
//	POST /playbooks/{id}/favorite → 切换收藏
//	DELETE /playbooks/{id}     → 删除
//	POST /playbooks            → 创建（v0.6 旧接口，半自动）
func (h *AgentRoomHandler) PlaybooksRouter(w http.ResponseWriter, r *http.Request) {
	p := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/agentroom/playbooks"), "/")
	if p == "" {
		switch r.Method {
		case http.MethodGet:
			h.ListPlaybooksV7(w, r)
		case http.MethodPost:
			h.CreatePlaybook(w, r)
		default:
			web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)
		}
		return
	}
	parts := strings.Split(p, "/")
	// 静态子路径（search / recommend）
	if len(parts) == 1 {
		switch parts[0] {
		case "search":
			if r.Method == http.MethodGet {
				h.SearchPlaybooks(w, r)
				return
			}
			web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)
			return
		case "recommend":
			if r.Method == http.MethodGet {
				h.RecommendPlaybooks(w, r)
				return
			}
			web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		// {id}：GET / PUT / DELETE
		switch r.Method {
		case http.MethodGet:
			h.GetPlaybookV7(w, r)
			return
		case http.MethodPut, http.MethodPatch:
			h.UpdatePlaybookV7(w, r)
			return
		case http.MethodDelete:
			h.DeletePlaybook(w, r)
			return
		}
		web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// {id}/favorite
	if len(parts) == 2 && parts[1] == "favorite" && r.Method == http.MethodPost {
		h.TogglePlaybookFavorite(w, r)
		return
	}
	web.FailErr(w, r, web.ErrNotFound)
}

// PersonaMemoryRouter 分发 /api/v1/agentroom/persona-memory[/{key}]。
// key 本身可以带冒号（user:42:developer），所以直接 Trim 前缀后整段当 key 用。
func (h *AgentRoomHandler) PersonaMemoryRouter(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/agentroom/persona-memory"), "/")
	if rest == "" {
		if r.Method == http.MethodGet {
			h.ListPersonaMemories(w, r)
			return
		}
		web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	switch r.Method {
	case http.MethodGet:
		h.GetPersonaMemory(w, r)
	case http.MethodPut, http.MethodPatch, http.MethodPost:
		h.UpsertPersonaMemory(w, r)
	case http.MethodDelete:
		h.DeletePersonaMemory(w, r)
	default:
		web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)
	}
}

// MembersRouter 分发 /api/v1/agentroom/members/{mid}/action 和 DELETE /api/v1/agentroom/members/{mid}。
func (h *AgentRoomHandler) MembersRouter(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/agentroom/members")
	path = strings.TrimPrefix(path, "/")
	parts := strings.Split(path, "/")
	if len(parts) == 2 && parts[1] == "action" && r.Method == http.MethodPost {
		h.MemberAction(w, r)
		return
	}
	// DELETE /api/v1/agentroom/members/{mid} —— 真删除成员
	if len(parts) == 1 && parts[0] != "" && r.Method == http.MethodDelete {
		h.RemoveMember(w, r)
		return
	}
	web.FailErr(w, r, web.ErrNotFound)
}

// TasksRouter 分发 /api/v1/agentroom/tasks/{tid}[/accept|/executions]。
//
//	PATCH/PUT /tasks/{tid}                → UpdateTask
//	DELETE    /tasks/{tid}                → DeleteTask
//	POST      /tasks/{tid}/accept         → AcceptTask（验收/返工，v0.2 GAP G3）
//	GET       /tasks/{tid}/executions     → ListTaskExecutions（v0.2 GAP G4）
func (h *AgentRoomHandler) TasksRouter(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/agentroom/tasks")
	path = strings.TrimPrefix(path, "/")
	if path == "" {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	parts := strings.Split(path, "/")
	// /tasks/{tid}/accept
	if len(parts) == 2 && parts[1] == "accept" {
		if r.Method != http.MethodPost {
			web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		h.AcceptTask(w, r)
		return
	}
	// /tasks/{tid}/executions
	if len(parts) == 2 && parts[1] == "executions" {
		if r.Method != http.MethodGet {
			web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		h.ListTaskExecutions(w, r)
		return
	}
	// /tasks/{tid}/lineage
	if len(parts) == 2 && parts[1] == "lineage" {
		if r.Method != http.MethodGet {
			web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		h.TaskLineage(w, r)
		return
	}
	if len(parts) != 1 {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	switch r.Method {
	case http.MethodPut, http.MethodPatch:
		h.UpdateTask(w, r)
	case http.MethodDelete:
		t, _ := h.repo.GetTask(path)
		if err := h.repo.DeleteTask(path); err != nil {
			web.FailErr(w, r, web.ErrDBQuery)
			return
		}
		if t != nil {
			h.broker().Emit(t.RoomID, agentroom.EventRoomUpdate, map[string]any{
				"roomId": t.RoomID, "patch": map[string]any{"tasksChanged": true},
			})
		}
		web.OK(w, r, map[string]any{"status": "ok"})
	default:
		web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)
	}
}

// ExecutionsRouter 分发 /api/v1/agentroom/executions/{eid}/{op}。
//
//	POST /executions/{eid}/submit-result  → SubmitExecutionResult
//	POST /executions/{eid}/cancel         → CancelExecution
func (h *AgentRoomHandler) ExecutionsRouter(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/agentroom/executions")
	path = strings.TrimPrefix(path, "/")
	if path == "" {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	parts := strings.Split(path, "/")
	if len(parts) != 2 || r.Method != http.MethodPost {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	switch parts[1] {
	case "submit-result":
		h.SubmitExecutionResult(w, r)
	case "cancel":
		h.CancelExecution(w, r)
	default:
		web.FailErr(w, r, web.ErrNotFound)
	}
}

func (h *AgentRoomHandler) RoleProfilesRouter(w http.ResponseWriter, r *http.Request) {
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/agentroom/role-profiles"), "/")
	if path == "" {
		switch r.Method {
		case http.MethodGet:
			h.ListRoleProfiles(w, r)
		case http.MethodPost:
			h.CreateRoleProfile(w, r)
		default:
			web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)
		}
		return
	}
	switch r.Method {
	case http.MethodPut, http.MethodPatch:
		h.UpdateRoleProfile(w, r)
	case http.MethodDelete:
		h.DeleteRoleProfile(w, r)
	default:
		web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)
	}
}

// ─────────────────────────────── 辅助 ───────────────────────────────

func (h *AgentRoomHandler) broker() *agentroom.Broker {
	// Orchestrators all share the same broker; grab one via manager (or a zero-room getter).
	// 用任意房间的 orchestrator 都能访问到同一个 broker；这里偷懒挂在 manager 上。
	return h.manager.Broker()
}

func pathID(r *http.Request, prefix string) string {
	return strings.Trim(strings.TrimPrefix(r.URL.Path, prefix), "/")
}

func jsonUnmarshalSlice(s string) []string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	var out []string
	if err := json.Unmarshal([]byte(s), &out); err != nil {
		return nil
	}
	return out
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func firstNonEmptySlice(values ...[]string) []string {
	for _, v := range values {
		if len(v) > 0 {
			return v
		}
	}
	return nil
}

func pathIDBetween(r *http.Request, prefix, suffix string) string {
	p := strings.TrimPrefix(r.URL.Path, prefix)
	idx := strings.Index(p, suffix)
	if idx < 0 {
		return ""
	}
	return p[:idx]
}

func pathIDLast(r *http.Request, prefix string) string {
	p := strings.TrimPrefix(r.URL.Path, prefix)
	// 允许最后带或不带斜杠
	p = strings.TrimSuffix(p, "/")
	// 取第一段作为 id
	if idx := strings.Index(p, "/"); idx >= 0 {
		return p[:idx]
	}
	return p
}

// ─────────────────────── OpenClaw Gateway 桥接（v0.4） ───────────────────────
//
// v0.4 起所有 agent 推理都走 OpenClaw Gateway RPC。工具调用与审批由 OpenClaw
// 原生审批流处理（gateway 的 exec.approval），不再经 DeckX tool-bridge。
// 前端 Member 编辑器通过 /api/v1/agentroom/gateway/agents 拉取 agent 目录。

// GatewayListAgents 代理到 OpenClaw 的 agents.list RPC，返回可供房间成员绑定的 agent 列表。
// 路径：GET /api/v1/agentroom/gateway/agents
func (h *AgentRoomHandler) GatewayListAgents(w http.ResponseWriter, r *http.Request) {
	bridge := h.manager.Bridge()
	if bridge == nil || !bridge.IsAvailable() {
		web.Fail(w, r, "GATEWAY_UNAVAILABLE", "OpenClaw gateway is not connected", http.StatusServiceUnavailable)
		return
	}
	agents, err := bridge.ListAgents(r.Context())
	if err != nil {
		web.Fail(w, r, "GATEWAY_LIST_AGENTS_FAILED", err.Error(), http.StatusBadGateway)
		return
	}
	web.OK(w, r, map[string]any{"agents": agents})
}

// GatewayStatus 暴露 bridge 的可用状态，前端房间创建向导检测"桥接就绪"。
// 路径：GET /api/v1/agentroom/gateway/status
func (h *AgentRoomHandler) GatewayStatus(w http.ResponseWriter, r *http.Request) {
	bridge := h.manager.Bridge()
	status := map[string]any{"available": false}
	if bridge != nil {
		status["available"] = bridge.IsAvailable()
	}
	web.OK(w, r, status)
}

func marshalStrings(ss []string) string {
	if len(ss) == 0 {
		return ""
	}
	b, _ := json.Marshal(ss)
	return string(b)
}

func rewritePrefix(s, oldPrefix, newPrefix string) string {
	if s == "" || !strings.HasPrefix(s, oldPrefix+"_") {
		return s
	}
	return newPrefix + "_" + strings.TrimPrefix(s, oldPrefix+"_")
}
