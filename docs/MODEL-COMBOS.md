# Model combo policy

`src/model-combos.mjs` is a pure policy module. It validates a virtual combo,
selects a healthy target, and returns serializable state for the caller to
persist. It does not publish a model, read credentials, call a provider, or
change the router request path.

Targets use the canonical registry `slug` and its owning `provider`:

```json
{
  "id": "coding-fallback",
  "displayName": "Coding fallback",
  "strategy": "failover",
  "sticky": true,
  "stickyLimit": 20,
  "targets": [
    { "provider": "openrouter", "slug": "openrouter/qwen-max", "weight": 1 },
    { "provider": "local", "slug": "local/qwen", "weight": 1 }
  ]
}
```

Use `beginComboAttempt` to select a target without changing state. Call
`completeComboAttempt` only after the request attempt has ended. Successful
attempts commit bounded stickiness; retryable failures clear the session
affinity and, for round-robin, advance the weighted cursor past the failed
target. Every completion advances a per-combo revision, so a stale concurrent
attempt is rejected instead of overwriting persisted state.

Health is fail-closed: every candidate needs an explicit healthy snapshot (or
an `isHealthy` callback returning `true`). Missing health, missing model
metadata, unknown capabilities, and context-window mismatches make a target
ineligible.

Runtime catalog publication and request-path failover are intentionally not
part of this change. A future integration must connect this policy to the
router's real attempt boundary and preserve the same no-byte-replay safety
rules before advertising combo models.
