# Troubleshooting

Start with:

```sh
./bin/model-router codex doctor
```

Every `FAIL` includes a targeted fix. To rebuild only repository-managed files,
config, and service state:

```sh
./bin/doctor --fix
```

If a recognized older Kimi router is reported:

```sh
./bin/doctor --fix --migrate-known
```

Neither command prints credential values. Repair refuses unknown router owners.

## New native models (GPT-6 Astra, GPT-7, etc.)

**Uninstall is never required** to see new OpenAI/Codex native models. When Codex updates `~/.codex/models_cache.json` (new native model released), the router automatically detects fingerprint drift on next startup and republishes the catalog.

**Codex full quit/reopen is still required** to reload the catalog file. Codex reads `model_catalog_json` once at startup; the router cannot make Codex hot-reload.

Expected flow:
1. OpenAI releases new native (e.g., GPT-7)
2. Codex updates `models_cache.json`
3. Router detects drift on next startup/refresh → republishes automatically
4. Fully quit and reopen Codex → new native appears in picker

No uninstall needed. The router stays installed while merging ALL natives + routed models.

## State directory belongs to another checkout

If `doctor` reports a state ownership failure, you are running from a clone
that did not perform the install. The safe fix is to repair through the
checkout that owns the installed state:

```sh
./bin/model-router codex doctor --fix
```

When the recorded owner still exists, this command runs the repair there and
keeps the installed checkout unchanged. It deliberately transfers ownership to
the current checkout only when the recorded owner is gone or you set
`MODEL_ROUTER_ALLOW_FOREIGN_STATE=1`.

To inspect the recorded owner:

```sh
# Find the owning checkout from the state manifest.
STATE_DIR="${MODEL_ROUTER_STATE_DIR:-${CODEX_ROUTER_STATE_DIR:-${KIMI_CODEX_STATE_DIR:-${HOME}/.codex/codex-router}}}"
cat "$STATE_DIR/install-manifest.json" | sed -n '1,80p'
```

To deliberately switch ownership to the checkout you are running from:

```sh
MODEL_ROUTER_ALLOW_FOREIGN_STATE=1 ./bin/model-router codex doctor --fix
```

## External models are missing from the picker

```sh
./bin/providers
./bin/refresh-catalog
./bin/doctor
```

The intended provider must say both `SHOW` and `ready`. Enable a configured
provider with `./bin/providers enable PROVIDER`.

Then fully quit Codex, reopen it, and create a new task. Closing only a window
does not reload `model_catalog_json`.

Inspect Codex's startup catalog directly:

```sh
codex debug models
```

## Routed model agents are missing

Pulling `main` updates only the source checkout. Apply that revision to the
per-user Codex installation and verify the generated custom agents:

```sh
./bin/model-router codex update
./bin/model-router codex doctor
```

The doctor should report `OK` for `Routed model agents`. If it does not:

```sh
./bin/model-router codex doctor --fix
```

Then fully quit Codex, reopen it, and create a new task. The generated personal
agent definitions are stored under `$CODEX_HOME/agents/` (normally
`~/.codex/agents/`).

The config root should contain exactly one `codex-router-managed` block with the
loopback base URL on port 4202, a generated `/_codex-router/.../v1` path, and a catalog under
`$CODEX_HOME/codex-router/merged-models.json`.

The generated path is a local caller capability. Use `./bin/status`, which
redacts it, when sharing diagnostics. Never paste the complete URL into an issue.

## Kimi OAuth is not ready

```sh
kimi login
./bin/providers enable kimi-oauth
./bin/doctor
```

Codex Router reads the official Kimi CLI credential under `$KIMI_CODE_HOME` or
`~/.kimi-code` and refreshes it under a cross-process lock. Do not copy the OAuth
token into Codex config, an API-key file, or an environment variable.

## Windows blocks the Grok OAuth CLI

On Windows, first confirm that the installed official CLI can launch:

```powershell
grok --version
```

If `grok --version` works in a terminal but the doctor still reports the CLI as
blocked, upgrade first: releases before this fix picked the extensionless npm
shim out of `where.exe grok` and could not spawn it, and that failure raises the
same `spawn UNKNOWN` Windows application control does. The router now selects
the `grok.cmd` shim and launches it through `cmd.exe`.

If the command itself reports `spawn UNKNOWN`, "An Application Control policy
has blocked this file," or a Smart App Control notification, Grok OAuth cannot
complete login or refresh its session. Keep Smart App Control enabled; it does
not offer a safe per-app bypass for this failure. Until xAI publishes an
official CLI build that Windows allows, use the API-key provider instead:

```powershell
./model-router.ps1 codex provider-key grok-api set
./model-router.ps1 codex providers enable grok-api
./model-router.ps1 codex doctor
```

An OAuth session created while the executable was allowed is not a durable
workaround. The router invokes the official CLI again near token expiry, so the
session eventually stops refreshing if Windows blocks the executable later.

## Windows reports that process containment is unavailable

Commands that can mutate router state run inside a kill-on-close Windows Job
Object. The owner is compiled in-memory by Windows PowerShell before the target
command starts. If the error names `ConstrainedLanguage`, `Add-Type`, AppLocker,
or WDAC, the local application-control policy does not permit that safety
boundary. The router fails before launching the mutation; `-ExecutionPolicy
Bypass` does not and must not override system application control.

Check the effective language mode without exposing credentials:

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -Command '$ExecutionContext.SessionState.LanguageMode'
```

`FullLanguage` is required. Keep the policy enabled and ask the machine
administrator to allow the reviewed checkout/helper through the organization's
normal trusted-script policy, or run the router on a supported host where the
boundary is permitted. Do not work around the failure by disabling AppLocker,
WDAC, or antivirus protection.

## An API key is missing or invalid

```sh
./bin/provider-key kimi-api set
./bin/provider-key deepseek set
./bin/provider-key anthropic-api set
./bin/provider-key kimi-api status
./bin/provider-key deepseek status
./bin/provider-key anthropic-api status
```

Input is hidden. After you press Enter, the prompt reports how many characters
it received, so you can tell a paste registered, and it asks before saving a
value that looks like the same key pasted twice. A key written by the helper is
protected for the current user.
Setting or rotating it takes effect on the next request; the background service
does not need a restart.

Confirm the key belongs to the named system. Kimi Code OAuth, Kimi Platform,
DeepSeek, Anthropic, Alibaba Model Studio plans, and the Z.ai GLM Coding Plan
do not share credentials or billing. Alibaba plan keys (`sk-sp-` prefix) are
separate from pay-as-you-go Model Studio keys and only work with the plan's
dedicated base URL. The Z.ai coding key is also distinct from general Z.ai
platform keys; only the Coding Plan subscription key works with the coding
endpoint. The two live side by side as separate providers: `zai-coding` reads
`ZAI_API_KEY` / `ZAI_CODING_API_KEY` for the plan, and `zai-api` reads
`ZAI_PLATFORM_API_KEY` for pay-per-token traffic. A 401 on one route usually
means the other route's key was stored.

## A provider changed its model IDs

Compare the provider's official model-list endpoint with the registry:

```sh
./bin/discover-models deepseek
./bin/discover-models kimi-api
```

Discovery does not edit the registry. A new ID still needs official capability
metadata and an explicitly billed compatibility run covering text, streaming,
tools, and compaction:

```sh
./bin/test-model 'provider/model' --live --yes
```

Open a provider request with the official documentation and test results. Do
not add an untested model directly to every user's picker.

To use a newly discovered model locally without waiting for a registry
release, curate it for your own machine:

```sh
./bin/curate-models deepseek
```

Curated entries live in the state directory's `user-models.json` with the
context window, image support, and reasoning efforts you provide during
curation — the context window taken from the provider's advertised
`context_length` when you do not name one, and from a conservative default only
when the provider advertises none — are skipped automatically if a later
registry update ships the same model, and are removed by re-running the command
and deselecting them.

An entry curated before the router read that advertised size keeps whatever it
was given: an additive `--models` run deliberately leaves existing metadata
alone. Edit `contextWindow` and `autoCompact` in `user-models.json` directly, or
`--remove` the model and curate it again, then regenerate with `./bin/install`.

## A session ran past the context window instead of compacting

Codex decides when to auto-compact from the `input_tokens` each response
reports. A provider that answers a large prompt with `input_tokens: 0` leaves
that counter flat: the context bar looks nearly empty right up to the point the
provider itself rejects the turn for exceeding its context length.

The router substitutes an estimate of the prompt it just sent when — and only
when — a routed response explicitly reports zero prompt tokens for a request
that plainly carried a large one. The estimate errs high, because compaction
sits below the provider's hard limit and an estimate that lands too low would
let the turn die anyway.

Substitutions are recorded rather than hidden. The usage event keeps the
provider's own numbers and adds `estimatedInputTokens`, and the router logs
`estimated-input-tokens=<count>` on that turn, so a run of them means the
provider is still not reporting. Count them in the state directory's
`usage-events.jsonl`:

```sh
grep -c estimatedInputTokens "$CODEX_HOME/codex-router/usage-events.jsonl"
```

Report zero-token responses to the provider; only they can fix the source. To
see the provider's own numbers in Codex again, set
`CODEX_ROUTER_ZERO_INPUT_ESTIMATE=0` in the service environment.

## A session compacts on every turn instead of getting work done

The same substitution read against a window that is too small. Check what the
model is declared as:

```sh
grep -A2 '"contextWindow"' "$CODEX_HOME/codex-router/user-models.json"
```

Curation now stores the `context_length` the provider's catalog advertises, but
a model curated before that landed kept the conservative 131072 default — and a
model that really carries a million tokens is then told to compact at 110,000,
which a real conversation reaches long before it needs to. Compare it against
what the provider says:

```sh
./bin/discover-models PROVIDER --json
```

Fix it by editing `contextWindow` and `autoCompact` (85% of the window) in
`user-models.json`, or by `./bin/curate-models PROVIDER --remove MODEL_ID` and
curating the model again. Either way run `./bin/install` and restart the
service so the picker catalog and the gateway routes carry the new figures.

## Finished subagents stay Working

Codex 0.147 keeps a child visually working after it has already written
`FINAL_ANSWER` if the parent turn is still live. Opening the child flips it
to done because that loads the child's idle thread status. `close_agent` is
not in the v2 toolset; `interrupt_agent` is the close path that build
exposes.

The router now does two things:

1. Ships a managed `multi_agent_v2` usage hint so the parent is told to call
   `interrupt_agent` on finished children.
2. On routed parent turns, scans the request for unfinished `FINAL_ANSWER`
   children and injects any missing `interrupt_agent` calls into the response
   before it completes. That is what settles San Francisco multi-agent badges
   when the parent otherwise keeps working.

Restart the router service so the inject path is loaded, then start a new
parent turn (or nudge the stuck parent so it issues another request):

```sh
./bin/model-router codex doctor --fix
```

Already-stuck badges in an old San Francisco turn settle on the next parent
response (native or routed) that sees those children's `FINAL_ANSWER` in
input. If the parent is fully idle and never turns again, click into each
child once or send a short follow-up on the parent.

## The agent stops mid-task with no error

A routed turn that answers 200 with no output text and no tool call is invisible
to Codex: it has no code path for "the model said nothing", so it records the
empty response as a completed turn and the agent appears to stop for no reason.
Reasoning-only turns count — a model that thinks and then says nothing produces
exactly this.

Grok OAuth previously had a nearby parser failure with the same visible shape:
the upstream could put a `function_call` only in `response.output_item.done`,
emit a `custom_tool_call`, or end the final SSE block without a trailing blank
line. The forwarder now accepts all three shapes and restores final tool
arguments without holding the full turn, so Codex sees the tool call instead of
mistaking the preceding status text for the completed task.

A remaining Grok OAuth shape is a progress-only stop: the model reasons,
emits a status sentence, and never calls a tool. On turns following a user
message, attempt 1 still streams live; when the client offered tools and the
short-text/token trigger fires, the forwarder retries once and appends a
retry tool call onto the same stream. On turns following a tool result, the
stricter certified-repair path opens the response as soon as xAI returns its
headers and relays reasoning, but stages the short visible answer until the
terminal event proves it is safe.
After a conversation has exhibited that shape once, later user-message turns
buffer only a short visible prefix up to the same text threshold. Headers and
preceding reasoning remain live, and a tool call or longer answer releases the
prefix; if the upstream stream aborts instead, Codex receives the terminal
stream error without first recording another partial progress sentence. Unaffected
conversation IDs retain the fully live path, and the evidence set is bounded
in memory.

The trigger is a shape, not a diagnosis, and it is worth knowing which turns
pay for it. After a tool result, every no-tool prose response is held and
repaired once — no language match, token floor, or length threshold. The
repair must call exactly one function: either a client tool or the private
router final-answer tool. The latter is converted to ordinary assistant text
and never reaches Codex. A retry that does neither returns an explicit 502; it
is never converted into a clean `stop`. After a user message the older rule
remains: both a finished one-liner and a stalled plan retry when output tokens
clear the floor, and the nudge offers the no-tool branch first so "Yes, that
is correct." is not talked into a call the client would then run. Raise
`CODEX_ROUTER_GROK_PROGRESS_ONLY_MIN_OUTPUT_TOKENS` or lower
`CODEX_ROUTER_GROK_PROGRESS_ONLY_MAX_TEXT` to fire less often on that
user-message path; those settings do not weaken the post-tool invariant.

Both attempts are billed. The usage returned to Codex reports only the
selected attempt's context size, while the local ledger retains the aggregate
as billed input/output tokens. The response sets
`progress_only_retried: true`, and the log line `progress-only-retried=true`
is never gated on `MODEL_ROUTER_QUIET`. That line includes `attempt_*` and
`repair_*` header, first-event, and total durations plus each request's
`x-grok-req-id`. A failure while reading either stream emits
`upstream-phase-failed=true` with the same safe fields. `headers_ms` shows how
long xAI took to accept the request; `first_event_ms` separates an upstream
that emitted nothing from output the forwarder deliberately withheld. Prompt
and response content are never logged. To disable the invariant and see the
raw first attempt, set `CODEX_ROUTER_GROK_PROGRESS_ONLY_RETRY=0`; this kill
switch is intentionally unsafe for unattended tool loops.

The router holds the entire response until it knows the turn produced something.
When nothing arrives it discards that attempt and retries the identical request
once, so the client sees only one response head, response ID, and sequence space.
A retry that produces content streams normally. A retry that is empty again
returns an explicit 502 `empty_completion` error, and one that fails upstream
returns `empty_completion_retry_failed` — a stated failure either way, never a
silent success. The hold has byte and time limits. Crossing the byte limit while
no output has appeared aborts the still-hidden attempt and uses the same single
retry; crossing it again returns an explicit 502 `precontent_limit` error. The
time limit releases the prologue so a healthy slow stream stays visible and
cancellable, but the guard keeps parsing it with the same bounded stall and
partial-event limits. A headers-only response has nothing safe to release, so
it reaches the single retry after 30 seconds instead of hanging indefinitely.
If a released stream then completes without output, the router withholds its
terminal frames and emits an explicit `precontent_limit` SSE error first,
instead of accepting an empty success. These stated mid-stream failures retain
the already-committed HTTP 200 on the wire but are metered internally as 502.

Operators diagnosing an unusually slow upstream can temporarily change the
30-second bound with `CODEX_ROUTER_EMPTY_COMPLETION_PRELUDE_MS` and the 1 MiB
parser bound with `CODEX_ROUTER_EMPTY_COMPLETION_PRELUDE_BYTES`. These are
safety limits, not performance knobs: raising them also lengthens how long a
broken provider can occupy a turn and how much pre-content data it may retain.

Retried turns are marked in the state directory's `usage-events.jsonl`:
`emptyCompletionRetried: true` on every retried turn, plus `emptyCompletion:
true` when the turn produced nothing in the end. A limit-triggered retry also
records `emptyCompletionPreludeLimit` as `bytes` or `time`. The token counts on
those rows combine provider-reported usage from both complete, bounded attempts,
including an incompatible retry body the router rejects. A bodyless, oversized,
stalled, transport-failed, or usage-free attempt stays unknown rather than
becoming an invented zero. Count retried turns:

```sh
grep -c emptyCompletionRetried "$CODEX_HOME/codex-router/usage-events.jsonl"
```

A steady stream of them means the provider is returning empty completions;
report it to them. The retry re-sends the whole prompt, so to pay once and see
the raw upstream behaviour instead, set
`CODEX_ROUTER_EMPTY_COMPLETION_RETRY=0` in the service environment.

## Native GPT models stopped working

Temporarily return Codex to its native base URL:

```sh
./bin/disable
```

This removes only the marked block and current service; it preserves the
selected model, profiles, provider credentials, and ChatGPT login. If native
models work again, inspect router health and create a support bundle.

## Another process owns ports 4200–4203

macOS/Linux:

```sh
lsof -nP -iTCP:4200 -iTCP:4201 -iTCP:4202 -iTCP:4203 -sTCP:LISTEN
```

Windows PowerShell:

```powershell
Get-NetTCPConnection -LocalPort 4200,4201,4202,4203 -State Listen |
  Select-Object LocalAddress,LocalPort,OwningProcess
```

Do not kill the process until its owner and purpose are known. The installer
migrates only recognized earlier repository services and otherwise stops with a
conflict.

## The background service is stopped

macOS:

```sh
launchctl print "gui/$(id -u)/io.github.codex-router"
./bin/doctor --fix
```

Linux:

```sh
systemctl --user status codex-router.service
journalctl --user -u codex-router.service --since today
./bin/doctor --fix
```

Windows PowerShell:

```powershell
Get-ScheduledTask -TaskName "Codex Router"
./codex-router.ps1 doctor --fix
```

The task runs `start-codex-router-hidden.vbs` from the state directory under
`wscript.exe`, which starts `start-codex-router.cmd` without a console window,
so a missing window is not a sign that the router is down. Read `router.log` in
the same directory for its output.

Keep the repository at the absolute path used during installation. Rerun setup
from the new path if it was moved.

## An update failed

The updater normally reinstalls its cached previous revision automatically.
Manual rollback is:

```sh
./bin/rollback
```

Updates refuse edits to tracked files, non-`main` development branches, and
unknown origin URLs rather than overwriting local work. Untracked files never
block an update; the refusal names the tracked files that do, and re-running the
same command with `--force` discards those edits without deleting anything
untracked.

Legacy migration rollback is separate:

```sh
./bin/migrate rollback
```

## Create a support bundle

```sh
./bin/support-bundle
```

The generated mode-`600` JSON includes versions, doctor checks, service state,
provider presence, config ownership, and file metadata. It excludes credential
values, prompts, responses, and log contents on every invocation. The legacy
`--include-logs` option remains accepted for script compatibility, but is a
deprecated no-op: an old log may contain a credential that was later rotated
or deleted, so discovering only current values cannot prove a historical tail
safe. The tool never uploads a bundle automatically.

## Responses WebSocket does not connect

Current Codex Router releases accept the Responses WebSocket v2 upgrade on the
managed caller-capability URL. A 401 means Codex is using a stale managed URL;
run `./bin/doctor --fix`, then fully quit and reopen Codex. A 426 carrying the
supported `OpenAI-Beta: responses_websockets=2026-02-06` hint means Codex will
fall back to HTTP because the attempted WebSocket contract did not match. The
WebSocket adapter re-enters the ordinary HTTP Responses route, so provider and
model failures are reported as normal Responses error events rather than by a
separate provider path.

`X-Reasoning-Included` is a WebSocket-upgrade response flag in Codex. The
adapter cannot truthfully add a value learned from its later internal HTTP
response to an already-completed upgrade, so that one accounting hint is not
projected as a per-request WebSocket event.

## Voice Mode reports an unsupported `/v1/live` route

Codex Voice uses native realtime endpoints that are separate from the Responses
API. Current installs keep the WebRTC call and its sideband WebSocket on Codex's
native endpoints instead of sending them through the Responses-only router.

Run `./bin/enable` again after updating, fully quit Codex, and reopen it so the
managed realtime overrides take effect. User-owned realtime endpoint overrides
are preserved.

## Retained tool results are using disk

Tool-result compaction can park the exact original bytes of a result it rewrote
in `<state dir>/retained-tool-results`. That store is owner-only, is excluded
from support bundles, and is bounded rather than evicting — at its cap it stops
accepting new results and eligible results pass through uncompacted.

`./bin/doctor` reports the store on every run: file count, total size, the age
of the oldest entry, and the TTL. To empty it:

```sh
./bin/control tool-result-aging purge          # what it would remove
./bin/control tool-result-aging purge --yes    # remove it
```

Without `--yes` nothing is deleted. The purge removes only files the store
itself wrote, only inside that one directory, and refuses to follow a symlink
out of it; anything else that ends up there is reported and left alone. Deleting
retained bytes is not reversible — a compacted result in an open session keeps
its hash and head/tail evidence, but the original is gone.

Retained results expire after 7 days by default, so most stores never need a
purge at all. Nothing sweeps on a timer: entries expire when the store is next
written to. On an install where compaction is off, or one that filled before the
TTL existed, nothing is going to write again — run the sweep by hand:

```sh
./bin/control tool-result-aging purge --expired        # what has aged out
./bin/control tool-result-aging purge --expired --yes  # remove it
```

`--expired` removes only entries past the TTL, under the same containment as a
full purge, and never removes the store's key. Change the lifetime with
`./bin/control tool-result-aging ttl <days>`, keep everything with `ttl off`, or
return to the shipped default with `ttl default`. If doctor reports the store at
its cap and the entries are recent, the TTL has nothing to drain yet: purge it
or shorten the TTL. `CODEX_ROUTER_TOOL_RESULT_AGING=0` stops compaction but does
not stop expiry.

## Uninstall retained files

This is intentional. `./bin/uninstall` removes only the active integration and
background service. The state directory may contain credentials, logs, catalog
caches, install history, and rollback snapshots. Inspect it manually before
deleting anything.
