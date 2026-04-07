## What's Changed

### ✨ New Features / 新功能

- add scripts for config path migration, test scaffold generator, CI compat gate, and enhanced doc generation
- add config path migration, enhanced doc generation, test scaffold generator, CI compat gate, and schema version drift hook
- add SchemaRemainder component and integrate into all sections
- add 2026.4.5 fields, i18n keys, and section tests
- add global Command Palette with deep-link protocol and runtime hooks
- align editor with OpenClaw v2026.4.4 schema changes
- channel-level toggles and event-based routing

### 🐛 Bug Fixes / 修复

- stabilize new session lifecycle
- guard null template metadata
- refresh update badges after checks
- refresh overview cache after upgrades
- stop running process on uninstall
- resolve [object Object] in command palette for usage window
- exempt translate-notes and config APIs from XSS body check
- add manual translate button for OpenClaw release notes
- move useCallback before early return in SchemaRemainder to fix React error #310
- update notify callback signature in gwclient_test
- use runtime.GOOS for platform and upgrade device auth to v3
- auto select generation model

### 🌐 Internationalization / 国际化

- add update backup prompts

### ✅ Tests / 测试

- add SchemaRemainder regression tests for hook order stability (React #310)
- add unit tests (Vitest) and E2E tests (Playwright)

### 🔧 Maintenance / 维护

- remove CI workflow and untrack gitignored scripts

---
**Full Changelog**: [v0.1.4...v0.1.5](https://github.com/ClawDeckX/ClawDeckX/compare/v0.1.4...v0.1.5)


