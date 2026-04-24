package agentroom

import (
	"sync"
	"time"
)

// ModelBreaker 是 per-orchestrator 的 provider/model 熔断器。
//
// 设计：同一 model 连续 3 次 LLM 调用失败 → 熔断 60 秒（Open）；
// 熔断期间 Allow() 返回 false，orchestrator 跳过该 agent 的本轮发言；
// 熔断窗口结束后回到 Closed 状态，重新计数。
//
// 之所以不用全局共享：不同房间可能配置了不同的 provider 别名/url，
// 把故障范围控制在房间内避免误伤其它健康房间。
type ModelBreaker struct {
	mu       sync.Mutex
	state    map[string]*breakerEntry
	threshold int
	openMs    int64
}

type breakerEntry struct {
	fails    int
	openedAt int64 // 0 = closed
}

// NewModelBreaker 创建默认阈值 3 / 熔断 60s 的实例。
func NewModelBreaker() *ModelBreaker {
	return &ModelBreaker{
		state:     map[string]*breakerEntry{},
		threshold: 3,
		openMs:    60_000,
	}
}

// Allow 返回该模型当前是否可用（非熔断状态）。
func (b *ModelBreaker) Allow(model string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	e := b.state[model]
	if e == nil {
		return true
	}
	if e.openedAt > 0 {
		if time.Now().UnixMilli()-e.openedAt >= b.openMs {
			// 熔断期已过，半开：给一次机会
			e.openedAt = 0
			e.fails = 0
			return true
		}
		return false
	}
	return true
}

// Fail 报告一次失败。
func (b *ModelBreaker) Fail(model string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	e := b.state[model]
	if e == nil {
		e = &breakerEntry{}
		b.state[model] = e
	}
	e.fails++
	if e.fails >= b.threshold && e.openedAt == 0 {
		e.openedAt = time.Now().UnixMilli()
	}
}

// Success 报告一次成功（复位）。
func (b *ModelBreaker) Success(model string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if e := b.state[model]; e != nil {
		e.fails = 0
		e.openedAt = 0
	}
}

// State 返回模型当前状态（用于调试/观测）。返回：closed|half-open|open。
func (b *ModelBreaker) State(model string) string {
	b.mu.Lock()
	defer b.mu.Unlock()
	e := b.state[model]
	if e == nil || (e.openedAt == 0 && e.fails == 0) {
		return "closed"
	}
	if e.openedAt > 0 {
		if time.Now().UnixMilli()-e.openedAt >= b.openMs {
			return "half-open"
		}
		return "open"
	}
	return "closed"
}
