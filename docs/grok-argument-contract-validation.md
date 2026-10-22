# Grok argument contracts — 2026-10-21

## Incident boundary

The two October 21 failures at 07:39:29 and 07:40:04 UTC occurred on the installed
`e6e58674` composite, before this patch. Each xAI request completed in one attempt;
the Router then rejected a function-facade argument payload. The upstream streams
finished in 8.123 and 6.860 seconds, while the Router failed after 10.467 and
6.973 seconds. This is a local argument-restoration failure, not proof of a
provider disconnect. Original argument values and the selected facade identity
were not retained, so the triggering malformed field cannot be reconstructed.

The October 19 custom-patch incidents similarly retained only
`ambiguous_or_invalid_json` / `missing_field`. These categories alone do not prove
that the history mismatch caused those particular requests.

## Changes and acceptance boundaries

- Native patch history contains `{input: rawPatch}`, whereas current structured
  calls require `{operations: [...]}`. These now have distinct provider identities:
  `apply_patch_history_v1` and `apply_patch_structured_v1`, with collision-safe
  aliases where needed. Historical bytes, call IDs, and results are preserved.
  The history identity is never advertised as callable, and invocation fails
  closed in JSON/SSE. Current forced choices and negotiated hook history retain
  their executable contract. Original client permission instructions remain in
  a verbatim quoted reference; they are not discarded.
- Read/search/directory schemas previously allowed characters that their shell
  argument compilers rejected. Their schemas and validators now share explicit
  character/size/numeric limits. No null coercion, missing-field guessing, JSON
  repair, or retry of committed actions is introduced. Terminal commands still
  permit line breaks; file/path/regex restrictions apply only to the relevant
  read facade.
- Function-facade failures now report a fixed tool identity and a fixed category,
  such as `read_file:out_of_range`. Argument contents and provider-supplied field
  names are never incorporated into that diagnostic. Earlier ambiguity checks
  still reject duplicate JSON keys before this compiler runs.
- The macOS nested process fixture published its PID file before the write and
  signal-handler installation were complete. Atomic rename after handler setup
  closes that readiness race. A delayed-write control makes the original fixture
  fail at the PID assertion and the fixed fixture pass without lengthening the
  cleanup budget.

## Previous live experiment and limits

The explicitly approved October 19 experiment consumed all eight allowed Grok
requests, through an isolated real forwarder with synthetic patch tasks. Both
baseline and candidate produced four valid patches out of four, with one upstream
attempt each. The incident was not reproduced. The sample does not demonstrate a
lower real-world failure rate or a general latency improvement. Temporary raw
probe artifacts were subsequently lost with the temporary checkout; these are
historical observations, not fresh reproducible acceptance evidence for this
revision. No additional live generations are authorized by that consumed budget.

Fresh deterministic checks, remote CI, review, and local installation must be
reported independently. Successful synthetic contract checks do not prove that
all organic Grok argument failures have disappeared.

## Follow-up CI compatibility check

The October 21 CI run for `545801ba` passed the macOS and Windows test jobs,
the native macOS application smoke, and all three Grok protocol jobs. Its Ubuntu
job switched from Node 24.21.0 to 24.22.0 and failed in skill publication:
`fs.cpSync` with `errorOnExist` now rejects the already-claimed destination root.
The same old-source failure was reproduced locally with the official Node
24.22.0 binary, verified against its published SHA-256. This installer failure
is separate from Grok argument handling. The compatibility fix retains exclusive
root ownership and copies children without overwriting existing entries; conflict
recovery must preserve concurrent files, including identical-content collisions
and interrupted refreshes.


## October 22 incident and bounded diagnostic follow-up

The installed `9f5a6fd4` composite still rejected an organic patch at
07:44:06 UTC with `ambiguous_or_invalid_json`. The upstream completed in one
attempt after 50.773 seconds; the local relay refused the arguments after
51.003 seconds. A later turn reported `embedded_line_separator`. Original
argument values were not retained, so neither failure can be attributed to a
specific malformed field or to transport corruption from those logs alone.

A new approved experiment used four of at most eight generations, with a
15-minute campaign limit. It ran from 08:02:04 through 08:09:43 UTC against the
real isolated Grok OAuth forwarder, using synthetic multi-file patch tasks at
`xhigh` effort. Three requests produced valid patches in 32.3, 76.8, and 110.1
seconds. Their argument sizes were 4,681, 13,753, and 33,922 bytes; upstream
terminal arguments and assembled Chat arguments were byte-identical, and all
three used an operations array. The fourth request hit the probe's 240-second
limit before any function arguments were emitted. It is a timeout, not a
successful patch or a reproduction of the JSON failure. No further live calls
were made. This is not an A/B measurement or evidence of a lower failure rate.

The live path did not include Router/LiteLLM. Offline replay of the three
captured responses through Router, the locked LiteLLM, and the forwarder
produced the exact expected native patch without retries. Applying the three
patches to synthetic files also produced the expected bytes. This validates
those captured responses, not the missing organic failure payloads.

The follow-up source change improves diagnostics only. Empty, syntactically
invalid, and ambiguous JSON now have distinct fixed categories at the outer
arguments and encoded-operations boundaries. Separator failures distinguish
paths, anchors, and file lines. No input values, parser excerpts, or paths enter
those messages. Validation still refuses invalid edits and does not retry
committed output. Schema, context size, provider prompts, and accepted patch
bytes are unchanged. The original incident remains unreproduced and unresolved.

Local verification: 611 relevant Grok/namespace tests passed with one skip;
`npm run check` passed. Two new diagnostic regression tests fail on the prior
source. Independent comparison of 426 inputs found no acceptance or output
changes. Remote CI and installation are separate receipts and must be tied to
the final commit.
