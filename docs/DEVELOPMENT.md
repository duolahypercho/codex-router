# Development guide

## Architecture

- `config/` is the split provider and model registry tree.
- `src/model-registry.mjs` validates and indexes that registry.
- `src/catalog.mjs` merges listed registry models with native Codex models.
- `src/litellm-config.mjs` generates every provider translation route.
- `src/router.mjs` dispatches native and namespaced external model IDs.
- `src/oauth-forwarder.mjs` owns Kimi CLI OAuth loading and refresh.
- `src/grok-oauth-forwarder.mjs` adapts Grok CLI OAuth to OpenAI-compatible chat.
- `src/api-forwarder.mjs` is shared by all API-key providers.
- `src/provider-credentials.mjs` isolates environment, file, and Keychain lookup.
- `src/rate-limit-headers.mjs` parses provider rate-limit headers into snapshots.
- `src/rate-limit-state.mjs` stores the latest observed window per provider.
- `src/provider-selection.mjs` controls which tested models enter the picker.
- `src/start.mjs` supervises the loopback processes.
- `src/service-*.mjs` install per-user services for macOS, Linux, and Windows.
- `src/paths.mjs` defines state roots, ports, and service names.

## Add an API-key provider

1. Add a provider fragment under `config/<vendor>/` with a unique lowercase ID,
   API base URL, protocol when it is not OpenAI-compatible, environment variable, protected key filename, and optional
   Keychain service.
2. Add one model object per upstream model. Public slugs should be namespaced as
   `provider/model`, and internal `gatewayModel` values must be unique.
3. Supply picker metadata for listed models: label, description, reasoning
   levels, context window, compaction limit, modalities, and compatibility hash.
4. Use an existing request profile or add a narrowly scoped profile to
   `src/api-forwarder.mjs` when the upstream needs parameter normalization.
5. Add routing, credential-isolation, and request-normalization tests.
6. Run `bin/discover-models PROVIDER` against the official model endpoint.
7. Install in isolated state and run
   `bin/test-model provider/model --live --yes`; verify text, streaming, tool
   calls, and compaction before setting `listed: true`.
8. Update the README model table and provider-specific setup documentation.

The shared API forwarder strips host and internal authentication before
injecting the selected provider key. It supports the registry's tested
OpenAI-compatible and Anthropic protocols; do not create a new listener merely
to add another provider using one of those protocols.

OAuth schemes usually need a dedicated adapter because refresh and identity
rules are provider-specific. Never infer that an API key can replace an OAuth
credential or vice versa.

GitHub Copilot is the existing dynamic-auth exception inside the shared API
forwarder. Its registry provider declares `authProfile: "github-copilot"`;
`src/github-copilot-session.mjs` validates the stored fine-grained PAT against
the account endpoint, caches the validated account routing briefly, allowlists
the returned inference host, and builds provider identity headers. Do not reuse
that profile for another vendor.

### GitHub Copilot reference implementations

This support is based on two established first-class Copilot providers, pinned
to the revisions reviewed during implementation:

- [OpenClaw provider](https://github.com/openclaw/openclaw/tree/5d98d2e6ecd7a53b41e2643dc7689c12118e0e1c/extensions/github-copilot):
  [`runtime-auth.ts`](https://github.com/openclaw/openclaw/blob/5d98d2e6ecd7a53b41e2643dc7689c12118e0e1c/extensions/github-copilot/runtime-auth.ts)
  validates the original GitHub token through `/copilot_internal/user`, takes
  `endpoints.api` from that response, and restricts it to GitHub Copilot hosts;
  [`models.ts`](https://github.com/openclaw/openclaw/blob/5d98d2e6ecd7a53b41e2643dc7689c12118e0e1c/extensions/github-copilot/models.ts)
  filters the live catalog using object/type, picker policy, tool, streaming,
  endpoint, and account availability metadata;
  [`runtime-identity.ts`](https://github.com/openclaw/openclaw/blob/5d98d2e6ecd7a53b41e2643dc7689c12118e0e1c/extensions/github-copilot/runtime-identity.ts)
  supplies the Copilot integration identity; and
  [`usage.ts`](https://github.com/openclaw/openclaw/blob/5d98d2e6ecd7a53b41e2643dc7689c12118e0e1c/extensions/github-copilot/usage.ts)
  maps `/copilot_internal/user` quota snapshots.
- [Hermes Agent provider](https://github.com/NousResearch/hermes-agent/tree/a4970d07d58af41968b7371776481b56411bc3d6/plugins/model-providers/copilot):
  [`copilot_auth.py`](https://github.com/NousResearch/hermes-agent/blob/a4970d07d58af41968b7371776481b56411bc3d6/hermes_cli/copilot_auth.py)
  documents accepted `gho_`, `github_pat_`, and `ghu_` tokens, rejects classic
  `ghp_` PATs, and builds Copilot intent/initiator/vision headers;
  [`models.py`](https://github.com/NousResearch/hermes-agent/blob/a4970d07d58af41968b7371776481b56411bc3d6/hermes_cli/models.py)
  consumes `model_picker_enabled`, `supported_endpoints`, and capability data;
  and the
  [provider profile](https://github.com/NousResearch/hermes-agent/blob/a4970d07d58af41968b7371776481b56411bc3d6/plugins/model-providers/copilot/__init__.py)
  registers Copilot and its credential environment variables as a normal
  provider rather than an experimental one.

The implementations are references, not copied dependencies. OpenClaw's current
direct-token account-validation path is the closest match to this router.
Hermes additionally retains a compatibility token-exchange path and supports
Chat Completions and Anthropic Messages models. Codex Router deliberately ships
only account-advertised Responses models because its gateway and curation
contract require one verified wire protocol per provider entry.

## Registry rules

The registry is intentionally declarative. `src/model-registry.mjs` rejects
unknown provider kinds, duplicate provider IDs, duplicate public slugs,
duplicate gateway model IDs, missing credential metadata, and incomplete picker
metadata.

Set `listed: false` for compatibility aliases that must remain routable but
should not appear in the app picker. Every model, listed or hidden, receives a
generated LiteLLM route.

An alternate registry can be tested in a development process with
`CODEX_ROUTER_REGISTRY=/path/file.json`. Installed background services use the
checked-in registry.

User-curated models (`user-models.json` in the state directory, written by
`bin/curate-models`) overlay the checked-in registry at load time. They pass
the same per-model validation, but a problem — including a collision with a
model a registry update later ships — skips the entry and surfaces it in
`USER_MODEL_WARNINGS` instead of failing the load, so a stale user file can
never take the router down. The listed-model live-test requirement applies to
registry submissions; curated entries are explicitly local-only.

Curated entries get their metadata from the user, not from any online
catalog: interactive curation asks for each new model's context window,
image support, and reasoning efforts (`--efforts` sets the effort ladder in
the deterministic `--models` form), and everything defaults conservatively
when unanswered. The stored entries in `user-models.json` are plain local
state — edit any value in place and re-run `./bin/install` to apply.

A curated model inherits a request profile from the provider's registry
models when it has any. The catalog-only resellers ship none, so curation
also offers `auto-tool-choice` (`--request-profile` in the deterministic
form) — the one profile meaningful to pick by hand, for a model whose
upstream rejects `tool_choice: "required"` while still calling tools under
`"auto"`. It normalizes the tool choice and nothing else, so it composes with
no vendor's parameter surface and misreads none. Keep it per model: the
restriction belongs to the upstream behind the reseller, and a provider-wide
downgrade would let models that honor a forced choice decline both the
compatibility probe and the subagent payload relay's forced function call.

## Tests

```sh
npm ci
npm run check
npm test
sh -n install.sh
for file in bin/*; do sh -n "$file"; done
npm audit --omit=dev
```

The test suite verifies native header forwarding, external credential
isolation, Kimi and DeepSeek rewriting, registry-generated gateway routes,
Zstandard request decoding, both Codex compaction formats, legacy migration,
provider selection, port defaults, Anthropic API forwarding, discovery
comparison, and service rendering for all three service platforms.

CI runs the Node suite on macOS, Linux, and Windows. Tagged releases are built
only after the suite passes and include checksums plus GitHub provenance
attestations.

Prepare an isolated state directory without touching the live Codex config:

```sh
test_root=$(mktemp -d)
CODEX_HOME="$test_root/codex" \
CODEX_ROUTER_STATE_DIR="$test_root/state" \
CODEX_BIN=/Applications/ChatGPT.app/Contents/Resources/codex \
./install.sh --prepare-only
```

Never use a real provider key in a fixture, command argument, shell history, or
committed file. Strict mock endpoints should assert the expected upstream model,
normalized request parameters, internal-auth replacement, and absence of Codex
identity headers.
