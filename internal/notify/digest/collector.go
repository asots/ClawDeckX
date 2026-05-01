package digest

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"ClawDeckX/internal/database"
)

// GatewayClient is the small subset of openclaw.GWClient we need. Defined as
// an interface so digest tests can stub it. The signature mirrors the real
// GWClient method exactly so concrete clients satisfy the interface without
// adapters.
type GatewayClient interface {
	IsConnected() bool
	RequestWithTimeout(method string, params interface{}, timeout time.Duration) (json.RawMessage, error)
}

// UpdateChecker reports whether a newer ClawDeckX release is available.
type UpdateChecker interface {
	HasUpdate() (bool, string)
}

// DreamProvider is a pluggable interface for the future dream module. It is
// allowed to return an empty string when no dream is available.
type DreamProvider interface {
	LatestSummary(ctx context.Context, win Window) (title, summary, link string, ok bool)
}

// Collector implements per-section data gathering. Every Run() entry point
// returns nil if the section is unknown so callers can skip cleanly.
type Collector struct {
	alertRepo     *database.AlertRepo
	auditRepo     *database.AuditLogRepo
	lifecycleRepo *database.GatewayLifecycleRepo
	snapshotRepo  *database.SnapshotRepo
	gw            GatewayClient
	updates       UpdateChecker
	dream         DreamProvider
	titleFn       func(SectionID) string // localized title resolver
	lang          string
}

// CollectorOptions wires concrete dependencies into a Collector.
type CollectorOptions struct {
	Gateway       GatewayClient
	Updates       UpdateChecker
	Dream         DreamProvider
	TitleResolver func(SectionID) string
}

// NewCollector builds a Collector backed by ClawDeckX's standard repos. Pass
// nil for any optional dependency to disable the corresponding section.
func NewCollector(opts CollectorOptions) *Collector {
	c := &Collector{
		alertRepo:     database.NewAlertRepo(),
		auditRepo:     database.NewAuditLogRepo(),
		lifecycleRepo: database.NewGatewayLifecycleRepo(),
		snapshotRepo:  database.NewSnapshotRepo(),
		gw:            opts.Gateway,
		updates:       opts.Updates,
		dream:         opts.Dream,
		titleFn:       opts.TitleResolver,
	}
	return c
}

func (c *Collector) title(id SectionID, fallback string) string {
	if c.titleFn != nil {
		if v := c.titleFn(id); v != "" {
			return v
		}
	}
	return fallback
}

func (c *Collector) tr(key string, args ...interface{}) string {
	return tr(c.lang, key, args...)
}

// Run dispatches to the section-specific collector.
func (c *Collector) Run(ctx context.Context, id SectionID, win Window) (*Section, error) {
	switch id {
	case SectionHealth:
		return c.health(ctx, win)
	case SectionAlerts:
		return c.alerts(ctx, win)
	case SectionEvents:
		return c.events(ctx, win)
	case SectionSessions:
		return c.sessions(ctx, win)
	case SectionTools:
		return c.tools(ctx, win)
	case SectionAudit:
		return c.audit(ctx, win)
	case SectionDream:
		return c.dreamSection(ctx, win)
	case SectionSnapshots:
		return c.snapshots(ctx, win)
	case SectionUpdate:
		return c.update(ctx, win)
	case SectionPending:
		return c.pending(ctx, win)
	}
	return nil, nil
}

// ── Health ────────────────────────────────────────────────────────────────
// Uses gateway lifecycle records to estimate downtime windows for the day.
func (c *Collector) health(_ context.Context, win Window) (*Section, error) {
	sec := &Section{ID: SectionHealth, Title: c.title(SectionHealth, "Gateway Health")}
	records, _, err := c.lifecycleRepo.List(database.GatewayLifecycleFilter{
		Page:     1,
		PageSize: 500,
		Since:    win.Start.Format(time.RFC3339),
		Until:    win.End.Format(time.RFC3339),
	})
	if err != nil {
		return nil, err
	}
	var crashed, unreachable, restarted, recovered int
	for _, r := range records {
		switch r.EventType {
		case "crashed":
			crashed++
		case "unreachable":
			unreachable++
		case "heartbeat_restart":
			restarted++
		case "recovered":
			recovered++
		}
	}
	totalDown := crashed + unreachable
	if totalDown == 0 && restarted == 0 {
		sec.Empty = true
		return sec, nil
	}
	if crashed > 0 {
		sec.Lines = append(sec.Lines, c.tr("crashes", crashed))
	}
	if unreachable > 0 {
		sec.Lines = append(sec.Lines, c.tr("unreachable", unreachable))
	}
	if restarted > 0 {
		sec.Lines = append(sec.Lines, c.tr("restart", restarted))
	}
	if recovered > 0 {
		sec.Lines = append(sec.Lines, c.tr("recovered", recovered))
	}
	return sec, nil
}

// ── Alerts ────────────────────────────────────────────────────────────────
func (c *Collector) alerts(_ context.Context, win Window) (*Section, error) {
	sec := &Section{ID: SectionAlerts, Title: c.title(SectionAlerts, "Alerts")}
	alerts, total, err := c.alertRepo.List(database.AlertFilter{
		Page:      1,
		PageSize:  100,
		StartTime: win.Start.Format(time.RFC3339),
		EndTime:   win.End.Format(time.RFC3339),
	})
	if err != nil {
		return nil, err
	}
	if total == 0 {
		sec.Empty = true
		return sec, nil
	}
	risks := map[string]int{}
	for _, a := range alerts {
		risks[a.Risk]++
	}
	parts := make([]string, 0, len(risks))
	for _, k := range []string{"critical", "high", "medium", "low"} {
		if v, ok := risks[k]; ok && v > 0 {
			parts = append(parts, fmt.Sprintf("%s=%d", k, v))
		}
	}
	sec.Lines = append(sec.Lines, c.tr("alerts_total", total, strings.Join(parts, ", ")))
	// Top 3 by risk severity then time desc (already sorted desc by created_at)
	max := 3
	if len(alerts) < max {
		max = len(alerts)
	}
	for i := 0; i < max; i++ {
		a := alerts[i]
		title := strings.TrimSpace(a.Message)
		if title == "" {
			title = a.Risk
		}
		if len(title) > 80 {
			title = title[:77] + "…"
		}
		sec.Lines = append(sec.Lines, fmt.Sprintf("  - [%s] %s", a.Risk, title))
	}
	return sec, nil
}

// ── Events (lifecycle counts beyond health summary) ───────────────────────
func (c *Collector) events(_ context.Context, win Window) (*Section, error) {
	sec := &Section{ID: SectionEvents, Title: c.title(SectionEvents, "Lifecycle Events")}
	records, _, err := c.lifecycleRepo.List(database.GatewayLifecycleFilter{
		Page:     1,
		PageSize: 500,
		Since:    win.Start.Format(time.RFC3339),
		Until:    win.End.Format(time.RFC3339),
	})
	if err != nil {
		return nil, err
	}
	if len(records) == 0 {
		sec.Empty = true
		return sec, nil
	}
	counts := map[string]int{}
	for _, r := range records {
		counts[r.EventType]++
	}
	keys := make([]string, 0, len(counts))
	for k := range counts {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		sec.Lines = append(sec.Lines, fmt.Sprintf("• %s: %d", c.eventLabel(k), counts[k]))
	}
	return sec, nil
}

// ── Sessions (gateway sessions.usage RPC) ─────────────────────────────────
func (c *Collector) sessions(_ context.Context, win Window) (*Section, error) {
	sec := &Section{ID: SectionSessions, Title: c.title(SectionSessions, "Sessions Usage")}
	if c.gw == nil || !c.gw.IsConnected() {
		sec.Empty = true
		return sec, nil
	}
	params := map[string]interface{}{
		"since": win.Start.Format(time.RFC3339),
		"until": win.End.Format(time.RFC3339),
	}
	data, err := c.gw.RequestWithTimeout("sessions.usage", params, 10*time.Second)
	if err != nil {
		// Don't bubble up – usage may not be supported on every plugin set.
		sec.Empty = true
		return sec, nil
	}
	var raw struct {
		TotalMessages int               `json:"total_messages"`
		TotalTokens   int               `json:"total_tokens"`
		TotalCostUSD  float64           `json:"total_cost_usd"`
		Sessions      []json.RawMessage `json:"sessions"`
		Models        map[string]int    `json:"models"`
	}
	_ = json.Unmarshal(data, &raw)
	if raw.TotalMessages == 0 && raw.TotalTokens == 0 && len(raw.Sessions) == 0 {
		sec.Empty = true
		return sec, nil
	}
	sec.Lines = append(sec.Lines, c.tr("sessions_count", len(raw.Sessions)))
	if raw.TotalMessages > 0 {
		sec.Lines = append(sec.Lines, c.tr("messages", raw.TotalMessages))
	}
	if raw.TotalTokens > 0 {
		sec.Lines = append(sec.Lines, c.tr("tokens", humanInt(raw.TotalTokens)))
	}
	if raw.TotalCostUSD > 0 {
		sec.Lines = append(sec.Lines, c.tr("cost", raw.TotalCostUSD))
	}
	if len(raw.Models) > 0 {
		type kv struct {
			K string
			V int
		}
		list := make([]kv, 0, len(raw.Models))
		for k, v := range raw.Models {
			list = append(list, kv{k, v})
		}
		sort.Slice(list, func(i, j int) bool { return list[i].V > list[j].V })
		max := 3
		if len(list) < max {
			max = len(list)
		}
		var parts []string
		for i := 0; i < max; i++ {
			parts = append(parts, fmt.Sprintf("%s×%d", list[i].K, list[i].V))
		}
		sec.Lines = append(sec.Lines, c.tr("top_models", strings.Join(parts, ", ")))
	}
	return sec, nil
}

// ── Tools (best-effort – pulls top-level tool stats from sessions.usage) ──
func (c *Collector) tools(_ context.Context, win Window) (*Section, error) {
	sec := &Section{ID: SectionTools, Title: c.title(SectionTools, "Tool Calls")}
	if c.gw == nil || !c.gw.IsConnected() {
		sec.Empty = true
		return sec, nil
	}
	params := map[string]interface{}{
		"since": win.Start.Format(time.RFC3339),
		"until": win.End.Format(time.RFC3339),
	}
	data, err := c.gw.RequestWithTimeout("sessions.usage", params, 10*time.Second)
	if err != nil {
		sec.Empty = true
		return sec, nil
	}
	var raw struct {
		ToolCalls  int            `json:"tool_calls"`
		ToolErrors int            `json:"tool_errors"`
		TopTools   map[string]int `json:"top_tools"`
	}
	_ = json.Unmarshal(data, &raw)
	if raw.ToolCalls == 0 && len(raw.TopTools) == 0 {
		sec.Empty = true
		return sec, nil
	}
	sec.Lines = append(sec.Lines, c.tr("calls", raw.ToolCalls, raw.ToolErrors))
	if len(raw.TopTools) > 0 {
		type kv struct {
			K string
			V int
		}
		list := make([]kv, 0, len(raw.TopTools))
		for k, v := range raw.TopTools {
			list = append(list, kv{k, v})
		}
		sort.Slice(list, func(i, j int) bool { return list[i].V > list[j].V })
		max := 3
		if len(list) < max {
			max = len(list)
		}
		var parts []string
		for i := 0; i < max; i++ {
			parts = append(parts, fmt.Sprintf("%s×%d", list[i].K, list[i].V))
		}
		sec.Lines = append(sec.Lines, c.tr("top_tools", strings.Join(parts, ", ")))
	}
	return sec, nil
}

// ── Audit (config / settings changes) ─────────────────────────────────────
func (c *Collector) audit(_ context.Context, win Window) (*Section, error) {
	sec := &Section{ID: SectionAudit, Title: c.title(SectionAudit, "Operations")}
	logs, total, err := c.auditRepo.List(database.AuditFilter{
		Page:      1,
		PageSize:  200,
		StartTime: win.Start.Format(time.RFC3339),
		EndTime:   win.End.Format(time.RFC3339),
	})
	if err != nil {
		return nil, err
	}
	if total == 0 {
		sec.Empty = true
		return sec, nil
	}
	actions := map[string]int{}
	for _, l := range logs {
		actions[l.Action]++
	}
	type kv struct {
		K string
		V int
	}
	list := make([]kv, 0, len(actions))
	for k, v := range actions {
		list = append(list, kv{k, v})
	}
	sort.Slice(list, func(i, j int) bool { return list[i].V > list[j].V })
	sec.Lines = append(sec.Lines, c.tr("ops_total", total))
	max := 3
	if len(list) < max {
		max = len(list)
	}
	for i := 0; i < max; i++ {
		sec.Lines = append(sec.Lines, fmt.Sprintf("  - %s ×%d", list[i].K, list[i].V))
	}
	return sec, nil
}

// ── Dream (placeholder until ClawDeckX dream backend is finalised) ────────
func (c *Collector) dreamSection(ctx context.Context, win Window) (*Section, error) {
	sec := &Section{ID: SectionDream, Title: c.title(SectionDream, "Dream")}
	if c.dream == nil {
		sec.Empty = true
		return sec, nil
	}
	title, summary, link, ok := c.dream.LatestSummary(ctx, win)
	if !ok {
		sec.Empty = true
		return sec, nil
	}
	if title != "" {
		sec.Lines = append(sec.Lines, "• "+title)
	}
	if summary != "" {
		// Keep it terse – dream content is already trimmed by the provider.
		if len(summary) > 240 {
			summary = summary[:237] + "…"
		}
		sec.Lines = append(sec.Lines, summary)
	}
	if link != "" {
		sec.Lines = append(sec.Lines, "↗ "+link)
	}
	return sec, nil
}

// ── Snapshots (config backups created during the day) ─────────────────────
func (c *Collector) snapshots(_ context.Context, win Window) (*Section, error) {
	sec := &Section{ID: SectionSnapshots, Title: c.title(SectionSnapshots, "Backups")}
	records, err := c.snapshotRepo.List()
	if err != nil {
		return nil, err
	}
	count := 0
	auto := 0
	for _, r := range records {
		if r.CreatedAt.Before(win.Start) || !r.CreatedAt.Before(win.End) {
			continue
		}
		count++
		if strings.EqualFold(r.Trigger, "auto") || strings.EqualFold(r.Trigger, "scheduled") {
			auto++
		}
	}
	if count == 0 {
		sec.Empty = true
		return sec, nil
	}
	sec.Lines = append(sec.Lines, c.tr("backups", count, auto))
	return sec, nil
}

// ── Update reminder ───────────────────────────────────────────────────────
func (c *Collector) update(_ context.Context, _ Window) (*Section, error) {
	sec := &Section{ID: SectionUpdate, Title: c.title(SectionUpdate, "Updates")}
	if c.updates == nil {
		sec.Empty = true
		return sec, nil
	}
	has, ver := c.updates.HasUpdate()
	if !has {
		sec.Empty = true
		return sec, nil
	}
	sec.Lines = append(sec.Lines, c.tr("new_version", ver))
	return sec, nil
}

// ── Pending (unread alerts, future: pairing requests) ─────────────────────
func (c *Collector) pending(_ context.Context, _ Window) (*Section, error) {
	sec := &Section{ID: SectionPending, Title: c.title(SectionPending, "Action Items")}
	unread, err := c.alertRepo.CountUnread()
	if err != nil {
		return nil, err
	}
	if unread == 0 {
		sec.Empty = true
		return sec, nil
	}
	sec.Lines = append(sec.Lines, c.tr("unread_alerts", unread))
	return sec, nil
}

// ── helpers ───────────────────────────────────────────────────────────────
func humanInt(n int) string {
	switch {
	case n >= 1_000_000:
		return fmt.Sprintf("%.2fM", float64(n)/1_000_000)
	case n >= 1_000:
		return fmt.Sprintf("%.1fk", float64(n)/1_000)
	default:
		return fmt.Sprintf("%d", n)
	}
}

func (c *Collector) eventLabel(eventType string) string {
	key := "event_" + eventType
	label := c.tr(key)
	if label == key || label == "" {
		return eventType
	}
	return label
}

func trimErr(err error) string {
	msg := err.Error()
	if len(msg) > 80 {
		msg = msg[:77] + "…"
	}
	return msg
}
