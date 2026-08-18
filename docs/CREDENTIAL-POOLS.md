# Credential Pools — multi-account / multi-key pools

Codex Router now supports **multiple credentials (API keys) for the same provider** and automatically rotates among them when one is rate-limited or quota-exhausted — similar to [Hermes Agent — Credential Pools](https://hermes-agent.nousresearch.com/docs/user-guide/features/credential-pools).

Inspired by Hermes, implemented router-native: no Hermes code is copied, the design follows the same four rotation strategies.

## Why

A single API key dies on `429` / `402` / “usage limit reached” mid-session. Pools keep the session alive by trying the next healthy key for the *same* provider before falling back to a *different* provider (`model-failover`). The native ChatGPT/Codex account is never pooled.

## Quick start

```sh
# Add a second key for the same provider (deepseek, openrouter, grok-api, etc.)
./bin/credential-pool add deepseek --label backup --api-key sk-...
# or hidden prompt:
./bin/credential-pool add openrouter

# Inspect
./bin/credential-pool list
./bin/credential-pool list deepseek

# Choose strategy (default: fill_first)
./bin/credential-pool strategy deepseek round_robin
./bin/credential-pool strategy deepseek least_used
./bin/credential-pool strategy deepseek random
./bin/credential-pool strategy deepseek fill_first

# Manual reset after a quota refills / limit raised
./bin/credential-pool reset deepseek
./bin/credential-pool reset --all

# Remove one key (by 1-based index or id)
./bin/credential-pool remove deepseek 2
./bin/credential-pool remove deepseek a1b2c3d4
```

`bin/provider-key <provider> set` (single-key path) continues to work. The first `credential-pool add` auto-seeds the existing `STATE_DIR/<provider>*.secret` as `primary`, so enabling pools never discards a working key.

## Rotation strategies

Set per-provider via CLI or by editing `STATE_DIR/credential-pools.json` (`strategy` field).

| Strategy | Behaviour |
|---|---|
| `fill_first` *(default)* | Use the first healthy key until exhausted, then move to the next. |
| `round_robin` | Cycle evenly through healthy keys. |
| `least_used` | Always pick the key with the lowest `requestCount`. |
| `random` | Random among healthy keys. |

`--json` on every command emits machine-readable output.

## Automatic rotation

`src/api-forwarder.mjs` selects a healthy key per strategy (cooldown-aware) and, after each upstream response, marks the used key:

| Upstream | Action | Cooldown |
|---|---|---|
| `429` (generic/burst) | Retry same key **once** (transient); second `429` → rotate | 1h (honours `Retry-After` capped 6h) |
| `402` or `out_of_usage` (`insufficient_quota`, `usage limit reached`, balance/arrears — including Chinese `余额不足/欠费/额度`) | **Immediately rotate** (no retry — cap won't clear) | 1h |
| `401/403` | Rotate | 5m |
| `entitlement` (“plan doesn't include API”, Go vs Provider) | **No rotate** (no key on same provider fixes it) | — |
| `200` | Clear `hasRetried429` + cooldown, increment `requestCount` | — |
| **All keys exhausted** | Surfaces `503`/`429` — router's cross-provider `model-failover` then activates |

Healthy = `cooldownUntil` absent or expired. Cooldown is per-key, not per-provider. Request counts and `lastUsedAt` are persisted for `least_used`/`round_robin`.

## Management commands

```
credential-pool list [provider]              - list pools or one provider
credential-pool add <provider> [--label L] [--api-key K]
credential-pool remove <provider> <index|id>
credential-pool strategy <provider> [strategy]
credential-pool reset <provider|--all>
```

Aliases: `status` = `list`, both argument orders accepted (`list <provider>` / `<provider> list`).

## Storage & safety

* `STATE_DIR/credential-pools.json` — versioned pool metadata only (no secrets), `0600` + `protectPrivateFile` (`icacls` on Windows).
* Each pool member → `STATE_DIR/<credential.file>.pool.<id>.secret` (`0600`), fingerprinted `sha256:16`. Env-var / Keychain members are read-only and never persisted inline.
* Duplicate keys rejected by fingerprint.
* Removing a pool member deletes its pool file only under `STATE_DIR`; the primary `<provider>.secret` is deleted only when explicitly removed.
* Empty pool entry is pruned (no empty strategy shell).
* No breaking change: no pool file = original single-key behaviour; `provider-selection` reports pooled providers as configured when the pool has any entry, otherwise classic file check.

## Compatibility

* Poolable: `openai-compatible` providers with `credential.file` (e.g. `deepseek`, `openrouter`, `grok-api`, `commandcode`, `xiaomi-mimo`, `zai`, `siliconflow`, etc.). `variantOf` families share one pool via canonical id.
* Not poolable: `keyless` (local Ollama), `anonymous` (`opencode-free`, `kilo-free`), `per-model` (`custom`) — rejected with an explanation.
* OAuth (`kimi-oauth`, `grok-oauth`) pooling is scaffolded but not yet routed; API-key pools are the primary use-case (rate/plan limits). Native ChatGPT (`openai` native path) is never pooled.
* Credential isolation (`api-forwarder` injects only the selected pool key as `Authorization`/`x-api-key`) and existing `file-security`, `provider-selection`, `health-cache`, `model-failover` and `grok/kimi-oauth` flows are preserved.

## Architecture

```
request → hasCredentialPool(id) ? selectCredential(id)   // strategy + cooldown
        : resolveProviderCredential(endpoint)               // classic
        → upstream fetch → markCredentialSuccess / markCredentialFailure
        → next request picks next healthy key; if none, failover to other provider
```

Key modules: `src/credential-pool.mjs` (manager), `src/credential-pool-cli.mjs` (CLI), `src/provider-selection.mjs` (picker integration), `src/api-forwarder.mjs` (selection + marking).

## Limitations & next steps

* In-request immediate retry (same turn) currently marks for *next* turn; bounded in-request pool loop (retry same turn with next key) is the planned follow-up — today the next turn rotates, which already rescues sessions.
* No non-interactive `auth add --type oauth` pooling yet; single OAuth session path still managed by `kimi login` / `grok login`.
* Per-credential `Retry-After` / `reset_at` could promote to per-key `retryAt` header exposure in `doctor`.
* Future: `provider-key` could delegate to `credential-pool add` with a `--pool` flag.

## Reference

Design inspiration: [Hermes Agent Credential Pools](https://hermes-agent.nousresearch.com/docs/user-guide/features/credential-pools). Hermes is `agent/credential_pool.py` + `hermes_cli/auth_commands.py`; this implementation is router-native and follows the spirit, not the code.
