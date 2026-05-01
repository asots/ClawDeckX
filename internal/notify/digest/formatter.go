package digest

import "strings"

// FormatPlain renders the digest as a single plain-text body suitable for any
// notify channel (Telegram, Discord, DingTalk text, WeCom text, webhook). It
// avoids markdown decorators because some channels strip or escape them
// inconsistently.
func FormatPlain(subject string, sections []Section, lang string) string {
	var b strings.Builder
	b.WriteString(subject)
	b.WriteString("\n")
	b.WriteString(strings.Repeat("─", 24))
	b.WriteString("\n")
	written := 0
	for _, s := range sections {
		if s.Empty {
			continue
		}
		if written > 0 {
			b.WriteString("\n")
		}
		b.WriteString("【")
		b.WriteString(s.Title)
		b.WriteString("】\n")
		if len(s.Lines) == 0 {
			b.WriteString(tr(lang, "empty"))
			b.WriteString("\n")
			written++
			continue
		}
		for _, line := range s.Lines {
			b.WriteString(line)
			b.WriteString("\n")
		}
		written++
	}
	if written == 0 {
		b.WriteString(tr(lang, "empty"))
	}
	return strings.TrimRight(b.String(), "\n")
}
