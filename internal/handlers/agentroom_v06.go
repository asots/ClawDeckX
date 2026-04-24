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

// v0.6 handlers —— 决策锚 / Artifact / 会议纪要 / 重跑 / 群询 / extract-todo / 长期记忆 / playbook。
// 走 HTTP 接口 + 组合 Repo + Orchestrator 能力；所有变更均写 audit。

// ─────────────────────────────── 决策锚 ───────────────────────────────

type promoteDecisionRequest struct {
	Summary string `json:"summary,omitempty"`
}

// PromoteDecision —— POST /api/v1/agentroom/messages/{mid}/promote-decision
func (h *AgentRoomHandler) PromoteDecision(w http.ResponseWriter, r *http.Request) {
	mid := pathIDBetween(r, "/api/v1/agentroom/messages/", "/promote-decision")
	_, roomID, ok := h.authorizeByMessage(w, r, mid)
	if !ok {
		return
	}
	var req promoteDecisionRequest
	_ = json.NewDecoder(r.Body).Decode(&req)
	if err := h.repo.PromoteMessageToDecision(mid, strings.TrimSpace(req.Summary)); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	h.broker().Emit(roomID, agentroom.EventMessageUpdate, map[string]any{
		"roomId":    roomID,
		"messageId": mid,
		"patch": map[string]any{
			"isDecision":      true,
			"decisionSummary": req.Summary,
			"kind":            agentroom.MsgKindDecision,
		},
	})
	h.audit(r, roomID, "decision.promote", mid, req.Summary)
	web.OK(w, r, map[string]any{"status": "ok"})
}

// DemoteDecision —— DELETE /api/v1/agentroom/messages/{mid}/promote-decision
func (h *AgentRoomHandler) DemoteDecision(w http.ResponseWriter, r *http.Request) {
	mid := pathIDBetween(r, "/api/v1/agentroom/messages/", "/promote-decision")
	_, roomID, ok := h.authorizeByMessage(w, r, mid)
	if !ok {
		return
	}
	if err := h.repo.DemoteDecision(mid); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	h.broker().Emit(roomID, agentroom.EventMessageUpdate, map[string]any{
		"roomId":    roomID,
		"messageId": mid,
		"patch": map[string]any{
			"isDecision":      false,
			"decisionSummary": "",
			"kind":            agentroom.MsgKindChat,
		},
	})
	h.audit(r, roomID, "decision.demote", mid, "")
	web.OK(w, r, map[string]any{"status": "ok"})
}

// ListDecisions —— GET /api/v1/agentroom/rooms/{id}/decisions
func (h *AgentRoomHandler) ListDecisions(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/decisions")
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	msgs, err := h.repo.ListDecisions(id)
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

// ─────────────────────────────── Artifact ───────────────────────────────

type artifactRequest struct {
	Title    string `json:"title"`
	Kind     string `json:"kind"`
	Language string `json:"language,omitempty"`
	Content  string `json:"content"`
}

// CreateArtifact —— POST /api/v1/agentroom/rooms/{id}/artifacts
func (h *AgentRoomHandler) CreateArtifact(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/artifacts")
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	var req artifactRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	title := strings.TrimSpace(req.Title)
	if title == "" {
		web.Fail(w, r, "INVALID_PARAM", "title required", http.StatusBadRequest)
		return
	}
	kind := req.Kind
	if kind == "" {
		kind = "markdown"
	}
	a := &database.AgentRoomArtifact{
		RoomID:   id,
		Title:    title,
		Kind:     kind,
		Language: req.Language,
		Content:  req.Content,
		Version:  1,
		AuthorID: "human-" + strconv.FormatUint(uint64(web.GetUserID(r)), 10),
	}
	if err := h.repo.CreateArtifact(a); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	h.audit(r, id, "artifact.create", a.ID, title)
	web.OK(w, r, agentroom.ArtifactFromModel(a))
}

// ListArtifacts —— GET /api/v1/agentroom/rooms/{id}/artifacts
func (h *AgentRoomHandler) ListArtifacts(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/artifacts")
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	as, err := h.repo.ListArtifacts(id)
	if err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	out := make([]agentroom.Artifact, 0, len(as))
	for i := range as {
		out = append(out, agentroom.ArtifactFromModel(&as[i]))
	}
	web.OK(w, r, out)
}

// UpdateArtifact —— PUT /api/v1/agentroom/artifacts/{aid}（版本自增）
func (h *AgentRoomHandler) UpdateArtifact(w http.ResponseWriter, r *http.Request) {
	aid := pathID(r, "/api/v1/agentroom/artifacts/")
	existing, err := h.repo.GetArtifact(aid)
	if err != nil || existing == nil {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	if _, ok := h.authorizeRoom(w, r, existing.RoomID); !ok {
		return
	}
	var req artifactRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	patch := map[string]any{
		"version":    existing.Version + 1,
		"updated_at": time.Now(),
	}
	if req.Title != "" {
		patch["title"] = req.Title
	}
	if req.Kind != "" {
		patch["kind"] = req.Kind
	}
	if req.Language != "" {
		patch["language"] = req.Language
	}
	// Content 允许空串（显式清空）
	patch["content"] = req.Content
	if err := h.repo.UpdateArtifact(aid, patch); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	h.audit(r, existing.RoomID, "artifact.update", aid, "")
	got, _ := h.repo.GetArtifact(aid)
	web.OK(w, r, agentroom.ArtifactFromModel(got))
}

// DeleteArtifact —— DELETE /api/v1/agentroom/artifacts/{aid}
func (h *AgentRoomHandler) DeleteArtifact(w http.ResponseWriter, r *http.Request) {
	aid := pathID(r, "/api/v1/agentroom/artifacts/")
	existing, err := h.repo.GetArtifact(aid)
	if err != nil || existing == nil {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	if _, ok := h.authorizeRoom(w, r, existing.RoomID); !ok {
		return
	}
	if err := h.repo.DeleteArtifact(aid); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	h.audit(r, existing.RoomID, "artifact.delete", aid, existing.Title)
	web.OK(w, r, map[string]any{"status": "ok"})
}

// ─────────────────────────────── 会议纪要 closing agent ───────────────────────────────

type synthesizeRequest struct {
	Template string `json:"template,omitempty"` // minutes|prd|adr|review，默认 minutes
	Close    bool   `json:"close,omitempty"`    // 生成后是否把房间标为 closed
}

// SynthesizeMinutes —— POST /rooms/{id}/close/synthesize
// 触发 orchestrator 跑一次 closing agent，产出 kind=minutes 的消息 + 同内容 artifact。
func (h *AgentRoomHandler) SynthesizeMinutes(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/close/synthesize")
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	var req synthesizeRequest
	_ = json.NewDecoder(r.Body).Decode(&req)
	tpl := req.Template
	if tpl == "" {
		tpl = "minutes"
	}
	artifactID, msgID, err := h.manager.Get(id).SynthesizeMinutes(r.Context(), tpl)
	if err != nil {
		web.Fail(w, r, "SYNTHESIZE_FAILED", err.Error(), http.StatusInternalServerError)
		return
	}
	if req.Close {
		_ = h.repo.UpdateRoom(id, map[string]any{"state": agentroom.StateClosed})
	}
	h.audit(r, id, "room.synthesize", artifactID, tpl)
	web.OK(w, r, map[string]any{
		"status":     "ok",
		"artifactId": artifactID,
		"messageId":  msgID,
	})
}

// ─────────────────────────────── extract-todo ───────────────────────────────

// ExtractTodo —— POST /rooms/{id}/extract-todo
// 让 orchestrator 分析最近 N 条消息，抽取动作项，批量创建 task。
func (h *AgentRoomHandler) ExtractTodo(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/extract-todo")
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	tasks, err := h.manager.Get(id).ExtractTodos(r.Context())
	if err != nil {
		web.Fail(w, r, "EXTRACT_FAILED", err.Error(), http.StatusInternalServerError)
		return
	}
	h.audit(r, id, "room.extract_todo", "", strconv.Itoa(len(tasks)))
	web.OK(w, r, map[string]any{"status": "ok", "tasks": tasks})
}

// ExtractQuestions —— POST /rooms/{id}/extract-questions
// v0.9：让 orchestrator 从最近消息里挑出"没人回答的开放问题"，批量写入 OpenQuestion，
// 并通过 broker 广播 room.question.append —— 前端 QuestionsPanel 会实时刷新、
// 折叠状态下未读绿点会亮起。
func (h *AgentRoomHandler) ExtractQuestions(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/extract-questions")
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	qs, err := h.manager.Get(id).ExtractOpenQuestions(r.Context())
	if err != nil {
		web.Fail(w, r, "EXTRACT_FAILED", err.Error(), http.StatusInternalServerError)
		return
	}
	h.audit(r, id, "room.extract_questions", "", strconv.Itoa(len(qs)))
	web.OK(w, r, map[string]any{"status": "ok", "questions": qs})
}

// ExtractRisks —— POST /rooms/{id}/extract-risks
// 同上，但抽取目标为"可能导致目标失败的风险"。
func (h *AgentRoomHandler) ExtractRisks(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/extract-risks")
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	risks, err := h.manager.Get(id).ExtractRisks(r.Context())
	if err != nil {
		web.Fail(w, r, "EXTRACT_FAILED", err.Error(), http.StatusInternalServerError)
		return
	}
	h.audit(r, id, "room.extract_risks", "", strconv.Itoa(len(risks)))
	web.OK(w, r, map[string]any{"status": "ok", "risks": risks})
}

// ─────────────────────────────── Rerun message ───────────────────────────────

type rerunRequest struct {
	Model string `json:"model,omitempty"` // 可选；空=用原 agent 模型
}

// RerunMessage —— POST /api/v1/agentroom/messages/{mid}/rerun
// 以消息作者（agent）身份重新生成一条新消息；原消息保留。可选换模型。
func (h *AgentRoomHandler) RerunMessage(w http.ResponseWriter, r *http.Request) {
	mid := pathIDBetween(r, "/api/v1/agentroom/messages/", "/rerun")
	_, roomID, ok := h.authorizeByMessage(w, r, mid)
	if !ok {
		return
	}
	var req rerunRequest
	_ = json.NewDecoder(r.Body).Decode(&req)
	newMsgID, err := h.manager.Get(roomID).RerunMessage(r.Context(), mid, req.Model)
	if err != nil {
		web.Fail(w, r, "RERUN_FAILED", err.Error(), http.StatusInternalServerError)
		return
	}
	h.audit(r, roomID, "message.rerun", mid, req.Model)
	web.OK(w, r, map[string]any{"status": "ok", "newMessageId": newMsgID})
}

// ─────────────────────────────── Ask all ───────────────────────────────

type askAllRequest struct {
	Question string `json:"question"`
}

// AskAll —— POST /rooms/{id}/ask-all
// 以人类身份发送一条消息，mentions 填所有存活 agent，promote 所有响应并排。
// 简化实现：创建一条人类消息，内容前缀 "【群询】"，mentions = 所有 agent。
func (h *AgentRoomHandler) AskAll(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/ask-all")
	if _, ok := h.authorizeRoom(w, r, id); !ok {
		return
	}
	var req askAllRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	q := strings.TrimSpace(req.Question)
	if q == "" {
		web.Fail(w, r, "INVALID_PARAM", "question required", http.StatusBadRequest)
		return
	}
	if err := h.manager.Get(id).AskAll(r.Context(), q); err != nil {
		web.Fail(w, r, "ASK_ALL_FAILED", err.Error(), http.StatusInternalServerError)
		return
	}
	h.audit(r, id, "room.ask_all", "", "")
	web.OK(w, r, map[string]any{"status": "ok"})
}

// ─────────────────────────────── Persona Memory ───────────────────────────────

type personaMemoryRequest struct {
	Content string `json:"content"`
	Append  bool   `json:"append,omitempty"` // true = 追加；默认 false = 覆盖
}

// GetPersonaMemory —— GET /api/v1/agentroom/persona-memory/{key}
func (h *AgentRoomHandler) GetPersonaMemory(w http.ResponseWriter, r *http.Request) {
	key := pathID(r, "/api/v1/agentroom/persona-memory/")
	if key == "" {
		web.FailErr(w, r, web.ErrInvalidParam)
		return
	}
	// 允许跨 user 读写时做所有权校验：只允许自己前缀 user:{uid}: 的 key，或系统 team:* 由 admin 管理。
	uid := web.GetUserID(r)
	if !isPersonaKeyOwned(key, uid) {
		web.Fail(w, r, "FORBIDDEN", "access denied", http.StatusForbidden)
		return
	}
	pm, err := h.repo.GetPersonaMemory(key)
	if err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	if pm == nil {
		web.OK(w, r, agentroom.PersonaMemory{MemoryKey: key})
		return
	}
	web.OK(w, r, agentroom.PersonaMemoryFromModel(pm))
}

// UpsertPersonaMemory —— PUT /api/v1/agentroom/persona-memory/{key}
func (h *AgentRoomHandler) UpsertPersonaMemory(w http.ResponseWriter, r *http.Request) {
	key := pathID(r, "/api/v1/agentroom/persona-memory/")
	if key == "" {
		web.FailErr(w, r, web.ErrInvalidParam)
		return
	}
	uid := web.GetUserID(r)
	if !isPersonaKeyOwned(key, uid) {
		web.Fail(w, r, "FORBIDDEN", "access denied", http.StatusForbidden)
		return
	}
	var req personaMemoryRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	if req.Append {
		if err := h.repo.AppendPersonaMemory(key, uid, req.Content); err != nil {
			web.FailErr(w, r, web.ErrDBQuery)
			return
		}
	} else {
		if err := h.repo.UpsertPersonaMemory(key, uid, req.Content); err != nil {
			web.FailErr(w, r, web.ErrDBQuery)
			return
		}
	}
	pm, _ := h.repo.GetPersonaMemory(key)
	web.OK(w, r, agentroom.PersonaMemoryFromModel(pm))
}

// DeletePersonaMemory —— DELETE /api/v1/agentroom/persona-memory/{key}
func (h *AgentRoomHandler) DeletePersonaMemory(w http.ResponseWriter, r *http.Request) {
	key := pathID(r, "/api/v1/agentroom/persona-memory/")
	if key == "" {
		web.FailErr(w, r, web.ErrInvalidParam)
		return
	}
	uid := web.GetUserID(r)
	if !isPersonaKeyOwned(key, uid) {
		web.Fail(w, r, "FORBIDDEN", "access denied", http.StatusForbidden)
		return
	}
	if err := h.repo.DeletePersonaMemory(key); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	web.OK(w, r, map[string]any{"status": "ok"})
}

// ListPersonaMemories —— GET /api/v1/agentroom/persona-memory
func (h *AgentRoomHandler) ListPersonaMemories(w http.ResponseWriter, r *http.Request) {
	uid := web.GetUserID(r)
	ms, err := h.repo.ListPersonaMemories(uid)
	if err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	out := make([]agentroom.PersonaMemory, 0, len(ms))
	for i := range ms {
		out = append(out, agentroom.PersonaMemoryFromModel(&ms[i]))
	}
	web.OK(w, r, out)
}

// isPersonaKeyOwned：只允许 "user:{uid}:*" 或 "team:*" 形态；后续接团队权限时再收紧 team 校验。
func isPersonaKeyOwned(key string, uid uint) bool {
	if strings.HasPrefix(key, "team:") {
		return true // TODO: hook 团队 ACL
	}
	prefix := "user:" + strconv.FormatUint(uint64(uid), 10) + ":"
	return strings.HasPrefix(key, prefix)
}

// ─────────────────────────────── Playbook ───────────────────────────────

type playbookRequest struct {
	Title      string   `json:"title"`
	Problem    string   `json:"problem"`
	Approach   string   `json:"approach"`
	Conclusion string   `json:"conclusion"`
	Category   string   `json:"category,omitempty"`
	Tags       []string `json:"tags,omitempty"`
	FromRoomID string   `json:"fromRoomId,omitempty"`
}

// CreatePlaybook —— POST /api/v1/agentroom/playbooks
//   - 完整手动：body 4 段都填
//   - 半自动：提供 fromRoomId，orchestrator 调一次 LLM 总结出 4 段（覆盖 body 为空的字段）
func (h *AgentRoomHandler) CreatePlaybook(w http.ResponseWriter, r *http.Request) {
	var req playbookRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	uid := web.GetUserID(r)
	if req.FromRoomID != "" {
		if _, ok := h.authorizeRoom(w, r, req.FromRoomID); !ok {
			return
		}
		// 如果有未填字段，交给 orchestrator 自动提炼
		if strings.TrimSpace(req.Problem) == "" ||
			strings.TrimSpace(req.Approach) == "" ||
			strings.TrimSpace(req.Conclusion) == "" {
			extracted, err := h.manager.Get(req.FromRoomID).ExtractPlaybook(r.Context())
			if err == nil {
				if req.Title == "" {
					req.Title = extracted.Title
				}
				if req.Problem == "" {
					req.Problem = extracted.Problem
				}
				if req.Approach == "" {
					req.Approach = extracted.Approach
				}
				if req.Conclusion == "" {
					req.Conclusion = extracted.Conclusion
				}
			}
		}
	}
	if strings.TrimSpace(req.Title) == "" {
		web.Fail(w, r, "INVALID_PARAM", "title required", http.StatusBadRequest)
		return
	}
	p := &database.AgentRoomPlaybook{
		OwnerUserID:  uid,
		SourceRoomID: req.FromRoomID,
		Title:        req.Title,
		Problem:      req.Problem,
		Approach:     req.Approach,
		Conclusion:   req.Conclusion,
		Category:     req.Category,
		TagsJSON:     agentroom.MarshalPlaybookTags(req.Tags),
	}
	if err := h.repo.CreatePlaybook(p); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	web.OK(w, r, agentroom.PlaybookFromModel(p))
}

// ListPlaybooks —— GET /api/v1/agentroom/playbooks
func (h *AgentRoomHandler) ListPlaybooks(w http.ResponseWriter, r *http.Request) {
	uid := web.GetUserID(r)
	ps, err := h.repo.ListPlaybooks(uid)
	if err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	out := make([]agentroom.Playbook, 0, len(ps))
	for i := range ps {
		out = append(out, agentroom.PlaybookFromModel(&ps[i]))
	}
	web.OK(w, r, out)
}

// ApplyPlaybook —— POST /api/v1/agentroom/rooms/{rid}/playbooks/{pid}/apply
//
// 把 Playbook 4 段内容渲染成 markdown 片段，作为 kind=summary 的消息注入当前房间。
// Orchestrator 在下轮组 prompt 时会自然把它当作最近对话上下文喂给 agent，相当于 few-shot。
// 设计取舍：不在 system prompt 永久注入，避免"经验"随着房间进程无法覆盖；summary 消息后续
// 用户可以手动编辑/删除，更接近团队 "把参考资料贴到群里" 的心智模型。
func (h *AgentRoomHandler) ApplyPlaybook(w http.ResponseWriter, r *http.Request) {
	// URL: /api/v1/agentroom/rooms/{rid}/playbooks/{pid}/apply
	rest := strings.TrimPrefix(r.URL.Path, "/api/v1/agentroom/rooms/")
	parts := strings.Split(rest, "/")
	if len(parts) < 4 || parts[1] != "playbooks" || parts[3] != "apply" {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	rid, pid := parts[0], parts[2]
	if rid == "" || pid == "" {
		web.FailErr(w, r, web.ErrInvalidParam)
		return
	}
	if _, ok := h.authorizeRoom(w, r, rid); !ok {
		return
	}
	p, err := h.repo.GetPlaybook(pid)
	if err != nil || p == nil {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	if p.OwnerUserID != 0 && p.OwnerUserID != web.GetUserID(r) {
		web.Fail(w, r, "FORBIDDEN", "access denied", http.StatusForbidden)
		return
	}

	content := renderPlaybookAsMarkdown(p)
	msg := h.manager.Get(rid).InjectSummaryMessage(content)
	h.audit(r, rid, "playbook.apply", pid, p.Title)
	web.OK(w, r, map[string]any{
		"messageId": msg.ID,
		"playbook":  agentroom.PlaybookFromModel(p),
	})
}

func renderPlaybookAsMarkdown(p *database.AgentRoomPlaybook) string {
	var sb strings.Builder
	sb.WriteString("📚 **参考 Playbook · " + strings.TrimSpace(p.Title) + "**\n\n")
	if p.Category != "" {
		sb.WriteString("_分类：" + p.Category + "_\n\n")
	}
	if s := strings.TrimSpace(p.Problem); s != "" {
		sb.WriteString("**问题**\n\n" + s + "\n\n")
	}
	if s := strings.TrimSpace(p.Approach); s != "" {
		sb.WriteString("**方法**\n\n" + s + "\n\n")
	}
	if s := strings.TrimSpace(p.Conclusion); s != "" {
		sb.WriteString("**结论**\n\n" + s + "\n\n")
	}
	sb.WriteString("---\n_以上内容来自跨房间经验库，请结合当前房间目标参考，不必机械照搬。_")
	return sb.String()
}

// DeletePlaybook —— DELETE /api/v1/agentroom/playbooks/{id}
func (h *AgentRoomHandler) DeletePlaybook(w http.ResponseWriter, r *http.Request) {
	id := pathID(r, "/api/v1/agentroom/playbooks/")
	if id == "" {
		web.FailErr(w, r, web.ErrInvalidParam)
		return
	}
	p, err := h.repo.GetPlaybook(id)
	if err != nil || p == nil {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	if p.OwnerUserID != 0 && p.OwnerUserID != web.GetUserID(r) {
		web.Fail(w, r, "FORBIDDEN", "access denied", http.StatusForbidden)
		return
	}
	if err := h.repo.DeletePlaybook(id); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	web.OK(w, r, map[string]any{"status": "ok"})
}
