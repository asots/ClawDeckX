package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"ClawDeckX/internal/agentroom"
	"ClawDeckX/internal/database"
	"ClawDeckX/internal/web"
)

// v0.7 handlers —— 真实会议环节。
//
// URL 划分：
//   /api/v1/agentroom/rooms/{id}/closeout              POST    关闭仪式流水线
//   /api/v1/agentroom/rooms/{id}/outcome               GET     最近一次产出总包
//   /api/v1/agentroom/rooms/{id}/retro                 GET/PUT/POST(regenerate)
//   /api/v1/agentroom/rooms/{id}/agenda                GET/POST
//   /api/v1/agentroom/rooms/{id}/agenda/advance        POST
//   /api/v1/agentroom/rooms/{id}/agenda/reorder        POST
//   /api/v1/agentroom/agenda-items/{aid}               PUT/DELETE
//   /api/v1/agentroom/agenda-items/{aid}/park          POST
//   /api/v1/agentroom/rooms/{id}/questions             GET/POST
//   /api/v1/agentroom/questions/{qid}                  PUT/DELETE
//   /api/v1/agentroom/rooms/{id}/parking               GET/POST
//   /api/v1/agentroom/parking/{pid}                    PUT/DELETE
//   /api/v1/agentroom/rooms/{id}/risks                 GET/POST
//   /api/v1/agentroom/risks/{rkid}                     PUT/DELETE
//   /api/v1/agentroom/rooms/{id}/votes                 GET/POST
//   /api/v1/agentroom/votes/{vid}                      GET/DELETE
//   /api/v1/agentroom/votes/{vid}/ballot               POST (upsert own ballot)
//   /api/v1/agentroom/votes/{vid}/tally                POST (close + compute result)
//   /api/v1/agentroom/playbooks/{id}                   GET/PUT (structured update, version++)
//   /api/v1/agentroom/playbooks/{id}/favorite          POST
//   /api/v1/agentroom/playbooks/search?q=...&limit=50  GET
//   /api/v1/agentroom/playbooks/recommend?goal=...     GET (给新房间 wizard)
//   /api/v1/agentroom/retros                           GET (dashboard 所有 retro)

// ═══════════════ Closeout ═══════════════

type closeoutRequest struct {
	CloseRoom bool `json:"closeRoom,omitempty"` // true = 把 room 标为 closed
}

// Closeout —— POST /rooms/{id}/closeout
func (h *AgentRoomHandler) Closeout(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/closeout")
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	var req closeoutRequest
	_ = json.NewDecoder(r.Body).Decode(&req)
	res, err := h.manager.Get(id).Closeout(r.Context(), req.CloseRoom)
	if err != nil {
		web.Fail(w, r, "CLOSEOUT_FAILED", err.Error(), http.StatusInternalServerError)
		return
	}
	h.audit(r, id, "room.closeout", "", strconv.FormatBool(req.CloseRoom))
	web.OK(w, r, res)
}

// CloseOnly —— POST /rooms/{id}/close
// v0.9.1：仅把房间状态切到 closed，不跑 Closeout 流水线。适用于"已经有纪要/不需要 AI 总结"的场景。
func (h *AgentRoomHandler) CloseOnly(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/close")
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	if err := h.manager.Get(id).CloseOnly(); err != nil {
		web.Fail(w, r, "CLOSE_FAILED", err.Error(), http.StatusBadRequest)
		return
	}
	h.audit(r, id, "room.close_only", "", "")
	web.OK(w, r, map[string]string{"status": "ok"})
}

// Reopen —— POST /rooms/{id}/reopen
// v0.9.1：把一个已关闭的房间重新开启到 paused 状态。用户可以点"继续会议"让
// agent 再跑一轮，或自己输入消息。产出物（minutes/todo/playbook/retro）保留。
func (h *AgentRoomHandler) Reopen(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/reopen")
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	if err := h.manager.Get(id).Reopen(); err != nil {
		web.Fail(w, r, "REOPEN_FAILED", err.Error(), http.StatusBadRequest)
		return
	}
	h.audit(r, id, "room.reopen", "", "")
	web.OK(w, r, map[string]string{"status": "ok"})
}

// CloseoutCancel —— POST /rooms/{id}/closeout/cancel
// 打断正在进行的 Closeout 流水线。立即返回，不等步骤跑完。
// 已完成的步骤结果保留；剩余步骤会在 ctx.Err() 检查后标为 skipped 广播。
// 没有正在跑的 closeout 时也返回 200（幂等）。
func (h *AgentRoomHandler) CloseoutCancel(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/closeout/cancel")
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	h.manager.Get(id).CancelCloseout()
	h.audit(r, id, "room.closeout.cancel", "", "")
	web.OK(w, r, map[string]string{"status": "ok"})
}

// GetOutcome —— GET /rooms/{id}/outcome —— 返回最近一份 outcome_bundle artifact 的解析结果。
func (h *AgentRoomHandler) GetOutcome(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/outcome")
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	arts, err := h.repo.ListArtifacts(id)
	if err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	var bundleArt *database.AgentRoomArtifact
	for i := range arts {
		if arts[i].Kind == "outcome_bundle" {
			bundleArt = &arts[i]
			break
		}
	}
	retro, _ := h.repo.GetRetro(id)
	resp := map[string]any{
		"hasBundle": bundleArt != nil,
	}
	if bundleArt != nil {
		resp["bundleArtifactId"] = bundleArt.ID
		resp["bundle"] = agentroom.ArtifactFromModel(bundleArt)
	}
	if retro != nil {
		rx := agentroom.RetroFromModel(retro)
		resp["retro"] = rx
	}
	web.OK(w, r, resp)
}

// ═══════════════ Retro ═══════════════

type retroUpdateRequest struct {
	ScoreOverall         *int                        `json:"scoreOverall,omitempty"`
	ScoreGoal            *int                        `json:"scoreGoal,omitempty"`
	ScoreQuality         *int                        `json:"scoreQuality,omitempty"`
	ScoreDecisionClarity *int                        `json:"scoreDecisionClarity,omitempty"`
	ScoreEfficiency      *int                        `json:"scoreEfficiency,omitempty"`
	OffTopicRate         *int                        `json:"offTopicRate,omitempty"`
	Highlights           []string                    `json:"highlights,omitempty"`
	Lowlights            []string                    `json:"lowlights,omitempty"`
	Summary              *string                     `json:"summary,omitempty"`
	PlaybookID           *string                     `json:"playbookId,omitempty"`
	NextMeetingDraft     *agentroom.NextMeetingDraft `json:"nextMeetingDraft,omitempty"`
}

// GetRetro —— GET /rooms/{id}/retro
func (h *AgentRoomHandler) GetRetro(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/retro")
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	rx, err := h.repo.GetRetro(id)
	if err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	if rx == nil {
		web.OK(w, r, nil)
		return
	}
	web.OK(w, r, agentroom.RetroFromModel(rx))
}

// UpdateRetro —— PUT /rooms/{id}/retro
func (h *AgentRoomHandler) UpdateRetro(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/retro")
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	existing, err := h.repo.GetRetro(id)
	if err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	if existing == nil {
		existing = &database.AgentRoomRetro{RoomID: id, GeneratedAt: agentroom.NowMs()}
	}
	var req retroUpdateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	clamp := func(v int) int {
		if v < 0 {
			return 0
		}
		if v > 100 {
			return 100
		}
		return v
	}
	if req.ScoreOverall != nil {
		existing.ScoreOverall = clamp(*req.ScoreOverall)
	}
	if req.ScoreGoal != nil {
		existing.ScoreGoal = clamp(*req.ScoreGoal)
	}
	if req.ScoreQuality != nil {
		existing.ScoreQuality = clamp(*req.ScoreQuality)
	}
	if req.ScoreDecisionClarity != nil {
		existing.ScoreDecisionClarity = clamp(*req.ScoreDecisionClarity)
	}
	if req.ScoreEfficiency != nil {
		existing.ScoreEfficiency = clamp(*req.ScoreEfficiency)
	}
	if req.OffTopicRate != nil {
		existing.OffTopicRate = clamp(*req.OffTopicRate)
	}
	if req.Highlights != nil {
		b, _ := json.Marshal(req.Highlights)
		existing.HighlightsJSON = string(b)
	}
	if req.Lowlights != nil {
		b, _ := json.Marshal(req.Lowlights)
		existing.LowlightsJSON = string(b)
	}
	if req.Summary != nil {
		existing.Summary = *req.Summary
	}
	if req.PlaybookID != nil {
		existing.PlaybookID = strings.TrimSpace(*req.PlaybookID)
	}
	if req.NextMeetingDraft != nil {
		b, _ := json.Marshal(req.NextMeetingDraft)
		existing.NextMeetingDraftJSON = string(b)
	}
	if err := h.repo.UpsertRetro(existing); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	h.audit(r, id, "retro.update", "", "")
	got, _ := h.repo.GetRetro(id)
	out := agentroom.RetroFromModel(got)
	if got != nil {
		bundle := &agentroom.OutcomeBundle{
			RoomID:      id,
			PlaybookID:  got.PlaybookID,
			Retro:       &out,
			GeneratedAt: agentroom.NowMs(),
		}
		h.manager.Get(id).DeliverInterRoomBus(r.Context(), "retro.updated", bundle)
	}
	web.OK(w, r, out)
}

// RegenerateRetro —— POST /rooms/{id}/retro/regenerate —— 重新跑一次 LLM 评分
func (h *AgentRoomHandler) RegenerateRetro(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/v1/agentroom/rooms/"), "/")
	if len(parts) < 3 || parts[1] != "retro" || parts[2] != "regenerate" {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	id := parts[0]
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	orch := h.manager.Get(id)
	rx, err := orch.GenerateRetro(r.Context())
	if err != nil {
		web.Fail(w, r, "RETRO_FAILED", err.Error(), http.StatusInternalServerError)
		return
	}
	// 保留已有 artifact/playbook 链接
	if existing, _ := h.repo.GetRetro(id); existing != nil {
		rx.OutcomeArtifactID = existing.OutcomeArtifactID
		rx.MinutesArtifactID = existing.MinutesArtifactID
		rx.PlaybookID = existing.PlaybookID
	}
	// 写入
	hi, _ := json.Marshal(rx.Highlights)
	lo, _ := json.Marshal(rx.Lowlights)
	nmd := ""
	if rx.NextMeetingDraft != nil {
		b, _ := json.Marshal(rx.NextMeetingDraft)
		nmd = string(b)
	}
	_ = h.repo.UpsertRetro(&database.AgentRoomRetro{
		RoomID: id, ScoreOverall: rx.ScoreOverall,
		ScoreGoal: rx.ScoreGoal, ScoreQuality: rx.ScoreQuality,
		ScoreDecisionClarity: rx.ScoreDecisionClarity, ScoreEfficiency: rx.ScoreEfficiency,
		OffTopicRate: rx.OffTopicRate, HighlightsJSON: string(hi), LowlightsJSON: string(lo),
		Summary: rx.Summary, NextMeetingDraftJSON: nmd,
		OutcomeArtifactID: rx.OutcomeArtifactID, MinutesArtifactID: rx.MinutesArtifactID,
		PlaybookID: rx.PlaybookID, GeneratedAt: rx.GeneratedAt,
	})
	bundle := &agentroom.OutcomeBundle{
		RoomID:      id,
		PlaybookID:  rx.PlaybookID,
		Retro:       rx,
		GeneratedAt: agentroom.NowMs(),
	}
	orch.DeliverInterRoomBus(r.Context(), "retro.updated", bundle)
	h.audit(r, id, "retro.regenerate", "", strconv.Itoa(rx.ScoreOverall))
	web.OK(w, r, rx)
}

// ListRetros —— GET /retros —— dashboard 列表
func (h *AgentRoomHandler) ListRetros(w http.ResponseWriter, r *http.Request) {
	uid := web.GetUserID(r)
	rows, err := h.repo.ListRetros(uid)
	if err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	type item struct {
		agentroom.Retro
		RoomTitle string `json:"roomTitle"`
		RoomGoal  string `json:"roomGoal,omitempty"`
	}
	out := make([]item, 0, len(rows))
	for _, x := range rows {
		rx := agentroom.RetroFromModel(&x.AgentRoomRetro)
		out = append(out, item{Retro: rx, RoomTitle: x.RoomTitle, RoomGoal: x.RoomGoal})
	}
	web.OK(w, r, out)
}

// ═══════════════ Agenda ═══════════════

type agendaItemRequest struct {
	Title         string   `json:"title"`
	Description   string   `json:"description,omitempty"`
	TargetOutcome string   `json:"targetOutcome,omitempty"`
	Policy        string   `json:"policy,omitempty"`
	RoundBudget   int      `json:"roundBudget,omitempty"`
	AssigneeIDs   []string `json:"assigneeIds,omitempty"`
}

// ListAgenda —— GET /rooms/{id}/agenda
func (h *AgentRoomHandler) ListAgenda(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/agenda")
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	items, err := h.repo.ListAgendaItems(id)
	if err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	out := make([]agentroom.AgendaItem, 0, len(items))
	for i := range items {
		out = append(out, agentroom.AgendaItemFromModel(&items[i]))
	}
	web.OK(w, r, out)
}

// CreateAgenda —— POST /rooms/{id}/agenda
func (h *AgentRoomHandler) CreateAgenda(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/agenda")
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	var req agendaItemRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	title := strings.TrimSpace(req.Title)
	if title == "" {
		web.Fail(w, r, "INVALID_PARAM", "title required", http.StatusBadRequest)
		return
	}
	ids := ""
	if len(req.AssigneeIDs) > 0 {
		b, _ := json.Marshal(req.AssigneeIDs)
		ids = string(b)
	}
	a := &database.AgentRoomAgendaItem{
		RoomID: id, Title: title, Description: req.Description,
		TargetOutcome: req.TargetOutcome, Policy: req.Policy, RoundBudget: req.RoundBudget,
		AssigneeIDsJSON: ids,
	}
	if err := h.repo.CreateAgendaItem(a); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	h.broker().Emit(id, "room.agenda.append", map[string]any{
		"roomId": id, "item": agentroom.AgendaItemFromModel(a),
	})
	h.audit(r, id, "agenda.create", a.ID, title)
	web.OK(w, r, agentroom.AgendaItemFromModel(a))
}

// UpdateAgendaItem —— PUT /agenda-items/{aid}
func (h *AgentRoomHandler) UpdateAgendaItem(w http.ResponseWriter, r *http.Request) {
	aid := pathID(r, "/api/v1/agentroom/agenda-items/")
	existing, err := h.repo.GetAgendaItem(aid)
	if err != nil || existing == nil {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	if _, ok := h.authorizeRoom(w, r, existing.RoomID); !ok {
		return
	}
	var req agendaItemRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	patch := map[string]any{}
	if req.Title != "" {
		patch["title"] = req.Title
	}
	patch["description"] = req.Description
	patch["target_outcome"] = req.TargetOutcome
	patch["policy"] = req.Policy
	patch["round_budget"] = req.RoundBudget
	if req.AssigneeIDs != nil {
		if len(req.AssigneeIDs) == 0 {
			patch["assignee_ids_json"] = ""
		} else {
			b, _ := json.Marshal(req.AssigneeIDs)
			patch["assignee_ids_json"] = string(b)
		}
	}
	if err := h.repo.UpdateAgendaItem(aid, patch); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	got, _ := h.repo.GetAgendaItem(aid)
	h.broker().Emit(existing.RoomID, "room.agenda.update", map[string]any{
		"roomId": existing.RoomID, "itemId": aid,
		"patch": map[string]any{
			"title": got.Title, "description": got.Description,
			"targetOutcome": got.TargetOutcome, "policy": got.Policy,
			"roundBudget": got.RoundBudget,
		},
	})
	web.OK(w, r, agentroom.AgendaItemFromModel(got))
}

// DeleteAgendaItem —— DELETE /agenda-items/{aid}
func (h *AgentRoomHandler) DeleteAgendaItem(w http.ResponseWriter, r *http.Request) {
	aid := pathID(r, "/api/v1/agentroom/agenda-items/")
	existing, err := h.repo.GetAgendaItem(aid)
	if err != nil || existing == nil {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	if _, ok := h.authorizeRoom(w, r, existing.RoomID); !ok {
		return
	}
	if err := h.repo.DeleteAgendaItem(aid); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	h.broker().Emit(existing.RoomID, "room.agenda.delete", map[string]any{
		"roomId": existing.RoomID, "itemId": aid,
	})
	h.audit(r, existing.RoomID, "agenda.delete", aid, existing.Title)
	web.OK(w, r, map[string]any{"status": "ok"})
}

// AdvanceAgenda —— POST /rooms/{id}/agenda/advance
func (h *AgentRoomHandler) AdvanceAgenda(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/v1/agentroom/rooms/"), "/")
	if len(parts) < 3 || parts[1] != "agenda" || parts[2] != "advance" {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	id := parts[0]
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	nextID, err := h.manager.Get(id).AdvanceAgenda(r.Context())
	if err != nil {
		web.Fail(w, r, "AGENDA_ADVANCE_FAILED", err.Error(), http.StatusInternalServerError)
		return
	}
	h.audit(r, id, "agenda.advance", nextID, "")
	web.OK(w, r, map[string]any{"nextItemId": nextID})
}

// ReorderAgenda —— POST /rooms/{id}/agenda/reorder
func (h *AgentRoomHandler) ReorderAgenda(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/v1/agentroom/rooms/"), "/")
	if len(parts) < 3 || parts[1] != "agenda" || parts[2] != "reorder" {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	id := parts[0]
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	var req struct {
		OrderedIDs []string `json:"orderedIds"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	if err := h.repo.ReorderAgendaItems(id, req.OrderedIDs); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	h.broker().Emit(id, "room.agenda.reorder", map[string]any{
		"roomId": id, "orderedIds": req.OrderedIDs,
	})
	h.audit(r, id, "agenda.reorder", "", strconv.Itoa(len(req.OrderedIDs)))
	web.OK(w, r, map[string]any{"status": "ok"})
}

// ParkAgendaItem —— POST /agenda-items/{aid}/park
func (h *AgentRoomHandler) ParkAgendaItem(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/v1/agentroom/agenda-items/"), "/")
	if len(parts) < 2 || parts[1] != "park" {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	aid := parts[0]
	existing, err := h.repo.GetAgendaItem(aid)
	if err != nil || existing == nil {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	if _, ok := h.authorizeRoom(w, r, existing.RoomID); !ok {
		return
	}
	if err := h.manager.Get(existing.RoomID).ParkAgenda(r.Context(), aid); err != nil {
		web.Fail(w, r, "AGENDA_PARK_FAILED", err.Error(), http.StatusInternalServerError)
		return
	}
	h.audit(r, existing.RoomID, "agenda.park", aid, "")
	web.OK(w, r, map[string]any{"status": "ok"})
}

// ═══════════════ OpenQuestion ═══════════════

type openQuestionRequest struct {
	Text         string `json:"text"`
	AgendaItemID string `json:"agendaItemId,omitempty"`
	RaisedByID   string `json:"raisedById,omitempty"`
}

// ListQuestions —— GET /rooms/{id}/questions
func (h *AgentRoomHandler) ListQuestions(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/questions")
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	qs, err := h.repo.ListOpenQuestions(id)
	if err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	out := make([]agentroom.OpenQuestion, 0, len(qs))
	for i := range qs {
		out = append(out, agentroom.OpenQuestionFromModel(&qs[i]))
	}
	web.OK(w, r, out)
}

// CreateQuestion —— POST /rooms/{id}/questions
func (h *AgentRoomHandler) CreateQuestion(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/questions")
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	var req openQuestionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	text := strings.TrimSpace(req.Text)
	if text == "" {
		web.Fail(w, r, "INVALID_PARAM", "text required", http.StatusBadRequest)
		return
	}
	q := &database.AgentRoomOpenQuestion{
		RoomID: id, AgendaItemID: req.AgendaItemID, Text: text, RaisedByID: req.RaisedByID,
	}
	if err := h.repo.CreateOpenQuestion(q); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	h.broker().Emit(id, "room.question.append", map[string]any{
		"roomId": id, "question": agentroom.OpenQuestionFromModel(q),
	})
	h.audit(r, id, "question.create", q.ID, text)
	web.OK(w, r, agentroom.OpenQuestionFromModel(q))
}

type openQuestionUpdateRequest struct {
	Text            *string `json:"text,omitempty"`
	Status          *string `json:"status,omitempty"`
	AnswerMessageID *string `json:"answerMessageId,omitempty"`
	AnswerText      *string `json:"answerText,omitempty"`
}

// UpdateQuestion —— PUT /questions/{qid}
func (h *AgentRoomHandler) UpdateQuestion(w http.ResponseWriter, r *http.Request) {
	qid := pathID(r, "/api/v1/agentroom/questions/")
	q, err := h.getQuestionOr404(w, r, qid)
	if q == nil {
		return
	}
	_ = err
	if _, ok := h.authorizeRoom(w, r, q.RoomID); !ok {
		return
	}
	var req openQuestionUpdateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	patch := map[string]any{}
	if req.Text != nil {
		patch["text"] = *req.Text
	}
	if req.Status != nil {
		patch["status"] = *req.Status
	}
	if req.AnswerMessageID != nil {
		patch["answer_message_id"] = *req.AnswerMessageID
	}
	if req.AnswerText != nil {
		patch["answer_text"] = *req.AnswerText
	}
	if err := h.repo.UpdateOpenQuestion(qid, patch); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	q2, _ := h.getQuestionOr404(nil, r, qid)
	if q2 != nil {
		h.broker().Emit(q.RoomID, "room.question.update", map[string]any{
			"roomId": q.RoomID, "questionId": qid, "patch": agentroom.OpenQuestionFromModel(q2),
		})
		web.OK(w, r, agentroom.OpenQuestionFromModel(q2))
		return
	}
	web.OK(w, r, map[string]any{"status": "ok"})
}

// DeleteQuestion —— DELETE /questions/{qid}
func (h *AgentRoomHandler) DeleteQuestion(w http.ResponseWriter, r *http.Request) {
	qid := pathID(r, "/api/v1/agentroom/questions/")
	q, _ := h.getQuestionOr404(w, r, qid)
	if q == nil {
		return
	}
	if _, ok := h.authorizeRoom(w, r, q.RoomID); !ok {
		return
	}
	if err := h.repo.DeleteOpenQuestion(qid); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	h.broker().Emit(q.RoomID, "room.question.delete", map[string]any{
		"roomId": q.RoomID, "questionId": qid,
	})
	web.OK(w, r, map[string]any{"status": "ok"})
}

// helper：获取 question；如果 w 不为 nil，则在 nil 时返回 404。
func (h *AgentRoomHandler) getQuestionOr404(w http.ResponseWriter, r *http.Request, qid string) (*database.AgentRoomOpenQuestion, error) {
	if qid == "" {
		if w != nil {
			web.FailErr(w, r, web.ErrInvalidParam)
		}
		return nil, nil
	}
	// 借用通用 First
	var q database.AgentRoomOpenQuestion
	if err := database.DB.First(&q, "id = ?", qid).Error; err != nil {
		if w != nil {
			web.FailErr(w, r, web.ErrNotFound)
		}
		return nil, err
	}
	return &q, nil
}

// ═══════════════ ParkingLot ═══════════════

type parkingItemRequest struct {
	Text       string `json:"text"`
	RaisedByID string `json:"raisedById,omitempty"`
	Resolution string `json:"resolution,omitempty"`
}

// ListParking —— GET /rooms/{id}/parking
func (h *AgentRoomHandler) ListParking(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/parking")
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	ps, err := h.repo.ListParkingLot(id)
	if err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	out := make([]agentroom.ParkingLotItem, 0, len(ps))
	for i := range ps {
		out = append(out, agentroom.ParkingLotItemFromModel(&ps[i]))
	}
	web.OK(w, r, out)
}

// CreateParking —— POST /rooms/{id}/parking
func (h *AgentRoomHandler) CreateParking(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/parking")
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	var req parkingItemRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	text := strings.TrimSpace(req.Text)
	if text == "" {
		web.Fail(w, r, "INVALID_PARAM", "text required", http.StatusBadRequest)
		return
	}
	p := &database.AgentRoomParkingLot{
		RoomID: id, Text: text, RaisedByID: req.RaisedByID, Resolution: req.Resolution,
	}
	if err := h.repo.CreateParkingLotItem(p); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	h.broker().Emit(id, "room.parking.append", map[string]any{
		"roomId": id, "item": agentroom.ParkingLotItemFromModel(p),
	})
	h.audit(r, id, "parking.create", p.ID, text)
	web.OK(w, r, agentroom.ParkingLotItemFromModel(p))
}

// UpdateParking —— PUT /parking/{pid}
func (h *AgentRoomHandler) UpdateParking(w http.ResponseWriter, r *http.Request) {
	pid := pathID(r, "/api/v1/agentroom/parking/")
	var p database.AgentRoomParkingLot
	if err := database.DB.First(&p, "id = ?", pid).Error; err != nil {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	if _, ok := h.authorizeRoom(w, r, p.RoomID); !ok {
		return
	}
	var req parkingItemRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	patch := map[string]any{}
	if req.Text != "" {
		patch["text"] = req.Text
	}
	if req.Resolution != "" {
		patch["resolution"] = req.Resolution
	}
	if err := h.repo.UpdateParkingLotItem(pid, patch); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	_ = database.DB.First(&p, "id = ?", pid)
	h.broker().Emit(p.RoomID, "room.parking.update", map[string]any{
		"roomId": p.RoomID, "itemId": pid, "patch": agentroom.ParkingLotItemFromModel(&p),
	})
	web.OK(w, r, agentroom.ParkingLotItemFromModel(&p))
}

// DeleteParking —— DELETE /parking/{pid}
func (h *AgentRoomHandler) DeleteParking(w http.ResponseWriter, r *http.Request) {
	pid := pathID(r, "/api/v1/agentroom/parking/")
	var p database.AgentRoomParkingLot
	if err := database.DB.First(&p, "id = ?", pid).Error; err != nil {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	if _, ok := h.authorizeRoom(w, r, p.RoomID); !ok {
		return
	}
	if err := h.repo.DeleteParkingLotItem(pid); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	h.broker().Emit(p.RoomID, "room.parking.delete", map[string]any{
		"roomId": p.RoomID, "itemId": pid,
	})
	web.OK(w, r, map[string]any{"status": "ok"})
}

// ═══════════════ Risk ═══════════════

type riskRequest struct {
	Text     string `json:"text"`
	Severity string `json:"severity,omitempty"`
	OwnerID  string `json:"ownerId,omitempty"`
	Status   string `json:"status,omitempty"`
}

// ListRisks —— GET /rooms/{id}/risks
func (h *AgentRoomHandler) ListRisks(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/risks")
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	rs, err := h.repo.ListRisks(id)
	if err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	out := make([]agentroom.Risk, 0, len(rs))
	for i := range rs {
		out = append(out, agentroom.RiskFromModel(&rs[i]))
	}
	web.OK(w, r, out)
}

// CreateRisk —— POST /rooms/{id}/risks
func (h *AgentRoomHandler) CreateRisk(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/risks")
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	var req riskRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	text := strings.TrimSpace(req.Text)
	if text == "" {
		web.Fail(w, r, "INVALID_PARAM", "text required", http.StatusBadRequest)
		return
	}
	k := &database.AgentRoomRisk{
		RoomID: id, Text: text, Severity: req.Severity, OwnerID: req.OwnerID,
	}
	if err := h.repo.CreateRisk(k); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	h.broker().Emit(id, "room.risk.append", map[string]any{
		"roomId": id, "risk": agentroom.RiskFromModel(k),
	})
	h.audit(r, id, "risk.create", k.ID, text)
	web.OK(w, r, agentroom.RiskFromModel(k))
}

// UpdateRisk —— PUT /risks/{rkid}
func (h *AgentRoomHandler) UpdateRisk(w http.ResponseWriter, r *http.Request) {
	rkid := pathID(r, "/api/v1/agentroom/risks/")
	var k database.AgentRoomRisk
	if err := database.DB.First(&k, "id = ?", rkid).Error; err != nil {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	if _, ok := h.authorizeRoom(w, r, k.RoomID); !ok {
		return
	}
	var req riskRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	patch := map[string]any{}
	if req.Text != "" {
		patch["text"] = req.Text
	}
	if req.Severity != "" {
		patch["severity"] = req.Severity
	}
	if req.OwnerID != "" {
		patch["owner_id"] = req.OwnerID
	}
	if req.Status != "" {
		patch["status"] = req.Status
	}
	if err := h.repo.UpdateRisk(rkid, patch); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	_ = database.DB.First(&k, "id = ?", rkid)
	h.broker().Emit(k.RoomID, "room.risk.update", map[string]any{
		"roomId": k.RoomID, "riskId": rkid, "patch": agentroom.RiskFromModel(&k),
	})
	web.OK(w, r, agentroom.RiskFromModel(&k))
}

// DeleteRisk —— DELETE /risks/{rkid}
func (h *AgentRoomHandler) DeleteRisk(w http.ResponseWriter, r *http.Request) {
	rkid := pathID(r, "/api/v1/agentroom/risks/")
	var k database.AgentRoomRisk
	if err := database.DB.First(&k, "id = ?", rkid).Error; err != nil {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	if _, ok := h.authorizeRoom(w, r, k.RoomID); !ok {
		return
	}
	if err := h.repo.DeleteRisk(rkid); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	h.broker().Emit(k.RoomID, "room.risk.delete", map[string]any{
		"roomId": k.RoomID, "riskId": rkid,
	})
	web.OK(w, r, map[string]any{"status": "ok"})
}

// ═══════════════ Vote ═══════════════

type voteCreateRequest struct {
	Question     string   `json:"question"`
	Options      []string `json:"options"`
	Mode         string   `json:"mode,omitempty"`
	VoterIDs     []string `json:"voterIds,omitempty"`
	AgendaItemID string   `json:"agendaItemId,omitempty"`
}

// ListVotes —— GET /rooms/{id}/votes
func (h *AgentRoomHandler) ListVotes(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/votes")
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	vs, err := h.repo.ListVotes(id)
	if err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	out := make([]agentroom.Vote, 0, len(vs))
	for i := range vs {
		bs, _ := h.repo.ListBallots(vs[i].ID)
		out = append(out, agentroom.VoteFromModel(&vs[i], bs))
	}
	web.OK(w, r, out)
}

// CreateVote —— POST /rooms/{id}/votes
func (h *AgentRoomHandler) CreateVote(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/votes")
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	var req voteCreateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	q := strings.TrimSpace(req.Question)
	if q == "" || len(req.Options) < 2 {
		web.Fail(w, r, "INVALID_PARAM", "question + ≥2 options required", http.StatusBadRequest)
		return
	}
	opts, _ := json.Marshal(req.Options)
	voters := ""
	if len(req.VoterIDs) > 0 {
		b, _ := json.Marshal(req.VoterIDs)
		voters = string(b)
	}
	uid := web.GetUserID(r)
	v := &database.AgentRoomVote{
		RoomID: id, AgendaItemID: req.AgendaItemID, Question: q,
		OptionsJSON: string(opts), Mode: req.Mode, VoterIDsJSON: voters,
		InitiatorID: "human-" + strconv.FormatUint(uint64(uid), 10),
	}
	if err := h.repo.CreateVote(v); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	dto := agentroom.VoteFromModel(v, nil)
	h.broker().Emit(id, "room.vote.append", map[string]any{
		"roomId": id, "vote": dto,
	})
	h.audit(r, id, "vote.create", v.ID, q)
	web.OK(w, r, dto)
}

// GetVote —— GET /votes/{vid}
func (h *AgentRoomHandler) GetVote(w http.ResponseWriter, r *http.Request) {
	vid := pathID(r, "/api/v1/agentroom/votes/")
	v, err := h.repo.GetVote(vid)
	if err != nil || v == nil {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	if _, ok := h.authorizeRoom(w, r, v.RoomID); !ok {
		return
	}
	bs, _ := h.repo.ListBallots(vid)
	web.OK(w, r, agentroom.VoteFromModel(v, bs))
}

// DeleteVote —— DELETE /votes/{vid}
func (h *AgentRoomHandler) DeleteVote(w http.ResponseWriter, r *http.Request) {
	vid := pathID(r, "/api/v1/agentroom/votes/")
	v, err := h.repo.GetVote(vid)
	if err != nil || v == nil {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	if _, ok := h.authorizeRoom(w, r, v.RoomID); !ok {
		return
	}
	if err := h.repo.DeleteVote(vid); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	h.broker().Emit(v.RoomID, "room.vote.delete", map[string]any{
		"roomId": v.RoomID, "voteId": vid,
	})
	web.OK(w, r, map[string]any{"status": "ok"})
}

type ballotRequest struct {
	VoterID   string `json:"voterId,omitempty"`
	Choice    string `json:"choice"`
	Rationale string `json:"rationale,omitempty"`
}

// UpsertBallot —— POST /votes/{vid}/ballot
func (h *AgentRoomHandler) UpsertBallot(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/v1/agentroom/votes/"), "/")
	if len(parts) < 2 || parts[1] != "ballot" {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	vid := parts[0]
	v, err := h.repo.GetVote(vid)
	if err != nil || v == nil {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	if _, ok := h.authorizeRoom(w, r, v.RoomID); !ok {
		return
	}
	var req ballotRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	if strings.TrimSpace(req.Choice) == "" {
		web.Fail(w, r, "INVALID_PARAM", "choice required", http.StatusBadRequest)
		return
	}
	voterID := req.VoterID
	if voterID == "" {
		voterID = "human-" + strconv.FormatUint(uint64(web.GetUserID(r)), 10)
	}
	b := &database.AgentRoomVoteBallot{
		VoteID: vid, VoterID: voterID, Choice: req.Choice, Rationale: req.Rationale,
		CreatedAt: time.Now(),
	}
	if err := h.repo.UpsertBallot(b); err != nil {
		web.Fail(w, r, "BALLOT_FAILED", err.Error(), http.StatusBadRequest)
		return
	}
	bs, _ := h.repo.ListBallots(vid)
	h.broker().Emit(v.RoomID, "room.vote.update", map[string]any{
		"roomId": v.RoomID, "voteId": vid, "ballots": bs,
	})
	web.OK(w, r, map[string]any{"status": "ok", "ballots": len(bs)})
}

// TallyVote —— POST /votes/{vid}/tally
func (h *AgentRoomHandler) TallyVote(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/v1/agentroom/votes/"), "/")
	if len(parts) < 2 || parts[1] != "tally" {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	vid := parts[0]
	v, err := h.repo.GetVote(vid)
	if err != nil || v == nil {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	if _, ok := h.authorizeRoom(w, r, v.RoomID); !ok {
		return
	}
	result, err := h.repo.TallyVote(vid)
	if err != nil {
		web.Fail(w, r, "TALLY_FAILED", err.Error(), http.StatusInternalServerError)
		return
	}
	v2, _ := h.repo.GetVote(vid)
	bs, _ := h.repo.ListBallots(vid)
	dto := agentroom.VoteFromModel(v2, bs)
	h.broker().Emit(v.RoomID, "room.vote.update", map[string]any{
		"roomId": v.RoomID, "voteId": vid, "vote": dto,
	})
	h.audit(r, v.RoomID, "vote.tally", vid, result)
	web.OK(w, r, dto)
}

// ═══════════════ Playbook v0.7 ═══════════════

// GetPlaybookV7 —— GET /playbooks/{id}
func (h *AgentRoomHandler) GetPlaybookV7(w http.ResponseWriter, r *http.Request) {
	id := pathID(r, "/api/v1/agentroom/playbooks/")
	p, err := h.repo.GetPlaybook(id)
	if err != nil || p == nil {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	if p.OwnerUserID != 0 && p.OwnerUserID != web.GetUserID(r) {
		web.Fail(w, r, "FORBIDDEN", "access denied", http.StatusForbidden)
		return
	}
	web.OK(w, r, agentroom.PlaybookV7FromModel(p))
}

type playbookUpdateRequest struct {
	Title      *string                  `json:"title,omitempty"`
	Problem    *string                  `json:"problem,omitempty"`
	Approach   *string                  `json:"approach,omitempty"`
	Conclusion *string                  `json:"conclusion,omitempty"`
	Category   *string                  `json:"category,omitempty"`
	Tags       []string                 `json:"tags,omitempty"`
	AppliesTo  []string                 `json:"appliesTo,omitempty"`
	Steps      []agentroom.PlaybookStep `json:"steps,omitempty"`
	IsFavorite *bool                    `json:"isFavorite,omitempty"`
}

// UpdatePlaybookV7 —— PUT /playbooks/{id}
func (h *AgentRoomHandler) UpdatePlaybookV7(w http.ResponseWriter, r *http.Request) {
	id := pathID(r, "/api/v1/agentroom/playbooks/")
	p, err := h.repo.GetPlaybook(id)
	if err != nil || p == nil {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	if p.OwnerUserID != 0 && p.OwnerUserID != web.GetUserID(r) {
		web.Fail(w, r, "FORBIDDEN", "access denied", http.StatusForbidden)
		return
	}
	var req playbookUpdateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	patch := map[string]any{}
	if req.Title != nil {
		patch["title"] = *req.Title
	}
	if req.Problem != nil {
		patch["problem"] = *req.Problem
	}
	if req.Approach != nil {
		patch["approach"] = *req.Approach
	}
	if req.Conclusion != nil {
		patch["conclusion"] = *req.Conclusion
	}
	if req.Category != nil {
		patch["category"] = *req.Category
	}
	if req.Tags != nil {
		patch["tags_json"] = agentroom.MarshalPlaybookTags(req.Tags)
	}
	if req.AppliesTo != nil {
		if len(req.AppliesTo) == 0 {
			patch["applies_to_json"] = ""
		} else {
			b, _ := json.Marshal(req.AppliesTo)
			patch["applies_to_json"] = string(b)
		}
	}
	if req.Steps != nil {
		if len(req.Steps) == 0 {
			patch["steps_json"] = ""
		} else {
			b, _ := json.Marshal(req.Steps)
			patch["steps_json"] = string(b)
		}
	}
	if req.IsFavorite != nil {
		patch["is_favorite"] = *req.IsFavorite
	}
	if err := h.repo.UpdatePlaybookV7(id, patch); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	got, _ := h.repo.GetPlaybook(id)
	h.audit(r, "", "playbook.update", id, got.Title)
	web.OK(w, r, agentroom.PlaybookV7FromModel(got))
}

// SearchPlaybooks —— GET /playbooks/search?q=...&limit=50
func (h *AgentRoomHandler) SearchPlaybooks(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	uid := web.GetUserID(r)
	ps, err := h.repo.SearchPlaybooks(uid, q, limit)
	if err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	out := make([]agentroom.PlaybookV7, 0, len(ps))
	for i := range ps {
		out = append(out, agentroom.PlaybookV7FromModel(&ps[i]))
	}
	web.OK(w, r, out)
}

// RecommendPlaybooks —— GET /playbooks/recommend?goal=...&templateId=...
// 根据 goal 关键词 + templateId 匹配，usage_count 降序排列，给新房间 wizard 用。
func (h *AgentRoomHandler) RecommendPlaybooks(w http.ResponseWriter, r *http.Request) {
	goal := r.URL.Query().Get("goal")
	tpl := r.URL.Query().Get("templateId")
	uid := web.GetUserID(r)

	// 综合打分：同 template id 最优先；含关键词其次；favorite 提权。
	ps, err := h.repo.ListPlaybooks(uid)
	if err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	type scored struct {
		item  agentroom.PlaybookV7
		score float64
	}
	goalLC := strings.ToLower(strings.TrimSpace(goal))
	scoredList := make([]scored, 0, len(ps))
	for i := range ps {
		v7 := agentroom.PlaybookV7FromModel(&ps[i])
		score := 0.0
		for _, a := range v7.AppliesTo {
			if tpl != "" && a == tpl {
				score += 20
			}
			if goalLC != "" && strings.Contains(goalLC, strings.ToLower(a)) {
				score += 6
			}
		}
		for _, t := range v7.Tags {
			if goalLC != "" && strings.Contains(goalLC, strings.ToLower(t)) {
				score += 3
			}
		}
		// usage 贡献（log 级避免被长尾霸榜）
		score += float64(v7.UsageCount) * 0.5
		if v7.IsFavorite {
			score += 5
		}
		// title/problem 关键词
		if goalLC != "" {
			hay := strings.ToLower(v7.Title + " " + v7.Problem)
			for _, word := range strings.Fields(goalLC) {
				if len(word) >= 2 && strings.Contains(hay, word) {
					score += 1
				}
			}
		}
		if score > 0 {
			scoredList = append(scoredList, scored{v7, score})
		}
	}
	// 排序
	for i := 0; i < len(scoredList); i++ {
		for j := i + 1; j < len(scoredList); j++ {
			if scoredList[j].score > scoredList[i].score {
				scoredList[i], scoredList[j] = scoredList[j], scoredList[i]
			}
		}
	}
	// 取前 8
	limit := 8
	if len(scoredList) < limit {
		limit = len(scoredList)
	}
	out := make([]agentroom.PlaybookV7, 0, limit)
	for i := 0; i < limit; i++ {
		out = append(out, scoredList[i].item)
	}
	web.OK(w, r, out)
}

// TogglePlaybookFavorite —— POST /playbooks/{id}/favorite
func (h *AgentRoomHandler) TogglePlaybookFavorite(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/v1/agentroom/playbooks/"), "/")
	if len(parts) < 2 || parts[1] != "favorite" {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	id := parts[0]
	p, err := h.repo.GetPlaybook(id)
	if err != nil || p == nil {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	if p.OwnerUserID != 0 && p.OwnerUserID != web.GetUserID(r) {
		web.Fail(w, r, "FORBIDDEN", "access denied", http.StatusForbidden)
		return
	}
	_ = h.repo.UpdatePlaybookV7(id, map[string]any{"is_favorite": !p.IsFavorite})
	got, _ := h.repo.GetPlaybook(id)
	web.OK(w, r, agentroom.PlaybookV7FromModel(got))
}

// ListPlaybooksV7 —— GET /playbooks  —— 返回 PlaybookV7 结构（替代旧 ListPlaybooks 返回的 v0.6 Playbook）
// 前端新版经验库走这个接口；旧接口保留兼容。
func (h *AgentRoomHandler) ListPlaybooksV7(w http.ResponseWriter, r *http.Request) {
	uid := web.GetUserID(r)
	ps, err := h.repo.ListPlaybooks(uid)
	if err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	out := make([]agentroom.PlaybookV7, 0, len(ps))
	for i := range ps {
		out = append(out, agentroom.PlaybookV7FromModel(&ps[i]))
	}
	web.OK(w, r, out)
}
