package updatecheck

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"ClawDeckX/internal/database"
	"ClawDeckX/internal/openclaw"
	"ClawDeckX/internal/updater"
	"ClawDeckX/internal/version"
)

const (
	OverviewCacheKey = "update_overview_cache"
	OverviewCacheTTL = 12 * time.Hour
)

type ProductStatus struct {
	CurrentVersion string `json:"currentVersion,omitempty"`
	LatestVersion  string `json:"latestVersion,omitempty"`
	UpdateAvailable bool  `json:"updateAvailable"`
	Error          string `json:"error,omitempty"`
}

type CompatibilityStatus struct {
	CurrentVersion string `json:"currentVersion,omitempty"`
	Required       string `json:"required,omitempty"`
	Compatible     bool   `json:"compatible"`
}

type Overview struct {
	CheckedAt     string              `json:"checkedAt,omitempty"`
	NextCheckAt   string              `json:"nextCheckAt,omitempty"`
	ClawDeckX     ProductStatus       `json:"clawdeckx"`
	OpenClaw      ProductStatus       `json:"openclaw"`
	Compatibility CompatibilityStatus `json:"compatibility"`
}

func GetOverview(ctx context.Context, force bool) (*Overview, error) {
	settingRepo := database.NewSettingRepo()
	if !force {
		if cached, ok := loadCachedOverview(settingRepo); ok {
			return cached, nil
		}
	}

	overview := buildOverview(ctx)
	_ = saveCachedOverview(settingRepo, overview)
	return overview, nil
}

func loadCachedOverview(settingRepo *database.SettingRepo) (*Overview, bool) {
	raw, err := settingRepo.Get(OverviewCacheKey)
	if err != nil || strings.TrimSpace(raw) == "" {
		return nil, false
	}
	var overview Overview
	if err := json.Unmarshal([]byte(raw), &overview); err != nil {
		return nil, false
	}
	if overview.CheckedAt == "" {
		return nil, false
	}
	checkedAt, err := time.Parse(time.RFC3339, overview.CheckedAt)
	if err != nil {
		return nil, false
	}
	if time.Since(checkedAt) > OverviewCacheTTL {
		return nil, false
	}
	return &overview, true
}

func saveCachedOverview(settingRepo *database.SettingRepo, overview *Overview) error {
	b, err := json.Marshal(overview)
	if err != nil {
		return err
	}
	return settingRepo.Set(OverviewCacheKey, string(b))
}

func buildOverview(ctx context.Context) *Overview {
	now := time.Now().UTC()
	overview := &Overview{
		CheckedAt:   now.Format(time.RFC3339),
		NextCheckAt: now.Add(OverviewCacheTTL).Format(time.RFC3339),
		Compatibility: CompatibilityStatus{Compatible: true, Required: version.OpenClawCompat},
	}

	clawCtx, clawCancel := context.WithTimeout(ctx, 15*time.Second)
	defer clawCancel()
	if res, err := updater.CheckForUpdate(clawCtx); err == nil && res != nil {
		overview.ClawDeckX = ProductStatus{
			CurrentVersion:  res.CurrentVersion,
			LatestVersion:   res.LatestVersion,
			UpdateAvailable: res.Available,
			Error:           res.Error,
		}
	} else if err != nil {
		overview.ClawDeckX.Error = err.Error()
		overview.ClawDeckX.CurrentVersion = version.Version
	}

	currentOpenClaw := ""
	if _, ver, ok := openclaw.DetectOpenClawBinary(); ok {
		currentOpenClaw = extractSemver(ver)
	}
	overview.OpenClaw.CurrentVersion = currentOpenClaw
	overview.Compatibility.CurrentVersion = currentOpenClaw
	if ok, required := version.CheckOpenClawCompat(currentOpenClaw); required != "" {
		overview.Compatibility.Required = required
		overview.Compatibility.Compatible = ok
	}

	openCtx, openCancel := context.WithTimeout(ctx, 8*time.Second)
	defer openCancel()
	req, err := http.NewRequestWithContext(openCtx, http.MethodGet, "https://registry.npmjs.org/openclaw/latest", nil)
	if err != nil {
		overview.OpenClaw.Error = err.Error()
		return overview
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		overview.OpenClaw.Error = err.Error()
		return overview
	}
	defer resp.Body.Close()
	var npmResp struct {
		Version string `json:"version"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&npmResp); err != nil {
		overview.OpenClaw.Error = err.Error()
		return overview
	}
	latest := strings.TrimPrefix(npmResp.Version, "v")
	overview.OpenClaw.LatestVersion = latest
	if currentOpenClaw != "" && latest != "" && currentOpenClaw != latest {
		overview.OpenClaw.UpdateAvailable = compareSemver(latest, currentOpenClaw) > 0
	}
	return overview
}

func compareSemver(a, b string) int {
	pa, preA := parseSemverParts(a)
	pb, preB := parseSemverParts(b)
	for i := 0; i < 3; i++ {
		if pa[i] != pb[i] {
			return pa[i] - pb[i]
		}
	}
	if preA && !preB {
		return -1
	}
	if !preA && preB {
		return 1
	}
	return 0
}

func parseSemverParts(v string) ([3]int, bool) {
	v = strings.TrimPrefix(v, "v")
	for len(v) > 0 && (v[0] < '0' || v[0] > '9') {
		v = v[1:]
	}
	hasPrerelease := false
	if idx := strings.IndexByte(v, '-'); idx >= 0 {
		hasPrerelease = true
		v = v[:idx]
	}
	if idx := strings.IndexByte(v, '+'); idx >= 0 {
		v = v[:idx]
	}
	if idx := strings.IndexByte(v, ' '); idx >= 0 {
		v = v[:idx]
	}
	parts := strings.SplitN(v, ".", 3)
	var result [3]int
	for i := 0; i < 3 && i < len(parts); i++ {
		result[i], _ = strconv.Atoi(parts[i])
	}
	return result, hasPrerelease
}

func extractSemver(raw string) string {
	raw = strings.TrimSpace(raw)
	raw = strings.TrimPrefix(raw, "v")
	for len(raw) > 0 && (raw[0] < '0' || raw[0] > '9') {
		raw = raw[1:]
	}
	end := len(raw)
	for i, c := range raw {
		if c == ' ' || c == '(' {
			end = i
			break
		}
	}
	return strings.TrimSpace(raw[:end])
}
