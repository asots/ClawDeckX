package agentroom

import (
	"sync"
	"testing"
)

func TestBroker_EmitFallsBackWhenNoUserBroadcaster(t *testing.T) {
	var fullCallCount int
	b := NewBroker(func(channel, msgType string, payload any) {
		fullCallCount++
	})
	b.EmitToUsers("room_x", []uint{1, 2, 3}, "test.event", map[string]any{"k": "v"})
	if fullCallCount != 1 {
		t.Fatalf("expect fallback to full broadcast when user broadcaster missing; got %d", fullCallCount)
	}
}

func TestBroker_EmitToUsersFallsBackOnEmptyUserList(t *testing.T) {
	var fullCalls, userCalls int
	b := NewBroker(func(channel, msgType string, payload any) { fullCalls++ })
	b.SetUserBroadcaster(func(channel string, userIDs []uint, msgType string, payload any) { userCalls++ })
	b.EmitToUsers("room_x", nil, "test.event", nil)
	b.EmitToUsers("room_x", []uint{}, "test.event", nil)
	if userCalls != 0 || fullCalls != 2 {
		t.Fatalf("empty userIDs → fallback to full broadcast; full=%d user=%d", fullCalls, userCalls)
	}
}

func TestBroker_EmitToUsersRoutesToUserBroadcaster(t *testing.T) {
	var gotChan string
	var gotUIDs []uint
	var gotType string
	b := NewBroker(func(string, string, any) {})
	b.SetUserBroadcaster(func(channel string, userIDs []uint, msgType string, payload any) {
		gotChan = channel
		gotUIDs = userIDs
		gotType = msgType
	})
	b.EmitToUsers("room_abc", []uint{42}, "message.append", nil)
	if gotChan != "agentroom:room_abc" {
		t.Fatalf("expect channel agentroom:room_abc; got %q", gotChan)
	}
	if len(gotUIDs) != 1 || gotUIDs[0] != 42 {
		t.Fatalf("expect userIDs=[42]; got %v", gotUIDs)
	}
	if gotType != "message.append" {
		t.Fatalf("expect type=message.append; got %q", gotType)
	}
}

func TestBroker_SubscribeReceivesEmits(t *testing.T) {
	b := NewBroker(func(string, string, any) {})
	var mu sync.Mutex
	received := make([]string, 0)
	unsub := b.Subscribe("r1", func(evt Event) {
		mu.Lock()
		received = append(received, evt.Type)
		mu.Unlock()
	})
	defer unsub()

	b.Emit("r1", "a", nil)
	b.Emit("r1", "b", nil)
	b.Emit("r2", "c", nil) // different room → ignored by r1 listener

	mu.Lock()
	defer mu.Unlock()
	if len(received) != 2 || received[0] != "a" || received[1] != "b" {
		t.Fatalf("expect [a,b]; got %v", received)
	}
}

func TestBroker_NilSafe(t *testing.T) {
	var b *Broker
	// Should not panic
	b.Emit("r", "t", nil)
	b.EmitToUsers("r", []uint{1}, "t", nil)
	b.SetUserBroadcaster(func(string, []uint, string, any) {})
}
