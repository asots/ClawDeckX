// gw_http.go —— GWClient 的 HTTP 调用助手。
//
// OpenClaw 的少数能力（例如 sessions_spawn 工具）只通过 HTTP `/tools/invoke`
// 暴露而没有对应的 WebSocket RPC（参考 openclaw/src/gateway/tools-invoke-http.ts）。
// 本文件给 GWClient 加一个薄 HTTP 调用入口，复用 cfg.Host/Port/Token，
// 与既有 WS 通道并行存在，不影响重连 / 心跳逻辑。
package openclaw

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

// ToolInvokeRequest 描述对 /tools/invoke 的一次调用。
type ToolInvokeRequest struct {
	Tool       string                 `json:"tool"`
	SessionKey string                 `json:"sessionKey,omitempty"`
	Args       map[string]interface{} `json:"args,omitempty"`
}

// ToolInvokeResponse 是 /tools/invoke 的返回体。
// 成功：{ ok: true, result: <tool 自定义> }；失败：{ ok: false, error: { type, message } }。
type ToolInvokeResponse struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

// ErrToolInvokeUnavailable 在 gateway 配置缺失时返回。
var ErrToolInvokeUnavailable = errors.New("openclaw gateway HTTP not configured")

// InvokeTool 通过 HTTP POST /tools/invoke 调用一个 agent tool。
// timeout <= 0 时使用默认 60s。
func (c *GWClient) InvokeTool(ctx context.Context, req ToolInvokeRequest, timeout time.Duration) (*ToolInvokeResponse, error) {
	if c == nil {
		return nil, ErrToolInvokeUnavailable
	}
	c.mu.Lock()
	host := c.cfg.Host
	port := c.cfg.Port
	token := c.cfg.Token
	c.mu.Unlock()
	if strings.TrimSpace(host) == "" || port <= 0 {
		return nil, ErrToolInvokeUnavailable
	}
	if strings.TrimSpace(req.Tool) == "" {
		return nil, errors.New("InvokeTool: tool required")
	}
	if timeout <= 0 {
		timeout = 60 * time.Second
	}

	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("marshal: %w", err)
	}

	url := fmt.Sprintf("http://%s/tools/invoke", net.JoinHostPort(host, fmt.Sprintf("%d", port)))
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if token != "" {
		httpReq.Header.Set("Authorization", "Bearer "+token)
	}

	client := &http.Client{Timeout: timeout}
	resp, err := client.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("http: %w", err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4*1024*1024))
	if err != nil {
		return nil, fmt.Errorf("read: %w", err)
	}

	var out ToolInvokeResponse
	if jerr := json.Unmarshal(raw, &out); jerr != nil {
		return nil, fmt.Errorf("decode (status=%d): %w; body=%s", resp.StatusCode, jerr, truncate(string(raw), 256))
	}
	if resp.StatusCode >= 400 || !out.OK {
		msg := "tool invoke failed"
		typ := fmt.Sprintf("http_%d", resp.StatusCode)
		if out.Error != nil {
			msg = out.Error.Message
			if out.Error.Type != "" {
				typ = out.Error.Type
			}
		}
		return &out, fmt.Errorf("%s: %s", typ, msg)
	}
	return &out, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
