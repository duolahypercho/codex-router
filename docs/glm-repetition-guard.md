# Optional GLM-5.3 repetition protection

Add `"repetitionGuard": true` to a curated GLM-5.3 entry in the router's local
`user-models.json`, then restart the router to reload that model metadata.
For a checked-in model, use a registry override (`MODEL_ROUTER_REGISTRY`) with
the flag on that model; a duplicate user entry does not override checked-in
metadata. No shipped model enables the guard.
Omitting the field or setting it to `false` keeps the normal stream behavior.
The field must be a boolean. It is not forwarded to the provider and does not
change reasoning effort, token budgets, input history or the saved transcript.

The guard observes streaming assistant output from GLM-5.3 and its variants.
It looks for an exact prose unit of 12–512 characters repeating continuously
through a 4,096-character window. Each text part has an independent bounded
8,192-character tail. Text beginning with a JSON bracket/quote and text containing
a code fence are excluded. Tool arguments, reasoning and refusal parts are not
inspected. Low character diversity alone is not a failure; distinct numbered
records remain valid. Non-streaming responses and other model families are unchanged.

A match stops upstream reading and reports `router_repetitive_generation`.
The router does not retry or fail over after that deliberate stop. Already
delivered text remains partial output; it is never reported as completion.
Review it and continue with a fresh instruction when appropriate.

Before content has been relayed, the stop is HTTP 400. After a stream starts,
it ends cleanly with a `response.failed` event. Its nested error code is
`invalid_prompt`, the terminal classification used by Codex 0.159.2; the event's
router-specific code and message identify the actual repetition stop. Ordinary
transport failures keep their existing retryable classification. If upstream
identity is unavailable, the local failure omits it rather than inventing an ID
or timestamp; this minimal envelope is a Codex compatibility behavior.

This is a conservative heuristic, not a proof that a task made no progress.
It can stop intentionally repeated prose when explicitly enabled, and will
miss shorter loops, varied wording, oversized SSE frames, unterminated frames,
loops inside structured output and prose after a code fence. Turn it off for
work requiring repetitive prose. There are at most 32 retained text-part
detectors; inspecting more interleaved parts evicts the oldest detector.
