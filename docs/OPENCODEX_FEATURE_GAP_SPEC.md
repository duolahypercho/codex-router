# OpenCodex feature gap specification for Codex Router

Status: proposed design; not a record of shipped features

Implementation tracking: [OpenCodex parity roadmap](./OPENCODEX_IMPLEMENTATION_ROADMAP.md)

This document describes possible parity work after comparing OpenCodex with the
current Codex Router `main` branch. It is an implementation handoff, not a
claim that any item is already available. The current `README.md`, source, and
tests are authoritative for shipped behavior. An implementation must re-check
those sources and the upstream provider contract before changing code.

The comparison reference is the public [OpenCodex repository](https://github.com/lidge-jun/opencodex).
OpenCodex behavior is a comparison input, not a claim about Codex Router. Re-check
the referenced project and its current contracts before implementing a proposal.

## 1. Verified current baseline

The current router already provides a shared local service for Codex, with
optional publication to DeepSeek Harness, Gemini CLI, and Cursor. OpenCode is
not shipped as a client target. It preserves the native GPT catalog and login, and keeps the native
default model, reasoning metadata, and speed controls client-owned by default.
A routed default is available only through an explicit router-owned opt-in. It
routes the checked-in provider registry and explicitly curated local models
through the Responses path, with protocol-specific forwarding for supported
providers. It also has selected-provider model discovery, usage/cooldown
handling, model failover, capability-aware vision handling, provider-specific
hosted search where available, verified sub-agent metadata, a macOS tray, and a
Control Center.

The current credential boundary is protected owner-only files or documented
environment/session sources. The repository does **not** currently ship a
provider-neutral encrypted credential database, an API-key pool, or a
multi-account ChatGPT pool. The managed `multi_agent_v2` concurrency value is
6. These facts are constraints for every proposal below.

Useful source and test anchors:

- Targets: `src/paths.mjs`, `src/target-integration.mjs`,
  `test/target-integration.test.mjs`.
- Native catalog and config ownership: `src/native-catalog-source.mjs`,
  `src/catalog.mjs`, `src/config-manager.mjs`, `test/config-manager.test.mjs`.
- Provider routing and discovery: `src/router.mjs`, `src/api-forwarder.mjs`,
  `src/model-discovery.mjs`, `test/routing.test.mjs`,
  `test/model-discovery.test.mjs`.
- Credentials and redaction: `src/provider-credentials.mjs`,
  `src/file-security.mjs`, `test/provider-credentials.test.mjs`.
- Failover and usage: `src/model-failover.mjs`, `src/provider-cooldown.mjs`,
  `src/provider-usage.mjs`, `test/model-failover.test.mjs`.
- Vision and collaboration: `src/vision-bridge.mjs`,
  `src/subagent-proofs.mjs`, `src/multi-agent-state.mjs`, and their tests.

## 2. Comparison summary

OpenCodex is broader in several areas that are not first-class features in the
current router:

1. credential pools with account/key selection and session affinity;
2. generic provider definitions and broader endpoint pass-through;
3. named virtual model combinations;
4. a provider-agnostic web-search sidecar;
5. broader sub-agent policy and fallback controls;
6. a live management API/dashboard and versioned client exports.

These are proposed gaps. They must not be represented as completed modules or
enabled by default without a separately reviewed implementation.

## 3. Proposed gap A: credential and account pooling

### 3.1 Logical model

Add one provider-neutral abstraction for two credential kinds:

- `account`: an OAuth or first-party login identity;
- `api_key`: a provider API key or token.

Each row needs a stable opaque ID, provider, kind, display alias, health state,
pause state, priority, last-used/error timestamps, and provider-reported usage
when available. Email and provider account IDs are metadata, not routing keys.
Secrets remain in an approved protected store and are never returned by list or
status operations.

This is a future security requirement. It must not be documented as current
encryption until an implementation and tests actually provide encryption.

### 3.2 Selection policies

The proposed policies are:

- `quota`: choose the healthy credential with the most reliable remaining quota;
- `round-robin`: distribute new sessions across eligible credentials;
- `fill-first`: use the highest-priority credential until a configured threshold.

Unknown quota must remain unknown; the router must not invent a percentage.
Selection must be cached and non-blocking for ordinary requests. A session
binding may change only on an explicit switch, expiry, pause, provider refusal,
rate limit, or another documented policy event.

Streaming failures may retry only before response bytes are committed. Two
concurrent turns for one session must not create two bindings.

### 3.3 Lifecycle and safety

Future control operations may list sanitized health/quota, add/remove/pause/
resume a credential, set priority and strategy, refresh an OAuth session, clear
cooldown, and run a provider-supported non-billable test. Pooling must not be
presented as a way to bypass provider limits or terms. Remote callers must not
be able to submit arbitrary credential pools.

Acceptance evidence: isolated fixtures, expiry/401/403/429/5xx handling,
concurrent selection, restart/rollback, redaction, permission checks, and a
native GPT catalog regression.

## 4. Proposed gap B: generic OpenAI-compatible providers

### 4.1 User-facing provider object

The current registry and custom/per-model paths are the baseline. A future
provider object could contain:

```json
{
  "id": "local-vllm",
  "displayName": "Local vLLM",
  "enabled": true,
  "adapter": "openai-chat",
  "baseUrl": "http://127.0.0.1:8000/v1",
  "auth": {"mode": "api_key", "keyIds": ["key_opaque_id"]},
  "network": {"allowPrivate": true},
  "discovery": {"enabled": true, "path": "/models"},
  "models": {
    "qwen-local": {
      "upstreamId": "Qwen/Qwen3.8-27B",
      "inputModalities": ["text"],
      "supportsTools": true,
      "supportsVision": false
    }
  }
}
```

This schema is illustrative only. It must map to the existing state/config
system, preserve old custom model files, keep provider IDs separate from UI
labels, and require an explicit local/private-network opt-in.

### 4.2 Adapter and capability rules

Future adapters may cover Responses, Chat Completions, legacy Completions,
Anthropic Messages, Gemini-native, or other verified protocols. Every adapter
must declare input/output modalities, streaming, tools, reasoning, search,
structured output, and endpoint support before translating a request.

Unsupported fields must be omitted or mapped from the capability profile. Do
not infer support from a model name. Validate URL scheme, redirects, private
network access, DNS behavior, timeouts, and maximum body sizes.

### 4.3 Endpoint scope

The Codex route remains the priority. Optional future forwarding may cover:

| Endpoint family | Proposed priority | Boundary |
| --- | --- | --- |
| `/v1/models` | P0 | Discovery and health only; never erase user models. |
| `/v1/responses` and `/v1/chat/completions` | P0 | Main model-routing contracts. |
| `/v1/messages` | P0 | Only for providers with a verified Messages contract. |
| Embeddings | Shipped focused slice | Explicit per-model declaration, caller capability, bounded JSON, cancellation, and no retry. |
| Legacy completions, media, moderation, files, batches | P1/P2 | Advertise only when the provider and caller contract support them. |

Non-chat endpoints must not be advertised as chat models. Multipart limits,
idempotency, cancellation, request IDs, and non-idempotent retry boundaries are
required for any future endpoint.

Acceptance evidence: local OpenAI-compatible fixture, remote URL validation,
discovery cache behavior, capability filtering, restart persistence, old custom
model regression, and request/response/error contract tests.

## 5. Proposed gap C: provider parity

Provider additions are only justified when the official endpoint, auth, model
IDs, quota semantics, and capabilities are documented and tested. Prefer a
data-only registry entry over a provider-specific branch. Keep experimental or
unknown providers disabled until a fixture and a live, explicitly approved
probe pass.

The implementation order should be:

1. stabilize the generic provider object and capability profiles;
2. add direct OpenAI-compatible and regional presets with verified auth;
3. add non-OpenAI protocol adapters only where the wire contract is stable;
4. add plan-specific quota/account handling only when the provider exposes it.

Do not add a client integration or target that is not supported by the current
repository policy. A provider route and a client target are separate concepts.

## 6. Proposed gap D: virtual combos

A future named combo may resolve several provider/model targets:

```json
{
  "id": "fast-coding",
  "displayName": "Fast Coding",
  "strategy": "failover",
  "sticky": true,
  "targets": [
    {"provider": "provider-a", "model": "model-a", "weight": 1},
    {"provider": "provider-b", "model": "model-b", "weight": 1}
  ]
}
```

Resolve a combo before protocol translation, preserve a sticky binding only for
the documented unit, run normal capability gates, and never retry after stream
commit. Diagnostics must show the actual target without exposing credentials.

Acceptance evidence: failover, weighted selection, all-targets-unhealthy,
capability mismatch, sticky session, and native catalog tests.

## 7. Implemented gap E: web-search sidecar

The router preserves native standalone search and provider-specific hosted
search. It also offers a concrete Perplexity Search adapter only as an explicit
per-model opt-in for a model that does not already own either capability.

Requirements:

- bounded query/result schema with citations and source URLs;
- separate credential scope from generation credentials;
- timeout, cancellation, retry, and cache policy;
- no sidecar call for a route that already supports native search unless the
  user explicitly selects it;
- observable latency and failure reason;
- capability-driven selection, never a model-name special case.

Acceptance evidence: success, timeout, cancellation, cache hit, malformed
result, native-search bypass, redaction, and request accounting. The focused
evidence lives in `test/search-sidecar.test.mjs`,
`test/search-sidecar-control.test.mjs`, `test/routing.test.mjs`,
`test/generic-providers.test.mjs`, and `test/usage-events.test.mjs`.

## 8. Proposed gap F: sub-agent policy

Current sub-agent availability is registry- and proof-driven, with a managed
concurrency value of 6. Future work may add explicit opt-in unverified models,
per-agent chains, fallback, budgets, and actual-target diagnostics.

Defaults must remain conservative. A child model must pass tool, vision,
search, reasoning, and context checks before selection. Fallback is legal only
before stream commit. Any concurrency change must be explicit, tested, and
separate from provider parity.

## 9. Proposed control surfaces

The current macOS tray and Control Center remain the primary local UI. A future
control API may expose sanitized, authenticated operations for providers,
discovery, credentials, pools, combos, sidecars, usage, cooldowns, and
diagnostics. A browser dashboard or client export is proposed only if the
existing local surfaces cannot manage the accepted feature.

Every new setting must use existing rows, pickers, spacing, typography, colors,
accessibility labels, and Dynamic Island behavior. Native GPT labels, defaults,
speed controls, and existing settings must remain untouched.

## 10. Proposed architecture

Keep the existing gateway and registry. Add narrowly scoped layers only when a
feature is accepted:

```text
Control API / tray / CLI
        |
Provider/model state and protected credential references
        |
Pool policy, session affinity, cooldown
        |
Combo resolver and capability registry
        |
Protocol adapter and endpoint gates
        |
Existing router request/stream pipeline
```

The request order should be deterministic:

1. authenticate the local caller;
2. resolve native, user, or combo model;
3. load validated capabilities;
4. choose a credential or session binding;
5. validate tools, images, search, and reasoning;
6. translate only supported fields;
7. send with cancellation and trace propagation;
8. update health, usage, cooldown, and sanitized diagnostics.

## 11. Security and migration requirements

These are requirements for future implementations, not claims about current
storage:

- use the existing protected-file/OS credential boundary or a separately
  reviewed encrypted store; never create a second plaintext database;
- redact authorization, cookies, refresh tokens, API keys, signed URLs, and
  provider-specific secret headers from logs, errors, traces, and exports;
- keep control operations loopback-bound and authenticated by default;
- validate endpoint schemes, redirects, private-network access, and DNS
  behavior;
- scope caches, cooldowns, quota, and session state by provider/credential;
- preserve native Codex auth and metadata;
- make migrations idempotent, reversible, and safe under concurrent writers;
- fail closed on unknown capability or identity data.

## 12. Test plan for accepted features

Each implementation must add only the focused tests it needs, then run the
existing regression gates:

- unit/state: normalization, migration, redaction, permissions, locking;
- protocol: text, streaming, tools, reasoning, images, unsupported fields,
  cancellation, errors, and request IDs;
- routing: provider selection, capability gates, cooldown, failover, and
  stream commit boundaries;
- integration: restart, rollback, concurrent writes, target publication, and
  native GPT preservation;
- UI: Control Center build/renderer tests and Swift build/tests for tray work;
- live checks: only with explicit approval, and never with secrets in fixtures
  or output.

No feature is complete because a helper module compiles, a draft PR exists, or
an isolated unit test passes. The code must be merged to current `main` and its
end-to-end evidence must be recorded in the corresponding PR.

## 13. Open questions

Resolve these from current provider and client documentation before coding:

1. Which official account and OAuth flows permit multiple saved identities?
2. Which providers expose reliable quota windows and reset timestamps?
3. Which optional OpenAI endpoint families are needed by a supported caller?
4. Which protocol fields are lossless for tools, reasoning, images, and search?
5. Which state/control API contract should tray and CLI share?
6. Which maintained client integration is worth an export after the gateway is
   stable?

When a contract is unknown, leave it proposed and disabled. Do not guess an
endpoint, auth header, quota rule, or model capability.
