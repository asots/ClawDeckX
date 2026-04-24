package agentroom

import (
	"strings"
	"testing"
)

func TestChunkMarkdown_PlainText(t *testing.T) {
	in := "just a single paragraph with some content."
	chunks := ChunkMarkdown(in)
	if len(chunks) != 1 {
		t.Fatalf("expect 1 chunk, got %d", len(chunks))
	}
	if chunks[0].Content != in {
		t.Fatalf("content mismatch: %q", chunks[0].Content)
	}
	if chunks[0].Heading != "" {
		t.Fatalf("no heading expected; got %q", chunks[0].Heading)
	}
}

func TestChunkMarkdown_HeadingHierarchy(t *testing.T) {
	in := "# Top\n\npara A\n\n## Sub\n\npara B\n\n### Sub2\n\npara C"
	chunks := ChunkMarkdown(in)
	if len(chunks) != 3 {
		t.Fatalf("expect 3 chunks; got %d", len(chunks))
	}
	// 依次 Top/Top>Sub/Top>Sub>Sub2
	want := []string{"Top", "Top > Sub", "Top > Sub > Sub2"}
	for i, c := range chunks {
		if c.Heading != want[i] {
			t.Fatalf("chunk %d heading=%q want=%q", i, c.Heading, want[i])
		}
	}
}

func TestChunkMarkdown_ResetDeeperOnHigherHeading(t *testing.T) {
	// H2 之后再遇到 H1，应该清掉 H2
	in := "# A\n\naa\n\n## B\n\nbb\n\n# C\n\ncc"
	chunks := ChunkMarkdown(in)
	if len(chunks) != 3 {
		t.Fatalf("expect 3 chunks; got %d", len(chunks))
	}
	if chunks[2].Heading != "C" {
		t.Fatalf("after new H1, heading should reset to 'C'; got %q", chunks[2].Heading)
	}
}

func TestChunkMarkdown_SoftSizeSplit(t *testing.T) {
	// 单一段落 > DocChunkSoftSize，应该被软切成多段
	big := strings.Repeat("段落内容 ", 400) // 约 1200 CJK chars
	chunks := ChunkMarkdown(big)
	if len(chunks) < 2 {
		t.Fatalf("expect >=2 chunks for oversized paragraph; got %d", len(chunks))
	}
}

func TestChunkMarkdown_EmptyInput(t *testing.T) {
	if got := ChunkMarkdown(""); len(got) != 0 {
		t.Fatalf("empty input → no chunks; got %d", len(got))
	}
	if got := ChunkMarkdown("\n\n   \n"); len(got) != 0 {
		t.Fatalf("whitespace-only → no chunks; got %d", len(got))
	}
}

func TestChunkMarkdown_MaxChunkLimit(t *testing.T) {
	// 构造一个一定会超过 MaxChunksPerDoc 的文档：大量小标题
	var b strings.Builder
	for i := 0; i < MaxChunksPerDoc+50; i++ {
		b.WriteString("## h\n\npara\n\n")
	}
	chunks := ChunkMarkdown(b.String())
	if len(chunks) != MaxChunksPerDoc {
		t.Fatalf("expect capped at %d; got %d", MaxChunksPerDoc, len(chunks))
	}
}

func TestSplitLarge_WithinSize(t *testing.T) {
	out := splitLarge("short", 100)
	if len(out) != 1 || out[0] != "short" {
		t.Fatalf("unexpected: %v", out)
	}
}

func TestSplitLarge_ByParagraph(t *testing.T) {
	p1 := strings.Repeat("x", 50)
	p2 := strings.Repeat("y", 50)
	p3 := strings.Repeat("z", 50)
	in := p1 + "\n\n" + p2 + "\n\n" + p3
	out := splitLarge(in, 60) // 单段 > 60，所以应该按段落切
	if len(out) < 2 {
		t.Fatalf("expect multi-segment; got %d", len(out))
	}
}
