// dispatch_spawn.go —— mode=subagent 的真实 OpenClaw sessions_spawn 路径。
//
// 与 dispatch.go 里的 member_agent fallback 不同，这里 fork 出 isolated 子 session
// 让任务在干净上下文里跑；返回 false 时由 caller 降级到 member_agent。
//
// 见 docs/agentroom/REAL_SUBAGENT_SPAWN.md。
package agentroom

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"ClawDeckX/internal/database"
	"ClawDeckX/internal/logger"
)

// tryRealSubagentSpawn 尝试通过上游 sessions_spawn 跑这次派发。
//
// 返回 true 表示已完整处理 execution（成功或硬失败都已写库 + 广播），
// caller 不应再走 member_agent 路径；
// 返回 false 表示 spawn 路径不可用或被拒，caller 应降级。
func (o *Orchestrator) tryRealSubagentSpawn(
	ctx context.Context,
	p dispatchPayload,
	t *database.AgentRoomTask,
	m *database.AgentRoomMember,
	trigger *database.AgentRoomMessage,
) bool {
	if o.bridge == nil || !o.bridge.IsAvailable() {
		return false
	}
	parentSessionKey := strings.TrimSpace(m.SessionKey)
	if parentSessionKey == "" {
		parentSessionKey = SessionKeyFor(m.AgentID, o.roomID, m.ID)
	}
	agentID := strings.TrimSpace(m.AgentID)
	if agentID == "" {
		// AgentRoomMember 没绑定 agentId 时无法 spawn —— 上游需要明确的 agentId
		return false
	}

	// 任务 prompt 直接复用派发系统消息文本（含任务/DoD/返工说明）
	taskPrompt := strings.TrimSpace(trigger.Content)
	if taskPrompt == "" {
		taskPrompt = strings.TrimSpace(t.Text)
	}

	logger.Log.Info().
		Str("room", o.roomID).Str("task", p.TaskID).
		Str("execution", p.ExecutionID).Str("member", p.MemberID).
		Str("parentSession", parentSessionKey).Str("agentId", agentID).
		Msg("agentroom: dispatching task via real subagent spawn")

	// 限制 spawn 调用本身不要被无限 ctx 拖死
	timeoutSec := 240
	res, err := o.bridge.SpawnSubagent(ctx, SpawnRequest{
		ParentSessionKey: parentSessionKey,
		AgentID:          agentID,
		Task:             taskPrompt,
		Model:            m.Model,
		Thinking:         m.Thinking,
		Label:            fmt.Sprintf("agentroom-task-%s-exec-%s", p.TaskID, p.ExecutionID),
		TimeoutSeconds:   timeoutSec,
	})
	if err != nil {
		if errors.Is(err, ErrSpawnNotSupported) {
			// 让 caller 降级到 member_agent
			return false
		}
		// 上游明确拒绝（forbidden / agent_unknown / spawn_depth_exceeded ...）
		// 这是硬失败：execution failed + task → todo
		o.failExecution(p.ExecutionID, fmt.Sprintf("subagent spawn failed: %v", err))
		if t2, _ := o.repo.GetTask(p.TaskID); t2 != nil && t2.Status == TaskStatusInProgress {
			_ = o.repo.UpdateTask(p.TaskID, map[string]any{"status": TaskStatusTodo})
		}
		o.appendSystemNotice(fmt.Sprintf("❌ 子代理 spawn 失败：%v", err))
		return true
	}
	if res == nil {
		o.failExecution(p.ExecutionID, "subagent spawn returned empty result")
		return true
	}

	summary := strings.TrimSpace(res.Output)
	if summary == "" {
		summary = "（子代理已 spawn，无同步文本输出）"
	}
	if r := []rune(summary); len(r) > 2000 {
		summary = string(r[:2000]) + "…"
	}

	// rawRunRef：把子 session + runId 都塞进去，便于日后审计 / sessions.get 查 transcript
	rawRunRef := strings.TrimSpace(res.RunID)
	if res.ChildSessionKey != "" {
		if rawRunRef != "" {
			rawRunRef = res.ChildSessionKey + "#" + rawRunRef
		} else {
			rawRunRef = res.ChildSessionKey
		}
	}

	completedAt := NowMs()
	patch := map[string]any{
		"status":       TaskExecStatusCompleted,
		"summary":      summary,
		"completed_at": &completedAt,
	}
	if rawRunRef != "" {
		patch["raw_run_ref"] = rawRunRef
	}
	_ = o.repo.UpdateTaskExecution(p.ExecutionID, patch)

	_ = o.repo.UpdateTask(p.TaskID, map[string]any{
		"result_summary": summary,
		"status":         TaskStatusReview,
	})
	o.broker.Emit(o.roomID, EventRoomUpdate, map[string]any{
		"roomId": o.roomID, "patch": map[string]any{"tasksChanged": true},
	})
	o.appendSystemNotice(fmt.Sprintf("🛰️ 任务已由子代理（@%s isolated）完成，进入待验收。", m.Name))

	// 主题 B：reviewer 是 agent 时自动触发初判
	o.tryAutoReview(ctx, p.TaskID)
	return true
}
