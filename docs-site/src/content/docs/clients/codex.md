---
title: "Codex"
description: "Publish routed models into the Codex CLI and desktop app."
---
After setup:

1. Run `./bin/model-router codex doctor` and resolve any `FAIL` line.
2. Confirm `providers` says `SHOW` and `ready` for the intended provider.
3. Fully quit Codex, reopen it, and create a new task.
4. Open the normal model picker.

Codex loads `model_catalog_json` only at app startup. If models are still
missing, run `./bin/refresh-catalog`, fully quit Codex, and reopen it.

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

For routed external models, old textual tool results larger than 32 KiB are
compacted after the model has acted on them. The four newest tool results stay
intact, and each compacted result keeps a hash, head/tail evidence, and an exact
read-only snapshot command.

This is **off by default.** It rewrites what the model sees mid-conversation,
so it is opted into rather than discovered after it has already altered a
session. Turning it on is remembered: a stored answer is kept verbatim and is
never re-defaulted by a later release.

Toggle **Token maxxing** in the router Settings;
the next external-model request sees the change without restarting Codex or the
router. The equivalent CLI commands are `./bin/control tool-result-aging on`,
`off`, and `status`.

That switch does not add a second context-pressure policy. Codex, DeepSeek
Harness, and Gemini CLI decide when the whole conversation needs compaction.
Ordinary routed turns only compact consumed old results, so the newest four
results remain byte-for-byte exact regardless of context size.

The whole-history compaction summarizer has no execution tools and receives
exact tool results. Other requests use the same aging policy and keep recent
results intact.

Native OpenAI traffic is unchanged by default. `./bin/control
tool-result-aging native on` extends the same compaction to native GPT models;
`native off` restores the default. It is opt-in because it changes what is sent
to OpenAI's own endpoint, and an install that has never run it keeps the
pre-existing behavior. Set `CODEX_ROUTER_TOOL_RESULT_AGING=0` for a hard
environment-level override that disables both the routed and the native path.

Before any old result is omitted, its exact received text is saved
to an owner-private store at `<state dir>/retained-tool-results` (override with
`MODEL_ROUTER_TOOL_RESULT_RETENTION_DIR`). A receipt includes a platform-specific
local command with an opaque handle. It returns bounded JSON pages (`text`,
`nextOffset`, `eof`); add `--offset N --limit N` or `--find 'literal text'` to
retrieve omitted evidence. Offsets and limits count UTF-16 characters without
splitting a surrogate pair. `control tool-result-aging read HANDLE` exposes the
same reader. It never runs the original tool again.

A request must expose a known local shell tool **and prove it can read the
private store**. Until a successful read, the complete original stays in context
with a small readback footer. A successful reader returns a signed, 30-minute
proof; Router accepts it only from tool-result history in the same conversation
and system/developer instruction context. Changing permissions invalidates the
proof. A workspace sandbox may deny private-store access: Router then keeps
full output and does not weaken the sandbox or request automatic escalation.
Otherwise results stay intact,
as they do on storage, ACL, lock, capacity, or integrity failures. Store limits
are 512 results / 512 MiB, with an 8 MiB maximum per received result. A bounded
per-request archival budget may leave additional results intact for that turn.
Originals already truncated by a tool before reaching Router cannot be restored.
Only the local account may read the files; snapshots are excluded from support
bundles and are not served over HTTP. These commands inspect and manage them:

```sh
./bin/doctor                                     # count, size, oldest entry, TTL
./bin/control tool-result-aging purge            # says what it would remove
./bin/control tool-result-aging purge --yes      # removes it
./bin/control tool-result-aging purge --expired  # only what the TTL outlived
./bin/control tool-result-aging ttl 30           # keep retained results 30 days
./bin/control tool-result-aging ttl off          # keep them until purged
./bin/control tool-result-aging ttl default      # back to 7 days
```

The doctor row appears whether or not the store exists, because an install that
has never retained anything is the answer most people should see and seeing it
is how the directory becomes discoverable at all. The purge is a report by
default: without `--yes` it prints what it would remove and removes nothing, and
`--dry-run` says the same thing explicitly and outranks `--yes`. It removes only
files this store wrote, only inside that one directory, never recursing and
never following a symlink out of it; anything else that ends up there is left in
place and named.

**Retained results expire after seven days of inactivity by default.** Replaying
an original renews its lease; normal readback does not. Expired or purged handles
return an explicit error, as do corrupt files. Such content is unavailable
evidence, not permission to rerun an old command. Nothing sweeps on a timer:
expiry runs on new writes or explicit `purge --expired`. The install key is
never expired. Use `ttl off` for long-lived evidence that must remain until
explicit purge. The aging kill switch disables rewriting, not explicit expiry.

To estimate the effect without spending provider quota, run:

```bash
node scripts/measure-tool-result-aging.mjs /path/to/rollout.jsonl
```

The report compares each observed compaction boundary and the latest history
before and after aging; this is an estimate and spends no provider quota.
`node scripts/aging-benchmark.mjs` reports the savings already recorded in
`usage-events.jsonl` — measured turns rather than an estimate. For a
live check, leave the setting on and inspect `usage-events.jsonl` after a routed
turn; events that compacted history include `toolResultsAged` and
`toolResultBytesSaved`. Those counters measure
serialized context bytes, while provider-billed token counts remain the
authoritative cost measurement.

For a reproducible provider-reported A/B, see
[`docs/tool-result-aging-benchmark.md`](https://github.com/duolahypercho/codex-router/blob/main/docs/tool-result-aging-benchmark.md).

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
