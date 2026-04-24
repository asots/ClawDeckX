package agentroom

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"ClawDeckX/internal/logger"
)

// Projector 把房间消息投影到外部 IM 频道（R-20：DeckX 自建 HTTP 出站，不走上游扩展）。
//
// 设计：
//   - 每个 ProjectionTarget 配置一个出站 Webhook URL
//   - 当房间的 projection.enabled = true 时，orchestrator 在消息入库后调用 Forward
//   - 回传由外部 IM 的 webhook 打到 DeckX 的 /api/v1/agentroom/projection/inbound（未来功能）
//
// MVP：仅实现 outbound 骨架，真实的 IM 适配（Telegram/Discord/Slack/WeCom）留待后续。
type Projector struct {
	hook func(platform, channelID string) string // platform+channelID → webhook URL
	cli  *http.Client
}

func NewProjector(hook func(platform, channelID string) string) *Projector {
	return &Projector{
		hook: hook,
		cli:  &http.Client{Timeout: 8 * time.Second},
	}
}

// ForwardMessage 把一条消息向目标广播。
func (p *Projector) ForwardMessage(ctx context.Context, proj *RoomProjection, roomTitle, authorName, content string) {
	if p == nil || proj == nil || !proj.Enabled {
		return
	}
	for _, tgt := range proj.Targets {
		url := ""
		if p.hook != nil {
			url = p.hook(tgt.Platform, tgt.ChannelID)
		}
		if url == "" {
			continue
		}
		payload := map[string]any{
			"platform":  tgt.Platform,
			"channelId": tgt.ChannelID,
			"roomTitle": roomTitle,
			"author":    authorName,
			"content":   content,
			"style":     proj.Style,
			"at":        NowMs(),
		}
		go p.post(ctx, url, payload, tgt.Platform)
	}
}

func (p *Projector) post(ctx context.Context, url string, payload any, platform string) {
	body, _ := json.Marshal(payload)
	tctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(tctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		logger.Log.Warn().Err(err).Str("platform", platform).Msg("agentroom: projection request build failed")
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := p.cli.Do(req)
	if err != nil {
		logger.Log.Warn().Err(err).Str("platform", platform).Msg("agentroom: projection request failed")
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		logger.Log.Warn().
			Int("status", resp.StatusCode).
			Str("platform", platform).
			Msg("agentroom: projection target returned error")
	}
}

// FormatNarrator 把一条消息格式化成叙述式投影文本（防止 agent 名字暴露用户身份）。
func FormatNarrator(author, content string) string {
	if author == "" {
		return content
	}
	return fmt.Sprintf("[%s] %s", author, content)
}
