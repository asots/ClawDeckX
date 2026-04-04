package handlers

import (
	"bufio"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"ClawDeckX/internal/openclaw"
	"ClawDeckX/internal/web"
)

// GatewayLogHandler serves gateway log viewing.
type GatewayLogHandler struct {
	svc      *openclaw.Service
	gwClient *openclaw.GWClient
}

func NewGatewayLogHandler(svc *openclaw.Service, gwClient *openclaw.GWClient) *GatewayLogHandler {
	return &GatewayLogHandler{svc: svc, gwClient: gwClient}
}

// GetLog returns the last N lines of gateway logs.
// Remote mode uses logs.tail JSON-RPC; local mode reads the log file.
// Supports cursor-based incremental polling (cursor, limit, maxBytes query params).
func (h *GatewayLogHandler) GetLog(w http.ResponseWriter, r *http.Request) {
	lines := 200
	if v := r.URL.Query().Get("lines"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 2000 {
			lines = n
		}
	}
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 5000 {
			lines = n
		}
	}

	cursor := -1 // -1 means no cursor provided
	if v := r.URL.Query().Get("cursor"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			cursor = n
		}
	}

	maxBytes := 250000
	if v := r.URL.Query().Get("maxBytes"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 1000000 {
			maxBytes = n
		}
	}

	// remote mode: fetch via GWClient logs.tail, fallback to local if RPC fails
	if h.gwClient != nil && h.gwClient.IsConnected() {
		if h.tryRemoteLog(w, r, lines, cursor, maxBytes) {
			return
		}
	}

	// local mode: read local log file
	h.getLocalLog(w, r, lines)
}

// tryRemoteLog attempts to fetch remote gateway logs via logs.tail JSON-RPC.
// Returns true if successful (response written), false if failed (caller should fallback).
func (h *GatewayLogHandler) tryRemoteLog(w http.ResponseWriter, r *http.Request, lines, cursor, maxBytes int) bool {
	params := map[string]interface{}{"limit": lines, "maxBytes": maxBytes}
	if cursor >= 0 {
		params["cursor"] = cursor
	}
	data, err := h.gwClient.RequestWithTimeout("logs.tail", params, 15*time.Second)
	if err != nil {
		return false
	}
	// parse logs.tail result: { file, cursor, size, lines: string[], truncated, reset }
	var result struct {
		File      string   `json:"file"`
		Cursor    int      `json:"cursor"`
		Size      int      `json:"size"`
		Lines     []string `json:"lines"`
		Truncated bool     `json:"truncated"`
		Reset     bool     `json:"reset"`
	}
	if err := json.Unmarshal(data, &result); err != nil {
		return false
	}
	web.OK(w, r, map[string]interface{}{
		"lines":      result.Lines,
		"path":       result.File,
		"line_count": len(result.Lines),
		"remote":     true,
		"cursor":     result.Cursor,
		"size":       result.Size,
		"truncated":  result.Truncated,
		"reset":      result.Reset,
	})
	return true
}

// getLocalLog reads local log files.
func (h *GatewayLogHandler) getLocalLog(w http.ResponseWriter, r *http.Request, lines int) {
	logPaths := h.findLogPaths()
	if len(logPaths) == 0 {
		web.OK(w, r, map[string]interface{}{
			"lines":   []string{},
			"path":    "",
			"message": "no gateway log file found",
		})
		return
	}

	logPath := logPaths[0]
	content, err := tailFile(logPath, lines)
	if err != nil {
		web.FailErr(w, r, web.ErrLogReadFailed, err.Error())
		return
	}

	web.OK(w, r, map[string]interface{}{
		"lines":      content,
		"path":       logPath,
		"all_paths":  logPaths,
		"line_count": len(content),
	})
}

// findLogPaths finds possible gateway log paths.
func (h *GatewayLogHandler) findLogPaths() []string {
	var paths []string

	stateDir := openclaw.ResolveStateDir()
	if stateDir == "" {
		return paths
	}

	candidates := []string{
		filepath.Join(stateDir, "gateway.log"),
		filepath.Join(stateDir, "openclaw-gateway.log"),
		filepath.Join(stateDir, "openclaw.log"),
		"/tmp/openclaw-gateway.log",
		"/var/log/openclaw/gateway.log",
	}

	// also search stateDir for all .log files
	ocDir := stateDir
	entries, _ := os.ReadDir(ocDir)
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".log") {
			p := filepath.Join(ocDir, e.Name())
			found := false
			for _, c := range candidates {
				if c == p {
					found = true
					break
				}
			}
			if !found {
				candidates = append(candidates, p)
			}
		}
	}

	for _, p := range candidates {
		if info, err := os.Stat(p); err == nil && !info.IsDir() && info.Size() > 0 {
			paths = append(paths, p)
		}
	}

	return paths
}

// tailFile reads the last N lines of a file.
func tailFile(path string, n int) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var allLines []string
	scanner := bufio.NewScanner(f)
	// increase buffer for long lines
	buf := make([]byte, 0, 64*1024)
	scanner.Buffer(buf, 1024*1024)

	for scanner.Scan() {
		allLines = append(allLines, scanner.Text())
	}

	if len(allLines) <= n {
		return allLines, nil
	}
	return allLines[len(allLines)-n:], nil
}
