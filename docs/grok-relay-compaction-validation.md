# Relay and compaction validation — 2026-10-19

## Observed incidents and attribution

The installed `75d74bfd` recorded two native collaboration relay failures at
08:18:56 and 08:18:58 UTC. The old parser discarded provider error details and
reported only “omitted the task payload”. Their exact upstream cause cannot be
reconstructed from the retained logs. No claim is made that they were Grok
reasoning failures.

The 173.075-second compaction was one successful xAI attempt. Router preparation
was 1.747 seconds; the forwarder queue wait was zero. Upstream headers arrived
at 2.652 seconds, its first SSE event at 151.094 seconds and its terminal at
170.979 seconds (forwarder clock). The 148.442 seconds between headers and the
first event were upstream silence, not local queueing or recovery. The request
retained `xhigh`. A separate 41-second request used `medium`; these different
requests do not establish the causal effect of effort.

## Confirmed defects and scope

- A fresh native payload relay inherited the caller's turn-affinity and response
  dialect headers. A live synthetic `agent_message` with ordinary plaintext
  returned HTTP 200; adding `x-openai-internal-codex-responses-lite: true` to that
  ordinary relay request returned HTTP 400. The candidate isolates headers and
  returned the exact marker with HTTP 200 in 3.404 seconds. This tests the native
  relay wire contract, not decryption of a real encrypted child task.
- The previous relay parser accepted arguments before checking the full response
  and did not classify HTTP-200 SSE errors. The candidate requires a completed
  response and one unambiguous task call, fails closed on incomplete/error
  responses, rejects conflicting argument snapshots/deltas before caching a task,
  and preserves safe 401/429 classifications and account-scoped
  rate-limit backoff. Provider messages and task contents are not logged.
- Routed compaction inherited execution instructions at system/developer level
  while the checkpoint instruction was merely a user message. The candidate
  gives the summarizer its own instruction authority, retaining original
  instructions as quoted context. Source extraction precedes quotation, so
  provenance and user-source IDs do not change.
- Compaction now retains provider-reported service-tier metadata. Timing records
  distinguish requested and forwarded service tier. Neither context limits nor
  the requested reasoning effort/service tier is changed.

## Bounded live comparison

Explicit consent covered at most eight Grok calls, four native auxiliary calls
and twenty minutes. All activity used synthetic inputs; no production service
was restarted for the experiment. The live compaction comparison used an isolated
Grok forwarder and the real checkpoint instruction/codec modules. LiteLLM and
the Router HTTP listener were outside this live experiment; routing tests cover
their request boundary using deterministic mocks.

Four initial oversized synthetic-history requests were rejected with HTTP 400
and are excluded from performance and quality results. Their error bodies were
not retained; the initial history was approximately 2.3 times the final fixture.
All four still count toward the quota bound. Four subsequent calls succeeded:

| Order | Version | Input tokens | Cached input | Duration | Reasoning tokens |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 | baseline | 253359 | 1152 | 31.260 s | 887 |
| 2 | candidate | 253449 | 1152 | 25.528 s | 0 |
| 3 | candidate | 253449 | 253440 | 4.274 s | 0 |
| 4 | baseline | 253359 | 253312 | 17.070 s | 945 |

Every call requested `xhigh` and `priority`; the forwarder retained effort and
the provider reported priority. Both versions produced valid JSON preserving
the opaque objective marker and current blocker, with zero tool calls. The
candidate was faster in both pairs, but two samples per version do not establish
a general latency guarantee or prove the cause of the earlier 173-second wait.
This is a narrow checkpoint quality check, not a comprehensive semantic eval.

Native auxiliary calls: ordinary relay success; inherited-lite-header rejection;
one inconclusive response for which the probe's missing-content-type handling
failed; candidate success after fixing the probe. Four calls total, no further
live generations. Real encrypted subagent creation/follow-up remains an organic
post-install acceptance check, not something this experiment proved.

## Deterministic verification

The new routing regressions fail on PR baseline `6cf6d683`: caller dialect header
leakage, HTTP-200 SSE rate-limit misclassification, and compaction instruction
priority/actual-tier accounting. They pass with the candidate. Focused tests
also cover exact payload preservation, terminal failure after arguments,
truncation, malformed/ambiguous responses, JSON completion states, account
partitioning, cancellation, and source preservation.

## Follow-up tool-argument incident

Request `:2283` failed at 09:47:42 UTC with
`invalid custom tool arguments done: ambiguous_or_invalid_json`. Its first
upstream attempt failed before headers; a subsequent attempt completed, but
namespace restoration rejected tool arguments after commentary was committed.
Raw arguments were not retained, so the exact triggering event sequence is unknown.

Deterministic investigation found two real assembly defects: a nonempty
`output_item.added.arguments` prefix was stored but omitted from Chat deltas;
and a conflicting final snapshot was appended in full, potentially twice.
Both can corrupt the Chat argument stream. The fix emits the initial prefix and
only appends a snapshot's missing suffix. Conflicting snapshots fail closed with
`grok_tool_arguments_mismatch`; timing classifies this as `protocol_error`, not
network transport failure. No JSON repair, relaxed patch validation, or retry
of a committed action is introduced. Completed-response snapshots obey the same
invariant. Four new regression groups fail on baseline and pass with the fix;
HTTP/SSE tests cover byte-exact arguments, one terminal error, and no hidden retry.
This proves the assembly fixes, not their causal connection to request `:2283`.
