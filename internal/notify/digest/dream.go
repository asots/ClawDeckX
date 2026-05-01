package digest

import "context"

// NoopDreamProvider returns no dream content. It exists so the digest engine
// can be wired up before the dream module is finalised.
type NoopDreamProvider struct{}

func (NoopDreamProvider) LatestSummary(_ context.Context, _ Window) (string, string, string, bool) {
	return "", "", "", false
}
