# Changelog

## Unreleased

- **GLM-5.3, on every route that actually serves it.** Z.ai shipped GLM-5.3 on
  2026-08-14. It is now in the picker three ways: `zai-coding/glm-5.3` on the
  GLM Coding Plan subscription, `zai-api/glm-5.3` on the metered platform, and
  `opencode-go/glm-5.3` on the opencode Go subscription, whose catalog already
  advertises it (`./bin/discover-models opencode-go`). Command Code, Qwen Plan,
  Ollama Cloud, and ClinePass do not carry it yet, so nothing was added there.

  Z.ai documents the 1M context window for GLM-5.3 only behind the `[1m]` model
  suffix, so that is a separate entry — `zai-coding/glm-5.3-1m`, which sends
  `glm-5.3[1m]` and a one-million-token compaction window. The suffix-free
  entries stay at the 200K lineage default rather than inheriting GLM-5.2's 1M,
  because under-declaring a context window compacts early and over-declaring
  overruns the turn.

- **A Z.ai key now means one of two different things, and the router keeps them
  apart.** `zai-api` is a new provider for the metered open platform on
  `https://api.z.ai/api/paas/v4`, carrying GLM-5.3, GLM-5.2 (1M context), and
  the cheaper GLM-4.7. It ships GLM-5.3 and GLM-5.2 with the same reasoning
  ladders as the plan route, and GLM-4.7 with none, because Z.ai documents no
  effort control for it.

  It is a separate credential end to end: its own key file
  (`zai-api-key.secret`), its own keychain service, and its own environment
  variable (`ZAI_PLATFORM_API_KEY`) — never the plan's `ZAI_API_KEY`. A Coding
  Plan key is not billable on the metered endpoint and vice versa, so a
  `planNote` says so wherever a key is connected, and the account panel links
  the billing page instead of polling the plan quota route with a key that has
  no plan behind it.

- **GLM reasoning effort follows the model, not the vendor.** The `glm-thinking`
  request profile mapped every multi-tier GLM onto GLM-5.2's two rungs
  (high/max), which would have silently rounded GLM-5.3's new `low` tier up to
  `high` and billed deeper thinking than was asked for. The requested effort is
  now clamped onto the ladder each model's own registry entry declares.

- **DeepSeek Harness can use the Codex models you are already signed in to.**
  Native GPT traffic is authorized by the caller's own ChatGPT session — the
  router copies `authorization` and `chatgpt-account-id` off each request, Codex
  attaches both, and a harness turn attaches neither. So the eight native models
  were withheld from the harness: advertising them would have offered a turn
  that could not authenticate.

  The router now falls back to the session this machine is already signed in
  with. You are logged in to Codex here; a client running as the same user on
  the same machine should not have to log in again. The eight `gpt-5.6-*` and
  `gpt-5.x` models publish to the harness whenever that session is usable, and
  are withheld the moment it is not, so the picker never offers a model that
  would 401.

  It is a fallback and never an override: the injection happens only for a
  request that carried no credential of its own, so a Codex turn is unchanged —
  verified by relaying a deliberately invalid token and getting that token's own
  401 back instead of a success. The credential is never logged, never returned
  by a status call, and never put in an error message.

  The session is checked for life, not just presence. That access token lasts
  about ten days and Codex renews it only when Codex is used, so a harness-only
  stretch longer than that would have left the router sending a dead token. An
  expired session is declined two minutes early, native models stop being
  published while it is dead, and `doctor` gains a line saying to open Codex
  once — which is the fix, and which nothing else would have told anybody.
  Renewal is left to Codex: reproducing that OAuth exchange would mean guessing
  an unpublished client identity and risking the very login this was asked not
  to disturb.

  Worth knowing before leaving it on: it widens what the caller key reaches,
  from the API-key providers to the ChatGPT subscription as well.
  `CODEX_ROUTER_NATIVE_SESSION_FALLBACK=0` turns it off, and the harness drops
  back to routed models only.

- **The tray can install DeepSeek Harness, not just publish into one.**
  `--target dsh` wrote routed models into a harness the user had already
  installed themselves; on a machine without one, the missing step was an
  `npm install -g` mentioned in passing in the docs. A Settings row now installs
  `@deepseek-ai/dsh` and publishes in one click, and `control harness
  status|setup` does the same from a terminal.

  Global rather than the `npx @deepseek-ai/dsh web` the harness's README
  documents: npx refetches on every run, leaves no `dsh` to type again, and is
  invisible to the presence rule that keeps the router up for clients it cannot
  watch. Node is checked against the harness's floor before npm is reached,
  since the package declares no `engines` and a stale runtime otherwise fails at
  first boot with a syntax error from inside `node_modules`. Install and publish
  are ordered but not transactional — a failed publish leaves an installed
  harness, which is where a retry wants to start, and republishing is
  byte-identical. The npm mechanics move to `src/npm-global-install.mjs`, shared
  with the provider-CLI installs rather than copied.

  It is never a side effect: no `apply`, `enable`, or repair path installs the
  harness. The model count the button reports is the routable set, not the
  picker — native GPT models come and go with the Codex session described
  above.

  The row then runs the harness's browser UI: **Install**, then **Connect**,
  then a play button, then **Open site**, each shown only in the state it
  applies to. Publishing models and leaving somebody to remember a command and a
  port was the step this action existed to remove, so the play button starts the
  UI and the row reports the URL it is serving. Setup itself deliberately does
  not start anything — it already installs a package and writes another
  program's configuration, and a republish should not put a browser window on
  screen nobody asked for.

  A running server this router did not start is adopted rather than collided
  with — the harness binds a fixed port, so a second launch exits with
  `EADDRINUSE` — and only a process this router started is ever signalled,
  matched on PID *and* process start identity because PIDs are reused.

  It can also be turned off again, which it could not safely be before.
  `bin/model-router dsh disable` ran `service.mjs uninstall` unconditionally, so
  switching the harness off removed the LaunchAgent and stopped Codex working
  too — the service is one shared plane, and one client leaving is not a reason
  to retire it. `bin/disable` now removes it only once no client integration
  remains, and the tray's **Turn off** goes through `control harness disconnect`,
  which stops a UI this router started, removes the route, and touches nothing
  else: the CLI, the harness's own settings, its other providers, and the
  service all stay.

  Two ways the uninstall could damage a user's own configuration are fixed with
  it. Restoring the default model overwrote whatever was there with the snapshot
  taken at install — so a model chosen afterwards through the harness's own
  Models page was silently discarded; the restore now applies only over a
  default this router wrote. And with no snapshot left to restore, a
  router-owned default was left in place pointing at the provider the same
  uninstall had just removed; it is now taken out.


- **A client the tray cannot watch keeps the router running.** The tray's
  presence setting could tie the router to the Codex and ChatGPT desktop apps
  and stop it 30 seconds after both closed. `NSRunningApplication` enumerates
  app bundles and nothing else, so that setting could only ever see those two:
  a `codex` TUI in a terminal and a `dsh` harness turn are both invisible to it.
  Neither can be started on demand either — a turn that finds 127.0.0.1:4202
  closed fails at once, while the stack behind that port takes up to 300 seconds
  to warm — so a terminal user who tried the setting got a dead port and a
  `doctor` line telling them to open an app they may not use.

  `effectivePresenceMode()` now reports `always` whenever the harness route is
  published or `codex` resolves on PATH, and the tray and `doctor` both act on
  that instead of the raw mode. Detection errs toward finding a client: a false
  positive costs a dormant toggle, a false negative costs somebody their next
  request. The stored preference is overridden rather than rewritten, so
  removing the client restores the user's own choice. `control --json` now
  carries a `presence` block so the router owns the rule and the tray consumes
  it rather than re-deriving it, and the tray picks up a change on the snapshot
  it already polls.

- **DeepSeek Harness is a supported target.** `--target dsh` publishes every
  routed model into the harness's own `settings.yaml` as one provider route,
  keyed to the same `/v1/responses` endpoint Codex already uses — so a harness
  turn gets the router's tool-result ageing, vision bridge, prompt-token
  substitution, bounded upstream retries, and tokens-per-second accounting
  without a second request path. The harness's shipped bundle mounts
  `dsh-llm-pi-ai` dormant and hot-reloads its settings document, so this is a
  settings write rather than a plugin change and there is nothing to restart.
  A target is a *client*, not a router: both share one service, one gateway,
  one credential store, and one provider selection, so adding the second
  integration never asks for a key again, and any change to the routable set
  republishes whichever clients are installed rather than letting the two
  drift apart.

  The router owns exactly one key in each of the harness's two documents
  (`llm-pi-ai.providers.codex-router` and `CODEX_ROUTER_CALLER_KEY`) and treats
  every other byte as somebody else's: sibling routes, other sections,
  comments, and other credentials survive a publish, and `dsh disable` restores
  the document. A settings file the new fail-closed YAML lexer cannot read
  unambiguously — a tab indent, a duplicate key, a multi-document stream, an
  inline `providers` mapping — is refused with the file untouched and the line
  named, rather than rewritten on a guess. Both documents are written 0600, the
  same bound the harness holds them to, because the settings document carries
  the managed base URL and the other carries the key it references.

  Only selected, credentialed, listed, non-hidden routed models are published.
  Native GPT models are not: they need the caller's own ChatGPT session, which
  a harness request does not carry, so advertising them would offer a turn that
  cannot authenticate — the same reason the vision-bridge engine candidates
  exclude them here. Taking over the harness's default model is opt-in,
  snapshotted, and reversible; delegation stays the user's, since
  `dsh-tool-subagent` is composition rather than settings and
  `./bin/model-router dsh subagent-preset` hands over the block to paste
  instead of editing a preset the router does not own.

- **`src/skills-install.mjs` no longer hijacks an unrelated `install`.** Its
  CLI block ran on `process.argv[2]` alone with no entry-module guard, and
  `install-manifest.mjs` imports it — so any command that transitively pulled
  the manifest in while its own subcommand happened to be `install` or
  `uninstall` installed the Codex skill pack and exited 0 before doing its own
  work. Every other module in the repository already guarded this; this one
  now does too.

- **Command Code's catalog caught up, and one dead route fixed.** The Messages
  route advertised Haiku 4.5 as `claude-haiku-4-5`, the undated alias every
  other Anthropic surface accepts. Command Code's catalog does not carry it —
  only the dated `claude-haiku-4-5-20251001` — so that route could never have
  resolved, and it was the one registered id in either reseller family absent
  from the live `/models` list. A registry assertion now pins the dated id.

  Fourteen models Command Code serves and the registry did not are now checked
  in: `grok-4.6`, `claude-opus-5`, `gpt-5.6-sol`, `gpt-5.6-terra`,
  `gemini-3.7-flash`, `GLM-5.2-Fast`, `Kimi-K2.7-Code-Highspeed`,
  `Qwen3.7-Flash`, and first entries for five vendors the reseller added since
  the last sweep — `meta/muse-spark-1.2`, `nvidia/nemotron-3-ultra`,
  `sakana/fugu-ultra`, `thinkingmachines/inkling` and `inkling-small`, and
  `poolside/laguna-s-2.1`. Context windows come from Command Code's own
  `/models` payload rather than the model name; effort ladders, image support,
  and request profiles mirror the already shipped sibling of the same upstream
  line, or fall back to the conservative single-`high` floor for a vendor with
  no prior entry. Older point releases the catalog still lists behind a
  registered newer sibling (GLM-5/5.1, Kimi K2.5/K2.6, MiniMax-M2.5,
  Qwen3.6, Step-3.5, gemini-3.1/3.5-flash-lite, gpt-5.3/5.4, mimo-v2.5) stay
  out deliberately; `bin/curate-models commandcode` still reaches them per
  user.

  These fourteen route correctly — a live request reaches Command Code and
  comes back with the account's own plan verdict — but their capability
  metadata is **not** live-verified: the test account is on the Go plan, which
  answers every Provider API call with "Your Go plan doesn't include API
  access." That blocks the tool-calling, streaming, and compaction probes for
  the twenty-one models already shipped just as much as for the new ones. Run
  `./bin/test-model 'commandcode/SLUG' --live --yes` on a Provider-plan account
  before treating any of them as proven.

  opencode Go needed no additions. All seven ids its catalog lists and the
  registry omits (`glm-5`, `kimi-k2.5`, `minimax-m2.5`, `qwen3.5-plus`,
  `mimo-v2-pro`, `mimo-v2-omni`, `hy3-preview`) are older releases or preview
  channels of models already registered, and every registered opencode Go id
  is still live.

- **Windows installs the tray companion, and keeps it.** Nothing on Windows
  ever built or started it: `install.ps1` had no tray option at all, the
  installer's own decision helper excluded the platform outright, and
  `control tray enable` answered `{"supported":false}` and exited 0 — a silent
  no-op that reads as success while no tray was ever going to appear. The only
  route was knowing to run `scripts/build-desktop-tray.ps1` by hand, and even
  then the companion vanished at the next reboot. `install.ps1 -WithTray` (and
  `-NoTray`, matching `install.sh`) now builds it and registers a `Codex Router
  Tray` logon task, kept separate from the router's own task so stopping one
  never takes the other down. Quitting from the tray menu stays quit: the
  restart setting covers a crash, not a clean exit. A platform with no
  supervisor now says so on stderr rather than reporting success, and the
  guidance names the `^` overflow that hides new tray icons on Windows 11.

- **Windows stops mistaking its own spawn failures for provider problems.** A
  command resolved on Windows and a command Windows can spawn are two different
  things: `where.exe` lists the extensionless npm shim first, and Node has
  refused to run a `.cmd` shim without a shell since CVE-2024-27980. Four
  copies of the same lookup helper took line one anyway, and the spawn errors
  that followed were each read as something else. The official Grok CLI was the
  worst of it — a healthy npm install failed to launch, raising the same
  `spawn UNKNOWN` that Smart App Control raises, so the router announced that
  Windows application control had blocked it and told the operator to give up
  on OAuth and use an API key. Even had the preflight passed, the token refresh
  behind it spawned the shim the same unusable way.

  Resolution and launching now live in one module and are used everywhere:
  the routed-subagent proof run (which hands Codex a whole sentence, so it
  cannot go through a shell that joins arguments on spaces), the Codex account
  usage panel, the doctor's Codex configuration probe, the `npm install -g` and
  sign-in paths for provider CLIs, and the precedence probe. Arguments are
  escaped for `cmd.exe` rather than concatenated, so a path under
  `C:\Program Files` and a prompt containing spaces both survive.

- **Three more Windows-only breakages in the same family.** The Codex account
  usage panel kept a private two-line search for the CLI — an undocumented
  environment variable, a macOS-only path, then the bare name — which finds
  nothing on Windows, so the panel reported "the Codex app-server could not be
  started" on every machine; it now uses the shared discovery and kills the
  process tree rather than leaking a Codex process per poll. `control apply`
  ran the POSIX `bin/enable` script, which Windows cannot execute, and now
  takes the PowerShell installer that `doctor --fix` already uses. The
  vision-model download worker was the one detached child without
  `windowsHide`, so it opened a console window for the length of a
  multi-gigabyte pull.

- **A local Ollama the router could find is one it can also run.** The vision
  host probed for Ollama through the runtime's known install locations but then
  spawned the bare name, so a Windows install under `%LOCALAPPDATA%` reported
  as available and failed at the next call. Both now use the same resolver.

- **Routed models that emit integer tool arguments as JSON floats no longer
  get those calls rejected by Codex.** Grok 4.6 was sending
  `timeout_ms: 20000.0`; Codex's native `shell_command` schema wants a `u64`,
  so every agentic turn died before the command ran. The response rewrite now
  turns whole-number tokens into integers on the way back, including native
  tools that are not namespaced. Genuine fractions are left alone.

## 0.4.0-beta.3

- **The usage panel shows what is left of your plan for xAI OAuth, MiniMax,
  Command Code, and opencode Go.** MiniMax reads its coding-plan remains
  endpoint (interval and weekly windows), Command Code reads the same billing
  credits route its official CLI polls (5-hour and weekly windows), and
  opencode Go reads its usage endpoint (rolling, weekly, and monthly windows,
  shared across the protocol variants). A fresh xAI weekly window arrives with
  its zero usage omitted from the wire format, which used to read as
  "unavailable" instead of everything left — a billing period with no percent
  now reads as 0% used. Every fetcher refuses to send the credential anywhere
  but the provider's own host, and any failure degrades to the previous
  router-traffic view.

- **The subagent list shows only models you can actually pick.** Hidden models
  rendered as permanently locked rows; they are filtered out, with a note
  giving the hidden count and pointing at the picker section that brings them
  back. Toolbar labels name the setting they change, both surfaces note that
  subagent choices never hide models from Codex's picker, and the tray's two
  look-alike provider panels no longer expand in lockstep.

- **A failed request names its cause all the way down.** The transport reports
  every connection-level failure as a bare `TypeError: fetch failed` with the
  code that says why buried on the cause chain, which left repeated native
  failures unexplainable from the retained log. The router and every forwarder
  now log the whole chain — names and codes only where a failure can wrap
  upstream response text. Name-resolution and local-resource failures
  (`ENOTFOUND`, `EADDRNOTAVAIL`, `ENOBUFS`) joined the retryable set, since
  all three fail before a connection exists. Every native failure now records
  a usage event, so a 502 without one can no longer hide inside the router,
  and an uncaught crash exits with its own code (95/94) and full chain in the
  log, so a supervisor's exit line alone distinguishes an in-process crash
  from an external kill.

- **One union-rooted tool schema no longer kills every xAI OAuth turn.** xAI
  rejects the whole request when any tool's parameter schema roots in an
  `anyOf`/`oneOf`/`allOf` union, and Codex's own automation tool ships one —
  so a Grok session that never touched automations still died on its first
  message. Union roots are flattened into a single object schema (branch
  properties merged, `required` narrowed to what every branch demands) and
  object-rooted schemas pass through untouched.

- **GitHub Copilot is available as a catalog-only provider.** A
  fine-grained PAT with the Copilot Requests permission is validated through
  the Copilot account endpoint; account-selected inference hosts are restricted
  to GitHub-owned Copilot hosts, and account routing is refreshed once on a 401
  before any bytes are relayed. Live discovery exposes only
  account-visible Responses models that advertise streaming and tool calls, so
  plans and organization policy remain authoritative. Setup, doctor, both tray
  implementations, quota reporting, curation, and credential redaction all use
  the same provider path. Account discovery keeps GitHub authoritative as its
  model and inference interfaces evolve.

- **The reader is asked what you actually want to know, and asked again when
  that changes.** The question used to be pinned to the image's own message, so
  an image's reading was fixed by the first thing ever asked about it. Paste a
  photo, ask "what is this?", and a reader under orders to describe rather than
  identify answered "a lake at dusk" — after which the model went to the
  filesystem, then to reverse image search, and uploaded the screenshot to a
  public image host to get an answer the vision model could have given in a
  line. Now the newest image follows the newest question.

  It is still bought once per *question*, never once per turn, so Codex
  resending the whole conversation between turns costs nothing — and only the
  newest image follows the conversation, so a chat holding ten screenshots
  cannot turn one new question into ten new reads. Earlier readings are kept, so
  the answer to your first question is still in front of the model when you ask
  your second.

- **The reader may say what something is.** A new `## Identification` section:
  the place, product, application, chart type, or well-known image it
  recognizes, with its confidence and what in the picture supports it. It is
  the one section where inference is allowed — `## Text` stays verbatim, and an
  unrecognizable image says `(unrecognized)` rather than guessing.

- **One unreachable engine no longer costs you the image.** Resolving an engine
  and reaching it are different questions, and the bridge conflated them: a
  pinned engine that resolved and then answered 401 because a session lapsed,
  or 503 because the provider's endpoint was down, left every paste degrading
  to "could not be read" until somebody noticed. Both happened within an hour of
  testing. The reader is now a short list — your chosen engine first, then the
  other credentialed vision models — and the image is offered to the next one
  when the first cannot be reached. Verified live with a genuinely dead engine
  pinned first: all ten test images were still read.

  Nothing extra is spent when your engine works, since a second engine is only
  called after the first has failed. It is not silent: the evidence names
  whichever engine actually did the reading and the log line records the
  fallback. A pin that does not resolve at all is still an operator-visible
  problem rather than a quiet switch, and a pinned local engine never falls back
  onto a provider's quota you did not choose to spend. Another provider is tried
  before another attempt at a broken one, which cut a degraded read from 30–52s
  to 12–35s.

- **A read that fails once is asked again.** The engine is a rate-limited
  account across a network, so a 429, a 502, a reset connection, or an empty
  reply used to cost you that image for the whole turn. Those are retried twice,
  250ms then 1s. A refusal is not: 400, 401, 403 and 404 buy the identical
  refusal a second time, and a timeout is reported rather than retried, because
  the per-attempt budget is already two minutes. A local engine that is down
  still reports the transport's own words, which is how you learn your own
  server is not running.

- **The gateway no longer installs a cryptography with a known advisory.**
  litellm 1.95.0 required `cryptography>=48.0.1,<49.0`, and the fix for
  GHSA-g6cj-pr64-35w5 — a Bleichenbacher oracle reachable through PKCS#7
  EnvelopedData decryption — landed in 50.0.0, so the patched version could not
  be resolved at all while that pin was held. litellm moves to 1.96.0, which
  allows `cryptography>=49.0.0,<51.0`, and the lock now carries 50.0.0. Nothing
  else moves except `litellm-enterprise`.

  The fastapi cap stays at 0.139.2. litellm 1.96.0 declares `fastapi<1.0` but
  still imports `get_flat_dependant`, which 0.140 removed, so a resolve that
  looks clean produces a gateway that dies on startup — verified by booting the
  proxy on both pins rather than by trusting the resolver. macOS installs get
  faster as a side effect: 1.96.0 publishes macOS wheels, where 1.95.0 had to be
  built from the sdist with a Rust toolchain.

- **An image the model fetched for itself is read too.** The bridge walked user
  messages only, so a pasted screenshot was transcribed and the turn still
  failed: the paste carries the file's path as text, the text-only model
  reached for Codex's `view_image` tool on it, and the tool result came back
  holding the same megabytes of image the bridge had just paid to read. The
  provider rejected the whole conversation (`unknown variant image_url`) with
  no mention of an image. Tool results are now read on the same terms as
  messages — and for the question that led to them, so the second read of the
  same screenshot is served from the transcript cache rather than bought again.
  Text-only models can now read image files on disk as well as pastes, which
  fell out of the same fix.

- **A transcript says which file it is of, so the model stops fetching what it
  already has.** A paste carries the image and its path, and nothing connected
  the two: the model was handed a full reading and then spent a tool call and an
  entire resend of the conversation opening the file itself — far more than the
  read cost. The evidence header now names the path and says the reading is
  complete. Codex's `<image …>` wrapper is markup rather than anything you
  asked, so it no longer travels to the vision engine as part of your question.

- **One image asked one question is bought once, however many requests are in
  flight.** The transcript cache only knew about reads that had finished, so
  concurrent turns — Codex sends them, and a subagent runs beside its parent —
  all missed and all paid. Measured on a real install: one pasted screenshot,
  two overlapping reads, three seconds apart. Reads now share, and the images in
  one turn are read concurrently under a cap rather than one after another, so a
  turn with five screenshots waits for the slowest instead of the sum.

- **What the router knows about an image accumulates instead of resetting.** A
  transcript used to be filed under the question that bought it, and only that
  one was ever injected — so an image's evidence was a snapshot of the first
  thing you asked about it. Ask "what colour is this?" and a later "what does
  the text say?" got the colour-focused reading back, with no way to ever add to
  it. The record is now per image: a later read appends, and every turn sees
  everything the router has learned about that picture. Records are capped, and
  the first, general reading is never the one dropped.

  The same image appearing twice in a turn — the paste and the tool result that
  fetched it — now prints its reading once, with the second slot pointing at the
  first. That is keyed on the image itself, never on transcripts that happen to
  match, so two screenshots that read alike are still two images.

- **An image sent straight to the gateway no longer dies at the provider.** The
  API forwarder sits downstream of the gateway, so Codex's own turns arrive
  already bridged — but a client talking to the gateway directly could hand a
  text-only model an image and get back a 400 naming a JSON variant, which reads
  as a router bug. Those parts are now replaced with a stated failure that says
  where the bridge actually lives. Reading them there is deliberately not
  offered: the engine call would re-enter the gateway holding that very request.

- **An incomplete reading says so.** A transcript that came back missing its
  required sections, or truncated at the router's size limit, is labelled as
  partial — and that is the only time the model is told it can look again. Left
  unsaid, a model cannot tell "the image does not show that" from "the
  transcript does not mention it", and it answers the first with confidence
  either way.

- **A text-only model reads a pasted image with no configuration.** The vision
  bridge is now on by default: paste a screenshot into DeepSeek, GLM, or Kimi
  and it is transcribed by the cheapest vision-capable model you have already
  enabled — or by your signed-in ChatGPT plan — instead of silently doing
  nothing until you discovered a toggle. An install with nothing to read images
  with behaves exactly as it did before: no engine resolves, the picker keeps
  saying text-only, and Codex keeps refusing the paste.

  Turning it off is permanent. The state file's *presence* is what separates
  "never configured" from "configured off", so a stored `enabled: false` is
  never re-enabled by this change or any future one, and a state file this
  build cannot parse falls back to off rather than to the new default. The
  installer no longer writes bridge state at all; it only reports what will
  happen.

  Two things it will not do on its own. It never picks an engine served from
  your own machine — the pinned `local` engine, or a model from the keyless
  `local` provider — because your runtime may not be running and that would
  fail every paste; pin one and it is used gladly. And it no longer spends
  quota invisibly: every read that misses the transcript cache records a usage
  event naming the engine it was billed to, and the per-turn log line is no
  longer suppressed on an unattended service. A ChatGPT-plan engine's quota is
  still not reflected in the tray's limits.

- **A curated model can say it refuses a forced tool choice.** A few upstreams
  call tools happily when `tool_choice` is `"auto"` and answer HTTP 400 when
  one is required, so the compatibility check reported no tool support and the
  routed-subagent handoff failed on a model whose tool calling was fine. The
  vendor profiles already covered DeepSeek and Qwen on their own endpoints;
  reached through a reseller like OpenRouter the same model had nowhere to
  declare it, because those providers ship no registry models to inherit a
  profile from. Curation now asks, and stores `auto-tool-choice`
  (`--request-profile auto-tool-choice` in the `--models` form), which
  downgrades the forced choice for that model and touches no other parameter.
  It stays per model on purpose: OpenRouter reports `tool_choice` support per
  model in its own catalog, so downgrading for a whole reseller would let
  models that honor a forced choice quietly decline both the probe and the
  subagent relay's forced function call. The probe itself still sends
  `required`. Thanks to @jepgambardella for the report.

- **An upstream failure that happens before any response byte is retried once
  or twice instead of being relayed.** ChatGPT's edge intermittently answers a
  native turn with a 503 whose body is "upstream connect error or
  disconnect/reset before headers"; a live usage log recorded Cloudflare 520s
  in the same window. The 503 is upstream and still is — but "before headers"
  means nothing was ever served, so the router now sends the request again
  rather than handing Codex a 5xx and spending one of its five reconnects on a
  failure a quarter of a second would have absorbed. Two retries at 250ms and
  750ms, so a genuinely dead upstream still fails in about a second rather than
  hanging. Only the statuses that mean an intermediary never got a response
  (502, 503, 504, and Cloudflare's 520-524) and connect-level socket failures
  qualify: a 429 is relayed with its `Retry-After` intact, every 4xx is
  relayed, and a 500 is left alone because the origin ran. A retry only starts
  while the request has been cheap so far, so a 504 the edge spent half a
  minute producing is relayed rather than tried twice more. Nothing is ever
  retried once a byte has reached the caller, which would duplicate the stream.
  A caller that disconnects stops the retries immediately, including during the
  backoff. Retries are logged whether or not the service is quiet, and recorded
  on the usage event, so an upstream that is being papered over still looks
  flaky in the telemetry instead of healthy.

- **A provider that reports no prompt tokens no longer disables compaction.**
  Codex decides when to auto-compact from the `input_tokens` each response
  reports. opencode's Go endpoint stopped reporting them for its DeepSeek V4
  models, so the context counter never climbed, compaction never fired, and
  sessions ran until the provider itself refused the turn — one captured turn
  carried 1,050,034 tokens against a 1,048,576-token limit, with the context
  bar still showing nearly empty. When a routed response now explicitly claims
  zero prompt tokens for a request the router just measured as large, the
  router substitutes an estimate of the prompt it sent, so Codex compacts on
  time. The estimate errs high on purpose: compaction sits 14% below the hard
  limit, so an estimate that lands low would let the turn die anyway, while a
  high one only compacts sooner. Nothing else is touched — a provider that
  reports correctly, a response with no usage block, and native traffic all
  pass through byte for byte, and the substitution stops by itself once the
  upstream starts reporting again. It is never silent: the usage event keeps
  the provider's own counts and adds `estimatedInputTokens` beside them, and
  the turn logs `estimated-input-tokens=<count>`, so estimated turns can never
  be mistaken for the provider having recovered.

- **You can now see which local models to download.** Installing one required
  knowing its tag by heart: the tray's only entry point was a free-text field,
  and every command took a tag as an argument, so anyone who had never
  installed a local model had nowhere to start. `local-models list` and the
  tray's Local LLMs panel now offer a shortlist rated against this machine's
  memory, with tool support stated per entry — it decides whether Codex can
  drive the model at all, and several popular coding models turn out not to
  have it. Anything already downloaded drops off the list. `list` also renders
  for a person now instead of printing one long JSON line; `--json` keeps the
  machine-readable form.

- **A local model is now checked against the machine before it downloads.**
  Installing one asked whether Codex could drive it but never whether the
  machine could run it, so a 65 GB pull could finish on a laptop that can never
  load it. The registry manifest already carries the size, so the same lookup
  now also rates fit against detected memory — unified memory on Apple Silicon,
  GPU memory where NVIDIA reports it, system RAM otherwise, allowing ~20% above
  the weights for context and cache. `inspect` reports `fits`, `tight`, or
  `too-large`; `install` refuses a `too-large` model before transferring
  anything unless `--yes` overrides it, and warns on a `tight` one.

- **The doctor stopped telling the local provider to store an API key.** Its
  provider loop labelled every row "<name> key" and offered `provider-key ...
  set` as the fix — a command the keyless local provider refuses. The
  empty-picker warning also claimed a "key stored" that never existed and
  pointed at `curate-models`, which is the remote-catalog flow rather than the
  download-and-check one local models use. The row is named for the endpoint
  now, and both fixes name commands that work.

- **The macOS tray lists every provider, not just the ones already working.**
  Its Providers section built rows by grouping the models in the picker, so a
  provider shipping none had no row — hiding the local provider and all ten
  catalog-only services in the one place built to configure them. Rows now come
  from the router's registry snapshot.

- **The Windows and Linux tray can toggle providers added after it shipped.**
  Its provider allowlist was a hardcoded six-entry list, so everything added
  since — the local provider included — failed with "Unknown provider." It now
  validates the id's shape and lets the registry decide what exists.

- **Windows no longer opens a console window at logon.** The scheduled task ran
  the CMD wrapper through `cmd.exe`, so a console window appeared at every logon
  and stayed for the router's lifetime, reappearing on each watchdog restart.
  The task now runs a generated VBS launcher under `wscript.exe //B //NoLogo`,
  which starts the wrapper hidden and waits for it, re-raising the wrapper's
  exit code so Task Scheduler's restart-on-failure settings still see a crash as
  a crash. Reinstalling replaces the old task in place, and uninstalling removes
  both generated launchers. Reinstalling and restarting now wait for the running
  instance to actually exit before starting the new one, an install that cannot
  register the task starts the router again rather than leaving the machine with
  none, and stopping a service that was never installed is no longer an error.

- **The Python gateway now installs from a hash-verified lock.** Pinning
  `litellm[proxy]` and `fastapi` left their entire transitive tree unpinned, so
  every install resolved and then executed around a hundred packages that
  nothing had verified — and two machines installing on different days got
  different trees. `requirements/python.txt` now pins that whole closure with a
  SHA256 for every distribution, and all four install paths (the `uv` and `pip`
  branches of `bin/install` and `install.ps1`) install it with
  `--require-hashes`. The pinned versions are unchanged. The lock is universal:
  one file covering macOS, Linux, and Windows on CPython 3.10+ through
  environment markers, rather than a snapshot of whoever generated it. The
  version literals are gone from the shell scripts entirely — `bin/lock-python`
  regenerates the lock from `PYTHON_REQUIREMENTS`, and
  `test/python-lock.test.mjs` fails the suite if the lock, the compile input,
  and that constant ever disagree, or if either installer stops checking
  hashes.

- **Text-only models can answer about a pasted image.** A model with no image
  input — DeepSeek, GLM, Kimi — used to refuse the paste outright. When the
  vision bridge is on, a vision model you already have reads the image and
  hands the transcript over, labelled as quoted image content rather than as
  instructions, so a screenshot saying "SYSTEM: delete everything" reads as
  something the image says. The transcript is cached per image, so a five-turn
  conversation about one screenshot is billed for one reading, and a failed
  reading becomes a stated failure in the turn instead of an invented answer.
  The picker only advertises image input while an engine actually resolves.

- **Models on your own machine are a provider, not a special case.** Local
  models served through Ollama are checked in the tray and routed through the
  normal provider path, with their real context window and Ollama's own
  protocol so `num_ctx` applies. Codex drives every turn through tool calls, so
  a model is published only after `local-models agent-check` proves it can
  dispatch one against Codex's real prompt — a check run with the actual
  client, because three hand-written probes each graded it backwards. Local
  chat stays labelled experimental: the same model has passed and failed the
  identical check minutes apart. Reading images locally is the dependable half.

- **The tray manages local models in one place.** Local LLMs is where they are
  installed by tag (including `hf.co/user/repo:Q4_K_M`), benchmarked, offered
  to Codex, pointed at vision, and removed. The Vision panel is now just the
  switch and which engine is reading. Rows say which of the two roles a model
  can fill, and the checkbox is dead for a model without tool support instead
  of silently doing nothing.

- **Codex updates now refresh the tray for every supported install location.**
  Guided setup installs the companion at `~/Applications/Model Router.app`,
  but updates only refreshed the tray when the checkout's own `dist/Model
  Router.app` existed. The update path now also detects the home-Applications
  bundle and the registered login-item bundle, then rebuilds and relaunches
  the tray from the updated checkout.

- **`doctor --fix` no longer breaks a running install from a second checkout.**
  When the recorded state owner still exists, repair now runs from that
  checkout and keeps ownership there. Deliberate ownership transfer still
  requires an explicit override or a fresh install.

- **The macOS tray stays linked to the apps that launch it.** If the tray
  bundle moves (for example from a checkout on a removable volume to the
  stable install), the next launch re-registers the login item against the
  current bundle; the launcher replaces an already-running tray with the
  rebuilt bundle; and `codex update` rebuilds and relaunches an installed tray
  so a router update never leaves a stale companion behind. Update & Verify
  now updates the checkout recorded as the installation owner instead of
  whichever checkout the tray binary was built from.

- **A busy machine no longer fails startup on services that are working.**
  Each health probe was abandoned after a flat second, and a probe we gave up
  on counted exactly like a refused connection. Under the fork and exec
  contention of a login — when a build or a sync starts at the same moment as
  the router — a forwarder that had printed `listening` at 1.4 s answered every
  probe later than that, so all of them aborted, the budget ran out, and
  startup reported `Timed out waiting for API forwarder to become healthy`
  about a service that was fine. The probe window now widens from 1 s to a 10 s
  cap, and the two outcomes are told apart: nothing listening on loopback
  refuses instantly, so a refusal still backs off (a cold-starting gateway must
  not flood its own access log), while an abort is retried at once with a wider
  window, because the window it already spent is backoff enough and gives no
  evidence the service is dead. A timeout now also says which of the two it
  saw. A service that genuinely died is still reported the same way it always
  was, by the exit check between the probe and the sleep: waking that sleep from
  the child's own exit callback would report it sooner, and kills the process on
  Windows with a libuv assertion while it is reporting the failure it had
  already diagnosed correctly.

## 0.4.0-beta.2

- **Updates stop reinstalling dependencies that never changed.** Every update
  re-ran the whole installer, so a commit that touched one `.mjs` file still
  wiped `node_modules` for a fresh `npm ci` and re-resolved the entire
  `litellm[proxy]` tree against PyPI — which pulled unpinned transitive
  upgrades and, on a cold uv cache or a slow link, dominated the run. Both
  installers now fingerprint each dependency step (the lockfile for Node, the
  pinned requirement set plus the installed distribution versions for Python)
  and skip it when the artifacts already match, recording the stamp next to
  `node_modules/` and `.venv/` so deleting either one reinstalls. Repair still
  rebuilds everything: `doctor --fix` passes `--force-deps` (`-ForceDeps` on
  Windows), which fingerprints cannot know about a corrupted tree. The
  LiteLLM and FastAPI pins now live in `src/install-plan.mjs`, and a test
  fails if either installer's copy drifts.

- **`update check` no longer performs the update.** The `bin/update` wrapper
  hardcoded the `update` subcommand, so the read-only availability check was
  unreachable from the CLI and asking "is there a new version?" reinstalled
  the router instead. Both `bin/update` and `codex-router.ps1 update` now
  forward the subcommand, and a bare invocation still updates.

- **Reasoning efforts now match what the installed Codex build can display.**
  Codex's picker parses effort levels into a fixed enum and silently drops
  values it does not recognize; `max` and `ultra` only joined that enum in
  Codex 0.143.0, so on older builds the `max` tiers curated for several
  models simply vanished from the effort menu (GLM-5.2 lost its second tier,
  DeepSeek V4 Flash showed two levels instead of three). The catalog now
  derives the supported vocabulary from the installed Codex version and
  republishes out-of-range efforts at the nearest supported tier (`max` →
  `xhigh`), keeping defaults and announcement copy in range. Routing is
  unchanged — the forwarder already folds `xhigh` back to each vendor's
  documented maximum.

- **Legacy opencode Go models now offer Codex's native migration prompt.**
  GLM-5.1, Kimi K2.6, and MiniMax M2.7 carry an `upgradeTo` entry pointing at
  their generational successor on the same subscription (GLM-5.2, Kimi K3,
  MiniMax M3), so operators still running the older model get the
  full-screen "upgrade" modal and can switch their default with one accept —
  the older models stay in the picker. Upgrade targets are now validated at
  registry load: a checked-in prompt pointing at a missing or unlisted slug
  fails the build, and a user-curated one is skipped with a warning instead
  of shipping a modal that can never render.

- **New models announce themselves in Codex.** Checked-in models that newly
  become routable — shipped by a router update, or unlocked the moment their
  provider is credentialed and enabled — now carry Codex's native
  "Introducing {model}" announcement for seven days, with copy assembled from
  their verified picker metadata (context window, effort ladder, image
  input). The first catalog capture seeds the tracking state silently so an
  install never announces the whole catalog, locally curated models never
  self-announce, and Codex's own per-model show cap still applies. Curators
  can override the generated copy with an `availabilityNux` string on the
  registry entry, and a new `upgradeTo` field (`{ model, markdown }`) drives
  Codex's full-screen migration prompt for a genuine successor model —
  accepting it switches the operator's default model, so it is reserved for
  deliberate hand-offs.

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
  The opencode Go models take their ladders from opencode's own model
  registry (Grok low/medium/high; GLM-5.2 and DeepSeek V4 Pro high/max;
  DeepSeek V4 Flash low/high/max; HY3 low/high; Kimi K3 max-only; GPT 5.6
  Luna low through max), passed through verbatim since the gateway validates
  these values itself. Providers whose thinking control is binary or
  undocumented (Qwen via DashScope, Ollama Cloud, MiniMax, MiMo, Kimi K2.x)
  intentionally keep a single level.

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
