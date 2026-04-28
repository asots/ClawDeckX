// Package agentroom · dispatch.go
//
// v0.3 主题 A 实现：把"任务派发"从空壳变成真实运行时。
//
// 调用链：
//
//	HTTP DispatchTask (handler)
//	   └─ Manager.Get(roomID).DispatchTaskAsAgent(taskID, executionID, memberID, mode)
//	        └─ orchestrator 入命令队列 "task.dispatch"
//	             └─ onDispatchTask（loop 内串行执行）
//	                  ├─ 写一条派发系统消息到房间（"🚀 派发任务给 @X..."）
//	                  ├─ 调 runAgentTurn 让该成员真在自己的 OpenClaw session 里干活
//	                  ├─ 取该成员本轮最新的 chat 消息作为执行结果
//	                  └─ 自动 SubmitExecutionResult：
//	                       execution → completed + summary=agent reply
//	                       task      → status=review，等 reviewer 接手
//
// 设计要点：
//   - 复用现有 runAgentTurn —— agent 的回复自然出现在房间消息流里，与正常发言无异
//   - 派发是异步的：handler 立即返回 queued execution，真实运行在 orchestrator loop 里
//   - mode=manual 不走这里（在 handler 里直接写 queued execution 等用户提交）
//   - mode=subagent 在 v0.3 与 member_agent 同路径（真正的 subagent.spawn 留待后续；
//     差异只在 system 消息文案 + 执行模式标签，便于审计区分）
//   - 失败处理：agent 运行失败时 execution → failed + errorMsg；任务回退 todo

package agentroom

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"ClawDeckX/internal/database"
	"ClawDeckX/internal/logger"
)

// dispatchPayload —— "task.dispatch" 命令的载荷。
type dispatchPayload struct {
	TaskID      string
	ExecutionID string
	MemberID    string
	Mode        string
}

// DispatchTaskAsAgent 公开入口：handler 调它把"让某成员 agent 接手任务"工作排队到 orchestrator loop。
//
// 调用方约定：handler 已经创建好 task 与对应的 queued execution 行；本方法只负责
// "把这条 execution 跑起来"。失败 / 超时通过 broker 事件 + execution 状态反映给前端。
//
// 不会阻塞——立即返回。真实运行发生在 orchestrator loop 里。
func (o *Orchestrator) DispatchTaskAsAgent(taskID, executionID, memberID, mode string) {
	if o == nil {
		return
	}
	o.send("task.dispatch", dispatchPayload{
		TaskID:      taskID,
		ExecutionID: executionID,
		MemberID:    memberID,
		Mode:        mode,
	})
}

// onDispatchTask 在 orchestrator loop 内执行真实派发。
//
// 注意：本方法可能比较耗时（runAgentTurn 内部会阻塞到 agent 回复完成），
// 这意味着派发期间 orchestrator 的其它命令会排队。这是合理的——派发本身就是房间的一次"主动发言"，
// 不应该和别的发言并行（避免话题撕裂）。
func (o *Orchestrator) onDispatchTask(ctx context.Context, p dispatchPayload) {
	if p.TaskID == "" || p.ExecutionID == "" || p.MemberID == "" {
		return
	}
	// 1) 校验 task / execution / member 三者都还存在且状态合理
	t, err := o.repo.GetTask(p.TaskID)
	if err != nil || t == nil {
		o.failExecution(p.ExecutionID, "task no longer exists")
		return
	}
	if t.RoomID != o.roomID {
		o.failExecution(p.ExecutionID, "task not in this room")
		return
	}
	exe, err := o.repo.GetTaskExecution(p.ExecutionID)
	if err != nil || exe == nil {
		return
	}
	// 已经被取消 / 超时 → 不再尝试
	if exe.Status != TaskExecStatusQueued {
		return
	}
	m := o.findMember(p.MemberID)
	if m == nil || m.Kind != "agent" {
		o.failExecution(p.ExecutionID, "executor is not an agent member")
		return
	}
	if m.IsKicked || m.IsMuted {
		o.failExecution(p.ExecutionID, fmt.Sprintf("member %s is kicked or muted", m.Name))
		return
	}

	// 2) execution 状态 → running
	now := NowMs()
	_ = o.repo.UpdateTaskExecution(p.ExecutionID, map[string]any{
		"status":     TaskExecStatusRunning,
		"started_at": &now,
	})
	o.broker.Emit(o.roomID, EventRoomUpdate, map[string]any{
		"roomId": o.roomID, "patch": map[string]any{"tasksChanged": true},
	})

	// 3) 在房间消息流中插入派发指令消息（作为 trigger）
	dispatchPrompt := buildDispatchPrompt(t, m, p.Mode, exe)
	triggerMsg := &database.AgentRoomMessage{
		ID:        GenID("msg"),
		RoomID:    o.roomID,
		Timestamp: NowMs(),
		AuthorID:  "system",
		Kind:      MsgKindSystem,
		Content:   dispatchPrompt,
		// 直接 @ 该成员，让 runAgentTurn 的 contextPrompt 能感知到
		MentionIDsJSON: jsonMarshal([]string{p.MemberID}),
	}
	if err := o.repo.CreateMessage(triggerMsg); err != nil {
		o.failExecution(p.ExecutionID, fmt.Sprintf("post dispatch prompt failed: %v", err))
		return
	}
	o.broker.Emit(o.roomID, EventMessageAppend, map[string]any{
		"roomId": o.roomID, "message": MessageFromModel(triggerMsg),
	})

	// 4) mode=subagent：尝试走真正的 OpenClaw sessions_spawn（isolated 子 session）。
	//    失败时降级到 member_agent 路径，确保派发不会因 spawn 不可用而卡死。
	//    见 docs/agentroom/REAL_SUBAGENT_SPAWN.md。
	if p.Mode == TaskExecutionModeSubagent {
		if handled := o.tryRealSubagentSpawn(ctx, p, t, m, triggerMsg); handled {
			return
		}
		// 否则继续走下面的 member_agent 同路径（fallback）。
		o.appendSystemNotice("⚠️ 真实子代理 spawn 不可用，已降级为成员代理执行。")
	}

	// 5) 取最近消息 + 执行 agent 回合（manual 不走这里；member_agent / 降级后的 subagent 走这里）
	recent, err := o.repo.ListMessagesPaged(o.roomID, 0, 30)
	if err != nil {
		o.failExecution(p.ExecutionID, fmt.Sprintf("load recent failed: %v", err))
		return
	}
	logger.Log.Info().
		Str("room", o.roomID).Str("task", p.TaskID).
		Str("execution", p.ExecutionID).Str("member", p.MemberID).
		Str("mode", p.Mode).
		Msg("agentroom: dispatching task to agent")

	if err := o.runAgentTurn(ctx, p.MemberID, recent, triggerMsg); err != nil {
		// 聊天失败 → execution failed
		o.failExecution(p.ExecutionID, fmt.Sprintf("agent run failed: %v", err))
		// 任务回退到 todo（如果还在 in_progress）
		if t2, _ := o.repo.GetTask(p.TaskID); t2 != nil && t2.Status == TaskStatusInProgress {
			_ = o.repo.UpdateTask(p.TaskID, map[string]any{"status": TaskStatusTodo})
		}
		return
	}

	// 5) 取该成员的最新 chat 消息作为执行结果
	reply := o.findLatestAgentReply(p.MemberID, triggerMsg.Seq, triggerMsg.Timestamp)
	summary := strings.TrimSpace(reply)
	if summary == "" {
		summary = "（agent 未产出文本回复）"
	}
	// 简单截断，避免超长摘要塞库（保留完整原文已在消息流中可查）
	if n := []rune(summary); len(n) > 2000 {
		summary = string(n[:2000]) + "…"
	}

	// 6) execution → completed + 同步 task → review
	completedAt := NowMs()
	_ = o.repo.UpdateTaskExecution(p.ExecutionID, map[string]any{
		"status":       TaskExecStatusCompleted,
		"summary":      summary,
		"completed_at": &completedAt,
	})
	_ = o.repo.UpdateTask(p.TaskID, map[string]any{
		"result_summary": summary,
		"status":         TaskStatusReview,
	})
	o.broker.Emit(o.roomID, EventRoomUpdate, map[string]any{
		"roomId": o.roomID, "patch": map[string]any{"tasksChanged": true},
	})
	o.appendSystemNotice(fmt.Sprintf("✅ 任务已由 @%s 完成，进入待验收状态。", m.Name))

	// 7) 主题 B：若 reviewer 也是 agent，触发自动初判
	o.tryAutoReview(ctx, p.TaskID)
}

// failExecution 把 execution 标为 failed 并广播。
func (o *Orchestrator) failExecution(executionID, reason string) {
	now := NowMs()
	_ = o.repo.UpdateTaskExecution(executionID, map[string]any{
		"status":       TaskExecStatusFailed,
		"completed_at": &now,
		"error_msg":    reason,
	})
	o.broker.Emit(o.roomID, EventRoomUpdate, map[string]any{
		"roomId": o.roomID, "patch": map[string]any{"tasksChanged": true},
	})
}

// findLatestAgentReply 取派发后该成员产出的最新 chat 消息文本。
// afterSeq / afterTs 用于"晚于派发指令"的过滤，避免取到陈旧消息。
func (o *Orchestrator) findLatestAgentReply(memberID string, afterSeq int64, afterTs int64) string {
	recent, err := o.repo.ListMessagesPaged(o.roomID, 0, 30)
	if err != nil {
		return ""
	}
	for i := len(recent) - 1; i >= 0; i-- {
		msg := recent[i]
		if msg.AuthorID != memberID || msg.Kind != MsgKindChat || msg.Deleted {
			continue
		}
		if msg.Seq <= afterSeq && msg.Timestamp <= afterTs {
			continue
		}
		return msg.Content
	}
	return ""
}

// buildDispatchPrompt 构造派发系统消息文本。
// 兼顾：
//   - 让 agent（通过房间上下文）清楚收到了一个"任务"
//   - 让人类读消息流时也能直观看到本次派发的所有要点
//   - 携带返工说明（如果是 rework 后的再次派发）
func buildDispatchPrompt(t *database.AgentRoomTask, m *database.AgentRoomMember, mode string, _ *database.AgentRoomTaskExecution) string {
	modeLabel := map[string]string{
		TaskExecutionModeMemberAgent: "成员代理",
		TaskExecutionModeSubagent:    "子代理",
	}[mode]
	if modeLabel == "" {
		modeLabel = mode
	}
	var b strings.Builder
	fmt.Fprintf(&b, "🚀 派发任务给 @%s（%s 模式）\n", m.Name, modeLabel)
	fmt.Fprintf(&b, "\n**任务内容**：%s\n", strings.TrimSpace(t.Text))
	if d := strings.TrimSpace(t.Deliverable); d != "" {
		fmt.Fprintf(&b, "\n**期望交付物**：%s\n", d)
	}
	if dod := strings.TrimSpace(t.DefinitionOfDone); dod != "" {
		fmt.Fprintf(&b, "\n**完成标准（DoD）**：\n%s\n", dod)
	}
	if t.ReworkCount > 0 && strings.TrimSpace(t.AcceptanceNote) != "" {
		fmt.Fprintf(&b, "\n**上一次返工说明（第 %d 轮返工）**：\n%s\n", t.ReworkCount, t.AcceptanceNote)
	}
	b.WriteString("\n请直接给出处理思路 + 最终结果（一条消息内说清）。" +
		"完成后系统会自动把你这条消息作为执行结果交给验收人。")
	return b.String()
}

// tryAutoReview —— 主题 B (B2)：reviewer 是 agent 时，自动触发一次初判。
//
// 触发条件：
//   - task.status = review
//   - task.reviewerId 非空且对应成员存在
//   - reviewer 是 agent kind
//   - task 没已经 accepted（避免重入）
//
// 行为：
//   - 让 reviewer agent 在自己的 session 里用一个结构化 prompt 对照 DoD 给出判定
//   - 解析回复中的 <verdict> 标签：accepted | rework
//   - 自动调用 acceptTaskInternal 写入 acceptance（带 source=auto）
//   - 失败 / 解析不出标签 → 静默退出，留给人类处理（不会卡住流程）
func (o *Orchestrator) tryAutoReview(ctx context.Context, taskID string) {
	t, err := o.repo.GetTask(taskID)
	if err != nil || t == nil {
		return
	}
	if t.Status != TaskStatusReview {
		return
	}
	if t.AcceptanceStatus == AcceptanceStatusAccepted {
		return
	}
	if strings.TrimSpace(t.ReviewerID) == "" {
		return
	}
	reviewer := o.findMember(t.ReviewerID)
	if reviewer == nil || reviewer.Kind != "agent" || reviewer.IsKicked || reviewer.IsMuted {
		return
	}
	// 构造验收 prompt
	prompt := buildAutoReviewPrompt(t)
	if o.bridge == nil || !o.bridge.IsAvailable() {
		return
	}
	sessionKey := strings.TrimSpace(reviewer.SessionKey)
	if sessionKey == "" {
		sessionKey = SessionKeyFor(reviewer.AgentID, o.roomID, reviewer.ID)
	}
	// 用一个独立、轻量的 RunAgent 调用——不污染房间消息流（不写入消息）。
	// extraSystemPrompt 注入会议背景；message 是验收指令；OpenClaw 内部会处理 session 上下文。
	runCtx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	res, err := o.bridge.RunAgent(runCtx, RunRequest{
		SessionKey:        sessionKey,
		Message:           prompt,
		Model:             reviewer.Model,
		Thinking:          reviewer.Thinking,
		ExtraSystemPrompt: "你是任务验收人，本次只输出结构化验收结论，不闲聊。",
		TimeoutSeconds:    90,
	}, nil)
	if err != nil || res == nil {
		logger.Log.Debug().Err(err).Str("task", taskID).Msg("agentroom: auto review failed")
		return
	}
	verdict, summary, passed, failed := parseAutoVerdict(res.Text)
	if verdict == "" {
		logger.Log.Debug().Str("task", taskID).Msg("agentroom: auto review verdict not parseable")
		return
	}
	o.applyAutoReview(t, verdict, summary, passed, failed)
}

// applyAutoReview 把 agent 自动初判写入 task acceptance，复用 G3 的状态机。
func (o *Orchestrator) applyAutoReview(t *database.AgentRoomTask, verdict, summary string, passed, failed []string) {
	now := NowMs()
	patch := map[string]any{
		"acceptance_status": verdict,
		"acceptance_note":   "（agent 自动初判）" + strings.TrimSpace(summary),
		"passed_criteria":   JoinLines(passed),
		"failed_criteria":   JoinLines(failed),
		"reviewed_at":       &now,
	}
	switch verdict {
	case AcceptanceStatusAccepted:
		patch["status"] = TaskStatusDone
		patch["completed_at"] = &now
	case AcceptanceStatusRework:
		newCount := t.ReworkCount + 1
		patch["rework_count"] = newCount
		if newCount >= DefaultReworkLimit {
			patch["acceptance_status"] = AcceptanceStatusNeedsHuman
			patch["status"] = TaskStatusReview
		} else {
			patch["status"] = TaskStatusInProgress
		}
	default:
		// 未识别结论 → 不动
		return
	}
	if err := o.repo.UpdateTask(t.ID, patch); err != nil {
		return
	}
	o.broker.Emit(o.roomID, EventRoomUpdate, map[string]any{
		"roomId": o.roomID, "patch": map[string]any{"tasksChanged": true},
	})
	verdictLabel := map[string]string{
		AcceptanceStatusAccepted:   "✅ 通过",
		AcceptanceStatusRework:     "🔄 返工",
		AcceptanceStatusNeedsHuman: "⚠️ 上升人工",
	}[verdict]
	o.appendSystemNotice(fmt.Sprintf("🤖 自动验收：%s（%s）", verdictLabel, strings.TrimSpace(summary)))

	// v1.0+：accepted → 自动推进依赖链（下游任务 dependsOn 全部 done 则自动 dispatch）
	if verdict == AcceptanceStatusAccepted {
		o.TryDispatchDependents(t.ID)
	}
}

// TryDispatchDependents —— 任务 done 后，扫描同房间内依赖该任务的下游任务。
// 如果下游任务的所有 dependsOn 都已 done + 有 assignee + 状态为 todo，则自动创建 execution
// 并派发给 agent。这实现了依赖链的自动推进，无需用户手动触发。
//
// 调用时机：
//   - applyAutoReview 中 verdict=accepted 后
//   - handler AcceptTask 中 status=accepted 后
func (o *Orchestrator) TryDispatchDependents(doneTaskID string) {
	if o == nil || o.repo == nil || doneTaskID == "" {
		return
	}
	allTasks, err := o.repo.ListTasks(o.roomID)
	if err != nil {
		return
	}
	for _, candidate := range allTasks {
		if candidate.Status != TaskStatusTodo {
			continue
		}
		deps := decodeStringSlice(candidate.DependsOnJSON)
		if len(deps) == 0 {
			continue
		}
		// 检查该 candidate 的 dependsOn 是否包含刚完成的 task
		dependsOnDone := false
		for _, d := range deps {
			if d == doneTaskID {
				dependsOnDone = true
				break
			}
		}
		if !dependsOnDone {
			continue
		}
		// 检查所有 dependsOn 是否都已 done
		allDone := true
		for _, d := range deps {
			dt, _ := o.repo.GetTask(d)
			if dt == nil || dt.Status != TaskStatusDone {
				allDone = false
				break
			}
		}
		if !allDone || strings.TrimSpace(candidate.AssigneeID) == "" {
			continue
		}
		// 自动派发
		mode := TaskExecutionModeMemberAgent
		if opts := o.getOpts(); opts != nil && strings.TrimSpace(opts.DefaultDispatchMode) != "" {
			mode = opts.DefaultDispatchMode
		}
		now := NowMs()
		exe := &database.AgentRoomTaskExecution{
			TaskID:           candidate.ID,
			RoomID:           o.roomID,
			ExecutorMemberID: candidate.AssigneeID,
			Mode:             mode,
			Status:           TaskExecStatusQueued,
			StartedAt:        &now,
		}
		if err := o.repo.CreateTaskExecution(exe); err != nil {
			continue
		}
		_ = o.repo.UpdateTask(candidate.ID, map[string]any{"status": TaskStatusInProgress})
		o.broker.Emit(o.roomID, EventRoomUpdate, map[string]any{
			"roomId": o.roomID, "patch": map[string]any{"tasksChanged": true},
		})
		o.appendSystemNotice(fmt.Sprintf("⏩ 前置任务已完成，自动派发「%s」给 @%s",
			truncateText(candidate.Text, 40), o.memberName(candidate.AssigneeID)))
		o.DispatchTaskAsAgent(candidate.ID, exe.ID, candidate.AssigneeID, mode)
	}
}

// memberName 取成员名。
func (o *Orchestrator) memberName(id string) string {
	m := o.findMember(id)
	if m != nil {
		return m.Name
	}
	return id
}

// truncateText 截取文本前 n 个 rune。
func truncateText(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

// cancelPendingTasks —— Closeout 时，把所有未完成（todo/doing/assigned/in_progress/review）
// 的任务批量设为 cancelled，同时取消对应的活跃 execution。
// 已完成（done）和已取消（cancelled/blocked）的不动。
func (o *Orchestrator) cancelPendingTasks() {
	tasks, err := o.repo.ListTasks(o.roomID)
	if err != nil {
		return
	}
	now := NowMs()
	count := 0
	for _, t := range tasks {
		switch t.Status {
		case TaskStatusTodo, TaskStatusDoing, TaskStatusAssigned, TaskStatusInProgress, TaskStatusReview:
			// 取消活跃 execution
			if exe, _ := o.repo.FindActiveTaskExecution(t.ID); exe != nil {
				_ = o.repo.UpdateTaskExecution(exe.ID, map[string]any{
					"status":       TaskExecStatusCanceled,
					"completed_at": &now,
					"error_msg":    "会议关闭，自动取消",
				})
			}
			_ = o.repo.UpdateTask(t.ID, map[string]any{
				"status":          TaskStatusCancelled,
				"acceptance_note": "会议关闭时自动取消",
			})
			count++
		}
	}
	if count > 0 {
		o.broker.Emit(o.roomID, EventRoomUpdate, map[string]any{
			"roomId": o.roomID, "patch": map[string]any{"tasksChanged": true},
		})
		o.appendSystemNotice(fmt.Sprintf("📋 会议关闭，%d 项未完成任务已自动取消。", count))
	}
}

// buildAutoReviewPrompt 构造让 agent reviewer 给出结构化结论的 prompt。
//
// 输出契约：要求 agent 严格输出：
//
//	<verdict>accepted|rework</verdict>
//	<summary>一句话总结</summary>
//	<passed>每行一项，已达标 DoD</passed>
//	<failed>每行一项，未达标 DoD（rework 时必填）</failed>
//
// 解析失败时静默退出，让人类来。
func buildAutoReviewPrompt(t *database.AgentRoomTask) string {
	var b strings.Builder
	b.WriteString("请对以下任务的执行结果做验收。严格按格式输出：\n\n")
	b.WriteString("<verdict>accepted 或 rework</verdict>\n")
	b.WriteString("<summary>一句话验收总结</summary>\n")
	b.WriteString("<passed>每行一项已达标 DoD（rework 时也写明确认达标的项）</passed>\n")
	b.WriteString("<failed>每行一项未达标 DoD（rework 时必填）</failed>\n\n")
	b.WriteString("=== 任务 ===\n")
	b.WriteString(strings.TrimSpace(t.Text))
	if d := strings.TrimSpace(t.Deliverable); d != "" {
		b.WriteString("\n\n期望交付物：")
		b.WriteString(d)
	}
	if dod := strings.TrimSpace(t.DefinitionOfDone); dod != "" {
		b.WriteString("\n\n完成标准（DoD）：\n")
		b.WriteString(dod)
	}
	b.WriteString("\n\n=== 执行结果 ===\n")
	if r := strings.TrimSpace(t.ResultSummary); r != "" {
		b.WriteString(r)
	} else {
		b.WriteString("（执行人未提交摘要）")
	}
	return b.String()
}

// parseAutoVerdict 从 agent 回复里提取 4 个字段。
func parseAutoVerdict(text string) (verdict, summary string, passed, failed []string) {
	verdict = strings.ToLower(extractTagContent(text, "verdict"))
	if verdict != AcceptanceStatusAccepted && verdict != AcceptanceStatusRework {
		return "", "", nil, nil
	}
	summary = extractTagContent(text, "summary")
	passed = splitNonEmptyLines(extractTagContent(text, "passed"))
	failed = splitNonEmptyLines(extractTagContent(text, "failed"))
	return
}

// extractTagContent 简单 <tag>...</tag> 抽取（取首个匹配，不区分大小写）。
func extractTagContent(text, tag string) string {
	openTag := "<" + tag + ">"
	closeTag := "</" + tag + ">"
	lower := strings.ToLower(text)
	start := strings.Index(lower, openTag)
	if start < 0 {
		return ""
	}
	start += len(openTag)
	end := strings.Index(lower[start:], closeTag)
	if end < 0 {
		return strings.TrimSpace(text[start:])
	}
	return strings.TrimSpace(text[start : start+end])
}

// 占位：让 errors 包不被未使用警告（buildAutoReviewPrompt 之外的路径暂时未直接用 errors，
// 但保留 import 让未来扩展时不再频繁改头部）。
var _ = errors.New
