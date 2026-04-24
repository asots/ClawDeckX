package agentroom

import (
	"sync"
)

// BroadcastFunc 由外层注入（通常是 WSHub.Broadcast 的闭包），
// 这样 agentroom 包不直接依赖 web.WSHub，便于单测。
type BroadcastFunc func(channel string, msgType string, payload any)

// BroadcastToUsersFunc 由外层注入（通常是 WSHub.BroadcastToUsers 的闭包）。
// 当 userIDs 非空时：仅向这些用户的 WS 客户端投递。
// Broker 用它实现 whisper 等 user-scoped 事件（避免被同房间其它订阅者窃听）。
type BroadcastToUsersFunc func(channel string, userIDs []uint, msgType string, payload any)

// Broker 把 orchestrator 产生的事件广播到 WSHub 的 agentroom:{roomId} 频道。
// 同时保留内存订阅机制用于测试/扩展。
type Broker struct {
	mu               sync.RWMutex
	broadcast        BroadcastFunc
	broadcastToUsers BroadcastToUsersFunc
	// 进程内订阅（可选）—— map[roomID]->listeners
	listeners map[string][]func(evt Event)
}

type Event struct {
	RoomID  string      `json:"roomId"`
	Type    string      `json:"type"` // 事件类型：message.append / member.update / room.update / intervention / bidding.snapshot
	Payload interface{} `json:"payload"`
}

func NewBroker(bc BroadcastFunc) *Broker {
	return &Broker{broadcast: bc, listeners: make(map[string][]func(Event))}
}

// SetUserBroadcaster 注入 user-scoped 广播函数。调用一次即可（通常在 serve.go 启动阶段）。
func (b *Broker) SetUserBroadcaster(fn BroadcastToUsersFunc) {
	if b == nil {
		return
	}
	b.broadcastToUsers = fn
}

// EmitToUsers 仅向 userIDs 名单内的用户广播 WS 事件。也通知进程内 listener（便于测试 + 跨房间桥接）。
// 若未注入 user broadcaster 或 userIDs 为空，退化为 Emit（全量广播），避免消息静默丢失。
func (b *Broker) EmitToUsers(roomID string, userIDs []uint, eventType string, payload any) {
	if b == nil {
		return
	}
	if len(userIDs) == 0 || b.broadcastToUsers == nil {
		b.Emit(roomID, eventType, payload)
		return
	}
	evt := Event{RoomID: roomID, Type: eventType, Payload: payload}
	b.broadcastToUsers(Channel(roomID), userIDs, eventType, evt)
	b.mu.RLock()
	ls := append([]func(Event){}, b.listeners[roomID]...)
	b.mu.RUnlock()
	for _, fn := range ls {
		fn(evt)
	}
}

// Channel 给定房间的 WS 频道名。
func Channel(roomID string) string { return "agentroom:" + roomID }

// Emit 发一个事件到所有订阅者（WS + 本地）。
func (b *Broker) Emit(roomID, eventType string, payload any) {
	if b == nil {
		return
	}
	evt := Event{RoomID: roomID, Type: eventType, Payload: payload}
	if b.broadcast != nil {
		b.broadcast(Channel(roomID), eventType, evt)
	}
	b.mu.RLock()
	ls := append([]func(Event){}, b.listeners[roomID]...)
	b.mu.RUnlock()
	for _, fn := range ls {
		fn(evt)
	}
}

// Subscribe 进程内订阅（单测或桥接其它组件）。
func (b *Broker) Subscribe(roomID string, fn func(Event)) func() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.listeners[roomID] = append(b.listeners[roomID], fn)
	return func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		ls := b.listeners[roomID]
		for i, l := range ls {
			if &l == &fn {
				b.listeners[roomID] = append(ls[:i], ls[i+1:]...)
				break
			}
		}
	}
}

// 事件类型常量（与前端 service.ts 中的事件总线对齐）
const (
	EventMessageAppend = "message.append"
	EventMessageUpdate = "message.update"
	EventMemberUpdate  = "member.update"
	EventMemberAdded   = "member.added"
	EventMemberRemoved = "member.removed"
	EventRoomUpdate    = "room.update"
	EventIntervention  = "intervention"
	EventBiddingStart  = "bidding.start"
	EventBidding       = "bidding.snapshot"
	// EventPlanning 用于 planned policy：phase / queue / ownerIdx 发生变化时广播。
	EventPlanning = "planning.update"
	// EventToolApproval 用于 Phase 2 工具调用审批：agent 请求执行工具时广播给前端。
	EventToolApproval = "tool.approval"
	// EventToolResult 用于 Phase 2 工具调用结果：执行完成后广播给前端。
	EventToolResult = "tool.result"
	// EventContextCompaction 用于 OpenClaw 上下文压缩事件（phase=start/end）。
	// Orchestrator/Bridge 检测到成员 session 触发自动压缩时发出，前端渲染横幅。
	EventContextCompaction = "context.compaction"
)

// EmitContextCompaction 便捷封装：发送 context.compaction 事件到指定房间。
// phase = "start" | "end"；willRetry 仅在 phase=="end" 时有意义（true 表示 OpenClaw 将紧接着重试原 prompt）。
// summary 可选 —— phase=="end" 时压缩产物的文字摘要。
func (b *Broker) EmitContextCompaction(roomID, memberID, sessionKey, phase string, willRetry bool, summary string) {
	payload := map[string]any{
		"roomId":     roomID,
		"memberId":   memberID,
		"sessionKey": sessionKey,
		"phase":      phase,
	}
	if phase == "end" {
		payload["willRetry"] = willRetry
		if summary != "" {
			payload["summary"] = summary
		}
	}
	b.Emit(roomID, EventContextCompaction, payload)
}
