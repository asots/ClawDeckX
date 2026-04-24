package agentroom

import (
	"testing"
	"time"
)

func TestModelBreaker_ClosedByDefault(t *testing.T) {
	b := NewModelBreaker()
	if !b.Allow("claude-sonnet") {
		t.Fatal("expect closed breaker to allow")
	}
	if got := b.State("claude-sonnet"); got != "closed" {
		t.Fatalf("expect closed, got %s", got)
	}
}

func TestModelBreaker_OpensAfterThreshold(t *testing.T) {
	b := NewModelBreaker()
	model := "gpt-5"
	b.Fail(model)
	b.Fail(model)
	if !b.Allow(model) {
		t.Fatal("below threshold (2 fails) should still allow")
	}
	b.Fail(model) // third → open
	if b.Allow(model) {
		t.Fatal("expect open breaker to deny")
	}
	if b.State(model) != "open" {
		t.Fatalf("expect open state, got %s", b.State(model))
	}
}

func TestModelBreaker_SuccessResets(t *testing.T) {
	b := NewModelBreaker()
	model := "deepseek"
	b.Fail(model)
	b.Fail(model)
	b.Success(model)
	// Should take 3 more fails to open again
	b.Fail(model)
	b.Fail(model)
	if !b.Allow(model) {
		t.Fatal("after success, counter should reset; 2 fails still within threshold")
	}
}

func TestModelBreaker_HalfOpenAfterWindow(t *testing.T) {
	b := NewModelBreaker()
	b.openMs = 30 // tiny window for test
	model := "qwen"
	b.Fail(model)
	b.Fail(model)
	b.Fail(model)
	if b.Allow(model) {
		t.Fatal("should be open immediately")
	}
	time.Sleep(60 * time.Millisecond)
	// Window elapsed → Allow should return true (half-open), moving state back to closed
	if !b.Allow(model) {
		t.Fatal("expect half-open to allow one retry")
	}
}
