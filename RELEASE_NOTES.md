## What's Changed

### ✨ New Features / 新功能

- check OpenClaw version before enabling prometheus plugin
- auto-enable diagnostics-prometheus plugin on 404
- integrate Prometheus diagnostics from OpenClaw
- Claude / Hermes one-click importer wizard
- QQBot group chat + Yuanbao 2026.4.27 config

### 🐛 Bug Fixes / 修复

- correct toast argument order (type, message)
- pass baseHash to all config.set calls for concurrency control
- pass baseHash to config.set for optimistic concurrency
- state-driven restart suppression instead of fixed grace timer
- prevent reconnect grace from shortening restart grace period
- poll for plugin readiness instead of fixed 3s wait
- show plugin-not-enabled hint on 404

### ⚡ Performance / 性能优化

- parallelize Scan() and extend gateway start timeout to 180s

### 🎨 UI & Styling / 界面优化

- collapsible scrape config with copyable fields

### 🌐 Internationalization / 国际化

- fix watchdog inactive hint wording

---
**Full Changelog**: [v0.2.5...v0.2.6](https://github.com/ClawDeckX/ClawDeckX/compare/v0.2.5...v0.2.6)


