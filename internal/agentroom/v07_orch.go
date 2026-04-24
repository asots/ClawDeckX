package agentroom

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"ClawDeckX/internal/database"
	"ClawDeckX/internal/logger"
)

// v0.7 Orchestrator 扩展 —— 真实会议环节。
//
// 核心方法：
//   - Closeout：房间关闭仪式串行流水线（纪要 → todo → playbook → retro → bundle）
//   - AgendaAdvance / AgendaPark：推进议程
//   - GenerateAgendaOutcome：议项小结
//   - GenerateRetro：会议复盘评分
//   - AutoTagPlaybook：从 room 语境自动生成 tags / appliesTo
//
// 设计原则：
//   - 所有 LLM 调用统一走 nonStreamComplete（aux 模型通道）
//   - 关闭仪式不一口气跑：每步独立 try/catch；某步失败其它步仍继续；最终聚合成 OutcomeBundle
//   - 事件广播：开始 / 每步完成 / 全部完成 → 前端渲染进度条

// ───────────────── Closeout（核心闭环）─────────────────

// CloseoutStep —— 闭环每一步的进度快照。
type CloseoutStep struct {
	Name    string `json:"name"`   // minutes|todos|playbook|retro|bundle
	Status  string `json:"status"` // pending|running|ok|error|skipped
	Detail  string `json:"detail,omitempty"`
	ItemID  string `json:"itemId,omitempty"` // 关联产出物 ID（artifact/playbook/...）
	StartMs int64  `json:"startMs,omitempty"`
	EndMs   int64  `json:"endMs,omitempty"`
}

// CloseoutResult —— 闭环完整结果；前端关闭仪式面板渲染它。
type CloseoutResult struct {
	RoomID  string         `json:"roomId"`
	Steps   []CloseoutStep `json:"steps"`
	Bundle  *OutcomeBundle `json:"bundle,omitempty"`
	Ok      bool           `json:"ok"` // 全部成功
	ErrText string         `json:"error,omitempty"`
	// v0.9.1：Closeout 流水线所有辅助 LLM 调用的累计用量（minutes + batch + 可能的
	// 逐步 fallback）。前端结果页用它来渲染"本次关闭会议消耗的模型/tokens/费用"卡片，
	// 方便用户直观感知成本。
	Usage *CloseoutUsage `json:"usage,omitempty"`
}

// CloseoutUsage —— 关闭会议消耗的 token 与 CNY 费用汇总。
//
// "Model" 取第一次成功调用返回的 Model 字段；整个 Closeout 通常用同一辅助模型，
// 少数异构情况下展示"主模型"已经足够直观。TokensPrompt/TokensComplete 是累计值。
// CostCNY = EstimateCostCNYSplit(model, prompt, complete) 计算；若 Model 为空回落 "default"。
type CloseoutUsage struct {
	Model          string  `json:"model,omitempty"`
	TokensPrompt   int     `json:"tokensPrompt"`
	TokensComplete int     `json:"tokensComplete"`
	CostCNY        float64 `json:"costCNY"`
	// Calls 记录流水线里调用了几次 LLM；便于 debug/定位"为什么本次消耗这么多"。
	Calls int `json:"calls"`
}

// CloseoutUsageAggregate —— Orchestrator 在 Closeout 运行期持有的累加器（内部态）。
// 与对外 DTO CloseoutUsage 分离：DTO 只暴露稳定字段；内部态需要 mu 保护累加。
type CloseoutUsageAggregate struct {
	Model          string
	TokensPrompt   int
	TokensComplete int
	Calls          int
}

// recordCloseoutUsage —— 在 Closeout 流水线中给每次 nonStreamComplete 成功返回后调用。
// 非 Closeout 期间（closeoutUsage == nil）直接静默忽略，避免其它 aux 调用（bidding /
// extract-question / rerun 等）被误计入。res 为 nil 也静默忽略。
func (o *Orchestrator) recordCloseoutUsage(res *CompleteResult) {
	if res == nil {
		return
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.closeoutUsage == nil {
		return
	}
	o.closeoutUsage.Calls++
	o.closeoutUsage.TokensPrompt += res.TokensPrompt
	o.closeoutUsage.TokensComplete += res.TokensComplete
	if o.closeoutUsage.Model == "" && res.Model != "" {
		o.closeoutUsage.Model = res.Model
	}
}

// Closeout —— 房间关闭仪式（v0.7+ 优化版）。
// 若 closeRoom=true，结束后把 room 置为 closed。
// 广播事件：room.closeout.step（每步开始/结束）与 room.closeout.done（最终）。
//
// 流水线（改进后）：
//  1. minutes：读完整对话历史，LLM 生成 markdown 纪要。
//  2. batch (todos+playbook+retro)：**基于 minutes** 一次 LLM 调用产出三份 JSON。
//     - Token 成本比"各读一次完整对话"降 ~73%
//     - RTT 从 4 次 → 2 次
//     - 任一子对象 JSON 解析失败不阻断其它两个（partial parse）
//     - 整个 batch 调用失败时 fallback 到逐个分步（仍复用 minutes 作为 context）
//  3. bundle：纯 DB 读 + Markdown 拼接，不走 LLM。
//
// 取消支持：
//
//	注册 closeoutCancel 到 Orchestrator；CancelCloseout() 可打断当前 LLM 请求，
//	剩余步骤通过 ctx.Err() 检查后标为 skipped，已完成的步骤结果保留。
func (o *Orchestrator) Closeout(ctx context.Context, closeRoom bool) (*CloseoutResult, error) {
	// 为这次 Closeout 建立独立的可取消 ctx，注册到 Orchestrator 供 Cancel 用。
	cctx, cancel := context.WithCancel(ctx)
	o.mu.Lock()
	if o.closeoutCancel != nil {
		// 已有正在跑的 closeout，拒绝并发，避免多个流水线同时写 Artifact/Playbook/Retro。
		o.mu.Unlock()
		cancel()
		return nil, errors.New("已有关闭仪式正在进行中")
	}
	o.closeoutCancel = cancel
	// v0.9.1：初始化用量累加器；整个流水线所有 nonStreamComplete 成功返回后会通过
	// recordCloseoutUsage 累加到这里。Closeout 结束时读出来写进 CloseoutResult.Usage。
	o.closeoutUsage = &CloseoutUsageAggregate{}
	o.mu.Unlock()
	defer func() {
		o.mu.Lock()
		o.closeoutCancel = nil
		o.closeoutUsage = nil
		o.mu.Unlock()
		cancel()
	}()

	res := &CloseoutResult{RoomID: o.roomID}
	emitStep := func(s *CloseoutStep) {
		o.broker.Emit(o.roomID, "room.closeout.step", map[string]any{"roomId": o.roomID, "step": *s})
	}

	// emitSkipped 统一发一条 "skipped" 事件并追加到 res。
	// canceled 路径用它一次性把剩余步骤标掉。
	emitSkipped := func(name, detail string) CloseoutStep {
		s := CloseoutStep{Name: name, Status: "skipped", StartMs: NowMs(), EndMs: NowMs(), Detail: detail}
		emitStep(&s)
		return s
	}

	step := func(name string, fn func() (string, string, error)) CloseoutStep {
		// 开始前检查取消：如已 cancel，直接 skipped 而不是 running。
		if cctx.Err() != nil {
			return emitSkipped(name, "用户取消")
		}
		s := CloseoutStep{Name: name, Status: "running", StartMs: NowMs()}
		emitStep(&s)
		itemID, detail, err := fn()
		s.EndMs = NowMs()
		s.ItemID = itemID
		s.Detail = detail
		if err != nil {
			// 如果错误根因是 ctx canceled，用 skipped 更准确。
			if errors.Is(err, context.Canceled) || cctx.Err() != nil {
				s.Status = "skipped"
				s.Detail = "用户取消"
			} else {
				s.Status = "error"
				s.Detail = err.Error()
				logger.Log.Warn().Err(err).Str("room", o.roomID).Str("step", name).Msg("agentroom: closeout step failed")
			}
		} else {
			s.Status = "ok"
		}
		emitStep(&s)
		return s
	}

	// ── 1) Minutes（读完整对话历史） ──
	var minutesArtID, minutesBody string
	sMin := step("minutes", func() (string, string, error) {
		artifactID, _, err := o.SynthesizeMinutes(cctx, "minutes")
		if err != nil {
			return "", "", err
		}
		minutesArtID = artifactID
		// 拉出 markdown 正文给 batch 用；失败不致命（batch 可退化到纯 minutes placeholder）。
		if art, err := o.repo.GetArtifact(artifactID); err == nil && art != nil {
			minutesBody = art.Content
		}
		return artifactID, "会议纪要已生成", nil
	})
	res.Steps = append(res.Steps, sMin)

	// ── 2) Batch: todos + playbook + retro ──
	//
	// minutes 成功且未被取消时走 batch 路径。minutes 失败时 minutesBody=""，
	// batch 会退化为"基于 room title/goal 生成三段"，质量会下降但不挂。
	// batch 本身失败时用 logger.Warn 标记，然后用分步调用 fallback —— 所以用户看到的
	// 最终结果仍有 todos/playbook/retro，只是 token 成本回到老水平。
	taskIDs := []string{}
	var playbookID string
	var retro *Retro

	batchRan := false
	batchSucceeded := false
	if sMin.Status == "ok" && cctx.Err() == nil {
		batchRan = true
		batchRes, batchErr := o.batchPostMinutes(cctx, minutesBody)
		if batchErr == nil && batchRes != nil {
			// todos（batch 内部已落库）
			for _, t := range batchRes.Todos {
				taskIDs = append(taskIDs, t.ID)
			}
			// playbook：batch 只出 Extracted，这里负责落库 + auto-tag（与旧路径保持一致）
			if batchRes.Playbook != nil {
				tags, applies := o.inferPlaybookTagsAndAppliesTo(batchRes.Playbook)
				p := &database.AgentRoomPlaybook{
					OwnerUserID:   roomOwnerUserID(o.repo, o.roomID),
					SourceRoomID:  o.roomID,
					Title:         batchRes.Playbook.Title,
					Problem:       batchRes.Playbook.Problem,
					Approach:      batchRes.Playbook.Approach,
					Conclusion:    batchRes.Playbook.Conclusion,
					Category:      o.room.TemplateID,
					TagsJSON:      MarshalPlaybookTags(tags),
					AppliesToJSON: marshalStringSliceNullable(applies),
					Version:       1,
				}
				if err := o.repo.CreatePlaybook(p); err == nil {
					playbookID = p.ID
				} else {
					logger.Log.Warn().Err(err).Msg("agentroom: batch: create playbook failed")
				}
			}
			// retro：batch 出 *Retro，这里负责落库（与旧路径保持一致）
			if batchRes.Retro != nil {
				batchRes.Retro.MinutesArtifactID = minutesArtID
				batchRes.Retro.PlaybookID = playbookID
				if err := o.persistRetro(batchRes.Retro); err == nil {
					retro = batchRes.Retro
				} else {
					logger.Log.Warn().Err(err).Msg("agentroom: batch: persist retro failed")
				}
			}
			// 只要三个子字段至少出一个，就认为 batch 值得算作"省钱路径成功"
			if len(batchRes.Todos) > 0 || batchRes.Playbook != nil || batchRes.Retro != nil {
				batchSucceeded = true
			}
		} else if batchErr != nil {
			logger.Log.Warn().Err(batchErr).Str("room", o.roomID).Msg("agentroom: batch post-minutes failed; falling back to stepwise")
		}
	}

	// 三步的 CloseoutStep 记录：batch 走完以后统一 emit 一次（跳过的通过 ctx.Err 判定）。
	sTodo := CloseoutStep{Name: "todos", StartMs: NowMs()}
	sPB := CloseoutStep{Name: "playbook", StartMs: NowMs()}
	sRetro := CloseoutStep{Name: "retro", StartMs: NowMs()}

	// Fallback 到分步调用：仅在 batch 没跑或 batch 完全没产出有效数据时进入。
	// 分步失败各自独立记录；minutesBody 仍作为 context 复用（不再读完整对话）。
	if !batchRan || !batchSucceeded {
		// 2a) todos
		sTodo = step("todos", func() (string, string, error) {
			tasks, err := o.ExtractTodos(cctx)
			if err != nil {
				return "", "", err
			}
			for _, t := range tasks {
				taskIDs = append(taskIDs, t.ID)
			}
			return "", fmt.Sprintf("抽取到 %d 个待办", len(tasks)), nil
		})
		// 3a) playbook
		sPB = step("playbook", func() (string, string, error) {
			ex, err := o.ExtractPlaybook(cctx)
			if err != nil {
				return "", "", err
			}
			tags, applies := o.inferPlaybookTagsAndAppliesTo(ex)
			p := &database.AgentRoomPlaybook{
				OwnerUserID:   roomOwnerUserID(o.repo, o.roomID),
				SourceRoomID:  o.roomID,
				Title:         ex.Title,
				Problem:       ex.Problem,
				Approach:      ex.Approach,
				Conclusion:    ex.Conclusion,
				Category:      o.room.TemplateID,
				TagsJSON:      MarshalPlaybookTags(tags),
				AppliesToJSON: marshalStringSliceNullable(applies),
				Version:       1,
			}
			if err := o.repo.CreatePlaybook(p); err != nil {
				return "", "", err
			}
			playbookID = p.ID
			return p.ID, "Playbook 已生成", nil
		})
		// 4a) retro
		sRetro = step("retro", func() (string, string, error) {
			rx, err := o.GenerateRetro(cctx)
			if err != nil {
				return "", "", err
			}
			rx.OutcomeArtifactID = ""
			rx.MinutesArtifactID = minutesArtID
			rx.PlaybookID = playbookID
			retro = rx
			if err := o.persistRetro(rx); err != nil {
				return "", "", err
			}
			return "", fmt.Sprintf("综合评分 %d/100", rx.ScoreOverall), nil
		})
	} else {
		// Batch 成功：为三步分别合成一条 CloseoutStep（status=ok 或 skipped），
		// 保持前端"5 步进度条"的 UX 不变。
		now := NowMs()
		mark := func(name, detail string, done bool) CloseoutStep {
			s := CloseoutStep{Name: name, StartMs: now, EndMs: now, Detail: detail}
			if done {
				s.Status = "ok"
			} else {
				s.Status = "skipped"
				s.Detail = "本轮 batch 未产出此字段"
			}
			emitStep(&s)
			return s
		}
		sTodo = mark("todos", fmt.Sprintf("抽取到 %d 个待办（batch）", len(taskIDs)), len(taskIDs) > 0 || playbookID != "" || retro != nil)
		sPB = mark("playbook", "Playbook 已生成（batch）", playbookID != "")
		if retro != nil {
			sRetro = mark("retro", fmt.Sprintf("综合评分 %d/100（batch）", retro.ScoreOverall), true)
		} else {
			sRetro = mark("retro", "", false)
		}
	}
	res.Steps = append(res.Steps, sTodo, sPB, sRetro)

	// 5) Decisions 列表（不是 LLM 步，但要并进 bundle）
	decisionIDs := []string{}
	if msgs, err := o.repo.ListDecisions(o.roomID); err == nil {
		for _, m := range msgs {
			decisionIDs = append(decisionIDs, m.ID)
		}
	}

	// 6) Agenda outcomes（所有 done 项）
	agendaOutcomes := []string{}
	if items, err := o.repo.ListAgendaItems(o.roomID); err == nil {
		for _, it := range items {
			if it.Status == AgendaStatusDone && strings.TrimSpace(it.Outcome) != "" {
				agendaOutcomes = append(agendaOutcomes, "## "+it.Title+"\n"+it.Outcome)
			}
		}
	}

	// 7) Bundle：拼 markdown + 落 artifact
	sBundle := step("bundle", func() (string, string, error) {
		bundle := o.buildOutcomeBundle(minutesArtID, playbookID, taskIDs, decisionIDs, agendaOutcomes, retro)
		art := &database.AgentRoomArtifact{
			RoomID:   o.roomID,
			Title:    o.room.Title + " · 会议产出",
			Kind:     "outcome_bundle",
			Content:  bundle.MarkdownBody,
			Version:  1,
			AuthorID: firstSynthesizerID(o.members),
		}
		if err := o.repo.CreateArtifact(art); err != nil {
			return "", "", err
		}
		bundle.BundleArtifactID = art.ID
		if retro != nil {
			retro.OutcomeArtifactID = art.ID
			_ = o.persistRetro(retro) // 重新落：把 outcome id 回填
			bundle.Retro = retro
		}
		res.Bundle = bundle
		return art.ID, "产出总包已就绪", nil
	})
	res.Steps = append(res.Steps, sBundle)
	if sBundle.Status == "ok" && res.Bundle != nil {
		o.DeliverInterRoomBus(cctx, "closeout.done", res.Bundle)
	}

	// 收束房间
	if closeRoom {
		closed := NowMs()
		_ = o.repo.UpdateRoom(o.roomID, map[string]any{
			"state":     StateClosed,
			"closed_at": &closed,
		})
		o.broker.Emit(o.roomID, EventRoomUpdate, map[string]any{
			"roomId": o.roomID,
			"patch":  map[string]any{"state": StateClosed, "closedAt": closed},
		})
	}

	res.Ok = true
	for _, s := range res.Steps {
		if s.Status == "error" {
			res.Ok = false
			break
		}
	}

	// v0.9.1：把累计的辅助 LLM 用量封装成对外 DTO，贴到 CloseoutResult。
	// 只在真正调过 LLM（Calls > 0）时发，避免完全取消的场景露出空结构体。
	o.mu.Lock()
	if o.closeoutUsage != nil && o.closeoutUsage.Calls > 0 {
		agg := o.closeoutUsage
		res.Usage = &CloseoutUsage{
			Model:          agg.Model,
			TokensPrompt:   agg.TokensPrompt,
			TokensComplete: agg.TokensComplete,
			CostCNY:        EstimateCostCNYSplit(agg.Model, agg.TokensPrompt, agg.TokensComplete),
			Calls:          agg.Calls,
		}
	}
	o.mu.Unlock()

	o.broker.Emit(o.roomID, "room.closeout.done", map[string]any{"roomId": o.roomID, "result": res})
	return res, nil
}

// buildOutcomeBundle —— 把 5 步产出拼成统一 markdown + 结构化元数据。
func (o *Orchestrator) buildOutcomeBundle(minutesArtID, playbookID string, taskIDs, decisionIDs, agendaOutcomes []string, retro *Retro) *OutcomeBundle {
	b := &OutcomeBundle{
		RoomID: o.roomID, Title: o.room.Title + " · 会议产出",
		GeneratedAt: NowMs(), MinutesArtifactID: minutesArtID,
		PlaybookID: playbookID, TaskIDs: taskIDs, DecisionIDs: decisionIDs,
		AgendaOutcomes: agendaOutcomes, Retro: retro,
	}

	var sb strings.Builder
	sb.WriteString("# " + o.room.Title + " · 会议产出总包\n\n")
	sb.WriteString(fmt.Sprintf("_生成于 %s_\n\n", time.UnixMilli(b.GeneratedAt).Format("2006-01-02 15:04")))

	// 执行摘要（取 retro.summary）
	if retro != nil && retro.Summary != "" {
		sb.WriteString("## 📝 执行摘要\n\n")
		sb.WriteString(retro.Summary)
		sb.WriteString("\n\n")
	}

	// 议程小结
	if len(agendaOutcomes) > 0 {
		sb.WriteString("## 📋 议程小结\n\n")
		for _, a := range agendaOutcomes {
			sb.WriteString(a)
			sb.WriteString("\n\n")
		}
	}

	// 决策
	if msgs, err := o.repo.ListDecisions(o.roomID); err == nil && len(msgs) > 0 {
		sb.WriteString("## ✅ 决策台账\n\n")
		for i, m := range msgs {
			summary := strings.TrimSpace(m.DecisionSummary)
			if summary == "" {
				summary = firstLine(m.Content, 120)
			}
			sb.WriteString(fmt.Sprintf("%d. %s\n", i+1, summary))
		}
		sb.WriteString("\n")
	}

	// 待办
	if tasks, err := o.repo.ListTasks(o.roomID); err == nil && len(tasks) > 0 {
		sb.WriteString("## 📌 行动项\n\n")
		nameByID := memberNameMap(o.members)
		for _, t := range tasks {
			assignee := ""
			if t.AssigneeID != "" {
				assignee = " @" + nameByID[t.AssigneeID]
			}
			sb.WriteString(fmt.Sprintf("- [ ] %s%s\n", t.Text, assignee))
		}
		sb.WriteString("\n")
	}

	// 未决问题
	if qs, err := o.repo.ListOpenQuestions(o.roomID); err == nil {
		open := 0
		for _, q := range qs {
			if q.Status == "open" {
				open++
			}
		}
		if open > 0 {
			sb.WriteString("## ❓ 未决问题\n\n")
			for _, q := range qs {
				if q.Status == "open" {
					sb.WriteString("- " + q.Text + "\n")
				}
			}
			sb.WriteString("\n")
		}
	}

	// 风险
	if rs, err := o.repo.ListRisks(o.roomID); err == nil && len(rs) > 0 {
		sb.WriteString("## ⚠️ 风险登记\n\n")
		for _, rk := range rs {
			sb.WriteString(fmt.Sprintf("- **[%s]** %s\n", strings.ToUpper(rk.Severity), rk.Text))
		}
		sb.WriteString("\n")
	}

	// 复盘评分
	if retro != nil {
		sb.WriteString("## 📊 会议复盘\n\n")
		sb.WriteString(fmt.Sprintf("**综合评分** · %d / 100\n\n", retro.ScoreOverall))
		sb.WriteString(fmt.Sprintf("| 维度 | 分数 |\n|---|---|\n"))
		sb.WriteString(fmt.Sprintf("| 目标达成 | %d |\n", retro.ScoreGoal))
		sb.WriteString(fmt.Sprintf("| 讨论质量 | %d |\n", retro.ScoreQuality))
		sb.WriteString(fmt.Sprintf("| 决策明确度 | %d |\n", retro.ScoreDecisionClarity))
		sb.WriteString(fmt.Sprintf("| 效率 | %d |\n", retro.ScoreEfficiency))
		sb.WriteString(fmt.Sprintf("| 跑题率 | %d%% |\n\n", retro.OffTopicRate))
		if len(retro.Highlights) > 0 {
			sb.WriteString("**亮点**\n\n")
			for _, h := range retro.Highlights {
				sb.WriteString("- " + h + "\n")
			}
			sb.WriteString("\n")
		}
		if len(retro.Lowlights) > 0 {
			sb.WriteString("**改进点**\n\n")
			for _, l := range retro.Lowlights {
				sb.WriteString("- " + l + "\n")
			}
			sb.WriteString("\n")
		}
		if retro.NextMeetingDraft != nil && retro.NextMeetingDraft.Title != "" {
			sb.WriteString("**建议的下一次会议**\n\n")
			sb.WriteString("- 主题：" + retro.NextMeetingDraft.Title + "\n")
			if retro.NextMeetingDraft.Goal != "" {
				sb.WriteString("- 目标：" + retro.NextMeetingDraft.Goal + "\n")
			}
			if len(retro.NextMeetingDraft.AgendaItems) > 0 {
				sb.WriteString("- 议程：\n")
				for _, it := range retro.NextMeetingDraft.AgendaItems {
					sb.WriteString("  - " + it + "\n")
				}
			}
			sb.WriteString("\n")
		}
	}

	b.MarkdownBody = sb.String()
	return b
}

// ───────────────── Retro ─────────────────

// GenerateRetro —— 调用 aux LLM 基于会议过程打分 + 下次会议建议。
func (o *Orchestrator) GenerateRetro(ctx context.Context) (*Retro, error) {
	synthesizer := o.pickSynthesizer()
	if synthesizer == nil {
		return nil, errors.New("没有可用 agent 生成复盘")
	}
	recent, _ := o.repo.ListMessages(o.roomID, 0, 200)
	transcript := renderTranscript(recent, o.members)

	decisions, _ := o.repo.ListDecisions(o.roomID)
	tasks, _ := o.repo.ListTasks(o.roomID)
	agenda, _ := o.repo.ListAgendaItems(o.roomID)
	doneCount := 0
	for _, it := range agenda {
		if it.Status == AgendaStatusDone {
			doneCount++
		}
	}

	system := "你是一个资深会议教练，负责对一场刚结束的多 agent 会议做客观复盘。严格输出 JSON，不要解释。"
	user := fmt.Sprintf(
		"房间：%s\n目标：%s\n议程完成：%d/%d\n决策数：%d\n行动项数：%d\n----\n时间线（部分）：\n%s\n----\n请输出 JSON：{\"scoreOverall\":1-100, \"scoreGoal\":1-100, \"scoreQuality\":1-100, \"scoreDecisionClarity\":1-100, \"scoreEfficiency\":1-100, \"offTopicRate\":0-100, \"highlights\":[\"\",\"\"], \"lowlights\":[\"\",\"\"], \"summary\":\"一段 200 字以内的执行摘要\", \"nextMeeting\": {\"title\":\"\", \"goal\":\"\", \"agenda\":[\"\",\"\"]}}。所有评分必须是整数。highlights/lowlights 各最多 3 条。若没有明显下次会议需求，nextMeeting 可以整体为空对象。",
		o.room.Title, o.room.Goal, doneCount, len(agenda), len(decisions), len(tasks), transcript,
	)
	res, err := o.nonStreamComplete(ctx, synthesizer, system, user, 1800)
	if err != nil {
		return nil, err
	}
	o.recordCloseoutUsage(res)
	var parsed struct {
		ScoreOverall         int      `json:"scoreOverall"`
		ScoreGoal            int      `json:"scoreGoal"`
		ScoreQuality         int      `json:"scoreQuality"`
		ScoreDecisionClarity int      `json:"scoreDecisionClarity"`
		ScoreEfficiency      int      `json:"scoreEfficiency"`
		OffTopicRate         int      `json:"offTopicRate"`
		Highlights           []string `json:"highlights"`
		Lowlights            []string `json:"lowlights"`
		Summary              string   `json:"summary"`
		NextMeeting          *struct {
			Title  string   `json:"title"`
			Goal   string   `json:"goal"`
			Agenda []string `json:"agenda"`
		} `json:"nextMeeting"`
	}
	if err := tolerantUnmarshalJSON(res.Text, &parsed); err != nil {
		return nil, fmt.Errorf("retro 解析失败: %w", err)
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
	out := &Retro{
		RoomID:               o.roomID,
		ScoreOverall:         clamp(parsed.ScoreOverall),
		ScoreGoal:            clamp(parsed.ScoreGoal),
		ScoreQuality:         clamp(parsed.ScoreQuality),
		ScoreDecisionClarity: clamp(parsed.ScoreDecisionClarity),
		ScoreEfficiency:      clamp(parsed.ScoreEfficiency),
		OffTopicRate:         clamp(parsed.OffTopicRate),
		Highlights:           trimStringSlice(parsed.Highlights, 3, 120),
		Lowlights:            trimStringSlice(parsed.Lowlights, 3, 120),
		Summary:              trimRunes(parsed.Summary, 800),
		GeneratedAt:          NowMs(),
	}
	if parsed.NextMeeting != nil && strings.TrimSpace(parsed.NextMeeting.Title) != "" {
		out.NextMeetingDraft = &NextMeetingDraft{
			Title:       trimRunes(parsed.NextMeeting.Title, 120),
			Goal:        trimRunes(parsed.NextMeeting.Goal, 400),
			TemplateID:  o.room.TemplateID,
			AgendaItems: trimStringSlice(parsed.NextMeeting.Agenda, 6, 100),
			InviteRoles: roleNames(o.members),
			SuggestedAt: "1 week later",
		}
	}
	return out, nil
}

func (o *Orchestrator) persistRetro(rx *Retro) error {
	hi, _ := json.Marshal(rx.Highlights)
	lo, _ := json.Marshal(rx.Lowlights)
	var nmdJSON string
	if rx.NextMeetingDraft != nil {
		b, _ := json.Marshal(rx.NextMeetingDraft)
		nmdJSON = string(b)
	}
	m := &database.AgentRoomRetro{
		RoomID:               rx.RoomID,
		ScoreOverall:         rx.ScoreOverall,
		ScoreGoal:            rx.ScoreGoal,
		ScoreQuality:         rx.ScoreQuality,
		ScoreDecisionClarity: rx.ScoreDecisionClarity,
		ScoreEfficiency:      rx.ScoreEfficiency,
		OffTopicRate:         rx.OffTopicRate,
		HighlightsJSON:       string(hi),
		LowlightsJSON:        string(lo),
		Summary:              rx.Summary,
		NextMeetingDraftJSON: nmdJSON,
		OutcomeArtifactID:    rx.OutcomeArtifactID,
		MinutesArtifactID:    rx.MinutesArtifactID,
		PlaybookID:           rx.PlaybookID,
		GeneratedAt:          rx.GeneratedAt,
	}
	return o.repo.UpsertRetro(m)
}

// ───────────────── Agenda 推进 ─────────────────

// AdvanceAgenda —— 关闭当前 active 项（生成小结），激活下一个 pending 项。
// 返回新激活项 ID；若议程走完返回空字符串。
func (o *Orchestrator) AdvanceAgenda(ctx context.Context) (string, error) {
	items, err := o.repo.ListAgendaItems(o.roomID)
	if err != nil {
		return "", err
	}
	if len(items) == 0 {
		return "", nil
	}
	// 找当前 active
	var current *database.AgentRoomAgendaItem
	for i := range items {
		if items[i].Status == AgendaStatusActive {
			c := items[i]
			current = &c
			break
		}
	}
	// 关闭当前
	if current != nil {
		outcome := o.GenerateAgendaOutcome(ctx, current)
		now := NowMs()
		_ = o.repo.UpdateAgendaItem(current.ID, map[string]any{
			"status":   AgendaStatusDone,
			"outcome":  outcome,
			"ended_at": &now,
		})
		o.appendSystemMessage(fmt.Sprintf("议程 %d. %s 已完成。%s", current.Seq, current.Title, firstLine(outcome, 80)))
		o.broker.Emit(o.roomID, "room.agenda.update", map[string]any{
			"roomId": o.roomID, "itemId": current.ID,
			"patch": map[string]any{"status": AgendaStatusDone, "outcome": outcome, "endedAt": now},
		})
	}
	// 激活下一个 pending
	for i := range items {
		if items[i].Status == AgendaStatusPending {
			now := NowMs()
			_ = o.repo.UpdateAgendaItem(items[i].ID, map[string]any{
				"status":     AgendaStatusActive,
				"started_at": &now,
			})
			o.appendSystemMessage(fmt.Sprintf("▶ 进入议程 %d. %s", items[i].Seq, items[i].Title))
			o.broker.Emit(o.roomID, "room.agenda.update", map[string]any{
				"roomId": o.roomID, "itemId": items[i].ID,
				"patch": map[string]any{"status": AgendaStatusActive, "startedAt": now},
			})
			return items[i].ID, nil
		}
	}
	// 议程全走完
	o.appendSystemMessage("📋 所有议程已完成。可点『关闭会议』生成最终产出。")
	return "", nil
}

// ParkAgenda —— 把当前 active 议程项标记为 parked。
func (o *Orchestrator) ParkAgenda(ctx context.Context, itemID string) error {
	now := NowMs()
	if err := o.repo.UpdateAgendaItem(itemID, map[string]any{
		"status":   AgendaStatusParked,
		"ended_at": &now,
	}); err != nil {
		return err
	}
	o.broker.Emit(o.roomID, "room.agenda.update", map[string]any{
		"roomId": o.roomID, "itemId": itemID,
		"patch": map[string]any{"status": AgendaStatusParked, "endedAt": now},
	})
	return nil
}

// GenerateAgendaOutcome —— 给单个议项生成 100-200 字小结。
func (o *Orchestrator) GenerateAgendaOutcome(ctx context.Context, item *database.AgentRoomAgendaItem) string {
	synthesizer := o.pickSynthesizer()
	if synthesizer == nil {
		return ""
	}
	// 取该议项期间的消息（startedAt 之后）
	all, _ := o.repo.ListMessages(o.roomID, 0, 200)
	slice := all
	if item.StartedAt != nil {
		s := []database.AgentRoomMessage{}
		for _, m := range all {
			if m.Timestamp >= *item.StartedAt {
				s = append(s, m)
			}
		}
		slice = s
	}
	transcript := renderTranscript(slice, o.members)

	system := "你把一场会议的一个议项压缩成 120-200 字的小结。只输出正文，不要寒暄。"
	user := fmt.Sprintf("议项：%s\n目标：%s\n----\n时间线：\n%s\n----\n总结要点：1) 结论 2) 谁负责什么 3) 未决问题（如有）。",
		item.Title, item.TargetOutcome, transcript)
	res, err := o.nonStreamComplete(ctx, synthesizer, system, user, 500)
	if err != nil {
		logger.Log.Warn().Err(err).Msg("agentroom: agenda outcome failed")
		return ""
	}
	o.recordCloseoutUsage(res)
	return strings.TrimSpace(res.Text)
}

// ───────────────── Playbook auto-tag ─────────────────

// inferPlaybookTagsAndAppliesTo —— 从 extracted playbook 文本 + room template 推断 tags 和 applicable 触发词。
// 简单策略：取 template id 作第一个 applicable；tags 从 title + conclusion 里拎常见关键词。
// 真实场景可以加一次 LLM 调用，此版本省 token。
func (o *Orchestrator) inferPlaybookTagsAndAppliesTo(ex *ExtractedPlaybook) (tags []string, applies []string) {
	seen := map[string]bool{}
	addTag := func(t string) {
		t = strings.TrimSpace(t)
		if t == "" || seen[t] {
			return
		}
		seen[t] = true
		tags = append(tags, t)
	}

	if o.room.TemplateID != "" {
		addTag(o.room.TemplateID)
		applies = append(applies, o.room.TemplateID)
	}

	keywords := []string{
		"产品", "架构", "设计", "评审", "脑暴", "决策", "风险", "事故", "复盘",
		"上线", "发布", "调研", "竞品", "客户", "优化", "重构", "性能", "安全",
	}
	haystack := strings.ToLower(ex.Title + " " + ex.Problem + " " + ex.Approach + " " + ex.Conclusion)
	for _, k := range keywords {
		if strings.Contains(haystack, strings.ToLower(k)) {
			addTag(k)
			if len(tags) >= 8 {
				break
			}
		}
	}
	return tags, applies
}

func (o *Orchestrator) DeliverInterRoomBus(ctx context.Context, trigger string, bundle *OutcomeBundle) {
	if bundle == nil || strings.TrimSpace(o.room.Projection) == "" {
		return
	}
	var proj RoomProjection
	if err := json.Unmarshal([]byte(o.room.Projection), &proj); err != nil || len(proj.BusRoutes) == 0 {
		return
	}
	markerID := strings.TrimSpace(bundle.BundleArtifactID)
	if markerID == "" {
		if bundle.Retro != nil && bundle.Retro.GeneratedAt > 0 {
			markerID = fmt.Sprintf("retro-%s-%d", o.roomID, bundle.Retro.GeneratedAt)
		} else if bundle.PlaybookID != "" {
			markerID = "playbook-" + bundle.PlaybookID
		} else {
			markerID = fmt.Sprintf("event-%s-%d", o.roomID, NowMs())
		}
	}
	for _, route := range proj.BusRoutes {
		if ctx.Err() != nil {
			return
		}
		if !route.Enabled || strings.TrimSpace(route.Trigger) != trigger {
			continue
		}
		targetRoomID := strings.TrimSpace(route.TargetRoomID)
		if targetRoomID == "" || targetRoomID == o.roomID {
			continue
		}
		targetRoom, err := o.repo.GetRoom(targetRoomID)
		if err != nil || targetRoom == nil {
			continue
		}
		if targetRoom.OwnerUserID != o.room.OwnerUserID {
			continue
		}
		var targetProj RoomProjection
		if strings.TrimSpace(targetRoom.Projection) != "" {
			_ = json.Unmarshal([]byte(targetRoom.Projection), &targetProj)
		}
		looped := false
		for _, backRoute := range targetProj.BusRoutes {
			if backRoute.Enabled && strings.TrimSpace(backRoute.Trigger) == trigger && strings.TrimSpace(backRoute.TargetRoomID) == o.roomID {
				looped = true
				break
			}
		}
		if looped {
			continue
		}
		marker := fmt.Sprintf("[bus:%s:%s]", trigger, markerID)
		duplicated := false
		switch strings.TrimSpace(route.DeliveryMode) {
		case "task":
			tasks, err := o.repo.ListTasks(targetRoomID)
			if err != nil {
				continue
			}
			for _, task := range tasks {
				if strings.Contains(task.Text, marker) {
					duplicated = true
					break
				}
			}
		default:
			items, err := o.repo.ListAgendaItems(targetRoomID)
			if err != nil {
				continue
			}
			for _, item := range items {
				if strings.Contains(item.Description, marker) || strings.Contains(item.TargetOutcome, marker) {
					duplicated = true
					break
				}
			}
		}
		if duplicated {
			continue
		}
		title := strings.TrimSpace(route.TitleTemplate)
		if title == "" {
			title = "复盘来源会议产出：" + o.room.Title
		}
		title = strings.ReplaceAll(title, "{{sourceRoomTitle}}", o.room.Title)
		title = strings.ReplaceAll(title, "{{targetRoomTitle}}", targetRoom.Title)
		title = strings.ReplaceAll(title, "{{playbookId}}", bundle.PlaybookID)
		title = strings.TrimSpace(title)
		if title == "" {
			title = "复盘来源会议产出"
		}
		triggerLabel := "关闭仪式产出"
		if trigger == "retro.updated" {
			triggerLabel = "复盘更新"
		}
		targetOutcome := "评审来源会议的结论、行动项与复盘，决定是否纳入当前房间计划。"
		if bundle.Retro != nil && bundle.Retro.NextMeetingDraft != nil && strings.TrimSpace(bundle.Retro.NextMeetingDraft.Goal) != "" {
			targetOutcome = bundle.Retro.NextMeetingDraft.Goal + "\n" + marker
		} else {
			targetOutcome = targetOutcome + "\n" + marker
		}
		desc := strings.TrimSpace(route.Note)
		if desc != "" {
			desc += "\n\n"
		}
		desc += "来源事件：" + triggerLabel + "\n"
		desc += "来源房间：" + o.room.Title + "\n"
		desc += "来源 roomId：" + o.roomID + "\n"
		if bundle.BundleArtifactID != "" {
			desc += "产出总包：" + bundle.BundleArtifactID + "\n"
		}
		if bundle.PlaybookID != "" {
			desc += "关联 Playbook：" + bundle.PlaybookID + "\n"
		}
		if bundle.Retro != nil {
			desc += fmt.Sprintf("复盘评分：%d/100\n", bundle.Retro.ScoreOverall)
		}
		desc += marker
		if strings.TrimSpace(route.DeliveryMode) == "task" {
			taskText := title
			if desc != "" {
				taskText += "\n" + desc
			}
			t := &database.AgentRoomTask{RoomID: targetRoomID, Text: taskText, Status: "todo"}
			if err := o.repo.CreateTask(t); err != nil {
				logger.Log.Warn().Err(err).Str("source_room", o.roomID).Str("target_room", targetRoomID).Msg("agentroom: deliver inter-room bus task failed")
				continue
			}
			o.broker.Emit(targetRoomID, "room.task.append", map[string]any{
				"roomId": targetRoomID,
				"task":   TaskFromModel(t),
			})
			continue
		}
		ag := &database.AgentRoomAgendaItem{
			RoomID:        targetRoomID,
			Title:         title,
			Description:   desc,
			TargetOutcome: targetOutcome,
		}
		if err := o.repo.CreateAgendaItem(ag); err != nil {
			logger.Log.Warn().Err(err).Str("source_room", o.roomID).Str("target_room", targetRoomID).Msg("agentroom: deliver inter-room bus agenda failed")
			continue
		}
		o.broker.Emit(targetRoomID, "room.agenda.append", map[string]any{
			"roomId": targetRoomID,
			"item":   AgendaItemFromModel(ag),
		})
	}
}

// ───────────────── Agenda protocol 注入 —————————————————
//
// buildAgendaProtocolBlock —— 被 buildContextPrompt 调用，返回注入 system prompt 的议程协议段。
// 当房间有 active 议项时，提醒 agent "只讨论当前议项、跑题进 parking lot、自判何时收敛"。
func (o *Orchestrator) buildAgendaProtocolBlock() string {
	items, err := o.repo.ListAgendaItems(o.roomID)
	if err != nil || len(items) == 0 {
		return ""
	}
	var active *database.AgentRoomAgendaItem
	total := len(items)
	doneCnt := 0
	activeIdx := -1
	sortedItems := items
	sort.Slice(sortedItems, func(i, j int) bool { return sortedItems[i].Seq < sortedItems[j].Seq })
	for i := range sortedItems {
		if sortedItems[i].Status == AgendaStatusDone {
			doneCnt++
		}
		if sortedItems[i].Status == AgendaStatusActive && active == nil {
			c := sortedItems[i]
			active = &c
			activeIdx = i + 1
		}
	}
	if active == nil {
		return ""
	}

	// 议程协议模板 —— 可在 RoomTuningModal "人设文案" 覆盖 AgendaProtocol 字段。
	return o.renderPrompt(
		func(p *PromptPack) string { return p.AgendaProtocol },
		map[string]any{
			"ActiveIdx":     activeIdx,
			"Total":         total,
			"AgendaTitle":   active.Title,
			"TargetOutcome": active.TargetOutcome,
			"HasBudget":     active.RoundBudget > 0,
			"RoundBudget":   active.RoundBudget,
			"RoundsUsed":    active.RoundsUsed,
		},
	)
}

// ───────────────── Helpers ─────────────────

func firstLine(s string, max int) string {
	s = strings.TrimSpace(s)
	if nl := strings.IndexByte(s, '\n'); nl >= 0 {
		s = s[:nl]
	}
	r := []rune(s)
	if len(r) > max {
		return string(r[:max]) + "…"
	}
	return s
}

func trimRunes(s string, max int) string {
	r := []rune(strings.TrimSpace(s))
	if len(r) <= max {
		return string(r)
	}
	return string(r[:max]) + "…"
}

func trimStringSlice(ss []string, maxN, perMax int) []string {
	out := make([]string, 0, len(ss))
	for i, s := range ss {
		if i >= maxN {
			break
		}
		v := trimRunes(s, perMax)
		if v != "" {
			out = append(out, v)
		}
	}
	return out
}

func memberNameMap(ms []database.AgentRoomMember) map[string]string {
	m := map[string]string{}
	for _, x := range ms {
		m[x.ID] = x.Name
	}
	return m
}

func firstSynthesizerID(ms []database.AgentRoomMember) string {
	for _, m := range ms {
		if m.Kind == "agent" && !m.IsKicked && m.IsModerator {
			return m.ID
		}
	}
	for _, m := range ms {
		if m.Kind == "agent" && !m.IsKicked {
			return m.ID
		}
	}
	return ""
}

func roomOwnerUserID(r *Repo, roomID string) uint {
	rm, err := r.GetRoom(roomID)
	if err != nil || rm == nil {
		return 0
	}
	return rm.OwnerUserID
}

func roleNames(ms []database.AgentRoomMember) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, m := range ms {
		if m.Kind == "agent" && m.Role != "" && !seen[m.Role] {
			seen[m.Role] = true
			out = append(out, m.Role)
		}
	}
	return out
}
