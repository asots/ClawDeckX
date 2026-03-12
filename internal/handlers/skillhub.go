package handlers

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"ClawDeckX/internal/logger"
	"ClawDeckX/internal/web"
)

// SkillHubHandler handles SkillHub-related operations
type SkillHubHandler struct {
	// Server-side cache for proxied SkillHub data (avoids re-fetching 3-5MB JSON from CDN)
	cacheMu        sync.Mutex
	cacheData      json.RawMessage
	cacheURL       string
	cacheTime      time.Time
	cacheTTL       time.Duration
	warmingUp      bool // prevents multiple concurrent WarmCache goroutines
	gwClient       GatewayClient
	diskCacheDir   string
	defaultDataURL string
}

// GatewayClient interface for OpenClaw Gateway RPC calls
type GatewayClient interface {
	Request(method string, params interface{}) (json.RawMessage, error)
}

// managedSkillsDir returns the openclaw managed skills directory (~/.openclaw/skills).
// This is where the gateway's skills.status RPC scans for installed skills.
func managedSkillsDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	// Respect OPENCLAW_STATE_DIR if set
	if dir := os.Getenv("OPENCLAW_STATE_DIR"); dir != "" {
		return filepath.Join(dir, "skills")
	}
	return filepath.Join(home, ".openclaw", "skills")
}

// NewSkillHubHandler creates a new SkillHub handler.
// dataURL is the upstream SkillHub JSON URL (configurable via config.skillhub.data_url).
func NewSkillHubHandler(dataDir string, dataURL string) *SkillHubHandler {
	cacheDir := filepath.Join(dataDir, "cache")
	os.MkdirAll(cacheDir, 0o755)

	if dataURL == "" {
		dataURL = "https://cloudcache.tencentcs.com/qcloud/tea/app/data/skills.33d56946.json"
	}

	h := &SkillHubHandler{
		cacheTTL:       1 * time.Hour,
		diskCacheDir:   cacheDir,
		defaultDataURL: dataURL,
	}
	// Load disk cache on startup for instant first response
	h.loadDiskCache()
	return h
}

const diskCacheFile = "skillhub_data.json"

// diskCacheMeta is stored alongside the cached data on disk.
type diskCacheMeta struct {
	URL       string    `json:"url"`
	FetchedAt time.Time `json:"fetched_at"`
}

// loadDiskCache restores cached data from disk into memory.
func (h *SkillHubHandler) loadDiskCache() {
	dataPath := filepath.Join(h.diskCacheDir, diskCacheFile)
	metaPath := dataPath + ".meta"

	data, err := os.ReadFile(dataPath)
	if err != nil || !json.Valid(data) {
		return
	}

	var meta diskCacheMeta
	if metaBytes, err := os.ReadFile(metaPath); err == nil {
		json.Unmarshal(metaBytes, &meta)
	}

	h.cacheMu.Lock()
	h.cacheData = json.RawMessage(data)
	h.cacheURL = meta.URL
	h.cacheTime = meta.FetchedAt
	h.cacheMu.Unlock()
	logger.Log.Info().Str("age", time.Since(meta.FetchedAt).String()).Msg("SkillHub disk cache loaded")
}

// saveDiskCache persists the in-memory cache to disk.
func (h *SkillHubHandler) saveDiskCache(data []byte, url string) {
	dataPath := filepath.Join(h.diskCacheDir, diskCacheFile)
	metaPath := dataPath + ".meta"

	if err := os.WriteFile(dataPath, data, 0o644); err != nil {
		logger.Log.Warn().Err(err).Msg("failed to save SkillHub disk cache")
		return
	}

	meta := diskCacheMeta{URL: url, FetchedAt: time.Now()}
	if metaBytes, err := json.Marshal(meta); err == nil {
		os.WriteFile(metaPath, metaBytes, 0o644)
	}
}

// WarmCache fetches upstream data in the background to pre-warm the cache.
// Call this at startup after creating the handler.
func (h *SkillHubHandler) WarmCache() {
	h.cacheMu.Lock()
	hasFreshCache := h.cacheData != nil && time.Since(h.cacheTime) < h.cacheTTL
	alreadyWarming := h.warmingUp
	if !hasFreshCache && !alreadyWarming {
		h.warmingUp = true
	}
	h.cacheMu.Unlock()

	if hasFreshCache || alreadyWarming {
		return
	}

	go func() {
		defer func() {
			h.cacheMu.Lock()
			h.warmingUp = false
			h.cacheMu.Unlock()
		}()
		dataURL := h.defaultDataURL
		client := &http.Client{Timeout: 2 * time.Minute}
		resp, err := client.Get(dataURL)
		if err != nil {
			logger.Log.Warn().Err(err).Msg("SkillHub cache warm-up failed")
			return
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			return
		}

		body, err := io.ReadAll(resp.Body)
		if err != nil || !json.Valid(body) {
			return
		}

		h.cacheMu.Lock()
		h.cacheData = json.RawMessage(body)
		h.cacheURL = dataURL
		h.cacheTime = time.Now()
		h.cacheMu.Unlock()

		h.saveDiskCache(body, dataURL)
		logger.Log.Info().Int("bytes", len(body)).Msg("SkillHub cache warmed up")
	}()
}

// SetGatewayClient sets the Gateway client for RPC calls
func (h *SkillHubHandler) SetGatewayClient(client GatewayClient) {
	h.gwClient = client
}

// CLIStatus checks if SkillHub CLI is installed
// GET /api/v1/skillhub/cli-status
func (h *SkillHubHandler) CLIStatus(w http.ResponseWriter, r *http.Request) {
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.Command("cmd.exe", "/c", "skillhub", "--version")
	} else {
		cmd = exec.Command("skillhub", "--version")
	}

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	if err != nil {
		// CLI not installed or not in PATH
		web.OK(w, r, map[string]interface{}{
			"installed": false,
			"version":   nil,
			"path":      nil,
		})
		return
	}

	version := strings.TrimSpace(stdout.String())
	if version == "" {
		version = strings.TrimSpace(stderr.String())
	}

	// Try to get the path
	var pathCmd *exec.Cmd
	if runtime.GOOS == "windows" {
		pathCmd = exec.Command("cmd.exe", "/c", "where", "skillhub")
	} else {
		pathCmd = exec.Command("which", "skillhub")
	}

	var pathOut bytes.Buffer
	pathCmd.Stdout = &pathOut
	pathCmd.Run()

	cliPath := strings.TrimSpace(pathOut.String())

	web.OK(w, r, map[string]interface{}{
		"installed": true,
		"version":   version,
		"path":      cliPath,
	})
}

// Install installs SkillHub CLI
// POST /api/v1/skillhub/install
func (h *SkillHubHandler) Install(w http.ResponseWriter, r *http.Request) {
	if runtime.GOOS == "windows" {
		web.Fail(w, r, "PLATFORM_NOT_SUPPORTED", "One-click install is not supported on Windows. Please install manually.", http.StatusBadRequest)
		return
	}

	logger.Log.Info().Msg("starting SkillHub CLI installation")

	// Create install script
	installScript := `#!/usr/bin/env bash
set -euo pipefail

KIT_URL="https://skillhub-1251783334.cos.ap-guangzhou.myqcloud.com/install/latest.tar.gz"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Downloading SkillHub CLI..."
curl -fsSL "$KIT_URL" -o "$TMP_DIR/latest.tar.gz"

echo "Extracting..."
tar -xzf "$TMP_DIR/latest.tar.gz" -C "$TMP_DIR"

INSTALLER="$TMP_DIR/cli/install.sh"
if [[ ! -f "$INSTALLER" ]]; then
  echo "Error: install.sh not found at $INSTALLER" >&2
  find "$TMP_DIR" -maxdepth 3 -print >&2
  exit 1
fi

echo "Running installer..."
bash "$INSTALLER" "$@"
`

	// Save script to temp file
	tmpDir := os.TempDir()
	scriptPath := filepath.Join(tmpDir, "skillhub-install.sh")
	err := os.WriteFile(scriptPath, []byte(installScript), 0755)
	if err != nil {
		logger.Log.Error().Err(err).Msg("failed to create install script")
		web.Fail(w, r, "SCRIPT_CREATE_FAILED", err.Error(), http.StatusInternalServerError)
		return
	}
	defer os.Remove(scriptPath)

	// Execute install script
	cmd := exec.Command("bash", scriptPath)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	done := make(chan error, 1)
	go func() {
		done <- cmd.Run()
	}()

	select {
	case err := <-done:
		output := stdout.String()
		errOutput := stderr.String()

		if err != nil {
			logger.Log.Error().Err(err).Str("stdout", output).Str("stderr", errOutput).Msg("SkillHub installation failed")

			// Check for permission errors
			if strings.Contains(errOutput, "Permission denied") || strings.Contains(output, "Permission denied") {
				web.Fail(w, r, "PERMISSION_DENIED", "Permission denied. Please run with sudo or as administrator.", http.StatusForbidden)
				return
			}

			web.Fail(w, r, "INSTALL_FAILED", errOutput+"\n"+output, http.StatusInternalServerError)
			return
		}

		logger.Log.Info().Str("output", output).Msg("SkillHub CLI installed successfully")
		web.OK(w, r, map[string]interface{}{
			"success": true,
			"output":  output,
		})

	case <-time.After(5 * time.Minute):
		if cmd.Process != nil {
			cmd.Process.Kill()
		}
		web.Fail(w, r, "INSTALL_TIMEOUT", "Installation timed out after 5 minutes", http.StatusGatewayTimeout)
	}
}

// InstallSkill installs a specific skill using SkillHub CLI
// POST /api/v1/skillhub/install-skill
func (h *SkillHubHandler) InstallSkill(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Slug string `json:"slug"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.Fail(w, r, "INVALID_REQUEST", "invalid request body", http.StatusBadRequest)
		return
	}

	if req.Slug == "" {
		web.Fail(w, r, "INVALID_REQUEST", "skill slug is required", http.StatusBadRequest)
		return
	}

	// Validate slug: only allow alphanumeric, hyphens, underscores, dots (prevent injection)
	for _, c := range req.Slug {
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.') {
			web.Fail(w, r, "INVALID_PARAM", "invalid slug characters", http.StatusBadRequest)
			return
		}
	}

	logger.Log.Info().Str("slug", req.Slug).Msg("installing skill via SkillHub CLI")

	// Check if SkillHub CLI is installed
	var checkCmd *exec.Cmd
	if runtime.GOOS == "windows" {
		checkCmd = exec.Command("cmd.exe", "/c", "skillhub", "--version")
	} else {
		checkCmd = exec.Command("skillhub", "--version")
	}

	if err := checkCmd.Run(); err != nil {
		web.Fail(w, r, "CLI_NOT_INSTALLED", "SkillHub CLI is not installed", http.StatusBadRequest)
		return
	}

	// Execute skillhub install command with --dir pointing to openclaw managed skills dir
	// Note: --dir must come BEFORE the install subcommand
	skillsDir := managedSkillsDir()
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.Command("cmd.exe", "/c", "skillhub", "--dir", skillsDir, "install", req.Slug)
	} else {
		cmd = exec.Command("skillhub", "--dir", skillsDir, "install", req.Slug)
	}

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	done := make(chan error, 1)
	go func() {
		done <- cmd.Run()
	}()

	select {
	case err := <-done:
		output := stdout.String()
		errOutput := stderr.String()

		if err != nil {
			logger.Log.Error().Err(err).Str("slug", req.Slug).Str("stdout", output).Str("stderr", errOutput).Msg("skill installation failed")
			web.Fail(w, r, "INSTALL_FAILED", errOutput+"\n"+output, http.StatusInternalServerError)
			return
		}

		logger.Log.Info().Str("slug", req.Slug).Str("output", output).Msg("skill installed successfully")
		web.OK(w, r, map[string]interface{}{
			"success": true,
			"output":  output,
			"slug":    req.Slug,
		})

	case <-time.After(3 * time.Minute):
		if cmd.Process != nil {
			cmd.Process.Kill()
		}
		web.Fail(w, r, "INSTALL_TIMEOUT", "Installation timed out after 3 minutes", http.StatusGatewayTimeout)
	}
}

// ProxyData proxies the SkillHub JSON data with server-side caching.
// The upstream JSON is ~3-5MB; without caching every page visit re-downloads it.
// GET /api/v1/skillhub/data?url=<encoded_url>
func (h *SkillHubHandler) ProxyData(w http.ResponseWriter, r *http.Request) {
	dataURL := r.URL.Query().Get("url")
	if dataURL == "" {
		dataURL = h.defaultDataURL
	}

	// Check server-side cache (same URL + within TTL)
	h.cacheMu.Lock()
	if h.cacheData != nil && h.cacheURL == dataURL && time.Since(h.cacheTime) < h.cacheTTL {
		cached := h.cacheData
		h.cacheMu.Unlock()
		logger.Log.Debug().Str("url", dataURL).Msg("serving SkillHub data from server cache")
		web.OK(w, r, json.RawMessage(cached))
		return
	}
	h.cacheMu.Unlock()

	logger.Log.Info().Str("url", dataURL).Msg("fetching SkillHub data from upstream")

	// Create HTTP client with timeout (large file ~3-5MB, needs more time)
	client := &http.Client{
		Timeout: 2 * time.Minute,
	}

	resp, err := client.Get(dataURL)
	if err != nil {
		logger.Log.Error().Err(err).Str("url", dataURL).Msg("failed to fetch SkillHub data")
		web.Fail(w, r, "FETCH_FAILED", err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		logger.Log.Error().Int("status", resp.StatusCode).Str("url", dataURL).Msg("SkillHub data fetch returned non-200")
		web.Fail(w, r, "FETCH_FAILED", "upstream returned "+resp.Status, http.StatusBadGateway)
		return
	}

	// Read response body
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		logger.Log.Error().Err(err).Msg("failed to read SkillHub data response")
		web.Fail(w, r, "READ_FAILED", err.Error(), http.StatusInternalServerError)
		return
	}

	// Validate JSON
	if !json.Valid(body) {
		logger.Log.Error().Msg("invalid JSON from SkillHub data source")
		web.Fail(w, r, "INVALID_JSON", "upstream returned invalid JSON", http.StatusBadGateway)
		return
	}

	// Update server-side cache
	h.cacheMu.Lock()
	h.cacheData = json.RawMessage(body)
	h.cacheURL = dataURL
	h.cacheTime = time.Now()
	h.cacheMu.Unlock()

	// Persist to disk for cold-start resilience
	h.saveDiskCache(body, dataURL)

	// Return standard API response format
	web.OK(w, r, json.RawMessage(body))
}

// GetInstalledSkills fetches installed skills from both OpenClaw Gateway and SkillHub CLI.
// Returns the union of skills detected by both sources.
// GET /api/v1/skillhub/installed
func (h *SkillHubHandler) GetInstalledSkills(w http.ResponseWriter, r *http.Request) {
	installedSet := map[string]struct{}{}

	// Source 1: OpenClaw Gateway skills.status RPC (bundled + managed + workspace)
	if h.gwClient != nil {
		raw, err := h.gwClient.Request("skills.status", map[string]interface{}{})
		if err != nil {
			logger.Log.Debug().Err(err).Msg("gateway skills.status unavailable, skipping")
		} else {
			var response struct {
				Skills []struct {
					Name   string `json:"name"`
					Source string `json:"source"`
				} `json:"skills"`
			}
			if err := json.Unmarshal(raw, &response); err == nil {
				for _, skill := range response.Skills {
					if skill.Source == "openclaw-managed" || skill.Source == "openclaw-workspace" {
						installedSet[skill.Name] = struct{}{}
					}
				}
			}
		}
	}

	// Source 2: SkillHub CLI "skillhub list" (skills installed via skillhub install)
	func() {
		skillsDir := managedSkillsDir()
		var cmd *exec.Cmd
		if runtime.GOOS == "windows" {
			cmd = exec.Command("cmd.exe", "/c", "skillhub", "--dir", skillsDir, "list")
		} else {
			cmd = exec.Command("skillhub", "--dir", skillsDir, "list")
		}
		var stdout bytes.Buffer
		cmd.Stdout = &stdout

		done := make(chan error, 1)
		go func() { done <- cmd.Run() }()

		select {
		case err := <-done:
			if err != nil {
				logger.Log.Debug().Err(err).Msg("skillhub list unavailable, skipping")
				return
			}
			lines := strings.Split(strings.TrimSpace(stdout.String()), "\n")
			for _, line := range lines {
				line = strings.TrimSpace(line)
				if line == "" {
					continue
				}
				fields := strings.Fields(line)
				if len(fields) >= 1 {
					installedSet[fields[0]] = struct{}{}
				}
			}
		case <-time.After(10 * time.Second):
			if cmd.Process != nil {
				cmd.Process.Kill()
			}
			logger.Log.Debug().Msg("skillhub list timed out, skipping")
		}
	}()

	// Convert set to sorted slice
	installedSkills := make([]string, 0, len(installedSet))
	for name := range installedSet {
		installedSkills = append(installedSkills, name)
	}

	logger.Log.Debug().Int("count", len(installedSkills)).Strs("skills", installedSkills).Msg("fetched installed skills (merged)")

	web.OK(w, r, map[string]interface{}{
		"skills": installedSkills,
	})
}

// skillHubSkill is the parsed form of a single skill from the upstream JSON.
type skillHubSkill struct {
	Slug          string   `json:"slug"`
	Name          string   `json:"name"`
	Homepage      string   `json:"homepage,omitempty"`
	Version       string   `json:"version"`
	Description   string   `json:"description"`
	DescriptionZH string   `json:"description_zh,omitempty"`
	Stars         int      `json:"stars"`
	Downloads     int      `json:"downloads"`
	Installs      int      `json:"installs"`
	Tags          []string `json:"tags"`
	UpdatedAt     int64    `json:"updated_at"`
	Score         float64  `json:"score"`
}

type skillHubFullData struct {
	Total       int                 `json:"total"`
	GeneratedAt string              `json:"generated_at"`
	Featured    []string            `json:"featured"`
	Categories  map[string][]string `json:"categories"`
	Skills      []skillHubSkill     `json:"skills"`
}

// getCachedSkills parses the in-memory cached JSON into structured data.
// Returns nil if no cache is available.
func (h *SkillHubHandler) getCachedSkills() *skillHubFullData {
	h.cacheMu.Lock()
	raw := h.cacheData
	h.cacheMu.Unlock()

	if raw == nil {
		return nil
	}

	var data skillHubFullData
	if err := json.Unmarshal(raw, &data); err != nil {
		return nil
	}
	return &data
}

// slimSkill returns a skill with only fields needed for list display.
type slimSkill struct {
	Slug          string   `json:"slug"`
	Name          string   `json:"name"`
	Version       string   `json:"version"`
	Description   string   `json:"description"`
	DescriptionZH string   `json:"description_zh,omitempty"`
	Stars         int      `json:"stars"`
	Downloads     int      `json:"downloads"`
	Installs      int      `json:"installs"`
	Tags          []string `json:"tags"`
	UpdatedAt     int64    `json:"updated_at"`
}

func toSlim(s skillHubSkill) slimSkill {
	return slimSkill{
		Slug:          s.Slug,
		Name:          s.Name,
		Version:       s.Version,
		Description:   s.Description,
		DescriptionZH: s.DescriptionZH,
		Stars:         s.Stars,
		Downloads:     s.Downloads,
		Installs:      s.Installs,
		Tags:          s.Tags,
		UpdatedAt:     s.UpdatedAt,
	}
}

// ListSkills returns a paginated, sorted, filtered list of skills from cached data.
// GET /api/v1/skillhub/skills?page=1&size=60&sort=newest&category=all&featured=false
func (h *SkillHubHandler) ListSkills(w http.ResponseWriter, r *http.Request) {
	data := h.getCachedSkills()
	if data == nil {
		// Cache not yet ready — trigger warm-up and wait up to 10s for it
		h.WarmCache()
		for i := 0; i < 20; i++ {
			time.Sleep(500 * time.Millisecond)
			data = h.getCachedSkills()
			if data != nil {
				break
			}
		}
		if data == nil {
			web.Fail(w, r, "CACHE_EMPTY", "SkillHub data not yet loaded, please try again shortly", http.StatusServiceUnavailable)
			return
		}
	}

	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if page < 1 {
		page = 1
	}
	size, _ := strconv.Atoi(r.URL.Query().Get("size"))
	if size < 1 || size > 200 {
		size = 60
	}
	sortBy := r.URL.Query().Get("sort")
	category := r.URL.Query().Get("category")
	featured := r.URL.Query().Get("featured") == "true"

	skills := data.Skills

	// Featured filter
	if featured {
		featSet := make(map[string]bool, len(data.Featured))
		for _, f := range data.Featured {
			featSet[f] = true
		}
		filtered := skills[:0:0]
		for _, s := range skills {
			if featSet[s.Slug] {
				filtered = append(filtered, s)
			}
		}
		skills = filtered
	}

	// Category filter
	if category != "" && category != "all" {
		if tags, ok := data.Categories[category]; ok {
			tagSet := make(map[string]bool, len(tags))
			for _, t := range tags {
				tagSet[strings.ToLower(t)] = true
			}
			filtered := skills[:0:0]
			for _, s := range skills {
				for _, t := range s.Tags {
					if tagSet[strings.ToLower(t)] {
						filtered = append(filtered, s)
						break
					}
				}
			}
			skills = filtered
		}
	}

	// Sort
	switch sortBy {
	case "downloads":
		sort.Slice(skills, func(i, j int) bool { return skills[i].Downloads > skills[j].Downloads })
	case "stars":
		sort.Slice(skills, func(i, j int) bool { return skills[i].Stars > skills[j].Stars })
	default: // newest
		sort.Slice(skills, func(i, j int) bool { return skills[i].UpdatedAt > skills[j].UpdatedAt })
	}

	total := len(skills)
	start := (page - 1) * size
	if start > total {
		start = total
	}
	end := start + size
	if end > total {
		end = total
	}
	pageSkills := skills[start:end]

	// Convert to slim
	slim := make([]slimSkill, len(pageSkills))
	for i, s := range pageSkills {
		slim[i] = toSlim(s)
	}

	web.OK(w, r, map[string]interface{}{
		"skills":     slim,
		"total":      total,
		"page":       page,
		"size":       size,
		"hasMore":    end < total,
		"categories": data.Categories,
		"featured":   data.Featured,
	})
}

// SearchSkills searches cached skills by query string.
// GET /api/v1/skillhub/search?q=xxx&limit=20
func (h *SkillHubHandler) SearchSkills(w http.ResponseWriter, r *http.Request) {
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" {
		web.Fail(w, r, "INVALID_PARAMS", "q is required", http.StatusBadRequest)
		return
	}

	data := h.getCachedSkills()
	if data == nil {
		h.WarmCache()
		for i := 0; i < 20; i++ {
			time.Sleep(500 * time.Millisecond)
			data = h.getCachedSkills()
			if data != nil {
				break
			}
		}
		if data == nil {
			web.Fail(w, r, "CACHE_EMPTY", "SkillHub data not yet loaded, please try again shortly", http.StatusServiceUnavailable)
			return
		}
	}

	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit < 1 || limit > 200 {
		limit = 20
	}

	q := strings.ToLower(query)
	var results []slimSkill
	for _, s := range data.Skills {
		if strings.Contains(strings.ToLower(s.Name), q) ||
			strings.Contains(strings.ToLower(s.Slug), q) ||
			strings.Contains(strings.ToLower(s.Description), q) ||
			strings.Contains(strings.ToLower(s.DescriptionZH), q) {
			results = append(results, toSlim(s))
			if len(results) >= limit {
				break
			}
		}
	}

	if results == nil {
		results = []slimSkill{}
	}

	web.OK(w, r, map[string]interface{}{
		"skills": results,
		"total":  len(results),
		"query":  query,
	})
}
