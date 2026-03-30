## What's Changed

### ✨ New Features / 新功能

- add confirm step before saving SKILL.md to prevent accidental overwrites
- add JSON edit tab to server editor, move mcp-remote button above extra JSON
- add mcp-remote bridge conversion button for SSE servers
- add headers editor for SSE servers in McpCenter form

### 🐛 Bug Fixes / 修复

- remove UTF-8 BOM from all cm_sk.json locale files
- use inline borderColor style to override theme-field border on JSON error
- validate JSON on every keystroke and highlight textarea border on error
- keep stdio stdin open for mcp-remote proxies, extend test timeout to 20s
- restrict attachments to images only, matching openclaw gateway behavior
- handle baseUrl-only single server and streamable-http type in JSON paste
- recognize baseUrl field and forward headers for HTTP servers

### 📦 Build & Deploy / 构建部署

- upgrade upload-artifact and download-artifact to v6 (Node.js 24)

---
**Full Changelog**: [v0.0.34...v0.0.35](https://github.com/ClawDeckX/ClawDeckX/compare/v0.0.34...v0.0.35)


