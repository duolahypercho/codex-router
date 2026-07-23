# Changelog

## Unreleased

- Service startup failures now include the underlying bounded, non-sensitive
  error message (for example which health check timed out or which service
  exited early) instead of a generic failure line.
- Canceling a generation (or any client disconnect mid-request) no longer
  flips router health into the eight-second error state, so tray and island
  status indicators stop flashing red on ordinary cancels. Errors the router
  or an upstream actually produced still surface.
- The hidden API-key prompt now confirms how many characters were captured
  after each entry, challenges input that looks like the same key pasted
  twice before saving, and re-prompts instead of failing on empty input, so a
  paste with terminal echo disabled is no longer a silent leap of faith.
- Added a Qwen provider (`qwen-plan`) for Alibaba Model Studio Token and
  Coding Plan subscriptions with Qwen3.7 Max and Qwen3.7 Plus picker models,
  defaulting to the Singapore Token Plan endpoint with an environment override
  for other regions or plans.
- Added a reversible tray toggle that lets signed-out Codex CLI/App sessions
  use connected external providers through a managed custom model provider,
  while preserving ChatGPT credentials and restoring the prior provider mode.
- The macOS login-free toggle now gracefully restarts the registered Codex app
  after applying or restoring its model-provider mode.
- Grok OAuth injects bare hosted `web_search` and `x_search` tools so xAI can
  run server-side realtime search agentically, matching Grok Build. Router-side
  search env filters and request search-parameter mapping were removed.
- Use Thinking Orbs `Shaping` while idle, `Thinking` while generating, and
  `Solving` for the Island's error indicator.
- Replace compact provider names with the providers' published marks and Codex
  session titles, add a plain `+N` concurrent-session indicator, and show dark
  hover rows with live status, elapsed time, daily usage, and ping-pong overflow
  for long titles.
- Added a native Windows and Linux tray companion with a seven-day token graph,
  connected-provider quota cards, secure onboarding, an animated top-center
  activity pill on Windows/X11, and an explicit tray-only Wayland fallback.
- Balanced the Dynamic Island with an animated status dot and slow idle
  heartbeat, a clearer localized pulse and edge comet during generation, and a
  one-shot line-chart draw while preserving Reduce Motion behavior.
- Restored the Dynamic Island's daily line graph with today's token total and
  provider quota percentage, while leaving longer-range controls in the tray.
- Hide tray usage cards until the corresponding OAuth session or API key is
  configured; enabled providers and historical local traffic no longer create
  disconnected-account cards.
- Cleaned up tray quota cards so each window has one standardized limit label
  and one reset line, with five-hour windows shown separately from weekly
  limits in both current and all-provider usage.
- Fixed All usage cards so local traffic with request counts no longer shows
  "No use", and local-only providers show "Local router traffic" instead of
  "No reset reported".
- Surface concurrent Codex model requests on the Dynamic Island: active count,
  multi-provider compact labels, and live request rows with elapsed time.
- Added a credential-isolated Anthropic API provider with Claude Opus 4.8 in
  the Codex picker, native Anthropic Messages forwarding, secure key setup,
  tray controls, and a real LiteLLM-to-mock-Anthropic Codex integration test.
- Added the macOS menu-bar control panel, all-provider usage grid, and optional
  Dynamic-Island-style activity overlay with secure provider onboarding.
- Made tray usage selection account-aware, added quota reset times to provider
  cards, and kept Kimi and Grok OAuth sessions fresh during usage polling and
  routed requests.
- Made macOS service reinstalls wait for launchd to finish unloading and use an
  in-place restart, preventing transient bootstrap status-5 failures.
- Serialized background-service changes and added bounded readiness checks so
  repairs cannot overlap or report failure while a healthy router is starting.
- Added a 30-second `Starting` grace state to the macOS tray so routine router
  recovery does not appear as an immediate failure.
- Added the isolated Cursor target and corrected its PowerShell installer path.
- Removed the experimental Claude Desktop router target while retaining the
  direct, credential-isolated Anthropic API provider for Codex and Cursor.
- Fixed partial startup failures so already-running forwarders are terminated,
  and isolated all six ports in the real LiteLLM integration test.
- Grok OAuth account usage now reads weekly/monthly credit limits from the official Grok CLI billing endpoint.
- Rewrote routed-model catalog identity text so external models no longer
  claim to be based on GPT-5 in Codex `base_instructions`.
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
