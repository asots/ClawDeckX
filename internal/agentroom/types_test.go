package agentroom

import (
	"strings"
	"testing"
)

func TestSanitizeSystemPrompt_TrimsWhitespace(t *testing.T) {
	if got := SanitizeSystemPrompt("  hello  "); got != "hello" {
		t.Fatalf("expect 'hello', got %q", got)
	}
}

func TestSanitizeSystemPrompt_KeepsNewlineAndTab(t *testing.T) {
	in := "line1\nline2\t tab"
	out := SanitizeSystemPrompt(in)
	if !strings.Contains(out, "\n") || !strings.Contains(out, "\t") {
		t.Fatalf("should preserve \\n and \\t; got %q", out)
	}
}

func TestSanitizeSystemPrompt_StripsControlChars(t *testing.T) {
	in := "abc\x00def\x07ghi\x1Fjkl"
	out := SanitizeSystemPrompt(in)
	if strings.ContainsAny(out, "\x00\x07\x1F") {
		t.Fatalf("should strip control chars; got %q", out)
	}
	if out != "abcdefghijkl" {
		t.Fatalf("expect 'abcdefghijkl', got %q", out)
	}
}

func TestSanitizeSystemPrompt_StripsDEL(t *testing.T) {
	if got := SanitizeSystemPrompt("a\x7Fb"); got != "ab" {
		t.Fatalf("expect 'ab', got %q", got)
	}
}

func TestSanitizeSystemPrompt_HardCap4000(t *testing.T) {
	in := strings.Repeat("x", 4500)
	out := SanitizeSystemPrompt(in)
	if n := len([]rune(out)); n != 4000 {
		t.Fatalf("expect 4000 runes, got %d", n)
	}
}

func TestSanitizeSystemPrompt_EmptyInput(t *testing.T) {
	if got := SanitizeSystemPrompt(""); got != "" {
		t.Fatalf("expect empty, got %q", got)
	}
	if got := SanitizeSystemPrompt("   "); got != "" {
		t.Fatalf("expect empty after trim, got %q", got)
	}
}

func TestSanitizeSystemPrompt_CJKPreserved(t *testing.T) {
	in := "你好\x00世界"
	out := SanitizeSystemPrompt(in)
	if out != "你好世界" {
		t.Fatalf("expect '你好世界', got %q", out)
	}
}
