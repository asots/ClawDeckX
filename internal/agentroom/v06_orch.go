package agentroom

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"ClawDeckX/internal/database"
	"ClawDeckX/internal/logger"
)

// v0.6 Orchestrator 公共方法 —— 会议纪要 / todo 抽取 / 消息重跑 / 群询 / playbook 提炼。
// 这些方法在 handler 里被同步调用；内部仍走 llmdirect，非流式，超时 60s。
//
// 设计原则：
//   - 使用"主持人"（有则优先）或"第一个存活 agent"的模型跑生成，避免每个场景再配模型。
//   - 保守 maxTokens（minutes 1200 / todo 800 / playbook 1000）避免烧预算。
//   - 非关键失败返回 error，让前端 toast，不污染聊天流。

const defaultV06Timeout = 60 * time.Second

// SynthesizeMinutes 让一个 agent 产出会议纪要 markdown，同时落盘为 kind=minutes 消息 + Artifact。
// 返回 (artifactID, messageID, error)。
func (o *Orchestrator) SynthesizeMinutes(ctx context.Context, template string) (string, string, error) {
	synthesizer := o.pickSynthesizer()
	if synthesizer == nil {
		return "", "", errors.New("没有可用的 agent 来生成纪要；请先邀请至少一个 agent")
	}

	recent, _ := o.repo.ListMessages(o.roomID, 0, 120)
	transcript := renderTranscript(recent, o.members)

	tplPrompt := minutesTemplate(template)
	system := fmt.Sprintf(
		"你是一个能干的会议秘书。现在需要你把下面这场多 Agent 会议压缩成一份结构化 markdown 纪要。"+
			"房间标题：%s；目标：%s；当前共有 %d 条消息、%d 位成员。",
		o.room.Title, o.room.Goal, len(recent), len(o.members),
	)
	user := tplPrompt + "\n\n----\n会议时间线（旧在上、新在下）：\n" + transcript + "\n----\n请直接输出纪要的 markdown 正文，不要解释自己在做什么。"

	res, err := o.nonStreamComplete(ctx, synthesizer, system, user, 1600)
	if err != nil {
		return "", "", err
	}
	o.recordCloseoutUsage(res)
	text := res.Text

	// 落盘 artifact + minutes 消息
	art := &database.AgentRoomArtifact{
		RoomID:   o.roomID,
		Title:    inferMinutesTitle(template, o.room.Title),
		Kind:     "markdown",
		Content:  text,
		Version:  1,
		AuthorID: synthesizer.ID,
	}
	if err := o.repo.CreateArtifact(art); err != nil {
		return "", "", err
	}
	msg := &database.AgentRoomMessage{
		ID:        GenID("msg"),
		RoomID:    o.roomID,
		Timestamp: NowMs(),
		AuthorID:  synthesizer.ID,
		Kind:      MsgKindMinutes,
		Content:   text,
	}
	if err := o.repo.CreateMessage(msg); err != nil {
		return art.ID, "", err
	}
	o.broker.Emit(o.roomID, EventMessageAppend, map[string]any{
		"roomId": o.roomID, "message": MessageFromModel(msg),
	})
	return art.ID, msg.ID, nil
}

// ExtractTodos 从 recent 里抽取 {text, assignee?} 列表，创建对应 task。
// 返回新创建的 Task DTO 数组。
func (o *Orchestrator) ExtractTodos(ctx context.Context) ([]Task, error) {
	synthesizer := o.pickSynthesizer()
	if synthesizer == nil {
		return nil, errors.New("没有可用的 agent 来抽取 todo")
	}

	recent, _ := o.repo.ListMessages(o.roomID, 0, 60)
	transcript := renderTranscript(recent, o.members)
	memberList := listMembersForPrompt(o.members)

	system := "你是一个会议秘书，从讨论里提炼出动作项（todo）。必须严格输出 JSON，不要有任何额外文字。"
	user := fmt.Sprintf(
		"会议目标：%s\n房间成员列表：\n%s\n\n----\n时间线：\n%s\n----\n请输出 JSON 数组，每个元素 {\"text\": \"待办具体描述\", \"assignee\": \"成员 ID 或空\"}。最多 8 条；只留确实需要人/agent 做的事。如果没有任何动作项，输出 [].",
		o.room.Goal, memberList, transcript,
	)

	res, err := o.nonStreamComplete(ctx, synthesizer, system, user, 800)
	if err != nil {
		return nil, err
	}
	o.recordCloseoutUsage(res)

	items := parseTodoJSON(res.Text)
	out := make([]Task, 0, len(items))
	creator := ""
	for _, it := range items {
		t := &database.AgentRoomTask{
			ID:         GenID("task"),
			RoomID:     o.roomID,
			Text:       it.Text,
			AssigneeID: it.Assignee,
			CreatorID:  creator,
			Status:     "todo",
		}
		if err := o.repo.CreateTask(t); err != nil {
			logger.Log.Warn().Err(err).Msg("agentroom: extract-todo: create task failed")
			continue
		}
		out = append(out, TaskFromModel(t))
	}
	return out, nil
}

// RerunMessage 以原消息作者身份再跑一次。modelOverride 非空则换模型。
// 实现：找原消息对应的触发上下文（取该消息之前的 trigger 消息，若无则传 nil），跑 runAgentTurn。
// 新消息有新 ID；原消息保留。
func (o *Orchestrator) RerunMessage(ctx context.Context, messageID, modelOverride string) (string, error) {
	orig, err := o.repo.GetMessage(messageID)
	if err != nil || orig == nil {
		return "", errors.New("消息不存在")
	}
	var member *database.AgentRoomMember
	for i := range o.members {
		if o.members[i].ID == orig.AuthorID {
			m := o.members[i]
			member = &m
			break
		}
	}
	if member == nil {
		return "", errors.New("原消息作者不是当前房间的 agent")
	}
	if member.Kind != "agent" {
		return "", errors.New("只能对 agent 消息重跑")
	}

	// 可选换模型：不写回 member.Model（仅本次使用）；通过参数流传给 runAgentTurn 会过度侵入，
	// 这里简化：临时替换内存里 Model 字段 → 跑完恢复；防止并发污染的办法是锁 o.mu。
	if modelOverride != "" && modelOverride != member.Model {
		o.mu.Lock()
		orig := member.Model
		member.Model = modelOverride
		// 回调保证即使 panic 也还原
		defer func() {
			member.Model = orig
			o.mu.Unlock()
		}()
	}

	// 找触发 trigger：原消息往前第一个非 agent chat（人类或 projection_in）。
	recent, _ := o.repo.ListMessages(o.roomID, 0, 60)
	var trigger *database.AgentRoomMessage
	foundSelf := false
	for i := len(recent) - 1; i >= 0; i-- {
		if recent[i].ID == messageID {
			foundSelf = true
			continue
		}
		if !foundSelf {
			continue
		}
		if recent[i].Kind == MsgKindChat && recent[i].AuthorID != member.ID {
			m := recent[i]
			trigger = &m
			break
		}
	}
	// 复制一份 recent（不含原消息，避免自我引用）
	filtered := make([]database.AgentRoomMessage, 0, len(recent))
	for _, m := range recent {
		if m.ID == messageID {
			continue
		}
		filtered = append(filtered, m)
	}

	// 预创建新消息 ID；由 runAgentTurn 自己 create
	newMsgID := "" // runAgentTurn 内部自建 ID，不好提前知道；用广播事件补发解决。
	runErr := o.runAgentTurn(ctx, member.ID, filtered, trigger)
	if runErr != nil {
		return "", runErr
	}
	// 拉最新一条该成员发言作为 newMsgID
	latest, _ := o.repo.ListMessages(o.roomID, 0, 5)
	for i := len(latest) - 1; i >= 0; i-- {
		if latest[i].AuthorID == member.ID && latest[i].ID != messageID {
			newMsgID = latest[i].ID
			break
		}
	}
	return newMsgID, nil
}

// AskAll 用人类身份发一条"群询"消息，mentions = 所有存活 agent。复用正常发言回合。
func (o *Orchestrator) AskAll(ctx context.Context, question string) error {
	agentIDs := make([]string, 0, len(o.members))
	for _, m := range o.members {
		if m.Kind == "agent" && !m.IsKicked && !m.IsMuted {
			agentIDs = append(agentIDs, m.ID)
		}
	}
	if len(agentIDs) == 0 {
		return errors.New("没有可发言的 agent")
	}
	mentionJSON, _ := json.Marshal(agentIDs)
	msg := &database.AgentRoomMessage{
		ID:             GenID("msg"),
		RoomID:         o.roomID,
		Timestamp:      NowMs(),
		AuthorID:       "human",
		Kind:           MsgKindChat,
		Content:        "【群询】" + strings.TrimSpace(question),
		MentionIDsJSON: string(mentionJSON),
	}
	if err := o.repo.CreateMessage(msg); err != nil {
		return err
	}
	o.emitMessageAppend(msg)
	// 立即触发一轮
	go func() {
		rctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		o.triggerRound(rctx, msg, "")
	}()
	return nil
}

// ExtractPlaybook 把房间整场讨论提炼成 {title, problem, approach, conclusion} 四段。
type ExtractedPlaybook struct {
	Title      string
	Problem    string
	Approach   string
	Conclusion string
}

func (o *Orchestrator) ExtractPlaybook(ctx context.Context) (*ExtractedPlaybook, error) {
	synthesizer := o.pickSynthesizer()
	if synthesizer == nil {
		return nil, errors.New("没有可用的 agent 抽取 playbook")
	}
	recent, _ := o.repo.ListMessages(o.roomID, 0, 200)
	transcript := renderTranscript(recent, o.members)

	system := "你是一个会议秘书，帮用户把一场多 agent 会议压缩成可复用的方法论卡（Playbook）。严格输出 JSON。"
	user := fmt.Sprintf(
		"房间标题：%s\n目标：%s\n----\n时间线：\n%s\n----\n请输出 JSON：{\"title\": string, \"problem\": string, \"approach\": string, \"conclusion\": string}。title 不超过 40 字；三段各不超过 600 字。不要解释。",
		o.room.Title, o.room.Goal, transcript,
	)
	res, err := o.nonStreamComplete(ctx, synthesizer, system, user, 1400)
	if err != nil {
		return nil, err
	}
	o.recordCloseoutUsage(res)
	var out ExtractedPlaybook
	if jsonErr := tolerantUnmarshalJSON(res.Text, &out); jsonErr != nil {
		return nil, fmt.Errorf("playbook 解析失败: %w", jsonErr)
	}
	return &out, nil
}

// ────────────── helpers ──────────────

func (o *Orchestrator) pickSynthesizer() *database.AgentRoomMember {
	// 先找主持人；否则找第一个存活的 agent。
	for i := range o.members {
		m := o.members[i]
		if m.Kind == "agent" && !m.IsKicked && m.IsModerator {
			return &m
		}
	}
	for i := range o.members {
		m := o.members[i]
		if m.Kind == "agent" && !m.IsKicked {
			return &m
		}
	}
	return nil
}

// nonStreamComplete 是 v0.6 辅助 LLM 入口（竞言打分 / 会议纪要 / extract-todo / promote-decision ...）。
//
// v0.4 升级：**统一走"辅助模型通道"**而不是成员自己的 model。原因：
//   - 竞言打分每轮 × N 成员调用一次，高频低质量敏感；用成员主模型（可能是 Opus）极其浪费。
//   - 纪要 / todo / 决议概括等输出短小，便宜模型（如 gpt-4o-mini / gpt-5.4-mini）完全够用。
//
// fallback 链：
//  1. o.room.AuxModel               —— 每房间覆盖（房间设置 UI）
//  2. settings["agentroom.aux_model"] —— 全局默认（全局 aux 设置）
//  3. m.Model                       —— 最后兜底：用传入 member 的主模型（保留原有行为）
//
// 同时用独立 aux session 避免污染成员对话历史：`agent:_aux:agentroom:<roomID>`。
// 该 session 在首次调用时通过 bridge.EnsureSession 建立，后续调用复用，历史长了 OpenClaw 自己压缩。
// v0.9.1：返回类型升级为 *CompleteResult（带 tokens/model），
// 方便调用方（尤其是 Closeout 流水线）把辅助 LLM 消耗的 token 累计起来展示。
// 只需要文本的调用方直接读 .Text 即可，迁移成本低。
func (o *Orchestrator) nonStreamComplete(ctx context.Context, m *database.AgentRoomMember, system, user string, maxTokens int) (*CompleteResult, error) {
	if o.bridge == nil || !o.bridge.IsAvailable() {
		return nil, ErrGatewayUnavailable
	}
	// 若调用方已设 deadline（如 runDeadlineSummary 的 3min），尊重它；
	// 否则退化到默认 60s，避免无限阻塞。
	var tctx context.Context
	var cancel context.CancelFunc
	if _, ok := ctx.Deadline(); ok {
		tctx, cancel = ctx, func() {}
	} else {
		tctx, cancel = context.WithTimeout(ctx, defaultV06Timeout)
	}
	defer cancel()

	// fallback 链：房间 → 全局 → 成员主模型
	model := o.auxModel()
	if model == "" {
		model = m.Model
	}
	agentID := strings.TrimSpace(m.AgentID)
	if agentID == "" {
		agentID = "main"
	}
	// aux session：每房间一条，复用上下文（压缩由 OpenClaw 管）。
	// 仍用专属 key，避免污染成员主会话历史；但不再使用虚构的 `_aux` agentId，
	// 否则 OpenClaw 可能把它物化成一个难删除的持久代理。直接复用 synth agent 的真实 ID。
	auxKey := "agent:" + agentID + ":agentroom-aux:" + o.roomID
	_ = o.bridge.EnsureSession(tctx, EnsureSessionParams{
		Key:      auxKey,
		AgentID:  agentID,
		Model:    model,
		Thinking: "off",
		Label:    "AgentRoom summary aux · " + m.Name + " · " + o.room.Title,
	})

	cres, err := o.bridge.Complete(tctx, CompleteRequest{
		SessionKey:     auxKey,
		AgentID:        agentID,
		Model:          model,
		Thinking:       "off", // 辅助任务不需要思考链
		SystemPrompt:   system,
		UserMessage:    user,
		MaxTokens:      maxTokens,
		TimeoutSeconds: int(defaultV06Timeout / time.Second),
	})
	if err != nil {
		return nil, err
	}
	// Fallback：OpenClaw transcript 有时不带 usage 字段，退化到本地估算
	// （与 runAgentTurn 同策略），保证 Closeout 费用汇总不会为零。
	if cres.TokensPrompt == 0 {
		cres.TokensPrompt = EstimateTokens(system + "\n" + user)
	}
	if cres.TokensComplete == 0 {
		cres.TokensComplete = EstimateTokens(cres.Text)
	}
	if cres.Model == "" {
		cres.Model = model
	}
	return cres, nil
}

// auxModel 返回本房间辅助 LLM 调用的有效模型。空串表示"上游再兜底"（调用方再退化到成员主模型）。
// 查询顺序：o.room.AuxModel → settings["agentroom.aux_model"] → ""。
//
// 注意：每次调用都会查 DB。辅助调用频率本就低（竞言一轮一次，纪要用户手动触发），
// 不做缓存，设置变更立即生效，避免维护缓存失效逻辑的复杂度。
func (o *Orchestrator) auxModel() string {
	if o.room != nil {
		if v := strings.TrimSpace(o.room.AuxModel); v != "" {
			return v
		}
	}
	if v := strings.TrimSpace(readAgentRoomAuxModelSetting()); v != "" {
		return v
	}
	return ""
}

func renderTranscript(recent []database.AgentRoomMessage, members []database.AgentRoomMember) string {
	nameMap := map[string]string{}
	for _, m := range members {
		nameMap[m.ID] = m.Name
	}
	var sb strings.Builder
	for _, m := range recent {
		if m.Deleted {
			continue
		}
		// v0.9.1：Closeout / Extract / Retro / Playbook 等"会议秘书"辅助 LLM 只关心
		// 人/agent 的"发言"——工具运行日志、竞价打分、错误、外部被哨兵隔离的内容、
		// 已经压缩过的摘要/纪要/checkpoint 指针、以及纯系统提示/思考链都不应再塞回
		// prompt，否则长会议时 token 浪费严重且极易把无意义上下文注入判断。
		switch m.Kind {
		case MsgKindThinking, MsgKindSystem,
			MsgKindTool, MsgKindToolApproval,
			MsgKindBidding, MsgKindError,
			MsgKindArtifactRef,
			MsgKindUntrusted,
			MsgKindMinutes, MsgKindSummary, MsgKindCheckpoint:
			continue
		}
		who := nameMap[m.AuthorID]
		if who == "" {
			who = m.AuthorID
			if who == "" {
				who = "system"
			}
		}
		prefix := who
		if m.IsDecision {
			prefix = "【决策】" + prefix
		}
		if m.Kind == MsgKindWhisper {
			prefix = "[whisper] " + prefix
		}
		snippet := strings.TrimSpace(m.Content)
		if len([]rune(snippet)) > 400 {
			snippet = string([]rune(snippet)[:400]) + "…"
		}
		sb.WriteString(prefix + "：" + snippet + "\n")
	}
	return sb.String()
}

func listMembersForPrompt(members []database.AgentRoomMember) string {
	var sb strings.Builder
	for _, m := range members {
		if m.IsKicked {
			continue
		}
		role := m.Role
		if m.Kind == "human" {
			role = "人类"
		}
		sb.WriteString(fmt.Sprintf("- %s (%s) · id=%s\n", m.Name, role, m.ID))
	}
	return sb.String()
}

// minutesTemplate 返回不同纪要模板的 system prompt 段落。
func minutesTemplate(tpl string) string {
	switch tpl {
	case "prd":
		return "请按产品需求文档（PRD）格式输出：1)背景与目标 2)用户 & 场景 3)功能范围 4)非功能需求 5)里程碑 6)风险。"
	case "adr":
		return "请按架构决策记录（ADR）格式输出：1)背景 2)待决策问题 3)考虑过的方案 4)结论与原因 5)后续影响。"
	case "review":
		return "请按 code/设计 review 小结格式输出：1)被 review 对象 2)主要发现 3)必须修复项 4)建议改进项 5)结论。"
	case "minutes":
		fallthrough
	default:
		return "请按会议纪要格式输出：1)议题 2)关键讨论要点 3)明确的决策（用【决策】前缀）4)待办事项 5)未决问题。"
	}
}

func inferMinutesTitle(tpl, roomTitle string) string {
	label := map[string]string{
		"minutes": "会议纪要",
		"prd":     "PRD",
		"adr":     "ADR",
		"review":  "Review 小结",
	}[tpl]
	if label == "" {
		label = "会议纪要"
	}
	return fmt.Sprintf("%s · %s", label, roomTitle)
}

// parseTodoJSON 从 LLM 输出里挑出 JSON 数组（兼容外面带 ```json 包裹）。
type todoItem struct {
	Text     string `json:"text"`
	Assignee string `json:"assignee,omitempty"`
}

func parseTodoJSON(s string) []todoItem {
	raw := extractJSONBlock(s)
	if raw == "" {
		return nil
	}
	var items []todoItem
	if err := json.Unmarshal([]byte(raw), &items); err != nil {
		return nil
	}
	out := items[:0]
	for _, it := range items {
		it.Text = strings.TrimSpace(it.Text)
		if it.Text == "" {
			continue
		}
		out = append(out, it)
	}
	return out
}

// tolerantUnmarshalJSON 先试直接 Unmarshal；失败则扫描第一个 {...} 块再解析。
func tolerantUnmarshalJSON(s string, out any) error {
	trimmed := strings.TrimSpace(s)
	if err := json.Unmarshal([]byte(trimmed), out); err == nil {
		return nil
	}
	block := extractJSONBlock(s)
	if block == "" {
		return errors.New("no JSON block found")
	}
	return json.Unmarshal([]byte(block), out)
}

// extractJSONBlock 找出字符串里第一个 { 或 [ 配对到末尾的 JSON 片段（最简括号匹配）。
func extractJSONBlock(s string) string {
	// 去掉 ```json / ``` 包裹
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "```json")
	s = strings.TrimPrefix(s, "```JSON")
	s = strings.TrimPrefix(s, "```")
	if i := strings.LastIndex(s, "```"); i >= 0 {
		s = s[:i]
	}
	s = strings.TrimSpace(s)
	// 找第一个 { 或 [
	start := -1
	for i, r := range s {
		if r == '{' || r == '[' {
			start = i
			break
		}
	}
	if start < 0 {
		return ""
	}
	// 匹配配对字符
	open := rune(s[start])
	var close rune
	if open == '{' {
		close = '}'
	} else {
		close = ']'
	}
	depth := 0
	for i := start; i < len(s); i++ {
		r := rune(s[i])
		if r == open {
			depth++
		} else if r == close {
			depth--
			if depth == 0 {
				return s[start : i+1]
			}
		}
	}
	return ""
}
