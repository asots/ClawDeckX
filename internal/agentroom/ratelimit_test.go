package agentroom

import (
	"testing"
	"time"
)

func TestRoomRateLimiter_BurstAllowed(t *testing.T) {
	rl := NewRoomRateLimiter(RateLimitConfig{Burst: 3, PerMinute: 60})
	for i := 0; i < 3; i++ {
		if !rl.Allow("r1") {
			t.Fatalf("burst %d should be allowed", i)
		}
	}
	// 4th immediately after: burst 3 + only ~0 refilled → should fail
	if rl.Allow("r1") {
		t.Fatal("4th request within same instant should be denied")
	}
}

func TestRoomRateLimiter_RefillOverTime(t *testing.T) {
	rl := NewRoomRateLimiter(RateLimitConfig{Burst: 1, PerMinute: 600}) // 10/s
	if !rl.Allow("r2") {
		t.Fatal("first should pass")
	}
	if rl.Allow("r2") {
		t.Fatal("second immediate should fail")
	}
	time.Sleep(150 * time.Millisecond) // enough for 1.5 tokens at 10/s
	if !rl.Allow("r2") {
		t.Fatal("after refill window should pass")
	}
}

func TestRoomRateLimiter_IsolatedPerRoom(t *testing.T) {
	rl := NewRoomRateLimiter(RateLimitConfig{Burst: 1, PerMinute: 1})
	if !rl.Allow("roomA") {
		t.Fatal("roomA first ok")
	}
	if !rl.Allow("roomB") {
		t.Fatal("roomB should be independent bucket")
	}
	if rl.Allow("roomA") {
		t.Fatal("roomA second should be denied (burst=1)")
	}
}

func TestRoomRateLimiter_ResetClearsBucket(t *testing.T) {
	rl := NewRoomRateLimiter(RateLimitConfig{Burst: 1, PerMinute: 1})
	_ = rl.Allow("r")
	if rl.Allow("r") {
		t.Fatal("expect denied before reset")
	}
	rl.Reset("r")
	if !rl.Allow("r") {
		t.Fatal("after reset expect fresh bucket")
	}
}

func TestRoomRateLimiter_DefaultsApplied(t *testing.T) {
	rl := NewRoomRateLimiter(RateLimitConfig{}) // zeros → apply defaults
	for i := 0; i < 5; i++ {
		if !rl.Allow("d") {
			t.Fatalf("default burst=5 should allow %d", i)
		}
	}
	if rl.Allow("d") {
		t.Fatal("6th should be denied with default burst=5")
	}
}
