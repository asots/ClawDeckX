// Package digest implements the ClawDeckX daily summary report. It aggregates
// gateway health, alerts, lifecycle events, audit activity, sessions usage,
// snapshots, update status and (optional) dream content for the previous local
// day and dispatches a single human-readable message through the existing
// notification manager.
package digest

import (
	"context"
	"fmt"
	"strings"
	"time"

	"ClawDeckX/internal/database"
	"ClawDeckX/internal/logger"
	"ClawDeckX/internal/notify"
)

// SectionID identifies an individual chunk in the daily digest.
// The order here is the canonical render order.
type SectionID string

const (
	SectionHealth    SectionID = "health"
	SectionAlerts    SectionID = "alerts"
	SectionEvents    SectionID = "events"
	SectionSessions  SectionID = "sessions"
	SectionTools     SectionID = "tools"
	SectionAudit     SectionID = "audit"
	SectionDream     SectionID = "dream"
	SectionSnapshots SectionID = "snapshots"
	SectionUpdate    SectionID = "update"
	SectionPending   SectionID = "pending"
)

// AllSections lists every section in canonical display order. Whenever a new
// SectionID is added it must be appended here so the UI and defaults pick it up.
var AllSections = []SectionID{
	SectionHealth,
	SectionAlerts,
	SectionEvents,
	SectionSessions,
	SectionTools,
	SectionAudit,
	SectionDream,
	SectionSnapshots,
	SectionUpdate,
	SectionPending,
}

// Section is the rendered content for a single area in the digest.
type Section struct {
	ID    SectionID
	Title string // localized header
	Lines []string
	Empty bool // collector reports nothing of value for this period
}

// Window describes the inclusive-exclusive time range a digest covers.
type Window struct {
	Start time.Time // local timezone, beginning of day
	End   time.Time // local timezone, end of day (exclusive)
	Date  string    // YYYY-MM-DD label of Start
}

// Settings is the runtime configuration loaded from the settings repo.
type Settings struct {
	Enabled       bool
	Time          string // HH:MM, 24h, local timezone
	Sections      []SectionID
	Channels      []string // empty -> broadcast to all configured channels
	SkipIfEmpty   bool
	CatchupHours  int    // grace period for missed runs
	LastSentDate  string // YYYY-MM-DD
	DreamProvider string // reserved for future dream backends
	Language      string // en | zh | zh-TW | ja | ko
}

// SettingsRepo is the subset of *database.SettingRepo we need.
type SettingsRepo interface {
	Get(key string) (string, error)
	Set(key string, value string) error
	SetBatch(items map[string]string) error
}

// Engine orchestrates collection, formatting, dispatch and history bookkeeping.
type Engine struct {
	settings  SettingsRepo
	notify    *notify.Manager
	collector *Collector
	repo      *database.DailyDigestRepo
}

// NewEngine wires together the collectors, notify manager and history repo.
func NewEngine(settings SettingsRepo, mgr *notify.Manager, collector *Collector) *Engine {
	return &Engine{
		settings:  settings,
		notify:    mgr,
		collector: collector,
		repo:      database.NewDailyDigestRepo(),
	}
}

// LoadSettings reads digest-related settings from the repo, applying defaults.
func LoadSettings(repo SettingsRepo) Settings {
	out := Settings{
		Enabled:      false,
		Time:         "08:00",
		SkipIfEmpty:  true,
		CatchupHours: 6,
	}
	if v, _ := repo.Get(KeyDigestEnabled); v == "true" {
		out.Enabled = true
	}
	if v, _ := repo.Get(KeyDigestTime); v != "" {
		out.Time = v
	}
	if v, _ := repo.Get(KeyDigestSkipIfEmpty); v == "false" {
		out.SkipIfEmpty = false
	}
	if v, _ := repo.Get(KeyDigestCatchupHours); v != "" {
		var n int
		fmt.Sscanf(v, "%d", &n)
		if n > 0 && n <= 72 {
			out.CatchupHours = n
		}
	}
	out.Sections = parseSections(repo)
	if v, _ := repo.Get(KeyDigestChannels); v != "" {
		for _, ch := range strings.Split(v, ",") {
			if ch = strings.TrimSpace(ch); ch != "" {
				out.Channels = append(out.Channels, ch)
			}
		}
	}
	out.LastSentDate, _ = repo.Get(KeyDigestLastSentDate)
	out.DreamProvider, _ = repo.Get(KeyDigestDreamProvider)
	out.Language = normalizeLang(readLanguage(repo))
	return out
}

func readLanguage(repo SettingsRepo) string {
	if v, _ := repo.Get("language"); v != "" {
		return v
	}
	if v, _ := repo.Get("ui_language"); v != "" {
		return v
	}
	return "en"
}

// parseSections returns the active section set. If no key is set we default to
// "all sections enabled" — the user explicitly opted into this UX.
func parseSections(repo SettingsRepo) []SectionID {
	v, _ := repo.Get(KeyDigestSections)
	if v == "" {
		out := make([]SectionID, len(AllSections))
		copy(out, AllSections)
		return out
	}
	allow := make(map[SectionID]bool)
	for _, id := range AllSections {
		allow[id] = true
	}
	var out []SectionID
	seen := make(map[SectionID]bool)
	for _, raw := range strings.Split(v, ",") {
		id := SectionID(strings.TrimSpace(raw))
		if id == "" || !allow[id] || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out
}

// Window for "yesterday" in the server's local timezone.
func YesterdayWindow(now time.Time) Window {
	loc := now.Location()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc)
	start := today.AddDate(0, 0, -1)
	return Window{Start: start, End: today, Date: start.Format("2006-01-02")}
}

// Build collects every requested section for the given window. Failures inside
// individual collectors are logged and skipped — a partial digest is better
// than nothing.
func (e *Engine) Build(ctx context.Context, win Window, ids []SectionID, lang string) []Section {
	if len(ids) == 0 {
		ids = append([]SectionID{}, AllSections...)
	}
	lang = normalizeLang(lang)
	out := make([]Section, 0, len(ids))
	for _, id := range ids {
		e.collector.lang = lang
		sec, err := e.collector.Run(ctx, id, win)
		if err != nil {
			logger.Log.Warn().Err(err).Str("section", string(id)).Msg("digest: collector failed")
			continue
		}
		if sec == nil {
			continue
		}
		if sec.Empty {
			continue
		}
		sec.Title = SectionTitle(lang, sec.ID)
		out = append(out, *sec)
	}
	return out
}

// Result describes the outcome of an attempted dispatch.
type Result struct {
	Status   string // success | partial | empty | failed | preview
	Subject  string
	Content  string
	Sections []Section
	Errors   []string
}

// Run is the canonical "do everything" entry point used by the scheduler. It
// honours skip_if_empty, channel routing and idempotency on the digest_date.
func (e *Engine) Run(ctx context.Context, win Window, settings Settings, force bool) Result {
	res := Result{Status: "success"}
	lang := normalizeLang(settings.Language)
	res.Sections = e.Build(ctx, win, settings.Sections, lang)
	res.Subject = tr(lang, "subject", win.Date)
	allEmpty := true
	for _, s := range res.Sections {
		if !s.Empty {
			allEmpty = false
			break
		}
	}

	if allEmpty {
		res.Status = "empty"
	}
	if allEmpty && settings.SkipIfEmpty && !force {
		// Persist an "empty" record so we know we ran, but don't dispatch.
		res.Content = ""
		_ = e.persist(win, settings, res, "")
		return res
	}

	res.Content = FormatPlain(res.Subject, res.Sections, lang)

	// Dispatch
	channels := settings.Channels
	if len(channels) == 0 {
		channels = e.notify.ChannelNames()
	}
	if len(channels) == 0 {
		res.Status = "failed"
		res.Errors = append(res.Errors, "no notification channels configured")
		_ = e.persist(win, settings, res, strings.Join(res.Errors, "; "))
		return res
	}

	failed := 0
	for _, ch := range channels {
		if err := e.notify.SendToChannel(ch, res.Content); err != nil {
			failed++
			res.Errors = append(res.Errors, fmt.Sprintf("%s: %v", ch, err))
		}
	}
	switch {
	case failed == len(channels):
		res.Status = "failed"
	case failed > 0:
		res.Status = "partial"
	}

	errDetail := strings.Join(res.Errors, "; ")
	if err := e.persist(win, settings, res, errDetail); err != nil {
		logger.Log.Warn().Err(err).Msg("digest: failed to persist history")
	}

	if res.Status == "success" || res.Status == "partial" {
		_ = e.settings.Set(KeyDigestLastSentDate, win.Date)
	}
	return res
}

// Preview builds the digest text without dispatching or persisting state. It is
// used by the test/preview HTTP endpoint.
func (e *Engine) Preview(ctx context.Context, win Window, ids []SectionID, lang string) Result {
	lang = normalizeLang(lang)
	sections := e.Build(ctx, win, ids, lang)
	subject := tr(lang, "subject", win.Date)
	return Result{
		Status:   "preview",
		Subject:  subject,
		Content:  FormatPlain(subject, sections, lang),
		Sections: sections,
	}
}

func (e *Engine) persist(win Window, settings Settings, res Result, errDetail string) error {
	if e.repo == nil {
		return nil
	}
	sectionIDs := make([]string, 0, len(res.Sections))
	for _, s := range res.Sections {
		sectionIDs = append(sectionIDs, string(s.ID))
	}
	rec := &database.DailyDigest{
		DigestDate:  win.Date,
		GeneratedAt: time.Now(),
		Channels:    strings.Join(settings.Channels, ","),
		Sections:    strings.Join(sectionIDs, ","),
		Status:      res.Status,
		Subject:     res.Subject,
		Content:     res.Content,
		ErrorDetail: errDetail,
	}
	return e.repo.Create(rec)
}
