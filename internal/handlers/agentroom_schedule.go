// agentroom_schedule.go —— v1.0 定时会议 CRUD + 手动触发。
//
// API:
//
//	GET    /api/v1/agentroom/schedules          → 列出当前用户的定时任务
//	POST   /api/v1/agentroom/schedules          → 创建定时任务
//	GET    /api/v1/agentroom/schedules/{id}     → 获取详情
//	PUT    /api/v1/agentroom/schedules/{id}     → 更新
//	DELETE /api/v1/agentroom/schedules/{id}     → 删除
//	POST   /api/v1/agentroom/schedules/{id}/run → 手动立即触发一次
package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	"ClawDeckX/internal/agentroom"
	"ClawDeckX/internal/database"
	"ClawDeckX/internal/web"
)

// SchedulesRouter 路由分发。
func (h *AgentRoomHandler) SchedulesRouter(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/agentroom/schedules")
	path = strings.TrimPrefix(path, "/")
	switch {
	case path == "" && r.Method == http.MethodGet:
		h.ListSchedules(w, r)
	case path == "" && r.Method == http.MethodPost:
		h.CreateSchedule(w, r)
	case strings.HasSuffix(path, "/run") && r.Method == http.MethodPost:
		h.RunScheduleNow(w, r)
	case r.Method == http.MethodGet:
		h.GetSchedule(w, r)
	case r.Method == http.MethodPut:
		h.UpdateSchedule(w, r)
	case r.Method == http.MethodDelete:
		h.DeleteSchedule(w, r)
	default:
		web.Fail(w, r, "METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed)
	}
}

// ListSchedules — GET /api/v1/agentroom/schedules
func (h *AgentRoomHandler) ListSchedules(w http.ResponseWriter, r *http.Request) {
	uid := web.GetUserID(r)
	schedules, err := h.repo.ListSchedules(uid)
	if err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	web.OK(w, r, schedules)
}

// CreateSchedule — POST /api/v1/agentroom/schedules
//
// 接受两种形态：
//   - 模板路径：{ templateId, ... }
//   - blueprint 路径：{ blueprint: <createRoomRequest>, ... } —— 用于 custom / AI 建会的定时化
func (h *AgentRoomHandler) CreateSchedule(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Title           string                   `json:"title"`
		TemplateID      string                   `json:"templateId"`
		CronExpr        string                   `json:"cronExpr"`
		Timezone        string                   `json:"timezone"`
		InitialPrompt   string                   `json:"initialPrompt"`
		AutoCloseout    *bool                    `json:"autoCloseout"`
		RoundBudget     int                      `json:"roundBudget"`
		BudgetCNY       float64                  `json:"budgetCNY"`
		InheritFromLast *bool                    `json:"inheritFromLast"`
		DeadlineAction  string                   `json:"deadlineAction"`
		PolicyOptions   *agentroom.PolicyOptions `json:"policyOptions"`
		// blueprint：完整的 createRoomRequest（含 members / policy / initialTasks 等）。
		// 与 templateId 互斥：填了 templateId 优先走模板，否则要求 blueprint 非空。
		Blueprint *createRoomRequest `json:"blueprint"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	if strings.TrimSpace(req.Title) == "" || strings.TrimSpace(req.CronExpr) == "" {
		web.Fail(w, r, "INVALID_PARAM", "title and cronExpr are required", http.StatusBadRequest)
		return
	}
	tplID := strings.TrimSpace(req.TemplateID)
	var blueprintJSON string
	switch {
	case tplID != "":
		// 验证模板存在
		if agentroom.FindTemplate(tplID) == nil {
			web.Fail(w, r, "TEMPLATE_NOT_FOUND", "template not found", http.StatusBadRequest)
			return
		}
	case req.Blueprint != nil:
		// 校验 blueprint 至少能跑通：kind=custom 时 title/members 必填，否则 buildRoomFromRequest 会报错。
		if req.Blueprint.Kind == "" {
			req.Blueprint.Kind = "custom"
		}
		if req.Blueprint.Kind == "custom" && len(req.Blueprint.Members) == 0 {
			web.Fail(w, r, "INVALID_PARAM", "blueprint.members is required for custom kind", http.StatusBadRequest)
			return
		}
		bb, err := json.Marshal(req.Blueprint)
		if err != nil {
			web.FailErr(w, r, web.ErrInvalidBody)
			return
		}
		blueprintJSON = string(bb)
	default:
		web.Fail(w, r, "INVALID_PARAM", "either templateId or blueprint is required", http.StatusBadRequest)
		return
	}

	autoCloseout := true
	if req.AutoCloseout != nil {
		autoCloseout = *req.AutoCloseout
	}
	inheritFromLast := true
	if req.InheritFromLast != nil {
		inheritFromLast = *req.InheritFromLast
	}
	tz := strings.TrimSpace(req.Timezone)
	if tz == "" {
		tz = "Asia/Shanghai"
	}
	da := strings.TrimSpace(req.DeadlineAction)
	if da == "" {
		if autoCloseout {
			da = "closeout"
		} else {
			da = "summarize"
		}
	}
	roundBudget := req.RoundBudget
	if roundBudget <= 0 {
		roundBudget = 12
	}
	budgetCNY := req.BudgetCNY
	if budgetCNY <= 0 {
		budgetCNY = 1.0
	}

	var optsJSON string
	if req.PolicyOptions != nil {
		b, _ := json.Marshal(req.PolicyOptions)
		optsJSON = string(b)
	}

	sched := &database.AgentRoomSchedule{
		OwnerUserID:     web.GetUserID(r),
		Title:           strings.TrimSpace(req.Title),
		TemplateID:      tplID,
		CronExpr:        strings.TrimSpace(req.CronExpr),
		Timezone:        tz,
		Enabled:         true,
		InitialPrompt:   strings.TrimSpace(req.InitialPrompt),
		AutoCloseout:    autoCloseout,
		RoundBudget:     roundBudget,
		BudgetCNY:       budgetCNY,
		InheritFromLast: inheritFromLast,
		DeadlineAction:  da,
		PolicyOptsJSON:  optsJSON,
		BlueprintJSON:   blueprintJSON,
	}
	if err := h.repo.CreateSchedule(sched); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	// 计算并设置下次运行时间
	if h.scheduler != nil {
		h.scheduler.CalcAndSetNextRun(sched)
	}
	// 重新读回含 NextRunAt 的记录
	saved, _ := h.repo.GetSchedule(sched.ID)
	if saved != nil {
		web.OK(w, r, saved)
	} else {
		web.OK(w, r, sched)
	}
}

// GetSchedule — GET /api/v1/agentroom/schedules/{id}
func (h *AgentRoomHandler) GetSchedule(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/v1/agentroom/schedules/")
	id = strings.TrimSuffix(id, "/")
	if id == "" {
		web.FailErr(w, r, web.ErrInvalidParam)
		return
	}
	sched, err := h.repo.GetSchedule(id)
	if err != nil || sched == nil {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	if sched.OwnerUserID != web.GetUserID(r) {
		web.FailErr(w, r, web.ErrForbidden)
		return
	}
	web.OK(w, r, sched)
}

// UpdateSchedule — PUT /api/v1/agentroom/schedules/{id}
func (h *AgentRoomHandler) UpdateSchedule(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/v1/agentroom/schedules/")
	id = strings.TrimSuffix(id, "/")
	if id == "" {
		web.FailErr(w, r, web.ErrInvalidParam)
		return
	}
	sched, err := h.repo.GetSchedule(id)
	if err != nil || sched == nil {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	if sched.OwnerUserID != web.GetUserID(r) {
		web.FailErr(w, r, web.ErrForbidden)
		return
	}
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	patch := map[string]any{}
	if v, ok := body["title"].(string); ok && v != "" {
		patch["title"] = v
	}
	if v, ok := body["cronExpr"].(string); ok && v != "" {
		patch["cron_expr"] = v
	}
	if v, ok := body["timezone"].(string); ok && v != "" {
		patch["timezone"] = v
	}
	if v, ok := body["enabled"].(bool); ok {
		patch["enabled"] = v
	}
	if v, ok := body["initialPrompt"].(string); ok {
		patch["initial_prompt"] = v
	}
	if v, ok := body["autoCloseout"].(bool); ok {
		patch["auto_closeout"] = v
	}
	if v, ok := body["roundBudget"].(float64); ok {
		patch["round_budget"] = int(v)
	}
	if v, ok := body["budgetCNY"].(float64); ok {
		patch["budget_cny"] = v
	}
	if v, ok := body["inheritFromLast"].(bool); ok {
		patch["inherit_from_last"] = v
	}
	if v, ok := body["deadlineAction"].(string); ok {
		patch["deadline_action"] = v
	}
	if len(patch) == 0 {
		web.OK(w, r, sched)
		return
	}
	if err := h.repo.UpdateSchedule(id, patch); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	// 如果 cron / timezone / enabled 变了，重算 next_run_at。
	//   enabled=false → 清空 next_run_at（避免下次 due 误触发）
	//   enabled=true 且 cron/timezone 变了，或仅 enabled 由 false→true → 重新计算
	_, cronChanged := patch["cron_expr"]
	_, tzChanged := patch["timezone"]
	enabledChanged := false
	if v, ok := patch["enabled"].(bool); ok {
		enabledChanged = true
		if !v {
			_ = h.repo.UpdateSchedule(id, map[string]any{"next_run_at": nil})
		}
	}
	if cronChanged || tzChanged || enabledChanged {
		updated, _ := h.repo.GetSchedule(id)
		if updated != nil && updated.Enabled && h.scheduler != nil {
			h.scheduler.CalcAndSetNextRun(updated)
		}
	}
	updated, _ := h.repo.GetSchedule(id)
	if updated != nil {
		web.OK(w, r, updated)
	} else {
		web.OK(w, r, map[string]any{"status": "ok"})
	}
}

// DeleteSchedule — DELETE /api/v1/agentroom/schedules/{id}
func (h *AgentRoomHandler) DeleteSchedule(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/v1/agentroom/schedules/")
	id = strings.TrimSuffix(id, "/")
	if id == "" {
		web.FailErr(w, r, web.ErrInvalidParam)
		return
	}
	sched, err := h.repo.GetSchedule(id)
	if err != nil || sched == nil {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	if sched.OwnerUserID != web.GetUserID(r) {
		web.FailErr(w, r, web.ErrForbidden)
		return
	}
	if err := h.repo.DeleteSchedule(id); err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	web.OK(w, r, map[string]any{"status": "deleted"})
}

// RunScheduleNow — POST /api/v1/agentroom/schedules/{id}/run
func (h *AgentRoomHandler) RunScheduleNow(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/agentroom/schedules/")
	id := strings.TrimSuffix(path, "/run")
	if id == "" {
		web.FailErr(w, r, web.ErrInvalidParam)
		return
	}
	sched, err := h.repo.GetSchedule(id)
	if err != nil || sched == nil {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	if sched.OwnerUserID != web.GetUserID(r) {
		web.FailErr(w, r, web.ErrForbidden)
		return
	}
	if h.scheduler == nil {
		web.Fail(w, r, "SCHEDULER_UNAVAILABLE", "room scheduler not initialized", http.StatusServiceUnavailable)
		return
	}
	roomID, runErr := h.scheduler.RunNow(id)
	if runErr != nil {
		web.Fail(w, r, "SCHEDULE_RUN_FAILED", runErr.Error(), http.StatusInternalServerError)
		return
	}
	web.OK(w, r, map[string]any{"status": "ok", "roomId": roomID})
}
