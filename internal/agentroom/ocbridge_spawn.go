// ocbridge_spawn.go —— 通过 OpenClaw HTTP /tools/invoke 触发真正的 sessions_spawn。
//
// 与 ocbridge.go 的 RunAgent 不同，这里 fork 出一个 isolated 子 session，
// 让任务在干净上下文里跑，而不是污染父房间 session。
//
// 见 docs/agentroom/REAL_SUBAGENT_SPAWN.md。
package agentroom

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"ClawDeckX/internal/openclaw"
)

// SpawnRequest 指定一次 sessions_spawn 的入参。
type SpawnRequest struct {
	// ParentSessionKey: 必须是 OpenClaw 已存在的顶层 session（通常是房间内某成员的常驻 session）。
	ParentSessionKey string
	// AgentID: 子 session 要绑定的 agent id（必须在 agents.list 里）。
	AgentID string
	// Task: 一次性任务 prompt（isolated 模式下子 agent 看不到房间历史，所有要点必须塞这里）。
	Task string
	// Model / Thinking 可选，覆盖子 agent 的默认配置。
	Model    string
	Thinking string
	// Label 可选，标记这次 spawn（OpenClaw run 列表里能看到）。
	Label string
	// TimeoutSeconds 子 run 的执行超时；0 = 用 OpenClaw 默认。
	TimeoutSeconds int
}

// SpawnResult 是 sessions_spawn 的执行结果。
type SpawnResult struct {
	// ChildSessionKey: 新 fork 出的子 session key。后续可用 sessions.get 拉取 transcript。
	ChildSessionKey string
	// RunID: spawn 触发的 run（异步时可用 agent.wait 等待）。
	RunID string
	// Output: 子 agent 的最终回复（同步路径已抓到时填）；为空则需要轮询。
	Output string
	// Status: OpenClaw 报告的执行状态（completed / running / error / forbidden / ...）。
	Status string
	// RawResult: 原始 result JSON，方便审计 / 调试。
	RawResult json.RawMessage
}

// ErrSpawnNotSupported 在 gateway HTTP 路径不可用时返回。
var ErrSpawnNotSupported = errors.New("subagent spawn not supported by gateway")

// SpawnSubagent 调用上游 sessions_spawn。
// gateway 不可用时返回 ErrSpawnNotSupported（让 caller 降级）。
func (b *Bridge) SpawnSubagent(ctx context.Context, req SpawnRequest) (*SpawnResult, error) {
	if b == nil || b.gw == nil || !b.gw.IsConnected() {
		return nil, ErrSpawnNotSupported
	}
	if strings.TrimSpace(req.ParentSessionKey) == "" {
		return nil, errors.New("SpawnSubagent: ParentSessionKey required")
	}
	if strings.TrimSpace(req.AgentID) == "" {
		return nil, errors.New("SpawnSubagent: AgentID required")
	}
	if strings.TrimSpace(req.Task) == "" {
		return nil, errors.New("SpawnSubagent: Task required")
	}

	args := map[string]interface{}{
		"task":    req.Task,
		"agentId": req.AgentID,
		// isolated：子 session 独立、不继承父 transcript（房间历史靠 task prompt 自带）。
		"context": "isolated",
		// run：单次执行，OpenClaw 不为它登记一个长生命周期 thread。
		"mode": "run",
	}
	if s := strings.TrimSpace(req.Model); s != "" {
		args["model"] = s
	}
	if s := strings.TrimSpace(req.Thinking); s != "" {
		args["thinking"] = s
	}
	if s := strings.TrimSpace(req.Label); s != "" {
		args["label"] = s
	}
	if req.TimeoutSeconds > 0 {
		args["runTimeoutSeconds"] = req.TimeoutSeconds
	}

	timeout := 90 * time.Second
	if req.TimeoutSeconds > 0 {
		timeout = time.Duration(req.TimeoutSeconds+30) * time.Second
	}

	resp, err := b.gw.InvokeTool(ctx, openclaw.ToolInvokeRequest{
		Tool:       "sessions_spawn",
		SessionKey: req.ParentSessionKey,
		Args:       args,
	}, timeout)
	if err != nil {
		// HTTP 不通 / 端点 404 / token 错 → 视为不支持，让 caller 降级
		var notFound bool
		if resp != nil && resp.Error != nil && resp.Error.Type == "not_found" {
			notFound = true
		}
		if notFound || isTransportError(err) {
			b.logf("warn", "SpawnSubagent fell back: "+err.Error())
			return nil, ErrSpawnNotSupported
		}
		return nil, err
	}
	if resp == nil || len(resp.Result) == 0 {
		return nil, errors.New("SpawnSubagent: empty result")
	}

	// sessions_spawn result 形如：
	// { "status": "completed", "childSessionKey": "...", "runId": "...", "output": "...", ... }
	var parsed struct {
		Status          string `json:"status"`
		ChildSessionKey string `json:"childSessionKey"`
		SessionKey      string `json:"sessionKey"` // 兼容字段
		RunID           string `json:"runId"`
		Output          string `json:"output"`
		Reply           string `json:"reply"`
		Text            string `json:"text"`
	}
	_ = json.Unmarshal(resp.Result, &parsed)

	out := strings.TrimSpace(parsed.Output)
	if out == "" {
		out = strings.TrimSpace(parsed.Reply)
	}
	if out == "" {
		out = strings.TrimSpace(parsed.Text)
	}
	childKey := strings.TrimSpace(parsed.ChildSessionKey)
	if childKey == "" {
		childKey = strings.TrimSpace(parsed.SessionKey)
	}

	return &SpawnResult{
		ChildSessionKey: childKey,
		RunID:           strings.TrimSpace(parsed.RunID),
		Output:          out,
		Status:          strings.TrimSpace(parsed.Status),
		RawResult:       resp.Result,
	}, nil
}

// isTransportError 粗略判断是不是网络/握手类错误（vs 上游业务错误）。
func isTransportError(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	for _, hint := range []string{"connection refused", "no such host", "i/o timeout", "eof", "tls", "deadline exceeded", "http_404", "http_405"} {
		if strings.Contains(msg, hint) {
			return true
		}
	}
	return false
}
