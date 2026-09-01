# OpenCodex parity roadmap

Status: verified baseline and proposed work

Parent specification: [OpenCodex feature gap specification](./OPENCODEX_FEATURE_GAP_SPEC.md)

Baseline: the current `main` branch at the time this document is reviewed.

This document is a planning aid, not a runtime capability catalogue. The
repository's `README.md`, source, and tests are authoritative. A feature is
listed as shipped only when the current `main` branch contains the code and a
focused test or documented operational check. Everything else is marked
proposed. Historical branch or pull-request names are intentionally not used as
proof of current behavior.

## Current shipped behavior

The following statements describe the behavior that is present and testable on
current `main`:

| Area | Shipped behavior | Evidence |
| --- | --- | --- |
| Client integrations | One shared router plane can publish routed models for Codex, DeepSeek Harness, Gemini CLI, Cursor, Claude Code, and OpenClaw. OpenCode is not a shipped client target. | `src/paths.mjs`, `src/target-integration.mjs`, `src/cursor-surface.mjs`, `src/openclaw-config-manager.mjs`, `README.md` |
| Native Codex path | Native GPT catalog and login remain client-owned. The native default model, reasoning metadata, and speed controls remain client-owned by default; a routed default requires an explicit opt-in. | `src/native-catalog-source.mjs`, `src/catalog.mjs`, `src/config-manager.mjs`, `test/native-catalog-source.test.mjs`, `test/config-manager.test.mjs`, `README.md` |
| Routed inference | Codex requests use the local Responses route. Supported providers are translated through Responses, Chat Completions, or Anthropic Messages adapters where their registry entry declares that protocol. | `src/router.mjs`, `src/api-forwarder.mjs`, `test/routing.test.mjs`, `test/anthropic-api-integration.test.mjs` |
| Provider registry | Providers and model metadata are checked in under `config/`; local model files and explicit curation extend the catalog without adding request-path branches. | `src/model-registry.mjs`, `src/user-models.mjs`, `src/curate-models.mjs`, `README.md` |
| Model discovery | Selected API providers can be queried through their `/models` endpoint. Results are cached and merged with the checked-in registry; discovery does not replace user model state. | `src/model-discovery.mjs`, `src/model-catalog-cache.mjs`, `test/model-discovery.test.mjs`, `test/provider-catalog-cache.test.mjs` |
| Credentials | Provider API keys are read from protected owner-only files or documented environment sources; OAuth providers use their documented local sessions. Status and diagnostics redact values. This is file protection, not an encrypted credential database. | `src/provider-credentials.mjs`, `src/file-security.mjs`, `test/provider-credentials.test.mjs`, `README.md` |
| Provider resilience | Model failover, provider cooldowns, usage accounting, and bounded retries are implemented for the supported routed paths. | `src/model-failover.mjs`, `src/provider-cooldown.mjs`, `src/provider-usage.mjs`, `test/model-failover.test.mjs`, `test/model-failover-router.test.mjs` |
| Tools and images | Capability metadata gates tool/vision handling. The vision bridge can use a configured cloud or local engine; it does not make an unsupported model support images. | `src/vision-bridge.mjs`, `src/vision-bridge-state.mjs`, `test/vision-bridge.test.mjs`, `test/vision-bridge-e2e.test.mjs`, `README.md` |
| Web search | Native Codex standalone search and provider-specific hosted search are preserved. Models without either capability can explicitly bind the separately credentialed, bounded Perplexity Search sidecar. | `src/search-sidecar.mjs`, `src/search-sidecar-state.mjs`, `src/router.mjs`, `test/search-sidecar.test.mjs`, `test/routing.test.mjs` |
| Embeddings | The caller-capability endpoint forwards only models that explicitly declare `/embeddings`; request/response limits, cancellation, credential isolation, and the no-retry boundary are enforced end to end. | `src/openai-endpoint-policy.mjs`, `src/router.mjs`, `src/api-forwarder.mjs`, `test/openai-endpoint-policy.test.mjs`, `test/routing.test.mjs` |
| Sub-agents | The router publishes the registry's verified v1/v2 collaboration metadata and manages the structured `multi_agent_v2` setting. The managed concurrency value is **6**; user-owned settings remain authoritative. | `src/multi-agent-state.mjs`, `src/subagent-proofs.mjs`, `src/config-manager.mjs`, `test/config-manager.test.mjs`, `test/subagent-*.test.mjs` |
| Local models | Ollama, LM Studio, MLX, and other explicitly configured local paths are opt-in and remain loopback-bound. | `src/local-models.mjs`, `src/lmstudio-models.mjs`, `src/local-mlx.mjs`, `test/lmstudio-provider.test.mjs`, `test/local-models.test.mjs`, `README.md` |
| Control surfaces | The macOS tray and Control Center expose the shipped provider, model, usage, health, local-model, and target controls using the existing visual language. | `apps/macos/ModelRouterTray`, `apps/control-center`, `test/control-center-electron.test.mjs`, Swift package tests |

The router currently has one active credential per configured API-provider
entry. It does not provide a provider-neutral API-key pool or a multi-account
ChatGPT pool on `main`. It also does not provide virtual combo models, a browser
dashboard, or general client configuration exports. These are proposed items
below, not completed modules.

The router-managed sub-agent setting intentionally remains at six concurrent
threads. A request to raise that value is a separate configuration change and
must not be represented as an already-shipped parity feature.

## Proposed work

The following items are future design work. They have no shipped status until
their code, focused tests, and supported client behavior land on `main`.

| ID | Proposed scope | Exit evidence |
| --- | --- | --- |
| P01 | Provider-neutral credential primitives and migration, using the existing protected-file boundary. | Schema and migration tests, redaction tests, rollback, permissions, and a doctor run with existing credentials. |
| P02 | Provider-scoped API-key pools with explicit selection, health, cooldown, and rotation policy. | Two-key fixture, 401/403/429/5xx handling, streaming commit boundary, concurrent selection, and no secret leakage. |
| P03 | Native ChatGPT account switching or pooling, only after the native profile and catalog ownership rules are settled. | Isolated profiles, identity binding, closed-app switching, rollback, restart persistence, usage identity, and native catalog regression tests. |
| P04 | Generic OpenAI-compatible provider definitions above the current checked-in/custom model paths. | Provider CRUD, base URL and header validation, private-network policy, discovery, restart persistence, and legacy custom-model regression. |
| P05 | Additional OpenAI-compatible endpoints beyond the shipped embeddings slice, such as legacy completions, media, moderation, files, and long-running jobs. | Per-endpoint capability gates, limits, cancellation, idempotency, and non-idempotent retry tests. |
| P06 | Named virtual models and explicit weighted/failover combinations. | Weight and failover behavior, capability checks, sticky-session semantics, stream commit boundary, and catalog regression tests. |
| P07 | Additional trusted search-provider adapters beyond the shipped Perplexity Search protocol, without weakening its per-model opt-in or transport boundary. | One reviewed protocol per adapter, exact destination policy, the existing bounded/cancellation/cache/redaction suite, and router-path tests. |
| P08 | Broader sub-agent policy controls, only for models with explicit capability evidence. | Default-safe behavior, opt-in validation, tool/vision/search mismatch tests, actual-target diagnostics, and concurrency budget tests. |
| P09 | Tray and Control Center controls for any new policy that is accepted. | Existing UI style, accessibility labels, restart persistence, release build, and native GPT/Dynamic Island regression checks. |
| P10 | Authenticated local management endpoints for the accepted provider/model policies. | Loopback authorization, redaction, concurrent writes, idempotence, and CLI/tray parity. |
| P11 | Versioned configuration exports for a maintained client integration. | Target-file preservation, secret-reference checks, import/export round trip, and a live non-paid smoke test. |
| P12 | A bounded end-to-end parity and migration suite. | `npm run check`, targeted Node tests, Swift build/tests where relevant, restart/rollback, one streamed tool call, one image case, one search case, and native GPT preservation. |

The IDs are planning labels only. They are not pull-request numbers and must
not be marked complete from a branch or draft PR. A proposal moves to shipped
only after it is merged to `main` and its evidence is reproducible there.

## Invariants for future changes

Every implementation must:

1. Preserve native GPT catalog ownership, native defaults, labels, reasoning
   metadata, and `normal`/`fast` speed controls.
2. Preserve existing provider credentials, local model configuration, target
   settings, and tray preferences. Migrations must be reversible and
   idempotent.
3. Use data-driven provider/model capabilities. Do not add model-name branches
   to the request path.
4. Keep secrets out of source, fixtures, logs, PR text, screenshots, exports,
   and diagnostics. Protected files must remain owner-only; do not claim
   encryption unless the implementation and tests actually provide it.
5. Fail closed on ambiguous process identity, endpoint validation, capability
   metadata, or credential state.
6. Keep the shared router plane single-instance. A new client integration must
   not create a second service or credential store.
7. Keep the current tray and Control Center visual language. Do not change the
   Dynamic Island silhouette or native GPT controls as a side effect.

## Verification and status rules

Before a future item is described as shipped:

- rebase the implementation onto the current `main`;
- verify the scope is not already implemented or removed by current policy;
- run the narrowest focused tests, then `npm run check`;
- run Control Center and Swift build/tests when those surfaces change;
- perform a live app/tray check for UI-affecting work;
- inspect the final diff for unrelated files or generated artifacts;
- record the exact evidence in the implementation PR and update this document
  only after the code is merged.

PR descriptions should use short Simplified Technical English and include:

```text
## What changed

<One or two short sentences.>

## Reason

<What user-visible or reliability problem this solves.>

## Validation

- <focused test>
- <regression/build check>
```

No item in this roadmap is complete merely because a draft PR exists, a helper
module compiles in isolation, or a local branch has unmerged changes.
