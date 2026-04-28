// room_scheduler.go —— v1.0 定时会议调度器。
//
// 后台 goroutine 每 30s 检查 agentroom_schedules 表，对到期的定时任务：
//  1. 基于模板自动创建房间（复用 templates.go + Manager.Get）
//  2. 注入 InitialPrompt 启动讨论
//  3. RoundBudget 耗尽后由 orchestrator 的 deadlineAction 自动闭环
//  4. InheritFromLast=true 时，从上次房间 Retro.NextMeetingDraft 继承议程
//
// 调度表达式支持两种格式：
//   - 简单日频："09:00"（每天该时间执行一次）
//   - 标准 cron 5-field："30 9 * * 1-5"（分 时 日 月 周）
//
// 设计参考 snapshots/scheduler.go 的 ticker + runIfNeeded 模式。
package agentroom

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"ClawDeckX/internal/database"
	"ClawDeckX/internal/logger"
)

// BlueprintReplayFn 在 schedule 携带 blueprint 时由调度器回调，由 handlers 层注入实现。
// blueprintJSON 是已存的 createRoomRequest 的 JSON 字节，由 handlers.buildRoomFromRequest 解析并落库。
type BlueprintReplayFn func(ctx context.Context, ownerUserID uint, blueprintJSON []byte) (roomID string, err error)

// RoomScheduler 定时会议调度器，由 serve.go 在启动时创建和 Start。
type RoomScheduler struct {
	repo            *Repo
	manager         *Manager
	broker          *Broker
	blueprintReplay BlueprintReplayFn
}

func NewRoomScheduler(repo *Repo, manager *Manager, broker *Broker) *RoomScheduler {
	return &RoomScheduler{repo: repo, manager: manager, broker: broker}
}

// SetBlueprintReplay 注入 blueprint 重放回调（由 serve.go 在 handler 初始化后调用）。
func (s *RoomScheduler) SetBlueprintReplay(fn BlueprintReplayFn) {
	s.blueprintReplay = fn
}

// Start 在后台循环检查到期的定时会议并触发创建。阻塞直到 ctx 取消。
func (s *RoomScheduler) Start(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	// 启动时先跑一次，确保重启后立即补跑到期任务
	s.tick()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.tick()
		}
	}
}

func (s *RoomScheduler) tick() {
	now := time.Now()
	schedules, err := s.repo.ListDueSchedules(now)
	if err != nil {
		logger.Log.Warn().Err(err).Msg("room_scheduler: list due schedules failed")
		return
	}
	for i := range schedules {
		s.runSchedule(&schedules[i])
	}
}

// RunNow 手动立即触发一次指定的定时会议。返回创建出的房间 ID 与错误。
func (s *RoomScheduler) RunNow(id string) (string, error) {
	sched, err := s.repo.GetSchedule(id)
	if err != nil || sched == nil {
		return "", fmt.Errorf("schedule not found")
	}
	return s.runSchedule(sched)
}

// runSchedule 同步执行一次定时任务。返回创建的 roomID（或 ""）与错误。
//
// 状态流转策略（消除竞态窗口）：
//  1. 先标记 running 并清空旧的 next_run_at（防止 30s tick 在执行期间重复 due）
//  2. 创建房间
//  3. 一次性合并写入 last_status / last_room_id / last_error / run_count / next_run_at
func (s *RoomScheduler) runSchedule(sched *database.AgentRoomSchedule) (string, error) {
	now := time.Now()
	// 步骤 1：先把 next_run_at 拨远（=now+1h），并标记 running，避免本轮执行期间再次 due。
	guard := now.Add(1 * time.Hour)
	_ = s.repo.UpdateSchedule(sched.ID, map[string]any{
		"last_status": "running",
		"last_run_at": &now,
		"next_run_at": &guard,
	})

	roomID, err := s.createRoomFromSchedule(sched)

	// 步骤 3：合并写入终态。
	patch := map[string]any{}
	if err != nil {
		errMsg := err.Error()
		if len(errMsg) > 500 {
			errMsg = errMsg[:500]
		}
		patch["last_status"] = "error"
		patch["last_error"] = errMsg
		logger.Log.Error().Err(err).Str("schedule", sched.ID).Msg("room_scheduler: create room failed")
	} else {
		patch["last_status"] = "ok"
		patch["last_room_id"] = roomID
		patch["last_error"] = ""
		patch["run_count"] = sched.RunCount + 1
	}
	// 计算真实的下次运行时间。无论本轮成功失败，都要前推。
	if next := calcNextRun(sched.CronExpr, sched.Timezone, now); next != nil {
		patch["next_run_at"] = next
	} else {
		// cron 非法 → 关闭调度，避免无限重试。
		patch["next_run_at"] = nil
		patch["enabled"] = false
		if _, ok := patch["last_error"]; !ok {
			patch["last_error"] = "invalid cron expression"
			patch["last_status"] = "error"
		}
	}
	_ = s.repo.UpdateSchedule(sched.ID, patch)
	return roomID, err
}

func (s *RoomScheduler) createRoomFromSchedule(sched *database.AgentRoomSchedule) (string, error) {
	tplID := strings.TrimSpace(sched.TemplateID)

	// 路径 A：blueprint 重放（custom / AI 建会的定时会议）。
	if tplID == "" {
		bp := strings.TrimSpace(sched.BlueprintJSON)
		if bp == "" {
			return "", fmt.Errorf("schedule has neither templateId nor blueprint")
		}
		if s.blueprintReplay == nil {
			return "", fmt.Errorf("blueprint replay not wired up")
		}
		ctx := context.Background()
		roomID, err := s.blueprintReplay(ctx, sched.OwnerUserID, []byte(bp))
		if err != nil {
			return "", fmt.Errorf("blueprint replay: %w", err)
		}
		// 续会上下文继承（与模板路径保持一致）。
		if sched.InheritFromLast && strings.TrimSpace(sched.LastRoomID) != "" {
			youID := roomID + "_you"
			s.inheritFromLastRoom(roomID, youID, sched.LastRoomID)
		}
		return roomID, nil
	}

	// 路径 B：模板路径（保持原有逻辑）。
	tpl := FindTemplate(tplID)
	if tpl == nil {
		return "", fmt.Errorf("template %q not found", tplID)
	}

	// 构建标题（含日期）—— 日期采用 schedule 自身时区，避免服务器时区漂移。
	title := strings.TrimSpace(sched.Title)
	if title == "" {
		title = tpl.Name
	}
	title = title + " · " + time.Now().In(loadTZ(sched.Timezone)).Format("01/02")

	// 构建 PolicyOptions
	var policyOpts PolicyOptions
	if strings.TrimSpace(sched.PolicyOptsJSON) != "" {
		_ = json.Unmarshal([]byte(sched.PolicyOptsJSON), &policyOpts)
	}
	if tpl.PresetID != "" {
		ApplyPreset(&policyOpts, tpl.PresetID)
	}
	if v := strings.TrimSpace(tpl.DefaultDispatchMode); v != "" {
		policyOpts.DefaultDispatchMode = v
	}
	// deadline action 覆盖：定时会议默认 closeout
	da := strings.TrimSpace(sched.DeadlineAction)
	if da == "" {
		da = "closeout"
	}
	policyOpts.DeadlineAction = da

	optsJSON, _ := json.Marshal(policyOpts)

	// 预算
	budget := sched.BudgetCNY
	if budget <= 0 {
		budget = tpl.BudgetCNY
	}
	budgetJSON, _ := json.Marshal(RoomBudget{LimitCNY: budget})

	roundBudget := sched.RoundBudget
	if roundBudget <= 0 {
		roundBudget = 12
	}

	// 创建房间
	roomID := GenID("room")
	roomModel := &database.AgentRoom{
		ID:          roomID,
		OwnerUserID: sched.OwnerUserID,
		Title:       title,
		TemplateID:  tplID,
		State:       StateActive,
		Policy:      tpl.DefaultPolicy,
		BudgetJSON:  string(budgetJSON),
		PolicyOpts:  string(optsJSON),
		RoundBudget: roundBudget,
		Whiteboard:  tpl.InitialWhiteboard,
		Goal:        strings.TrimSpace(sched.InitialPrompt),
	}
	if err := s.repo.CreateRoom(roomModel); err != nil {
		return "", fmt.Errorf("create room: %w", err)
	}

	// 创建成员
	var entries []schedMemberEntry
	for i, m := range tpl.Members {
		mid := roomID + "_m" + strconv.Itoa(i)
		dm := &database.AgentRoomMember{
			ID:           mid,
			RoomID:       roomID,
			Kind:         "agent",
			Name:         m.Role,
			Role:         m.Role,
			Emoji:        m.Emoji,
			SystemPrompt: m.SystemPrompt,
			Status:       MemberStatusIdle,
			IsModerator:  m.IsModerator,
			AgentID:      m.AgentID,
			Thinking:     m.Thinking,
		}
		if err := s.repo.CreateMember(dm); err != nil {
			continue
		}
		if m.IsModerator && roomModel.ModeratorID == "" {
			roomModel.ModeratorID = mid
			_ = s.repo.UpdateRoom(roomID, map[string]any{"moderator_id": mid})
		}
		// 预建 session
		if s.manager.bridge != nil && s.manager.bridge.IsAvailable() {
			sessionKey := SessionKeyFor(m.AgentID, roomID, mid)
			_ = s.manager.bridge.EnsureSession(context.Background(), EnsureSessionParams{
				Key:          sessionKey,
				AgentID:      m.AgentID,
				Model:        m.Model,
				Thinking:     m.Thinking,
				Label:        fmt.Sprintf("AgentRoom · %s · %s", title, m.Role),
				SystemPrompt: m.SystemPrompt,
			})
		}
		entries = append(entries, schedMemberEntry{memberID: mid, member: m})
	}
	// You member
	youID := roomID + "_you"
	_ = s.repo.CreateMember(&database.AgentRoomMember{
		ID: youID, RoomID: roomID, Kind: "human", Name: "You", Role: "Owner", Emoji: "🧑", Status: MemberStatusIdle,
	})

	// 事实
	for k, v := range tpl.InitialFacts {
		_ = s.repo.UpsertFact(&database.AgentRoomFact{RoomID: roomID, Key: k, Value: v, AuthorID: "system"})
	}

	// 继承上次会议上下文
	if sched.InheritFromLast && strings.TrimSpace(sched.LastRoomID) != "" {
		s.inheritFromLastRoom(roomID, youID, sched.LastRoomID)
	}

	// 种子化初始任务 + 自动派发（复用 Manager 内的 orchestrator）
	orch := s.manager.Get(roomID)

	if len(tpl.InitialTasks) > 0 {
		// 构建 resolvedMemberSpec 等价物用于 task seeding
		// 这里直接在 orchestrator 层发系统消息通知任务已就绪
		s.seedAndDispatchTasks(roomID, youID, tpl, entries, orch, policyOpts.DefaultDispatchMode)
	}

	// 注入初始 prompt
	prompt := strings.TrimSpace(sched.InitialPrompt)
	if prompt == "" {
		prompt = fmt.Sprintf("这是「%s」的定时会议。请开始讨论。", strings.TrimSpace(sched.Title))
	}
	orch.PostUserMessage(youID, prompt, nil, nil, "", "", "", nil)

	logger.Log.Info().Str("schedule", sched.ID).Str("room", roomID).Msg("room_scheduler: room created successfully")
	return roomID, nil
}

type schedMemberEntry struct {
	memberID string
	member   TemplateMember
}

func (s *RoomScheduler) seedAndDispatchTasks(
	roomID string,
	creatorID string,
	tpl *Template,
	entries []schedMemberEntry,
	orch *Orchestrator,
	defaultDispatchMode string,
) {
	if len(tpl.InitialTasks) == 0 {
		return
	}

	// 构建 roleId → memberId 映射
	roleToMemberID := make(map[string]string)
	defaultReviewerID := ""
	for _, e := range entries {
		key := strings.TrimSpace(e.member.RoleID)
		if key == "" {
			continue
		}
		roleToMemberID[key] = e.memberID
		if e.member.IsDefaultReviewer && defaultReviewerID == "" {
			defaultReviewerID = e.memberID
		}
	}

	type seeded struct {
		id         string
		assigneeID string
		hasDeps    bool
	}
	var results []seeded
	createdIDs := make([]string, 0, len(tpl.InitialTasks))

	for _, tt := range tpl.InitialTasks {
		text := strings.TrimSpace(tt.Text)
		if text == "" {
			createdIDs = append(createdIDs, "")
			continue
		}
		t := &database.AgentRoomTask{
			RoomID:           roomID,
			Text:             text,
			CreatorID:        creatorID,
			Status:           TaskStatusTodo,
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
		// dependsOn
		if len(tt.DependsOnIndices) > 0 {
			deps := make([]string, 0, len(tt.DependsOnIndices))
			for _, di := range tt.DependsOnIndices {
				if di >= 0 && di < len(createdIDs) {
					if id := createdIDs[di]; id != "" {
						deps = append(deps, id)
					}
				}
			}
			if len(deps) > 0 {
				if b, err := json.Marshal(deps); err == nil {
					t.DependsOnJSON = string(b)
				}
			}
		}
		if err := s.repo.CreateTask(t); err != nil {
			createdIDs = append(createdIDs, "")
			continue
		}
		createdIDs = append(createdIDs, t.ID)
		hasDeps := strings.TrimSpace(t.DependsOnJSON) != "" && t.DependsOnJSON != "[]"
		results = append(results, seeded{id: t.ID, assigneeID: t.AssigneeID, hasDeps: hasDeps})
	}

	// 自动派发无依赖任务
	if orch == nil || len(results) == 0 {
		return
	}
	mode := strings.TrimSpace(defaultDispatchMode)
	if mode == "" {
		mode = TaskExecutionModeMemberAgent
	}
	for _, st := range results {
		if st.id == "" || st.assigneeID == "" || st.hasDeps {
			continue
		}
		now := NowMs()
		exe := &database.AgentRoomTaskExecution{
			TaskID:           st.id,
			RoomID:           roomID,
			ExecutorMemberID: st.assigneeID,
			Mode:             mode,
			Status:           TaskExecStatusQueued,
			StartedAt:        &now,
		}
		if err := s.repo.CreateTaskExecution(exe); err != nil {
			continue
		}
		_ = s.repo.UpdateTask(st.id, map[string]any{"status": TaskStatusInProgress})
		orch.DispatchTaskAsAgent(st.id, exe.ID, st.assigneeID, mode)
	}
}

func (s *RoomScheduler) inheritFromLastRoom(newRoomID, youID, lastRoomID string) {
	retro, err := s.repo.GetRetro(lastRoomID)
	if err != nil || retro == nil {
		return
	}
	r := RetroFromModel(retro)
	if r.NextMeetingDraft == nil {
		return
	}
	draft := r.NextMeetingDraft

	// 注入继承上下文作为白板
	var sb strings.Builder
	sb.WriteString("## 续自上次会议\n\n")
	if draft.Goal != "" {
		sb.WriteString("**目标**: " + draft.Goal + "\n\n")
	}
	if len(draft.AgendaItems) > 0 {
		sb.WriteString("**议程**:\n")
		for _, a := range draft.AgendaItems {
			sb.WriteString("- " + a + "\n")
		}
		sb.WriteString("\n")
	}
	// 继承未完成任务
	if len(draft.UnfinishedTaskIDs) > 0 {
		sb.WriteString("**上次未完成任务**:\n")
		for _, tid := range draft.UnfinishedTaskIDs {
			t, _ := s.repo.GetTask(tid)
			if t != nil {
				sb.WriteString("- " + t.Text + "\n")
			}
		}
		sb.WriteString("\n")
	}

	if sb.Len() > 0 {
		existing, _ := s.repo.GetRoom(newRoomID)
		if existing != nil {
			wb := strings.TrimSpace(existing.Whiteboard)
			if wb != "" {
				wb += "\n\n"
			}
			wb += sb.String()
			_ = s.repo.UpdateRoom(newRoomID, map[string]any{"whiteboard": wb})
		}
	}
}

// ── Cron 解析 ──

// calcNextRun 计算下一次运行时间。
// 支持两种格式：
//   - "HH:MM" → 每天该时刻
//   - "M H D Mon DOW"（标准 5-field cron）→ 简化匹配（仅支持 * 和数字/范围）
func calcNextRun(expr, tz string, after time.Time) *time.Time {
	loc := loadTZ(tz)
	now := after.In(loc)

	expr = strings.TrimSpace(expr)
	// 简单 daily 格式 "HH:MM"
	if len(expr) == 5 && expr[2] == ':' {
		h, m, ok := parseHHMM(expr)
		if !ok {
			return nil
		}
		next := time.Date(now.Year(), now.Month(), now.Day(), h, m, 0, 0, loc)
		if !next.After(now) {
			next = next.AddDate(0, 0, 1)
		}
		return &next
	}

	// 5-field cron
	next := nextCron5(expr, now)
	return next
}

func parseHHMM(s string) (int, int, bool) {
	parts := strings.SplitN(s, ":", 2)
	if len(parts) != 2 {
		return 0, 0, false
	}
	h, err1 := strconv.Atoi(parts[0])
	m, err2 := strconv.Atoi(parts[1])
	if err1 != nil || err2 != nil || h < 0 || h > 23 || m < 0 || m > 59 {
		return 0, 0, false
	}
	return h, m, true
}

func loadTZ(tz string) *time.Location {
	if tz == "" {
		tz = "Asia/Shanghai"
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		return time.FixedZone("CST", 8*3600)
	}
	return loc
}

// nextCron5 —— 极简 5-field cron 解析器。
// 支持 *, 单数字, 逗号列表, 范围 (1-5), step (*/5)。
// 向前搜索最多 366 天。
//
// DOM × DOW 语义遵循 POSIX cron：
//   - 都为 * → 任意天
//   - 仅一方为 * → 仅看另一方
//   - 都不为 * → 任一匹配即可（OR）
func nextCron5(expr string, after time.Time) *time.Time {
	fields := strings.Fields(expr)
	if len(fields) != 5 {
		return nil
	}
	minutes := parseCronField(fields[0], 0, 59)
	hours := parseCronField(fields[1], 0, 23)
	doms := parseCronField(fields[2], 1, 31)
	months := parseCronField(fields[3], 1, 12)
	dows := parseCronField(fields[4], 0, 6)

	if minutes == nil || hours == nil {
		return nil
	}

	domStar := strings.TrimSpace(fields[2]) == "*"
	dowStar := strings.TrimSpace(fields[4]) == "*"

	loc := after.Location()
	candidate := after.Truncate(time.Minute).Add(time.Minute)
	limit := after.AddDate(0, 0, 366)

	for candidate.Before(limit) {
		if months != nil && !months[int(candidate.Month())] {
			// 跳到下个月1日00:00
			candidate = time.Date(candidate.Year(), candidate.Month()+1, 1, 0, 0, 0, 0, loc)
			continue
		}
		domHit := doms == nil || doms[candidate.Day()]
		dowHit := dows == nil || dows[int(candidate.Weekday())]
		var dayOk bool
		switch {
		case domStar && dowStar:
			dayOk = true
		case domStar:
			dayOk = dowHit
		case dowStar:
			dayOk = domHit
		default:
			dayOk = domHit || dowHit
		}
		if !dayOk {
			candidate = time.Date(candidate.Year(), candidate.Month(), candidate.Day()+1, 0, 0, 0, 0, loc)
			continue
		}
		if !hours[candidate.Hour()] {
			candidate = time.Date(candidate.Year(), candidate.Month(), candidate.Day(), candidate.Hour()+1, 0, 0, 0, loc)
			continue
		}
		if !minutes[candidate.Minute()] {
			candidate = candidate.Add(time.Minute)
			continue
		}
		return &candidate
	}
	return nil
}

func parseCronField(field string, min, max int) map[int]bool {
	field = strings.TrimSpace(field)
	if field == "*" {
		return nil // nil = match all
	}
	result := make(map[int]bool)
	for _, part := range strings.Split(field, ",") {
		part = strings.TrimSpace(part)
		// step: */N 或 lo-hi/N
		step := 1
		if idx := strings.Index(part, "/"); idx >= 0 {
			s, err := strconv.Atoi(strings.TrimSpace(part[idx+1:]))
			if err != nil || s <= 0 {
				continue
			}
			step = s
			part = strings.TrimSpace(part[:idx])
		}
		var lo, hi int
		switch {
		case part == "*":
			lo, hi = min, max
		case strings.Contains(part, "-"):
			bounds := strings.SplitN(part, "-", 2)
			a, err1 := strconv.Atoi(strings.TrimSpace(bounds[0]))
			b, err2 := strconv.Atoi(strings.TrimSpace(bounds[1]))
			if err1 != nil || err2 != nil {
				continue
			}
			lo, hi = a, b
		default:
			v, err := strconv.Atoi(part)
			if err != nil {
				continue
			}
			lo, hi = v, v
		}
		for i := lo; i <= hi && i <= max; i++ {
			if i < min {
				continue
			}
			if (i-lo)%step == 0 {
				result[i] = true
			}
		}
	}
	if len(result) == 0 {
		return nil
	}
	return result
}

// CalcAndSetNextRun 给定一个 schedule，计算并持久化下次运行时间。
// 用于创建/更新 schedule 后调用。
func (s *RoomScheduler) CalcAndSetNextRun(sched *database.AgentRoomSchedule) {
	next := calcNextRun(sched.CronExpr, sched.Timezone, time.Now())
	if next != nil {
		_ = s.repo.UpdateSchedule(sched.ID, map[string]any{"next_run_at": next})
	}
}
