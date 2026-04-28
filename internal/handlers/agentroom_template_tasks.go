// agentroom_template_tasks.go —— 模板初始任务清单的种子化逻辑。
//
// 配合 templates.go 里的 TemplateTask：在房间创建后、orchestrator 启动前，
// 把模板预置的任务批量 insert 成真实 AgentRoomTask，并解析：
//   - ExecutorRoleID → AssigneeID (memberId)
//   - ReviewerRoleID（缺省回退到 IsDefaultReviewer 成员）→ ReviewerID
//   - DependsOnIndices → DependsOnJSON（前置任务的真实 id）
//
// 任何字段解析失败都做"软降级"：种子任务能落库尽量落库，不让模板创建因数据
// 不齐而失败。
package handlers

import (
	"encoding/json"
	"strings"

	"ClawDeckX/internal/agentroom"
	"ClawDeckX/internal/database"
)

// seededTask —— 种子化后的任务摘要，供调用方决定是否自动派发。
type seededTask struct {
	ID         string
	AssigneeID string
	HasDeps    bool
}

func seedInitialTasksFromTemplate(
	repo *agentroom.Repo,
	roomID string,
	creatorID string,
	tasks []agentroom.TemplateTask,
	tplMembers []agentroom.TemplateMember,
	resolved []resolvedMemberSpec,
	disabled map[int]bool,
) []seededTask {
	if repo == nil || len(tasks) == 0 {
		return nil
	}
	var result []seededTask

	// 构建 roleId → memberId 映射。member 创建顺序与 tplMembers 对齐
	// （CreateRoom 里 `for i, resolved := range members { memberID := fmt.Sprintf("%s_m%d", ...) }`）。
	roleToMemberID := make(map[string]string, len(tplMembers))
	defaultReviewerID := ""
	for i, m := range tplMembers {
		if i >= len(resolved) {
			break
		}
		key := strings.TrimSpace(m.RoleID)
		if key == "" {
			continue
		}
		// memberID 必须与 CreateRoom 里 `${roomID}_m${i}` 完全一致
		mid := roomID + "_m" + itoa(i)
		roleToMemberID[key] = mid
		if m.IsDefaultReviewer && defaultReviewerID == "" {
			defaultReviewerID = mid
		}
	}

	// 按下标顺序 insert，记录 idx → taskID 让后面的 task 可以解析 dependsOn。
	createdIDs := make([]string, 0, len(tasks))
	for idx, tt := range tasks {
		text := strings.TrimSpace(tt.Text)
		if text == "" {
			createdIDs = append(createdIDs, "")
			continue
		}
		if disabled[idx] {
			// 用户在向导第 3 步勾掉了这条；保留下标占位让后面任务的 dependsOn 不会指向错位的 id
			createdIDs = append(createdIDs, "")
			continue
		}
		t := &database.AgentRoomTask{
			RoomID:           roomID,
			Text:             text,
			CreatorID:        creatorID,
			Status:           agentroom.TaskStatusTodo,
			Deliverable:      strings.TrimSpace(tt.Deliverable),
			DefinitionOfDone: strings.TrimSpace(tt.DefinitionOfDone),
		}
		if rid := strings.TrimSpace(tt.ExecutorRoleID); rid != "" {
			if mid, ok := roleToMemberID[rid]; ok {
				t.AssigneeID = mid
			}
		}
		if rrid := strings.TrimSpace(tt.ReviewerRoleID); rrid != "" {
			if mid, ok := roleToMemberID[rrid]; ok {
				t.ReviewerID = mid
			}
		}
		if t.ReviewerID == "" && defaultReviewerID != "" {
			t.ReviewerID = defaultReviewerID
		}
		// 解析 dependsOn：只保留前面已成功 insert 的下标对应的 task id。
		if len(tt.DependsOnIndices) > 0 {
			deps := make([]string, 0, len(tt.DependsOnIndices))
			for _, di := range tt.DependsOnIndices {
				if di < 0 || di >= len(createdIDs) {
					continue
				}
				if id := createdIDs[di]; id != "" {
					deps = append(deps, id)
				}
			}
			if len(deps) > 0 {
				if b, err := json.Marshal(deps); err == nil {
					t.DependsOnJSON = string(b)
				}
			}
		}
		if err := repo.CreateTask(t); err != nil {
			createdIDs = append(createdIDs, "")
			continue
		}
		createdIDs = append(createdIDs, t.ID)
		result = append(result, seededTask{
			ID:         t.ID,
			AssigneeID: t.AssigneeID,
			HasDeps:    strings.TrimSpace(t.DependsOnJSON) != "" && t.DependsOnJSON != "[]",
		})
		_ = idx // 显式记录：我们按下标顺序处理
	}
	return result
}

// autoDispatchSeededTasks —— 对种子化的任务中没有依赖且有 assignee 的，自动创建 execution 并通过
// orchestrator 派发。这样用户建房后无需所有任务都手动点「派发」。
//
// dispatchMode 可为 "member_agent" / "subagent"，空则默认 "member_agent"。
func autoDispatchSeededTasks(
	repo *agentroom.Repo,
	seeded []seededTask,
	roomID string,
	dispatchMode string,
	orch *agentroom.Orchestrator,
) {
	if len(seeded) == 0 || orch == nil {
		return
	}
	if dispatchMode == "" {
		dispatchMode = agentroom.TaskExecutionModeMemberAgent
	}
	for _, st := range seeded {
		if st.ID == "" || st.AssigneeID == "" || st.HasDeps {
			continue
		}
		now := agentroom.NowMs()
		exe := &database.AgentRoomTaskExecution{
			TaskID:           st.ID,
			RoomID:           roomID,
			ExecutorMemberID: st.AssigneeID,
			Mode:             dispatchMode,
			Status:           agentroom.TaskExecStatusQueued,
			StartedAt:        &now,
		}
		if err := repo.CreateTaskExecution(exe); err != nil {
			continue
		}
		_ = repo.UpdateTask(st.ID, map[string]any{"status": agentroom.TaskStatusInProgress})
		orch.DispatchTaskAsAgent(st.ID, exe.ID, st.AssigneeID, dispatchMode)
	}
}

// itoa —— 小整数 → 字符串，避免引入 strconv 仅为这一处。
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}
