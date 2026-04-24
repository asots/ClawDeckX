package agentroom

import (
	"encoding/json"
	"strings"
	"sync"
)

// CompactionBus 是 agentroom 内部的 sessionKey → 实时回调分发层。
//
// 背景：OpenClaw Gateway 通过 WebSocket 广播 `agent` 事件流，事件里携带
// `stream` 字段（"auto_compaction_start" / "auto_compaction_end" / "compaction" 等），
// 以及 `sessionKey` 定位具体会话。ClawDeckX 此前通过 history polling 启发式
// 检测 compactionSummary 条目来触发 UI 横幅，延迟 ~500ms 一跳、且无法区分
// "压缩已开始但还没写入 summary" 的中间态。
//
// 本总线给出一条实时路径：gateway 事件 → Manager 副听众 → Dispatch(sessionKey)
// → Orchestrator/Bridge 注册的回调。它同时作为 bridge polling 的 fast path，
// 用 sync.Once 在 Bridge.Run 的生命周期内保证 OnCompaction("start" / "end")
// 各触发至多一次，避免 WS + polling 双重 emit。
//
// 并发：Subscribe / Unsubscribe / Dispatch 都线程安全；订阅者最多 1 个 per
// sessionKey（同一个 session 不会在 bridge 里并发 Run，Orchestrator 侧已有
// 门）；多订阅场景会警告覆盖但保持兼容，旧订阅自动退场。
type CompactionBus struct {
	mu   sync.RWMutex
	subs map[string]CompactionListener
}

// CompactionListener 实时回调：phase ∈ {"start","end"}，end 事件 summary 可能非空，
// willRetry 只有在 end 阶段有意义。
type CompactionListener func(phase, summary string, willRetry bool)

// NewCompactionBus 构造空总线。Manager 持有单例。
func NewCompactionBus() *CompactionBus {
	return &CompactionBus{subs: map[string]CompactionListener{}}
}

// Subscribe 为指定 sessionKey 注册回调。同 key 重复订阅会覆盖（Bridge.Run 串行保证，
// 不会真正出现竞态；覆盖语义是防御性兜底）。
// sessionKey 为空时 no-op。
func (b *CompactionBus) Subscribe(sessionKey string, fn CompactionListener) {
	if b == nil || sessionKey == "" || fn == nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.subs[sessionKey] = fn
}

// Unsubscribe 撤销订阅。幂等。
func (b *CompactionBus) Unsubscribe(sessionKey string) {
	if b == nil || sessionKey == "" {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.subs, sessionKey)
}

// Dispatch 按 sessionKey 路由一条压缩事件给当前订阅者（如果有）。
// 未订阅即 drop —— 这是可接受的：事件只在 Bridge.Run 生命周期内有意义，
// 其他时间窗口里 compaction 是 OpenClaw 内部的事，ClawDeckX 不关心。
func (b *CompactionBus) Dispatch(sessionKey, phase, summary string, willRetry bool) {
	if b == nil || sessionKey == "" {
		return
	}
	b.mu.RLock()
	fn := b.subs[sessionKey]
	b.mu.RUnlock()
	if fn != nil {
		fn(phase, summary, willRetry)
	}
}

// ParseCompactionEvent 尝试把一条 gateway `agent` 事件载荷解析成
// （sessionKey, phase, summary, willRetry, recognized）。
//
// OpenClaw 在 src/agents/pi-embedded-subscribe.ts 里通过 emitAgentEvent 广播
// 两类 stream：auto_compaction_start / auto_compaction_end；Gateway server-chat.ts
// 在 broadcast("agent", agentPayload) 时把 `sessionKey` 透传。我们做
// 宽松匹配，兼容将来可能的命名收敛（compaction_start / compaction / 等）。
//
// recognized=false 时调用方应 fallthrough（不是 compaction 事件）。
func ParseCompactionEvent(payload json.RawMessage) (sessionKey, phase, summary string, willRetry, recognized bool) {
	if len(payload) == 0 {
		return "", "", "", false, false
	}
	var envelope struct {
		SessionKey string          `json:"sessionKey"`
		Stream     string          `json:"stream"`
		Data       json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return "", "", "", false, false
	}
	stream := strings.ToLower(strings.TrimSpace(envelope.Stream))
	phase = classifyCompactionStream(stream)
	if phase == "" {
		// 有些广播可能把 type 嵌在 data 里，或 stream 字段使用了短名（如 "compaction"）。
		// 再尝试读 data.type / data.phase 做一次 fallback。
		if len(envelope.Data) > 0 {
			var d struct {
				Type      string `json:"type"`
				Phase     string `json:"phase"`
				Summary   string `json:"summary"`
				WillRetry *bool  `json:"willRetry"`
				Result    *struct {
					Summary string `json:"summary"`
				} `json:"result"`
			}
			if err := json.Unmarshal(envelope.Data, &d); err == nil {
				if p := classifyCompactionStream(strings.ToLower(d.Type)); p != "" {
					phase = p
				} else if d.Phase == "start" || d.Phase == "end" {
					phase = d.Phase
				}
				if phase != "" {
					summary = strings.TrimSpace(d.Summary)
					if summary == "" && d.Result != nil {
						summary = strings.TrimSpace(d.Result.Summary)
					}
					if d.WillRetry != nil {
						willRetry = *d.WillRetry
					}
				}
			}
		}
		if phase == "" {
			return "", "", "", false, false
		}
	} else if phase == "end" && len(envelope.Data) > 0 {
		// end 事件的 summary 优先从 data 里取。
		var d struct {
			Summary   string `json:"summary"`
			WillRetry *bool  `json:"willRetry"`
			Result    *struct {
				Summary string `json:"summary"`
			} `json:"result"`
		}
		if err := json.Unmarshal(envelope.Data, &d); err == nil {
			summary = strings.TrimSpace(d.Summary)
			if summary == "" && d.Result != nil {
				summary = strings.TrimSpace(d.Result.Summary)
			}
			if d.WillRetry != nil {
				willRetry = *d.WillRetry
			}
		}
	}
	sessionKey = strings.TrimSpace(envelope.SessionKey)
	if sessionKey == "" {
		return "", "", "", false, false
	}
	recognized = true
	return sessionKey, phase, summary, willRetry, true
}

// classifyCompactionStream 把 OpenClaw 的流类型字符串收敛为 "start" / "end"
// 两个语义阶段。空串表示不是 compaction 事件。
func classifyCompactionStream(s string) string {
	switch s {
	case "auto_compaction_start",
		"compaction_start",
		"compactionstart",
		"context_compaction_start":
		return "start"
	case "auto_compaction_end",
		"compaction_end",
		"compactionend",
		"context_compaction_end",
		"compactionsummary":
		return "end"
	}
	// 通用兜底：stream 本身就是 "compaction" 且不带 start/end —— 视为 end
	// （OpenClaw 部分旧版本会把 summary 结果一次性发出）。
	if s == "compaction" {
		return "end"
	}
	return ""
}
