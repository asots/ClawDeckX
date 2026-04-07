package snapshots

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"ClawDeckX/internal/constants"
	"ClawDeckX/internal/database"
)

const (
	settingScheduleEnabled       = "snapshot_schedule_enabled"
	settingScheduleTime          = "snapshot_schedule_time"
	settingScheduleRetention     = "snapshot_schedule_retention_count"
	settingScheduleTimezone      = "snapshot_schedule_timezone"
	settingSchedulePassword      = "snapshot_schedule_password"
	settingScheduleLastRunAt     = "snapshot_schedule_last_run_at"
	settingScheduleLastSuccessAt = "snapshot_schedule_last_success_at"
	settingScheduleLastStatus    = "snapshot_schedule_last_status"
	settingScheduleLastError     = "snapshot_schedule_last_error"
	settingScheduleLastSnapshot  = "snapshot_schedule_last_snapshot_id"
	settingScheduleLastRunDate   = "snapshot_schedule_last_run_date"
)

type ScheduleConfig struct {
	Enabled        bool   `json:"enabled"`
	Time           string `json:"time"`
	RetentionCount int    `json:"retentionCount"`
	Timezone       string `json:"timezone"`
	PasswordSet    bool   `json:"passwordSet"`
}

type ScheduleUpdateRequest struct {
	Enabled        bool   `json:"enabled"`
	Time           string `json:"time"`
	RetentionCount int    `json:"retentionCount"`
	Timezone       string `json:"timezone"`
	Password       string `json:"password"`
}

type ScheduleStatus struct {
	LastRunAt      string `json:"lastRunAt,omitempty"`
	LastSuccessAt  string `json:"lastSuccessAt,omitempty"`
	LastStatus     string `json:"lastStatus"`
	LastError      string `json:"lastError,omitempty"`
	LastSnapshotID string `json:"lastSnapshotId,omitempty"`
	Running        bool   `json:"running"`
}

type Scheduler struct {
	svc       *Service
	setting   *database.SettingRepo
	auditRepo *database.AuditLogRepo
	deviceID  string

	mu      sync.Mutex
	running bool
}

func NewScheduler(svc *Service) *Scheduler {
	return &Scheduler{
		svc:       svc,
		setting:   database.NewSettingRepo(),
		auditRepo: database.NewAuditLogRepo(),
	}
}

func (s *Scheduler) SetDeviceID(id string) {
	s.deviceID = id
}

func (s *Scheduler) Start(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	s.runIfNeeded()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.runIfNeeded()
		}
	}
}

func (s *Scheduler) GetConfig() (*ScheduleConfig, error) {
	enabled := s.getBool(settingScheduleEnabled, false)
	timeStr := s.getString(settingScheduleTime, "03:00")
	retention := s.getInt(settingScheduleRetention, 7)
	tz := s.getString(settingScheduleTimezone, DefaultScheduleTimezone)
	storedPwd, err := s.setting.Get(settingSchedulePassword)
	passwordSet := err == nil && storedPwd != ""
	if retention < 1 {
		retention = 1
	}
	return &ScheduleConfig{
		Enabled:        enabled,
		Time:           timeStr,
		RetentionCount: retention,
		Timezone:       tz,
		PasswordSet:    passwordSet,
	}, nil
}

func (s *Scheduler) UpdateConfig(req ScheduleUpdateRequest, userID uint, username, ip string) error {
	timeStr := strings.TrimSpace(req.Time)
	if !isValidScheduleTime(timeStr) {
		return fmt.Errorf("invalid schedule time")
	}
	if req.RetentionCount < 1 || req.RetentionCount > 365 {
		return fmt.Errorf("invalid retention count")
	}
	tz := strings.TrimSpace(req.Timezone)
	if tz == "" {
		tz = DefaultScheduleTimezone
	}
	if tz != DefaultScheduleTimezone && tz != "UTC" {
		if _, loadErr := time.LoadLocation(tz); loadErr != nil {
			return fmt.Errorf("unsupported timezone: %s", tz)
		}
	}
	if req.Password != "" && len(req.Password) < 6 {
		return fmt.Errorf("password too short")
	}
	if req.Enabled {
		hasPassword := req.Password != ""
		if !hasPassword {
			if p, err := s.setting.Get(settingSchedulePassword); err == nil && p != "" {
				hasPassword = true
			}
		}
		if !hasPassword {
			return fmt.Errorf("schedule password required")
		}
	}
	items := map[string]string{
		settingScheduleEnabled:   strconv.FormatBool(req.Enabled),
		settingScheduleTime:      timeStr,
		settingScheduleRetention: strconv.Itoa(req.RetentionCount),
		settingScheduleTimezone:  tz,
	}
	if req.Password != "" {
		if s.deviceID != "" {
			enc, err := EncryptSchedulePassword(req.Password, s.deviceID)
			if err != nil {
				return fmt.Errorf("encrypt password: %w", err)
			}
			items[settingSchedulePassword] = enc
		} else {
			items[settingSchedulePassword] = req.Password
		}
	}
	if err := s.setting.SetBatch(items); err != nil {
		return err
	}
	_ = s.auditRepo.Create(&database.AuditLog{
		UserID:   userID,
		Username: username,
		Action:   constants.ActionSnapshotScheduleUpdate,
		Result:   "success",
		Detail:   fmt.Sprintf("enabled=%t,time=%s,retention=%d", req.Enabled, timeStr, req.RetentionCount),
		IP:       ip,
	})
	return nil
}

func (s *Scheduler) GetStatus() (*ScheduleStatus, error) {
	status := &ScheduleStatus{
		LastRunAt:      s.getString(settingScheduleLastRunAt, ""),
		LastSuccessAt:  s.getString(settingScheduleLastSuccessAt, ""),
		LastStatus:     s.getString(settingScheduleLastStatus, ScheduleStatusNever),
		LastError:      s.getString(settingScheduleLastError, ""),
		LastSnapshotID: s.getString(settingScheduleLastSnapshot, ""),
		Running:        s.isRunning(),
	}
	if status.LastStatus == "" {
		status.LastStatus = ScheduleStatusNever
	}
	return status, nil
}

func (s *Scheduler) runIfNeeded() {
	if !s.getBool(settingScheduleEnabled, false) {
		return
	}
	cfg, err := s.GetConfig()
	if err != nil {
		return
	}
	now := time.Now()
	if cfg.Timezone == "UTC" {
		now = now.UTC()
	} else if cfg.Timezone != "" && cfg.Timezone != DefaultScheduleTimezone {
		if loc, err := time.LoadLocation(cfg.Timezone); err == nil {
			now = now.In(loc)
		}
	}
	nowHM := now.Format("15:04")
	schH, schM := parseHM(cfg.Time)
	nowH, nowM := parseHM(nowHM)
	if nowH != schH || nowM < schM || nowM > schM+1 {
		return
	}
	today := now.Format("2006-01-02")
	if s.getString(settingScheduleLastRunDate, "") == today {
		return
	}

	s.mu.Lock()
	if s.running {
		s.mu.Unlock()
		return
	}
	s.running = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.running = false
		s.mu.Unlock()
	}()

	nowRFC3339 := now.UTC().Format(time.RFC3339)
	_ = s.setting.SetBatch(map[string]string{
		settingScheduleLastRunAt:   nowRFC3339,
		settingScheduleLastRunDate: today,
	})

	rawPassword, err := s.setting.Get(settingSchedulePassword)
	if err != nil || rawPassword == "" {
		s.markFailed(nowRFC3339, "schedule password not configured")
		return
	}
	password := rawPassword
	if s.deviceID != "" {
		if dec, decErr := DecryptSchedulePassword(rawPassword, s.deviceID); decErr == nil {
			password = dec
		}
	}

	rec, err := s.svc.Create("auto scheduled backup", ScheduledSnapshotTag, password, nil)
	if err != nil {
		s.markFailed(nowRFC3339, err.Error())
		return
	}

	_ = s.auditRepo.Create(&database.AuditLog{
		Action: constants.ActionSnapshotScheduleRun,
		Result: "success",
		Detail: rec.SnapshotID,
		IP:     "system",
	})

	prunedIDs, pruneErr := s.svc.PruneScheduledBackups(cfg.RetentionCount)
	if pruneErr == nil {
		_ = s.auditRepo.Create(&database.AuditLog{
			Action: constants.ActionSnapshotSchedulePrune,
			Result: "success",
			Detail: fmt.Sprintf("retention=%d,pruned=%d", cfg.RetentionCount, len(prunedIDs)),
			IP:     "system",
		})
	}

	lastError := ""
	if pruneErr != nil {
		lastError = pruneErr.Error()
		_ = s.auditRepo.Create(&database.AuditLog{
			Action: constants.ActionSnapshotSchedulePrune,
			Result: "failed",
			Detail: pruneErr.Error(),
			IP:     "system",
		})
	}
	_ = s.setting.SetBatch(map[string]string{
		settingScheduleLastSuccessAt: nowRFC3339,
		settingScheduleLastStatus:    ScheduleStatusSuccess,
		settingScheduleLastError:     lastError,
		settingScheduleLastSnapshot:  rec.SnapshotID,
	})
}

func (s *Scheduler) markFailed(lastRunAt, detail string) {
	_ = s.setting.SetBatch(map[string]string{
		settingScheduleLastRunAt:  lastRunAt,
		settingScheduleLastStatus: ScheduleStatusFailed,
		settingScheduleLastError:  detail,
	})
	_ = s.auditRepo.Create(&database.AuditLog{
		Action: constants.ActionSnapshotScheduleRun,
		Result: "failed",
		Detail: detail,
		IP:     "system",
	})
}

func (s *Scheduler) isRunning() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.running
}

func (s *Scheduler) getString(key, fallback string) string {
	v, err := s.setting.Get(key)
	if err != nil || v == "" {
		return fallback
	}
	return v
}

func (s *Scheduler) getInt(key string, fallback int) int {
	v, err := s.setting.Get(key)
	if err != nil || v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return fallback
	}
	return n
}

func (s *Scheduler) getBool(key string, fallback bool) bool {
	v, err := s.setting.Get(key)
	if err != nil || v == "" {
		return fallback
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return fallback
	}
	return b
}

func isValidScheduleTime(v string) bool {
	if len(v) != 5 {
		return false
	}
	_, err := time.Parse("15:04", v)
	return err == nil
}

func parseHM(hm string) (int, int) {
	parts := strings.SplitN(hm, ":", 2)
	if len(parts) != 2 {
		return -1, -1
	}
	h, err1 := strconv.Atoi(parts[0])
	m, err2 := strconv.Atoi(parts[1])
	if err1 != nil || err2 != nil {
		return -1, -1
	}
	return h, m
}

// RunNow triggers an immediate scheduled backup regardless of the configured time.
func (s *Scheduler) RunNow(userID uint, username, ip string) (*ScheduleRunNowResponse, error) {
	s.mu.Lock()
	if s.running {
		s.mu.Unlock()
		return nil, fmt.Errorf("a scheduled backup is already running")
	}
	s.running = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.running = false
		s.mu.Unlock()
	}()

	cfg, err := s.GetConfig()
	if err != nil {
		return nil, err
	}

	rawPassword, err := s.setting.Get(settingSchedulePassword)
	if err != nil || rawPassword == "" {
		return nil, fmt.Errorf("schedule password not configured")
	}
	password := rawPassword
	if s.deviceID != "" {
		if dec, decErr := DecryptSchedulePassword(rawPassword, s.deviceID); decErr == nil {
			password = dec
		}
	}

	nowRFC3339 := time.Now().UTC().Format(time.RFC3339)
	_ = s.setting.SetBatch(map[string]string{
		settingScheduleLastRunAt: nowRFC3339,
	})

	rec, createErr := s.svc.Create("manual trigger of scheduled backup", ScheduledSnapshotTag, password, nil)
	if createErr != nil {
		s.markFailed(nowRFC3339, createErr.Error())
		return nil, createErr
	}

	_ = s.auditRepo.Create(&database.AuditLog{
		UserID:   userID,
		Username: username,
		Action:   constants.ActionSnapshotScheduleRun,
		Result:   "success",
		Detail:   rec.SnapshotID + " (manual trigger)",
		IP:       ip,
	})

	if cfg.RetentionCount > 0 {
		_, _ = s.svc.PruneScheduledBackups(cfg.RetentionCount)
	}

	_ = s.setting.SetBatch(map[string]string{
		settingScheduleLastSuccessAt: nowRFC3339,
		settingScheduleLastStatus:    ScheduleStatusSuccess,
		settingScheduleLastError:     "",
		settingScheduleLastSnapshot:  rec.SnapshotID,
	})

	return &ScheduleRunNowResponse{SnapshotID: rec.SnapshotID}, nil
}
