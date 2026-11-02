# Providers, authentication, and model curation

English · [简体中文](zh-CN/PROVIDERS.md) · [日本語](ja/PROVIDERS.md)

Built-in and locally curated models are defined in the [registry](https://github.com/duolahypercho/codex-router/tree/main/config/)
and the private user-model overlay. The exact picker list depends on enabled
providers, usable credentials, account access, compatibility policy, and your
model selection. Each provider/model route has its own credentials, billing,
and capabilities.

Run the following from the installed checkout. On Windows replace
`./bin/model-router codex` with `.\model-router.ps1 codex`,
`./bin/curate-models` with `.\codex-router.ps1 curate-models`, and
`./bin/control` with `node src/control.mjs`. Commands with `--live --yes`
send real requests and can consume quota.

## Platform and authentication differences

### Kimi platforms

Kimi has two API platforms and they are not interchangeable. `kimi-api` is the
global console at platform.moonshot.ai; `kimi-api-cn` is the mainland console at
platform.moonshot.cn. Accounts, billing, and keys are separate — a key minted on
one platform is rejected by the other — so each is enabled and credentialed on
its own, and both can be active at once. Pick the one matching where your key
was created. (`kimi-oauth` is a third, distinct thing: the Kimi Code
subscription reused through the official CLI's session.) Kimi Code itself also
has two deployments — kimi.com for mainland China and kimi.ai for the rest of
the world. A bare `kimi login` targets kimi.com; a kimi.ai account signs in
with `kimi login --region global` (guided setup asks which site to use). The
router reads the region the official CLI recorded in `~/.kimi-code/config.toml`
and refreshes tokens, forwards requests, and reads quota from the matching
`auth.`/`api.` hosts, so no router-side configuration is needed for either.

### StepFun regions

StepFun is split the same way. `stepfun-api` is the global Open Platform at
platform.stepfun.ai (`https://api.stepfun.ai/v1`); `stepfun-api-cn` is the
mainland console at platform.stepfun.com (`https://api.stepfun.com/v1`). Each
console issues its own key, so the two providers are enabled and credentialed
separately and can both be active at once — pick the one matching where your
key was created. The model ids are identical on both hosts, so the only
difference between a `stepfun-api/` and a `stepfun-api-cn/` route is which
platform serves and bills it.

The Codex catalog is credential-aware. It includes models only from enabled
external providers with a stored credential or valid OAuth session. Native GPT
models are included only when `codex login status` confirms an OpenAI login.

### Qwen authentication

Qwen is key-only. Alibaba discontinued the Qwen Code OAuth free tier on
2026-04-15, so the Model Studio plan key is the sole Qwen surface; `qwen-plan`
points at the token-plan endpoint. Set `QWEN_PLAN_BASE_URL` to
`https://dashscope-intl.aliyuncs.com/compatible-mode/v1` to bill a
pay-as-you-go DashScope key through the same provider. Alibaba publishes no
quota or balance API on either endpoint, so the tray shows router-observed
traffic and links to the console for actual spend.

### ClinePass

ClinePass uses Cline's OpenAI-compatible API at
`https://api.cline.bot/api/v1`. An API key alone does not grant access to the
`cline-pass/*` models: the account also needs an active ClinePass subscription.
Create the key under Cline Settings > API Keys, then store it with
`./bin/model-router codex provider-key clinepass set`.

### Grok OAuth

Grok OAuth reuses the official CLI credential at `~/.grok/auth.json` and sends
it only to xAI's documented Grok CLI inference proxy. On that path the router
also attaches bare hosted `web_search` and `x_search` tools, the same agentic
surface Grok Build uses. xAI's backend chooses when to search and how to filter
results; the router does not take search env knobs or request-side filter
config. Install the official CLI and authenticate before enabling the route:

```sh
npm install -g @xai-official/grok
grok login --oauth
```

### Search capabilities

Other routed providers can use Codex's client-side (standalone) web search when
the selected model has been verified for it. DeepSeek V4 Flash is enabled on
its direct API and opencode Go routes. A compatible model declares
`"searchTool": { "mode": "standalone" }` in its registry or user-model
metadata. This capability is resolved from the selected model/provider pair;
the managed Codex provider block enables the provider half of standalone
search so verified models can use it, while the merged catalog remains the
per-model gate. The router never infers compatibility from an
OpenAI-compatible endpoint. A model is advertised only after its exact
provider path has been verified to preserve Codex search-result items and
tool-call history. If Codex attaches hosted-search fields to an unsupported
runtime-generic route anyway, the managed Responses boundary removes only
those search extensions before the strict upstream sees them.

For a routed model that has no verified standalone or provider-hosted search,
Codex can instead use an explicit Perplexity Search sidecar. This is not a
global fallback: the binding names one exact routed model, uses a separately
stored Perplexity API key, and is refused for a model that already owns a
search capability. The adapter implements Perplexity's raw
[`POST /search`](https://docs.perplexity.ai/api-reference/search-post) API and
accepts only Codex `search_query` commands; unsupported filters or other web
commands fail by name.

Create the trusted provider descriptor, enter the key at the hidden terminal
prompt, and bind the model:

```sh
./bin/model-router codex providers generic add perplexity-search \
  --name "Perplexity Search" \
  --base-url https://api.perplexity.ai \
  --adapter openai-chat
./bin/model-router codex providers generic credential perplexity-search set
./bin/model-router codex search-sidecar set PROVIDER/MODEL perplexity-search
./bin/model-router codex search-sidecar status PROVIDER/MODEL
```

The credential command never accepts the key as an argument. The descriptor,
credential reference, and per-model binding are private, atomic state; the key
remains in the generic-provider protected credential file. Search requests use
the generic-provider DNS-pinned, redirect-refusing transport. Result URLs must
resolve publicly, credential-bearing citations are rejected, the whole
operation shares one timeout across retry and backoff, and cache entries are
scoped by caller account, model, provider, and credential reference. Removing
the generic provider also removes its credential and every dependent sidecar
binding. Fully quit and reopen Codex after changing a binding so its model
catalog refreshes.

On Windows, the same commands are available through `codex-router.ps1`:

```powershell
.\codex-router.ps1 providers generic add perplexity-search --name "Perplexity Search" --base-url https://api.perplexity.ai --adapter openai-chat
.\codex-router.ps1 providers generic credential perplexity-search set
.\codex-router.ps1 search-sidecar set PROVIDER/MODEL perplexity-search
```

### Antigravity OAuth

> [!WARNING]
> **Antigravity OAuth has no bundled or shared OAuth client.** Create and use a
> Google OAuth Desktop-app client pair that you own, as described below. A
> Google AI Pro/Ultra subscription, Gemini API key, Google account, or existing
> `agy` CLI login does not supply that pair, and the router never copies the
> official `agy` identity or credential store. Do not use the old
> `your-integration-client-secret` placeholder: it cannot work.

> [!IMPORTANT]
> **The Cloud project behind your OAuth client must be allowlisted for
> `cloudcode-pa.googleapis.com`, and most projects are not.** The bootstrap call
> is billed to the project that owns the calling OAuth client, so an
> operator-owned client bills your project rather than Google's. That service is
> a private API: binding it needs the producer-side
> `servicemanagement.services.bind` permission, so `gcloud services enable`
> fails even for the project owner, and it has no API Library entry to enable
> through the console.
>
> Sign-in still succeeds; the live probe is what fails, with
> `PERMISSION_DENIED` / `SERVICE_DISABLED`. If your project is not allowlisted,
> **this provider cannot currently be used** — there is no operator-side
> workaround, and no configuration in this repository changes it. See
> [#566](https://github.com/duolahypercho/codex-router/issues/566).

Create a Google OAuth **Desktop app** client in a Google Cloud project you own:

1. In Google Cloud Console, open **APIs & Services > OAuth consent screen** and
   configure the app for your account with a truthful name such as **Codex
   Router**—not Antigravity (add the account as a test user when the consent
   screen is in testing mode).
2. Open **APIs & Services > Credentials**, choose **Create credentials > OAuth
   client ID**, and select **Desktop app**. Keep the resulting client ID and
   matching secret in that private browser tab.
3. Run the login command below and enter that one pair only in the local setup
   page it opens.

Do not copy the official Antigravity/`agy` client or credential store. The
login command binds `127.0.0.1` on an OS-assigned ephemeral port before it
constructs the redirect. It opens only a loopback URL through the operating
system; the local listener redirects the browser to Google, so neither client
value is put in process arguments or terminal output. The pair and tokens are
persisted together in the router's owner-only state and are never copied to a
background-service environment.

If an older incompatible router credential is already present, the new flow
preserves it and asks you to run `providers disconnect antigravity-oauth`
before sign-in; it never silently upgrades, reuses, or overwrites that record.

```sh
./bin/model-router codex providers login antigravity-oauth
./bin/model-router codex providers probe antigravity-oauth --live --yes
./bin/model-router codex providers enable antigravity-oauth
```

On Windows PowerShell, use the matching wrapper:

```powershell
.\model-router.ps1 codex providers login antigravity-oauth
.\model-router.ps1 codex providers probe antigravity-oauth --live --yes
.\model-router.ps1 codex providers enable antigravity-oauth
```

The probe sends a small real prompt and consumes provider quota. It uses the
truthful `codex-router` identity and must succeed before the route can be
enabled. If the account has no companion project, rerun the probe with
`--provision-project` only after authorizing that side effect. Provisioning still
requires a successful, schema-valid bootstrap response that explicitly
advertises the tier it will use; auth errors, server errors, malformed
responses, and missing tiers all fail closed. This remains an unofficial
compatibility route over Google's internal Antigravity service,
not a public Gemini API contract; if Google serves only the impersonated vendor
client, the router deliberately leaves this provider disabled.

After proof, the command records a nonpublishable pending generation and
restarts an installed router service. Startup health-checks that exact proof
and promotes it only after the complete local stack is ready; restart failure
or process death leaves it disabled. Proof records from the earlier v2 writer
that have no activation metadata are unverified and require the explicit live
probe again. Before proof the Antigravity forwarder
does not bind a port, so an unused provider cannot make the rest of the router
fail to start. If you run the router in the foreground for development,
restart that foreground process before enabling the provider.

### Xiaomi MiMo

MiMo (Xiaomi API) uses Xiaomi's official OpenAI-compatible endpoint at
`https://api.xiaomimimo.com/v1`. Unlike MiMo reseller routes, the direct API
serves `mimo-v2.5` and `mimo-v2.5-pro` through the standard
`/chat/completions` surface. The router adapts these requests for its
Responses frontend.
`mimo-v2.5` is verified for text/image input and Codex standalone web search;
`mimo-v2.5-pro` is text-only. Store the key with
`./bin/model-router codex provider-key xiaomi-mimo set`.

Native GPT requests normally pass through the router to the ChatGPT Codex
backend without LiteLLM. A valid ChatGPT login is still required; optional
native redirect and login-free alias modes have separate behavior. See the
[Codex guide](CODEX.md).

### GitHub Copilot

`github-copilot` routes account-visible models that explicitly advertise the
Responses API, streaming, and tool calls. The catalog is plan- and
policy-specific, so this provider ships no hard-coded models: store a
fine-grained GitHub PAT with the **Copilot Requests** permission, then curate
from the live catalog. This initial integration targets GitHub.com; GitHub
Enterprise Cloud data-residency hosts are not yet configured by the router.

```sh
./bin/model-router codex provider-key github-copilot set
./bin/curate-models github-copilot
```

The hidden prompt stores the GitHub token in protected router state. For a
foreground process, `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, and `GITHUB_TOKEN` are
checked in that order. Classic `ghp_` tokens are not supported by Copilot;
create a fine-grained `github_pat_` token
at [GitHub personal access tokens](https://github.com/settings/personal-access-tokens/new).
The router deliberately does not read or copy the official Copilot CLI's
credential store.

At request time the GitHub credential is validated through the Copilot account
endpoint, which also selects the account's inference host. That host is accepted
only when it is GitHub-owned. The tray reads the account's AI-credit or legacy
request quota when GitHub exposes a per-user meter; organization-managed plans
that expose no per-seat quota fall back to router-observed traffic.

GitHub documents the PAT permission and Copilot clients, while the inference
interface may continue to evolve. Requests consume the user's Copilot
allowance; use it
within the [GitHub Copilot terms](https://docs.github.com/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot)
and [acceptable use policies](https://docs.github.com/site-policy/acceptable-use-policies/github-acceptable-use-policies).

Kimi Code OAuth and Kimi Platform API access are separate authentication and
billing systems. The two Kimi entries intentionally coexist. Older DeepSeek
aliases remain hidden compatibility routes and are not advertised to new users.



The Ollama Cloud entries bill through an ollama.com account and can host the
same model families as other providers under a separate quota. Matching entries
(for example DeepSeek V4 Pro) intentionally coexist with the vendor-direct
providers because credentials and billing differ.
The Qwen plan entries cover every chat model the Individual Plan serves,
including the cross-vendor models it resells (DeepSeek V4 and GLM-5.2) under
the same plan key and quota. The cross-vendor entries use DashScope's
compatible-mode request profile because DashScope rejects each vendor's native
thinking parameters.
The Qwen entries default to the Alibaba Model Studio Token Plan endpoint in
the Singapore region. Coding Plan subscribers or other regions can point
`QWEN_PLAN_BASE_URL` at their dashboard-issued base URL. Plan keys use the
`sk-sp-` prefix and are separate from pay-as-you-go Model Studio keys; Alibaba
reserves plan endpoints for interactive coding tools.
The `zai-coding` entries use the GLM Coding Plan's dedicated endpoint and its
subscription API key. That key is not interchangeable with general Z.ai
platform keys, and Z.ai reserves the coding endpoint for interactive coding
tools. The metered platform is therefore a separate provider, `zai-api`, on
`https://api.z.ai/api/paas/v4` with its own key file and its own environment
variable (`ZAI_PLATFORM_API_KEY`, never the plan's `ZAI_API_KEY`) — connecting
one does not connect the other. GLM-5.3 ships on both routes with Z.ai's
documented low/high/max reasoning tiers and a one-million-token context
window. The `[1m]` model suffix that circulated for GLM-5.3 does not exist on
either Z.ai endpoint -- both the OpenAI-compatible coding route and the
Anthropic route reject `glm-5.3[1m]` with error 1214 -- and it was never
needed: a live run accepted 990,020 prompt tokens on the plain `glm-5.3`
code.
## Local model curation

Beyond the built-in models, each API-key provider's live catalog can be
curated interactively: `./bin/curate-models PROVIDER` lists the models the
provider currently advertises that are not in the registry, lets you toggle
the ones you want, and stores them as user models in protected state
(surviving updates, editable in place, and removable by re-running the
command and deselecting). Curation asks for each new model's context window,
image support, and reasoning efforts — so curated models get the effort
switcher in the picker — and everything defaults conservatively when
unanswered. The context window is not guessed when the provider publishes one:
the `context_length` its catalog advertises for the model is offered as the
default and stored by both curation forms, so a million-token model is not
filed as a 131K one and told to compact at 110K. The non-interactive
`--models id1,id2` form is additive: it keeps
existing curated entries and their metadata while adding the named models;
`--efforts minimal,low,medium,high,xhigh` sets the new entries' ladder. Remove
entries explicitly with `--remove id1,id2`. Every value stays editable in
`user-models.json`. Curation also asks whether the model rejects a forced
`tool_choice`: a few upstreams call tools happily when the choice is `auto`
but answer HTTP 400 when one is required, which fails the compatibility check
and the routed-subagent handoff even though tool calling works. Answering yes
stores `"requestProfile": "auto-tool-choice"`, and the router downgrades the
forced choice for that model only (`--request-profile auto-tool-choice` in the
`--models` form), for example:

```sh
./bin/curate-models PROVIDER --models MODEL_ID --request-profile auto-tool-choice
```

Vertex also has an explicit offline mode for accounts where Model Garden's
publisher-model list is unavailable: `./bin/curate-models vertex --static --models MODEL_ID`.
This uses only the reviewed entries in
`config/vertex/support-catalog.json`, never silently falls back after a live
discovery failure, and still requires working ADC, Vertex API enablement, IAM,
and model access when a request is sent. `--static` cannot be combined with
`--refresh`; it is a curation escape hatch, not proof that the account can use
every reviewed model.

For an already-curated model, edit only that entry's `requestProfile` in the
protected `user-models.json`, preserving its existing context, modalities,
efforts, and other hand-tuned metadata; do not remove and re-add it or apply a
broader vendor profile just to repair `tool_choice`. The provider's own
`/v1/models` endpoint always decides which models exist. Curated models are
local to your machine and are not vetted by the repository's compatibility
tests.

## Non-chat APIs

The same managed OpenAI base URL also serves `/v1/embeddings`, but only for a
model whose local or checked-in metadata explicitly names the capability. A
model that is both conversational and embedding-capable declares its normal
provider route plus `"/embeddings"`, for example:

```json
"supportedEndpoints": ["/chat/completions", "/embeddings"]
```

A dedicated embedding model uses only `"/embeddings"` and must set
`"listed": false` so it never appears as a conversational Codex model. Live
catalog discovery does not infer this capability. Requests and responses are
bounded to 8 MiB by default, caller cancellation reaches the provider, query
parameters on the secret-bearing capability URL are dropped, and embedding
requests are never retried or passed through a chat adapter. Redirects are
refused on both internal and provider hops so 307/308 cannot replay the POST.
The provider's normal credential isolation and generic-provider DNS checks
still apply. Messages-native provider protocols cannot opt into this OpenAI
endpoint.

The managed base URL also exposes `/v1/decisions` for OpenRouter's native
Decisions protocol. A model such as `openrouter-decisions/jev-latest` rides on the same
stored OpenRouter key as normal chat models, but its provider variant targets
`https://openrouter.ai/api/alpha`. This route preserves the caller capability,
body and response bounds, cancellation, and usage metering used by other native
routes. It is not a chat-completions adapter and does not synthesize an
assistant message; callers submit and consume the structured Decisions payload.
The Jev route is intentionally unlisted, so it cannot appear in Codex's
conversational model picker. It is for an explicit local integration such as
jev-pruner, never a substitute for Codex native compaction.

Connecting OpenRouter makes this Decisions route available to a client that
calls `/v1/decisions`. Do not add a Jev model in **Models** to turn on output
pruning. In particular, OpenRouter's `typesafe/jev-router` is a conversational
model route: selecting it changes the assistant used by Codex. It does not
activate the hidden `openrouter-decisions/jev-latest` route or install a tool
output hook. A Decisions client must be configured separately to call the
endpoint; automatic Codex tool output pruning needs its own hook.

If the Router goes offline during setup, use **Status → Service health → Fix**
in Control Center, then check Router health and return to a known working chat
model. Fix repairs and restarts the installed Router, so routed chats may be
interrupted. It does not enable a Decisions client. See the
[provider and model guide](https://github.com/duolahypercho/codex-router/blob/main/docs-site/src/content/docs/reference/providers-and-models.md)
for the general boundary between chat models and tool APIs.

### opencode (Go subscription and Zen)

The opencode provider family covers both of opencode's endpoints with one
stored API key (`OPENCODE_API_KEY` or `OPENCODE_GO_API_KEY` in the
environment): the flat-rate **Go** subscription at
`https://opencode.ai/zen/go/v1`, whose tested models ship in the registry, and the pay-per-use **Zen** endpoint at `https://opencode.ai/zen/v1`,
whose larger catalog is available through local curation
(`./bin/curate-models opencode-zen`). Everything appears as a single
"opencode Go/Zen" provider; internally the catalog is split across provider
IDs by
endpoint and by the protocol each model speaks upstream. Set the key once and
enable the family:

```sh
./bin/model-router codex provider-key opencode-go set
./bin/model-router codex providers enable opencode-go
```

An optional API-key pool can rotate between the two registry-declared
OpenCode environment sources without copying either secret into pool or
credential metadata. Export the values in an interactive shell (never put a
key in a command argument or chat). If the managed router is already running,
stop it before adding a new environment-backed entry: a running service cannot
inherit a newly named shell variable, and the command refuses to publish a
route the service could not authenticate.

```sh
codex-router key-pool opencode-go add-env OPENCODE_API_KEY
codex-router key-pool opencode-go add-env OPENCODE_GO_API_KEY
codex-router key-pool opencode-go policy round-robin
codex-router key-pool opencode-go status
```

Then rerun the installer from that same shell with `--providers configured`
(and the same target you installed originally). The installer copies only the
allowlisted variables referenced by the pool into the owner-only service
definition and starts it. A plain service restart is not enough because it
replays the old definition. Rerun the installer after removing or deleting an
environment-backed entry as well, so its old value is removed from the service
definition.

`pause <credential-id>` and `resume <credential-id>` change one entry without
deleting its credential metadata. Once a pool exists it is authoritative: an
empty, invalid, or unresolvable pool fails closed instead of silently spending
the legacy single key. A pre-response `429` can rebind the request to another
healthy entry; failover stops once response headers or body bytes have been
committed.

The desktop panel and macOS tray Settings tab provide both per-model controls
and provider-level Select all / Unselect all actions for which registry-proven
v2 models can run as subagents and which models appear in installed client
pickers. Local settings cannot promote an unverified model. Fully quit and
reopen Codex after changing either list; DeepSeek Harness hot-reloads its route,
and the next Gemini CLI invocation reads the new environment.
The Control Center keeps Go and pay-per-use Zen under this one credential card,
but exposes each live catalog as a separate source. Loading a catalog only
caches and previews its candidates; models are added to the picker only after
the operator explicitly selects them.

Model entries are maintained in the [registry](https://github.com/duolahypercho/codex-router/tree/main/config/).
Use the installed catalog and curation tools to see the currently available IDs.

`opencode-go` carries the Chat Completions models, `opencode-go-messages` the
Anthropic Messages models, `opencode-go-responses` the Responses models
(including Grok 4.5 and Grok 4.6), and
`opencode-zen` the pay-per-use Zen endpoint (no preselected models — curate
the ones you want). All four are one selectable family: they share a single
stored key, and enabling or disabling any of them toggles all of them
together.
Entries that duplicate a vendor-direct provider (for example DeepSeek V4 Pro)
intentionally coexist because the subscription bills separately. Point
`OPENCODE_GO_BASE_URL` (or `OPENCODE_ZEN_BASE_URL`) elsewhere to override the
endpoints.

### Anonymous free model gateways

Two additional entries use providers' documented free-model exceptions. Neither
asks for an API key, neither is ever selected on your behalf, and each is pinned
in code to its official endpoint.

| Picker label | Provider ID | Endpoint | Free-model rule |
| --- | --- | --- | --- |
| OpenCode Free | `opencode-free` | `https://opencode.ai/inference/v1` | `big-pickle` and IDs ending in `-free` (public CLI fingerprint; no key) |
| Kilo Free | `kilo-free` | `https://api.kilo.ai/api/gateway` | IDs ending in `:free` |

Neither ships its free subset as checked-in metadata: everything comes from the
provider's live `/models` response, filtered to the free subset and then added
locally with `./bin/curate-models`. OpenCode Free curation routes
`muse-spark-1.2-contributor-free` through its internal Responses sibling while
keeping the other free IDs on Chat Completions; the provider remains one
selection in setup and the picker. An existing Chat-routed copy of that one Muse
model is migrated only when the operator explicitly runs `curate-models`;
install, update, and catalog reads do not rewrite the user model or picker
state. Zen's `/models` response publishes no context limits, so free IDs that
OpenCode documents are sized from its published metadata instead of the
conservative 131K fallback, and each stored entry's `description` records where
its window came from. Every other free ID keeps the conservative default, and
any window is editable in `user-models.json`.

```sh
./bin/model-router codex providers enable opencode-free
./bin/curate-models opencode-free

./bin/model-router codex providers enable kilo-free
./bin/curate-models kilo-free
```

OpenCode Console documents that free chat models can omit the bearer header;
the paid Console models still require a key. Kilo documents anonymous access
only for `:free` models and limits anonymous traffic to 200 requests per hour
per IP. Both catalogs and limits are provider-controlled and can change, so
the router refuses paid IDs and shows traffic-only usage when no quota header
has been observed. Kilo's general SDK setup guide still asks external SDK
users for an API key; this entry intentionally covers only the gateway's
documented anonymous `:free` path.

Kilo's catalog also advertises `tencent/hy4-preview`, but that ID is paid: it
does not end in `:free`. The Kilo Free route deliberately filters it out rather
than presenting HY4 as an anonymous model.

### Free Auto: one model, many free backends (`free/auto`)

`free/auto` is a single model ID that is backed by a pool of anonymous free
models. Only `free/auto` shows up in the Codex picker and in the model lists.
The individual free models behind it stay hidden.

```sh
./bin/providers enable free        # opt in; no API key
./bin/control free-pool status     # members, drains, recent usage (JSON)
./bin/control free-pool refresh    # re-read the free lists from upstream, then restart the router
./bin/control free-pool reset      # forget every drain
```

**Members, in try order.** Kilo's `kilo-auto/free` router comes first. Next
come the Kilo gateway's free models (`:free` / `/free` / `-free`, plus other
`isFree` listings the catalog accepts), then the OpenCode Zen free lane
(`big-pickle` and IDs ending in `-free`, minus IDs Zen has withdrawn, as listed
in `src/opencode-curation.mjs`). Both lanes need no login and no API key. The
OpenCode lane talks to `https://opencode.ai/inference/v1` and sends OpenCode's
public CLI client fingerprint (User-Agent `opencode/latest/2.0.26/cli`,
`Authorization: Bearer public`, paired session headers, and the official
`read`/`shell` tool definitions — see `src/opencode-free-lane.mjs`). That is
the same public client shape the no-login reference plugin uses; there is no
per-user secret. A built-in list ships with the router. It is replaced by the
live `/models` lists (filtered to the free rule) when
`./bin/control free-pool refresh` runs, or once a day at router start while
`free` is enabled (`MODEL_ROUTER_FREE_POOL_REFRESH=0` turns that off). A
refreshed list takes effect after a router restart. If a refresh fails, the
last good list is kept, falling back to the built-in one.

**Fallback rules.**

- The pool tries members in order. It moves to the next member when a member
  answers 429, quota or usage-limit, any 5xx, model unavailable, or a network
  timeout, but only *before any text has streamed*.
- Once a member has streamed output, the turn stays with that member. A
  failure after that point is returned as it is, so no answer is ever spliced
  from two models.
- A plain request rejection, such as a bad tool schema or a 400, is returned
  as is and does not walk the pool.
- A member that fails is *drained* for a cooldown. The cooldown is the
  upstream's `Retry-After` for a rate limit (held between 30 seconds and 1
  hour), otherwise 10 minutes for rate limits, 1 hour for quota or a refused
  key, 2 minutes for a 5xx or timeout, 10 to 30 minutes when the upstream says
  the model is unavailable, and 6 hours for 402, 404 or 410. No cooldown is
  longer than 12 hours.
  Drained members are skipped until the cooldown passes. Drains are stored in
  `free-pool-drains.json` and never mark the `kilo-free` or `opencode-free`
  providers as cooling down.
- When every member is drained, `free/auto` returns HTTP 429 with error type
  `free_pool_exhausted` and a `retry_at` time.
- `MODEL_ROUTER_FREE_POOL_PREFER=<upstream id>[,<id>...]` moves the listed
  members to the front.

**Using it outside Codex.** In Codex, pick **Free Auto** in the model picker.
Any OpenAI-compatible client can send `"model": "free/auto"` to the router's
managed base URL, the `openai_base_url` in `~/.codex/config.toml`
(`http://127.0.0.1:4202/_codex-router/<caller-key>/v1`):

```sh
BASE="http://127.0.0.1:4202/_codex-router/<caller-key>"
# Responses API (streaming or not)
curl -s "$BASE/v1/responses" -H 'content-type: application/json' \
  -d '{"model":"free/auto","input":"Say hi","stream":false}'
# Chat Completions
curl -s "$BASE/cursor/v1/chat/completions" -H 'content-type: application/json' \
  -d '{"model":"free/auto","messages":[{"role":"user","content":"Say hi"}],"stream":false}'
```

The caller key is a secret, so don't share the full URL.

**Usage.** In the Control Center, the **Usage** page has a *Free Auto pool*
panel. It shows requests, tokens in and out, which backend model served each
request, fallbacks, drained members with their remaining cooldown, and
errors. The data is read from this machine's local usage log and drain file.
Nothing is sent anywhere.

**Caveats.**

- Free tiers are rate-limited per IP and shared by everyone behind that IP.
- Prompts sent to free models may be logged or used for training by the
  upstream.
- OpenCode's free tier accepts the public CLI fingerprint above. Without it
  the same free ids answer FreeTierError. The fingerprint is not a login and
  uses the pooled `Bearer public` credential; OpenCode may still rate-limit or
  region-block the IP, and may log prompts.
- A refreshed OpenCode or Kilo member list only takes effect after a router
  restart.

### Custom: one provider, many endpoints

Every other provider owns one address. `custom` owns none — each of its models
names its own endpoint, its own auth, and its own metadata, so a single picker
entry can hold a free community endpoint, a friend's self-hosted server, and a
paid API you have a key for, all at once.

```sh
./bin/model-router codex providers enable custom
```

Enabling it costs nothing and asks for nothing: a model that needs a key says so
on its own row. It is never selected for you and never part of the default set,
because what it holds is whatever somebody put in it.

| Model | Endpoint | Auth |
| --- | --- | --- |
| Qwen3.8-27-free-victor | `https://g9hnto0u7lvbu837.us-east-2.aws.endpoints.huggingface.cloud/v1` | none |

That first model is a free community [Hugging Face Inference
Endpoint](https://huggingface.co/spaces/victor/Qwen3.8-27B-free-endpoint) for
`Qwen/Qwen3.8-27B`, published by an individual rather than by Qwen or Hugging
Face: BF16 on one H200 behind vLLM, 262,144-token context, image input, tool
calling, and a thinking budget you dial with the normal effort picker. It is
shared and rate limited to roughly 30 requests per minute per IP, and its owner
says it will be retired once launch interest fades — so treat it as a model to
try, not one to depend on.

Your own endpoints are added from the desktop app rather than by hand. Open
**Control Center → Models**, click the **Custom** chip, and choose **Add
endpoint**. Give it a name, the base URL, whether it speaks Chat Completions or
Responses, and its API key; the key goes to the router over standard input and
is stored in its protected credential file, never in a command argument or a
log. Saving runs one `GET /models` against the address, so a typo, an
unreachable host, or a rejected key is reported while you are still looking at
the form.

Each endpoint then owns a chip of its own. Its menu lists the models you added
from it, with **Add models** to pick more from the endpoint's own catalog, **By
name** for a private or preview id that catalog never lists, a bin icon to drop
one, **Edit endpoint** to change the address, protocol, or key, and **Remove
endpoint** to delete the endpoint, its key, and its models together. Models are
published as `<endpoint>/<model id>`, so two endpoints serving the same model id
never collide.

The same operations exist on the command line, where an endpoint added this way
is a generic provider:

```sh
./bin/model-router codex providers generic add my-endpoint \
  --name "My Endpoint" --base-url https://api.example.com/v1 --adapter openai-chat
./bin/model-router codex providers generic credential my-endpoint set
./bin/curate-models my-endpoint
./bin/model-router codex providers generic add-model my-endpoint private-preview-1
```

`add-model` is the terminal form of **By name**: it registers an id the
endpoint does not advertise, without asking its catalog whether the id exists.
Registering an ID by name does not prove inference or tool-call compatibility.
Endpoint configuration is still validated; a registered ID that the provider
does not serve fails at request time and can be removed again.

An endpoint reached with **no credential** is the one thing a registry fragment
cannot introduce on its own. Its address has to be allowlisted in
`src/model-registry.mjs`, exactly as an anonymous provider's is, because
otherwise adding a JSON file under `config/custom/` would be enough to send your
prompts to any host on the internet with nothing to authenticate them. An
endpoint that carries a key, or one that stays on loopback, needs no allowlist
entry — the key or the address is already the boundary.

> **Use these at your own risk.** The two gateways above, and any `custom` model
> whose endpoint carries no credential, are the only routes here that reach an
> upstream with no account behind them, and that changes what "supported" can
> mean. Nobody has agreed to serve you: access is a published exception, not an
> entitlement, and it can be narrowed, rate-limited, or withdrawn without
> notice. On the two reseller gateways the naming rule is a heuristic rather
> than a promise — their catalogs
> carry no pricing field to check, so a model whose ID says `free` can still
> answer `401 Paid inference requests require an Authorization bearer token`,
> and the router cannot tell in advance. Anonymous traffic is identified by IP,
> so a router fanning out parallel subagents spends a budget shared with
> everyone behind that address. Treat these as a way to try a model, not as
> something to depend on: nothing in this repository can keep them working, and
> a failure here is not a bug the project can fix.

### Command Code

Command Code's official Provider API is an OpenAI-compatible chat completions
surface plus an Anthropic Messages surface at `https://api.commandcode.ai/provider/v1`
(`COMMAND_CODE_API_KEY` or `COMMANDCODE_API_KEY` in the environment, or store
the key once). Every plan except Go has API access; GOAT, Pro, Max, Team, and
Provider accounts use the API. Everything appears as one
"Command Code" provider; internally the catalog is split between
`commandcode` for Chat Completions models and `commandcode-messages` for
models that require the Messages protocol (Claude).

**The Go plan uses the coding-plan route.** A Go-plan account is refused by
`/provider/v1` with `403 upgrade_required` even though its key is valid. When
that exact entitlement response arrives before any response byte has been
relayed, the router retries the turn through Command Code's `/alpha/generate`
transport and remembers the result for that credential. Other 403s, timeouts,
rate limits, and server failures do not trigger the fallback. The route is
rechecked periodically so an upgraded account returns to the documented
Provider API. Both paths use the same stored key and provider family.

**Store an API key.** Create one in Command Code Studio and save it here:

```sh
./bin/model-router codex provider-key commandcode set
./bin/model-router codex providers enable commandcode
```

When multiple API-key sources exist, the exported environment variable wins,
then the key stored here, then the macOS Keychain. `doctor` names whichever
source is live. The router does not install, launch, or read a Command Code CLI
session; `/alpha/generate` is called directly as an inference transport.

Command Code's [headless CLI](https://commandcode.ai/docs/headless) is a
complete autonomous coding agent with its own workspace, tools, permission
decisions, sessions, and compaction. Launching it behind one Codex Responses
request would create a second, hidden tool loop and would bypass Codex's tool
events and approvals. It therefore cannot transparently replace the Codex
harness or transfer CLI-only AST/context/taste optimizations into the Codex
app. Codex remains the harness; this router only adapts the model transport and
preserves Command Code's reported cached-token usage.

Model entries are maintained in the [registry](https://github.com/duolahypercho/codex-router/tree/main/config/).
Use the installed catalog and curation tools to see the currently available IDs.

Both entries are one selectable family that shares a single stored key;
enabling or disabling either toggles the whole family together. The live
catalog is available without authentication from
`https://api.commandcode.ai/provider/v1/models`, and additional models can be
added per machine with `./bin/curate-models commandcode`. Point
`COMMANDCODE_BASE_URL` elsewhere to override the endpoint — both routes follow
it, so a redirected provider stays coherent. The tray reports the plan's
remaining credits and its 5-hour and weekly windows from the same undocumented
billing route the official CLI polls, and links to Command Code Studio when
that route is unavailable. A **Monthly limit** card is derived from the
billing-period spend in the usage summary plus the remaining plan credits,
resetting at the subscription's period end; it is omitted, rather than shown
as a guessed percentage, when either read fails or the subscription is past
due.

### Ox Alpha

Ox Alpha is a stealth reasoning model for coding and long-horizon agentic work:
a 1,048,576-token context window, 131,072 tokens of output, text and image
input, and tool calling. No checked-in Ox Alpha route remains. OpenCode Go
graduated the preview to the named, metered `glm-5.3-flash` model; direct
exact-route probes also certified that named model on OpenRouter and Z.ai
Coding, and the Z.ai API route is shipped with the same direct-proven ladder.

| Picker label | Model ID | Needs a key | Status |
| --- | --- | --- | --- |
| ~~Ox Alpha (Command Code)~~ | `commandcode/ox-alpha` | ~~Command Code~~ | Not shipped — upstream reported model unavailable |
| ~~Ox Alpha (Venice)~~ | `venice/ox-alpha` | ~~Venice~~ | Not shipped — wire verification was billing-blocked |
| ~~Ox Alpha (OpenCode Free)~~ | `opencode-free/ox-alpha` | ~~no~~ | Withdrawn |
| GLM-5.3-Flash (opencode Go) | `opencode-go/glm-5.3-flash` | opencode | Named replacement |
| GLM-5.3-Flash (Command Code) | `commandcode/glm-5.3-flash` | Command Code | Available — catalog-pinned, no exact-route run recorded |
| GLM-5.3-Flash (OpenRouter) | `openrouter/glm-5.3-flash` | OpenRouter | Available |
| GLM-5.3-Flash (Z.ai API) | `zai-api/glm-5.3-flash` | Z.ai API | Available |
| GLM-5.3-Flash (Z.ai Coding) | `zai-coding/glm-5.3-flash` | Z.ai Coding | Available |
| GLM-5.3-Flash (Ollama Cloud) | `ollama-cloud/glm-5.3-flash` | Ollama Cloud | Candidate — exact-route proof required |
| ~~Ox Alpha (OpenRouter)~~ | `openrouter/ox-alpha` | ~~OpenRouter~~ | Withdrawn |
| ~~Ox Alpha (Nous Research)~~ | `nousresearch/ox-alpha` | ~~Nous Portal~~ | Withdrawn |

The exact-route certification run sent basic, streaming, forced-tool,
stateless tool-result, and compact requests without failover for the named
OpenCode Go, OpenRouter, Z.ai API, and Z.ai Coding routes. The Ollama Cloud
candidate must pass that same router-level suite before it is called certified.
The full `ollama-cloud/glm-5.3` entry is candidate registry metadata too and
requires its own run of the same suite.
Command Code's `stealth/ox-alpha` rejected every surface as unavailable. The
available Venice account stopped at its API billing gate before
`stealth-ox-alpha` could be wire-certified. Publishing either preset would
therefore claim more than the evidence supports.

Reasoning effort is **low · high · max** on the certified named Flash routes,
defaulting to `max`. Only three rungs exist because
the model always thinks and its upstream says so outright — anything else comes
back as `400 — This model always engages in thinking and cannot be disabled;
please use low, high, or max`. Codex has more rungs than that, and a Codex older
than 0.143 has no `max` at all, so the router clamps whatever effort you pick
onto the three the model accepts. Existing `opencode-go/ox-alpha` and locally
curated `opencode-go/ox-alpha-free` selections migrate to
`opencode-go/glm-5.3-flash` automatically.

The picker retains the advertised 1M context. OpenCode Go, OpenRouter, Z.ai API,
and the other Flash routes keep the conservative 400K compaction threshold:
live multimodal histories on the original OpenCode Go route repeatedly returned
empty completions before the advertised limit. Z.ai Coding is provider-specific
at 500K. Current Codex Desktop subagents attach a tool-schema prefix large enough
that successful Z.ai Coding prompts reached 474K immediately after compaction;
keeping the copied 400K pin caused compact -> reopen above the threshold ->
compact loops. The 500K pin is deliberately smaller than the generic 850K
curation rule and still reserves half of the advertised window. The Z.ai Coding
Flash route also uses the same GPT-5.6 behavior template, concise agentic
instruction overlay, and standalone tool-search contract as the proven
full-size `zai-coding/glm-5.3` route. Standalone search keeps deferred tools out
of the initial Codex tool surface and loads them through the native
`tool_search` bridge on demand; this is the root fix for the large fixed prefix
that made compacted Flash subagents reopen above their threshold. OpenCode Go's
Flash route advertises the same deferred tool loading and concise project-work
instructions, with its 400K compaction threshold unchanged. A fresh desktop
turn is still needed to verify the provider-facing tool count and replay. These
execution/catalog capabilities are route-local: Flash remains conservative v1
for shipped multi-agent capability until its exact route has a separate
accepted `v2_agent` proof artifact. OpenCode Go's content moderation still
applies to the compaction request itself, so a sensitive transcript may be
rejected even when the ordinary task turn worked.

OpenCode Go withdrew its Union Alpha stealth preview and OpenRouter withdrew
`stealth/union-alpha`; neither id is listed upstream any more and no route is
checked in. Console Go still rejects a single message whose content exceeds
2,500,000 characters, so an oversized ImageGen data URL is replaced with a
labeled stub on every OpenCode Messages hop. Omen Alpha remains in the live Go
catalog but is deprecated in OpenCode's models.dev record and is not checked
in.

Command Code and Venice still expose their live catalogs to explicit curation.
An operator with an entitled account can inspect and select whatever those
catalogs currently publish:

```sh
./bin/curate-models commandcode
./bin/curate-models venice
```

That creates a per-machine route from provider catalog metadata; it does not
turn the repository's failed or blocked compatibility result into a guarantee.
The withdrawn OpenCode Free pin is likewise no longer published, although an
older local curation may still contain its stale upstream id.

### Meta Model API

Meta's Muse Spark models speak the Responses protocol at
`https://api.meta.ai/v1` (`META_API_KEY` in the environment, or store the key
once):

```sh
./bin/model-router codex provider-key meta set
./bin/model-router codex providers enable meta
```

Three Muse Spark models ship in the registry: 1.2 and its cheaper
Contributor tier (whose inputs and outputs Meta may use for training) with a
1M context window, reasoning efforts from minimal to xhigh, and reasoning
summaries enabled, plus the previous-generation 1.1. Additional Meta models
can be added per machine with `./bin/curate-models meta`. Point
`META_BASE_URL` elsewhere to override the endpoint.

### Catalog-only providers

These OpenAI-compatible providers are registered for routing and credential
isolation but ship no preselected models, because their catalogs change too
often for the repository to pin and live-verify individual entries:

| Provider | Provider ID | Base URL |
| --- | --- | --- |
| AI/ML API | `aimlapi` | `https://api.aimlapi.com/v1` |
| Atlas Cloud | `atlascloud` | `https://api.atlascloud.ai/v1` |
| Runcrate | `runcrate` | `https://api.runcrate.ai/v1` |
| Groq | `groq` | `https://api.groq.com/openai/v1` |
| Together AI | `together` | `https://api.together.xyz/v1` |
| Fireworks AI | `fireworks` | `https://api.fireworks.ai/inference/v1` |
| Cerebras | `cerebras` | `https://api.cerebras.ai/v1` |
| Mistral AI | `mistral` | `https://api.mistral.ai/v1` |
| NVIDIA NIM | `nvidia-nim` | `https://integrate.api.nvidia.com/v1` |
| SiliconFlow | `siliconflow` | `https://api.siliconflow.cn/v1` |
| Hugging Face Router | `huggingface` | `https://router.huggingface.co/v1` |
| Google Gemini API | `gemini-api` | `https://generativelanguage.googleapis.com/v1beta/openai` |
| GitHub Copilot | `github-copilot` | Account-specific GitHub Copilot endpoint |
| Chutes | `chutes` | `https://llm.chutes.ai/v1` |
| OrcaRouter | `orca` | `https://api.orcarouter.ai/v1` |

AI/ML API uses `AIMLAPI_API_KEY` or a key stored through
`./bin/model-router codex provider-key aimlapi set`. Run
`./bin/curate-models aimlapi` after connecting: discovery keeps only models
advertising the OpenAI chat-completions endpoint. No models are preselected.
`AIMLAPI_API_BASE_URL` overrides the endpoint. Account cards show router traffic
and link to the AI/ML API dashboard for usage and limits.

`devin-cli` is the OAuth exception to this API-key table. See the
[Devin compatibility probe](DEVIN-CLI-PROBE.md) for account-level verification.
After `devin auth
login`, the Control Center and `./bin/curate-models devin-cli` read the model
configuration available to that account through the installed Devin CLI; the
provider still ships no preselected models.

`vertex` is the Google Cloud exception. It uses Application Default Credentials
from `gcloud auth application-default login` plus
`./bin/control vertex set PROJECT_ID LOCATION`, not an API key, and it is
never selected by a default install. After connecting, run
`./bin/curate-models vertex`. A discovered Model Garden id is not routable
until it is curated onto a reviewed adapter.

OpenRouter, NanoGPT, Venice, and Nous Research are ordinary API-key providers with
live-reviewed checked-in routes in the registry. Use `bin/curate-models` for
anything else their current account catalogs expose:

| Provider | Provider ID | Base URL | Key from |
| --- | --- | --- | --- |
| OpenRouter | `openrouter` | `https://openrouter.ai/api/v1` | [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) |
| NanoGPT | `nano-gpt` | `https://nano-gpt.com/api/v1` | [nano-gpt.com](https://nano-gpt.com) |
| Venice | `venice` | `https://api.venice.ai/api/v1` | [venice.ai/settings/api](https://venice.ai/settings/api) |
| Nous Research (Hermes) | `nousresearch` | `https://inference-api.nousresearch.com/v1` | [portal.nousresearch.com](https://portal.nousresearch.com) |

Venice API access is an entitlement, not just a key: a free Venice account has
none. A Pro subscription (the low-rate-limit Explorer tier), a funded USD
balance, or staked VVV that grants VCU is what makes the key usable, and the
router prints that requirement wherever you connect the provider rather than
letting it arrive as a 403 inside Codex. Nous Research keys are Nous Portal API
keys and authenticate the same endpoint the Hermes agent uses.

Add a key, then pick the models you want from the provider's live catalog:

```sh
./bin/model-router codex provider-key groq set
./bin/curate-models groq
```

OrcaRouter's public catalog includes paid models and concrete zero-price model
deployments. Inference still requires an OrcaRouter API key, including for free
models. The moving `orcarouter/free` meta-router is intentionally not curated:
the picker shows the concrete model identity with a **Free** badge instead. To
add every currently advertised free OpenAI-compatible model without pinning
that changing list in the repository:

```sh
./bin/model-router codex provider-key orca set
./bin/curate-models orca --free-only --apply
```

The free list is read live from OrcaRouter's `/models` response. Re-run the
command when its catalog changes, and verify a curated model with
`./bin/test-model 'orca/MODEL_ID' --live --yes` before relying on it for
tool-driven work.

Curated entries use the context window, image support, and reasoning efforts
you provide during curation — the context window falling back to the one the
provider's catalog advertises, and to a conservative default only when it
advertises none — and are local to your machine. Verify a model before relying
on it:

```sh
./bin/test-model 'groq/MODEL_ID' --live --yes
```

Each base URL is overridable through the provider's `baseUrlEnv` variable, so a
regional endpoint or a self-hosted gateway can reuse the same provider entry.

Quota cards work for these providers without any extra configuration. Most
OpenAI-compatible services report the caller's remaining window on every
response through `x-ratelimit-*` headers, and Anthropic reports the same facts
under an `anthropic-ratelimit-*` prefix. The router reads those headers as
traffic passes through, so a provider starts showing real request and token
limits after its first request — no balance endpoint, no extra API call, and no
separate credential. Providers that publish no such headers, including Google
Gemini, keep showing router traffic only.
Gemini is routed through Google's OpenAI-compatible surface rather than the
native Gemini protocol, so it shares the existing forwarder and needs no
separate adapter.

Only explicitly selected router models from enabled providers appear in
installed client pickers. Adding a model during curation selects it for the
picker; merely enabling a provider does not flood the list:

```sh
./bin/model-router codex providers
./bin/model-router codex providers enable deepseek
./bin/model-router codex provider-key deepseek set
./bin/model-router codex provider-key anthropic-api set
```

On Windows, use `./model-router.ps1 codex` with the same commands.

## Router-owned default model (optional)

In a normal signed-in Codex installation, you can opt into an external router
model as the default for new tasks. The model must already be selected for the
picker. The router snapshots the prior Codex default, reapplies your router
choice after an update or repair, and restores that prior default when cleared:

```sh
./bin/control router-default set deepseek/deepseek-v4-flash
./bin/control router-default clear
```

This is separate from login-free mode, which has always owned its routed
default. Fully quit and reopen Codex after changing either default.

The API-key prompt disables terminal echo. Protected files use mode `600` on
POSIX and an inheritance-disabled, current-user ACL on Windows. Diagnostics
report credential presence and source, never the value.

## Adding providers to the project

The [`config/`](https://github.com/duolahypercho/codex-router/tree/main/config/) registry tree is the validated registry for
provider metadata, picker entries, upstream IDs, API protocols, context limits, request
profiles, modalities, and credential sources. Tested OpenAI-compatible and
Anthropic API providers share one credential-isolating forwarder and appear
in the Codex picker after compatibility tests pass.

Discovery does not publish every upstream model blindly:

```sh
./bin/discover-models deepseek
./bin/test-model 'deepseek/deepseek-v4-pro' --live --yes
```

New models should remain unlisted until official capabilities and live text,
streaming, image-input, tool-call, and context behavior are verified. See
[Development](DEVELOPMENT.md) for the registry contract.
