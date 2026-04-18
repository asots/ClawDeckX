package handlers

// ============================================================================
// Weixin iLink QR Login — direct Go implementation for ClawDeckX
// ============================================================================
// Protocol reverse-engineered from hermes-agent gateway/platforms/weixin.py
// and adapted for ClawDeckX (writes credentials to the openclaw-weixin plugin's
// on-disk account storage, not to .env).
//
// Flow:
//   1. GET  ilink/bot/get_bot_qrcode?bot_type=3  → { qrcode, qrcode_img_content }
//   2. GET  ilink/bot/get_qrcode_status?qrcode=X  → { status, ... }
//        status: wait | scaned | scaned_but_redirect | expired | confirmed
//   3. On confirmed: { ilink_bot_id, bot_token, baseurl, ilink_user_id }
//   4. Persist to {OPENCLAW_STATE_DIR}/openclaw-weixin/accounts/{normalizedId}.json
//      + append to {OPENCLAW_STATE_DIR}/openclaw-weixin/accounts.json index
//
// The openclaw-weixin plugin does NOT implement the standard web.login.start
// gateway RPC (no `gatewayMethods` declaration, no `gateway.loginWithQrStart`
// hook), so this handler bypasses the plugin and speaks to iLink directly.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"ClawDeckX/internal/logger"
	"ClawDeckX/internal/openclaw"
	"ClawDeckX/internal/web"

	"github.com/skip2/go-qrcode"
)

const (
	ilinkBaseURL          = "https://ilinkai.weixin.qq.com"
	ilinkAppID            = "bot"
	ilinkAppClientVersion = "131584" // (2 << 16) | (2 << 8) | 0
	ilinkEPGetBotQR       = "ilink/bot/get_bot_qrcode"
	ilinkEPGetQRStatus    = "ilink/bot/get_qrcode_status"
	ilinkQRTimeout        = 35 * time.Second
	weixinQRSessionExpiry = 10 * time.Minute
	weixinQRMaxRefresh    = 3
)

// WeixinQRHandler handles openclaw-weixin QR login flow.
type WeixinQRHandler struct {
	gwClient *openclaw.GWClient
}

func NewWeixinQRHandler(gwClient *openclaw.GWClient) *WeixinQRHandler {
	return &WeixinQRHandler{gwClient: gwClient}
}

// ----------------------------------------------------------------------------
// Session state
// ----------------------------------------------------------------------------

type weixinQRSession struct {
	mu           sync.Mutex
	qrcodeValue  string // opaque token for polling
	qrcodeImgURL string // URL to QR image from iLink (may not be displayable in browser)
	qrDataURI    string // locally generated data:image/png;base64,... QR image
	baseURL      string // may change on IDC redirect
	status       string // wait | scaned | refreshed | confirmed | expired | error | timeout
	statusMsg    string
	refreshCount int
	createdAt    time.Time
	// Result (only when status == "confirmed")
	accountID      string // raw ilink_bot_id (e.g. "b0f5860fdecb@im.bot")
	normalizedID   string // filesystem-safe id (e.g. "b0f5860fdecb-im-bot")
	token          string
	resultURL      string
	userID         string
	credentialPath string // where creds were saved
}

var (
	weixinSessionMu sync.Mutex
	weixinSession   *weixinQRSession
)

// ----------------------------------------------------------------------------
// iLink HTTP client
// ----------------------------------------------------------------------------

func ilinkGET(ctx context.Context, baseURL, endpoint string) (map[string]interface{}, error) {
	url := strings.TrimRight(baseURL, "/") + "/" + endpoint
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("iLink-App-Id", ilinkAppID)
	req.Header.Set("iLink-App-ClientVersion", ilinkAppClientVersion)

	client := &http.Client{Timeout: ilinkQRTimeout}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != 200 {
		snippet := string(body)
		if len(snippet) > 200 {
			snippet = snippet[:200]
		}
		return nil, fmt.Errorf("iLink %s HTTP %d: %s", endpoint, resp.StatusCode, snippet)
	}
	var result map[string]interface{}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("iLink %s: bad JSON: %w", endpoint, err)
	}
	return result, nil
}

func jsonStr(m map[string]interface{}, key string) string {
	v, ok := m[key]
	if !ok || v == nil {
		return ""
	}
	switch s := v.(type) {
	case string:
		return s
	case float64:
		return fmt.Sprintf("%.0f", s)
	default:
		return fmt.Sprintf("%v", s)
	}
}

// generateQRDataURI encodes data into a QR code PNG and returns a data URI.
func generateQRDataURI(data string, size int) string {
	if data == "" {
		return ""
	}
	png, err := qrcode.Encode(data, qrcode.Medium, size)
	if err != nil {
		logger.Log.Warn().Err(err).Msg("weixin QR: failed to generate QR image")
		return ""
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(png)
}

// ----------------------------------------------------------------------------
// HTTP handlers
// ----------------------------------------------------------------------------

// QRStart initiates a new Weixin QR login session.
// POST /api/v1/plugins/weixin/qr-start
func (h *WeixinQRHandler) QRStart(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), ilinkQRTimeout)
	defer cancel()

	resp, err := ilinkGET(ctx, ilinkBaseURL, ilinkEPGetBotQR+"?bot_type=3")
	if err != nil {
		logger.Log.Error().Err(err).Msg("weixin QR: failed to fetch QR code")
		web.Fail(w, r, "WEIXIN_QR_FAILED", "Failed to fetch QR code: "+err.Error(), http.StatusBadGateway)
		return
	}

	qrcodeValue := jsonStr(resp, "qrcode")
	qrcodeImgURL := jsonStr(resp, "qrcode_img_content")
	if qrcodeValue == "" {
		web.Fail(w, r, "WEIXIN_QR_EMPTY", "iLink returned empty QR code", http.StatusBadGateway)
		return
	}

	// iLink's qrcode_img_content may be a URL that browsers cannot render as
	// <img src>, so we always generate a local PNG data URI from the qrcode value.
	qrData := qrcodeImgURL
	if qrData == "" {
		qrData = qrcodeValue
	}
	qrDataURI := generateQRDataURI(qrData, 256)

	session := &weixinQRSession{
		qrcodeValue:  qrcodeValue,
		qrcodeImgURL: qrcodeImgURL,
		qrDataURI:    qrDataURI,
		baseURL:      ilinkBaseURL,
		status:       "wait",
		createdAt:    time.Now(),
	}

	weixinSessionMu.Lock()
	weixinSession = session
	weixinSessionMu.Unlock()

	// Start background polling goroutine
	go weixinPollLoop(session)

	logger.Log.Info().Msg("weixin QR: session started")

	web.OK(w, r, map[string]interface{}{
		"qrcode":   qrcodeValue,
		"qrImgUrl": qrDataURI,
		"status":   "wait",
	})
}

// QRPoll returns the current status of an in-progress Weixin QR login.
// POST /api/v1/plugins/weixin/qr-poll
func (h *WeixinQRHandler) QRPoll(w http.ResponseWriter, r *http.Request) {
	weixinSessionMu.Lock()
	s := weixinSession
	weixinSessionMu.Unlock()

	if s == nil {
		web.Fail(w, r, "NO_SESSION", "No Weixin QR session in progress", http.StatusBadRequest)
		return
	}

	s.mu.Lock()
	result := map[string]interface{}{
		"status":   s.status,
		"message":  s.statusMsg,
		"qrImgUrl": s.qrDataURI,
		"qrcode":   s.qrcodeValue,
	}
	if s.status == "confirmed" {
		result["accountId"] = s.normalizedID
		result["rawAccountId"] = s.accountID
		result["userId"] = s.userID
		result["baseUrl"] = s.resultURL
	}
	s.mu.Unlock()

	web.OK(w, r, result)
}

// QRCancel aborts the current session (if any).
// POST /api/v1/plugins/weixin/qr-cancel
func (h *WeixinQRHandler) QRCancel(w http.ResponseWriter, r *http.Request) {
	weixinSessionMu.Lock()
	s := weixinSession
	weixinSession = nil
	weixinSessionMu.Unlock()

	if s != nil {
		s.mu.Lock()
		if s.status != "confirmed" {
			s.status = "cancelled"
			s.statusMsg = "cancelled by user"
		}
		s.mu.Unlock()
	}
	web.OK(w, r, map[string]interface{}{"cancelled": true})
}

// ----------------------------------------------------------------------------
// Polling loop
// ----------------------------------------------------------------------------

func weixinPollLoop(s *weixinQRSession) {
	deadline := s.createdAt.Add(weixinQRSessionExpiry)

	for time.Now().Before(deadline) {
		s.mu.Lock()
		if s.status == "confirmed" || s.status == "error" || s.status == "timeout" || s.status == "cancelled" {
			s.mu.Unlock()
			return
		}
		baseURL := s.baseURL
		qrcode := s.qrcodeValue
		s.mu.Unlock()

		ctx, cancel := context.WithTimeout(context.Background(), ilinkQRTimeout)
		resp, err := ilinkGET(ctx, baseURL, ilinkEPGetQRStatus+"?qrcode="+qrcode)
		cancel()

		if err != nil {
			logger.Log.Warn().Err(err).Msg("weixin QR: poll error")
			time.Sleep(2 * time.Second)
			continue
		}

		status := jsonStr(resp, "status")
		if status == "" {
			status = "wait"
		}

		s.mu.Lock()
		switch status {
		case "wait":
			s.status = "wait"
		case "scaned":
			s.status = "scaned"
			s.statusMsg = "Scanned, please confirm in WeChat"
		case "scaned_but_redirect":
			redirectHost := jsonStr(resp, "redirect_host")
			if redirectHost != "" {
				s.baseURL = "https://" + redirectHost
			}
			s.status = "scaned"
			s.statusMsg = "Scanned, redirecting..."
		case "expired":
			s.refreshCount++
			if s.refreshCount > weixinQRMaxRefresh {
				s.status = "error"
				s.statusMsg = "QR code expired too many times"
				s.mu.Unlock()
				return
			}
			// Refresh QR
			s.mu.Unlock()
			ctx2, cancel2 := context.WithTimeout(context.Background(), ilinkQRTimeout)
			newResp, err := ilinkGET(ctx2, ilinkBaseURL, ilinkEPGetBotQR+"?bot_type=3")
			cancel2()
			if err != nil {
				s.mu.Lock()
				s.status = "error"
				s.statusMsg = "Failed to refresh QR: " + err.Error()
				s.mu.Unlock()
				return
			}
			s.mu.Lock()
			s.qrcodeValue = jsonStr(newResp, "qrcode")
			s.qrcodeImgURL = jsonStr(newResp, "qrcode_img_content")
			refreshData := s.qrcodeImgURL
			if refreshData == "" {
				refreshData = s.qrcodeValue
			}
			s.qrDataURI = generateQRDataURI(refreshData, 256)
			s.status = "refreshed"
			s.statusMsg = fmt.Sprintf("QR refreshed (%d/%d)", s.refreshCount, weixinQRMaxRefresh)
		case "confirmed":
			rawAccountID := jsonStr(resp, "ilink_bot_id")
			s.accountID = rawAccountID
			s.normalizedID = normalizeWeixinAccountID(rawAccountID)
			s.token = jsonStr(resp, "bot_token")
			s.resultURL = jsonStr(resp, "baseurl")
			s.userID = jsonStr(resp, "ilink_user_id")
			if s.resultURL == "" {
				s.resultURL = ilinkBaseURL
			}
			if s.accountID == "" || s.token == "" {
				s.status = "error"
				s.statusMsg = "QR confirmed but credential payload was incomplete"
			} else {
				// Persist credentials to openclaw-weixin plugin's account storage.
				if err := saveWeixinAccount(s.normalizedID, s.token, s.resultURL, s.userID); err != nil {
					s.status = "error"
					s.statusMsg = "Failed to save credentials: " + err.Error()
					logger.Log.Error().Err(err).Msg("weixin QR: save credentials failed")
				} else {
					s.status = "confirmed"
					s.statusMsg = "Login successful"
					s.credentialPath = resolveWeixinAccountPath(s.normalizedID)
					logger.Log.Info().
						Str("accountId", s.normalizedID).
						Str("userId", s.userID).
						Msg("weixin QR: credentials saved")
				}
			}
			s.mu.Unlock()
			return
		}
		s.mu.Unlock()
		time.Sleep(1500 * time.Millisecond)
	}

	// Session TTL reached
	s.mu.Lock()
	if s.status != "confirmed" && s.status != "error" && s.status != "cancelled" {
		s.status = "timeout"
		s.statusMsg = "QR login timed out"
	}
	s.mu.Unlock()
}

// ----------------------------------------------------------------------------
// Credential persistence
// ----------------------------------------------------------------------------
// Mirrors @tencent-weixin/openclaw-weixin's src/auth/accounts.ts format:
//   {OPENCLAW_STATE_DIR}/openclaw-weixin/accounts.json          — ["id1", "id2"]
//   {OPENCLAW_STATE_DIR}/openclaw-weixin/accounts/{id}.json     — { token, savedAt, baseUrl, userId }
// normalizeWeixinAccountID: "xxx@im.bot" → "xxx-im-bot"

func normalizeWeixinAccountID(raw string) string {
	if raw == "" {
		return ""
	}
	// Replace @ and . with - so the id is filesystem-safe.
	// This matches openclaw/plugin-sdk/account-id's normalizeAccountId behavior
	// for the known weixin suffixes (@im.bot, @im.wechat).
	s := strings.ReplaceAll(raw, "@", "-")
	s = strings.ReplaceAll(s, ".", "-")
	return s
}

func resolveWeixinStateDir() string {
	base := strings.TrimSpace(openclaw.ResolveStateDir())
	if base == "" {
		return ""
	}
	return filepath.Join(base, "openclaw-weixin")
}

func resolveWeixinAccountsDir() string {
	dir := resolveWeixinStateDir()
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, "accounts")
}

func resolveWeixinAccountIndexPath() string {
	dir := resolveWeixinStateDir()
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, "accounts.json")
}

func resolveWeixinAccountPath(accountID string) string {
	dir := resolveWeixinAccountsDir()
	if dir == "" || accountID == "" {
		return ""
	}
	return filepath.Join(dir, accountID+".json")
}

type weixinAccountFile struct {
	Token   string `json:"token,omitempty"`
	SavedAt string `json:"savedAt,omitempty"`
	BaseURL string `json:"baseUrl,omitempty"`
	UserID  string `json:"userId,omitempty"`
}

// saveWeixinAccount writes the per-account credentials file and appends the
// account id to the persistent index (matching the plugin's accounts.ts flow).
func saveWeixinAccount(accountID, token, baseURL, userID string) error {
	if accountID == "" {
		return fmt.Errorf("empty accountID")
	}
	accountsDir := resolveWeixinAccountsDir()
	if accountsDir == "" {
		return fmt.Errorf("cannot resolve openclaw state directory")
	}

	if err := os.MkdirAll(accountsDir, 0o755); err != nil {
		return fmt.Errorf("mkdir accounts dir: %w", err)
	}

	// Merge with any existing account data (mirrors plugin's saveWeixinAccount).
	accountPath := resolveWeixinAccountPath(accountID)
	existing := weixinAccountFile{}
	if b, err := os.ReadFile(accountPath); err == nil {
		_ = json.Unmarshal(b, &existing)
	}

	if strings.TrimSpace(token) != "" {
		existing.Token = token
		existing.SavedAt = time.Now().UTC().Format(time.RFC3339)
	}
	if strings.TrimSpace(baseURL) != "" {
		existing.BaseURL = baseURL
	}
	if strings.TrimSpace(userID) != "" {
		existing.UserID = userID
	}

	data, err := json.MarshalIndent(existing, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal account file: %w", err)
	}
	if err := os.WriteFile(accountPath, data, 0o600); err != nil {
		return fmt.Errorf("write account file: %w", err)
	}

	// Append to account index (unique).
	if err := registerWeixinAccountID(accountID); err != nil {
		// Non-fatal — the account file is the source of truth.
		logger.Log.Warn().Err(err).Str("accountId", accountID).Msg("weixin QR: failed to update account index")
	}

	return nil
}

func registerWeixinAccountID(accountID string) error {
	indexPath := resolveWeixinAccountIndexPath()
	if indexPath == "" {
		return fmt.Errorf("cannot resolve account index path")
	}
	if err := os.MkdirAll(filepath.Dir(indexPath), 0o755); err != nil {
		return err
	}

	var ids []string
	if b, err := os.ReadFile(indexPath); err == nil {
		_ = json.Unmarshal(b, &ids)
	}
	for _, id := range ids {
		if id == accountID {
			return nil // already present
		}
	}
	ids = append(ids, accountID)

	data, err := json.MarshalIndent(ids, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(indexPath, data, 0o644)
}
