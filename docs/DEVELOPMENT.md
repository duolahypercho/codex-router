# Development guide

## Architecture

- `config/providers.json` is the provider and model registry.
- `src/model-registry.mjs` validates and indexes that registry.
- `src/catalog.mjs` merges listed registry models with native Codex models.
- `src/litellm-config.mjs` generates every Responses-to-Chat-Completions route.
- `src/router.mjs` dispatches native and namespaced external model IDs.
- `src/oauth-forwarder.mjs` owns Kimi CLI OAuth loading and refresh.
- `src/api-forwarder.mjs` is shared by all API-key providers.
- `src/provider-credentials.mjs` isolates environment, file, and Keychain lookup.
- `src/start.mjs` supervises the loopback processes.

## Add an OpenAI-compatible provider

1. Add a provider object to `config/providers.json` with a unique lowercase ID,
   API base URL, environment variable, protected key filename, and optional
   Keychain service.
2. Add one model object per upstream model. Public slugs should be namespaced as
   `provider/model`, and internal `gatewayModel` values must be unique.
3. Supply picker metadata for listed models: label, description, reasoning
   levels, context window, compaction limit, modalities, and compatibility hash.
4. Use an existing request profile or add a narrowly scoped profile to
   `src/api-forwarder.mjs` when the upstream needs parameter normalization.
5. Add routing, credential-isolation, and request-normalization tests.
6. Update the README model table and provider-specific setup documentation.

The shared forwarder strips Codex/ChatGPT authentication before injecting the
selected provider key. Do not create a new listener merely to add another
standard OpenAI-compatible provider.

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
`CODEX_ROUTER_REGISTRY=/path/file.json`. Production LaunchAgents use the
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
Zstandard request decoding, and both Codex compaction formats.

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
