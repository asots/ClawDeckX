package updater

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"ClawDeckX/internal/logger"
	"ClawDeckX/internal/netutil"
	"ClawDeckX/internal/version"
)

const (
	GitHubOwner = "ClawDeckX"
	GitHubRepo  = "ClawDeckX"
)

// ReleaseInfo holds GitHub release metadata.
type ReleaseInfo struct {
	TagName     string    `json:"tag_name"`
	Name        string    `json:"name"`
	Body        string    `json:"body"`
	Prerelease  bool      `json:"prerelease"`
	PublishedAt time.Time `json:"published_at"`
	Assets      []Asset   `json:"assets"`
}

// Asset is a single release asset.
type Asset struct {
	Name               string `json:"name"`
	Size               int64  `json:"size"`
	BrowserDownloadURL string `json:"browser_download_url"`
}

// CheckResult is returned by CheckForUpdate.
type CheckResult struct {
	Available      bool   `json:"available"`
	CurrentVersion string `json:"currentVersion"`
	LatestVersion  string `json:"latestVersion"`
	ReleaseNotes   string `json:"releaseNotes,omitempty"`
	PublishedAt    string `json:"publishedAt,omitempty"`
	AssetName      string `json:"assetName,omitempty"`
	AssetSize      int64  `json:"assetSize,omitempty"`
	DownloadURL    string `json:"downloadUrl,omitempty"`
	Error          string `json:"error,omitempty"`
	Channel        string `json:"channel,omitempty"`
}

// ApplyProgress reports download/apply progress.
type ApplyProgress struct {
	Stage      string  `json:"stage"`
	Percent    float64 `json:"percent"`
	Downloaded int64   `json:"downloaded,omitempty"`
	Total      int64   `json:"total,omitempty"`
	Error      string  `json:"error,omitempty"`
	Done       bool    `json:"done"`
}

// CheckForUpdate queries GitHub Releases for a newer version.
// Uses intelligent mirror selection for better accessibility in China.
func CheckForUpdate(ctx context.Context) (*CheckResult, error) {
	currentVersion := version.Version

	// Use smart mirror selection for GitHub API
	apiBase := netutil.GetGitHubAPIURL(ctx)
	url := fmt.Sprintf("%s/repos/%s/%s/releases/latest", apiBase, GitHubOwner, GitHubRepo)
	logger.Config.Debug().Str("api_url", url).Msg("[Updater] Checking for updates")

	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return &CheckResult{Available: false, CurrentVersion: currentVersion, Error: err.Error()}, nil
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "ClawDeckX/"+currentVersion)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		// Network error - likely blocked or timeout
		errMsg := err.Error()
		if strings.Contains(errMsg, "timeout") || strings.Contains(errMsg, "connection refused") || strings.Contains(errMsg, "no route to host") {
			return &CheckResult{Available: false, CurrentVersion: currentVersion, Error: "Cannot connect to GitHub. Please check your network or download manually from https://github.com/ClawDeckX/ClawDeckX/releases"}, nil
		}
		return &CheckResult{Available: false, CurrentVersion: currentVersion, Error: errMsg}, nil
	}
	defer resp.Body.Close()

	if resp.StatusCode == 404 {
		return &CheckResult{Available: false, CurrentVersion: currentVersion, Error: "no releases found"}, nil
	}
	if resp.StatusCode >= 500 {
		return &CheckResult{Available: false, CurrentVersion: currentVersion, Error: fmt.Sprintf("GITHUB_SERVER_ERROR:%d", resp.StatusCode)}, nil
	}
	if resp.StatusCode == 403 || resp.StatusCode == 429 {
		return &CheckResult{Available: false, CurrentVersion: currentVersion, Error: "GITHUB_RATE_LIMITED"}, nil
	}
	if resp.StatusCode != 200 {
		return &CheckResult{Available: false, CurrentVersion: currentVersion, Error: fmt.Sprintf("GITHUB_API_ERROR:%d", resp.StatusCode)}, nil
	}

	// Check Content-Type to ensure we got JSON, not HTML error page
	contentType := resp.Header.Get("Content-Type")
	if !strings.Contains(contentType, "application/json") {
		return &CheckResult{Available: false, CurrentVersion: currentVersion, Error: fmt.Sprintf("invalid response type: %s (mirror may be broken)", contentType)}, nil
	}

	var release ReleaseInfo
	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
		return &CheckResult{Available: false, CurrentVersion: currentVersion, Error: err.Error()}, nil
	}

	latestVersion := strings.TrimPrefix(release.TagName, "v")
	available := compareSemver(latestVersion, currentVersion) > 0

	result := &CheckResult{
		Available:      available,
		CurrentVersion: currentVersion,
		LatestVersion:  latestVersion,
		ReleaseNotes:   release.Body,
		PublishedAt:    release.PublishedAt.Format(time.RFC3339),
	}

	// Find matching asset for current platform
	assetName := expectedAssetName()
	for _, a := range release.Assets {
		if strings.EqualFold(a.Name, assetName) {
			result.AssetName = a.Name
			result.AssetSize = a.Size
			// Use smart mirror selection for download URL
			result.DownloadURL = netutil.GetGitHubReleaseURL(ctx, a.BrowserDownloadURL)
			logger.Config.Debug().Str("download_url", result.DownloadURL).Msg("[Updater] Selected download mirror")
			break
		}
	}

	if available && result.DownloadURL == "" {
		result.Error = fmt.Sprintf("no asset found for %s/%s (expected %s)", runtime.GOOS, runtime.GOARCH, assetName)
	}

	return result, nil
}

// ReleaseSummary is a condensed release listing entry for the version picker UI.
// 用于 UpdateTab 的"指定版本升级"下拉，只保留 UI 需要的字段。
type ReleaseSummary struct {
	TagName     string `json:"tagName"`
	Name        string `json:"name"`
	Prerelease  bool   `json:"prerelease"`
	PublishedAt string `json:"publishedAt"`
	HasAsset    bool   `json:"hasAsset"`            // 当前平台是否有匹配资产；没有则不可升级。
	IsCurrent   bool   `json:"isCurrent,omitempty"` // 与当前运行版本一致（语义比较）。
	IsOlder     bool   `json:"isOlder,omitempty"`   // 比当前版本旧（= 降级）。
}

// ListReleases fetches the most recent GitHub releases, including prereleases, for the version picker.
// limit 被 clamp 到 [1, 30]；不标记降级/当前的场景下 IsCurrent/IsOlder 会留空。
func ListReleases(ctx context.Context, limit int) ([]ReleaseSummary, error) {
	if limit <= 0 {
		limit = 20
	}
	if limit > 30 {
		limit = 30
	}

	apiBase := netutil.GetGitHubAPIURL(ctx)
	url := fmt.Sprintf("%s/repos/%s/%s/releases?per_page=%d", apiBase, GitHubOwner, GitHubRepo, limit)

	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "ClawDeckX/"+version.Version)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("GITHUB_API_ERROR:%d", resp.StatusCode)
	}
	if !strings.Contains(resp.Header.Get("Content-Type"), "application/json") {
		return nil, fmt.Errorf("invalid response type from GitHub")
	}

	var releases []ReleaseInfo
	if err := json.NewDecoder(resp.Body).Decode(&releases); err != nil {
		return nil, err
	}

	assetName := expectedAssetName()
	currentVersion := version.Version
	out := make([]ReleaseSummary, 0, len(releases))
	for _, rel := range releases {
		hasAsset := false
		for _, a := range rel.Assets {
			if strings.EqualFold(a.Name, assetName) {
				hasAsset = true
				break
			}
		}
		ver := strings.TrimPrefix(rel.TagName, "v")
		cmp := compareSemver(ver, currentVersion)
		out = append(out, ReleaseSummary{
			TagName:     rel.TagName,
			Name:        rel.Name,
			Prerelease:  rel.Prerelease,
			PublishedAt: rel.PublishedAt.Format(time.RFC3339),
			HasAsset:    hasAsset,
			IsCurrent:   cmp == 0,
			IsOlder:     cmp < 0,
		})
	}
	return out, nil
}

// CheckTag fetches a specific release by tag name and builds a CheckResult
// suitable for the existing Apply flow. "available" here is informational only —
// the apply endpoint does not gate on it, so downgrades are supported with confirmation.
func CheckTag(ctx context.Context, tag string) (*CheckResult, error) {
	currentVersion := version.Version
	if tag == "" {
		return &CheckResult{Available: false, CurrentVersion: currentVersion, Error: "tag required"}, nil
	}

	apiBase := netutil.GetGitHubAPIURL(ctx)
	// GitHub accepts tag as-is (e.g. "v2026.3.2"); user may pass with or without leading "v".
	tagParam := tag
	url := fmt.Sprintf("%s/repos/%s/%s/releases/tags/%s", apiBase, GitHubOwner, GitHubRepo, tagParam)

	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return &CheckResult{Available: false, CurrentVersion: currentVersion, Error: err.Error()}, nil
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "ClawDeckX/"+currentVersion)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return &CheckResult{Available: false, CurrentVersion: currentVersion, Error: err.Error()}, nil
	}
	defer resp.Body.Close()

	if resp.StatusCode == 404 {
		// Try the "v" prefix variant once if the user-provided tag didn't include it.
		if !strings.HasPrefix(tagParam, "v") {
			retryURL := fmt.Sprintf("%s/repos/%s/%s/releases/tags/v%s", apiBase, GitHubOwner, GitHubRepo, tagParam)
			req2, _ := http.NewRequestWithContext(ctx, "GET", retryURL, nil)
			req2.Header.Set("Accept", "application/vnd.github+json")
			req2.Header.Set("User-Agent", "ClawDeckX/"+currentVersion)
			resp2, err2 := http.DefaultClient.Do(req2)
			if err2 == nil {
				defer resp2.Body.Close()
				if resp2.StatusCode == 200 {
					resp = resp2
				}
			}
		}
	}
	if resp.StatusCode != 200 {
		return &CheckResult{Available: false, CurrentVersion: currentVersion, Error: fmt.Sprintf("GITHUB_API_ERROR:%d", resp.StatusCode)}, nil
	}
	if !strings.Contains(resp.Header.Get("Content-Type"), "application/json") {
		return &CheckResult{Available: false, CurrentVersion: currentVersion, Error: "invalid response type from GitHub"}, nil
	}

	var release ReleaseInfo
	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
		return &CheckResult{Available: false, CurrentVersion: currentVersion, Error: err.Error()}, nil
	}

	latestVersion := strings.TrimPrefix(release.TagName, "v")
	result := &CheckResult{
		Available:      compareSemver(latestVersion, currentVersion) != 0, // 任何差异都允许操作（升/降）。
		CurrentVersion: currentVersion,
		LatestVersion:  latestVersion,
		ReleaseNotes:   release.Body,
		PublishedAt:    release.PublishedAt.Format(time.RFC3339),
	}

	assetName := expectedAssetName()
	for _, a := range release.Assets {
		if strings.EqualFold(a.Name, assetName) {
			result.AssetName = a.Name
			result.AssetSize = a.Size
			result.DownloadURL = netutil.GetGitHubReleaseURL(ctx, a.BrowserDownloadURL)
			break
		}
	}
	if result.DownloadURL == "" {
		result.Error = fmt.Sprintf("no asset found for %s/%s (expected %s)", runtime.GOOS, runtime.GOARCH, assetName)
	}
	return result, nil
}

// CheckForPreRelease queries GitHub Releases for the latest pre-release (beta channel).
func CheckForPreRelease(ctx context.Context) (*CheckResult, error) {
	currentVersion := version.Version
	apiBase := netutil.GetGitHubAPIURL(ctx)
	url := fmt.Sprintf("%s/repos/%s/%s/releases", apiBase, GitHubOwner, GitHubRepo)

	req, err := http.NewRequestWithContext(ctx, "GET", url+"?per_page=20", nil)
	if err != nil {
		return &CheckResult{Available: false, CurrentVersion: currentVersion, Error: err.Error()}, nil
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "ClawDeckX/"+currentVersion)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		// Network error - likely blocked or timeout
		errMsg := err.Error()
		if strings.Contains(errMsg, "timeout") || strings.Contains(errMsg, "connection refused") || strings.Contains(errMsg, "no route to host") {
			return &CheckResult{Available: false, CurrentVersion: currentVersion, Error: "Cannot connect to GitHub. Please check your network or download manually from https://github.com/ClawDeckX/ClawDeckX/releases"}, nil
		}
		return &CheckResult{Available: false, CurrentVersion: currentVersion, Error: errMsg}, nil
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 500 {
		return &CheckResult{Available: false, CurrentVersion: currentVersion, Error: fmt.Sprintf("GITHUB_SERVER_ERROR:%d", resp.StatusCode)}, nil
	}
	if resp.StatusCode == 403 || resp.StatusCode == 429 {
		return &CheckResult{Available: false, CurrentVersion: currentVersion, Error: "GITHUB_RATE_LIMITED"}, nil
	}
	if resp.StatusCode != 200 {
		return &CheckResult{Available: false, CurrentVersion: currentVersion, Error: fmt.Sprintf("GITHUB_API_ERROR:%d", resp.StatusCode)}, nil
	}

	// Check Content-Type to ensure we got JSON, not HTML error page
	contentType := resp.Header.Get("Content-Type")
	if !strings.Contains(contentType, "application/json") {
		return &CheckResult{Available: false, CurrentVersion: currentVersion, Error: fmt.Sprintf("invalid response type: %s (mirror may be broken)", contentType)}, nil
	}

	var releases []ReleaseInfo
	if err := json.NewDecoder(resp.Body).Decode(&releases); err != nil {
		return &CheckResult{Available: false, CurrentVersion: currentVersion, Error: err.Error()}, nil
	}

	// Find the first pre-release that is newer than current
	for _, release := range releases {
		if !release.Prerelease {
			continue
		}
		latestVersion := strings.TrimPrefix(release.TagName, "v")
		if compareSemver(latestVersion, currentVersion) <= 0 {
			continue
		}
		result := &CheckResult{
			Available:      true,
			CurrentVersion: currentVersion,
			LatestVersion:  latestVersion,
			ReleaseNotes:   release.Body,
			PublishedAt:    release.PublishedAt.Format(time.RFC3339),
		}
		assetName := expectedAssetName()
		for _, a := range release.Assets {
			if strings.EqualFold(a.Name, assetName) {
				result.AssetName = a.Name
				result.AssetSize = a.Size
				result.DownloadURL = netutil.GetGitHubReleaseURL(ctx, a.BrowserDownloadURL)
				break
			}
		}
		if result.DownloadURL == "" {
			result.Error = fmt.Sprintf("no asset found for %s/%s (expected %s)", runtime.GOOS, runtime.GOARCH, assetName)
		}
		return result, nil
	}

	return &CheckResult{Available: false, CurrentVersion: currentVersion}, nil
}

// ApplyUpdate downloads the new binary and replaces the current one.
// progressFn is called with progress updates (can be nil).
func ApplyUpdate(ctx context.Context, downloadURL string, progressFn func(ApplyProgress)) error {
	if progressFn == nil {
		progressFn = func(ApplyProgress) {}
	}

	// 1. Download to temp file
	progressFn(ApplyProgress{Stage: "downloading", Percent: 0})

	req, err := http.NewRequestWithContext(ctx, "GET", downloadURL, nil)
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("User-Agent", "ClawDeckX/"+version.Version)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("download: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return fmt.Errorf("download returned HTTP %d", resp.StatusCode)
	}

	// Reject HTML responses — mirrors may return error pages with HTTP 200
	ct := resp.Header.Get("Content-Type")
	if strings.Contains(ct, "text/html") {
		return fmt.Errorf("download returned HTML instead of binary (Content-Type: %s), mirror may be broken", ct)
	}

	totalSize := resp.ContentLength

	// Create temp file in same directory as current executable
	currentExe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("get executable path: %w", err)
	}
	currentExe, err = filepath.EvalSymlinks(currentExe)
	if err != nil {
		return fmt.Errorf("resolve symlinks: %w", err)
	}

	dir := filepath.Dir(currentExe)
	tmpFile, err := os.CreateTemp(dir, "ClawDeckX-update-*.tmp")
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}
	tmpPath := tmpFile.Name()
	defer func() {
		tmpFile.Close()
		os.Remove(tmpPath) // clean up on error
	}()

	// Download with progress tracking
	hasher := sha256.New()
	writer := io.MultiWriter(tmpFile, hasher)
	var downloaded int64

	buf := make([]byte, 64*1024) // 64KB buffer
	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if _, writeErr := writer.Write(buf[:n]); writeErr != nil {
				return fmt.Errorf("write: %w", writeErr)
			}
			downloaded += int64(n)
			pct := float64(0)
			if totalSize > 0 {
				pct = float64(downloaded) / float64(totalSize) * 100
			}
			progressFn(ApplyProgress{Stage: "downloading", Percent: pct, Downloaded: downloaded, Total: totalSize})
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return fmt.Errorf("read: %w", readErr)
		}
	}
	tmpFile.Close()

	checksum := hex.EncodeToString(hasher.Sum(nil))
	logger.Config.Info().Str("checksum", checksum).Int64("size", downloaded).Msg("update downloaded")

	// 2. Verify: ensure downloaded file is a valid binary, not HTML/text garbage
	progressFn(ApplyProgress{Stage: "verifying", Percent: 100})

	if err := validateBinaryMagic(tmpPath); err != nil {
		return fmt.Errorf("downloaded file is not a valid binary: %w", err)
	}

	// 3. Replace binary
	progressFn(ApplyProgress{Stage: "replacing", Percent: 100})

	if err := replaceBinary(currentExe, tmpPath); err != nil {
		return fmt.Errorf("replace binary: %w", err)
	}

	progressFn(ApplyProgress{Stage: "done", Percent: 100, Done: true})
	logger.Config.Info().Str("version", version.Version).Msg("self-update applied, restart required")

	return nil
}

// expectedAssetName returns the expected asset filename for the current platform.
func expectedAssetName() string {
	ext := ""
	if runtime.GOOS == "windows" {
		ext = ".exe"
	}
	return fmt.Sprintf("clawdeckx-%s-%s%s", runtime.GOOS, runtime.GOARCH, ext)
}

// replaceBinary replaces the current executable with the new one.
// On Windows: rename current → .bak, rename new → current.
// On Unix: overwrite directly (safe because inode stays).
func replaceBinary(currentPath, newPath string) error {
	// Set executable permission on Unix
	if runtime.GOOS != "windows" {
		if err := os.Chmod(newPath, 0o755); err != nil {
			return fmt.Errorf("chmod: %w", err)
		}
	}

	if runtime.GOOS == "windows" {
		// Windows: running exe can be renamed but not deleted
		bakPath := currentPath + ".bak"
		// Remove old backup if exists
		os.Remove(bakPath)
		// Rename current → .bak
		if err := os.Rename(currentPath, bakPath); err != nil {
			return fmt.Errorf("rename current to bak: %w", err)
		}
		// Rename new → current
		if err := os.Rename(newPath, currentPath); err != nil {
			// Try to restore
			os.Rename(bakPath, currentPath)
			return fmt.Errorf("rename new to current: %w", err)
		}
		return nil
	}

	// Unix: direct rename (atomic on same filesystem)
	if err := os.Rename(newPath, currentPath); err != nil {
		return fmt.Errorf("rename: %w", err)
	}
	return nil
}

// validateBinaryMagic checks that the file starts with a valid executable magic number.
// This prevents replacing the binary with HTML error pages or other garbage.
func validateBinaryMagic(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

	header := make([]byte, 4)
	n, err := f.Read(header)
	if err != nil || n < 2 {
		return fmt.Errorf("file too small or unreadable (%d bytes read)", n)
	}

	// ELF (Linux): 0x7f 'E' 'L' 'F'
	if n >= 4 && header[0] == 0x7f && header[1] == 'E' && header[2] == 'L' && header[3] == 'F' {
		return nil
	}
	// MZ / PE (Windows): 'M' 'Z'
	if header[0] == 'M' && header[1] == 'Z' {
		return nil
	}
	// Mach-O (macOS): 0xFEEDFACE, 0xFEEDFACF, 0xCEFAEDFE, 0xCFFAEDFE, or fat binary 0xCAFEBABE
	if n >= 4 {
		magic := uint32(header[0])<<24 | uint32(header[1])<<16 | uint32(header[2])<<8 | uint32(header[3])
		switch magic {
		case 0xFEEDFACE, 0xFEEDFACF, 0xCEFAEDFE, 0xCFFAEDFE, 0xCAFEBABE:
			return nil
		}
	}

	// Show first bytes for diagnosis
	preview := string(header[:n])
	if len(preview) > 40 {
		preview = preview[:40]
	}
	return fmt.Errorf("unrecognized file header (starts with %q), expected ELF/PE/Mach-O binary", preview)
}

// compareSemver compares two semver strings; returns positive if a > b.
// Prerelease-aware: 2026.3.8 > 2026.3.8-beta.1 (per semver spec).
func compareSemver(a, b string) int {
	pa, preA := parseParts(a)
	pb, preB := parseParts(b)
	for i := 0; i < 3; i++ {
		if pa[i] != pb[i] {
			return pa[i] - pb[i]
		}
	}
	// Same major.minor.patch: prerelease < release
	if preA && !preB {
		return -1 // a is prerelease, b is release → a < b
	}
	if !preA && preB {
		return 1 // a is release, b is prerelease → a > b
	}
	return 0
}

func parseParts(v string) ([3]int, bool) {
	v = strings.TrimPrefix(v, "v")
	// Skip leading non-digit chars (e.g. "OpenCLaw 2026.3.8 (3caab92)" → "2026.3.8 (3caab92)")
	for len(v) > 0 && (v[0] < '0' || v[0] > '9') {
		v = v[1:]
	}
	// detect and strip prerelease tag
	hasPrerelease := false
	if idx := strings.IndexByte(v, '-'); idx >= 0 {
		hasPrerelease = true
		v = v[:idx]
	}
	// strip build metadata / extra info (e.g. "2026.3.8 (3caab92)" or "2026.3.8+build")
	if idx := strings.IndexByte(v, '+'); idx >= 0 {
		v = v[:idx]
	}
	if idx := strings.IndexByte(v, ' '); idx >= 0 {
		v = v[:idx]
	}
	parts := strings.SplitN(v, ".", 3)
	var result [3]int
	for i := 0; i < 3 && i < len(parts); i++ {
		fmt.Sscanf(parts[i], "%d", &result[i])
	}
	return result, hasPrerelease
}
