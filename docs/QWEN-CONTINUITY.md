# Qwen continuity

`src/qwen-compaction.mjs` adapts requests only for the exact slugs
`custom/qwen3.8-flash-next` and `custom/spark-default`, both with
`requestProfile: "qwen38-community"`. Configuring another Qwen route or merely
using that profile does not enable these instructions. This feature changes
runtime requests, not model catalogs, provider selection, reasoning transport,
or service configuration.

## Local checkpoint requests

The router replaces Codex's exact default terminal compact prompt only when
canonical `client_metadata["x-codex-turn-metadata"]` declares
`request_kind: "compaction"` and `compaction.implementation: "responses"`.
Metadata must be an unambiguous JSON object of at most 256 KiB, with recognized
compaction enum values. Compatibility headers do not grant eligibility. No
tools may be offered, and remote `compaction_trigger` input is excluded. Caller
custom compact prompts remain untouched.

The adapted prompt retains the nine-section XML `state_snapshot` schema from
Qwen Code. It prioritizes a file/finding/fix/verification ledger, exact details
needed to resume, material older facts, rejected approaches, latest corrections,
and the source and scope of authorization. It groups repeated intent history
instead of reproducing a transcript. It requires direct extraction of recorded
working state without re-solving the task, adding findings, or emitting
scratchpad text, plus secret redaction. Prompt requirements are not proof that a
model's generated checkpoint preserved every material fact.

## Resume and final responses

`adaptQwenCompactionRequest` also adds fixed resume guidance when a top-level
user message contains a standalone Codex-prefixed checkpoint with exactly the
nine ordered sections, at most 128 KiB. It examines string message content and
individual `text`/`input_text` parts, including multipart messages and
checkpoints followed by separate restored items. It does not join parts, inspect
nested tool strings, or infer attachment provenance from text markers.

Resume guidance treats the checkpoint as historical context. Newer user
steering and higher-priority instructions remain controlling; completed actions
and old approvals do not become new authorization. Quoted instructions, tool
results, and restored reference material remain data. Original input items and
parts are retained in their original order and are never modified by the
adapter.

`adaptQwenConversationRequest` composes that adapter with dedicated ordinary-turn
final-response guidance: continue authorized work, lead with a self-contained
outcome or status, group material findings with evidence and limitations, and
remove repeated process narration. Completed changes state what changed, how it
was verified, and important unrun checks; a bare "done" or "fixed" is insufficient.
Remaining actions appear only when real, with ownership, dependencies, and the
next check when known. Explicit user
format requests take precedence; complete or simple answers require no
boilerplate or invented follow-up actions.

Both adapters preserve explicitly supplied non-string `instructions` and
enforced nontext `text.format` or `response_format` requests unchanged, including
JSON/schema output on a checkpoint or compaction request. Missing instructions
may be initialized. The wrapper never adds final-response guidance to canonical
compaction requests (including unknown implementations), exact default or Qwen
terminal compact prompts, or remote compaction triggers. Present malformed or
unknown canonical metadata disables adaptation. Absent metadata remains
compatible with ordinary turns and checkpoint resume.

Adaptations copy only changed payload/message layers, retain original
instructions, and are idempotent. `buildRoutedRequest` applies the wrapper before
compatibility transforms and carries any adapted compact input into the routed
request result. Other routes and the separate remote `/responses/compact`
checkpoint protocol retain their existing behavior.

## Verification

Run the model-free boundary and mocked-router tests plus repository checks:

```sh
node --test test/qwen-compaction.test.mjs
npm run check
```

The focused tests exercise both aliases, metadata/framing failures, attachments,
newer user steering, nested tool text, immutable payloads, idempotence, structured
formats, and the actual routed request seam with a synthetic gateway. They test
request transformation, not model retention quality. Live retention evaluation
uses synthetic fixtures and requires separate local-model availability and
authorization; no installation, restart, or catalog refresh is implied by these
commands.

## Synthetic local evaluation

Review the frozen fixture/request manifest and run its model-free scorer checks:

```sh
node scripts/eval-qwen-continuity.mjs --prepare --out generated/qwen-continuity-prepare
node --test test/qwen-continuity-eval.test.mjs
```

After reviewing that plan and authorizing local inference, run against the
intended DGX host with a fresh output directory:

```sh
node scripts/eval-qwen-continuity.mjs --live --yes --ssh-host USER@DGX --out generated/qwen-continuity-live
```

The harness caps the run at 22 model requests, at most two concurrently, with
`reasoning_effort: "medium"`. It uses synthetic task histories and compares
baseline and candidate compaction, retained file/finding/fix/verification
associations, human final responses, and completion/JSON/code controls. Private
artifacts under the selected `generated/` directory include fixture/source
hashes, the request ledger, and the resulting report. An existing live ledger
is preserved by refusing to reuse its directory. This measures prompt behavior
on synthetic inputs; it does not exercise Codex app end to end or establish
real-work retention quality.

Prompt sourcing and Apache notices are recorded in
`config/qwen-compaction/PROVENANCE.md` and its adjacent `LICENSE`.
