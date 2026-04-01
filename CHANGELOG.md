# v0.0.38

_2026-04-01_

## What's Changed

### ✨ New Features / 新功能

- enrich multi-agent soulSnippets and render persona examples in UI

### 🐛 Bug Fixes / 修复

- disable test send when config has unsaved changes
- harden watchdog and notify flows

### 🌐 Internationalization / 国际化

- add stepIdentity/stepScenarios/stepMemory tab labels for all 13 locales
- add category label keys for all 13 locales

---
**Full Changelog**: [v0.0.37...v0.0.38](https://github.com/ClawDeckX/ClawDeckX/compare/v0.0.37...v0.0.38)



---

# v0.0.37

_2026-03-31_

## What's Changed

### ✨ New Features / 新功能

- add generation mode toggle (agent session vs direct LLM)
- bypass agent session with direct LLM streaming via llmdirect
- async AI team generation with background task + WS push
- add AI team generation and scenario builder

### 🐛 Bug Fixes / 修复

- two-step direct LLM generation to avoid max_tokens truncation
- resolve connectLoop storm and invalid-handshake on restart

---
**Full Changelog**: [v0.0.36...v0.0.37](https://github.com/ClawDeckX/ClawDeckX/compare/v0.0.36...v0.0.37)



---

# v0.0.36

_2026-03-30_

## What's Changed

### 🐛 Bug Fixes / 修复

- preload device pairing counts
- refresh history token on auth failure
- make code block copy button reliably clickable
- keep code block copy button visible during copied/failed feedback
- add 3-attempt retry for ClawHub and SkillHub CLI install
- add git push retry logic with 3 attempts and exit on failure

### 📦 Build & Deploy / 构建部署

- optimize arm64 smoke test for QEMU slowness
- replace softprops/action-gh-release with gh CLI

---
**Full Changelog**: [v0.0.35...v0.0.36](https://github.com/ClawDeckX/ClawDeckX/compare/v0.0.35...v0.0.36)



---

# v0.0.35

_2026-03-30_

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



---

# v0.0.34

_2026-03-29_

## What's Changed

### ✨ New Features / 新功能

- handle context_compaction events and includeSpawned
- sync with openclaw v2026.3.28
- add MCP handler, mirror config, McpCenter UI and settings

### 🐛 Bug Fixes / 修复

- relax SKILL.md path validation, expand editor modal, add resize
- remove save button from mirror settings, make prefs sections collapsible
- resolve api key for model discovery

### 🌐 Internationalization / 国际化

- add mirror and mcp test keys to all 11 non-en locales

---
**Full Changelog**: [v0.0.33...v0.0.34](https://github.com/ClawDeckX/ClawDeckX/compare/v0.0.33...v0.0.34)



---

# v0.0.33

_2026-03-27_

## What's Changed

### 🐛 Bug Fixes / 修复

- route recipe install through gateway RPC
- ignore cached URL translations
- reject garbage translations containing URLs for skill names
- use clipboard fallback for context menu copy in Sessions
- use clipboard fallback for code block copy in non-HTTPS context

### 🎨 UI & Styling / 界面优化

- move tool policy above model picker in UsagePanel

### 🌐 Internationalization / 国际化

- add secProfile tool strategy labels for all 13 locales

---
**Full Changelog**: [v0.0.32...v0.0.33](https://github.com/ClawDeckX/ClawDeckX/compare/v0.0.32...v0.0.33)



---

# v0.0.32

_2026-03-27_

## What's Changed

### 🐛 Bug Fixes / 修复

- hide snapshot toolbar on config-history tab
- backup dir outside state path, radio scope, notify reorder, i18n ON/OFF

### 🌐 Internationalization / 国际化

- rename ocBackupFull to Standard backup for clarity

### 📦 Build & Deploy / 构建部署

- upgrade Node.js from 22 to 24

---
**Full Changelog**: [v0.0.31...v0.0.32](https://github.com/ClawDeckX/ClawDeckX/compare/v0.0.31...v0.0.32)



---

# v0.0.31

_2026-03-27_

## What's Changed

### ✨ New Features / 新功能

- usage panel UX overhaul with expandable models, session filters, and enhanced metrics
- security config navigation, channel policy editor, collapsible tool pickers, i18n

### 🌐 Internationalization / 国际化

- remove 1054 unused keys per locale across 13 languages

---
**Full Changelog**: [v0.0.30...v0.0.31](https://github.com/ClawDeckX/ClawDeckX/compare/v0.0.30...v0.0.31)



---

# v0.0.30

_2026-03-26_

## What's Changed

### ✨ New Features / 新功能

- fallback to model config contextWindow when gateway maxContextTokens is 0
- collapsible KPI dashboard in Activity page with i18n
- show agent name badge in session sidebar before kind badge
- enhance Activity KPI dashboard and session cards with missing data
- enhance UsagePanel with full session data visualization
- scope new session to selected agent filter
- buffered save for A2A and subagents, cleanup on delete
- add paginated session history endpoint

### 🐛 Bug Fixes / 修复

- correct A2A empty list defaults and toggle behavior
- resolve agent list clobbering and display name improvements
- render CustomSelect dropdown via portal to prevent clipping
- unified safePatch/safeApply with auto hash refresh and retry
- agent create shows default workspace path in Docker and validates empty workspace

### ⚡ Performance / 性能优化

- add 15s getCached TTL to sessionsUsage and usageCost endpoints
- add 30s in-memory cache to UsagePanel data loading

### 🎨 UI & Styling / 界面优化

- hide wildcard * chips in allowed agents and subagents lists
- group agent and kind badges together in session sidebar

### 🌐 Internationalization / 国际化

- add editSession key to all 13 locales
- add agent and chat locale keys for all 13 locales

### ♻️ Refactoring / 重构

- remove agent info and kind chip from UsagePanel (shown in sidebar)

---
**Full Changelog**: [v0.0.29...v0.0.30](https://github.com/ClawDeckX/ClawDeckX/compare/v0.0.29...v0.0.30)



---

# v0.0.29

_2026-03-25_

## What's Changed

### ✨ New Features / 新功能

- add editable combobox to plugin allow/deny fields
- auto-manage plugins.allow on install and uninstall
- add PATH registration for installers and streaming improvements
- add workspace memory logs API and UI

### 🐛 Bug Fixes / 修复

- reload page after Docker runtime update to show new version
- correct required credential validation for all channels
- preserve partial stream on error and suppress error during active streaming

---
**Full Changelog**: [v0.0.28...v0.0.29](https://github.com/ClawDeckX/ClawDeckX/compare/v0.0.28...v0.0.29)



---

# v0.0.28

_2026-03-25_

## What's Changed

### ✨ New Features / 新功能

- schema-aware tooltips with auto-fallback and range/enum display
- unified OpenClaw binary discovery across all platforms and install methods

### 🐛 Bug Fixes / 修复

- hide MCP from unmapped config section, remove unused tools toggle

### 🎨 UI & Styling / 界面优化

- remove expand/collapse tools button from AI chat menu
- remove TTS speak button from AI chat messages
- optimize AI chat layout and wallpaper toolbar UX
- remove language label from chat code blocks

### 🌐 Internationalization / 国际化

- add missing tooltip keys to all 10 remaining locales
- translate DM to native terms in zh and zh-TW locales

---
**Full Changelog**: [v0.0.27...v0.0.28](https://github.com/ClawDeckX/ClawDeckX/compare/v0.0.27...v0.0.28)



---

# v0.0.27

_2026-03-24_

## What's Changed

### 🐛 Bug Fixes / 修复

- derive cookie name from request Host header for Docker port mapping
- restart with overlay binary after runtime update
- read tokens from multi-account config path in test-channel
- port-specific cookie name to prevent cross-instance collision
- enhance config load diagnostics for JWT secret persistence tracking
- add diagnostic logging for 401 auth failures in middleware
- use correct param name 'key' for sessions.messages RPC
- persist JWT secret across Docker restarts and add diagnostic logging

### 🎨 UI & Styling / 界面优化

- fix model dropdown dark mode contrast

### 🔧 Maintenance / 维护

- bump openclawCompat to >=2026.3.23

---
**Full Changelog**: [v0.0.26...v0.0.27](https://github.com/ClawDeckX/ClawDeckX/compare/v0.0.26...v0.0.27)



---

# v0.0.26

_2026-03-24_

## What's Changed

### ✨ New Features / 新功能

- register gateway stale/restart keys and add MCP Servers editor
- add subscription convergence, TTS speak, and send timeout recovery
- show gateway presence on nodes page
- add skills.install and system-presence RPC wrappers
- adapt to openclaw v2026.3.14 API changes
- add openclaw-weixin channel integration with QR login
- multi-account UI with auto-migration and styled forms
- add CLI fix fallback for doctor one-click repair button

### 🐛 Bug Fixes / 修复

- harden runtime apt install in prebuilt image
- decouple docker install version from compat
- add builder diagnostics for prebuilt image
- remove openclaw-cn compat and harden binary detection
- move QR login to post-save step in wizard flow
- align editor sections with upstream openclaw config schema
- bypass GitHub API rate limit with direct URL download
- fallback to direct pull when mirror image pull fails

### ♻️ Refactoring / 重构

- always use CLI fix for doctor one-click repair

### 📝 Documentation / 文档

- add note about quoting passwords with special characters
- add account lockout policy and prominent mirror warnings

---
**Full Changelog**: [v0.0.25...v0.0.26](https://github.com/ClawDeckX/ClawDeckX/compare/v0.0.25...v0.0.26)



---

# v0.0.25

_2026-03-23_

## What's Changed

### 🐛 Bug Fixes / 修复

- scroll wizard into view on step change in add provider flow
- remove invalid redact param from config.get RPC calls
- increase health check wait to 150s for first-boot gateway startup
- show host volume paths instead of container-internal paths
- remove duplicate admin credentials output from startup banner

---
**Full Changelog**: [v0.0.24...v0.0.25](https://github.com/ClawDeckX/ClawDeckX/compare/v0.0.24...v0.0.25)



---

# v0.0.24

_2026-03-23_

## What's Changed

### ✨ New Features / 新功能

- add firewall port reminder in access URL output
- show LAN and public IP in post-install access URLs
- smart auto-detect next available instance name for multi-deploy
- support multiple Docker deployments in installer scripts
- smart port detection for Docker and binary installs
- change default port from 18788 to 18800 to avoid OpenClaw range
- unified adaptive menu for coexisting Docker and binary installs

### 🐛 Bug Fixes / 修复

- standardize internal port to 18788, Docker host port to 18700
- unified rpc retry for gateway transient disconnects
- retry hash refresh after gateway reload to prevent stale hash
- update Dockerfile.prebuilt port from 18788 to 18800
- show correct host port in container banner via OCD_HOST_PORT
- comprehensive audit fixes for reliability and compatibility
- auto-add openclaw user to docker group for cross-account access

### 🎨 UI & Styling / 界面优化

- replace technical Binary/������ labels with ClawDeckX

### 📝 Documentation / 文档

- update README to reflect unified installer for Docker

---
**Full Changelog**: [v0.0.23...v0.0.24](https://github.com/ClawDeckX/ClawDeckX/compare/v0.0.23...v0.0.24)



---

# v0.0.23

_2026-03-22_

## What's Changed

### ✨ New Features / 新功能

- enable wallpaper image by default for new users
- add Docker install/manage/mirror support to install scripts

### 🐛 Bug Fixes / 修复

- show user-configured model count instead of total gateway models
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



























































