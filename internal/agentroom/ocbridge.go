// ocbridge.go — OpenClaw Gateway RPC 桥接层（v0.4 全量替换 llmdirect）
//
// 职责：把 AgentRoom 需要的"执行一次 agent 发言"翻译成 OpenClaw Gateway 的
// JSON-RPC 调用，并把 session 历史里产生的新回复 / 工具调用 / 流式增量
// 流回给 orchestrator。
//
// 设计约束（DESIGN.md v0.4 / 方案 A 全量替换）：
//   - AgentRoom 不再直接调 LLM API；所有 agent 执行都走 OpenClaw agent RPC
//   - OpenClaw 负责工具调用、审批、长上下文压缩、provider 管理
//   - ClawDeckX 仍掌控调度、预算、房间状态机、UI 广播
//   - 每个 room 成员绑定一个持久化 session：agent:<agentID>:agentroom:<roomID>:<memberID>
//     房间创建时 EnsureSession 预建；房间删除时 DeleteSession 清理。
//
// RPC 调用（对齐 openclaw/src/gateway/server-methods/*）:
//   - agent              { sessionKey, message, model, thinking, timeout,
//     extraSystemPrompt, idempotencyKey(必填), ... }
//     → { runId } 触发异步执行
//   - agent.wait         { runId, timeoutMs } → 等待 runId 完成
//   - sessions.create    { key, agentId, model, thinkingLevel, label } → 新建 session
//   - sessions.patch     { key, label, thinkingLevel, model, ... }
//     （注意：agentId / extraSystemPrompt 已不再接受；thinking 改名为 thinkingLevel）
//   - sessions.delete    { key, deleteTranscript, emitLifecycleHooks }
//   - sessions.get       { key, limit } → { messages: [...] } 读取 transcript
//     （替代早期 sessions.history；响应不再含 total，用 messages 长度判定）
//   - agents.list        → 获取可用 agent id 列表，供前端 Member 编辑器
package agentroom

import (
	"context"
	cryptorand "crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"ClawDeckX/internal/logger"
	"ClawDeckX/internal/openclaw"
)

// cryptoRandRead 是 crypto/rand.Read 的薄封装，方便单元测试替换。
var cryptoRandRead = cryptorand.Read

// Bridge 封装了对 OpenClaw Gateway 的所有调用。所有方法都是线程安全的
// （委托给 GWClient.Request）。
type Bridge struct {
	gw *openclaw.GWClient
	// v0.4：实时压缩事件总线（manager 注入）。Run 生命周期内按 sessionKey
	// 订阅一次，用于在 gateway 广播 auto_compaction_* 事件时立即回调
	// req.OnCompaction，比 history polling 更快（~100ms vs ~500ms）。
	compactionBus *CompactionBus
	// v0.4：OpenClaw 的默认 agent id 缓存（对应 agents.list payload 的 defaultId 字段）。
	// 以往硬编码成 "default" 会让 OpenClaw 自动创建一个名为 "default" 的影子 agent，
	// 导致"智能代理"列表里多出一条。现改为先查 defaultId，未知时才回退。
	defaultAgentMu sync.RWMutex
	defaultAgentID string
	defaultAgentAt time.Time
}

// NewBridge 创建一个 bridge 实例。gw 可为 nil（测试 / gateway 未启动时），
// 此时所有调用返回 ErrGatewayUnavailable。
func NewBridge(gw *openclaw.GWClient) *Bridge {
	return &Bridge{gw: gw}
}

// SetCompactionBus 注入实时压缩事件总线。Manager 构造时调用一次。
func (b *Bridge) SetCompactionBus(bus *CompactionBus) {
	if b == nil {
		return
	}
	b.compactionBus = bus
}

// ErrGatewayUnavailable 在 gw 为 nil 或未连接时返回。
var ErrGatewayUnavailable = errors.New("openclaw gateway not connected")

// IsAvailable 检查 gateway 是否可用。
func (b *Bridge) IsAvailable() bool {
	return b != nil && b.gw != nil && b.gw.IsConnected()
}

// ── Session lifecycle ──────────────────────────────────────────────

// SessionKeyFor 构造某 member 的持久化 OpenClaw session key。
// 约定：agent:<agentID>:agentroom:<roomID>:<memberID>
// agentID 未配置时退化为 "default"（只用于 key，不会触发 agent 新建）。
func SessionKeyFor(agentID, roomID, memberID string) string {
	a := strings.TrimSpace(agentID)
	if a == "" {
		a = "default"
	}
	return fmt.Sprintf("agent:%s:agentroom:%s:%s", a, roomID, memberID)
}

// DefaultAgentID 返回 OpenClaw 当前配置的默认 agent id（对应 agents.list 的 defaultId）。
// 缓存 60s 后失效；gateway 不可用或 defaultId 缺失时返回 "main"（OpenClaw 常规默认名），
// 最差也不会返回空串 —— 避免继续走硬编码 "default" 这条路径造成幽灵 agent。
func (b *Bridge) DefaultAgentID(ctx context.Context) string {
	if b == nil {
		return "main"
	}
	b.defaultAgentMu.RLock()
	cached := b.defaultAgentID
	fresh := !b.defaultAgentAt.IsZero() && time.Since(b.defaultAgentAt) < 60*time.Second
	b.defaultAgentMu.RUnlock()
	if fresh && cached != "" {
		return cached
	}
	if !b.IsAvailable() {
		if cached != "" {
			return cached
		}
		return "main"
	}
	resp, err := b.gw.RequestWithTimeout("agents.list", map[string]interface{}{}, 5*time.Second)
	if err != nil {
		if cached != "" {
			return cached
		}
		return "main"
	}
	var wrapped struct {
		DefaultID string `json:"defaultId"`
	}
	_ = json.Unmarshal(resp, &wrapped)
	id := strings.TrimSpace(wrapped.DefaultID)
	if id == "" {
		id = "main"
	}
	b.defaultAgentMu.Lock()
	b.defaultAgentID = id
	b.defaultAgentAt = time.Now()
	b.defaultAgentMu.Unlock()
	return id
}

// EnsureSessionParams —— 预建或更新 OpenClaw session 元数据。
type EnsureSessionParams struct {
	Key          string
	AgentID      string
	Model        string // 空 = 使用 agent 默认模型
	Thinking     string // 空 = 使用 agent 默认
	Label        string
	SystemPrompt string // 注入为 session 级 extraSystemPrompt
}

// EnsureSession 预建或更新 session。成员第一次加入房间时调用；Model/Thinking
// 变更时再调用一次即可（幂等 upsert）。
//
// OpenClaw 协议约束：
//   - agentId 只能在 sessions.create 时绑定；sessions.patch 不再接受 agentId
//   - extraSystemPrompt 改为每轮 agent RPC 时传入（session 级已不再接受）
//   - thinking 参数改名为 thinkingLevel
//
// 实现策略：优先 sessions.create（带 agentId）；若 session 已存在，回退到
// sessions.patch 只更新 label/model/thinkingLevel。
func (b *Bridge) EnsureSession(ctx context.Context, p EnsureSessionParams) error {
	if !b.IsAvailable() {
		return ErrGatewayUnavailable
	}
	// 1) 先尝试 sessions.create
	createParams := map[string]interface{}{
		"key": p.Key,
	}
	if strings.TrimSpace(p.AgentID) != "" {
		createParams["agentId"] = p.AgentID
	}
	if strings.TrimSpace(p.Model) != "" {
		createParams["model"] = p.Model
	}
	if strings.TrimSpace(p.Thinking) != "" {
		createParams["thinkingLevel"] = p.Thinking
	}
	if strings.TrimSpace(p.Label) != "" {
		createParams["label"] = p.Label
	}
	_, err := b.gw.RequestWithTimeout("sessions.create", createParams, 10*time.Second)
	if err == nil {
		return nil
	}
	// 2) 已存在则走 patch 更新可变字段（丢弃 agentId —— 想换 agent 应换 session key）
	//    其它不兼容错误直接抛出。
	errMsg := err.Error()
	if !strings.Contains(strings.ToLower(errMsg), "exist") &&
		!strings.Contains(strings.ToLower(errMsg), "already") &&
		!strings.Contains(strings.ToLower(errMsg), "conflict") {
		return fmt.Errorf("sessions.create %s: %w", p.Key, err)
	}
	patchParams := map[string]interface{}{
		"key": p.Key,
	}
	if strings.TrimSpace(p.Model) != "" {
		patchParams["model"] = p.Model
	}
	if strings.TrimSpace(p.Thinking) != "" {
		patchParams["thinkingLevel"] = p.Thinking
	}
	if strings.TrimSpace(p.Label) != "" {
		patchParams["label"] = p.Label
	}
	if len(patchParams) == 1 {
		// 只有 key，没什么可 patch 的 —— 就认为 session 已 ok
		return nil
	}
	if _, perr := b.gw.RequestWithTimeout("sessions.patch", patchParams, 10*time.Second); perr != nil {
		return fmt.Errorf("sessions.patch %s: %w", p.Key, perr)
	}
	return nil
}

// newIdempotencyKey 生成一次 agent / chat RPC 用的 idempotency key。
// OpenClaw ≥2026.x 强制要求该字段非空；重试同一逻辑调用可复用同一 key 让服务端去重。
func newIdempotencyKey() string {
	var b [12]byte
	if _, err := cryptoRandRead(b[:]); err != nil {
		// 兜底：时间戳 + 进程内递增
		return fmt.Sprintf("ck-%d", time.Now().UnixNano())
	}
	return fmt.Sprintf("ck-%x", b[:])
}

// DeleteSession 彻底移除 OpenClaw 侧的 session（含 transcript）。
// 房间删除 / 踢出成员时调用。Best-effort：返回 error 仅打 log，不阻塞房间删除。
func (b *Bridge) DeleteSession(ctx context.Context, key string) error {
	if !b.IsAvailable() {
		return ErrGatewayUnavailable
	}
	_, err := b.gw.RequestWithTimeout("sessions.delete", map[string]interface{}{
		"key":                key,
		"deleteTranscript":   true,
		"emitLifecycleHooks": false,
	}, 10*time.Second)
	if err != nil {
		return fmt.Errorf("sessions.delete %s: %w", key, err)
	}
	return nil
}

// ── Agent run ───────────────────────────────────────────────────────

// RunRequest 是一次 agent 执行的入参。
type RunRequest struct {
	SessionKey        string // 目标 session（必填）
	Message           string // 本轮用户消息（通常是 orchestrator 合成的触发 prompt；仅图片消息时可为空）
	Model             string // 可选：运行时模型覆盖
	Thinking          string // 可选：thinking 级别 off/low/medium/high
	ExtraSystemPrompt string // 可选：本轮额外 system prompt（房间上下文 / 协作风格）
	TimeoutSeconds    int    // 0 = 使用 bridge 默认 180s；最大 600s
	// v0.9.1 图片附件 —— 透传给 OpenClaw `agent` RPC 的 attachments 参数（见 src/gateway/server-methods/agent.ts）。
	// OpenClaw 会把它们经 normalizeRpcAttachmentsToChatAttachments → parseMessageWithAttachments
	// 翻译成多模态 content block 注入给 LLM；仅 supportsImages 的模型才能真正"看到"图片。
	Attachments []MessageAttachment
	// OnCompaction 可选：当 bridge 在 history 中检测到 OpenClaw 上下文压缩时回调，
	// phase = "start" | "end"，summary 为压缩产物（仅 end 时可能有）。
	// 启发式检测基于 role="compactionSummary" 标记条目；一次 Run 最多触发一次 end。
	OnCompaction func(phase string, summary string)
}

// RunResult 是一次 agent 执行的最终输出。
type RunResult struct {
	RunID          string
	Text           string // 最终 assistant 文本（已去除 tool call fence）
	Model          string // 实际使用的 model
	TokensPrompt   int
	TokensComplete int
	ToolCalls      []ToolCallSummary // OpenClaw 实际执行过的工具列表（只读，供 UI 展示）
	DurationMs     int64
}

// ToolCallSummary 是 OpenClaw 本轮执行的单个工具的摘要。
type ToolCallSummary struct {
	Name       string `json:"name"`
	ArgsJSON   string `json:"args,omitempty"`
	ResultText string `json:"result,omitempty"`
	IsError    bool   `json:"isError,omitempty"`
	DurationMs int64  `json:"durationMs,omitempty"`
}

// StreamCallback 在 RunAgent 执行过程中被反复调用，用于流式增量 UI 广播。
// partial 为目前积累的 assistant 文本（不含 tool call 原文）。
// phase 表示当前阶段："thinking" / "speaking" / "tool" / "done"。
type StreamCallback func(partial string, phase string)

// RunAgent 执行一次完整的 agent 回合：发起 agent 请求 → 等待 runId 完成
// → 读 session 历史拿到最终回复。执行过程中每隔 pollInterval 轮询 history，
// 通过 onStream 回调推送增量更新。
func (b *Bridge) RunAgent(ctx context.Context, req RunRequest, onStream StreamCallback) (*RunResult, error) {
	if !b.IsAvailable() {
		return nil, ErrGatewayUnavailable
	}
	if strings.TrimSpace(req.SessionKey) == "" {
		return nil, errors.New("ocbridge: SessionKey required")
	}
	// v0.9.1：允许 Message 为空但带 Attachments（"仅图片"消息）。二者都空才是无效请求。
	if strings.TrimSpace(req.Message) == "" && len(req.Attachments) == 0 {
		return nil, errors.New("ocbridge: Message or Attachments required")
	}

	timeoutSec := req.TimeoutSeconds
	if timeoutSec <= 0 {
		timeoutSec = 180
	}
	if timeoutSec > 600 {
		timeoutSec = 600
	}

	started := time.Now()

	// 1) 读取基线快照：用于对比 new assistant reply。
	baselineCount, _ := b.readHistoryCount(req.SessionKey)

	// 2) 触发 agent 执行（异步，拿到 runId）
	//    OpenClaw ≥2026.x 起 `agent` schema 强制 idempotencyKey 非空。
	agentParams := map[string]interface{}{
		"sessionKey":     req.SessionKey,
		"message":        req.Message,
		"deliver":        false,
		"timeout":        0, // async
		"idempotencyKey": newIdempotencyKey(),
	}
	if strings.TrimSpace(req.Model) != "" {
		agentParams["model"] = req.Model
	}
	if strings.TrimSpace(req.Thinking) != "" {
		agentParams["thinking"] = req.Thinking
	}
	if strings.TrimSpace(req.ExtraSystemPrompt) != "" {
		agentParams["extraSystemPrompt"] = req.ExtraSystemPrompt
	}
	// v0.9.1：图片附件透传给 OpenClaw `agent` RPC。格式对齐 OpenClaw schema：
	// attachments: Array<{ type, mimeType, fileName, content }> （content 为 base64 原文）。
	// 空数组不发送，避免 OpenClaw 侧额外走一趟 normalizeRpcAttachmentsToChatAttachments 空路径。
	if len(req.Attachments) > 0 {
		attach := make([]map[string]any, 0, len(req.Attachments))
		for _, a := range req.Attachments {
			entry := map[string]any{
				"type":    a.Type,
				"content": a.Content,
			}
			if a.MimeType != "" {
				entry["mimeType"] = a.MimeType
			}
			if a.FileName != "" {
				entry["fileName"] = a.FileName
			}
			attach = append(attach, entry)
		}
		agentParams["attachments"] = attach
	}
	resp, err := b.gw.RequestWithTimeout("agent", agentParams, 15*time.Second)
	if err != nil {
		return nil, fmt.Errorf("agent rpc: %w", err)
	}
	var startResp struct {
		RunID string `json:"runId"`
	}
	_ = json.Unmarshal(resp, &startResp)
	if startResp.RunID == "" {
		return nil, errors.New("ocbridge: gateway did not return runId")
	}
	runID := startResp.RunID

	// 3) 并行：等待 runId 完成 + 流式轮询 history 推送增量。
	done := make(chan error, 1)
	go func() {
		_, waitErr := b.gw.RequestWithTimeout("agent.wait", map[string]interface{}{
			"runId":     runID,
			"timeoutMs": timeoutSec * 1000,
		}, time.Duration(timeoutSec+10)*time.Second)
		done <- waitErr
	}()

	pollInterval := 500 * time.Millisecond
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

	if onStream != nil {
		onStream("", "thinking")
	}

	var lastPartial string
	// v0.4：compaction emit 去重 —— real-time（bus）与 polling（history） 两条
	// 路径任意一条先触发，另一条自动变 no-op。start 和 end 各自独立 Once。
	var (
		compactionStartOnce sync.Once
		compactionEndOnce   sync.Once
		compactionStarted   bool // 读：bridge 内部 polling 判断是否已 start
	)
	emitCompactionStart := func() {
		if req.OnCompaction == nil {
			return
		}
		compactionStartOnce.Do(func() {
			compactionStarted = true
			req.OnCompaction("start", "")
		})
	}
	emitCompactionEnd := func(summary string) {
		if req.OnCompaction == nil {
			return
		}
		// 为保持原有"无 start 不发 end"语义，这里校验 compactionStarted
		if !compactionStarted {
			return
		}
		compactionEndOnce.Do(func() {
			req.OnCompaction("end", summary)
		})
	}

	// v0.4：实时路径 —— 把 gateway `agent` 事件流里的 auto_compaction_* 事件
	// 直接路由到上面两个 emit。注意它们是 Once，不会和 polling 路径重复 fire。
	if b.compactionBus != nil && req.OnCompaction != nil && req.SessionKey != "" {
		b.compactionBus.Subscribe(req.SessionKey, func(phase, summary string, willRetry bool) {
			// willRetry 目前未暴露给 orchestrator（OnCompaction 签名是 phase+summary）。
			// 如需感知重试决策，后续可扩 OnCompaction 签名或通过 context 传递。
			_ = willRetry
			switch phase {
			case "start":
				emitCompactionStart()
			case "end":
				// end 事件可能先于 start 抵达（OpenClaw 老版本一次性发 summary），
				// 这种场景下补一个 start，让 UI 横幅体验完整。
				emitCompactionStart()
				emitCompactionEnd(summary)
			}
		})
		defer b.compactionBus.Unsubscribe(req.SessionKey)
	}

	for {
		select {
		case <-ctx.Done():
			// 被取消：尽力打捞已写入 session 的 partial assistant 文本，当作部分成功返回。
			if summary, ok := b.detectCompactionSummary(req.SessionKey, baselineCount); ok {
				emitCompactionStart()
				emitCompactionEnd(summary)
			}
			if salvaged := b.salvagePartial(req.SessionKey, baselineCount, runID, started, "canceled"); salvaged != nil {
				return salvaged, ctx.Err()
			}
			return nil, ctx.Err()
		case err := <-done:
			if err != nil {
				if summary, ok := b.detectCompactionSummary(req.SessionKey, baselineCount); ok {
					emitCompactionStart()
					emitCompactionEnd(summary)
				}
				// agent.wait 失败（超时 / provider 报错 / 取消）：尝试打捞 partial + 附加 friendly hint。
				salvaged := b.salvagePartial(req.SessionKey, baselineCount, runID, started, "error")
				friendly := friendlyBridgeError(err)
				if salvaged != nil {
					return salvaged, fmt.Errorf("agent.wait %s: %w", runID, friendly)
				}
				return nil, fmt.Errorf("agent.wait %s: %w", runID, friendly)
			}
			// 完成前最后一次检测 compaction 标记。
			if summary, ok := b.detectCompactionSummary(req.SessionKey, baselineCount); ok {
				emitCompactionStart()
				emitCompactionEnd(summary)
			}
			// 完成：最终读一次
			result, readErr := b.readLatestReply(req.SessionKey, baselineCount)
			if readErr != nil {
				// 正常完成但 history 读不到内容 —— 兜底打捞 lastPartial（流里已经拿到的文本）
				if strings.TrimSpace(lastPartial) != "" {
					return &RunResult{
						RunID:      runID,
						Text:       lastPartial,
						DurationMs: time.Since(started).Milliseconds(),
					}, nil
				}
				return nil, readErr
			}
			result.RunID = runID
			result.DurationMs = time.Since(started).Milliseconds()
			if onStream != nil {
				onStream(result.Text, "done")
			}
			return result, nil
		case <-ticker.C:
			// 每次心跳：先检测 compaction 标记（出现过即发 start）。
			if !compactionStarted && req.OnCompaction != nil {
				if _, ok := b.detectCompactionSummary(req.SessionKey, baselineCount); ok {
					emitCompactionStart()
				}
			}
			if onStream != nil {
				partial, phase, _ := b.readPartialReply(req.SessionKey, baselineCount)
				if partial != lastPartial && partial != "" {
					lastPartial = partial
					onStream(partial, phase)
				}
			}
		}
	}
}

// salvagePartial 在出错/取消时尽力读出 session 里已持久化的 assistant 文本，
// 让 UI 至少能保留用户看到的流式内容（类似 Sessions.tsx state:'error' 的 partialText 处理）。
// 读不到 / 文本为空返回 nil。
func (b *Bridge) salvagePartial(sessionKey string, baseline int, runID string, started time.Time, reason string) *RunResult {
	defer func() {
		if r := recover(); r != nil {
			logger.Log.Warn().Interface("panic", r).Msg("salvagePartial recover")
		}
	}()
	result, err := b.readLatestReply(sessionKey, baseline)
	if err != nil || result == nil || strings.TrimSpace(result.Text) == "" {
		return nil
	}
	result.RunID = runID
	result.DurationMs = time.Since(started).Milliseconds()
	// 附加一个 reason 前缀，方便 orchestrator 判断（也会被 UI 显示）
	if reason != "" {
		result.Text = strings.TrimRight(result.Text, "\n") + fmt.Sprintf("\n\n_(partial — %s)_", reason)
	}
	return result
}

// friendlyBridgeError 把 OpenClaw gateway 返回的原始错误字符串翻译为
// 用户看得懂的提示（HTTP 状态码 / rate limit / auth 等）。
// 参考 Sessions.tsx `state:'error'` 路径的 hint 表。
func friendlyBridgeError(err error) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	lower := strings.ToLower(msg)
	// HTTP code hints
	hints := map[string]string{
		"401": "API key 无效或已过期",
		"403": "访问被拒绝 —— 检查 API key 权限或模型可用性",
		"429": "被限流 —— 请求太频繁，稍后重试",
		"500": "模型服务内部错误",
		"502": "模型服务不可达",
		"503": "模型服务暂不可用",
		"504": "模型服务响应超时",
	}
	for code, hint := range hints {
		if strings.Contains(msg, code) && !strings.Contains(msg, hint) {
			return fmt.Errorf("%s（%s）", msg, hint)
		}
	}
	// 超时
	if strings.Contains(lower, "timeout") || strings.Contains(lower, "deadline") {
		if !strings.Contains(msg, "超时") {
			return fmt.Errorf("%s（请求超时，可能是模型在长时间思考或工具执行）", msg)
		}
	}
	// Rate limit
	if strings.Contains(lower, "rate limit") || strings.Contains(lower, "rate-limit") {
		if !strings.Contains(msg, "限流") {
			return fmt.Errorf("%s（被限流，请稍后重试）", msg)
		}
	}
	// Context length
	if strings.Contains(lower, "context") && (strings.Contains(lower, "length") || strings.Contains(lower, "window") || strings.Contains(lower, "exceed")) {
		if !strings.Contains(msg, "上下文") {
			return fmt.Errorf("%s（上下文超限，建议压缩房间历史或派生新房间）", msg)
		}
	}
	return err
}

// ── History reading ────────────────────────────────────────────────

// readHistoryCount 读取某 session 当前的消息条数（基线快照）。
// OpenClaw ≥2026.x 起只有 sessions.get，响应无 total，用 messages 长度代替。
func (b *Bridge) readHistoryCount(sessionKey string) (int, error) {
	entries, total, err := b.fetchHistorySince(sessionKey, 0, 0)
	if err != nil {
		return 0, err
	}
	if total > 0 {
		return total, nil
	}
	return len(entries), nil
}

// sessionHistoryEntry 是 OpenClaw sessions.get 返回后归一化成的单条消息。
// 原始 transcript 格式 content 可能是 string 或 [{type,text}]；这里统一拍平成 string。
type sessionHistoryEntry struct {
	ID       string
	Role     string
	Content  string
	ToolName string
	ToolArgs string
	// IsError：OpenClaw transcript 当前不落这个字段，保留为兼容位。
	// 真正的失败判定在 detectToolErrorFromContent() 里做内容启发（找 Error:/Traceback/Exception 等）。
	IsError   bool
	Kind      string
	CreatedAt int64
	Streaming bool
	Tokens    struct {
		Prompt   int
		Complete int
	}
	Model string
}

// rawTranscriptMessage 对应 OpenClaw sessions.get 的 messages[] 原始结构。
// 字段宽松匹配 —— OpenClaw 不同版本/角色下结构不完全一致，用 json.RawMessage 接住 content 再解析。
type rawTranscriptMessage struct {
	Role     string          `json:"role"`
	Content  json.RawMessage `json:"content"`
	Name     string          `json:"name,omitempty"` // 工具消息名
	ToolName string          `json:"toolName,omitempty"`
	ToolArgs json.RawMessage `json:"toolArgs,omitempty"`
	// 注：OpenClaw 的 sessions.get transcript 并没有稳定的 "toolOk / success" 字段——
	// 工具错误信号走 live WS "tool" 事件里的 `isError:true`，不落盘到 transcript。
	// 早期 ClawDeckX 解析 `toolOk` 后取反来判定失败，结果 transcript 里永远没这字段 → 每个
	// 工具都被错误打成 "failure"。这里保留 IsError 作为兼容字段（OpenClaw 未来若补上就用），
	// 默认 omitempty；实际判定在 normalize 后用 detectToolErrorFromContent() 做内容启发。
	IsError   bool   `json:"isError,omitempty"`
	Kind      string `json:"kind,omitempty"`
	Model     string `json:"model,omitempty"`
	Streaming bool   `json:"streaming,omitempty"`
	Timestamp int64  `json:"timestamp,omitempty"`
	CreatedAt int64  `json:"createdAt,omitempty"`
	Usage     struct {
		// OpenClaw 正规格式（normalizeUsage 输出）
		Input      int `json:"input,omitempty"`
		Output     int `json:"output,omitempty"`
		CacheRead  int `json:"cacheRead,omitempty"`
		CacheWrite int `json:"cacheWrite,omitempty"`
		TotalTk    int `json:"totalTokens,omitempty"`
		// 兼容：部分 provider SDK 直出的别名
		InputTokens  int `json:"inputTokens,omitempty"`
		OutputTokens int `json:"outputTokens,omitempty"`
		PromptTokens int `json:"promptTokens,omitempty"`
		CompletionTk int `json:"completionTokens,omitempty"`
		// OpenClaw cost 子对象
		Cost *struct {
			Total float64 `json:"total,omitempty"`
		} `json:"cost,omitempty"`
	} `json:"usage,omitempty"`
	OpenClaw *struct {
		ID   string `json:"id,omitempty"`
		Seq  int    `json:"seq,omitempty"`
		Kind string `json:"kind,omitempty"`
	} `json:"__openclaw,omitempty"`
}

// flattenTranscriptContent 把 OpenClaw transcript 的 content（string 或 [{type,text}]）
// 拍平成单一字符串。对非文本 part 直接忽略（图像 / 工具调用占位符等）。
func flattenTranscriptContent(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	// 直接字符串
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	// 数组形式：[{type:"text", text:"..."}, ...]
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &parts); err == nil {
		var sb strings.Builder
		for _, p := range parts {
			if p.Text != "" {
				if sb.Len() > 0 {
					sb.WriteString("\n")
				}
				sb.WriteString(p.Text)
			}
		}
		return sb.String()
	}
	return ""
}

// detectToolErrorFromContent 用启发式判断一段工具输出是否代表"调用失败"。
//
// 背景：OpenClaw sessions.get 的 transcript 里 role=tool 的消息没有稳定的 ok/isError
// 字段——工具执行的错误信号由 live WS 事件 (tool.phase=result, isError=true) 推送，
// 不落盘到 transcript。但 ClawDeckX orchestrator 只读 transcript，只能从内容猜。
//
// 规则（保守）：
//   - 明确的 Python Traceback / JavaScript Stack / ToolError / "Error:" 前缀 → 失败
//   - 明确标记 ok=false / "success": false JSON → 失败
//   - 其余（包括普通文本、JSON、二进制、空结果）→ 成功
//
// 宁愿把"实际失败但被我们误判成功"显示成中性结果，也不要像之前那样把 29/29 个成功
// 全部显示成红色失败。真实要失败判定请推后端在 transcript 里补 isError 字段，或走
// live WS tool 事件更新 toolStatus。
func detectToolErrorFromContent(content string) bool {
	if content == "" {
		return false
	}
	head := strings.TrimSpace(content)
	if len(head) > 256 {
		head = head[:256]
	}
	lower := strings.ToLower(head)
	// 明确错误前缀
	errorPrefixes := []string{
		"traceback (most recent call last)",
		"traceback:",
		"error:",
		"exception:",
		"fatal:",
		"toolerror:",
		"panic:",
		"assertionerror:",
	}
	for _, p := range errorPrefixes {
		if strings.HasPrefix(lower, p) {
			return true
		}
	}
	// JSON 显式 ok/success:false
	if strings.HasPrefix(head, "{") {
		if strings.Contains(lower, `"ok":false`) || strings.Contains(lower, `"success":false`) {
			return true
		}
		if strings.Contains(lower, `"iserror":true`) {
			return true
		}
	}
	return false
}

// normalizeRawTranscript 把一条原始 transcript 消息规整成 sessionHistoryEntry。
func normalizeRawTranscript(raw rawTranscriptMessage) sessionHistoryEntry {
	e := sessionHistoryEntry{
		Role:      raw.Role,
		Content:   flattenTranscriptContent(raw.Content),
		ToolName:  raw.ToolName,
		IsError:   raw.IsError,
		Kind:      raw.Kind,
		Model:     raw.Model,
		Streaming: raw.Streaming,
		CreatedAt: raw.CreatedAt,
	}
	if e.CreatedAt == 0 {
		e.CreatedAt = raw.Timestamp
	}
	if e.ToolName == "" && raw.Role == "tool" {
		e.ToolName = raw.Name
	}
	if len(raw.ToolArgs) > 0 {
		e.ToolArgs = string(raw.ToolArgs)
	}
	if raw.OpenClaw != nil {
		e.ID = raw.OpenClaw.ID
		if e.Kind == "" {
			e.Kind = raw.OpenClaw.Kind
		}
	}
	// Usage 规整：优先读 OpenClaw 正规格式（input/output），再 fallback 到 SDK 别名。
	// OpenClaw normalizeUsage 将 input 定义为"去除 cacheRead 的净 prompt"，
	// 所以 Prompt = input + cacheRead，与 runAgentTurn 的 promptTokens 口径一致。
	if raw.Usage.Input > 0 {
		e.Tokens.Prompt = raw.Usage.Input + raw.Usage.CacheRead
	} else if raw.Usage.InputTokens > 0 {
		e.Tokens.Prompt = raw.Usage.InputTokens
	} else if raw.Usage.PromptTokens > 0 {
		e.Tokens.Prompt = raw.Usage.PromptTokens
	}
	if raw.Usage.Output > 0 {
		e.Tokens.Complete = raw.Usage.Output
	} else if raw.Usage.OutputTokens > 0 {
		e.Tokens.Complete = raw.Usage.OutputTokens
	} else if raw.Usage.CompletionTk > 0 {
		e.Tokens.Complete = raw.Usage.CompletionTk
	}
	return e
}

// readPartialReply 读取当前进行中的 assistant 回复（可能带 streaming 标志）。
// 用于 onStream 回调推送增量。
func (b *Bridge) readPartialReply(sessionKey string, baseline int) (string, string, error) {
	entries, _, err := b.fetchHistorySince(sessionKey, baseline, 20)
	if err != nil {
		return "", "speaking", err
	}
	// 从最新往前找：最新一条 assistant 文本 = 当前在写的那条
	for i := len(entries) - 1; i >= 0; i-- {
		e := entries[i]
		if e.Role == "assistant" && strings.TrimSpace(e.Content) != "" {
			phase := "speaking"
			if e.Streaming {
				phase = "speaking"
			}
			return e.Content, phase, nil
		}
		if e.Role == "tool" || e.ToolName != "" {
			return "", "tool", nil
		}
	}
	return "", "thinking", nil
}

// readLatestReply 读取 baseline 之后的所有新消息，组装成最终 RunResult。
// 同时返回检测到的 compactionSummary（若有）——调用方可据此触发 OnCompaction。
func (b *Bridge) readLatestReply(sessionKey string, baseline int) (*RunResult, error) {
	entries, _, err := b.fetchHistorySince(sessionKey, baseline, 50)
	if err != nil {
		return nil, err
	}

	result := &RunResult{}
	var textBuilder strings.Builder

	for _, e := range entries {
		switch {
		case e.Role == "assistant" && strings.TrimSpace(e.Content) != "":
			// 最新的 assistant 文本取 last（覆盖之前的 partial 片段）
			textBuilder.Reset()
			textBuilder.WriteString(e.Content)
			if e.Tokens.Prompt > 0 {
				result.TokensPrompt = e.Tokens.Prompt
			}
			if e.Tokens.Complete > 0 {
				result.TokensComplete = e.Tokens.Complete
			}
			if e.Model != "" {
				result.Model = e.Model
			}
		case e.Role == "tool" || e.ToolName != "":
			// v0.9：默认 success。OpenClaw transcript 没有稳定的 ok/error 字段，
			// 除非 (a) 我们从 raw 拿到明确 isError=true，或 (b) 内容启发命中典型错误关键字，
			// 才标记失败。否则一律按成功处理，避免之前"所有工具都显示红色失败"的假象。
			isErr := e.IsError || detectToolErrorFromContent(e.Content)
			result.ToolCalls = append(result.ToolCalls, ToolCallSummary{
				Name:       e.ToolName,
				ArgsJSON:   e.ToolArgs,
				ResultText: truncateString(e.Content, 2000),
				IsError:    isErr,
			})
		}
	}
	result.Text = strings.TrimSpace(textBuilder.String())
	if result.Text == "" {
		return nil, errors.New("ocbridge: agent returned empty response")
	}
	return result, nil
}

// detectCompactionSummary 扫描 baseline 之后的历史，返回最近一条 compactionSummary 的
// summary 文本（可能为空）和是否检测到。OpenClaw pi-agent-core 自定义消息约定：
//
//	{ role: "compactionSummary", summary: "...", tokensBefore, timestamp }
//
// 兼容性：有的实现把 summary 放在 content 里，我们两者都扫一下。
func (b *Bridge) detectCompactionSummary(sessionKey string, baseline int) (string, bool) {
	entries, _, err := b.fetchHistorySince(sessionKey, baseline, 50)
	if err != nil {
		return "", false
	}
	for i := len(entries) - 1; i >= 0; i-- {
		e := entries[i]
		if e.Role == "compactionSummary" || e.Kind == "compactionSummary" || e.Kind == "compaction" {
			if strings.TrimSpace(e.Content) != "" {
				return e.Content, true
			}
			return "", true
		}
	}
	return "", false
}

// fetchHistorySince 拉取 baseline 之后的消息，最多 limit 条。
// OpenClaw sessions.get 返回 { messages: [...] }（正序、最多 limit 条；默认 200）。
// 没有 total 字段 —— baseline 表示"上次见过的 messages 长度"，此函数从 baseline
// 开始往后切片作为"新消息"。若 limit ≤ 0 则请求全量。
func (b *Bridge) fetchHistorySince(sessionKey string, baseline, limit int) ([]sessionHistoryEntry, int, error) {
	params := map[string]interface{}{
		"key": sessionKey,
	}
	// OpenClaw sessions.get 的 limit 是"尾部切片"语义（保留末尾 N 条），
	// 恰好满足我们只关心最新消息的需求。limit ≤ 0 时走服务端默认 200。
	if limit > 0 {
		// 为了能覆盖 baseline 之后的所有新消息，额外预留一点余量。
		params["limit"] = limit + baseline
	}
	resp, err := b.gw.RequestWithTimeout("sessions.get", params, 8*time.Second)
	if err != nil {
		return nil, 0, err
	}
	var payload struct {
		Messages []rawTranscriptMessage `json:"messages"`
	}
	if err := json.Unmarshal(resp, &payload); err != nil {
		return nil, 0, fmt.Errorf("parse sessions.get: %w", err)
	}
	all := make([]sessionHistoryEntry, 0, len(payload.Messages))
	for _, m := range payload.Messages {
		all = append(all, normalizeRawTranscript(m))
	}
	total := len(all)
	// 截取 baseline 之后
	if baseline > 0 && baseline <= total {
		all = all[baseline:]
	} else if baseline > total {
		// baseline 比实际大 → session 可能被重置；返回空以避免"幻觉新消息"。
		all = nil
	}
	// 若调用方指定了 limit，只保留最后 limit 条
	if limit > 0 && len(all) > limit {
		all = all[len(all)-limit:]
	}
	return all, total, nil
}

// ── Agent catalog (for Member editor dropdown) ─────────────────────

// AgentInfo 描述一个可供房间绑定的 OpenClaw agent。
type AgentInfo struct {
	ID           string `json:"id"`
	Name         string `json:"name,omitempty"`
	Model        string `json:"model,omitempty"`
	Description  string `json:"description,omitempty"`
	IsDefault    bool   `json:"isDefault,omitempty"`
	ToolCount    int    `json:"toolCount,omitempty"`
	ChannelCount int    `json:"channelCount,omitempty"`
}

// ListAgents 通过 agents.list RPC 拉取 OpenClaw 侧所有 agent 定义。
//
// OpenClaw 兼容的返回形状：
//  1. { agents: [{ id, name?, model?, ... }] }  —— 新版，model 可以是 string 或 { primary, fallbacks[] }
//  2. [ { id, ... } ]                           —— 旧版直接数组
//
// 这里用 rawAgent 做宽松解析，model 字段两种形态都认。
func (b *Bridge) ListAgents(ctx context.Context) ([]AgentInfo, error) {
	if !b.IsAvailable() {
		return nil, ErrGatewayUnavailable
	}
	resp, err := b.gw.RequestWithTimeout("agents.list", map[string]interface{}{}, 10*time.Second)
	if err != nil {
		return nil, err
	}
	// 先尝试新版 { agents: [...] } 形状
	var wrapped struct {
		DefaultID string          `json:"defaultId"`
		Agents    json.RawMessage `json:"agents"`
	}
	if err := json.Unmarshal(resp, &wrapped); err == nil && len(wrapped.Agents) > 0 {
		agents, perr := parseAgentList(wrapped.Agents, wrapped.DefaultID)
		if perr == nil {
			return agents, nil
		}
	}
	// 回退：直接数组
	if agents, perr := parseAgentList(resp, ""); perr == nil {
		return agents, nil
	}
	return nil, fmt.Errorf("ocbridge: unrecognized agents.list payload: %s", string(resp))
}

// parseAgentList 解析 agents 数组，兼容 model 为字符串或 { primary, fallbacks[] } 对象。
func parseAgentList(raw json.RawMessage, defaultID string) ([]AgentInfo, error) {
	var rawAgents []map[string]json.RawMessage
	if err := json.Unmarshal(raw, &rawAgents); err != nil {
		return nil, err
	}
	out := make([]AgentInfo, 0, len(rawAgents))
	for _, ra := range rawAgents {
		info := AgentInfo{}
		if v, ok := ra["id"]; ok {
			_ = json.Unmarshal(v, &info.ID)
		}
		if v, ok := ra["name"]; ok {
			_ = json.Unmarshal(v, &info.Name)
		}
		if v, ok := ra["description"]; ok {
			_ = json.Unmarshal(v, &info.Description)
		}
		if v, ok := ra["model"]; ok {
			// 先试 string
			var s string
			if err := json.Unmarshal(v, &s); err == nil {
				info.Model = s
			} else {
				// 再试 { primary, fallbacks }
				var obj struct {
					Primary   string   `json:"primary"`
					Fallbacks []string `json:"fallbacks"`
				}
				if err := json.Unmarshal(v, &obj); err == nil {
					info.Model = obj.Primary
				}
			}
		}
		if defaultID != "" && info.ID == defaultID {
			info.IsDefault = true
		}
		if info.ID != "" {
			out = append(out, info)
		}
	}
	return out, nil
}

// ── Non-streaming Complete (for scoring / minutes / playbook) ──────

// CompleteRequest 是一次非流式辅助 LLM 调用，用于竞价打分、会议纪要等短输出任务。
type CompleteRequest struct {
	SessionKey     string // 通常是专用辅助 session；空时会用 tempSessionKey
	AgentID        string // 辅助 agent（默认 = 房间主 agent）
	Model          string
	Thinking       string
	SystemPrompt   string
	UserMessage    string
	MaxTokens      int // 软提示；OpenClaw 不强制
	TimeoutSeconds int
}

// CompleteResult —— v0.9.1：Complete() 的返回用量附加。
// 原先只返回 text，导致 Closeout / Bidding / Extract 等辅助 LLM 调用的 token / 费用信息
// 在 Bridge 层直接丢失；收尾仪式无从向用户展示真实消耗。
//
// 把 RunAgent 已经有的 TokensPrompt / TokensComplete / Model 顺带透出。
// 调用方不关心用量时读 .Text 即可，与旧 API 迁移成本极小。
type CompleteResult struct {
	Text           string
	Model          string // 实际使用的模型（Bridge 可能已做路由）
	TokensPrompt   int
	TokensComplete int
}

// Complete 执行一次简单的 system+user 非流式生成。内部仍走 agent RPC，
// 但不保留长历史——每次用一个临时 session key（caller 管理或 bridge 生成）。
func (b *Bridge) Complete(ctx context.Context, req CompleteRequest) (*CompleteResult, error) {
	if !b.IsAvailable() {
		return nil, ErrGatewayUnavailable
	}
	key := strings.TrimSpace(req.SessionKey)
	if key == "" {
		// 临时 session：调用完不删除，由 OpenClaw 的 session gc 自动回收
		agent := req.AgentID
		if agent == "" {
			agent = b.DefaultAgentID(ctx)
		}
		key = fmt.Sprintf("agent:%s:agentroom:aux:%d", agent, time.Now().UnixNano())
		// 预建一下以注入 agentId
		_ = b.EnsureSession(ctx, EnsureSessionParams{
			Key:      key,
			AgentID:  req.AgentID,
			Model:    req.Model,
			Thinking: req.Thinking,
			Label:    "aux",
		})
		defer func() {
			_ = b.DeleteSession(context.Background(), key)
		}()
	}

	runReq := RunRequest{
		SessionKey:        key,
		Message:           req.UserMessage,
		Model:             req.Model,
		Thinking:          req.Thinking,
		ExtraSystemPrompt: req.SystemPrompt,
		TimeoutSeconds:    req.TimeoutSeconds,
	}
	result, err := b.RunAgent(ctx, runReq, nil)
	if err != nil {
		return nil, err
	}
	return &CompleteResult{
		Text:           result.Text,
		Model:          result.Model,
		TokensPrompt:   result.TokensPrompt,
		TokensComplete: result.TokensComplete,
	}, nil
}

// ── helpers ─────────────────────────────────────────────────────────

func truncateString(s string, maxRunes int) string {
	r := []rune(s)
	if len(r) <= maxRunes {
		return s
	}
	return string(r[:maxRunes]) + "…"
}

// logf 统一前缀日志。
func (b *Bridge) logf(level, msg string, kv ...any) {
	e := logger.Log.Info()
	switch level {
	case "warn":
		e = logger.Log.Warn()
	case "error":
		e = logger.Log.Error()
	case "debug":
		e = logger.Log.Debug()
	}
	e = e.Str("module", "agentroom.ocbridge")
	for i := 0; i+1 < len(kv); i += 2 {
		k, ok := kv[i].(string)
		if !ok {
			continue
		}
		e = e.Interface(k, kv[i+1])
	}
	e.Msg(msg)
}
