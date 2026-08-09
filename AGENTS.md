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
   `zai-coding`, `ollama-cloud`, `minimax-token-plan`, `meta`, and/or
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

## The Python gateway is installed from a hash-verified lock

The router's gateway is LiteLLM, so every install executes a large Python
dependency tree. That tree is pinned and hashed rather than re-resolved.

1. `requirements/python.txt` is the lock: the full transitive closure of
   `PYTHON_REQUIREMENTS` in `src/install-plan.mjs`, every distribution pinned
   and carrying its SHA256. Both installers install *that file* with
   `--require-hashes`, in both their `uv` and their `pip` branch. Pinning only
   the two top-level packages left everything underneath them floating, which
   is how one machine's gateway came to differ from another's.
2. Never edit either `requirements/` file by hand, and never add a package to
   an installer command line. Change the pin in `src/install-plan.mjs` and run
   `bin/lock-python`, which rewrites `requirements/python.in` from
   `PYTHON_REQUIREMENTS` and recompiles the lock. Commit both files together.
3. The lock must stay **universal**. `bin/lock-python` passes `--universal
   --generate-hashes --python-version 3.10`, which is what makes one file
   serve macOS, Linux, and Windows on CPython 3.10+ through environment
   markers. A lock regenerated without `--universal` looks fine and installs
   only on the machine that produced it; `test/python-lock.test.mjs` fails on
   that, on an unhashed entry, and on any disagreement with
   `PYTHON_REQUIREMENTS`. Do not weaken those tests to land a lock.
4. `litellm==1.95.0` publishes wheels for `manylinux` and `win_amd64` only, so
   **macOS builds it from the sdist** with `maturin` and a Rust toolchain. That
   predates the lock and the lock does not change it — the sdist hash is in the
   file, so the source build is verified too. Do not "fix" a slow or failing
   macOS install by moving the pin; check for `cargo` first.
5. Hash verification covers the distributions, not the isolated build
   environment pip and uv create for an sdist. `maturin` is fetched unhashed
   during that build. Closing that gap needs a separate build-requirements
   lock; do not claim the current lock covers it.
6. The lock is proven by installing it, not by reasoning about it.
   `.github/workflows/python-lock.yml` installs it for real on Linux and
   Windows through both resolvers, then asserts the pinned versions, the
   `litellm[proxy]` extra, and a live `/health/liveliness`. It gets the command
   from `install-plan.mjs python-install-command`, which extracts the line from
   `bin/install` and `install.ps1` themselves — never write a `pip install` line
   into CI, because a job that spells its own command can pass while the
   shipped installer fails. Its negative control must also keep failing: if an
   unhashed requirement ever installs, every other check in that job is
   meaningless. Do not add a resolver cache there; a cache hit can serve an
   already-unpacked wheel and skip the hash check the job exists to perform.

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
6. A curated model inherits a request profile from the provider's registry
   models. The catalog-only resellers ship none, so curation also asks whether
   the model rejects a forced `tool_choice` (`--request-profile
   auto-tool-choice` in the deterministic form). Answer yes only for a model
   observed to answer HTTP 400 on `tool_choice: "required"` while still
   calling tools under `"auto"` — the restriction belongs to the upstream
   behind the reseller, not to the reseller, so it is set per model and never
   as a provider-wide default. Never widen it by changing what
   `src/compatibility-test.mjs` sends: the probe must keep sending `required`,
   or it stops proving tool calling works for every other provider.
7. Run `./bin/model-router codex doctor`. A live `bin/test-model` request uses
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

## Vision bridge for text-only models

The router can let a text-only model answer about a pasted image: the routed
request path sends each image part to a vision-capable model the operator has
already enabled and credentialed, and substitutes the returned transcript into
the turn as text. Treat it as a router capability, never as a model capability.

1. It is opt-in per install (`bin/control vision-bridge on`, protected state in
   `vision-bridge.json`). The installer auto-enables it once, and only when it
   is still unconfigured and the operator already enabled a vision-capable
   provider — that reuses a model they already pay for, so no download and no
   surprise. When no such provider exists it stays off and the summary points
   at `vision-bridge setup`. `visionBridgeConfigured()` gates this so
   re-running the installer never overrides an explicit off. Never auto-enable
   in any other path; a routed image spends the engine provider's quota.
2. The registry keeps declaring what each model itself reads. `inputModalities`
   is never edited to add `image` for a bridge, and `visionBridge` accepts only
   `false`, as a per-model opt-out. The registry loader rejects `true` so the
   file can never assert a capability the model lacks.
3. The catalog advertises image input on a bridged model only while an engine
   actually resolves from the selected, credentialed, listed set. When the
   bridge is off, or the pinned engine disappears, the advertisement goes with
   it — Codex gates the paste on `input_modalities`, so a stale advertisement
   would leave a paste that nothing can serve. Rebuild the catalog after every
   change and tell the user to fully quit and reopen Codex.
4. A registry engine's call goes through the same gateway, credential, and
   request profile as any other routed turn. Do not add a second upstream path,
   a separate vision API key, or an external CLI dependency for a hosted engine.
   The one sanctioned exception is the local engine (`vision-bridge local`): a
   vision model the operator runs themselves (Ollama, LM Studio, llama.cpp). It
   lives outside the registry, so the request path calls its
   `/v1/chat/completions` endpoint directly with no credential, and it is used
   only when explicitly pinned — auto mode never routes images to `localhost`,
   since an unreachable server would fail every paste. This is what lets a
   text-only-only install enable the bridge with no paid vision model. The
   `vision-bridge setup` command and probe target Ollama for auto-download
   because it is a managed daemon with a stable model registry — the only
   runtime where "install once and it keeps working" holds. llama.cpp and LM
   Studio remain first-class manual engines (the probe detects both, and
   `vision-bridge local <model> <baseUrl>` pins either); the installer never
   installs a runtime or pulls a multi-gigabyte model without explicit consent
   (`setup` requires `--yes` before any download). A model download runs
   detached (`src/vision-download.mjs` streams Ollama's `/api/pull` and records
   progress in `vision-download.json`): `pull` returns at once and `pull-status`
   reports the percentage, because a synchronous multi-gigabyte pull freezes
   the tray and reads as a crash. The worker pins the model only after it is on
   disk, so a failed or interrupted download never repoints the bridge at a
   model that is not there.
5. Substituted transcripts are untrusted user data. Keep them fenced and
   labelled as quoted image content, never log a transcript or a gateway error
   body, and keep the per-image failure path degrading to a stated failure
   rather than a failed turn.
6. Evidence, not impressions. The instruction set asks for a transcript, a
   layout list, readable data values, and an explicit uncertainty list, so the
   downstream model quotes rather than guesses. Preserve the uncertainty
   section in any rewrite.
7. Never add a local model to `LOCAL_VISION_CATALOG` with an `accuracy` claim
   that was not measured. Run `node src/vision-benchmark.mjs`, which scores a
   model against a checked-in image with known contents, and record the result
   in `measured`; anything unmeasured stays `untested`. This is not bureaucracy:
   `llava` scores 0% and `moondream` 0% on text while sounding entirely
   plausible, so a reputation-based label would route users straight to a model
   that fabricates invoice numbers. The picker sorts on this field, so an
   unearned "accurate" puts a confident-wrong reader at the top of the list.
7. Regression coverage lives in `test/vision-bridge.test.mjs`,
   `test/vision-bridge-state.test.mjs`, and the bridged-catalog case in
   `test/catalog.test.mjs`. A change to engine ranking, caching, substitution,
   or the advertisement rule needs a test there.

## Local models as a provider

`local` is a keyless provider: it serves from this machine, so there is no
credential to store, prompt for, or redact.

Local models are published as **experimental**, and the two roles are not
equally proven. Reading images is dependable: a local vision model transcribes
codes, numbers, and dates exactly, every run. Driving a Codex turn is not: the
same model has passed `local-models agent-check` and failed the identical check
minutes later. Do not quietly drop the label because a check happened to pass.

1. `keyless: true` is only valid with a loopback `baseUrl` and no `credential`
   block; the loader rejects both violations. An unauthenticated provider
   pointed at the internet would send traffic off-box with no key.
2. Checked local models are published into the user-model overlay, the same
   mechanism curated cloud models use. Do not add a second registry path for
   them, and never write local models into the checked-in `config/` tree --
   they exist only on the machine that installed them.
3. A change to the checked set must rewrite **both** the Codex catalog and the
   gateway route table (`refreshModelSettingsCatalog({ routes: true })`).
   Writing one without the other is the drift doctor's "Catalog matches gateway
   routes" check exists to catch.
4. Checking, installing, and removing are three separate actions. Unchecking
   never deletes a download; removing requires explicit consent and unchecks
   the model so nothing stays selected once it is off disk.
5. A local model advertises image input only when its family can actually read
   images -- the same standard the checked-in registry is held to.
6. Codex drives every turn through tool calls, so a local model is publishable
   only when Ollama reports the `tools` capability. Most vision models do not
   have it. `local-models inspect <tag>` reads the registry's chat template to
   answer that before a download, but a template mentioning `.Tools` is
   necessary and not sufficient -- `qwen2.5-coder:7b` advertises tools and
   still returns them as plain JSON text, which Codex cannot dispatch. Treat
   the flag as a filter and a real request as the proof.
7. New providers only reach a running router after the service restarts, since
   the registry and gateway config load at startup. If the router starts
   answering every request with `local_router_error`, suspect a process still
   holding pre-change state rather than the new code.

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
- The same rule applies in reverse, and it is not conditional on the envelope.
  A routed subagent cannot mint an OpenAI token, so Codex stores its readable
  handoff under `agent_message.content[].encrypted_content` whatever the
  surrounding `Message Type:` rendering looks like. Before forwarding to a
  native Responses endpoint — `/responses` and `/responses/compact` alike —
  rewrite every non-Fernet `encrypted_content` part of an `agent_message` to
  `input_text`; that schema accepts only `input_text`, `input_image`, and
  `encrypted_content`, so `output_text` is not a fallback. Classify on the
  ciphertext format (the `gAAAAA` Fernet prefix over base64url with no
  whitespace), never on whether the plaintext looks readable, and forward a
  value that passes byte-identical. Do not gate this on a router-written
  sentinel: the router never authors these items, and a marker would strand
  the already-broken conversations this recovers.
- Never log relay response bodies, decrypted task text, or exception messages
  that can echo either. Regressions require fragmented/mislabeled SSE tests and
  real marker-return probes through every installed routed agent plus a
  same-thread follow-up.
