# Model Router installation instructions

These instructions apply when a user asks an agent to install this repository.

## Choose the target

- `codex` is the only supported target. If the user asks for Cursor or
  opencode integration, explain that those targets were removed and the
  router now focuses on Codex; the opencode provider (the Go subscription and
  the pay-per-use Zen endpoint) remains available inside Codex.

## Codex outcome

Install Codex Router for the current user, preserve every unrelated Codex
setting and ChatGPT authentication artifact, expose only the external providers
the user wants, verify the integration, and leave the final Codex restart to the
user.

## Codex procedure

1. Read the host platform and check for Codex, Git, Node.js 22.19+, and `uv` or
   Python 3.10+. Read-only checks are allowed. Do not install a package manager
   or system runtime without the user's permission.
2. Use a stable checkout: `~/.local/share/codex-router` on macOS/Linux, or
   `%LOCALAPPDATA%\codex-router` on Windows. Do not install the service from a
   temporary clone.
3. Never ask the user to paste OAuth tokens or API keys into chat, command
   arguments, logs, environment snippets, or tracked files.
4. Determine which provider IDs the user requested: `anthropic-api`,
   `kimi-oauth`, `kimi-api`, `deepseek`, `grok-oauth`, `grok-api`, `qwen-plan`,
   `zai-coding`, `ollama-cloud`, `minimax-token-plan`, `meta`, `clinepass`, and/or
   `opencode-go`
   (shown to users as "opencode Go/Zen"; its `opencode-go-messages`,
   `opencode-go-responses`, and `opencode-zen` variants share its stored key
   and are enabled and disabled with it automatically; never select or toggle
   them separately. Zen ships no preselected models — curate them per user
   with `bin/curate-models opencode-zen`), and/or `commandcode`
   (shown to users as "Command Code"; its `commandcode-messages` variant
   shares its stored key and is enabled and disabled with it automatically;
   never select or toggle it separately. Command Code accepts either a stored
   key or a `command-code login` browser sign-in — see step 5). The
   catalog-only providers `groq`, `openrouter`, `together`, `fireworks`,
   `cerebras`, `mistral`, `nvidia-nim`, `siliconflow`, `huggingface`, and
   `gemini-api` are also selectable, but they ship no preselected models: after
   the key is stored, the user must run `bin/curate-models PROVIDER` in an
   interactive terminal to choose models. If they did not specify and
   credentials already exist, use
   `configured` rather than showing providers that cannot authenticate.
5. For Kimi OAuth, reuse a valid `kimi login` session. If login is needed, run
   the official CLI only in an interactive terminal. For API providers, invoke
   `bin/model-router codex provider-key PROVIDER set` in a PTY so the hidden
   prompt receives the value directly; do not relay it through chat. Command
   Code also accepts a browser sign-in: reuse a valid `command-code login`
   session (`~/.commandcode/auth.json`), or run that CLI in an interactive
   terminal. A successful sign-in does not mean the account may use the
   Provider API: that needs the Provider plan, and a Go-plan key is refused
   with "Your Go plan doesn't include API access". Say so rather than
   re-running setup, which cannot change an entitlement. Read the session only through the router's credential resolver;
   never open, copy, move, or delete another tool's credential file.
6. Run read-only legacy detection. It is safe to pass `--migrate-known` when the
   detector identifies a repository-recognized older Codex Router: migration is
   scoped, snapshotted, and reversible. Never migrate, stop, delete, or replace
   an unknown router automatically.
7. On macOS/Linux, run
   `./install.sh --target codex --auto --providers IDS --migrate-known` from the
   stable checkout. On Windows, run
   `./install.ps1 -Target codex -Auto -Providers IDS -MigrateKnown`. Omit the
   migration flag when detection found nothing. Do not enable the smoke test
   unless the user agrees to a quota-consuming request.
8. Run `bin/model-router codex doctor` (or
   `./model-router.ps1 codex doctor` on Windows). Core config, config privacy,
   catalog, caller capability, internal key, service, router health, and
   selected credentials must be `OK`. Unselected credentials may be `WARN`.
9. If a managed layer fails, use `model-router codex doctor --fix`; add
   `--migrate-known` only for a recognized older installation. Repair rebuilds
   the Node and Python dependencies unconditionally, unlike a normal install or
   update, which skips whichever dependency step already matches its
   fingerprint. Force that rebuild by hand with `bin/install --force-deps`
   (`./install.ps1 -CheckoutInstall -ForceDeps`) when an environment looks
   corrupted rather than merely out of date. If repair still fails, create
   `bin/support-bundle` and report its path without uploading it.
10. Do not terminate Codex. Tell the user to fully quit it, reopen it, create a
    new task, and choose the new model.

## Requests to install or expose more models

First distinguish a local model addition from a repository-wide model change.
Prefer local curation when one user wants a model that an already registered
provider advertises. Change the checked-in registry only when the user intends
to ship tested support to every installer.

### Add models for the current user

1. Inspect the installed selection with
   `./bin/model-router codex providers list --json`. Do not assume that a stored
   credential means the provider is intentionally visible.
2. If authentication is missing, use the provider's official OAuth CLI or run
   `./bin/model-router codex provider-key PROVIDER set` in a PTY. Keep secrets
   out of chat, arguments, logs, environment snippets, and tracked files.
3. If the requested model is already checked into the registry tree under
   `config/` (one vendor directory holding a `<vendor>.json` provider file
   plus per-access-method `models.json` fragments, e.g.
   `config/kimi/kimi.json` and `config/kimi/oauth/models.json`), run
   `./bin/model-router codex providers enable PROVIDER`. This preserves the
   other selected providers and refreshes the installed picker catalog.
4. If the provider is registered but the model is not checked in, run
   `./bin/curate-models PROVIDER` in an interactive terminal. When the user gave
   exact IDs and the live catalog confirms them, the deterministic form is
   `./bin/curate-models PROVIDER --models ID1,ID2 --apply`. On Windows use
   `node .\src\curate-models.mjs` with the same arguments.
5. Local curation writes protected `user-models.json` state and survives router
   updates. Never edit the checked-in `config/` registry tree merely to
   satisfy one machine's
   request. The provider's own `/v1/models` endpoint alone decides which
   models exist. Interactive curation asks for each new model's context
   window, image support, and reasoning efforts (so the user can switch
   effort in the picker); the deterministic `--models` form takes
   conservative defaults, `--efforts minimal,low,medium,high,xhigh` sets the
   effort ladder, and every stored value stays editable in
   `user-models.json`. An optional `availabilityNux` string on a model becomes
   the Codex "Introducing {model}" announcement (shown a limited number of
   times per slug, tracked by the Codex client itself); leave it unset unless
   the model is genuinely news to the operator. Curated models are not
   implicitly approved as native v2 subagent model overrides.
6. Run `./bin/model-router codex doctor`. A live `bin/test-model` request uses
   provider quota, so run it only with the user's approval. Finally, tell the
   user to fully quit and reopen Codex before checking the picker.

If the provider itself is unknown to the registry, stop treating the request as
installation. It is repository development and requires the process below.

### Ship a model to every installer

1. Run `./bin/discover-models PROVIDER`; discovery is read-only. Confirm the
   model ID and capabilities against the provider's current official
   documentation. Never infer tools, images, context size, reasoning, or billing
   behavior from the model name.
2. Add the model declaratively to the vendor's registry fragment (the
   `config/<vendor>/<method>/models.json` file for its provider; a new
   provider also needs its definition in `config/<vendor>/<vendor>.json`)
   with unique `slug`,
   `gatewayModel`, and provider/upstream IDs; complete picker metadata;
   supported reasoning levels; input modalities; context/compaction limits;
   and the correct request profile. Use `listed: false` for compatibility-only
   aliases. An optional `availabilityNux` string ships announcement copy that
   Codex renders as its "Introducing {model}" card the first few launches
   after the model appears; reserve it for a genuinely new flagship, because
   every installer will see it. Checked-in models that newly become routable
   (added by an update, or unlocked when the operator credentials and enables
   their provider) also announce automatically for seven days with copy
   assembled from their verified picker metadata (context window, effort
   ladder, image support) — tracked in the protected
   `announced-models.json` state; the first catalog capture seeds that state
   silently, curated `availabilityNux` copy wins over the generated text, and
   locally curated user models never self-announce. In the CLI TUI this renders as a startup tip
   line; the full-screen prompt is instead driven by an optional `upgradeTo`
   object (`{ "model": "target/slug", "markdown": "..." }`) on the model the
   operator currently runs: Codex renders the markdown as the entire
   "Codex just got an upgrade" modal (with `{model_from}`/`{model_to}`
   placeholders), and accepting switches the operator's default model to the
   target, so ship one only for a genuine successor.
3. A new provider also needs credential isolation, discovery metadata,
   selection/onboarding support, request translation, health behavior, and
   tests. Never place an API key or OAuth artifact in the registry. A new
   provider is not done until the whole checklist in
   "Ship a new provider to every installer" below passes.
4. Set `multiAgentVersion: "v2"` only after the model is proven through native
   Codex collaboration: tool calls work, encrypted subagent payload relay works
   without disclosure, a marker-return spawn succeeds, and a same-thread
   follow-up succeeds. Otherwise omit it and retain conservative v1 behavior.
5. Remember that Codex advertises only a small priority-ordered subset of native
   spawn-model overrides. Adjust priority intentionally and keep the desired
   Kimi/Grok/GPT choices in that visible subset; do not crowd them out
   accidentally when adding a model.
6. Add registry, catalog, routing/request-profile, and failure-path regression
   tests. Run `npm run check` and `npm test`. With explicit quota approval, run
   `./bin/test-model 'provider/model' --live --yes`, reinstall, fully restart
   Codex, and perform the native subagent probe before claiming support.

### Ship a new provider to every installer

A new provider is only complete when all of the following are true. Do not
land a provider that satisfies routing but skips the tray, install, or usage
surfaces.

1. **One-click install.** The provider ID must work end to end with no manual
   config edits: selectable through `install.sh --providers` /
   `install.ps1 -Providers`, through
   `bin/model-router codex providers enable PROVIDER`, and reported correctly
   by `bin/model-router codex doctor`. If the provider ships no preselected
   models, document it as catalog-only and make sure `bin/curate-models`
   handles it.
2. **Tray setup section.** Every provider must appear in the macOS tray with a
   working setup card driven by `src/provider-onboarding.mjs` and the control
   commands the tray invokes:
   - API-key providers get the hidden credential path (tray →
     `control credential PROVIDER` over stdin → `saveApiCredential`). The key
     must never transit chat, logs, or command arguments.
   - OAuth providers additionally get the OAuth section: an `OAUTH_CLIS`
     entry in `src/provider-onboarding.mjs` (executable, npm package, login
     arguments) so the tray's `install-cli PROVIDER` and `login PROVIDER`
     buttons work, plus status,
     session-refresh, and reconnect-on-expiry wiring in the provider's OAuth
     status/session modules (follow `kimi-oauth-*` / `grok-oauth-*` as the
     patterns).
   - Some official CLIs draw a full-screen terminal interface and put stdin in
     raw mode (`command-code login` uses Ink). Spawned with pipes they die on
     "Raw mode is not supported" before reaching the browser, so the tray must
     hand them a real terminal (`needsTerminal` in `SIGN_IN_CLIS`) and then
     wait for the credential to be rewritten. Check this by running the login
     with `</dev/null` before wiring a button to it.
   - Connecting is always one click. Any tray sign-in button installs the
     official CLI when it is missing and then runs the login in the same
     operation (`connectProvider` in the tray), rather than stopping after the
     install and waiting for a second click. Label the button for everything
     it will do (`Install & Sign In`) so the single click stays honest. This
     is the house rule for every provider, OAuth or CLI-session: implement it
     without asking.
   - A provider whose official CLI finishes a browser sign-in by minting an
     API key into its own home directory (Command Code) is not an `oauth`
     provider: it stays `openai-compatible` and declares
     `credential.cliSession` in the registry so the resolver reads that file
     after the environment, the stored key, and the Keychain. Add its CLI to
     `SIGN_IN_CLIS` in `src/provider-onboarding.mjs` so the tray's install and
     sign-in buttons work, and keep the key field available alongside.
     Do not split such a provider into separate OAuth and API ids. The
     sign-in mints the very key the API route would use, against the same
     endpoint and the same catalog, so the two are one credential with two
     delivery mechanisms rather than two products. Split a provider only when
     the routes differ in endpoint, models, or billing — as Kimi's
     subscription forwarder and Moonshot's platform API do.
   - Add the provider icon under
     `apps/macos/ModelRouterTray/Resources/` and record its source in
     `PROVIDER-ICON-SOURCES.md`.
3. **Plan entitlement.** When a provider's credential can authenticate an
   account whose plan still may not call the API, set `planNote` on its
   registry entry. `providers enable`, `doctor`, and the tray all print it, so
   the requirement is visible where someone connects instead of arriving as a
   403 inside Codex. Command Code is the case: any plan signs in, only the
   Provider plan is served.
4. **Usage, limits, and balance in the tray.** Wire the provider's account
   endpoint into `src/provider-account-usage.mjs` so `provider-usage --json`
   returns real metrics: `quota` metrics (used/limit/remaining with reset
   time) for plan- or window-limited providers, and `balance` metrics (the
   remaining dollar or credit amount) for prepaid/pay-per-use providers. These
   feed the tray's "% left" display, usage cards, and low-remaining reminders,
   so a provider without them silently hides the user's spend. If the provider
   exposes no usage or balance API, the snapshot must degrade gracefully and
   the tray must say usage is unavailable rather than showing stale or empty
   numbers. Routed request/token accounting comes from the shared usage-events
   pipeline and needs no per-provider work beyond correct event recording.

## Codex safety boundaries

- The config manager owns its marked root `openai_base_url` and
  `model_catalog_json` block plus its marked `model_providers.codex-router`
  table and, when the user has no concurrency preference, its marked
  `[agents].max_concurrent_threads_per_session` default. It may change the root
  `model_provider` only when the user explicitly
  enables the tray's login-free mode. In that mode it may also select an
  enabled external `model`; snapshot both previous values in protected router
  state and restore them exactly when the mode is disabled.
- Preserve reasoning settings, profiles, projects, trust, MCP configuration,
  features, and ChatGPT authentication. Preserve `model` and `model_provider`
  outside the explicitly enabled login-free mode.
- A user-initiated macOS tray login-mode change may gracefully restart only the
  registered Codex desktop app. This does not authorize an installation task to
  quit Codex, and the tray must never force-terminate it.
- Do not kill unknown processes on ports 4100-4103, or on the Grok OAuth
  forwarder port 4108.
- Do not print or read credential-file contents. Status commands report presence
  and source only.
- Treat the generated `/_codex-router/.../v1` config path as sensitive local
  authentication. Never paste the complete managed base URL into chat or a
  public issue; use the redacted status or support-bundle output.
- Do not delete retained keys, logs, backups, snapshots, or old state
  directories.
- Do not restart or quit the Codex App from the installation task.

## Routed subagent regression prevention

- A normal `/responses` smoke test does not cover Codex collaboration. Current
  model-generated subagent tasks and messages can arrive as native
  `encrypted_content`, with visible text ending at `Payload:`. External models
  cannot read that payload directly.
- The compatibility relay must remain signed-in-only and fail closed. Send its
  native request with `stream: true`, accept SSE by body framing as well as
  content type, recognize padded `gAAAA...=` ciphertext, and treat non-Fernet
  `encrypted_content` from an external parent as plaintext.
- Never log relay response bodies, decrypted task text, or exception messages
  that can echo either. Regressions require fragmented/mislabeled SSE tests and
  real marker-return probes through every installed routed agent plus a
  same-thread follow-up.
