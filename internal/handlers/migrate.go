package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"ClawDeckX/internal/openclaw"
	"ClawDeckX/internal/web"
)

// MigrateHandler — Claude / Hermes importer wizard 的 HTTP 端点。
// 全部 endpoint 都委托给 internal/openclaw 的 CLI 封装，
// 不缓存 plan / apply 结果（每次重新调用 CLI 拿 fresh 数据，避免状态漂移）。
type MigrateHandler struct{}

func NewMigrateHandler() *MigrateHandler { return &MigrateHandler{} }

func (h *MigrateHandler) requireCLI(w http.ResponseWriter, r *http.Request) bool {
	if openclaw.IsOpenClawInstalled() {
		return true
	}
	web.Fail(w, r, "OPENCLAW_NOT_INSTALLED", "OpenClaw CLI 不可用，请先完成安装", http.StatusServiceUnavailable)
	return false
}

// GET /api/v1/migrate/list
func (h *MigrateHandler) List(w http.ResponseWriter, r *http.Request) {
	if !h.requireCLI(w, r) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	res, err := openclaw.MigrateList(ctx)
	if err != nil {
		web.Fail(w, r, "MIGRATE_LIST_FAILED", err.Error(), http.StatusBadGateway)
		return
	}
	web.OK(w, r, res)
}

// GET /api/v1/migrate/detect
// Returns each known provider's default source dir + whether it exists.
func (h *MigrateHandler) Detect(w http.ResponseWriter, r *http.Request) {
	web.OK(w, r, map[string]interface{}{
		"results": openclaw.DetectSources(),
	})
}

type planRequest struct {
	Provider       string `json:"provider"`
	From           string `json:"from,omitempty"`
	IncludeSecrets bool   `json:"includeSecrets"`
	Overwrite      bool   `json:"overwrite"`
}

// POST /api/v1/migrate/plan
func (h *MigrateHandler) Plan(w http.ResponseWriter, r *http.Request) {
	if !h.requireCLI(w, r) {
		return
	}
	var req planRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	if strings.TrimSpace(req.Provider) == "" {
		web.Fail(w, r, "INVALID_PROVIDER", "缺少 provider", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	plan, err := openclaw.MigratePlan(ctx, openclaw.MigrateOptions{
		Provider:       req.Provider,
		From:           strings.TrimSpace(req.From),
		IncludeSecrets: req.IncludeSecrets,
		Overwrite:      req.Overwrite,
	})
	if err != nil {
		web.Fail(w, r, "MIGRATE_PLAN_FAILED", err.Error(), http.StatusBadGateway)
		return
	}
	web.OK(w, r, plan)
}

type applyRequest struct {
	Provider       string `json:"provider"`
	From           string `json:"from,omitempty"`
	IncludeSecrets bool   `json:"includeSecrets"`
	Overwrite      bool   `json:"overwrite"`
	NoBackup       bool   `json:"noBackup"`
	Force          bool   `json:"force"`
	BackupOutput   string `json:"backupOutput,omitempty"`
}

// POST /api/v1/migrate/apply
// 危险操作 — 会修改 OpenClaw 状态。前端必须先调用 /plan 拿到预览并由用户确认。
// CLI 默认会先做 backup（除非传 noBackup+force）。timeout 取 4min（与 CLI 封装一致）。
func (h *MigrateHandler) Apply(w http.ResponseWriter, r *http.Request) {
	if !h.requireCLI(w, r) {
		return
	}
	var req applyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}
	if strings.TrimSpace(req.Provider) == "" {
		web.Fail(w, r, "INVALID_PROVIDER", "缺少 provider", http.StatusBadRequest)
		return
	}
	if req.NoBackup && !req.Force {
		web.Fail(w, r, "FORCE_REQUIRED", "跳过备份必须同时勾选 force", http.StatusBadRequest)
		return
	}
	result, err := openclaw.MigrateApply(openclaw.ApplyOptions{
		MigrateOptions: openclaw.MigrateOptions{
			Provider:       req.Provider,
			From:           strings.TrimSpace(req.From),
			IncludeSecrets: req.IncludeSecrets,
			Overwrite:      req.Overwrite,
		},
		NoBackup:     req.NoBackup,
		Force:        req.Force,
		BackupOutput: strings.TrimSpace(req.BackupOutput),
	})
	if err != nil {
		// apply 失败 - 仍把 partial result（如果有）发给前端用于展示。
		if result != nil {
			web.OK(w, r, map[string]interface{}{
				"ok":     false,
				"error":  err.Error(),
				"result": result,
			})
			return
		}
		web.Fail(w, r, "MIGRATE_APPLY_FAILED", err.Error(), http.StatusBadGateway)
		return
	}
	web.OK(w, r, map[string]interface{}{
		"ok":     true,
		"result": result,
	})
}
