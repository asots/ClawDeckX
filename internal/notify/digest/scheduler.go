package digest

import (
	"context"
	"strings"
	"sync"
	"time"

	"ClawDeckX/internal/logger"
)

// Scheduler runs the digest engine once per minute, firing Run() when the
// configured local time is reached. It also handles missed-run catch-up: if
// the host was offline at the configured time and we are now within the
// catch-up window, the digest is dispatched as soon as the scheduler boots.
type Scheduler struct {
	engine   *Engine
	settings SettingsRepo

	mu     sync.Mutex
	cancel context.CancelFunc

	// Used by tests to override "now".
	nowFn func() time.Time
}

// NewScheduler returns a stopped scheduler. Call Start to launch the loop.
func NewScheduler(engine *Engine, settings SettingsRepo) *Scheduler {
	return &Scheduler{engine: engine, settings: settings, nowFn: time.Now}
}

// Start launches the scheduler goroutine. It is safe to call Start multiple
// times; subsequent calls replace the running loop.
func (s *Scheduler) Start(ctx context.Context) {
	s.mu.Lock()
	if s.cancel != nil {
		s.cancel()
	}
	c, cancel := context.WithCancel(ctx)
	s.cancel = cancel
	s.mu.Unlock()

	go s.loop(c)
}

// Stop terminates the running loop, if any.
func (s *Scheduler) Stop() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cancel != nil {
		s.cancel()
		s.cancel = nil
	}
}

func (s *Scheduler) loop(ctx context.Context) {
	// Slight startup delay so the gateway has time to connect before the first
	// catch-up tick (sessions.usage requires gateway connectivity).
	select {
	case <-ctx.Done():
		return
	case <-time.After(15 * time.Second):
	}

	s.tick(ctx, true)
	t := time.NewTicker(60 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.tick(ctx, false)
		}
	}
}

// tick checks whether a digest should be dispatched right now.
//
// startup=true triggers the catch-up path: if today's digest hasn't been sent
// yet and the configured time has already passed within the catch-up window,
// fire immediately.
func (s *Scheduler) tick(ctx context.Context, startup bool) {
	settings := LoadSettings(s.settings)
	if !settings.Enabled {
		return
	}

	now := s.nowFn()
	hh, mm, ok := parseHHMM(settings.Time)
	if !ok {
		return
	}

	loc := now.Location()
	target := time.Date(now.Year(), now.Month(), now.Day(), hh, mm, 0, 0, loc)
	todayStr := now.Format("2006-01-02")

	// Avoid double-dispatching once the date marker is already current day.
	if settings.LastSentDate == todayStr {
		return
	}

	shouldFire := false
	switch {
	case !startup:
		// Periodic tick: fire when we are within the same minute as target.
		if now.Year() == target.Year() && now.Month() == target.Month() &&
			now.Day() == target.Day() && now.Hour() == target.Hour() &&
			now.Minute() == target.Minute() {
			shouldFire = true
		}
	case startup:
		// Catch-up: target time today already passed and we are still within
		// the user-allowed grace window.
		if !now.Before(target) {
			grace := time.Duration(settings.CatchupHours) * time.Hour
			if now.Sub(target) <= grace {
				shouldFire = true
			}
		}
	}

	if !shouldFire {
		return
	}

	win := YesterdayWindow(now)
	logger.Log.Info().
		Str("digest_date", win.Date).
		Str("trigger", triggerName(startup)).
		Msg("digest: dispatching")
	res := s.engine.Run(ctx, win, settings, false)
	logger.Log.Info().
		Str("digest_date", win.Date).
		Str("status", res.Status).
		Int("sections", len(res.Sections)).
		Str("errors", strings.Join(res.Errors, "; ")).
		Msg("digest: dispatch complete")
}

func parseHHMM(s string) (int, int, bool) {
	parts := strings.Split(strings.TrimSpace(s), ":")
	if len(parts) != 2 {
		return 0, 0, false
	}
	h, mErr := atoiClamped(parts[0], 0, 23)
	m, hErr := atoiClamped(parts[1], 0, 59)
	if !mErr || !hErr {
		return 0, 0, false
	}
	return h, m, true
}

func atoiClamped(s string, min, max int) (int, bool) {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, false
		}
		n = n*10 + int(c-'0')
		if n > max {
			return 0, false
		}
	}
	if n < min {
		return 0, false
	}
	return n, true
}

func triggerName(startup bool) string {
	if startup {
		return "catchup"
	}
	return "scheduled"
}
