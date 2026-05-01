package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"ClawDeckX/internal/constants"
	"ClawDeckX/internal/database"
	"ClawDeckX/internal/logger"
	"ClawDeckX/internal/notify/digest"
	"ClawDeckX/internal/web"
)

// DigestHandler exposes /api/v1/notify/digest/* endpoints. It owns no extra
// state — the engine, collector and settings repo are shared with the rest of
// the notify subsystem.
type DigestHandler struct {
	settingRepo *database.SettingRepo
	auditRepo   *database.AuditLogRepo
	historyRepo *database.DailyDigestRepo
	engine      *digest.Engine
}

func NewDigestHandler(engine *digest.Engine) *DigestHandler {
	return &DigestHandler{
		settingRepo: database.NewSettingRepo(),
		auditRepo:   database.NewAuditLogRepo(),
		historyRepo: database.NewDailyDigestRepo(),
		engine:      engine,
	}
}

// GetConfig returns the digest configuration plus the static section catalog
// so the UI can render the chooser without hard-coding section ids.
func (h *DigestHandler) GetConfig(w http.ResponseWriter, r *http.Request) {
	cfg := make(map[string]string)
	for _, key := range digest.AllKeys() {
		v, _ := h.settingRepo.Get(key)
		cfg[key] = v
	}
	if cfg[digest.KeyDigestSections] == "" {
		// Surface "all enabled" as the explicit list so the UI checkboxes match.
		ids := make([]string, 0, len(digest.AllSections))
		for _, id := range digest.AllSections {
			ids = append(ids, string(id))
		}
		cfg[digest.KeyDigestSections] = strings.Join(ids, ",")
	}
	if cfg[digest.KeyDigestTime] == "" {
		cfg[digest.KeyDigestTime] = "08:00"
	}
	if cfg[digest.KeyDigestSkipIfEmpty] == "" {
		cfg[digest.KeyDigestSkipIfEmpty] = "true"
	}
	if cfg[digest.KeyDigestCatchupHours] == "" {
		cfg[digest.KeyDigestCatchupHours] = "6"
	}

	sections := make([]map[string]string, 0, len(digest.AllSections))
	for _, id := range digest.AllSections {
		sections = append(sections, map[string]string{"id": string(id)})
	}

	web.OK(w, r, map[string]interface{}{
		"config":     cfg,
		"sections":   sections,
		"timezone":   time.Now().Format("MST"),
		"local_time": time.Now().Format("15:04"),
	})
}

// UpdateConfig replaces the digest settings. Unknown keys are ignored.
func (h *DigestHandler) UpdateConfig(w http.ResponseWriter, r *http.Request) {
	var items map[string]string
	if err := json.NewDecoder(r.Body).Decode(&items); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	allowed := make(map[string]bool)
	for _, k := range digest.AllKeys() {
		allowed[k] = true
	}
	filtered := make(map[string]string)
	for k, v := range items {
		if allowed[k] {
			filtered[k] = v
		}
	}
	if len(filtered) == 0 {
		web.FailErr(w, r, web.ErrInvalidParam)
		return
	}
	// If the user changes the time or re-enables the digest, clear the
	// "last sent" marker so the new schedule isn't blocked by yesterday's run.
	if _, hasTime := filtered[digest.KeyDigestTime]; hasTime {
		filtered[digest.KeyDigestLastSentDate] = ""
	}
	if v, ok := filtered[digest.KeyDigestEnabled]; ok && v == "true" {
		filtered[digest.KeyDigestLastSentDate] = ""
	}

	if err := h.settingRepo.SetBatch(filtered); err != nil {
		web.FailErr(w, r, web.ErrSettingsUpdateFail)
		return
	}

	h.auditRepo.Create(&database.AuditLog{
		UserID:   web.GetUserID(r),
		Username: web.GetUsername(r),
		Action:   constants.ActionSettingsUpdate,
		Detail:   "daily digest config updated",
		Result:   "success",
		IP:       r.RemoteAddr,
	})
	logger.Log.Info().Str("user", web.GetUsername(r)).Msg("daily digest config updated")
	web.OK(w, r, map[string]string{"message": "ok"})
}

// Preview builds the digest body for yesterday without dispatching it.
func (h *DigestHandler) Preview(w http.ResponseWriter, r *http.Request) {
	if h.engine == nil {
		web.Fail(w, r, "DIGEST_DISABLED", "digest engine not initialised", http.StatusServiceUnavailable)
		return
	}
	settings := digest.LoadSettings(h.settingRepo)
	settings.Language = web.GetLanguage(r)
	win := digest.YesterdayWindow(time.Now())
	res := h.engine.Preview(r.Context(), win, settings.Sections, settings.Language)
	web.OK(w, r, map[string]interface{}{
		"date":     win.Date,
		"subject":  res.Subject,
		"content":  res.Content,
		"sections": flattenSections(res.Sections),
	})
}

// TestSend builds and dispatches the digest immediately. Used for "send now"
// in the UI; ignores skip_if_empty so the user always gets feedback.
func (h *DigestHandler) TestSend(w http.ResponseWriter, r *http.Request) {
	if h.engine == nil {
		web.Fail(w, r, "DIGEST_DISABLED", "digest engine not initialised", http.StatusServiceUnavailable)
		return
	}
	settings := digest.LoadSettings(h.settingRepo)
	settings.Language = web.GetLanguage(r)
	win := digest.YesterdayWindow(time.Now())
	res := h.engine.Run(context.Background(), win, settings, true)

	h.auditRepo.Create(&database.AuditLog{
		UserID:   web.GetUserID(r),
		Username: web.GetUsername(r),
		Action:   constants.ActionSettingsUpdate,
		Detail:   "daily digest test send: " + res.Status,
		Result:   res.Status,
		IP:       r.RemoteAddr,
	})

	web.OK(w, r, map[string]interface{}{
		"date":    win.Date,
		"status":  res.Status,
		"subject": res.Subject,
		"content": res.Content,
		"errors":  res.Errors,
	})
}

// History returns the latest digest run records (configurable up to 30).
func (h *DigestHandler) History(w http.ResponseWriter, r *http.Request) {
	limit := 7
	if v := r.URL.Query().Get("limit"); v != "" {
		var n int
		if _, err := readInt(v, &n); err == nil && n > 0 && n <= 30 {
			limit = n
		}
	}
	records, err := h.historyRepo.Recent(limit, true)
	if err != nil {
		web.FailErr(w, r, web.ErrInternalError)
		return
	}
	web.OK(w, r, map[string]interface{}{"list": records})
}

func flattenSections(sections []digest.Section) []map[string]interface{} {
	out := make([]map[string]interface{}, 0, len(sections))
	for _, s := range sections {
		out = append(out, map[string]interface{}{
			"id":    string(s.ID),
			"title": s.Title,
			"empty": s.Empty,
			"lines": s.Lines,
		})
	}
	return out
}

func readInt(s string, dst *int) (int, error) {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, errInvalidNumber
		}
		n = n*10 + int(c-'0')
	}
	*dst = n
	return n, nil
}

type digestErr string

func (e digestErr) Error() string { return string(e) }

const errInvalidNumber = digestErr("invalid number")
