package handlers

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"ClawDeckX/internal/i18n"
	"ClawDeckX/internal/logger"
	"ClawDeckX/internal/web"
	"ClawDeckX/internal/webconfig"
)

// ServerConfigHandler handles GET/PUT for the server's own network config (bind, port, CORS).
type ServerConfigHandler struct{}

func NewServerConfigHandler() *ServerConfigHandler {
	return &ServerConfigHandler{}
}

type serverConfigPayload struct {
	Bind            string   `json:"bind"`
	Port            int      `json:"port"`
	CORSOrigins     []string `json:"cors_origins"`
	ClawHubQueryURL string   `json:"clawhub_query_url"`
	ClawHubSource   string   `json:"clawhub_source"`
	SkillHubDataURL string   `json:"skillhub_data_url"`
}

// Get returns the current server config.
// GET /api/v1/server-config
func (h *ServerConfigHandler) Get(w http.ResponseWriter, r *http.Request) {
	cfg, err := webconfig.Load()
	if err != nil {
		web.Fail(w, r, "SERVER_CONFIG_LOAD_ERROR", err.Error(), http.StatusInternalServerError)
		return
	}
	web.OK(w, r, serverConfigPayload{
		Bind:            cfg.Server.Bind,
		Port:            cfg.Server.Port,
		CORSOrigins:     cfg.Server.CORSOrigins,
		ClawHubQueryURL: cfg.Server.ClawHubQueryURL,
		ClawHubSource:   cfg.Server.ClawHubSource,
		SkillHubDataURL: cfg.Server.SkillHubDataURL,
	})
}

// Update saves the server config. Changes require a restart to take effect.
// PUT /api/v1/server-config
func (h *ServerConfigHandler) Update(w http.ResponseWriter, r *http.Request) {
	var payload serverConfigPayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		web.Fail(w, r, "INVALID_REQUEST", "invalid JSON body", http.StatusBadRequest)
		return
	}

	// Validate port
	if payload.Port < 1 || payload.Port > 65535 {
		web.Fail(w, r, "INVALID_PORT", "port must be between 1 and 65535", http.StatusBadRequest)
		return
	}

	// Validate bind address
	bind := strings.TrimSpace(payload.Bind)
	if bind == "" {
		bind = "0.0.0.0"
	}

	// Load current config, update server section only, then save
	cfg, err := webconfig.Load()
	if err != nil {
		web.Fail(w, r, "SERVER_CONFIG_LOAD_ERROR", err.Error(), http.StatusInternalServerError)
		return
	}

	cfg.Server.Bind = bind
	cfg.Server.Port = payload.Port
	cfg.Server.CORSOrigins = payload.CORSOrigins
	cfg.Server.ClawHubQueryURL = strings.TrimRight(strings.TrimSpace(payload.ClawHubQueryURL), "/")
	// Normalize: strip legacy /api/query suffix so we always store the base URL
	cfg.Server.ClawHubQueryURL = strings.TrimSuffix(cfg.Server.ClawHubQueryURL, "/api/query")
	if cfg.Server.ClawHubQueryURL == "" {
		cfg.Server.ClawHubQueryURL = webconfig.Default().Server.ClawHubQueryURL
	}
	src := strings.ToLower(strings.TrimSpace(payload.ClawHubSource))
	if src != "convex" && src != "volces" {
		src = "convex"
	}
	cfg.Server.ClawHubSource = src
	cfg.Server.SkillHubDataURL = strings.TrimSpace(payload.SkillHubDataURL)
	if cfg.Server.SkillHubDataURL == "" {
		cfg.Server.SkillHubDataURL = webconfig.Default().Server.SkillHubDataURL
	}

	if err := webconfig.Save(cfg); err != nil {
		web.Fail(w, r, "SERVER_CONFIG_SAVE_ERROR", err.Error(), http.StatusInternalServerError)
		return
	}

	logger.Log.Info().
		Str("bind", bind).
		Int("port", payload.Port).
		Str("clawhub_source", cfg.Server.ClawHubSource).
		Msg(i18n.T(i18n.MsgLogServerConfigUpdated))

	web.OK(w, r, map[string]any{
		"bind":              bind,
		"port":              payload.Port,
		"cors_origins":      payload.CORSOrigins,
		"clawhub_query_url": cfg.Server.ClawHubQueryURL,
		"clawhub_source":    cfg.Server.ClawHubSource,
		"skillhub_data_url": cfg.Server.SkillHubDataURL,
		"restart":           true,
	})
}

// Restart restarts the ClawDeckX process so the latest server config takes
// effect. It defers the actual restart by ~1.5s so the HTTP response can flush.
// POST /api/v1/server-config/restart
func (h *ServerConfigHandler) Restart(w http.ResponseWriter, r *http.Request) {
	logger.Log.Info().
		Str("user", web.GetUsername(r)).
		Msg("ClawDeckX self-restart requested via API")

	web.OK(w, r, map[string]any{
		"message": "restarting",
	})

	go func() {
		time.Sleep(1500 * time.Millisecond)
		restartSelf()
	}()
}
