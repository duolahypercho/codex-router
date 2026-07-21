# Changelog

## Unreleased

- Added a credential-isolated Anthropic API provider with Claude Opus 4.8 in
  the Codex picker, native Anthropic Messages forwarding, secure key setup,
  tray controls, and a real LiteLLM-to-mock-Anthropic Codex integration test.
- Added the macOS menu-bar control panel, all-provider usage grid, and optional
  Dynamic-Island-style activity overlay with secure provider onboarding.
- Added the isolated Cursor target and corrected its PowerShell installer path.
- Fixed partial startup failures so already-running forwarders are terminated,
  and isolated all six ports in the real LiteLLM integration test.
- Grok OAuth account usage now reads weekly/monthly credit limits from the official Grok CLI billing endpoint.
- Rewrote routed-model catalog identity text so external models no longer
  claim to be based on GPT-5 in Codex `base_instructions`.
- Added an isolated, experimental Claude Desktop target using the official
  third-party gateway contract: authenticated Anthropic Messages routing,
  streaming, explicit model lists, and preserved tool/image message payloads.
- Added reversible per-user Claude configuration management, separate ports,
  state, caller keys, provider selection, and background-service identities so
  Codex and Claude can be installed from one checkout without configuration
  overlap.
- Added the cross-target `model-router` command, Claude guided setup, doctor,
  smoke test, agent installation guidance, and dedicated compatibility docs.
- Hardened local caller authentication with a separate per-install capability,
  exact internal-key checks, authenticated credential-detail health endpoints,
  browser-request rejection, and fail-closed routing before request bodies or
  provider quota are touched.
- Protected Codex config and all config snapshots for the current user, and
  redacted the caller capability from status, migration, and support output.
- Replaced raw exception text in HTTP responses and service logs with bounded,
  non-sensitive errors.
- Fixed Windows private-file ACL grants for numeric user SIDs and corrected
  router-status detection for escaped Windows catalog paths.

## 0.3.0

- Added guided, provider-aware setup for Kimi OAuth, Kimi API, and DeepSeek API.
- Added safe detection, snapshots, automatic migration, and exact rollback for
  the two recognized earlier Kimi router layouts.
- Added macOS launchd, Linux systemd-user, and Windows Task Scheduler services,
  plus a native PowerShell installer and command wrapper.
- Added provider visibility and runtime enforcement so hidden external models
  cannot be mistaken for native models.
- Added `doctor --fix`, privacy-safe support bundles, update rollback, guarded
  provider model discovery, and billed compatibility tests.
- Added cross-platform CI, dependency audits, tagged source archives, SHA-256
  checksums, and GitHub build-provenance attestations.
- Expanded zero-knowledge onboarding, installation, security, troubleshooting,
  and future-provider documentation.

## 0.2.0

- Generalized the original Kimi-only prototype into a validated provider/model
  registry.
- Added separate Kimi OAuth, Kimi API, and DeepSeek API routes while preserving
  native Codex models and ChatGPT authentication.
