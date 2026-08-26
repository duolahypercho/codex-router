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

### Model catalog discovery

`src/untrusted-model-discovery.mjs` is the only network boundary for live
`/models` discovery. It resolves every destination before a request, follows
only same-origin redirects with a small hop limit, revalidates each hop, and
bounds both the response body and individual records. It returns a catalog
only after the response has the supported list shape; provider error bodies
are never copied into router errors. Credential-bearing public endpoints must
use HTTPS. Direct requests pin the validated address into the connection; a
proxy transport that would resolve the provider hostname independently is
refused because its destination cannot be proven by the router's DNS check.

`src/model-discovery.mjs` and generic-provider discovery are callers of that
library. Discovery metadata is advisory and cannot set a router request
profile unless it comes from a trusted checked-in or user-curated record.
Snapshots are written with the atomic private JSON writer and include a
provider/account fingerprint plus endpoint provenance. The versioned cache
rejects legacy, future, malformed, and symlinked documents instead of
normalizing them into a usable catalog. A cache hit is therefore scoped to
the same provider endpoint and credential identity; changing either causes a
live miss.

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

## Audit provider model catalogs

The **Provider model discovery** GitHub workflow has three deliberately
separate paths:

- Pull requests run only fixture-backed discovery tests. They receive no
  provider secrets and never call a live model endpoint.
- A weekly default-branch run audits every anonymous catalog and every API-key
  catalog whose matching repository secret is configured.
- A manual run accepts `all`, one provider ID, or a comma-separated set. A
  targeted run fails when a requested provider's credential is absent; an
  `all` run records unconfigured providers as skipped so one missing
  subscription does not hide the rest of the audit.

Repository secret names match the provider credential environment names in
`config/`; the workflow maps the supported names explicitly. Add only the
providers the repository is authorized to audit. GitHub Copilot requires the
fine-grained PAT described above in `COPILOT_GITHUB_TOKEN` rather than the
workflow's ordinary `GITHUB_TOKEN`.

Each live run uploads `provider-model-audit.json` and writes a job summary with
new candidates, unavailable registered IDs, skips, and failures. The report is
research input only: `src/model-discovery-audit.mjs` never invokes curation or
changes the registry. A newly advertised slug still needs the normal live
compatibility proof before it can become a listed model.

## Registry rules

The registry is intentionally declarative. `src/model-registry.mjs` rejects
unknown provider kinds, duplicate provider IDs, duplicate public slugs,
duplicate gateway model IDs, missing credential metadata, and incomplete picker
metadata.

Remote anonymous providers are a separate, tightly constrained mode. A
provider with `authMode: "anonymous"` must use one of the fixed official
endpoints allowlisted in `src/model-registry.mjs`, must not declare a
credential or a base-URL override, and must declare an `anonymousModelPolicy`
and user-facing `anonymousNote`. Discovery and user-model validation enforce
that policy so a free route cannot be used to reach paid model IDs. This mode
is for documented provider-side free exceptions; it is not an alternative
form of arbitrary keyless hosting (keyless providers remain loopback-only).

Models may declare `serviceTiers` as `{ id, name, description? }` entries only
when the upstream is verified to honor those request values. The catalog
exposes them as opt-in choices and always keeps standard service as the
default. User-curated entries can add the same field directly in
`user-models.json`; duplicate tier IDs are rejected.

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

The deterministic `--models` form is additive so adding one model cannot
discard other curated entries or their hand-tuned metadata. Non-interactive
pruning is explicit with `--remove id1,id2` and does not require a provider
network request. The interactive picker remains authoritative: deselecting an
entry there removes it.

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
for file in bin/*; do
  case "$file" in
    *.mjs) node --check "$file" ;;
    *) sh -n "$file" ;;
  esac
done
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
