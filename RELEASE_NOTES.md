## What's Changed

### ✨ New Features / 新功能

- persistent snippets, local sysinfo, Windows ConPTY, i18n
- add container/local file browser for native PTY shell
- add native PTY local/container shell (bypass SSH)
- add QR login via direct iLink API, bypassing plugin's missing web.login.start

### 🐛 Bug Fixes / 修复

- rename qqPrep/qqPitfall/qqHelpUrl to qqbotPrep/qqbotPitfall/qqbotHelpUrl
- sync qqbot config with upstream openclaw, fix channel plugin specs
- smoother plugin install & wizard flow, restore prep/pitfall i18n
- reset ws backoff on user-triggered restart
- local-tab snippets history + commands panel parity
- add channels.status fallback for residue channel plugins
- use plugins.entries fallback instead of unsupported plugins.status RPC

### 🎨 UI & Styling / 界面优化

- unify dmPolicy row styling with other SelectField rows

---
**Full Changelog**: [v0.2.2...v0.2.3](https://github.com/ClawDeckX/ClawDeckX/compare/v0.2.2...v0.2.3)


