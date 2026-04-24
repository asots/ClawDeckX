package agentroom

import (
	"strings"
	"testing"
)

// TestParseInlineCaptures_Basic —— 最典型的单条 open_question 加单条 risk。
func TestParseInlineCaptures_Basic(t *testing.T) {
	src := `我觉得方案 A 可行。
<open_question>方案 A 的 SLA 谁负责兜底？</open_question>
另外要注意节奏。
<risk severity="high">Q2 交付排期冲突可能导致延期</risk>`
	c := parseInlineCaptures(src)

	if !c.HasAny() {
		t.Fatal("expected HasAny=true")
	}
	if got, want := len(c.OpenQuestions), 1; got != want {
		t.Fatalf("OpenQuestions count: got %d want %d (%v)", got, want, c.OpenQuestions)
	}
	if c.OpenQuestions[0] != "方案 A 的 SLA 谁负责兜底？" {
		t.Errorf("question text: %q", c.OpenQuestions[0])
	}
	if got, want := len(c.Risks), 1; got != want {
		t.Fatalf("Risks count: got %d want %d", got, want)
	}
	if c.Risks[0].Severity != "high" {
		t.Errorf("severity: %q", c.Risks[0].Severity)
	}
	// 剥离后 cleaned 不应该包含任何 tag 关键字。
	if strings.Contains(c.Cleaned, "<open_question") || strings.Contains(c.Cleaned, "<risk") {
		t.Errorf("cleaned still contains tags: %q", c.Cleaned)
	}
	if !strings.Contains(c.Cleaned, "方案 A 可行") || !strings.Contains(c.Cleaned, "注意节奏") {
		t.Errorf("cleaned lost body text: %q", c.Cleaned)
	}
}

// TestParseInlineCaptures_SeverityVariants —— severity 属性的多种写法都应正确归一化。
func TestParseInlineCaptures_SeverityVariants(t *testing.T) {
	cases := []struct {
		raw  string
		want string
	}{
		{`<risk severity="high">x</risk>`, "high"},
		{`<risk severity='low'>x</risk>`, "low"},
		{`<risk severity=mid>x</risk>`, "mid"},
		{`<risk severity="medium">x</risk>`, "mid"}, // LLM 常见变体
		{`<risk severity="CRITICAL">x</risk>`, "high"},
		{`<risk>x</risk>`, "mid"}, // 缺省
		{`<RISK severity="low">x</RISK>`, "low"}, // 大小写
	}
	for _, tc := range cases {
		c := parseInlineCaptures(tc.raw)
		if len(c.Risks) != 1 {
			t.Errorf("%q: want 1 risk got %d", tc.raw, len(c.Risks))
			continue
		}
		if c.Risks[0].Severity != tc.want {
			t.Errorf("%q: want severity=%q got %q", tc.raw, tc.want, c.Risks[0].Severity)
		}
	}
}

// TestParseInlineCaptures_NoTags —— 没 tag 时 HasAny=false、Cleaned 不变（trim 除外）。
func TestParseInlineCaptures_NoTags(t *testing.T) {
	src := "这是一段普通发言，没有任何结构化标注。"
	c := parseInlineCaptures(src)
	if c.HasAny() {
		t.Errorf("expected HasAny=false, got captures: q=%v r=%v", c.OpenQuestions, c.Risks)
	}
	if c.Cleaned != src {
		t.Errorf("cleaned mutated: %q", c.Cleaned)
	}
}

// TestParseInlineCaptures_Multiple —— 同一发言多个 open_question / risk，都应捕获。
func TestParseInlineCaptures_Multiple(t *testing.T) {
	src := `<open_question>Q1</open_question>正文<open_question>Q2</open_question>
<risk severity="low">R1</risk>中间<risk severity="high">R2</risk>`
	c := parseInlineCaptures(src)
	if len(c.OpenQuestions) != 2 || c.OpenQuestions[0] != "Q1" || c.OpenQuestions[1] != "Q2" {
		t.Errorf("questions: %v", c.OpenQuestions)
	}
	if len(c.Risks) != 2 {
		t.Fatalf("risks count: %d", len(c.Risks))
	}
	if c.Risks[0].Severity != "low" || c.Risks[1].Severity != "high" {
		t.Errorf("severity order: %+v", c.Risks)
	}
}

// TestParseInlineCaptures_MultilineText —— tag 内文本允许跨行。
func TestParseInlineCaptures_MultilineText(t *testing.T) {
	src := "<open_question>这个问题\n跨了一行</open_question>"
	c := parseInlineCaptures(src)
	if len(c.OpenQuestions) != 1 {
		t.Fatalf("want 1 question, got %d", len(c.OpenQuestions))
	}
	if !strings.Contains(c.OpenQuestions[0], "跨了一行") {
		t.Errorf("multiline not captured: %q", c.OpenQuestions[0])
	}
}

// TestParseInlineCaptures_EmptyTag —— 空 tag 忽略，不应产生空条目污染面板。
func TestParseInlineCaptures_EmptyTag(t *testing.T) {
	src := "<open_question>   </open_question><risk severity=\"high\">  </risk>正文"
	c := parseInlineCaptures(src)
	if c.HasAny() {
		// 注意：当前实现对全空白的 open_question tag 在 FindAllStringSubmatch 层面
		// 因为 `\s*(.+?)\s*` 里 (.+?) 要求至少 1 非空白字符，所以确实会被丢弃。
		// 如果将来 regex 改动导致空 tag 也被捕获，这个断言就会提前报警。
		t.Errorf("empty tags should be ignored, got q=%v r=%v", c.OpenQuestions, c.Risks)
	}
}

// TestCollapseBlankLines —— tag 剥离后遗留的多个空行应折叠到最多一个空行。
func TestCollapseBlankLines(t *testing.T) {
	in := "a\n\n\n\nb"
	if got := collapseBlankLines(in); got != "a\n\nb" {
		t.Errorf("collapse: got %q", got)
	}
}
