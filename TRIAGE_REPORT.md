# Triage Report for duolahypercho/codex-router

## Summary
- **30 Open PRs** (3 drafts)
- **6 Open Issues**
- **Repository**: External-model router for Codex with guided Kimi OAuth/API, DeepSeek, safe migration, and rollback
- **Main Branch**: main
- **Authorized Actions**: Merges, review comments, fixes

## Pull Requests

### Dependency Updates (High Priority - Safe to Merge)
- [ ] #1194: chore(deps): bump stream-json from 3.8.0 to 3.9.0
- [ ] #1197: chore(deps): bump Homebrew/actions/setup-homebrew
- [ ] #1198: chore(deps-dev): bump playwright from 1.65.0 to 1.65.1
- [ ] #1199: chore(deps): bump undici from 8.12.4 to 8.13.0
- [ ] #1114: chore(deps): bump the pip group (LARGE - review carefully)

### Bug Fixes
- [ ] #1127: fix: keep damaged provider policy from enabling routes
- [ ] #1128: fix: preserve discovery opt-out at credential reader boundaries
- [ ] #1141: fix: preserve client terminal and cancellation evidence
- [ ] #1144: fix: preserve received HTTP responses without automatic replay
- [ ] #1177: fix: recover desktop page results that have no call id
- [ ] #1183: test: cover tool-search completion and usage through the router
- [ ] #1187: Deduplicate tool screenshots in Responses WebSocket turns
- [ ] #1188: fix(anthropic): handle Claude 5.5 assistant prefills
- [ ] #1192: Clarify native Responses errors near context limits
- [ ] #1193: fix(native): bound zstd window to prevent image-history HTTP 400s

### Features / Provider Additions
- [ ] #1021: feat: add opt-in ChatGPT account balancing and quota failover
- [ ] #1068: ci: allow manual runtime verification without Homebrew source install
- [ ] #1089: feat(providers): add Cheaper Inference as a catalog-only provider
- [ ] #1096: feat(providers): add Obscurify.ai as a catalog-only provider
- [ ] #1097: feat(providers): add Runcrate as a catalog-only provider
- [ ] #1115: test: isolate homes and host Keychain before runtime imports
- [ ] #1178: feat(providers): add Standard Compute as a catalog-only provider
- [ ] #1186: Sync OpenCode Go models from live catalog
- [ ] #1191: feat(providers): add AbliteratedLLM as a catalog-only provider

### Refactoring
- [ ] #1119: refactor: use durable Antigravity project context
- [ ] #1132: refactor: read each image once with the selected engine
- [ ] #1135: refactor: remove inferred subagent interrupt injection

### Draft PRs (Lower Priority)
- [ ] #1033 [DRAFT]: fix(router): preserve local GLM reasoning effort
- [ ] #1184 [DRAFT]: 修复 Responses WebSocket 丢失上游拒绝原因
- [ ] #1196 [DRAFT]: docs: link the trilingual documentation site from the READMEs

## Issues

### Bugs (High Priority)
- [ ] #1175: tray uninstall fails with "task exists or is unreadable"
- [ ] #1176: install.ps1 deletes itself after installing Codex CLI
- [ ] #1185: Command Code DeepSeek V4.1 Flash repeatedly auto-compacts
- [ ] #1189: Collaboration v2 threads fail with 400 invalid_responses_request
- [ ] #1195: Tray update fails with "npm is required but was not found on PATH"

### Roadmap
- [ ] #1099: Search sidecar: Keenable as an opt-in second adapter (roadmap P07)

## Progress Log
