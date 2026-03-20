## What's Changed

### ✨ New Features / 新功能

- smart provider test with API type auto-detection
- change default startup window from dashboard to none
- show channel display names in Gateway Monitor channel list
- show theme input in create dialog and persist via config.patch
- add model/default/theme to create/edit dialog
- prefill defaults in create dialog and model dropdown in edit

### 🐛 Bug Fixes / 修复

- add toast feedback to Resolve and Compact session actions
- prevent model switch revert after loadSessions refresh
- sync wallpaper history selection
- persist emoji via config.patch identity.emoji instead of agents.update
- resolve template icon colors in KnowledgeHub, TemplateManager, WorkflowRunner, Market, UsageWizard
- resolve scenario template icon colors via inline styles
- resolve template icon colors via inline styles for Tailwind JIT compat
- use correct config nesting fallback in resolveAgentConfig
- simplify config.patch to minimal agent entry merge
- persist model/workspace via config.patch instead of agents.update
- reload config after create/update to reflect changes
- prefer explicit config name over identity name in sidebar
- replace missing Material Symbols icons in multi-agent templates
- handle nested config structure for models and workspace
- increase first-start gateway wait time to 60s

### ⚡ Performance / 性能优化

- optimize WS reconnect, streaming, and chat UX
- optimize GWClient reconnect and WSHub backpressure handling

### 🎨 UI & Styling / 界面优化

- collapse session toolbar into overflow menu

---
**Full Changelog**: [v0.0.20...v0.0.21](https://github.com/ClawDeckX/ClawDeckX/compare/v0.0.20...v0.0.21)


