package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"

	"ClawDeckX/internal/executil"
	"ClawDeckX/internal/logger"
	"ClawDeckX/internal/updatecheck"
)

// npmVersionCache caches the latest version from npm registry.
type npmVersionCache struct {
	mu       sync.RWMutex
	versions map[string]*npmCacheEntry
	client   *http.Client
	cacheTTL time.Duration
}

type npmCacheEntry struct {
	version   string
	fetchedAt time.Time
}

var npmCache = &npmVersionCache{
	versions: make(map[string]*npmCacheEntry),
	client:   &http.Client{Timeout: 10 * time.Second},
	cacheTTL: 6 * time.Hour,
}

// FetchLatestNpmVersion returns the latest version of an npm package.
// Results are cached for 6 hours.
func FetchLatestNpmVersion(packageName string) (string, error) {
	npmCache.mu.RLock()
	if entry, ok := npmCache.versions[packageName]; ok && time.Since(entry.fetchedAt) < npmCache.cacheTTL {
		npmCache.mu.RUnlock()
		return entry.version, nil
	}
	npmCache.mu.RUnlock()

	url := fmt.Sprintf("https://registry.npmjs.org/%s/latest", packageName)
	resp, err := npmCache.client.Get(url)
	if err != nil {
		return "", fmt.Errorf("npm registry request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return "", fmt.Errorf("npm registry returned status %d", resp.StatusCode)
	}

	var data struct {
		Version string `json:"version"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return "", fmt.Errorf("failed to parse npm response: %w", err)
	}

	if data.Version == "" {
		return "", fmt.Errorf("empty version in npm response")
	}

	npmCache.mu.Lock()
	npmCache.versions[packageName] = &npmCacheEntry{
		version:   data.Version,
		fetchedAt: time.Now(),
	}
	npmCache.mu.Unlock()

	return data.Version, nil
}

// CompareVersions returns true if latest is newer than current.
// Simple semver comparison: splits on "." and compares numerically.
func CompareVersions(current, latest string) bool {
	current = strings.TrimPrefix(current, "v")
	latest = strings.TrimPrefix(latest, "v")

	// Strip anything after "-" or "+" (pre-release/build metadata)
	if idx := strings.IndexAny(current, "-+"); idx >= 0 {
		current = current[:idx]
	}
	if idx := strings.IndexAny(latest, "-+"); idx >= 0 {
		latest = latest[:idx]
	}

	cParts := strings.Split(current, ".")
	lParts := strings.Split(latest, ".")

	maxLen := len(cParts)
	if len(lParts) > maxLen {
		maxLen = len(lParts)
	}

	for i := 0; i < maxLen; i++ {
		var c, l int
		if i < len(cParts) {
			fmt.Sscanf(cParts[i], "%d", &c)
		}
		if i < len(lParts) {
			fmt.Sscanf(lParts[i], "%d", &l)
		}
		if l > c {
			return true
		}
		if l < c {
			return false
		}
	}
	return false
}

// UpgradeNpmCLI upgrades a globally installed npm package.
func UpgradeNpmCLI(packageName string) (string, error) {
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.Command("cmd.exe", "/c", "npm", "install", "-g", packageName+"@latest")
	} else {
		cmd = exec.Command("npm", "install", "-g", packageName+"@latest")
	}
	executil.HideWindow(cmd)

	output, err := cmd.CombinedOutput()
	result := strings.TrimSpace(string(output))

	if err != nil {
		logger.Log.Error().Err(err).Str("package", packageName).Str("output", result).Msg("npm CLI upgrade failed")
		return result, fmt.Errorf("upgrade failed: %w", err)
	}

	// Invalidate cache so next CLIStatus check fetches fresh data
	npmCache.mu.Lock()
	delete(npmCache.versions, packageName)
	npmCache.mu.Unlock()

	// Clear the 12-hour update overview cache so badge counts refresh immediately
	updatecheck.InvalidateCache()

	logger.Log.Info().Str("package", packageName).Str("output", result).Msg("npm CLI upgraded")
	return result, nil
}
