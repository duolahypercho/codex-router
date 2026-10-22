# Grok agent-loop quality verification

Baseline: `8c5c128867d3b9f1bd359b9e9491d94cd65b90e1` (upstream main,
2026-10-16). All experiments use synthetic fixtures and isolated loopback
forwarders. Those campaigns left the installed service and client configuration
unchanged; a later user-authorized installation enabled manual testing.

## Final implementation and acceptance boundary

Grok 4.6/4.7 receive typed patches and a whole-line `replace_lines` facade.
The client's native executor retains filesystem ownership, permissions and
matching rules. The optional patch hook receives raw replacement arguments so
exact-match/create-only validation happens before patch execution.

The Grok schema adapter preserves complete alternatives. Proven disjoint root
operation variants become separate descriptive provider functions. Their full
constraints and root definitions remain intact; unsupported schemas stay
unchanged. The forwarder restores original client names and arguments and maps
historical calls back to the appropriate provider operation. Call IDs and
encrypted reasoning carry are preserved. Explicit caller tool choice, reserved
search names, duplicate definitions, name collisions and tool limits retain
regression coverage.

After a tool result, the provider may call another client tool or finish with
native text. A private final tool remains optional. Forcing `required` here was
removed after live traces showed prolonged text generation instead of a tool
call. A successful nonempty native final takes one generation. Only an empty
successful response may be repaired once; failed, incomplete, canceled or
truncated attempts never release held actions. A successful terminal establishes
protocol completion, not proof that the model fulfilled the user's task.

Caller sampling values are preserved, with temperature 0.7/top-p 0.95 defaults
matching [xAI guidance](https://docs.x.ai/developers/model-capabilities/text/best-practices)
and the inspected official Grok CLI.
Caller output budgets reach the Responses API; `max_output_tokens` limits visible
text, not reasoning or function arguments. No production timeout was shortened
and no generic repeat-count breaker or retry-until-success loop was introduced.

## Measurement method

Live runs use Grok 4.7 OAuth at medium effort with service tier omitted. They
exercise the actual Chat adapter and synthetic client tool loop; the original
edit campaign also uses the stock Codex patch executor. They bypass the Router
HTTP listener and LiteLLM. Separate deterministic full-hop checks cover Router →
locked LiteLLM → forwarder over HTTP JSON, SSE and WebSocket. Neither is a desktop
UI acceptance test or a matched Grok Build comparison.

Success requires the requested state transition with all unrelated fields
preserved, exactly one update, and a nonempty final answer. The arithmetic final
fixture requires just `42` (optional punctuation). Every started run, failure,
interruption and exclusion is retained. Missing telemetry remains missing.
Small synthetic samples cannot establish universal loop freedom or general speed.

## Original comparison: editing and schema correctness

[Original campaign](grok-agent-loop-quality-results.json) retains all 18 planned
slots: three fixtures × three repetitions × main/candidate, alternating arms.
The user authorized 120 generations/20 minutes including schema probes.
Each task allowed six client turns/twelve generations and a 90-second request
limit. These were experiment limits, not production timeout settings.

Edit runs 1 and 2 had a broken benchmark verifier import and are excluded from
quality denominators; both edited the file but subsequent behavior is
uninterpretable. Baseline run 5 was interrupted during that harness correction
and charged the entire 12-generation allowance. No excluded run was silently
rerun. Unaffected failed runs remain in the denominators.

| Fixture | Main | Then-current candidate | Requests per eligible run |
| --- | --- | --- | --- |
| Edit repeated context and verify | 2/2 | 2/2 | 5 vs 4 |
| Recover invalid id, then update | 0/3 | 0/3 | 6 vs 6 (limit) |
| Two sequential tools, then final | 2/2 | 2/3 | 4 vs 3 |

Recovery generated 14 invalid calls on main and zero on the candidate, but valid
reads/updates still repeated. Overall success was 4/7 vs 4/8 eligible tasks:
schema correctness improved, aggregate task success did not. Eligible edit times
were 11.193/36.132 seconds vs 10.432/8.183; this sample does not support a general
latency claim. Neither eligible arm rejected a native patch.

Usage was 83 known requests + at most 12 interrupted requests + six schema
probes. [Schema evidence](grok-schema-probes.json) also records 414 independent
validator comparisons. A separately approved three-run
[final check](grok-final-validation.json) completed 2/3 in one generation
(4.843/2.103 seconds); the other reached its 90-second harness deadline. The old
observer did not robustly decode every SSE shape, so a missing terminal in that
report cannot alone identify the upstream failure. Total usage was at most
104/120. These historical results are not retroactively credited to later code.

## Follow-up diagnosis: 60 generations

[All 19 follow-up runs](grok-loop-followup-results.json) consumed the separately
authorized 60-generation/30-minute budget. The report contains several explicitly
named stages, not one homogeneous candidate. No failing run was removed.

| Stage | Runs | Observation |
| --- | --- | --- |
| Diagnose current/auto/no-reasoning-carry | 1–6 | Normal recovery sometimes completed; disabling carry looped. One final had 967 text deltas before a transport error at 45.503 seconds. |
| Test repeated-result advisory with forced final | 7–15 | Five of six recovery cases completed; one still looped. A final generated 4,885 text deltas over 301.613 seconds before the client fetch failed. |
| Native final with advisory and sampling defaults | 16–19 | Both seeded repeat cases still looped. One arithmetic final passed, one violated the strict answer-format oracle. |

The advisory did not reliably resolve repetition and was removed. Structural
operation lowering was implemented afterward. The long final traces expose
continued provider text generation behind a forced function choice, rather than
a silent local deadlock; they do not prove every historical timeout has that
cause. The forwarder now accepts successful native text without a second
completion generation. Its transport/cancellation contracts remain covered by
fault tests.

The new observer uses the production SSE decoder for CRLF/LF, multiline data and
EOF, records timing/event kinds/terminal/usage, and seals the first terminal.
It stores no raw reasoning or argument text. Diagnostic run 4's source snapshot
was taken after a source edit while its child process still had the prior code
loaded; that run is diagnostic only, not exact-revision acceptance. Final
acceptance records source immutability per run.

## Structural correction acceptance

The user separately authorized six tasks, at most 30 generations and 20 minutes:
two normal invalid-id recoveries, two seeded three-read loops, and two arithmetic
finals. Each uses the frozen final source, six client turns and a 180-second
request deadline. Results: [acceptance telemetry](grok-loop-acceptance-results.json).

All **6/6 tasks passed**, using **13/30 provider generations**. All 13 upstream
responses completed successfully; every recorded source snapshot remained
unchanged. No generated call failed schema validation, no task hit its client
turn limit, and no request timed out.

| Fixture | Success | Requests per task | Task elapsed time |
| --- | --- | --- | --- |
| Invalid-id recovery | 2/2 | 3 / 3 | 58.800 / 11.176 seconds |
| Seeded three-read loop | 2/2 | 2 / 3 | 6.465 / 5.886 seconds |
| Arithmetic post-tool final | 2/2 | 1 / 1 | 1.747 / 4.506 seconds |

Both seeded loops selected the update immediately; one then read back the state
before finishing. Every recovery task performed exactly one update and preserved
all other fields. The first request received headers in 1.425 seconds but its
first decoded event only at 50.128 seconds and completed at 52.465 seconds.
Latency variability remains; the local full test suite was running concurrently,
so these wall times are not an isolated performance benchmark. These observations support
fixture-level loop recovery and single-generation completion, not a universal
speedup or elimination of all upstream stalls.

The original main recovery result was 0/3; the final candidate recovery result
is 4/4 including seeded loops. These were separate sequential campaigns, not a
new randomized paired comparison. Earlier 0/3 results and failed advisory runs
remain published alongside the final result.

## Regression verification

- `npm run check`: passed (syntax, seven app definitions, 101 changelog fragments).
- Full local suite before the last test-fixture correction: 5,440 tests,
  5,400 passed, one failed, 39 skipped. The sole failure expected text to
  trigger recovery; it now uses an empty successful answer, preserving the
  selected-attempt reasoning assertion. Its module then passed 5/5.
- Combined final schema/forwarder/turn/carry/observer contracts: **276/276 passed**.
- Real stock Codex patch parser: **18/18 scenarios passed**.
- Router → locked LiteLLM → forwarder: **24/24 scenarios passed**, including
  tool alternatives, sampling/output budget preservation, and one-generation
  completion over HTTP JSON, SSE and WebSocket.
- Final live acceptance: **6/6 passed**, 13 generations, source unchanged.

The PR's checks and description record the subsequent full-suite/CI outcome for
its exact head. The earlier full-suite failure above remains visible rather
than being rewritten as an all-green initial run.

Reproduce the local boundary proofs with:

```sh
npm run check
npm test
node scripts/verify-grok-structured-patch-codec.mjs /absolute/path/to/codex
node scripts/verify-grok-service-tier.mjs /absolute/path/to/locked-venv/python
```

Live scripts require `--live --yes` and a separately authorized budget. Optional
AJV is version checked, not installed automatically. The acceptance command is
`node scripts/verify-grok-loop-followup.mjs --mode=final --acceptance --live --yes`.
An existing exhausted report cannot silently reset its budget.

Full-suite investigation also repaired test fixtures: Antigravity slow-body tests
now wait for observed body-read startup; overlay cancellation waits until its
process owner is ready; app-server tests distinguish authenticated startup
prewarm sockets from the one generation request; auto-review fixture imports its
path-dependent module after setting isolated state. These are fixture corrections,
not changes to those production providers or cancellation implementations.

Source digests are represented as `{path, sha256}` entries because GitGuardian
misidentified two OAuth-named digest-map entries as credentials. All prior digest
values and measurements were preserved and compared after normalization. No
security scan or detector was disabled.

## Codex review follow-up

The review of `151d3257` identified three issues addressed after the live
acceptance campaign:

- Root unions now receive the existing recursive malformed-literal normalization
  before preservation, flattening or operation lowering. A removed invalid
  discriminator cannot supply a false proof of exclusivity. Regression tests
  cover preserved/ref-based unions and eager, discovered and deferred tools,
  as well as the final strict provider boundary.
- Initial/resumed campaign snapshots and the separate final-validation snapshot
  now include `src/grok-tool-alternatives.mjs`. Historical snapshots were not
  backfilled: the original campaign preceded that module; the later six-task
  acceptance already recorded its digest through the follow-up harness.
- Resume excludes unfinished runs from quality results and reserves their
  unrecorded per-run allowance before new requests. Repeated resume cannot
  charge that allowance twice. Ambiguous legacy reserve attribution is refused
  before resumption rather than guessed.

These fixes use offline regression and local protocol checks; no additional
provider generations were used. The six-task live result remains evidence for
the source recorded in its original artifact, not a new live measurement of the
review fixes. The automation schema used by those tasks is unchanged by literal
normalization.

Review-fix verification: `npm run check` passed; full local suite **5,415 passed,
0 failed, 39 skipped** (5,454 total); targeted schema/provider tests **210/210**,
resume bookkeeping **10/10**, and local Router/LiteLLM protocol proof **24/24**.

## Manual-use follow-up: context accounting and stream failures

Manual use exposed a different boundary from tool selection: xAI's agentic
`prompt_tokens` is cumulative across server-side inference steps, including
repeated history ([provider contract](https://docs.x.ai/developers/tools/tool-usage-details)).
The client previously treated that billing count as the size of one context.
That can trigger repeated compaction after a search even when the request is
small. Historical Grok billing rows are no longer used to infer context capacity.

The forwarder now estimates the final provider-facing request, including expanded
operation schemas, hosted tools and repair instructions. Authenticated metadata
carries that estimate through LiteLLM. Only Grok client input usage is rewritten;
the original provider counters and aggregate cache counts remain in the meter.
Repair billing is also carried explicitly because LiteLLM drops nonstandard Chat
usage fields. The estimate is approximate, not a tokenizer measurement: images
use the existing bound and encrypted reasoning is not counted as plaintext.
It is not derived by dividing or capping the provider's cumulative bill.

The loopback JSON/SSE/WebSocket proof includes a 572,089-input-token billing
fixture whose translated request estimates 31,630 tokens. Each surface delivers
the estimate to the client while retaining the full bill. A two-generation repair
retains 1,144,178 billed input tokens and only the selected request's context
estimate. No additional real-provider generations were used for this follow-up.

A second reproduced failure followed a real mid-stream connection loss: a flat
Responses error was sent over the forwarder's Chat Completions endpoint. The
OpenAI SDK decoded it as a chunk without choices, and LiteLLM raised `IndexError`.
All streamed error exits now use the nested Chat error envelope, without a false
successful terminal or replay. A metadata-only terminal no longer emits an
empty-choice usage chunk. `scripts/verify-grok-chat-errors.py` feeds captured mock
forwarder output through the installed SDK/LiteLLM iterator; its old-envelope
negative control reproduces the exact failure. Pre-header connection resets and
connect timeouts remain transport errors; the existing bounded retry is unchanged.

### Model window and desktop reload

The bundled Codex app-server snapshots the static model catalog on startup.
An isolated offline test reproduced startup at 256,000, rewriting the file to
500,000, then creating a new thread: the effective window remained 243,200.
A fresh process with the 500,000 catalog reported 475,000 (the 95% effective
window). Creating a chat is therefore insufficient after this catalog change;
fully quit and reopen Codex before retesting. Router does not terminate the app.

The inspected official Grok model metadata advertises default 256,000 and available
windows [256,000, 500,000]. Router retains its existing 500,000 preset and 440,000
compaction threshold. The official CLI's window selection is local compaction
configuration; `x-grok-context-window` is response metadata, not a request switch
([source](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-sampler/src/client.rs#L211)).
This establishes catalog and client behavior, not a new live 500k capacity test.
Before this follow-up Router declared priority processing for Grok OAuth 4.6
only, so the observed Grok 4.7 session did not establish Fast processing.
All five direct xAI presets now advertise Fast as an opt-in tier: OAuth
4.5/4.6/4.7 and API 4.5/4.7. The selected `service_tier` survives the Responses
to Chat bridge. Telemetry distinguishes requested priority, provider-confirmed
priority, a standard-tier response, missing confirmation and an unknown tier.
No paid default is introduced and reseller routes do not inherit a different
provider's scheduling contract. This matches the documented
[xAI priority parameter](https://docs.x.ai/developers/advanced-api-usage/priority-processing);
the offline proofs do not establish actual availability or latency on an account.

Additional offline reproduction commands:

```sh
MODEL_ROUTER_TEST_LITELLM_PYTHON=/absolute/path/to/locked-venv/python \
  node --test --test-name-pattern='emits one terminal SSE error when the upstream stream fails mid-turn' test/grok-oauth-forwarder.test.mjs
node scripts/verify-codex-catalog-reload.mjs /absolute/path/to/bundled/codex
```

Follow-up verification: `npm run check` passed; the full local run passed
5,424 tests with 39 skipped and one changelog-format failure. Splitting the two
release notes into separate fragments fixed that sole failure; all 9 changelog
regressions then passed. Runtime sources were unchanged after the full run.
The expanded Router/LiteLLM/forwarder proof passed **51/51** scenarios across
OAuth and API JSON/SSE/WebSocket. The SDK/LiteLLM stream-error negative control
passed and is now wired into the three-platform protocol workflow. Catalog
reload was reproduced with both local CLI 0.159 and bundled
0.162.0-alpha.17.2. Remote CI remains separate evidence for the pushed revision.

### Client decoder regression follow-up

The first context-accounting patch removed `cached_tokens` but retained its
`input_tokens_details` object. Codex requires that member when the object is
present, so real turns failed with `failed to parse ResponseCompleted: missing
field cached_tokens`. The initial unit and protocol fixtures incorrectly
asserted absence; their green results did not establish client compatibility.

The estimated context omits the entire optional input-details object: the
current request cache breakdown is unknown, so neither a cumulative count nor
a fabricated zero belongs there. Raw cumulative cache billing is unchanged.
The existing offline app-server verifier now has `--usage-contract`: its negative
control reproduces the exact decoder error, then the production transform's
output must complete with 58,000 input tokens and no cache-details object.
Codex defaults its own absent cache count to zero; Router does not send that
number. The raw meter retains 500,000 cached tokens. Both responses use an isolated synthetic server,
with retries disabled and no provider quota.

```sh
node scripts/verify-codex-catalog-reload.mjs /absolute/path/to/bundled/codex --usage-contract
```
