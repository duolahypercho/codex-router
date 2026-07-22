# Development guide

## Architecture

- `config/providers.json` is the provider and model registry.
- `src/model-registry.mjs` validates and indexes that registry.
- `src/catalog.mjs` merges listed registry models with native Codex models.
- `src/litellm-config.mjs` generates every provider translation route.
- `src/router.mjs` dispatches native and namespaced external model IDs.
- `src/oauth-forwarder.mjs` owns Kimi CLI OAuth loading and refresh.
- `src/grok-oauth-forwarder.mjs` adapts Grok CLI OAuth to OpenAI-compatible chat.
- `src/api-forwarder.mjs` is shared by all API-key providers.
- `src/provider-credentials.mjs` isolates environment, file, and Keychain lookup.
- `src/provider-selection.mjs` controls which tested models enter the picker.
- `src/start.mjs` supervises the loopback processes.
- `src/service-*.mjs` install per-user services for macOS, Linux, and Windows.
- `src/paths.mjs` isolates app targets, state roots, ports, and service names.

## Add an API-key provider

1. Add a provider object to `config/providers.json` with a unique lowercase ID,
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
provider selection, target isolation, Anthropic API forwarding, discovery
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
