## What's Changed

### ✨ New Features / 新功能

- add JSON semantic diff with key-path changes summary
- add unified diff view with color-coded add/remove lines
- add OpenClaw native backup integration with method selector
- add Config History tab for OpenClaw .bak file management
- CLI version detection, upgrade prompts, real-time search

### 🐛 Bug Fixes / 修复

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


