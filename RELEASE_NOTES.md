## What's Changed

### ✨ New Features / 新功能

- add background tasks tab, cron event refresh and toast notifications
- auto-generate admin credentials on first run and display after deploy

### 🐛 Bug Fixes / 修复

- handle residue directory via force-reinstall and runtime status check
- prevent double restart and stale config overwrite on plugin install
- restore full log tail for docker first-boot credentials
- remove stray 'local' keyword in top-level Docker scan
- background launch with inline credential display
- auto-restart gateway after OpenClaw upgrade in Docker
- add confirm dialog for Docker restart, toast restart hint after OpenClaw upgrade
- graceful degradation for ModelAuthStatus RPC timeout
- fix ModelAuthStatus i18n path and add translations
- remove entrypoint credential gen, let binary handle first-boot admin

---
**Full Changelog**: [v0.2.1...v0.2.2](https://github.com/ClawDeckX/ClawDeckX/compare/v0.2.1...v0.2.2)


