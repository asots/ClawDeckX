package agentroom

import (
	"sync"
	"time"
)

// RateLimitConfig 定义每房间的速率限制参数。
type RateLimitConfig struct {
	Burst     int // 最大突发容量（桶容量）
	PerMinute int // 稳态速率：每分钟补充 token 数
}

// RoomRateLimiter 是一个极简的 token bucket，按 roomID 维度限速。
// 非持久化；进程重启后重置。对"防止同一房间单用户/脚本刷屏"足够。
type RoomRateLimiter struct {
	cfg RateLimitConfig
	mu  sync.Mutex
	buckets map[string]*bucket
}

type bucket struct {
	tokens    float64
	updatedAt time.Time
}

func NewRoomRateLimiter(cfg RateLimitConfig) *RoomRateLimiter {
	if cfg.Burst <= 0 {
		cfg.Burst = 5
	}
	if cfg.PerMinute <= 0 {
		cfg.PerMinute = 20
	}
	return &RoomRateLimiter{
		cfg:     cfg,
		buckets: make(map[string]*bucket),
	}
}

// Allow 尝试在给定 roomID 下扣一张票。成功 true；桶空 false。
func (rl *RoomRateLimiter) Allow(roomID string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	b, ok := rl.buckets[roomID]
	now := time.Now()
	refillRatePerSec := float64(rl.cfg.PerMinute) / 60.0
	if !ok {
		rl.buckets[roomID] = &bucket{tokens: float64(rl.cfg.Burst) - 1, updatedAt: now}
		return true
	}
	elapsed := now.Sub(b.updatedAt).Seconds()
	b.tokens += elapsed * refillRatePerSec
	if b.tokens > float64(rl.cfg.Burst) {
		b.tokens = float64(rl.cfg.Burst)
	}
	b.updatedAt = now
	if b.tokens < 1 {
		return false
	}
	b.tokens -= 1
	return true
}

// Reset 清除某房间的计数（例如房间被删除时）。
func (rl *RoomRateLimiter) Reset(roomID string) {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	delete(rl.buckets, roomID)
}
