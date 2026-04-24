package agentroom

import (
	"testing"

	"ClawDeckX/internal/database"
)

func TestParseExecutionQueue(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want []string
	}{
		{"empty", "", nil},
		{"nullString", "null", nil},
		{"ok", `["a","b","c"]`, []string{"a", "b", "c"}},
		{"trimBlank", `["  a ", "", "b"]`, []string{"a", "b"}},
		{"badJSON", `not-json`, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := parseExecutionQueue(tc.in)
			if len(got) != len(tc.want) {
				t.Fatalf("len: got %v want %v", got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Fatalf("idx %d: got %q want %q", i, got[i], tc.want[i])
				}
			}
		})
	}
}

func TestDetectHandoff(t *testing.T) {
	members := []database.AgentRoomMember{
		{ID: "alice-id", Name: "Alice"},
		{ID: "bob-id", Name: "Bob"},
		{ID: "carol-id", Name: "Carol"},
		{ID: "kicked-id", Name: "Ghost", IsKicked: true},
	}
	queue := []string{"alice-id", "bob-id", "carol-id"}

	t.Run("forwardMention", func(t *testing.T) {
		got := detectHandoff("我做完了，下一步 @Bob 来处理", queue, 0, members)
		if got != "bob-id" {
			t.Fatalf("got %q", got)
		}
	})

	t.Run("caseInsensitiveByID", func(t *testing.T) {
		got := detectHandoff("@carol-id 请你继续", queue, 1, members)
		if got != "carol-id" {
			t.Fatalf("got %q", got)
		}
	})

	t.Run("backwardMentionStillAllowedAsRework", func(t *testing.T) {
		got := detectHandoff("@Alice 你再看一眼", queue, 2, members)
		if got != "alice-id" {
			t.Fatalf("got %q", got)
		}
	})

	t.Run("kickedIsIgnored", func(t *testing.T) {
		got := detectHandoff("@Ghost 来一下", queue, 0, members)
		if got != "" {
			t.Fatalf("kicked member leaked: %q", got)
		}
	})

	t.Run("noMention", func(t *testing.T) {
		if got := detectHandoff("已完成", queue, 0, members); got != "" {
			t.Fatalf("got %q", got)
		}
	})
}
