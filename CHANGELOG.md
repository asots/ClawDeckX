# v0.0.23

_2026-03-22_

## What's Changed

### ✨ New Features / 新功能

- add Docker install/manage/mirror support to install scripts

### 🐛 Bug Fixes / 修复

- set explicit network name and auto-show logs after install
- hide console window for all exec.Command calls on Windows
- use logs --tail 50 for credential viewing hint
- increase first-run gateway wait to 120s with progress
- improve install mode text and fix duplicate Docker ready message
- add login credential hint after Docker install
- improve first-run password visibility in Docker logs
- code block copy button and auto-scroll on tool calls

### 🎨 UI & Styling / 界面优化

- remove green checkmark badge from chat welcome screen

---
**Full Changelog**: [v0.0.22...v0.0.23](https://github.com/ClawDeckX/ClawDeckX/compare/v0.0.22...v0.0.23)



---

# v0.0.22

_2026-03-21_

## What's Changed

### ✨ New Features / 新功能

- add required credential validation to channel wizard

### 🐛 Bug Fixes / 修复

- stop deleting runtime .md files from OpenClaw package
- auto-reset run phase after error and stuck detection
- enhance chat error display with HTTP status hints
- split provider/model in session model switch for correct local display
- auto-set supportsUsageInStreaming for custom openai-completions providers

---
**Full Changelog**: [v0.0.21...v0.0.22](https://github.com/ClawDeckX/ClawDeckX/compare/v0.0.21...v0.0.22)



---

# v0.0.21

_2026-03-20_

## What's Changed

### ✨ New Features / 新功能

- smart provider test with API type auto-detection
- change default startup window from dashboard to none
- show channel display names in Gateway Monitor channel list
- show theme input in create dialog and persist via config.patch
- add model/default/theme to create/edit dialog
- prefill defaults in create dialog and model dropdown in edit

### 🐛 Bug Fixes / 修复

- sync arm64 docker smoke test and fix Dockerfile.prebuilt drift
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



---

# v0.0.20

_2026-03-19_

## What's Changed

### ✨ New Features / 新功能

- add JSON semantic diff with key-path changes summary
- add unified diff view with color-coded add/remove lines
- add OpenClaw native backup integration with method selector
- add Config History tab for OpenClaw .bak file management
- CLI version detection, upgrade prompts, real-time search

### 🐛 Bug Fixes / 修复

- use whole-line grep and trailer-style Docker-Build marker
- change skip-docker marker to SKIP_DOCKER=true to avoid changelog false match
- use GitHub API instead of checkout to read tag message in check-docker job
- suppress GORM record-not-found log for missing settings

### ⚡ Performance / 性能优化

- optimize ClawHub real-time search with 500ms debounce

### 🎨 UI & Styling / 界面优化

- unify stats order and icons in ClawHub/SkillHub cards and details

### 🌐 Internationalization / 国际化

- add Run Now button locale keys for all 13 languages

### ♻️ Refactoring / 重构

- route ClawHub search and detail via Convex HTTP actions

### 📦 Build & Deploy / 构建部署

- invert Docker flag - default skip, -d enables Docker build
- add -d alias for -NoDocker shorthand
- add -NoDocker flag to skip Docker builds via [skip-docker] tag marker

---
**Full Changelog**: [v0.0.19...v0.0.20](https://github.com/ClawDeckX/ClawDeckX/compare/v0.0.19...v0.0.20)



---

# v0.0.19

_2026-03-19_

## What's Changed

### ✨ New Features / 新功能

- show Docker volume mount paths in setup wizard
- add persistent runtime update overlay

### 🐛 Bug Fixes / 修复

- show all sessions instead of only last 24h active
- make memory card clickable to navigate to editor config
- remove unused react-shiki that crashes Sessions window
- display actual GitHub release tag for recovery releases
- show CLI install banner on every visit when not installed
- add missing dark mode variants across windows, remove duplicate SourceConfigModal
- allow description click to bubble for detail modal
- streamline skillhub remote flow
- sanitize skillhub config and docs
- allow longer first gateway startup

### 🎨 UI & Styling / 界面优化

- increase font sizes in KPI dashboard and session cards
- batch theme and layout refinements across windows
- add light mode theme support to Events, Channels, Service, Debug panels
- card grid for tools catalog, card-click detail for plugins
- card-click opens detail, remove detail buttons, card-style capabilities
- unify skillhub and plugin center UI patterns

### 🌐 Internationalization / 国际化

- add topConsumers key to all 13 locales
- add missing logout and sort keys across 10 locales

---
**Full Changelog**: [v0.0.18...v0.0.19](https://github.com/ClawDeckX/ClawDeckX/compare/v0.0.18...v0.0.19)



---

# v0.0.18

_2026-03-18_

## What's Changed

### ✨ New Features / 新功能

- install clawhub and skillhub by default

### 🐛 Bug Fixes / 修复

- use official skillhub cli installer

---
**Full Changelog**: [v0.0.17...v0.0.18](https://github.com/ClawDeckX/ClawDeckX/compare/v0.0.17...v0.0.18)



---

# v0.0.17

_2026-03-18_

## What's Changed

### ✨ New Features / 新功能

- add wallpaper handler
- improve wallpaper and settings experience
- add wallpaper source selection with random/Picsum/Unsplash options and enlarge preview
- update Docker onboarding and setup flows
- add window controls position and desktop wallpaper preferences
- render scope tags from uiHints in SchemaField badges
- add dedicated UI for media retention, talk silence, APNs relay
- show Docker-managed status in Settings service panel
- add entrypoint script for OpenClaw gateway auto-start
- inline model picker on UsagePanel with direct patching
- clickable model card in UsagePanel to open session settings
- Escape key to abort run, dismiss btw, add Esc hint
- display btw/side-result inline messages from gateway
- fun waiting phrases, sending-waiting-streaming flow, reconnect toast
- add live tool streaming, fast mode override, and enhanced run phases
- add imageModel selector in models section with i18n

### 🐛 Bug Fixes / 修复

- replace openclaw onboard with minimal config write
- move app port to 18788
- accept generated config
- wait for docker health
- bootstrap openclaw config
- enable tini subreaper mode
- stabilize bundled openclaw runtime
- improve plugin and wallpaper handling
- use runtime plugin ids in plugin center
- correct wallpaper controls behavior
- correct wallpaper controls behavior
- make ClawHub and SkillHub URLs configurable
- stabilize window namespace hook deps
- break session list refresh loop by using silent polls and stable deps
- debounce gwReady to prevent chat unmount on brief connectivity blips
- suppress sidebar refresh flicker by making background polls silent
- stabilize session list by preventing unnecessary re-renders from polling and i18n deps
- stop session list flickering caused by i18n dep in WS effect
- allow wallpaper fetch through CSP and use img element loading
- add OpenClaw persistence, log rotation, network isolation, and startup diagnostics
- session rename not persisting after switching sessions
- sync session metadata more eagerly
- smooth sessions sidebar loading
- reduce sessions race conditions
- harden sessions markdown and history loading
- preserve pending tab navigation on window open
- correct schema paths for media.ttlHours and gateway.push.apns.relay
- tooltip fallback per-key instead of per-language
- cancel pending RAF on stream clear to prevent duplicate messages
- prevent duplicate messages from re-broadcast events
- preserve usage/cost/model metadata from streaming events
- stop leaking JWT token in WebSocket URL console errors
- use react-shiki plug-and-play import to prevent crash
- prevent duplicate messages during streaming via ref-based dedup guard

### ⚡ Performance / 性能优化

- stabilize i18n and gwReady deps across Sessions, Agents, Skills
- smooth session switching transitions

### 🌐 Internationalization / 国际化

- add missing wallpaper alt locale keys
- fix missing keys in tooltips, cm_set, and cm_sk across locales
- add Chinese tooltips for new config keys
- localize waiting phrases across 13 locales
- revise capability limit text to warn about risks

### ♻️ Refactoring / 重构

- unify default port to 18788 across codebase
- rename openclaw volume
- separate runtime from builder
- use fixed bundled openclaw path
- extract shared utilities for time, polling, errors, storage, and skeletons
- unify gateway status polling with shared hook
- replace service install buttons with Settings link

### 📦 Build & Deploy / 构建部署

- upgrade release action
- upgrade upload artifact action
- improve runtime tooling and release checks
- add TZ default, STOPSIGNAL, OCI labels, resource limits, and .dockerignore
- switch to Ubuntu 22.04 with Node.js 22 and OpenClaw support

### 📝 Documentation / 文档

- update Docker section with accurate volume and env details
- expand Docker section with ports, env vars, volumes, and resource limits

---
**Full Changelog**: [v0.0.16...v0.0.17](https://github.com/ClawDeckX/ClawDeckX/compare/v0.0.16...v0.0.17)



---

# v0.0.16

_2026-03-15_

## What's Changed

### ✨ New Features / 新功能

- add doctor health checks, snapshot import, and API extensions
- add model vision capability config, drag-drop images, usage panel improvements
- auto-select first session on initial load when default has no messages
- add model, stopReason and rich metadata badges to chat messages
- show per-message token/cost badges and improve empty tool output display
- beautify chat sidebar with chart visuals and fix streaming status stuck
- per-session usage cards with chart-based KPI dashboard visuals
- enrich activity monitor with aggregate usage data from sessions.usage API
- enrich usage panel with full session data from sessions.usage API
- replace model override text input with dropdown from config
- Add ToolsCatalog component and market locale files, update skill locales

### 🐛 Bug Fixes / 修复

- add image input capability to default model config in wizard and installer
- fix image sending protocol and preserve images across history reloads
- send raw base64 in attachments and preserve images across history reloads
- resolve duplicate messages and stuck streaming via improved dedup and reconciliation
- raise body size limit to 20 MB and fix image attachment base64 prefix
- add tooltip to CustomSelect for truncated option labels
- robust 3-layer uninstall with force-remove fallback and Windows npm fix
- fall back to npm uninstall when openclaw CLI is broken
- enforce Node >= 22.16 in installer and update Dockerfile to node:22-alpine
- add Node 22.x minor version check in environment scanner
- detect Node version too old and show clear upgrade prompt
- add timeout to model/channel connection test requests
- smart npm mirror fallback retry and accurate speed test
- add config.apply retry with baseHash and improve error handling

### ⚡ Performance / 性能优化

- prioritize chat history loading over sessions list refresh

### 🎨 UI & Styling / 界面优化

- remove duplicate model name from top bar and show time in duration
- merge session stats into context row in usage sidebar
- fix gateway log area layout and tab text wrapping
- add sci-tech theme and modernize all window components

### 🌐 Internationalization / 国际化

- add usage panel keys for tools, duration, models across all 13 locales
- fill missing locale keys across all 13 locales (1784 keys)

### ♻️ Refactoring / 重构

- clean up gateway WebSocket client debug code
- move session info to right sidebar panel for better space usage

### 📦 Build & Deploy / 构建部署

- add CI workflow, i18n checker, and clean up unused files
- pin Node base image to 22.16-alpine

### 📝 Documentation / 文档

- update pull request template

### 🔧 Maintenance / 维护

- bump openclawCompat to >=2026.3.12

---
**Full Changelog**: [v0.0.15...v0.0.16](https://github.com/ClawDeckX/ClawDeckX/compare/v0.0.15...v0.0.16)



---





























