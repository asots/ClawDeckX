package handlers

import (
	"context"
	"net/http"
	"time"

	"ClawDeckX/internal/netutil"
	"ClawDeckX/internal/web"
)

// NetworkHandler handles network utility endpoints.
type NetworkHandler struct{}

func NewNetworkHandler() *NetworkHandler {
	return &NetworkHandler{}
}

// TestMirror proxies a HEAD request to the given URL so the frontend can
// measure real latency without browser CORS restrictions.
// GET /api/v1/network/test-mirror?url=<encoded-url>
func (h *NetworkHandler) TestMirror(w http.ResponseWriter, r *http.Request) {
	targetURL := r.URL.Query().Get("url")
	if targetURL == "" {
		web.Fail(w, r, "INVALID_PARAM", "url parameter is required", http.StatusBadRequest)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "HEAD", targetURL, nil)
	if err != nil {
		web.Fail(w, r, "REQUEST_ERROR", err.Error(), http.StatusBadRequest)
		return
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		web.Fail(w, r, "MIRROR_UNREACHABLE", err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 200 && resp.StatusCode < 400 {
		web.OK(w, r, map[string]interface{}{
			"status":  resp.StatusCode,
			"success": true,
		})
		return
	}

	web.Fail(w, r, "MIRROR_ERROR", "upstream returned "+resp.Status, resp.StatusCode)
}

// GetMirrors returns the current best mirrors for all services.
// GET /api/v1/network/mirrors
func (h *NetworkHandler) GetMirrors(w http.ResponseWriter, r *http.Request) {
	info := netutil.GetBestMirrorInfo(r.Context())
	web.OK(w, r, info)
}

// TestAllMirrors tests all mirrors and returns detailed results.
// GET /api/v1/network/test-all
func (h *NetworkHandler) TestAllMirrors(w http.ResponseWriter, r *http.Request) {
	results := netutil.TestAllMirrors(r.Context())
	web.OK(w, r, results)
}
