# Grok reasoning and request timings

Grok OAuth accepts both a scalar `reasoning_effort` and the Responses
`reasoning: { effort, summary }` object. Router copies the final reasoning
choice, after any subagent override, into LiteLLM's supported `extra_body`
at the owned Responses-to-Chat boundary. The locked gateway otherwise drops
the effort for generic OpenAI-compatible Chat models; a deployment-level
`allowed_openai_params` does not reach its nested Chat call. The forwarder
normalizes either representation into the upstream Responses effort. An
omitted effort stays omitted; Router does not invent a default here. Existing
model-specific aliases and xhigh support remain unchanged. API-key Grok and
other providers retain their existing reasoning paths.

Ordinary turns and both remote compaction forms now use the same final bridge
adaptation. Previously the compaction branch bypassed it: explicit reasoning
could disappear and the forwarder generated a different correlation ID.
An omitted compaction effort still stays omitted. The summarizer also sends
the standard `tool_choice: none` prohibition. The forwarder consumes it by
removing client and hosted tools, then omits the choice on the tool-free xAI
request. An empty client tool list alone did not prevent the forwarder from
adding `web_search` and `x_search`. Ordinary requests without an explicit
prohibition retain their existing hosted search capability.

## Reading stage timings

`[grok-timing]` JSON records in the service log join the Router and OAuth
forwarder by `requestId`, also present in `usage-events.jsonl`. The Router owns
this correlation ID; it is sent only to the local gateway and forwarder, never
to xAI. Each forwarder attempt has a separate `upstreamRequestId`.

All `*Ms` marks are elapsed milliseconds from receipt **in that process**,
measured with a monotonic clock. Subtract marks in the same record; do not
subtract Router marks from forwarder marks. `startedAt` is wall time for
correlation. Missing marks mean the stage was not observed, not zero latency.

| Boundary | Marks and interpretation |
| --- | --- |
| Router preparation | `parsedMs`, `preparedMs`: body parsing, then routing and request adaptation completed |
| Gateway | `firstGatewayDispatchMs` to `firstGatewayHeadersMs`: first gateway request to response headers |
| Forwarder preparation | `parsedMs`, `preparedMs`: JSON parsing and upstream request adaptation |
| Local concurrency queue | Per attempt: `dispatchMs - queuedMs` |
| Upstream headers | Per attempt: `headersMs - dispatchMs`, including transport and provider scheduling |
| Upstream output | Per attempt: `firstEventMs`, `firstReasoningMs`, `firstTextMs`, `firstToolMs`, `firstToolReadyMs`, `terminalMs` |
| Forwarder release | `firstActionMs`: first text or tool action released to the gateway; post-tool actions may wait for a certified terminal |
| Codex-facing stream | Router `firstReasoningMs`, `firstTextMs`, `firstToolMs`, `terminalMs`, observed after its output transformations |
| Completion | `totalMs` and transport `outcome`; semantic success is separately recorded as `terminal: completed` |

Attempt HTTP errors, transport errors, cancellation, and a stream ending
without a semantic terminal remain distinct. A finished HTTP response alone
does not prove a successful model turn. Preparation-to-queue time can include
authentication and CLI-version work; it is not reported as queue time. The
Router records only the first gateway dispatch/headers; gateway retries can
produce multiple forwarder records with the same correlation ID. These
records cover ordinary Grok OAuth requests and compaction. Router timing and
usage records label these as `requestKind: generation` or `compaction`.
Compaction records preparation, dispatch, gateway headers and the client-facing
terminal; forwarder records locate the work within the summary generation.
A locally skipped compaction has a completed checkpoint but no dispatch or
provider-header marks. Cancellation does not fabricate a semantic terminal.
Usage records preserve `httpStatus` separately from `generationOutcome`, so
a streamed error carried by HTTP 200 is still a failed compaction. These
records are not a complete cross-provider failover trace.

Diagnostics are bounded and contain no prompts, tool arguments/results,
reasoning text, credentials, URLs, or arbitrary error messages. They remain
available in quiet mode. Requested and forwarded effort are recorded
separately; aliases may legitimately differ. Unknown/absent effort is `null`.
These timings locate delay at observable boundaries; they do not measure
provider-internal compute time or establish a speed improvement by themselves.

## Checking tool delivery

The same records contain bounded `toolSurfaces` inventories: Router `client`
and `gateway`, then forwarder `gateway` and `upstream`. `count` counts all
leaf declarations, including hosted tools. `known` only admits a fixed set of
execution and editing names: `exec_command`, `write_stdin`, `shell_command`,
`apply_patch`, `replace_lines`, `search_replace`, `write`, and
`run_terminal_command`, `exec`, and `tool_search`. It also recognizes only
`list_projects`, `create_thread`, and `automation_update` in the exact
`codex_app` and `mcp__codex_app` namespaces, retaining their distinct identities.
For these, it records declaration count, declaration type, explicit
function/namespace deferral, schema SHA-256 and a fixed allowlist of parameter
names. Native search records its `client`/`server` execution kind; its Chat relay
is a function declaration. An app definition may correctly be absent before
search, then appear after a `tool_search_output` supplies it. It never logs arbitrary tool names, descriptions, schemas or arguments.
At most four declarations per known name are retained, even for duplicates.
The forwarder snapshot describes the initial prepared request, not a separate
inventory for every repair attempt.

Join records by request ID to locate where a known tool disappeared or its
schema changed. Namespace flattening, custom-patch conversion and provider
schema adaptation can legitimately change a hash; a changed hash alone is not
evidence of corruption. During compaction, client tools may be present at
ingress while both provider-facing inventories are intentionally empty.

The real Codex executable was also driven through the locked bridge with a
local synthetic provider. Native `exec_command` produced an actual running
session, `write_stdin` read its output and nonzero exit status, and the editing
probe recovered from a missing patch context and changed the fixture. This
proves the core tool protocol, not that a live model will select the right tool
or that a desktop chat has the same additional MCP registrations. Runtime
inventories make the latter observable without recording private schemas.

## Verification

`node scripts/verify-grok-service-tier.mjs .venv/bin/python` exercises the
generated production configuration through Router, the locked LiteLLM gateway,
the real forwarder, and a synthetic loopback provider. It covers all advertised
OAuth efforts with and without summaries, scalar effort, HTTP streaming,
HTTP JSON, WebSocket, post-tool completion and repair. Delayed-terminal cases
verify that upstream tool readiness and action release are measured separately.
It also covers nine compaction cases: V1 JSON and V2 JSON/SSE, each with object,
scalar or omitted reasoning, no tool dispatch, and correlated stage/usage
records. There are 135 scenarios in total. Focused HTTP tests cover failed,
canceled and locally skipped compaction; unit tests cover child overrides,
failed/incomplete/missing terminals, timing bounds and log privacy.

Repeat the real-client execution and editing checks with an installed Codex
binary (the client's own workspace sandbox remains enabled):

```sh
node scripts/verify-grok-apply-patch-guidance.mjs .venv/bin/python --structured --native-exec --codex=/absolute/path/to/codex
node scripts/verify-grok-apply-patch-guidance.mjs .venv/bin/python --structured --codex=/absolute/path/to/codex
```

These checks use a disposable client home, isolated Router/gateway and fake
provider credentials. No live quota is used. A sandbox wrapping the whole
test must permit the nested client's workspace writes; a denial by that outer
sandbox is not a provider editing failure. No latency or live model-quality
improvement is inferred from these deterministic checks.


## Parallel calls and current app registrations

`parallelToolCalls` records the incoming Router `client` value and the
forwarder's `gateway`/`upstream` values as boolean or `null` (absent/invalid).
The forwarder preserves explicit `parallel_tool_calls: false` and `true`;
omission stays omitted. Previously this field was dropped when converting Chat
back to xAI Responses, so a caller's explicit serialization request was lost.
No calls are suppressed, reordered, or executed by the Router.

Current Codex deliberately removed the model-catalog parallel flag in
[86b1123](https://github.com/openai/codex/commit/86b1123ff6b5d089a146be4e603a324cf454223a).
The installed Codex 0.162.0-alpha.17.2 sends `true` even with the legacy catalog
field set to `false`. Actual scheduling is a separate per-tool client policy.
The offline `--native-tool-policy` probe captures ingress and checks that it
survives every hop, then executes three fixture-selected dependent native
patches. This proves feedback and final integrity, not Grok's choice of tools.

The additional `--native-scheduler=read|race|patch` diagnostics exercise two
simultaneous tool calls in the real client. They establish parallel reads,
deterministically reproduce a lost update from shell read/modify/write, and
show that conflicting native patches produce one success and one context
conflict. See [the evidence and client-side correction boundary](codex-edit-concurrency.md).
These diagnostics do not claim that Router fixes arbitrary shell races.

A client declaring modern `mcp__codex_app` tools owns that app surface. The
legacy `codex_app` snapshot is no longer appended alongside it when native
search is absent. Older native app clients retain their compatibility path.
This fixes a reproduced duplicate-registration defect. A separate full-chain
regression found that a search-only response was restored to native
`tool_search_call` before the empty-completion guard, which recognized only
ordinary/custom tool calls and text. The guard withheld the search and retried
the same generation without letting Codex return discovery results. It now
recognizes the native search action, preserving the terminal and avoiding that
retry. Search results by themselves and reasoning-only responses remain empty.
Native search also records tool-ready timing after restoration.

The local full-chain verifier exercises actual discovery, MCP dispatch and
result replay with a fixture server. The feedback feature flag
`tool_search=false` does not imply that the wire search control is absent.
This reproduces and repairs a Router loop mechanism; the historical Air shell
loop cannot be uniquely attributed to it without the original wire capture.

```sh
node scripts/verify-grok-apply-patch-guidance.mjs .venv/bin/python --structured --native-tool-policy --codex=/absolute/path/to/codex
node scripts/verify-grok-app-tools.mjs .venv/bin/python --codex=/absolute/path/to/codex
```
