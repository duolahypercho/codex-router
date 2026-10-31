# Codex configuration and optional features

English · [简体中文](zh-CN/CODEX.md) · [日本語](ja/CODEX.md)

This guide covers detailed Codex settings. For installation and first use,
start with the [README](../README.md).

Unless marked otherwise, commands below use a macOS/Linux source checkout.
On Windows, replace `./bin/model-router codex` with
`.\model-router.ps1 codex` and `./bin/control` with
`node src/control.mjs`. For standalone helpers, use the matching
`.\codex-router.ps1 COMMAND` wrapper.

## Model picker and request limits

After setup:

1. Run `./bin/model-router codex doctor` and resolve any `FAIL` line.
2. Confirm `providers` says `SHOW` and `ready` for the intended provider.
3. Fully quit Codex, reopen it, and create a new task.
4. Open the normal model picker.

While the router service is running, it checks the signed-in account's native
model catalog every five minutes and republishes changes. This lets the next
Codex launch see newly released models without a manual catalog refresh.
Codex loads `model_catalog_json` only at app startup. If the catalog changes
while Codex is open, fully quit and reopen Codex to load the new list. If a
model is still missing, run `./bin/refresh-catalog` and reopen Codex.

Large compressed Codex contexts use separate safety limits for bytes received
on the loopback socket and bytes produced after decompression. The defaults are
64 MiB encoded and 256 MiB decoded. Override them with
`MODEL_ROUTER_MAX_BODY_BYTES` and `MODEL_ROUTER_MAX_DECODED_BODY_BYTES`
respectively when a deliberately larger local workload requires it.

The router admits at most 64 simultaneous inference requests by default. It
keeps tray activity records for 15 minutes without releasing truthful in-flight
accounting, and applies a separate conservative 24-hour execution deadline.
Override those bounds with `MODEL_ROUTER_MAX_ACTIVE_REQUESTS`,
`MODEL_ROUTER_ACTIVITY_RECORD_RETENTION_MS`, and
`MODEL_ROUTER_REQUEST_EXECUTION_TIMEOUT_MS`; buffered upstream error bodies use
an 8 MiB ceiling configurable through `MODEL_ROUTER_MAX_BUFFERED_RESPONSE_BYTES`.
The caller-authenticated health endpoint reports these limits, aggregate
in-flight counts, bounded-buffer ceilings, and encrypted-relay cache metrics;
the public health endpoint omits that resource detail.

`CODEX_ROUTER_APP_CONNECTORS` can withhold the Codex app connectors from a
routed Chat Completions or Messages model. Codex can send its full connector
registry (`mcp__codex_apps__github`, `mcp__codex_apps__notion`, ...), adding
hundreds of tool schemas to a turn. Supply the variable when installing or
regenerating the service; the Linux, macOS, and Windows service definitions
retain the setting until regenerated again. Restart an already-running service
after changing its environment. A foreground router reads it from its launch
environment. The setting is opt-in:

- unset or empty: keep ordinary connector functions eager.
- `none`: withhold every connector function.
- `all`: keep ordinary connector functions eager, stated explicitly.
- `airtable,gmail`: keep those connectors eager and withhold the rest;
  trimmed, case-insensitive, unknown ids ignored.

A withheld function is re-declared when stored call history, a forced choice,
or an allowed-tools choice names it. With a client-executed `tool_search`,
marked deferred functions can also be loaded through the existing search relay.
Codex's own app tools, the collaboration runtime, the repls, image generation,
and custom tools are outside connector selection. Explicitly deferred functions
still follow the client tool-search contract; custom tools remain visible.
Responses compatibility routes that translate namespace tools also use this
policy; routes that preserve native namespace declarations bypass it.

## Tool-result aging and exact archive readback

**Off by default.** The Settings switch **Token maxxing** opts into rewriting
eligible old tool results in model requests. The stored choice survives updates;
it is read on the next request without restarting the router or Codex.

```sh
node src/control.mjs tool-result-aging status
node src/control.mjs tool-result-aging on
node src/control.mjs tool-result-aging off
```

By default, ordinary aging considers consumed textual results larger than
32 KiB and protects the newest four results. Recognized instruction-file reads
(such as AGENTS.md and SKILL.md) and Cua bootstrap/runtime documentation are
protected from aging. Detection is bounded,
not a complete interpreter of arbitrary shell or JavaScript.

Safe omission requires both a committed exact original and verified local
readback access for the same conversation/permission scope. Before access is
verified, full output stays in the request with a read-only recovery instruction.
An archive write failure, denied access, invalid proof, or expired proof is not
permission to discard the original. Clients without a recognized local execution
tool keep the unmodified output on this recovery path.

Follow the exact reader command attached to the result; it supplies the correct
Node executable, reader path, signed handle, and store directory. The reader
returns JSON with `text`, `nextOffset`, and `eof`. It supports `--offset N`,
`--limit N`, and `--find 'literal text'`. For an unknown archive, use a valid
reference handle with `--scope-search --find 'literal text'`; do not guess handles.
A missing, expired, or corrupt original is unavailable historical evidence.
**Do not rerun the original command to reconstruct it.** A fresh execution could
observe different state or repeat a mutation.

Context compaction uses the same aging policy and keeps recent results intact.

Native GPT rewriting is separately opt-in:

```sh
node src/control.mjs tool-result-aging native on
node src/control.mjs tool-result-aging native off
```

`CODEX_ROUTER_TOOL_RESULT_AGING=0` disables both routed and native rewriting.
It does not disable expiry of originals already stored.

### Storage and expiry

Originals are stored in the owner-private
`<state dir>/retained-tool-results` directory, overridable with
`MODEL_ROUTER_TOOL_RESULT_RETENTION_DIR`. Retention is bounded at 512 files
or 512 MiB; new archives are refused at the cap rather than evicting unrelated
entries. Uncommitted results stay full.

The default TTL is seven days. Expired files are swept during archive writes or
an explicit expired-only purge, not by a timer. Reads reject expired evidence
even if its file has not yet been swept. A short-lived access proof is distinct
from the archive's lifetime.

```sh
node src/control.mjs tool-result-aging purge
node src/control.mjs tool-result-aging purge --expired
node src/control.mjs tool-result-aging purge --expired --yes
node src/control.mjs tool-result-aging ttl 30
node src/control.mjs tool-result-aging ttl off
node src/control.mjs tool-result-aging ttl default
```

Purge previews unless `--yes` is supplied; `--dry-run` wins over `--yes`.
A full purge with `purge --yes` permanently removes managed originals, so active
sessions can lose historical readback. Foreign files and symlinks are not
followed or recursively deleted. Doctor reports the store's size, count, oldest
entry, and lifetime.

For proof validation, scope-search pagination, and explicit per-model policies,
see [Desktop readback proofs](tool-result-readback-proof.md),
[scoped archive search](tool-result-scope-search.md), and
[per-model history policy](tool-result-model-policy.md).

### Measuring the effect

```sh
node scripts/measure-tool-result-aging.mjs /path/to/rollout.jsonl
node scripts/aging-benchmark.mjs
```

The first estimates context savings from a rollout without provider calls.
The second reports recorded savings. Byte reductions are not a promised
reduction in billed tokens: readback requests and changed prompt-cache prefixes
can offset them. Use provider-reported usage and task correctness to judge the
effect. See the [benchmark guide](tool-result-aging-benchmark.md) for a live A/B
procedure that consumes quota.

## Managed configuration and caller keys

The integration preserves the built-in OpenAI provider, native GPT models,
ChatGPT sign-in, profiles, MCP settings, project trust, and reasoning defaults.
It adds one marked root block and one inert custom-provider table to the user's
Codex config:

```toml
# BEGIN codex-router-managed
openai_base_url = "http://127.0.0.1:4202/_codex-router/<generated-capability>/v1"
model_catalog_json = "/absolute/path/to/.codex/codex-router/merged-models.json"
# END codex-router-managed

# BEGIN codex-router-provider-managed
[model_providers.codex-router]
name = "Codex Router (external models)"
base_url = "http://127.0.0.1:4202/_codex-router/<generated-capability>/v1"
wire_api = "responses"
# END codex-router-provider-managed
```

The generated path is local caller authentication. Do not paste the complete
managed URL into an issue. If that capability may have been exposed, rotate it
through the supported transaction instead of deleting state files by hand:

```sh
./bin/model-router codex caller-key rotate
```

On Windows use `./codex-router.ps1 caller-key rotate`. Rotation acquires the
router's mutation locks, refuses partial managed client state, and refreshes only
the caller URL/key fields of integrations that are already installed. A running
router is stopped before the key swap, restarted afterward, and accepted only
after the new capability returns a valid model list while the old one returns
exactly `401`. An installed-but-stopped service stays stopped. A protected phase
journal and rollback generation make an interrupted rotation recoverable without
printing either key. Fully quit and reopen Codex (and restart a running Gemini
CLI session) after success so cached client configuration cannot keep using the
previous route.

### Optional native context variant

The current registry defines a hidden `gpt-5.6-sol-1m` picker variant of
`gpt-5.6-sol` with a 1,000,000-token context and a 900,000-token compaction
threshold. It appears only when the signed-in native catalog contains the
listed base model.

```sh
node src/control.mjs picker set gpt-5.6-sol-1m show
node src/control.mjs picker set gpt-5.6-sol-1m hide
```

The router rewrites this alias to the base model before upstream delivery.
The choice is remembered, and Codex must be fully restarted to reload its picker.
Larger histories can increase usage; check the account's current limits and
billing before enabling one. Login-free installs do not publish this variant.

### Windows Codex Desktop running through WSL

When Codex Desktop runs on Windows while commands are executed through WSL,
there may be two different Codex home directories:

```text
C:\Users\<WindowsUser>\.codex
```

and:

```text
/home/<LinuxUser>/.codex
```

Router commands use the Codex home selected by `CODEX_HOME`. Running them inside
WSL without overriding that variable may update the Linux CLI configuration
instead of the configuration used by Windows Codex Desktop.

To target the Windows Desktop configuration from WSL:

```sh
export CODEX_HOME=/mnt/c/Users/<WindowsUser>/.codex
export CODEX_ROUTER_STATE_DIR="$CODEX_HOME/codex-router"
```

Then run the router command normally. For example, to return to authenticated
mode with native GPT models and enabled external providers in the merged
catalog:

```sh
./bin/control auth-mode off
```

Verify that the Windows `config.toml` uses a path that the WSL runtime can read:

```toml
model_catalog_json = "/mnt/c/Users/<WindowsUser>/.codex/codex-router/merged-models.json"
```

When the Codex runtime is executing inside WSL, a Windows-style path such as
`C:\Users\...` is not readable as a Linux filesystem path. Use the corresponding
`/mnt/c/...` path instead.

If setup appears successful but the Desktop model picker does not change, check
which Codex home was modified before rerunning setup.

### Use external models while signed in to ChatGPT

The Control Center's **Use Router with ChatGPT** switch keeps ChatGPT
authentication available while external provider models remain selectable. On
current Codex builds, an explicit switch from the built-in OpenAI provider
selects the managed `codex-router-signed` transport so Codex validates prefixed
model ids against the router before sending them. The prior provider is stored
in protected state and restored when the switch is turned off. Normal updates
and catalog refreshes do not silently opt an existing installation into this
provider switch.

The optional native redirect is independent of this switch and of model
failover. If native redirect is set, every unmatched native GPT turn that
reaches the router continues to use its configured external route until
`./bin/control native-redirect clear` is run.

If **Approve for me** stops working once the ChatGPT plan is exhausted, that is
a separate quota from the session's. Codex runs automatic approval reviews on
its own hidden native model, so a session answered by an external provider can
keep reasoning and proposing commands while every review still costs ChatGPT
quota. Name a routed model to take those reviews over when that happens:

```
./bin/control auto-review-fallback set kimi-oauth/k3
./bin/control auto-review-fallback status
./bin/control auto-review-fallback clear
```

The fallback engages only after Codex's own reviewer has refused a review *for
quota*, and only for the window that refusal named. A denial, a policy
rejection, a malformed answer, and any other failure all stay with the native
reviewer -- a `deny` is a decision, and it is never retried through another
model. The first answer the native reviewer gives afterwards ends the window,
so reviews return to it on their own. It changes nothing about which model runs
the session.

### Use Codex without an OpenAI login

The tray's **Use without OpenAI login** switch selects the managed custom
provider for new Codex sessions. In that mode, enabled external models use the
OAuth session or API key configured for their provider and do not require a
ChatGPT or OpenAI API login. Connect and enable at least one external provider
before turning it on. On macOS, the tray gracefully quits and reopens the
registered Codex desktop app after the mode changes; if that restart fails, the
tray reports that Codex must be restarted manually. The switch keeps the current
model when it already belongs to a connected external provider; otherwise it
selects the first enabled model from one of those providers.

While the switch is on, model selection happens in Codex's own picker: the
catalog republishes external models with their real names, so switching models
needs no extra tray UI. `./bin/control model-set <model-slug>` switches the
active model from the command line; it accepts canonical external slugs and
writes the aliased native slug so pickers highlight the selection.

Login-free catalogs republish external models under the native GPT slugs
(with the external model's own name and reasoning levels), because some Codex
surfaces — notably the ChatGPT desktop app's model menu — only display models
whose slugs pass a server-delivered allowlist of native slugs. The router
records the mapping in `native-aliases.json` and dispatches those slugs to the
mapped external provider. Models beyond the available native slots stay listed
under their own slugs, and signing back in restores the native catalog
untouched.

For custom providers, the switch preserves the root `model_provider`,
temporarily owns that provider's complete table, and restores the exact table
plus the prior root `model`. Codex reserves the built-in `openai` provider id,
so root-OpenAI configurations use the compatible `codex-router` provider while
login-free mode is active and restore the prior provider afterward. The router
does not modify or delete ChatGPT credentials. Native GPT models, ChatGPT usage, cloud
tasks, and other account-backed features still require OpenAI authentication
and are not available while signed out. The equivalent local control command is
`./bin/control auth-mode on` or `./bin/control auth-mode off`; when using the
command directly, restart Codex yourself.

### Native ChatGPT account switching

Codex Router can keep multiple ChatGPT subscription logins in isolated
profiles. Select an account in Control Center; the selection is
applied to native Codex after Codex is closed and restarted. The previous
login remains saved, and switching never removes another account's session.

Each account keeps its own native model catalog and routed overlay. Usage is
read from up to eight saved, usable accounts' isolated `CODEX_HOME`
directories, prioritizing the selected account and using the weekly
window when available and the monthly window otherwise. This is an explicit
switch-only feature: it does not perform automatic quota or round-robin
routing. See [the account switching guide](CHATGPT-ACCOUNT-MODES.md) for
the safety and token-refresh details.
### Local models

Ollama and LM Studio models can be selected locally, but agent reliability,
tool support, context capacity, memory use, and speed depend on the exact model
and machine. A tools-capable template alone does not prove that a model can
finish a Codex task. Consult current inspection and client tests rather than
old sample benchmark tables.

See [local LLM installation and controls](LOCAL-MODELS.md) for downloads,
cancellation, fit checks, runtime updates, and LM Studio configuration. Checking
a model changes publication; it does not mean deleting or replacing its weights.
Local model selection can restart the router service.

### Paste images into a text-only model

A text-only route cannot consume an image directly: the client may refuse the
attachment or the provider may reject it. The optional vision bridge handles
that case at the router: it sends the pasted image to a
vision-capable model you have **already enabled**, and substitutes the reply
into the turn as text before the text-only model ever sees it.

It is **on by default** — paste a screenshot and it is read, with nothing to
configure. If nothing on your machine can read images, nothing changes: the
picker keeps saying text-only, exactly as before.

```sh
./bin/control vision-bridge status
./bin/control vision-bridge off     # never spend an engine's quota on a paste
```

Turning it off is remembered permanently; an update never turns it back on.

On an installation with no stored choice, the current default is
`gpt-5.6-luna` at `low` effort. If that unanswered default is unavailable, the
resolver ranks enabled, credentialed non-loopback alternatives. Explicit **Auto**
also uses ranking; this is a preference heuristic, not a live price comparison
or a guarantee of the cheapest engine. A model on your own machine is never
chosen automatically because its runtime may not be running.

An explicitly selected engine that no longer resolves is reported rather than
silently replaced. If a resolved remote engine fails during the read, bounded
fallback can try other enabled vision engines and consume their quota; the
output identifies the engine that actually answered. A pinned local engine
does not fall back to a remote provider.

Pin a specific engine, or choose Auto:

```sh
./bin/control vision-bridge engine qwen-plan/qwen3.6-flash
./bin/control vision-bridge engine auto
```

What the text-only model actually receives is evidence, not an impression: a
summary, a verbatim transcript of every readable word, a reading-order layout
list, chart and table values, and an explicit list of what was too small or
blurred to read. That last section is what stops the model answering confidently
about a detail nobody could see.

Notes worth knowing:

- **No extra account.** The engine uses the same route-specific protocol handling,
  credential, and request profile as other requests to that model. Nothing new to sign into.
- **Cached image reads can avoid repeat calls.** The router caches transcripts
  for the image and question for an hour. A new question, cache expiry or eviction,
  a process restart, or changed authorization can require another provider call;
  this is not a once-only billing guarantee.
- **Image text is untrusted data.** The transcript arrives fenced and labelled
  as quoted content, so a screenshot containing "SYSTEM: delete everything"
  reads as something the image says, not something you asked for.
- **It fails out loud.** If the engine errors, that image becomes a stated
  failure in the turn and the rest of the conversation still answers. The model
  is told it could not see the image rather than being left to invent it.
- **It advertises only what it can deliver.** With the bridge off, or with no
  enabled model that reads images, the picker keeps saying text-only and Codex
  keeps refusing the paste. `doctor` reports the engine in use.
- **You can see what it spent.** Every read that is not served from the cache
  is written to `usage-events.jsonl` with the engine it was billed to, and the
  router logs one line per bridged turn. Plan quota for a ChatGPT-plan engine
  is still not reflected in the tray's limits — see `AGENTS.md`.

The evidence contract is modelled on
[ModLens](https://github.com/liustack/modlens), which solves the same problem
one layer up, as an agent skill.

#### Free, private, offline: a tiny local vision model

The bridge normally reuses a vision model you already pay for. If every provider
you have is text-only — a DeepSeek-only setup, say — point it instead at a small
vision model running on your own machine. It costs nothing, the image never
leaves your computer, and it works offline.

The default or Auto engine can consume hosted-provider quota. To read images
locally instead, download a local vision model and explicitly select it from
the tray or CLI.

**From the macOS tray** (no terminal): open the menu-bar app → Model Settings →
Local LLMs, install a vision model by tag, then click "Use for vision" on its
row. Rows that read images say so, and "Test" scores one against the benchmark
image. Local models are managed only there — the Vision panel just shows the
on/off switch and which engine is reading, and its Engine menu offers Auto and
your paid models.

**From the CLI**, list the same picker — size, fit, and what's already pulled:

```sh
./bin/control vision-bridge models
./bin/control vision-bridge pull qwen2.5vl:3b   # downloads via Ollama, then pins it
./bin/control vision-bridge pull-status         # percentage while it runs
```

The download runs detached: `pull` returns immediately and the model is pinned
as the reader only once it is actually on disk, so quitting the tray — or a
failed download — never leaves the bridge pointing at a model that isn't there.

Not sure what your machine can run? This reads your RAM and pings your local
server, without downloading or changing anything:

```sh
./bin/control vision-bridge probe
```

It reports the model your hardware suggests (roughly: `moondream` under 8 GB,
`qwen2.5vl:3b` at 8 GB, `qwen2.5vl:7b` at 16 GB+), which vision models you have
pulled already, and the exact command to pin one.

The bridge does not run the model itself — it POSTs to an OpenAI-compatible
`/v1/chat/completions` with no credential, and requires a runtime compatible with that request/response contract. `vision-bridge probe` auto-detects the common ones:

| Runtime | Default base URL | Serve a vision model with |
|---------|------------------|---------------------------|
| [Ollama](https://ollama.com) | `http://127.0.0.1:11434/v1` | `ollama pull qwen2.5vl:3b` (then it just runs) |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) | `http://127.0.0.1:8080/v1` | `llama-server -hf ggml-org/Qwen2.5-VL-3B-Instruct-GGUF` |
| [LM Studio](https://lmstudio.ai) | `http://127.0.0.1:1234/v1` | load a vision model, start its local server |

**Ollama** is the least setup:

```sh
ollama pull qwen2.5vl:3b
./bin/control vision-bridge local qwen2.5vl:3b
```

**llama.cpp** — its `llama-server` speaks the same protocol. `-hf` pulls the
model and its vision projector (`mmproj`) together; then point the bridge at
port 8080:

```sh
llama-server -hf ggml-org/Qwen2.5-VL-3B-Instruct-GGUF --port 8080
./bin/control vision-bridge local qwen2.5vl:3b http://127.0.0.1:8080/v1
```

(With a manual build, pass the two GGUFs yourself:
`llama-server -m model.gguf --mmproj mmproj.gguf`. The model name you pin is
cosmetic — llama.cpp serves whichever model it loaded.)

Either way, pinning turns the bridge on; fully quit and reopen Codex, then paste
into DeepSeek as usual. Run `local` with no model to let the machine pick — it
reuses a vision model already served by a running runtime, or falls back to the
hardware recommendation and tells you the pull command:

```sh
./bin/control vision-bridge local                        # auto-pick for this machine
./bin/control vision-bridge local moondream http://127.0.0.1:11434/v1
```

**Not all vision models can read.** The bridge needs verbatim transcription, and
most small vision models are captioners: they describe the scene convincingly
and invent the codes and numbers. That is worse than no model, because the
text-only model downstream repeats the invention as fact. So the picker labels
accuracy from measurement, not reputation:

```sh
node src/vision-benchmark.mjs        # scores every installed model
```

It reads `test/fixtures/vision-benchmark.png` — an invoice with known codes,
decimals, dates, and a table — and scores how much comes back exactly.
Results depend on the model, runtime, and image.
A historical score does not establish accuracy for your own screenshots.
Use the benchmark output from your installed version and machine before
trusting codes, numbers, or small text. Download-size metadata may be refreshed
from Ollama, with cached figures used offline.

**Any other model.** The checked-in tag snapshot is refreshed separately from
Ollama, but it is not a cage: the tray's Local LLMs section has a field that
accepts any Ollama tag — including `hf.co/user/repo:Q4_K_M` — and the CLI takes
one too.

```sh
./bin/control vision-bridge pull minicpm-v
```

Models you add this way carry no accuracy label, because nobody has measured
them here. Run the benchmark against one before trusting it with anything that
matters:

```sh
node src/vision-benchmark.mjs minicpm-v
```

How the local path differs from a paid engine:

- **It speaks chat completions, not the gateway.** A local model runs outside
  the router's gateway, so the bridge calls its `/v1/chat/completions` endpoint
  directly with no credential. Nothing about your setup is sent anywhere.
- **It is only used when you pin it.** Auto mode never routes images to
  `localhost` on its own — an unreachable server would fail every paste — so the
  local engine is opt-in via `vision-bridge local`. `vision-bridge engine auto`
  hands the choice back to your paid models.
- **Start it before you paste.** If the local server is down or the model is not
  pulled, that image degrades to a stated failure in the turn (the model is told
  it could not be read) rather than a crash. `doctor` shows the pinned local
  model and reminds you to pull it.
- **Slower, and only as good as the model.** A 3B model on a laptop is seconds
  slower than a hosted Flash tier and less precise on tiny text. For heavy use,
  a paid vision engine still reads better; the local option is about cost and
  privacy, not peak quality.

### Keep working when a provider runs out of usage

A coding-plan window closes, a weekly quota lands, a balance empties — and the
turn you were in the middle of used to stop there. Codex can do nothing with a
billing error, so the session ended, subagents included, while every other model
you had configured sat unused.

Before any response is relayed, an eligible failed turn can be **rebuilt for
another compatible routed model**. This is **on by default** and uses only
already enabled, authenticated routes. It does not guarantee recovery: no
compatible candidate, an exhausted recovery budget, or a failure after the
response has started can still end the turn. It never switches models to
continue a stream already delivered to the client.

```sh
./bin/control failover status
./bin/control failover off      # a provider running out ends the turn, as before
```

Turning it off is remembered permanently; an update never turns it back on.

**Quota failures** are deliberately narrow: an exhausted balance or plan limit,
a `402`, or a `429` that asks you to wait more than a minute. A separate eligible
case is the local forwarder's reserved pre-response transport-failure marker.
An ordinary provider `5xx`, rejected key, unknown model, malformed request, or
lack of API entitlement is not permission to switch away silently. Swapping models to dodge a bad credential would
only bury the one fact that fixes it.

**Which model answers instead**, in order:

1. Free models — the anonymous gateways, if you have curated any
2. Everything else you have enabled, in the picker's own preference order

**A free first stop is not automatic, and that is deliberate.** The free
catalogs at `opencode-free` and `kilo-free` are picked out by naming rules their
vendors change without notice, so none are checked in, and an anonymous provider
is never enabled for you — turning one on sends your prompts to a third-party
endpoint with no credential, which has to be your choice. Until you make it,
failover goes straight to your own providers. `doctor` says which of the two
you are in. To give failover a free first stop:

```sh
./bin/providers enable opencode-free
./bin/curate-models opencode-free
```

A model served from your own machine is never chosen automatically, for the same
reason the vision bridge does not choose one: your runtime might not be running.
Name it in a chain and it is used. A model whose context window cannot hold the
conversation is skipped, so a quota failure never turns into a "too many tokens"
failure. Choose the order yourself, or hand the choice back:

```sh
./bin/control failover chain opencode-free/big-pickle,kimi-api/kimi-k3
./bin/control failover auto
```

**A route you only ever want to pick yourself can opt out.** Set
`"failoverCandidate": false` on its entry in `user-models.json` and it stays in
the picker and answers when you select it, but it is never chosen
automatically -- not by quota failover, not by compaction, and not through a
named chain. Use it for a slow, best-effort or subscription-bound route that
must not absorb other models' traffic. Curation keeps the field on an existing
entry; a model without it behaves exactly as before.

**When a provider tells you when it will be back, that is believed.** The next
turn skips it outright instead of paying for the same rejection again, and it
starts being used the moment the window passes — or the next time it answers
successfully, whichever comes first. Reset times are never invented, only read
from the provider, and capped at six hours. `doctor` shows anything currently
being held off and when it clears:

```sh
./bin/control failover reset   # clear every hold now and ask again next turn
```

**You are never left guessing which model answered.** The tray Island names the
model actually serving, `router.log` records every swap (even with the quiet
flag the background service sets), and the usage graphs mark the turn with the
model you originally asked for. Nothing is written into your transcript — Codex
replays assistant output back as input, so a note from the router would come
back next turn as a sentence the model thinks it wrote.

Compaction gets the same treatment: a compaction that cannot run ends a long
session just as surely as a turn that cannot run.

Note: your signed-in ChatGPT plan is **not** currently used as a fallback tier.
Routed models fall back to other routed models only.

## Skills for custom models

The installer includes companion skills under [skills/](https://github.com/duolahypercho/codex-router/tree/main/skills/) to explain
tool naming and the app's thread, browser, and computer-use tools to external
models. Available app tools and client permissions determine which actions
the model can perform.

Read the shipped skill for current runtime APIs. App tool names and browser or
computer-use entrypoints can change; an old README example is not their contract.

The skills live in `skills/` in this repository. `bin/install` copies them
to `~/.codex/skills/` (each directory is marked `.codex-router-managed`);
`bin/uninstall` removes exactly those, never a skill you wrote yourself. A
name collision with an existing skill of your own is skipped, not
overwritten. To install or remove them by hand:

```sh
./bin/model-router codex skills install
./bin/model-router codex skills uninstall
```

If another manager owns a skill with the same name, review that complete
directory and explicitly approve its exact contents instead of transferring
ownership to codex-router:

```sh
./bin/model-router codex skills approve-external codex-router
./bin/model-router codex skills revoke-external codex-router
```

Approval records digests of both the external directory and this checkout's
matching skill. Any change to either side requires review and re-approval.
Symlinks, special files, unreadable trees, and oversized trees are refused.
Approval never authorizes codex-router to replace or remove the external
directory; uninstall preserves it.

`./bin/model-router codex doctor` checks the pack: installed, current
against the checkout, free of name collisions, and matching the app
toolset snapshot the router relays.

To inspect rollout evidence for the pack, run the read-only check after using
a custom model in the app:

```sh
node scripts/verify-skill-injection.mjs ~/.codex/sessions/2026/08/09/rollout-*.jsonl
node scripts/verify-skill-injection.mjs --latest --expect routed
```

It accepts only a standalone app-injected developer block with a turn ID, then
correlates a same-turn tool call referencing the skill path with its output and
checks same-turn `create_thread` arguments. With `--expect native`, that
completed pack-path call is an error. Because arbitrary exec code is opaque,
the rollout proves a completed path-referencing call, not that the command read
specific bytes. Browser and computer-use execution remains live-only.
