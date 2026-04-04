package handlers

import (
	"encoding/json"
	"net/http"
	"os"
	"time"

	"ClawDeckX/internal/constants"
	"ClawDeckX/internal/database"
	"ClawDeckX/internal/logger"
	"ClawDeckX/internal/openclaw"
	"ClawDeckX/internal/web"
)

// ConfigHandler manages OpenClaw config read/write.
type ConfigHandler struct {
	auditRepo *database.AuditLogRepo
}

func NewConfigHandler() *ConfigHandler {
	return &ConfigHandler{
		auditRepo: database.NewAuditLogRepo(),
	}
}

// configPath returns the OpenClaw config file path.
func configPath() string {
	return openclaw.ResolveConfigPath()
}

// Get reads the OpenClaw config.
func (h *ConfigHandler) Get(w http.ResponseWriter, r *http.Request) {
	path := configPath()
	if path == "" {
		web.FailErr(w, r, web.ErrConfigPathError)
		return
	}

	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			web.FailErr(w, r, web.ErrConfigNotFound)
			return
		}
		web.FailErr(w, r, web.ErrConfigReadFailed)
		return
	}

	// parse as JSON object
	var cfg map[string]interface{}
	if err := json.Unmarshal(data, &cfg); err != nil {
		// return raw text
		web.OK(w, r, map[string]interface{}{
			"raw":    string(data),
			"parsed": false,
		})
		return
	}

	web.OK(w, r, map[string]interface{}{
		"config": cfg,
		"path":   path,
		"parsed": true,
	})
}

// Update updates the OpenClaw config via openclaw CLI only.
func (h *ConfigHandler) Update(w http.ResponseWriter, r *http.Request) {
	path := configPath()
	if path == "" {
		web.FailErr(w, r, web.ErrConfigPathError)
		return
	}

	var req struct {
		Config map[string]interface{} `json:"config"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}

	if req.Config == nil {
		web.FailErr(w, r, web.ErrConfigEmpty)
		return
	}

	if !openclaw.IsOpenClawInstalled() {
		web.FailErr(w, r, web.ErrConfigWriteFailed, "openclaw CLI is required for config updates")
		return
	}

	if err := openclaw.ConfigApplyFull(req.Config); err != nil {
		logger.Config.Error().Err(err).Msg("openclaw config set failed")
		web.FailErr(w, r, web.ErrConfigWriteFailed, err.Error())
		return
	}

	// audit log
	h.auditRepo.Create(&database.AuditLog{
		UserID:   web.GetUserID(r),
		Username: web.GetUsername(r),
		Action:   constants.ActionConfigUpdate,
		Result:   "success",
		IP:       r.RemoteAddr,
	})

	logger.Config.Info().Str("user", web.GetUsername(r)).Str("path", path).Msg("OpenClaw config updated")
	web.OK(w, r, map[string]string{"message": "ok"})
}

// SetKey sets a single config key.
// POST /api/v1/config/set-key
func (h *ConfigHandler) SetKey(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Key   string `json:"key"`
		Value string `json:"value"`
		JSON  bool   `json:"json"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}

	if req.Key == "" || req.Value == "" {
		web.FailErr(w, r, web.ErrInvalidParam)
		return
	}

	if !openclaw.IsOpenClawInstalled() {
		web.FailErr(w, r, web.ErrOpenClawNotInstalled)
		return
	}

	var err error
	if req.JSON {
		err = openclaw.ConfigSet(req.Key, req.Value)
	} else {
		err = openclaw.ConfigSetString(req.Key, req.Value)
	}

	if err != nil {
		web.FailErr(w, r, web.ErrConfigWriteFailed, err.Error())
		return
	}

	h.auditRepo.Create(&database.AuditLog{
		UserID:   web.GetUserID(r),
		Username: web.GetUsername(r),
		Action:   constants.ActionConfigUpdate,
		Result:   "success",
		Detail:   "config set " + req.Key,
		IP:       r.RemoteAddr,
	})

	logger.Config.Info().Str("user", web.GetUsername(r)).Str("key", req.Key).Msg("config key updated")
	web.OK(w, r, map[string]string{"message": "ok", "key": req.Key})
}

// UnsetKey removes a single config key.
// POST /api/v1/config/unset-key
func (h *ConfigHandler) UnsetKey(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Key string `json:"key"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}

	if req.Key == "" {
		web.FailErr(w, r, web.ErrInvalidParam)
		return
	}

	if !openclaw.IsOpenClawInstalled() {
		web.FailErr(w, r, web.ErrOpenClawNotInstalled)
		return
	}

	if err := openclaw.ConfigUnset(req.Key); err != nil {
		web.FailErr(w, r, web.ErrConfigWriteFailed, err.Error())
		return
	}

	h.auditRepo.Create(&database.AuditLog{
		UserID:   web.GetUserID(r),
		Username: web.GetUsername(r),
		Action:   constants.ActionConfigUpdate,
		Result:   "success",
		Detail:   "config unset " + req.Key,
		IP:       r.RemoteAddr,
	})

	logger.Config.Info().Str("user", web.GetUsername(r)).Str("key", req.Key).Msg("config key removed")
	web.OK(w, r, map[string]string{"message": "ok", "key": req.Key})
}

// GetKey reads a single config key.
// GET /api/v1/config/get-key
func (h *ConfigHandler) GetKey(w http.ResponseWriter, r *http.Request) {
	key := r.URL.Query().Get("key")
	if key == "" {
		web.FailErr(w, r, web.ErrInvalidParam)
		return
	}

	if !openclaw.IsOpenClawInstalled() {
		web.FailErr(w, r, web.ErrOpenClawNotInstalled)
		return
	}

	value, err := openclaw.ConfigGet(key)
	if err != nil {
		web.FailErr(w, r, web.ErrConfigReadFailed, err.Error())
		return
	}

	web.OK(w, r, map[string]interface{}{"key": key, "value": json.RawMessage(value)})
}

// Validate validates a config payload via OpenClaw CLI checks.
// POST /api/v1/config/validate
func (h *ConfigHandler) Validate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Config map[string]interface{} `json:"config"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	if req.Config == nil {
		web.FailErr(w, r, web.ErrConfigEmpty)
		return
	}
	if !openclaw.IsOpenClawInstalled() {
		web.FailErr(w, r, web.ErrConfigValidateCLIAbsent)
		return
	}

	start := time.Now()
	result, err := openclaw.ConfigValidate(req.Config)
	if err != nil {
		logger.Config.Error().Err(err).Msg("config validate failed")
		web.FailErr(w, r, web.ErrConfigValidateFailed, err.Error())
		return
	}

	h.auditRepo.Create(&database.AuditLog{
		UserID:   web.GetUserID(r),
		Username: web.GetUsername(r),
		Action:   constants.ActionConfigUpdate,
		Result:   map[bool]string{true: "success", false: "failed"}[result.OK],
		Detail:   "config validate",
		IP:       r.RemoteAddr,
	})

	web.OK(w, r, map[string]interface{}{
		"ok":      result.OK,
		"code":    result.Code,
		"summary": result.Summary,
		"issues":  result.Issues,
		"meta": map[string]interface{}{
			"duration_ms":  time.Since(start).Milliseconds(),
			"validated_at": time.Now().UTC().Format(time.RFC3339),
		},
	})
}

// GenerateDefault generates a default config file via openclaw CLI.
// POST /api/v1/config/generate-default
func (h *ConfigHandler) GenerateDefault(w http.ResponseWriter, r *http.Request) {
	path := configPath()
	if path == "" {
		web.FailErr(w, r, web.ErrConfigPathError)
		return
	}

	// do not overwrite existing config
	if _, err := os.Stat(path); err == nil {
		web.Fail(w, r, "CONFIG_EXISTS", "config file already exists", http.StatusConflict)
		return
	}

	if !openclaw.IsOpenClawInstalled() {
		web.FailErr(w, r, web.ErrOpenClawNotInstalled)
		return
	}

	output, err := openclaw.InitDefaultConfig()
	if err != nil {
		web.FailErr(w, r, web.ErrConfigWriteFailed, err.Error())
		return
	}

	h.auditRepo.Create(&database.AuditLog{
		UserID:   web.GetUserID(r),
		Username: web.GetUsername(r),
		Action:   constants.ActionConfigUpdate,
		Result:   "success",
		Detail:   "generated default config via openclaw CLI",
		IP:       r.RemoteAddr,
	})

	logger.Config.Info().Str("user", web.GetUsername(r)).Str("path", path).Str("output", output).Msg("default config generated via CLI")
	web.OK(w, r, map[string]string{"message": "ok", "path": path})
}
