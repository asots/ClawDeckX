package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"ClawDeckX/internal/database"
	"ClawDeckX/internal/logger"
	"ClawDeckX/internal/runtime"
	"ClawDeckX/internal/web"
	"ClawDeckX/internal/webconfig"
)

// BackupConfigHandler manages user-configurable backup storage directory.
type BackupConfigHandler struct {
	cfg       *webconfig.Config
	auditRepo *database.AuditLogRepo
}

func NewBackupConfigHandler(cfg *webconfig.Config) *BackupConfigHandler {
	return &BackupConfigHandler{
		cfg:       cfg,
		auditRepo: database.NewAuditLogRepo(),
	}
}

// Get returns the current backup directory configuration.
func (h *BackupConfigHandler) Get(w http.ResponseWriter, r *http.Request) {
	effective := strings.TrimSpace(h.cfg.Backup.Directory)
	defaultDir := webconfig.DefaultBackupDirectory()
	if effective == "" {
		effective = defaultDir
	}

	envLocked := strings.TrimSpace(os.Getenv("OCD_BACKUP_DIR")) != ""

	web.OK(w, r, map[string]any{
		"directory":         h.cfg.Backup.Directory,
		"effective":         effective,
		"default_directory": defaultDir,
		"is_docker":         runtime.IsDocker(),
		"env_locked":        envLocked,
	})
}

// Update persists a new backup directory. Empty string resets to default.
// Containerized runtime is read-only because the path is managed by the image.
func (h *BackupConfigHandler) Update(w http.ResponseWriter, r *http.Request) {
	if runtime.IsDocker() {
		web.FailErr(w, r, web.ErrInvalidParam, "backup directory is read-only inside container runtime")
		return
	}
	if strings.TrimSpace(os.Getenv("OCD_BACKUP_DIR")) != "" {
		web.FailErr(w, r, web.ErrInvalidParam, "backup directory is locked by OCD_BACKUP_DIR environment variable")
		return
	}

	var req struct {
		Directory string `json:"directory"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.FailErr(w, r, web.ErrInvalidBody)
		return
	}

	dir := strings.TrimSpace(req.Directory)
	if dir != "" {
		if err := validateBackupDirectory(dir); err != nil {
			web.FailErr(w, r, web.ErrInvalidParam, err.Error())
			return
		}
		abs, err := filepath.Abs(dir)
		if err == nil {
			dir = abs
		}
		if err := os.MkdirAll(dir, 0o700); err != nil {
			web.FailErr(w, r, web.ErrInvalidParam, fmt.Sprintf("cannot create directory: %v", err))
			return
		}
	}

	h.cfg.Backup.Directory = dir
	if err := webconfig.Save(*h.cfg); err != nil {
		logger.Log.Error().Err(err).Msg("failed to save backup config")
		web.FailErr(w, r, web.ErrConfigWriteFailed, err.Error())
		return
	}

	h.auditRepo.Create(&database.AuditLog{
		UserID:   web.GetUserID(r),
		Username: web.GetUsername(r),
		Action:   "backup.config.update",
		Detail:   "directory=" + dir,
		Result:   "success",
		IP:       r.RemoteAddr,
	})

	logger.Log.Info().
		Str("user", web.GetUsername(r)).
		Str("directory", dir).
		Msg("backup directory updated")

	effective := dir
	if effective == "" {
		effective = webconfig.DefaultBackupDirectory()
	}
	web.OK(w, r, map[string]any{
		"directory": h.cfg.Backup.Directory,
		"effective": effective,
	})
}

// validateBackupDirectory enforces basic safety checks on user-supplied paths.
func validateBackupDirectory(dir string) error {
	if dir == "" {
		return errors.New("directory cannot be empty")
	}
	// Disallow obvious shell metacharacters that would never appear in a real path.
	for _, ch := range []string{"\x00", "\n", "\r"} {
		if strings.Contains(dir, ch) {
			return errors.New("directory contains invalid characters")
		}
	}
	// Must be absolute once resolved, to avoid surprises relative to the daemon CWD.
	if !filepath.IsAbs(dir) {
		abs, err := filepath.Abs(dir)
		if err != nil {
			return fmt.Errorf("cannot resolve path: %w", err)
		}
		dir = abs
	}
	// Refuse to write backups directly into the OpenClaw state dir, because the
	// OpenClaw CLI rejects archives that live inside a source path.
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		ocState := filepath.Join(home, ".openclaw")
		if isWithin(dir, ocState) {
			return errors.New("backup directory cannot be inside the OpenClaw state directory (~/.openclaw)")
		}
	}
	// If the path exists, it must be a directory.
	if info, err := os.Stat(dir); err == nil && !info.IsDir() {
		return errors.New("path exists and is not a directory")
	}
	return nil
}

// isWithin reports whether target is equal to or a subdirectory of base.
func isWithin(target, base string) bool {
	rel, err := filepath.Rel(base, target)
	if err != nil {
		return false
	}
	if rel == "." {
		return true
	}
	if strings.HasPrefix(rel, "..") {
		return false
	}
	return !strings.Contains(rel, "..")
}
