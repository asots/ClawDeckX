package agentroom

// planning.go ——
//   planned policy 的三阶段执行流水线：discussion → executing → review → discussion。
//
//   discussion：房间像 free 一样自由讨论，但附带 discussion-first 启发（未 @ 时争取 ≥2
//       条回复，避免单 agent 独占）。任何人手动安排 executionQueue 并点 StartExecution
//       才进入 executing。
//   executing：按 queue 顺序，一次只一位 owner 自动发言；其输出若以 @下一人 结束
//       → 切换到下一位 owner；若 @ 的不是队列下一位则尊重 @，把队列指针前推到最近匹配；
//       owner 说完整个队列 → 自动进入 review。
//   review：暂停自动回合。人类可 /continue-discussion 回到 discussion，或再次排
//       序队列发起新一轮 executing。

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"

	"ClawDeckX/internal/database"
	"ClawDeckX/internal/logger"
)

// parseExecutionQueue 把 AgentRoom.ExecutionQueueJSON 反序列化。失败/空返回空切片。
func parseExecutionQueue(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" || raw == "null" {
		return nil
	}
	var arr []string
	if err := json.Unmarshal([]byte(raw), &arr); err != nil {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, s := range arr {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

// handoffNameRegex 抓取消息结尾的 @Name 引用。
// 允许 @ 后是中英文数字 _ - 的连续序列（宽松匹配；真正的成员匹配按 name/id 逐一比对）。
var handoffNameRegex = regexp.MustCompile(`@([\p{L}\p{N}_\-]+)`)

// detectHandoff 从 owner 发言 full 中找出被 @ 的下一个 owner 候选。
// 只返回队列里尚未执行的成员 ID；优先匹配 ownerIdx 之后的项，其次全队列任意匹配。
func detectHandoff(full string, queue []string, currentIdx int, members []database.AgentRoomMember) string {
	matches := handoffNameRegex.FindAllStringSubmatch(full, -1)
	if len(matches) == 0 {
		return ""
	}
	// 构建 name/id → memberID
	byName := map[string]string{}
	for _, m := range members {
		if m.IsKicked {
			continue
		}
		byName[strings.ToLower(m.Name)] = m.ID
		byName[strings.ToLower(m.ID)] = m.ID
	}
	mentioned := make([]string, 0, len(matches))
	for _, mm := range matches {
		if len(mm) < 2 {
			continue
		}
		key := strings.ToLower(strings.TrimSpace(mm[1]))
		if id, ok := byName[key]; ok {
			mentioned = append(mentioned, id)
		}
	}
	if len(mentioned) == 0 {
		return ""
	}
	// 优先：队列里在 currentIdx 之后的第一个被 @ 成员
	if currentIdx+1 < len(queue) {
		for i := currentIdx + 1; i < len(queue); i++ {
			for _, mid := range mentioned {
				if queue[i] == mid {
					return queue[i]
				}
			}
		}
	}
	// 退化：队列里任一被 @ 成员（即使索引在当前位之前，也可以视作"返工"）
	for _, qid := range queue {
		for _, mid := range mentioned {
			if qid == mid {
				return qid
			}
		}
	}
	// 再退化：队列外但被 @ 到的成员 — 视为临时插入
	return mentioned[0]
}

// emitPlanningUpdate 广播 planning 状态。
func (o *Orchestrator) emitPlanningUpdate() {
	if o.room == nil {
		return
	}
	queue := parseExecutionQueue(o.room.ExecutionQueueJSON)
	o.broker.Emit(o.roomID, EventPlanning, map[string]any{
		"roomId":            o.roomID,
		"phase":             o.room.ExecutionPhase,
		"queue":             queue,
		"executionOwnerIdx": o.room.ExecutionOwnerIdx,
	})
}

// savePlanningUpdate 持久化 + 广播（原子更新 3 个字段）。
func (o *Orchestrator) savePlanningUpdate(phase string, queue []string, ownerIdx int) error {
	queueJSON, _ := json.Marshal(queue)
	patch := map[string]any{
		"execution_phase":      phase,
		"execution_queue_json": string(queueJSON),
		"execution_owner_idx":  ownerIdx,
	}
	if err := o.repo.UpdateRoom(o.roomID, patch); err != nil {
		return err
	}
	o.mu.Lock()
	if o.room != nil {
		o.room.ExecutionPhase = phase
		o.room.ExecutionQueueJSON = string(queueJSON)
		o.room.ExecutionOwnerIdx = ownerIdx
	}
	o.mu.Unlock()
	o.emitPlanningUpdate()
	return nil
}

// ── 命令入口（被 Orchestrator.handle 路由到）──

// onSetExecutionQueue 设置队列，但不触发执行。仅在 planned 策略下有效。
func (o *Orchestrator) onSetExecutionQueue(queue []string) {
	if o.room == nil || o.room.Policy != PolicyPlanned {
		return
	}
	// 过滤：仅保留 live agent 成员（存在、未踢、未禁）
	live := map[string]bool{}
	for _, m := range o.members {
		if m.Kind == "agent" && !m.IsKicked {
			live[m.ID] = true
		}
	}
	clean := make([]string, 0, len(queue))
	seen := map[string]bool{}
	for _, id := range queue {
		if !live[id] || seen[id] {
			continue
		}
		seen[id] = true
		clean = append(clean, id)
	}
	// 保存时不改变 phase（保持在 discussion 或 review）；ownerIdx 重置为 0。
	phase := o.room.ExecutionPhase
	if phase == "" {
		phase = PhaseDiscussion
	}
	_ = o.savePlanningUpdate(phase, clean, 0)
	logger.Log.Info().Str("room", o.roomID).Int("len", len(clean)).Msg("agentroom: execution queue set")
}

// onStartExecution 把 phase 切到 executing 并触发队首 agent 发言。
// 若队列为空或已不在 planned 策略，则静默忽略。
func (o *Orchestrator) onStartExecution(ctx context.Context) {
	if o.room == nil || o.room.Policy != PolicyPlanned {
		return
	}
	queue := parseExecutionQueue(o.room.ExecutionQueueJSON)
	if len(queue) == 0 {
		logger.Log.Warn().Str("room", o.roomID).Msg("agentroom: start execution with empty queue, ignored")
		return
	}
	if err := o.savePlanningUpdate(PhaseExecuting, queue, 0); err != nil {
		return
	}
	recent, _ := o.repo.ListMessages(o.roomID, 0, 40)
	// 首位 owner 发言。后续 handoff 由 runAgentTurn 末尾触发 maybeAdvancePlannedQueue。
	_ = o.runAgentTurn(ctx, queue[0], recent, nil)
	// runAgentTurn 成功后 triggerPostTurn 会根据 @handoff 结果把 ownerIdx 推进
	// 并再次调用 runAgentTurn。若 agent 没 @ 任何人 → 默认顺序推进。
}

// onContinueDiscussion 从 review 回到 discussion 阶段。清空 queue。
func (o *Orchestrator) onContinueDiscussion() {
	if o.room == nil || o.room.Policy != PolicyPlanned {
		return
	}
	_ = o.savePlanningUpdate(PhaseDiscussion, nil, 0)
	logger.Log.Info().Str("room", o.roomID).Msg("agentroom: planned → discussion")
}

// maybeAdvancePlannedQueue 在 executing 阶段每轮结束后调用：
//   1. 解析最后一条 agent 消息的 @handoff；
//   2. 若有，切到被 @ 的成员；
//   3. 否则顺序推进 ownerIdx；
//   4. 所有 owner 执行完 → phase=review，暂停；
// 返回下一个 owner ID（空表示应进入 review 或已结束）。
func (o *Orchestrator) maybeAdvancePlannedQueue(lastMsg *database.AgentRoomMessage) string {
	if o.room == nil || o.room.Policy != PolicyPlanned || o.room.ExecutionPhase != PhaseExecuting {
		return ""
	}
	queue := parseExecutionQueue(o.room.ExecutionQueueJSON)
	if len(queue) == 0 {
		return ""
	}
	curIdx := o.room.ExecutionOwnerIdx
	var nextID string
	if lastMsg != nil {
		nextID = detectHandoff(lastMsg.Content, queue, curIdx, o.members)
	}
	nextIdx := curIdx + 1
	if nextID != "" {
		// 找到 nextID 在 queue 里的位置（若在）
		for i, id := range queue {
			if id == nextID {
				nextIdx = i
				break
			}
		}
	} else if nextIdx < len(queue) {
		nextID = queue[nextIdx]
	}
	if nextID == "" || nextIdx >= len(queue) {
		// 全部完成 → review
		_ = o.savePlanningUpdate(PhaseReview, queue, len(queue))
		return ""
	}
	// 持久化新 ownerIdx
	_ = o.savePlanningUpdate(PhaseExecuting, queue, nextIdx)
	return nextID
}
