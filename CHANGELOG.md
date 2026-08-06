# Changelog

## Unreleased

- **Adapted the managed `[agents]` concurrency default to the installed Codex
  build.** Some Codex builds (observed on 0.141-0.145) parse `[agents]` as a
  pure role map and refuse to load any config containing the scalar, which
  broke `codex login status` and `codex doctor` outright. The config manager
  now probes the installed binary with a minimal config before writing the
  scalar and skips it when the build rejects it, so builds that accept the
  scalar keep the concurrency cap and strict builds keep a loadable config.
- **Re-captured the native model catalog when the Codex build changes.** The
  cached capture now records the Codex version that produced it and is
  refreshed from `codex debug models` on mismatch, so a catalog captured by an
  older build no longer feeds missing or stale capability fields (such as
  `supports_reasoning_summaries`) into the merged catalog after an upgrade. If
  the re-capture fails, the router keeps serving the previous capture and says
  so instead of failing the rebuild.

- **Reasoning effort ladders now match each vendor's documentation.** Every
  listed model's picker levels were verified against the provider's official
  API docs: Kimi K3 (API) gains its documented low/high/max ladder instead of
  a forced max; DeepSeek V4 Flash gains its real low tier; Claude Opus 4.8
  gains the full low/medium/high/xhigh/max `output_config.effort` ladder and
  the forwarder now passes the picked effort through instead of hardcoding
  high; GLM-5.2 sends its two documented tiers explicitly (upstream defaults
  to max when the parameter is omitted) and defaults to max as Z.ai
  recommends; GLM-5-Turbo no longer advertises effort control it does not
  support; and the cross-vendor DeepSeek/GLM models resold through the
  Alibaba plan gain the high/max ladder DashScope documents for them.
  Providers whose thinking control is binary or undocumented (Qwen via
  DashScope, Ollama Cloud, MiniMax, MiMo, Kimi K2.x) intentionally keep a
  single level.

- **Curated models now carry user-provided metadata, including reasoning
  efforts.** `bin/curate-models` asks for each new model's context window,
  image support, and reasoning efforts (so curated models get the effort
  switcher in the Codex picker), with `--efforts` available for the
  non-interactive `--models` form. Every value defaults conservatively and
  stays editable in `user-models.json`. No online metadata catalog is
  consulted — the provider's own `/v1/models` endpoint decides which models
  exist, and the metadata is yours.

- **New Meta Model API provider.** The `meta` provider (shown as "Meta API")
  routes the Responses protocol to `https://api.meta.ai/v1` with a stored
  `META_API_KEY`. Three Muse Spark models ship in the registry: 1.2, its
  cheaper 1.2 Contributor tier (whose inputs and outputs Meta may use for
  training), and the previous-generation 1.1 — the 1.2 tiers with reasoning
  summaries enabled. More Meta models can be curated per machine with
  `bin/curate-models meta`.

- **opencode Go is one provider family everywhere.** The
  `opencode-go-messages` and `opencode-go-responses` protocol variants now
  declare `variantOf: "opencode-go"` in the registry, and provider selection
  treats the three as a single unit: enabling or disabling any of them toggles
  the whole family, the selection file stores only `opencode-go`, and every
  read expands it back to all variants. This retroactively fixes installs
  whose selection predates the variants — MiniMax, Qwen, and GPT 5.6 Luna
  models no longer vanish from the Codex picker while the other opencode Go
  models show. Setup, the tray, and `providers list` now show one
  **opencode Go** entry instead of three.

- **Removed the Cursor and opencode app targets.** The router now focuses on
  Codex only: `--target codex` is the sole installer target, the Cursor Chat
  Completions gateway and the opencode config manager/subagent generator are
  gone, and their port blocks (4104-4107, 4116, 4120-4126) are released. The
  opencode Go model subscription is unaffected — it remains a regular provider
  inside Codex. Anyone with a previously installed Cursor or opencode
  integration can remove the old service with that checkout's
  `model-router <target> uninstall` before updating.

- A **Show tray** mode in the macOS tray's Settings tab can tie the menu bar
  icon, Dynamic Island, and desktop panel to the Codex/ChatGPT desktop apps:
  the surfaces appear when either app launches and hide when the last one
  quits, while the tray process stays resident as the watcher. The default
  remains always-visible.

- The macOS tray registers itself as a login item on its first launch, so it
  reopens automatically after a reboot instead of requiring a manual
  `./bin/model-router-tray`. A **Start at login** toggle in the Settings tab
  (backed by `SMAppService`, also visible in System Settings › Login Items)
  controls it, and the automatic registration happens only once — disabling
  the item is never overridden.

- The opencode target now generates one subagent per selected model in
  opencode's config, and refreshes those entries when providers are enabled,
  disabled, or given new keys. `setup`, `doctor`, `status`, `enable`, `disable`,
  and `uninstall` all support `MODEL_ROUTER_TARGET=opencode` through
  `bin/model-router opencode ...`, and the opencode installer works from both
  `install.sh --target opencode` and `install.ps1 -Target opencode`.

- Fixed native OpenAI models disappearing from the Codex picker on Windows when
  the Codex CLI is installed through npm (#46). `where.exe codex` lists the
  extensionless POSIX shim before `codex.cmd`, and Node cannot spawn the former
  without a shell, so every probe threw ENOENT. The router now picks a shim Node
  can execute and runs `.cmd`/`.bat` through a shell with the path quoted.
- A Codex binary that cannot be spawned is no longer reported as a signed-out
  session. That conflation is what let one spawn error silently strip every
  native model from the catalog; the catalog build now refuses to run rather
  than guess, and the doctor reports the probe failure on its own line.

- `DASHSCOPE_API_KEY` is documented as a `qwen-plan` credential alongside
  `QWEN_PLAN_API_KEY`, and the README now records that Qwen is key-only:
  Alibaba discontinued the Qwen Code OAuth free tier on 2026-04-15, so there is
  no OAuth path to add. Point `QWEN_PLAN_BASE_URL` at the DashScope
  compatible-mode endpoint to bill a pay-as-you-go key through the same
  provider.

- The Alibaba Model Studio plan provider (`qwen-plan`) now lists every chat
  model the Individual Plan serves, not just Qwen3.7: Qwen3.8 Max, Qwen3.8 Max
  Preview and Qwen3.6 Flash (all with vision input), plus the cross-vendor
  models the plan resells — DeepSeek V4 Pro, DeepSeek V4 Flash (0731) and
  GLM-5.2. The cross-vendor entries use the DashScope compatible-mode request
  profile rather than each vendor's native thinking profile, because DashScope
  rejects the vendor-specific parameters. The plan's speech, image and video
  models are deliberately not listed — they are not chat-completions models
  and would fail on every request from a model picker.

- API keys can now be replaced or removed from the desktop app and the macOS
  tray, not just the terminal. Each connected API provider gains a **Replace
  key** action and a confirmed **Remove** action; removing deletes the managed
  key files and hides the provider from the Codex model picker. If a key is
  also present in the macOS Keychain or the environment, the removal result
  says where it still resolves from instead of claiming a clean disconnect.
  `control credential <provider> --remove` exposes the same operation.

- The Dynamic Island setting is now a three-way mode: Off, Notch (the
  existing top-of-screen overlay), or Desktop — a draggable widget-style
  panel pinned just above the desktop icons that always shows live router
  activity, every connected provider's vendor quota bars with reset
  countdowns, and the 7-day token trend, with its position remembered.
- Added a Z.ai vendor quota adapter: when a `zai-coding` provider is
  configured, account usage now reports real plan windows (5-hour, weekly,
  token quota) with reset times from Z.ai's key-authenticated quota API,
  plus a dashboard link. Alibaba plan and Ollama Cloud accounts stay
  local-only by design — their vendor dashboards are session-gated and the
  router never imports browser cookies — but now carry a `dashboardUrl` so
  companion UIs can deep-link to the official usage pages.
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
- Guided setup now offers to build and launch the desktop companion app as a
  final step on macOS (menu bar, installed into `~/Applications`) and Linux
  (tray), with `--with-tray`/`--no-tray` overrides on `install.sh` and
  `bin/setup`. A missing toolchain or failed build warns and continues; it
  never fails the router install.
- Added an Ollama Cloud provider (`ollama-cloud`) with GLM-5.2, Kimi K2.7
  Code, MiniMax M3, and DeepSeek V4 Pro picker models, using ollama.com's
  OpenAI-compatible API with an account API key and context windows read from
  Ollama's published model metadata.
- Added a Qwen provider (`qwen-plan`) for Alibaba Model Studio Token and
  Coding Plan subscriptions with Qwen3.7 Max and Qwen3.7 Plus picker models,
  defaulting to the Singapore Token Plan endpoint with an environment override
  for other regions or plans.
- Added a Z.ai GLM Coding Plan provider (`zai-coding`) with GLM-5.2 and
  GLM-5-Turbo picker models. Requests use the plan's dedicated coding endpoint,
  enable thinking, map Codex's maximum reasoning tier to Z.ai's `max` effort,
  and drop sampling overrides that conflict with thinking mode.
- Added interactive model curation: `bin/curate-models PROVIDER` discovers the
  provider's live model list, lets the user toggle models the registry does
  not ship, and stores them as protected local user models with conservative
  default metadata. User models overlay the registry at load time; invalid or
  colliding entries are skipped with warnings instead of failing the router,
  and the command can rebuild routes and restart the service on request.
- Rebuilt the guided setup as a stepped wizard: numbered progress headers, a
  toggleable provider list with live ready/needs-key/needs-sign-in status,
  `a`/`n` select-all/none shortcuts, invalid-input recovery instead of
  aborting, color when the terminal supports it (respecting `NO_COLOR`), and a
  review summary with explicit confirmation before anything is installed.
- Guided Codex setup can now onboard Grok OAuth (and offers to `npm install`
  a missing official provider CLI), matching what the Cursor setup and tray
  already supported.
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
