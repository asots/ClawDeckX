package agentroom

import (
	"encoding/json"
	"sync/atomic"
	"testing"
)

func TestParseCompactionEvent_StreamVariants(t *testing.T) {
	cases := []struct {
		name       string
		payload    string
		wantPhase  string
		wantKey    string
		wantSum    string
		recognized bool
	}{
		{
			name:       "auto_compaction_start",
			payload:    `{"sessionKey":"agent:a:agentroom:r1:m1","stream":"auto_compaction_start","data":{}}`,
			wantPhase:  "start",
			wantKey:    "agent:a:agentroom:r1:m1",
			recognized: true,
		},
		{
			name:       "auto_compaction_end_with_summary",
			payload:    `{"sessionKey":"sess","stream":"auto_compaction_end","data":{"summary":"hello"}}`,
			wantPhase:  "end",
			wantKey:    "sess",
			wantSum:    "hello",
			recognized: true,
		},
		{
			name:       "end_with_result_summary",
			payload:    `{"sessionKey":"sess","stream":"auto_compaction_end","data":{"result":{"summary":"done"}}}`,
			wantPhase:  "end",
			wantKey:    "sess",
			wantSum:    "done",
			recognized: true,
		},
		{
			name:       "type_inside_data",
			payload:    `{"sessionKey":"sess","data":{"type":"compaction_start"}}`,
			wantPhase:  "start",
			wantKey:    "sess",
			recognized: true,
		},
		{
			name:       "non_compaction",
			payload:    `{"sessionKey":"sess","stream":"assistant","data":{"text":"hi"}}`,
			recognized: false,
		},
		{
			name:       "missing_session_key",
			payload:    `{"stream":"auto_compaction_start"}`,
			recognized: false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			key, phase, sum, _, ok := ParseCompactionEvent(json.RawMessage(tc.payload))
			if ok != tc.recognized {
				t.Fatalf("recognized: got=%v want=%v", ok, tc.recognized)
			}
			if !ok {
				return
			}
			if phase != tc.wantPhase {
				t.Errorf("phase: got=%q want=%q", phase, tc.wantPhase)
			}
			if key != tc.wantKey {
				t.Errorf("key: got=%q want=%q", key, tc.wantKey)
			}
			if sum != tc.wantSum {
				t.Errorf("summary: got=%q want=%q", sum, tc.wantSum)
			}
		})
	}
}

func TestCompactionBus_DispatchRoutesByKey(t *testing.T) {
	bus := NewCompactionBus()

	var aHits, bHits atomic.Int32
	bus.Subscribe("sess-a", func(phase, summary string, willRetry bool) {
		aHits.Add(1)
	})
	bus.Subscribe("sess-b", func(phase, summary string, willRetry bool) {
		bHits.Add(1)
	})

	bus.Dispatch("sess-a", "start", "", false)
	bus.Dispatch("sess-a", "end", "ok", false)
	bus.Dispatch("sess-b", "start", "", false)
	bus.Dispatch("sess-unknown", "end", "", false) // no subscriber, drop

	if got := aHits.Load(); got != 2 {
		t.Errorf("sess-a: got %d hits, want 2", got)
	}
	if got := bHits.Load(); got != 1 {
		t.Errorf("sess-b: got %d hits, want 1", got)
	}

	// Unsubscribe 后不应再收到
	bus.Unsubscribe("sess-a")
	bus.Dispatch("sess-a", "start", "", false)
	if got := aHits.Load(); got != 2 {
		t.Errorf("after unsubscribe: got %d hits, want 2", got)
	}

	// 幂等 Unsubscribe
	bus.Unsubscribe("nonexistent")
	bus.Unsubscribe("")

	// nil bus 不崩
	var nilBus *CompactionBus
	nilBus.Subscribe("k", func(string, string, bool) {})
	nilBus.Dispatch("k", "start", "", false)
	nilBus.Unsubscribe("k")
}
