# Model Router installation instructions

These instructions apply when a user asks an agent to install this repository.

## Choose the target

- `codex` (the Codex CLI and desktop app) and `dsh` (DeepSeek Harness) are the
  supported targets. If the user asks for Cursor or opencode integration,
  explain that those targets were removed and the router does not have them;
  the opencode provider (the Go subscription and the pay-per-use Zen endpoint)
  remains available as a provider inside both targets.
- **A target is a client, not a router.** One installation serves both: one
  background service, one gateway, one set of provider credentials, one
  provider selection, one set of ports. `MODEL_ROUTER_TARGET` selects which
  client's configuration a command writes. It must never fork the state
  directory, the service, or the credential store — a user who installs both
  would otherwise be asked for every API key twice and would run two gateways
  against one set of provider quotas. `ROUTER_PLANE_TARGET` in
  `src/paths.mjs` names that shared plane, and the environment aliases and the
  `/health` service name are keyed on it rather than on the client.
- Installing both is normal and needs no special handling: run the install
  once per target. Whichever one is already present is republished whenever the
  routable set changes, so the two clients cannot drift apart.

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
   `kimi-oauth`, `kimi-api`, `kimi-api-cn`, `deepseek`, `grok-oauth`, `grok-api`, `qwen-plan`,
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
   `cerebras`, `mistral`, `nvidia-nim`, `siliconflow`, `huggingface`,
   `gemini-api`, `github-copilot`, and `chutes` are also selectable, but they ship no
   preselected models: after
   the credential is stored, the user must run `bin/curate-models PROVIDER` in an
   interactive terminal to choose models. If they did not specify and
   credentials already exist, use
   `configured` rather than showing providers that cannot authenticate.
   The anonymous catalog-only providers `opencode-free` and `kilo-free` are
   also selectable, but they need no credential only for their documented free
   model subsets. They ship no preselected models and must be explicitly
   selected before `bin/curate-models PROVIDER` is run; never select either one
   on the user's behalf just because it can authenticate without a key.
   `kimi-api` and `kimi-api-cn` are two different Moonshot platforms, not a
   fallback pair: the global console at platform.moonshot.ai and the mainland
   one at platform.moonshot.cn have separate accounts, separate billing, and
   keys that each host rejects from the other. Ask which platform the user's
   key came from rather than defaulting, and never copy a stored key between
   the two.
5. For Kimi OAuth, reuse a valid `kimi login` session. If login is needed, run
   the official CLI only in an interactive terminal. For API providers, invoke
   `bin/model-router codex provider-key PROVIDER set` in a PTY so the hidden
   prompt receives the value directly; do not relay it through chat. GitHub
   Copilot requires a fine-grained PAT with the Copilot Requests permission;
   never read or copy the official Copilot CLI credential store. Command
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

## DeepSeek Harness outcome

Publish the router's routed models into DeepSeek Harness as one provider route,
preserve every other section, route, comment, and credential in the harness's
own documents, and leave the harness running — it hot-reloads, so there is
nothing to restart and nothing to tell the user to quit.

## DeepSeek Harness procedure

1. Steps 1-6 of the Codex procedure apply unchanged, except that Codex itself is
   not a prerequisite: a harness-only machine needs Node 22.19+, `uv` or Python
   3.10+, and the harness. Do not run `src/catalog.mjs` there — it asks the
   Codex CLI whether the session is signed in and refuses to publish when it
   cannot ask, which is a failure, not a fallback.
2. Run `./install.sh --target dsh --auto --providers IDS` (macOS/Linux) or
   `./install.ps1 -Target dsh -Auto -Providers IDS` (Windows).
   `--migrate-known` and `--adopt-native-catalog` are refused here: both act on
   Codex's own configuration, and the harness has no counterpart to either.
3. Run `bin/model-router dsh doctor`. "Harness routing config", "Harness caller
   credential", "Harness settings privacy", and "Harness catalog freshness"
   must be `OK`, alongside the shared-plane checks.
4. Do not tell the user to restart the harness. `dsh-settings-file` watches the
   document and publishes external edits, so the route is live on the next
   request. Saying otherwise trains people to restart for nothing.

## What the harness integration writes, and what it must never touch

The router owns exactly two keys, in two documents that belong to the harness.
Both are hot-reloaded by it, and its own Models page writes provider routes
beside ours, so everything else in them is somebody else's work.

1. **One route, not a section.** The router owns
   `llm-pi-ai.providers.codex-router` in `$DSH_HOME/settings.yaml` and
   `CODEX_ROUTER_CALLER_KEY` in `$DSH_HOME/.credentials.yaml`. It never reads,
   rewrites, or removes a sibling route, another adapter's section, or another
   credential. Publishing twice is byte-identical, and removing the route
   restores the document exactly — including the user's comments and blank
   lines. `test/dsh-config-manager.test.mjs` asserts both properties against a
   document that has work of somebody else's in every position the router
   writes near; do not weaken them.
2. **Refuse rather than guess.** `src/yaml-structure.mjs` is a fail-closed
   structural lexer for block-mapping YAML, not a general YAML parser. A
   document it cannot read plainly — a tab indent, a multi-document stream, a
   duplicate key, a sequence root, an unterminated flow collection, an anchored
   key, an inline `providers` mapping — is refused with the file untouched and
   the line named. A refusal costs a command; a wrong guess rewrites a file
   whose only copy is on the user's disk. Never add a "best effort" path there.
3. **Both documents are private.** The settings document carries the managed
   base URL, which is a local caller capability, and the credentials document
   carries the key it references. Both are written 0600 under a 0700 directory,
   the same bound the harness itself holds them to, and status output reports
   the redacted URL exactly as the Codex manager does. Never print the complete
   managed base URL.
4. **Routed models are always published; native ones only while a session backs
   them.** Publish only the selected, credentialed, listed, non-hidden routed
   models. An unregistered slug on the router's `/v1/responses` endpoint is
   treated as native GPT traffic needing a ChatGPT session, which a harness
   request does not carry — so a native model is advertised only while
   `nativeSessionStatus().usable` reports the session this machine is signed in
   with as spendable, and is withheld again the moment it is not. Publishing one
   the router cannot authorize offers a turn that 401s, which is the failure
   this gate exists to prevent; never widen it to presence alone, because an
   expired session is present.
   The vision-bridge engine candidates still exclude native models: that call
   site admits an engine on evidence the *caller's* session can spend it, and a
   substituted session is not the caller's.
5. **The protocol is `openai-responses`**, because that is the only thing the
   router's caller endpoint serves, and every router capability — tool-result
   ageing, the vision bridge, prompt-token substitution, upstream retry, usage
   and throughput accounting — already sits on that routed path. Do not add a
   second upstream path or a chat-completions surface for the harness; the
   point of pointing it at the same endpoint Codex uses is that there is one
   request path to keep correct. `models[].id` is the router **slug**, never
   the gateway model id: `/v1/responses` resolves it against `MODEL_BY_SLUG`,
   and a gateway id falls through to the native path.
6. **No `compat` on the route.** pi-ai types its reasoning-dispatch switches
   only on `openai-completions` and refuses a route-level switch anywhere else.
   Each model's request profile is applied on the router's own side of the hop,
   which is where that knowledge belongs.
7. **A reasoning level pi-ai cannot name is dropped, not approximated.** Its
   level set is `off, minimal, low, medium, high, xhigh, max`; the Codex ladder
   also spells `ultra`. `unmappableEfforts()` reports what was dropped so the
   omission is visible rather than silent. A model with no levels declares
   `reasoningEfforts: false` — omitting the field would inherit whatever
   pi-ai's installed catalog says about a colliding id.
8. **The default model is the user's.** Taking over `agent-default-model` is
   opt-in (`--set-default-model`), snapshotted verbatim, and restored on
   uninstall — the same discipline the Codex login-free mode applies to `model`
   and `model_provider`. Never write it as a side effect of publishing.
9. **Delegation is composition, not settings.** `dsh-tool-subagent` installs no
   settings section, so the router cannot configure the harness's subagent
   model and must not edit a preset it does not own. A child with no model of
   its own inherits the default model selection, which is already a routed
   model once the route is the default;
   `./bin/model-router dsh subagent-preset` prints the block to paste for a
   deployment that wants children on a *different* routed model. Codex's
   `bin/multi-agent` stays Codex-only: it drives `multi_agent_version` and the
   Codex agents directory, whose payloads are Codex's own encrypted format.
10. **Drift is this integration's failure mode.** The harness hot-reloads its
    settings document, so anything else that writes it takes effect at once and
    can leave the published route naming models the gateway no longer routes.
    `dsh-models.json` in the router's own state directory records what the last
    publish wrote; doctor compares it against the routable set, and it is the
    marker that decides whether an integration is installed. Any code path that
    changes the routable set must republish through
    `refreshTargetPickerIfInstalled()`, which refreshes every installed client
    rather than only the active target.

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
4. Check which wheels a litellm pin actually publishes before moving it.
   `1.95.0` shipped `manylinux` and `win_amd64` only, so **macOS built it from
   the sdist** with `maturin` and a Rust toolchain — slow, and broken outright
   without `cargo`. `1.96.0` publishes macOS wheels (arm64 and x86_64) as well,
   so no supported platform builds from source today. If a macOS install is slow
   or failing, check for `cargo` and check the pin's wheel list; do not assume
   either state.
5. Hash verification covers the distributions, not the isolated build
   environment pip and uv create for an sdist. `maturin` is fetched unhashed
   during that build. Closing that gap needs a separate build-requirements
   lock; do not claim the current lock covers it. No supported platform builds
   from source at the current pin, which narrows the exposure but does not
   remove it — a pin without a wheel for someone's platform brings it back.
6. A pin can be a **security floor**, and moving it backwards reintroduces the
   advisory it was raised for. `litellm==1.95.0` required
   `cryptography>=48.0.1,<49.0`, so no patched cryptography could be resolved
   while it was held (GHSA-g6cj-pr64-35w5, fixed in 50.0.0). Dependabot reports
   the transitive package; the fix is almost always the direct pin above it.
7. Resolving is not booting. litellm's own metadata allows fastapi versions its
   code cannot import (`get_flat_dependant`, removed in 0.140), so `uv pip
   compile` will happily produce a lock whose gateway dies on startup. Any
   change to either Python pin has to be proven by starting the proxy and
   getting a live `/health/liveliness`, not by a successful resolve.
8. The lock is proven by installing it, not by reasoning about it.
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

1. It is **on by default** and off only when the operator says so
   (`bin/control vision-bridge off`, protected state in `vision-bridge.json`).
   Reading a pasted screenshot is the one thing people expect to work without
   finding a toggle, and everything it needs is already installed: an install
   with nothing to read images with resolves no engine and degrades exactly as
   it did before the bridge existed, so the default costs an unequipped machine
   nothing.
   - The line between "never configured" and "configured off" is **structural,
     not a sentinel**: no state file means nobody has answered and the current
     default applies; a readable file's `enabled` is the operator's own answer
     and is taken verbatim forever. A stored `false` must never be re-enabled by
     a change of default. A file that exists but this build cannot parse falls
     back to **off**, not to the default — somebody was here and we cannot tell
     what they chose, so it must not start spending quota.
   - `version` stays `1` on purpose. A bump would have to guess what an older
     `false` meant, and there is nothing to guess with; file presence already
     answers it, and `visionBridgeConfigured()` has gated exactly that
     distinction since the bridge shipped. Do not add a migration that replaces
     that fact with an inference.
   - The installer writes no bridge state at all. It used to auto-enable once
     when a vision-capable provider happened to be selected, which made the
     file's presence mean "the installer ran" and left every other install
     needing a command nobody knew about. It now only reports. Never write
     bridge state from an install or update path; a routed image spends the
     engine provider's quota, so the only writers are the operator's own
     commands.
   - Because it is on by default, a surface that would nag an unconfigured
     install checks `visionBridgeConfigured()` first. `doctor` warns about "no
     resolvable engine" only for an operator who actually asked; for a
     default-on install it reports `ok`, since nothing was lost.
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
   `resolveVisionEngine` takes that set as a **function**, never as an array,
   and rejects an array outright. Assembling it means probing every provider's
   credential synchronously — on macOS one `/usr/bin/security` spawn per
   provider per keychain service, ~250ms with the event loop stopped — while two
   of the three answers (bridge off, engine pinned to `local`) never look at a
   candidate. On the request path that cost was paid per pasted image and
   blocked every other in-flight request. Deferring narrows nothing: what gets
   ranked is still exactly the selected, credentialed, listed set. A lazy list
   that skips the credential check is a security regression, not a speedup.
4. A registry engine's call goes through the same gateway, credential, and
   request profile as any other routed turn. Do not add a second upstream path,
   a separate vision API key, or an external CLI dependency for a hosted engine.
   The one sanctioned exception is the local engine (`vision-bridge local`): a
   vision model the operator runs themselves (Ollama, LM Studio, llama.cpp). It
   lives outside the registry, so the request path calls its
   `/v1/chat/completions` endpoint directly with no credential, and it is used
   only when explicitly pinned — auto mode never routes images to `localhost`,
   since an unreachable server would fail every paste. The rule is about the
   address, not about that one engine: a **keyless registry provider** (`local`,
   and the loader guarantees keyless means a loopback `baseUrl`) is the same
   hazard wearing a registry slug, so `resolveVisionEngine` excludes every
   loopback-served candidate from auto and admits it only by explicit pin. It
   stays listed in the picker, because choosing it carries the knowledge that
   the server has to be up. Auto mode is the only default an unattended machine
   gets, so it may only nominate an engine that is reachable without the
   operator having started something. This is what lets a
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
5. The second sanctioned exception is a **native engine**: a vision model from
   the operator's own signed-in ChatGPT plan, reached over the native path the
   router already owns (`NATIVE_BASE`) with the caller's own session headers.
   It is permitted because it introduces nothing — no stored credential, no
   separate vision API key, no external CLI, no install step, nothing to
   download — and because it spends a plan the operator already pays for, on a
   backend the router already talks to on every native turn. That is the whole
   justification. These conditions are what keep it from widening into
   something else, and each one is load-bearing:
   - **No new credential, ever.** A native engine carries the caller's session
     and nothing else: the fixed `FORWARD_HEADERS` allowlist, copied from the
     request in hand and sent only to the hardcoded `NATIVE_BASE`. The router
     must never store, cache, mint, or read a credential for this path, and the
     gateway's internal key must never travel to that backend. An engine that
     would need a key the router does not already hold is not this exception.
   - **Fail closed when there is no caller session.** No session on the request
     means no native engine: not a candidate, and a pin naming one does not
     resolve. Never fall back to the gateway for a native slug — it holds no
     credential for one — and never accept an on-disk capture as evidence that
     the session is still good. `native-models.json` and `merged-models.json`
     are both reused deliberately when a fresh probe fails, so a sign-out leaves
     them naming an engine that can no longer be called. Signing out has to stop
     the engine resolving on the very next paste, not at the next catalog
     rebuild. Cached transcripts are part of this: a native transcript is keyed
     to the account that bought it, because a cache hit skips the call and with
     it every check that this session may still spend that model.
   - **This is not a general bypass.** It licenses one destination and one
     credential: the router's own native path, on the caller's own session. It
     is not a precedent that any hosted engine may skip the gateway once its
     credential story sounds tidy. Item 4 stands unchanged for every registry
     engine — a hosted engine that would bring a second upstream, a separate
     vision key, or an external dependency goes through the gateway or does not
     ship.

   Known gap: **plan quota and limits** spent this way are still not surfaced.
   Every bridged read now records a usage event through the shared pipeline
   (model, provider, status, duration — no token counts, because the request
   path receives the transcript rather than the envelope) and logs one
   never-quieted line, so the operator can tell a vision call happened and
   against what. What is still missing is the other half of what "Ship a new
   provider to every installer" requires of everyone else: the ChatGPT plan's
   remaining quota does not move in the tray when a screenshot is transcribed,
   and no surface renders routed usage events at all. It is being closed
   separately. Do not read it as settled, do not weaken this section to
   accommodate it, and do not extend the exception to another engine while it is
   still open.
6. Substituted transcripts are untrusted user data. Keep them fenced and
   labelled as quoted image content, never log a transcript or a gateway error
   body, and keep the per-image failure path degrading to a stated failure
   rather than a failed turn. A stream that fails partway through is a failure,
   not a short transcript: deltas already in hand are discarded rather than
   returned, because a plausible truncated transcript is quoted downstream as
   though it were the whole image.
7. Evidence, not impressions. The instruction set asks for a transcript, a
   layout list, readable data values, and an explicit uncertainty list, so the
   downstream model quotes rather than guesses. Preserve the uncertainty
   section in any rewrite.
   - `## Identification` is the **one** section where inference is allowed, and
     it exists because a pure transcription contract cannot answer "what is
     this?" — which is the most common thing anyone asks about a pasted image.
     Without it the reader described a photo it plainly recognized, and the
     routed model went looking on the internet, uploading the operator's
     screenshot to a public host on the way. Keep it separate from `## Text`,
     keep it required, and keep `(unrecognized)` as the answer when nothing is
     recognizable. Inference belongs in one labelled place, never spread
     through the sections that claim to be a reading.
8. The reader is asked what the operator wants to know, and asked **again when
   that changes**. Pinning the question to the image's own message kept the
   cache still and made an image's reading a snapshot of the first thing ever
   asked about it. The newest image follows the newest question instead. Three
   properties keep that affordable, and all three are load-bearing:
   - Bought once per *question*, never per turn: a question already asked is
     served from the record, so Codex resending the conversation is free.
   - Only the **newest** image follows the conversation. Older images keep the
     question they were read for, so a chat holding ten screenshots cannot turn
     one new question into ten new reads.
   - The record accumulates, so an earlier answer survives a later question.
   The question itself is the operator's words only: Codex's `<image …>` wrapper,
   its `# Files mentioned by the user:` preamble, and its context blocks
   (`<environment_context>`, `<recommended_plugins>`) are bookkeeping, and
   sending them produced transcripts written about a filename.
9. Resolving an engine and **reaching** it are different questions. The reader
   is a short list — the operator's choice first, then the other credentialed,
   non-loopback vision models — and an image is offered to the next one when the
   first cannot be reached. A 401 from a lapsed session and a 503 from a
   provider outage both turned every paste into "could not be read" while the
   engine still resolved perfectly. What the fallback must not become:
   - **Silent.** The evidence header names the engine that actually read the
     image, and the per-turn log line records `fellBack`.
   - **A way around a pin.** A pin that does not *resolve* is still an
     operator-visible problem, never a quiet switch to another model, and a
     pinned **local** engine never falls back onto a provider's quota nobody
     chose to spend.
   - **Expensive.** The list is capped, the candidate set is still built at most
     once per turn, and a second engine is only ever called after the first has
     failed — so a working engine costs exactly what it did before. Another
     provider is tried before another *attempt* at a broken one: retries are
     spent only on the last engine in the list, because waiting out a retry
     ladder against a dead endpoint while a working engine sits behind it is
     how a fallback that works becomes a paste that takes half a minute.
10. A read that fails **transiently** is asked again — twice, at 250ms and 1s.
   The engine is a rate-limited account across a network, and losing an image
   for the whole turn to a 429 that would have cleared in a second is the
   opposite of what the bridge is for. What is not retried is equally
   deliberate: 4xx refusals buy the identical refusal, and a timeout is reported
   rather than retried because the per-attempt budget is already two minutes. A
   transport failure keeps the transport's own wording ("fetch failed"), which
   is how an operator learns their own loopback engine is down.
   - A reading that came back **incomplete** says so in its own header. The
     downstream model cannot otherwise tell "the image does not show that" from
     "the transcript does not mention it", and it answers the first with
     confidence either way. `## Data` is optional by contract and its absence is
     not a bad read. The two causes are reported differently on purpose: a read
     cut off at the size cap left a large image genuinely unread, so it is the
     one case that invites a second look; missing sections mean the engine does
     not follow the format at all -- a small local model answering in prose --
     and reading again returns the same shape, so an invitation there buys a
     loop rather than an answer. Never advertise a second look on every image.
11. Every image the router carries is read, in **both** places Codex puts one:
   parts of a user message, and the `output` of a `function_call_output`. A
   text-only model that has just been handed a transcript still sees the file's
   path in the turn and calls `view_image` on it, and that tool result holds the
   same bytes again. Missing it hands a raw data URL to a provider that rejects
   the whole conversation with an error naming no image
   (`unknown variant image_url, expected text`). Two consequences are load-bearing
   and must survive any rewrite:
   - **Say which file the transcript is of.** A pasted image takes the path from
     Codex's own `<image … path="…">` wrapper, a tool result from the
     `view_image` call that asked for it. Without that link the model pays a tool
     turn plus a full resend of the conversation to open a file it has already
     been given — far more than the read cost. That wrapper is markup, not the
     operator's words, so it is stripped from the question sent to the engine.
   - **A tool result inherits the question that led to it**, so a `view_image`
     round trip lands on the transcript the paste already bought instead of
     buying a second one. It is also the only way a *later* question gets a
     freshly focused read, since the question pinned to an image is the one in
     its own message.
12. An image's evidence is **one record per image, not one transcript per
   question**. The question still decides whether a read has to be bought;
   what gets injected is every reading the router holds for that image. Filing
   one transcript per (image, question) and injecting only the matching one made
   the evidence a snapshot of the first question ever asked, which a later
   question could not add to. Keep the record append-only, keep the first
   (general) reading undroppable when the cap bites, and keep the whole record
   inside the budget a single transcript used to have. When one turn carries the
   same image twice — the paste and the `view_image` result — only the first
   slot prints the record; the rest point at it. That pointer is keyed on the
   image, never on matching transcript text: two different screenshots can read
   identically, and "the same image" has to be a fact about the bytes.
13. One image, one purchase. The transcript cache only knows about reads that
   have **finished**, so concurrent requests — Codex sends them, and a subagent
   runs beside its parent — all missed and all bought the same transcript. Reads
   in flight are shared by image, effort, account, and question; waiters take the
   first read's outcome including its failure, and the shared read is never tied
   to one caller's `AbortSignal`, or one client's cancellation would cost a live
   request an image. Reads within a turn run concurrently under a fixed cap: the
   operator waits for all of them before the routed turn starts, but the engine
   is somebody's rate-limited account and must not receive an album as a burst.
14. Never add a local model to `LOCAL_VISION_CATALOG` with an `accuracy` claim
   that was not measured. Run `node src/vision-benchmark.mjs`, which scores a
   model against a checked-in image with known contents, and record the result
   in `measured`; anything unmeasured stays `untested`. This is not bureaucracy:
   `llava` scores 0% and `moondream` 0% on text while sounding entirely
   plausible, so a reputation-based label would route users straight to a model
   that fabricates invoice numbers. The picker sorts on this field, so an
   unearned "accurate" puts a confident-wrong reader at the top of the list.
15. Which native models may read an image is one rule in one place
   (`src/vision-engines.mjs`), not a criterion each surface re-derives. The
   catalog build, the tray, and the request path each asked it separately once,
   and the three answers disagreed — the request path applied no auth gate at
   all. The rule is shared; only the evidence for the gate differs, because just
   one caller can afford to ask Codex directly (`codexAuthStatus()` spawns a
   process) and only the request path holds the caller's live session. Every
   call site names its evidence explicitly, and the coverage below fails when
   one of them stops.
16. The bridge lives on the **routed request path only**. `src/api-forwarder.mjs`
    sits downstream of the gateway — every routed model's `api_base` points at
    it — so Codex's traffic arrives already bridged and an image reaching that
    hop came from a client talking to the gateway directly. It replaces those
    parts with the same stated failure rather than reading them: an engine call
    from there would re-enter the gateway that is holding the request open. The
    substituted part must use the protocol's own text type (`input_text` for
    Responses, `text` for chat completions and Anthropic messages), or an image
    the provider rejects is merely traded for a text part it rejects.
17. Regression coverage lives in `test/vision-bridge.test.mjs`,
    `test/vision-bridge-state.test.mjs`, the bridged-catalog case in
    `test/catalog.test.mjs`, the whole-path measurements in
    `test/vision-bridge-e2e.test.mjs`, and the router cases in
    `test/routing.test.mjs`. A change to engine ranking, caching, substitution,
    the native gate, or the advertisement rule needs a test there. The two
    properties worth stating as tests rather than prose: nothing image-shaped
    may survive into a forwarded body, and one image asked one question may be
    bought only once however many requests are in flight.

## Anonymous remote providers

`authMode: "anonymous"` is not the same as `keyless`. A keyless provider is
loopback-only and serves from this machine; an anonymous provider sends the
operator's prompt to a fixed remote endpoint under a provider-controlled free
model policy. It must never declare a credential, keyless mode, or a base-URL
override, and the registry loader keeps its endpoint allowlisted.

Anonymous providers are **configured but never defaulted**: the credential
resolver may report them as ready, and an explicit `--providers` choice may
route a curated free model, but `defaultProviderIds()`, the no-argument setup
path, `--providers configured`, and `ensure-configured` must not add them when
the operator did not ask. They are catalog-only, so discovery filters the
provider's live `/models` response to its documented free IDs and the user
must curate models locally. Never check in a paid model ID or silently turn on
an anonymous endpoint during installation.

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
- Do not kill unknown processes on ports 4200-4203, or on the Grok OAuth
  forwarder port 4208. The previous 4100-4103/4108 defaults remain valid only
  when explicitly supplied through the port environment variables.
- Do not print or read credential-file contents. Status commands report presence
  and source only.
- Treat the generated `/_codex-router/.../v1` config path as sensitive local
  authentication. Never paste the complete managed base URL into chat or a
  public issue; use the redacted status or support-bundle output.
- Do not delete retained keys, logs, backups, snapshots, or old state
  directories.
- Do not restart or quit the Codex App from the installation task.

## The `codex` shim is opt-in and must never break `codex`

`src/codex-shim.mjs` can put a wrapper named `codex` on the user's PATH so the
router is verified up before Codex starts. Installing a file that shadows a
command the user already has is a change only they may authorize.

1. Never install it from `install.sh`, `install.ps1`, `doctor --fix`, or any
   automatic repair. It ships behind `model-router codex shim install` only.
2. Never write into a PATH directory outside the user's home directory. A shim
   in `/usr/local/bin` changes `codex` for every account on the machine.
3. Never overwrite or delete a `codex` that does not carry `SHIM_MARKER`.
   Another wrapper there is somebody's deliberate setup, not debris.
4. Never edit shell startup files to put the shim on PATH. When no directory
   ahead of Codex is writable, print the `export PATH=...` line and stop.
5. Every failure path in the generated shim must still `exec` the real Codex.
   A stopped router, a deleted checkout, and a gateway that never becomes
   healthy are all recoverable; a `codex` that refuses to start is not. The
   wait is bounded by `MODEL_ROUTER_SHIM_WAIT`, and `MODEL_ROUTER_SHIM=0`
   bypasses the check.

`test/codex-shim.test.mjs` covers each of these. Do not weaken those tests to
land a change.

## Detecting whether Codex is open

Follow mode ("Show tray: With Codex") decides when the tray is visible and, in
that mode, when the router runs at all. Codex ships both as a desktop app and as
an npm CLI, and only the app has a bundle identifier, so
`NSRunningApplication` alone is not an answer: a bundle-only check reported
"Codex is not running" for every terminal session, hid the menu bar item, and
stopped the router 30 seconds into the user's work.

Detection must cover both — bundle identifiers for the apps, and a process-table
scan for the CLI. Keep the scan in `sysctl`; it runs every five seconds for the
life of the session, and spawning `pgrep` on that cadence is a cost the check
does not justify. `apps/macos/ModelRouterTray/Tests/HostProcessDetectionTests.swift`
guards it.

## The macOS app icon is committed, not built during a tray build

`apps/macos/ModelRouterTray/Resources/AppIcon.svg` is the source and
`AppIcon.icns` beside it is the committed output of `scripts/build-app-icon.sh`.
Regenerate and commit both together after editing the SVG. Do not make
`scripts/build-macos-tray-app.sh` rasterize the icon: it would put `sips` and
`iconutil` on the critical path of every tray build for one asset that changes
almost never. Keep the SVG free of `--` inside comments and of SVG filter
primitives — CoreSVG, which is what `sips` uses, rejects the first and silently
drops the second.

## Upstream retries are legal only before the first relayed byte

`src/upstream-retry.mjs` retries a native upstream request a bounded number of
times. One rule governs it, and breaking it corrupts responses rather than
merely failing them.

1. A retry is legal only while **nothing has been relayed**. The loop lives
   entirely before its callers touch their `ServerResponse`, and the `canRetry`
   predicate (`response.headersSent`, checked again before every retry) is the
   backstop. `copyResponseHeaders` only stages values with `setHeader`, so
   `headersSent` flips when Node flushes the head — on the first body write, or
   on `end()` for a bodyless upstream. Never move a retry around
   `pipeResponse`: an upstream that dies mid-stream has already delivered
   bytes, and replaying it appends a second response to a stream the client is
   reading. `test/native-retry.test.mjs` asserts the caller received the partial
   stream exactly once.
2. Only failures where an intermediary never obtained a response qualify: 502,
   503, 504, Cloudflare's 520-524, and connect-level socket errors. Do not add
   429 — it is rate limiting, its `Retry-After` is relayed, and sleeping for the
   upstream's suggested delay is the hang the bound exists to prevent. Do not
   add 4xx, and do not add 500, where the origin ran and a repeat risks a second
   execution.
3. Keep the bound small. Codex retries roughly five times on its own and the
   two loops multiply, so the router's share (2 retries, 250ms then 750ms) has
   to keep the product a fast failure. A retry is also only *started* while the
   request has been cheap so far — a five-second budget, because a 504 the edge
   spent half a minute producing, or a connect timeout, must not be tripled.
   `CODEX_ROUTER_NATIVE_RETRIES`, `CODEX_ROUTER_NATIVE_RETRY_BACKOFF_MS`, and
   `CODEX_ROUTER_NATIVE_RETRY_BUDGET_MS` tune it; `0` disables it.
4. The request body must stay replayable: encode it into a Buffer once, above
   the retry, so every attempt sends identical bytes under the identical
   `Content-Encoding`. Never hand the loop a stream, and never re-run
   `compressedNativeBody` per attempt — headers and body would be free to
   disagree.
5. An abort stops everything at once, backoff included. Pass the caller's signal
   through to both the fetch and the wait.
6. A silent retry is worse than no retry: it makes a flaky upstream look
   healthy. The retry log line is never gated on `CODEX_ROUTER_QUIET`, which a
   production LaunchAgent hard-sets, and the usage event carries `retries` so a
   turn the router rescued is distinguishable from one that never failed. Log
   the status or the transport error's own name and code — never a response
   body, and never the caller capability path.

## Substituting a prompt-token count a provider reported as zero

Codex decides when to compact from the `input_tokens` each response reports, so
a provider that answers a large prompt with an explicit zero disables
compaction entirely and the session runs until the provider rejects the turn.
The router replaces that number on the way to Codex. The rules are narrow on
purpose.

1. Only an **explicit zero** is replaced, and only on a **routed** response
   whose request the router measured as large. A missing usage block, a missing
   prompt field, and any positive count are all forwarded untouched, so a
   provider that reports correctly never sees this path and the substitution
   stops by itself the moment the upstream recovers. Do not widen the predicate
   into "the number looks wrong".
2. The estimate errs **high**. Compaction sits below the provider's hard limit
   (900,000 of 1,048,576 for the affected models, a 14% margin), so an estimate
   that lands low still lets the turn die, while a high one only compacts
   sooner. Do not "improve" the ratio toward accuracy without re-checking that
   margin, and do not add a tokenizer dependency or download for it.
3. Telemetry keeps what the **provider** said. The usage event records the
   reported counts verbatim and adds `estimatedInputTokens` beside them; the
   log line names the substitution. Never fold the estimate into `inputTokens`
   — a run of estimated turns is the evidence that the provider is still
   broken, and an overwritten field would read as a recovery.
4. The response body is otherwise byte-identical, including bytes that are not
   valid UTF-8: the rewrite path forwards the original buffers and re-encodes
   only the one `data:` line it replaces, preserving framing and terminators.
   Do not reintroduce a decoded-text passthrough, which silently rewrites a
   malformed byte to U+FFFD.
5. If a provider is ever added that reports prompt tokens *excluding* cache
   hits, a fully cached turn could report a truthful zero. Substituting there
   is still right for compaction — cached tokens occupy the context window —
   but say so in that provider's registry work rather than discovering it from
   a surprised user.
6. Regression coverage lives in `test/response-usage.test.mjs` and the
   `prompt-token estimate` cases in `test/routing.test.mjs`. A change to the
   predicate, the ratio, or the telemetry needs a test there.

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

## Installing the harness is one action, and it is never a side effect

`dsh-config-manager.mjs` publishes routed models into a harness that is already
there. On a machine without one that assumption is a manual `npm install -g` the
user has to find in the docs, so `src/dsh-install.mjs` owns the other half.

- `control harness setup` installs `@deepseek-ai/dsh` globally if `dsh` is
  absent, then publishes. `control harness status` reports without touching
  anything. The tray's Settings row drives the same command.
- Global, not `npx`. The harness's own README documents `npx @deepseek-ai/dsh
  web`, which refetches per run and leaves no `dsh` behind — and an npx process
  is invisible to `presence-state.mjs`, which has to be able to see the client
  to keep the router up for it.
- Never folded into `apply`, `enable`, or a repair path. It installs a
  third-party package over the network; that must be something a user asked for
  in as many words, not a consequence of something else.
- Node is checked before npm is reached. The package declares no `engines`, so a
  stale runtime otherwise fails at first boot with a syntax error from inside
  `node_modules`. Compare major and minor numerically — `22.9` sorts above
  `22.19` as a string.
- Install then publish, with no rollback between them. A publish that fails
  leaves an installed harness, which is where a retry wants to start, and the
  publish is idempotent so the retry is a re-run of the same call.
- `npm-global-install.mjs` holds the npm mechanics for both this and the
  provider CLIs. One copy, because the details that took a debugging session to
  get right — the PATH a spawn inherits, where npm drops binaries per platform,
  which line of npm's output is worth showing — are exactly what drifts.
- Native GPT models are published only while `codex-native-session.mjs` reports
  a usable session: they need a ChatGPT session, a harness request carries none
  of its own, and the fallback spends the one this machine is already signed in
  with. They are withheld again the moment it is missing or expired. The count
  the button reports is the routable set, not the picker.

`src/dsh-web.mjs` starts and finds the browser UI, so the tray's button can be
`Open site` once there is a site to open.

- Adopt, never collide. The harness binds a fixed port rather than picking a
  free one, so a second launch exits with `EADDRINUSE` and takes the click with
  it. `startDshWeb` probes first and returns `startedNow: false` when something
  already answers.
- Stop only what this router started, the same rule `ollama-runtime.mjs`
  follows. PID plus process start identity are persisted together and both must
  match, because PIDs are reused; `src/process-identity.mjs` holds that check
  for both callers.
- The probe asks whether the port answers, not what is behind it. A 404 from the
  harness's own router is a running harness, and fingerprinting somebody else's
  HTML to be surer would be worse than the ambiguity.
- The port is a setting (`MODEL_ROUTER_DSH_WEB_PORT`), not a constant. `dsh web
  --port` exists, and a user who moved theirs must not be sent to a dead URL.
- Setup does not start the UI. It already installs a package and writes another
  program's configuration; adding a server launch makes one click three
  consequential things, and the last is the one the user can do themselves a
  moment later. Starting is its own button, so a republish never puts a browser
  window on screen that nobody asked for.
- `control --json` must carry the *web-aware* snapshot. It is what the tray
  polls, and the cheap synchronous variant reports no `web` at all, which reads
  as "stopped" and offers to start a harness that is already serving.
- Stopping and disconnecting are different questions, and the row asks whichever
  one currently costs something. While the harness is resident it holds a Node
  process and its plugin tree in memory -- ~184 MB measured -- so the secondary
  action is **Turn off**, which stops the process and leaves the route
  published. Once nothing is running, the only thing left to undo is the
  integration, so it becomes **Disconnect**. A harness this router did not start
  is never signalled; the row says where it came from instead.
- Turning a client off is not a reason to tear the plane down. `bin/disable`
  removes the service only once `installedTargets()` is empty; disabling the
  harness while Codex is still published used to uninstall the LaunchAgent and
  stop Codex working too. `control harness disconnect` is the tray's path and
  never touches the service at all.
- The default model is the user's. Restore only over a default this router
  wrote — the harness's own Models page writes the same key, and a snapshot
  taken before their choice is not a licence to undo it. With no snapshot but a
  router-owned default, remove the key rather than leave the harness pointed at
  a provider the same uninstall just deleted. All three cases are covered in
  `test/dsh-config-manager.test.mjs`.


## Native GPT for a client with no ChatGPT login of its own

Native traffic is authorized by the caller's session: `nativeHeaders` copies
`authorization` and `chatgpt-account-id` off the incoming request, and Codex
attaches both. A harness turn attaches neither, so native models advertised to
it were models it could never spend.

`src/codex-native-session.mjs` closes that by falling back to the session this
machine is already signed in with, in `$CODEX_HOME/auth.json`. The user is
signed in to Codex here; asking them to sign in again for a client running as
the same user on the same machine buys nothing.

- **Fallback, never override.** Injection happens only when the request carried
  no *upstream* credential. Codex always carries one, so a Codex turn is
  byte-identical to before — verified by relaying a deliberately invalid token
  and getting that token's own 401 back rather than a success.
- **"No credential" is not "no header".** The harness authenticates to this
  router with the router's own caller key, sent as a bearer token, because a
  provider route has nowhere else to put one. Testing `!headers.authorization`
  therefore never fired for a real harness turn: the caller key went upstream
  and every turn came back "API key is invalid". Compare the presented bearer
  token against `CALLER_KEY` and `INTERNAL_KEY` and treat a match as no upstream
  credential. When there is nothing to substitute, delete the header rather than
  forward it — a router secret must never leave the machine.
- Test the shape the client actually sends. A curl with no `Authorization`
  header at all passes the naive guard and proves nothing.
- **The native endpoint accepts a narrower request than the public Responses
  API.** `store` must be `false`, `stream` must be `true`, and ten parameters a
  generic OpenAI client sends are rejected one at a time as bare 400s:
  `temperature`, `top_p`, `presence_penalty`, `frequency_penalty`, `max_tokens`,
  `max_output_tokens`, `metadata`, `seed`, `user`, `truncation`. Codex complies
  already, so the payload is normalized *only* for a caller whose session was
  substituted — a Codex turn is never rewritten. `reasoning`, `tool_choice`,
  `parallel_tool_calls`, and `instructions` are accepted and must survive; the
  strip is a denylist for that reason, not a whitelist. Measure any change to
  that list against the live endpoint rather than guessing.
- **Publishable exactly while spendable.** `dshRoutedModels()` includes native
  models only while `nativeSessionAvailable()` is true, so the harness is never
  offered a model that would 401. `visibility: "hide"` entries stay unpublished:
  they are Codex's own internals, a watermarked build and the auto-review model.
- **The credential never leaves the process.** It is not logged, not returned by
  a status call, and not put in an error message. `nativeSessionStatus()` reports
  presence, usability, and age — `test/codex-native-session.test.mjs` asserts the
  serialized status contains neither the token nor the account id.
- **It widens the caller key.** With the fallback on, anything holding that key
  spends the ChatGPT subscription and not only the API-key providers. That is a
  deliberate, user-made tradeoff; `CODEX_ROUTER_NATIVE_SESSION_FALLBACK=0` turns
  it off and the harness silently drops back to routed models only.
- **The access token lives about ten days, and Codex renews it only when Codex
  is used.** A harness-only stretch longer than that would otherwise leave the
  router sending a dead token. `nativeSessionHeaders()` reads the `exp` claim
  and declines two minutes early, so an expired session withholds the headers
  and `dshRoutedModels()` stops publishing native models — the picker loses the
  eight rather than serving certain 401s.
- **Codex refreshes its own credential; this router never does.** Reproducing
  that OAuth exchange would mean guessing an unpublished client identity and, if
  refresh tokens rotate, either rewriting Codex's own file or invalidating the
  login this router was asked not to disturb. `refreshViaCodex()` runs
  `codex login status` instead — best effort, single-flight, at most once every
  five minutes — and lets Codex decide. If nothing renews, the session simply
  reads as expired.
- `doctor` reports it as its own line, because "open Codex once" is the fix and
  nothing else would say so.

## A client the tray cannot watch keeps the router on

The tray's presence setting can tie the router to the Codex and ChatGPT desktop
apps, stopping it 30 seconds after both close. That is only safe for a client
the tray can actually see. `NSRunningApplication` enumerates app bundles, so it
sees the desktop apps and nothing else — a `codex` TUI in a terminal and a `dsh`
harness turn both register nothing at all. Neither can be started on demand
either: a turn that finds 127.0.0.1:4202 closed fails immediately, while the
five-process stack behind that port takes up to 300 seconds to warm, so lazy
start does not exist at request latency. The port has to already be open.

- `effectivePresenceMode()` in `src/presence-state.mjs` is what the tray and
  `doctor` act on. It reports `always` whenever `dsh-models.json` exists or
  `codex` resolves on PATH, whatever the stored mode says. Read it, never
  `readPresenceMode()`, anywhere a service gets stopped.
- Detection errs toward finding a client. A false positive costs a dormant
  toggle; a false negative costs somebody their next request.
- The stored mode is overridden, never rewritten. Removing the harness route or
  the CLI hands the user's own choice back on the next read.
- The router owns the rule and the tray consumes it: `control --json` carries a
  `presence` block, and the tray reads `presence.effectiveMode` rather than
  re-deriving anything from target flags, which is where the two would drift.
  The field is optional in the Swift decoder, so a tray keeps working against a
  router that predates it.
- `test/presence-state.test.mjs` covers both signals, the override, the round
  trip, and the fact that always-on is left alone. A change to the gate needs a
  test there.

## Generated media and scratch output

- Anything a skill, tool, or agent produces that is not source — rendered
  video, images, audio, benchmark dumps, one-off reports — belongs in
  `generated/` at the repository root. That directory is gitignored, so the
  working tree stays clean and nothing large lands in a commit by accident.
- Do not add per-extension ignore rules (`*.mp4`, `*.png`) for this. They also
  hide checked-in assets such as tray icons and documentation screenshots.
- Files that are meant to ship — icons, fixtures, docs assets — go in their
  real home under version control, not in `generated/`.
