// Package handlers · agentroom_lineage.go
//
// v0.3 主题 C：跨房间血缘 (Lineage) handler。
//
// 提供两个核心 API：
//
//	POST /api/v1/agentroom/rooms/{newRoomId}/clone-from/{sourceRoomId}
//	  body: { taskIds?: [...], riskIds?: [...] }   省略时默认 = 源会复盘草案推荐项
//	  作用：把 sourceRoomId 中指定的 task / risk 真实复制到 newRoomId
//	         同时 newRoom.parentRoomId = sourceRoomId（若原本未设）
//	         新建的 task.parentTaskId / risk.parentRiskId 指向源对象，形成 lineage
//
//	GET  /api/v1/agentroom/rooms/{roomId}/lineage
//	  作用：返回当前房间的"血缘视图"
//	    {
//	      parent:  {id, title} | null,    // 直接父房间（fork / 续会源）
//	      root:    {id, title} | null,    // 沿父向上追溯到的最初房间
//	      children:[{id, title, ...}],    // 把当前房间作为 parent 的所有房间
//	    }
//
//	GET  /api/v1/agentroom/tasks/{taskId}/lineage
//	  作用：返回单个任务的全血缘
//	    {
//	      task:           Task,
//	      sourceDecision: Message | null,
//	      sourceMessage:  Message | null,
//	      parentTask:     Task | null,        // 跨房间父任务
//	      childTasks:     [Task],             // 在续会中被克隆出的子任务
//	      executions:     [TaskExecution]
//	    }
//
// 设计要点：
//   - clone 是幂等的：相同 (newRoom, sourceTask) 不会重复克隆（按 parentTaskId 检查）
//   - lineage 接口是只读，复用现有 repo + 新增小查询
//   - 鉴权：所有接口都要求当前用户是相关房间 owner

package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"ClawDeckX/internal/agentroom"
	"ClawDeckX/internal/database"
	"ClawDeckX/internal/web"
)

// CloneFromRoom —— POST /api/v1/agentroom/rooms/{newRoomId}/clone-from/{sourceRoomId}
//
// Body：
//
//	{
//	  "taskIds": ["task_xxx", ...],   // 可选；空数组表示不克隆任务
//	  "riskIds": ["risk_xxx", ...],   // 可选
//	}
//
// 至少一个数组必须非空，否则返回 400。
func (h *AgentRoomHandler) CloneFromRoom(w http.ResponseWriter, r *http.Request) {
	// path: /api/v1/agentroom/rooms/{newRoomId}/clone-from/{sourceRoomId}
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/agentroom/rooms/")
	parts := strings.Split(path, "/")
	if len(parts) != 3 || parts[1] != "clone-from" {
		web.FailErr(w, r, web.ErrInvalidParam)
		return
	}
	newRoomID := parts[0]
	sourceRoomID := parts[2]
	if newRoomID == "" || sourceRoomID == "" || newRoomID == sourceRoomID {
		web.FailErr(w, r, web.ErrInvalidParam)
		return
	}
	// 鉴权：两个房间都必须当前用户能访问
	newRoom, ok := h.authorizeRoom(w, r, newRoomID)
	if !ok {
		return
	}
	if _, ok := h.authorizeRoom(w, r, sourceRoomID); !ok {
		return
	}

	var req struct {
		TaskIDs []string `json:"taskIds"`
		RiskIDs []string `json:"riskIds"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	if len(req.TaskIDs) == 0 && len(req.RiskIDs) == 0 {
		web.Fail(w, r, "EMPTY_CLONE_LIST",
			"taskIds and riskIds cannot both be empty",
			http.StatusBadRequest)
		return
	}

	// 维护 newRoom.parentRoomId（若没设）
	if newRoom.ParentRoomID == "" {
		_ = h.repo.UpdateRoom(newRoomID, map[string]any{
			"parent_room_id": sourceRoomID,
		})
	}

	clonedTasks := make([]agentroom.Task, 0, len(req.TaskIDs))
	skippedTasks := 0
	for _, srcID := range req.TaskIDs {
		src, err := h.repo.GetTask(srcID)
		if err != nil || src == nil || src.RoomID != sourceRoomID {
			skippedTasks++
			continue
		}
		// 幂等：检查是否已克隆
		if existing, _ := h.findTaskByParent(newRoomID, srcID); existing != nil {
			skippedTasks++
			continue
		}
		// 计算 root_room_id：源任务有 root 用源 root；否则源房间就是 root
		rootRoom := src.RootRoomID
		if rootRoom == "" {
			rootRoom = sourceRoomID
		}
		nt := &database.AgentRoomTask{
			RoomID:           newRoomID,
			Text:             src.Text,
			AssigneeID:       src.AssigneeID,
			CreatorID:        src.CreatorID,
			Status:           agentroom.TaskStatusTodo, // 克隆体重置状态，不继承 done/review
			DueAt:            src.DueAt,
			ReviewerID:       src.ReviewerID,
			Deliverable:      src.Deliverable,
			DefinitionOfDone: src.DefinitionOfDone,
			ExecutionMode:    src.ExecutionMode,
			SourceDecisionID: src.SourceDecisionID, // 决策来源跨房间保留（仅作引用）
			ParentTaskID:     srcID,
			RootRoomID:       rootRoom,
		}
		if err := h.repo.CreateTask(nt); err != nil {
			skippedTasks++
			continue
		}
		clonedTasks = append(clonedTasks, agentroom.TaskFromModel(nt))
	}

	clonedRisks := make([]agentroom.Risk, 0, len(req.RiskIDs))
	skippedRisks := 0
	if len(req.RiskIDs) > 0 {
		// ListRisks 一次性拉取，按 ID 取
		all, _ := h.repo.ListRisks(sourceRoomID)
		byID := make(map[string]*database.AgentRoomRisk, len(all))
		for i := range all {
			byID[all[i].ID] = &all[i]
		}
		for _, srcID := range req.RiskIDs {
			src := byID[srcID]
			if src == nil {
				skippedRisks++
				continue
			}
			if existing, _ := h.findRiskByParent(newRoomID, srcID); existing != nil {
				skippedRisks++
				continue
			}
			nr := &database.AgentRoomRisk{
				RoomID:       newRoomID,
				Text:         src.Text,
				Severity:     src.Severity,
				OwnerID:      src.OwnerID,
				Status:       "open",
				ParentRiskID: srcID,
			}
			if err := h.repo.CreateRisk(nr); err != nil {
				skippedRisks++
				continue
			}
			clonedRisks = append(clonedRisks, agentroom.RiskFromModel(nr))
		}
	}

	h.audit(r, newRoomID, "room.clone_from", sourceRoomID, "")
	h.broker().Emit(newRoomID, agentroom.EventRoomUpdate, map[string]any{
		"roomId": newRoomID,
		"patch":  map[string]any{"tasksChanged": true, "risksChanged": true},
	})

	web.OK(w, r, map[string]any{
		"sourceRoomId": sourceRoomID,
		"newRoomId":    newRoomID,
		"clonedTasks":  clonedTasks,
		"clonedRisks":  clonedRisks,
		"skippedTasks": skippedTasks,
		"skippedRisks": skippedRisks,
	})
}

// findTaskByParent 在某房间内找已克隆自给定 parent 的任务（幂等检查用）。
// 没找到返回 nil, nil。
func (h *AgentRoomHandler) findTaskByParent(roomID, parentTaskID string) (*database.AgentRoomTask, error) {
	tasks, err := h.repo.ListTasks(roomID)
	if err != nil {
		return nil, err
	}
	for i := range tasks {
		if tasks[i].ParentTaskID == parentTaskID {
			return &tasks[i], nil
		}
	}
	return nil, nil
}

func (h *AgentRoomHandler) findRiskByParent(roomID, parentRiskID string) (*database.AgentRoomRisk, error) {
	risks, err := h.repo.ListRisks(roomID)
	if err != nil {
		return nil, err
	}
	for i := range risks {
		if risks[i].ParentRiskID == parentRiskID {
			return &risks[i], nil
		}
	}
	return nil, nil
}

// RoomLineage —— GET /api/v1/agentroom/rooms/{roomId}/lineage
type roomBrief struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	State string `json:"state"`
}

func (h *AgentRoomHandler) RoomLineage(w http.ResponseWriter, r *http.Request) {
	id := pathIDBetween(r, "/api/v1/agentroom/rooms/", "/lineage")
	room, ok := h.authorizeRoom(w, r, id)
	if !ok {
		return
	}

	out := map[string]any{
		"current":  roomBrief{ID: room.ID, Title: room.Title, State: room.State},
		"parent":   nil,
		"root":     nil,
		"children": []roomBrief{},
	}

	// 父链路：parentRoomId → 一直追溯到 root
	var rootBrief *roomBrief
	current := room
	for hop := 0; hop < 10; hop++ { // 防止环路
		if current.ParentRoomID == "" {
			break
		}
		parent, err := h.repo.GetRoom(current.ParentRoomID)
		if err != nil || parent == nil {
			break
		}
		// 第一次找到的就是直接 parent
		if hop == 0 {
			out["parent"] = roomBrief{ID: parent.ID, Title: parent.Title, State: parent.State}
		}
		rootBrief = &roomBrief{ID: parent.ID, Title: parent.Title, State: parent.State}
		current = parent
	}
	if rootBrief != nil {
		out["root"] = *rootBrief
	}

	// 子链路：所有 parent_room_id == 本房间的房间
	if children, err := h.repo.ListChildRooms(id); err == nil {
		brief := make([]roomBrief, 0, len(children))
		for i := range children {
			brief = append(brief, roomBrief{
				ID: children[i].ID, Title: children[i].Title, State: children[i].State,
			})
		}
		out["children"] = brief
	}

	web.OK(w, r, out)
}

// TaskLineage —— GET /api/v1/agentroom/tasks/{taskId}/lineage
//
// 返回任务的完整血缘视图。
func (h *AgentRoomHandler) TaskLineage(w http.ResponseWriter, r *http.Request) {
	// path: /api/v1/agentroom/tasks/{tid}/lineage
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/agentroom/tasks/")
	tid := strings.TrimSuffix(path, "/lineage")
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

	taskDTO := agentroom.TaskFromModel(t)
	out := map[string]any{
		"task":           taskDTO,
		"sourceDecision": nil,
		"sourceMessage":  nil,
		"parentTask":     nil,
		"childTasks":     []agentroom.Task{},
		"executions":     []agentroom.TaskExecution{},
	}

	// 来源决策 / 普通消息
	if t.SourceDecisionID != "" {
		if msg, _ := h.repo.GetMessage(t.SourceDecisionID); msg != nil {
			out["sourceDecision"] = agentroom.MessageFromModel(msg)
		}
	}
	if t.SourceMessageID != "" {
		if msg, _ := h.repo.GetMessage(t.SourceMessageID); msg != nil {
			out["sourceMessage"] = agentroom.MessageFromModel(msg)
		}
	}

	// 父任务（跨房间）
	if t.ParentTaskID != "" {
		if pt, _ := h.repo.GetTask(t.ParentTaskID); pt != nil {
			out["parentTask"] = agentroom.TaskFromModel(pt)
		}
	}

	// 子任务（其它房间里 parent=本任务的）
	if children, err := h.repo.ListTasksByParent(tid); err == nil {
		out["childTasks"] = mapTasks(children)
	}

	// 执行记录
	if exes, err := h.repo.ListTaskExecutions(tid); err == nil {
		converted := make([]agentroom.TaskExecution, 0, len(exes))
		for i := range exes {
			converted = append(converted, agentroom.TaskExecutionFromModel(&exes[i]))
		}
		out["executions"] = converted
	}

	web.OK(w, r, out)
}

// DecisionImpact —— GET /api/v1/agentroom/messages/{mid}/decision-impact
//
// 返回所有把 messageId 当作 sourceDecisionId 的任务（从此决策衍生出来的工作单）。
// 前端撤回决策前调用此接口，若 tasks 非空则弹出确认对话框，列出受影响任务。
//
// 返回:
//
//	{
//	  message: { id, isDecision, decisionSummary } | null,
//	  derivedTasks: [Task],   // 在本房间里 sourceDecisionId == mid 的任务
//	}
func (h *AgentRoomHandler) DecisionImpact(w http.ResponseWriter, r *http.Request) {
	// path: /api/v1/agentroom/messages/{mid}/decision-impact
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/agentroom/messages/")
	mid := strings.TrimSuffix(path, "/decision-impact")
	if mid == "" || strings.Contains(mid, "/") {
		web.FailErr(w, r, web.ErrInvalidParam)
		return
	}
	msg, err := h.repo.GetMessage(mid)
	if err != nil || msg == nil {
		web.FailErr(w, r, web.ErrNotFound)
		return
	}
	if _, ok := h.authorizeRoom(w, r, msg.RoomID); !ok {
		return
	}
	// 查同房间所有任务，挑 sourceDecisionId == mid 的
	tasks, _ := h.repo.ListTasks(msg.RoomID)
	derived := make([]agentroom.Task, 0, 4)
	for i := range tasks {
		if tasks[i].SourceDecisionID == mid {
			derived = append(derived, agentroom.TaskFromModel(&tasks[i]))
		}
	}
	web.OK(w, r, map[string]any{
		"message": map[string]any{
			"id":              msg.ID,
			"isDecision":      msg.IsDecision,
			"decisionSummary": msg.DecisionSummary,
		},
		"derivedTasks": derived,
	})
}

// validateAndCleanDeps 校验任务依赖列表（v0.3 主题 D）。
//   - 去掉空 / 重复 id
//   - 自引用直接报错
//   - 必须同房间
//   - 检测环路（深度优先；当前 task 也算入环检测起点）
//
// roomID = 当前任务所在房间；selfID = 当前任务 id（创建时为空字符串）。
// 返回去重后的 dep id 列表，或 error 描述具体问题。
func (h *AgentRoomHandler) validateAndCleanDeps(roomID, selfID string, ids []string) ([]string, error) {
	const maxDeps = 32 // 防滥用：单任务最多 32 个直接依赖
	seen := make(map[string]bool, len(ids))
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			continue
		}
		if id == selfID {
			return nil, fmt.Errorf("task cannot depend on itself")
		}
		dep, err := h.repo.GetTask(id)
		if err != nil || dep == nil {
			return nil, fmt.Errorf("dependency task %q not found", id)
		}
		if dep.RoomID != roomID {
			return nil, fmt.Errorf("cross-room dependencies are not supported (%q)", id)
		}
		seen[id] = true
		out = append(out, id)
	}
	if len(out) > maxDeps {
		return nil, fmt.Errorf("too many dependencies (max %d)", maxDeps)
	}
	if selfID != "" && len(out) > 0 {
		// 环路检测：从 out 开始向上爬，看是否能回到 selfID。
		if err := h.detectDepCycle(roomID, selfID, out); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// detectDepCycle 沿 dependsOn 链向上 DFS，若能到达 selfID 则报环。
// startDeps 是新设置的直接依赖；若把它们作为 selfID 的前置后能从其中任一节点回到 selfID，
// 则说明形成了环。深度上限 32（远大于实际合理值）。
func (h *AgentRoomHandler) detectDepCycle(roomID, selfID string, startDeps []string) error {
	visited := make(map[string]bool)
	var dfs func(id string, depth int) error
	dfs = func(id string, depth int) error {
		if depth > 32 {
			return fmt.Errorf("dependency chain too deep (>32)")
		}
		if visited[id] {
			return nil
		}
		visited[id] = true
		t, err := h.repo.GetTask(id)
		if err != nil || t == nil || t.RoomID != roomID {
			return nil
		}
		deps := agentroom.TaskFromModel(t).DependsOn
		for _, d := range deps {
			if d == selfID {
				return fmt.Errorf("dependency cycle detected via %q", id)
			}
			if err := dfs(d, depth+1); err != nil {
				return err
			}
		}
		return nil
	}
	for _, d := range startDeps {
		if err := dfs(d, 1); err != nil {
			return err
		}
	}
	return nil
}

func mapTasks(ms []database.AgentRoomTask) []agentroom.Task {
	out := make([]agentroom.Task, 0, len(ms))
	for i := range ms {
		out = append(out, agentroom.TaskFromModel(&ms[i]))
	}
	return out
}

// MyDashboard —— GET /api/v1/agentroom/dashboard
//
// 跨房间总览：返回当前用户名下所有房间的工作面板信息：
//
//	{
//	  rooms: [{id, title, state, taskCount, openCount, reviewCount, riskCount}],
//	  myActiveTasks:    [Task],   // assignee 是我的人类成员且未完成
//	  awaitingMyReview: [Task],   // reviewer 是我的人类成员且 status=review
//	}
//
// "我"目前在 ClawDeckX 单用户模型里就是 OwnerUserID 对应的用户；为简化，使用每个房间的"第一位 human 成员"作为本人代理。
func (h *AgentRoomHandler) MyDashboard(w http.ResponseWriter, r *http.Request) {
	uid := web.GetUserID(r)
	if uid == 0 {
		web.Fail(w, r, "UNAUTHORIZED", "login required", http.StatusUnauthorized)
		return
	}
	rooms, err := h.repo.ListRooms(uid)
	if err != nil {
		web.FailErr(w, r, web.ErrDBQuery)
		return
	}
	type roomSummary struct {
		ID          string `json:"id"`
		Title       string `json:"title"`
		State       string `json:"state"`
		Policy      string `json:"policy"`
		TaskCount   int    `json:"taskCount"`
		OpenCount   int    `json:"openCount"`
		ReviewCount int    `json:"reviewCount"`
		RiskCount   int    `json:"riskCount"`
		ParentRoom  string `json:"parentRoomId,omitempty"`
		UpdatedAt   int64  `json:"updatedAt"`
	}
	out := map[string]any{
		"rooms":            []roomSummary{},
		"myActiveTasks":    []agentroom.Task{},
		"awaitingMyReview": []agentroom.Task{},
	}
	summaries := make([]roomSummary, 0, len(rooms))
	myActive := []agentroom.Task{}
	myReview := []agentroom.Task{}
	for i := range rooms {
		room := &rooms[i]
		// 跳过已归档
		if room.State == agentroom.StateArchived {
			continue
		}
		tasks, _ := h.repo.ListTasks(room.ID)
		risks, _ := h.repo.ListRisks(room.ID)
		// 找到本房间的"我"——第一位 human 成员
		members, _ := h.repo.ListMembers(room.ID)
		var myMemberID string
		for _, m := range members {
			if m.Kind == "human" {
				myMemberID = m.ID
				break
			}
		}
		open := 0
		review := 0
		for _, t := range tasks {
			if t.Status != agentroom.TaskStatusDone && t.Status != agentroom.TaskStatusCancelled {
				open++
			}
			if t.Status == agentroom.TaskStatusReview {
				review++
			}
			if myMemberID != "" {
				if t.AssigneeID == myMemberID && t.Status != agentroom.TaskStatusDone && t.Status != agentroom.TaskStatusCancelled {
					myActive = append(myActive, agentroom.TaskFromModel(&t))
				}
				if t.ReviewerID == myMemberID && t.Status == agentroom.TaskStatusReview {
					myReview = append(myReview, agentroom.TaskFromModel(&t))
				}
			}
		}
		summaries = append(summaries, roomSummary{
			ID:          room.ID,
			Title:       room.Title,
			State:       room.State,
			Policy:      room.Policy,
			TaskCount:   len(tasks),
			OpenCount:   open,
			ReviewCount: review,
			RiskCount:   len(risks),
			ParentRoom:  room.ParentRoomID,
			UpdatedAt:   room.UpdatedAt.UnixMilli(),
		})
	}
	out["rooms"] = summaries
	out["myActiveTasks"] = myActive
	out["awaitingMyReview"] = myReview
	web.OK(w, r, out)
}
