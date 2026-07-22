# Security model

Codex and Cursor targets share source code but not their trust roots. Each has a
separate caller key, internal key, state directory, provider selection, API-key
files, service identity, and port range. Kimi OAuth is the intentional
exception: both targets may reuse the official Kimi CLI session under
`~/.kimi-code`.

## Credential separation

Codex Router handles four credential classes and keeps them on distinct paths:

- ChatGPT/Codex authentication is allow-listed only for native GPT requests.
- Kimi Code OAuth is read from the official Kimi CLI directory and sent only to
  the Kimi Code managed endpoint.
- Kimi Platform API keys are sent only to the configured Kimi Platform endpoint.
- DeepSeek API keys are sent only to the configured DeepSeek endpoint.

External requests never receive ChatGPT account IDs, Codex installation IDs,
attestation headers, or the caller's authorization header. The loopback gateway
uses a random internal key, which the final forwarder replaces with exactly one
provider credential.

No provider credential is written to the model registry, catalog, Codex config,
generated LiteLLM config, logs, or health responses. Codex config does contain a
random, local-only caller capability as part of the managed loopback URL. The
config, its backup, migration snapshots, and diagnostic output are therefore
protected or redacted.

## Local secret storage

Codex state lives under `$CODEX_HOME/codex-router` by default. Cursor state uses
`~/.local/state/model-router/cursor` on POSIX or
`%LOCALAPPDATA%\model-router\cursor` on Windows. Each target has its own copy of
the applicable files below; the native/merged catalogs exist only for Codex:

| File | Purpose | Mode |
| --- | --- | --- |
| `internal-secret` | Random loopback service key | `600` |
| `caller-secret` | Random capability used by that app target's router requests | `600` |
| `kimi-api-key.secret` | Optional Kimi Platform key | `600` |
| `deepseek-api-key.secret` | Optional DeepSeek key | `600` |
| `xai-api-key.secret` | Optional xAI key | `600` |
| `anthropic-api-key.secret` | Optional Anthropic key | `600` |
| `native-models.json` | Cached native Codex catalog | `600` |
| `merged-models.json` | Native plus registry model catalog | `600` |
| `litellm.yaml` | Generated routes with environment references only | `600` |
| `enabled-providers.json` | Picker visibility, no credential values | `600` |
| `install-manifest.json` | Installed version and rollback metadata | `600` |
| `migrations/` | Protected config/service rollback snapshots | private |
| `support/` | Locally generated diagnostic bundles | `600` files |

The Codex target can read provider keys from process environment or compatible
legacy macOS Keychain services; the Cursor target does not reuse those Codex
Keychain entries. The interactive helper writes target-specific protected local
files so the per-user background service can access them without copying
secrets into its service definition. Files use mode `600` on POSIX systems. On
Windows, the helper removes inherited ACL entries and grants access only to the
current user SID.

Installers deliberately do not copy API-key environment variables into launchd,
systemd, or Task Scheduler definitions. Environment-only credentials work for a
foreground router process, but background setup requires a target-specific
protected file. Compatible legacy Keychain lookup is a Codex-only migration
path.

Kimi OAuth remains under `$KIMI_CODE_HOME` or `~/.kimi-code`; Codex Router does
not copy it into its own state directory.

Never commit either state directory, a provider key, a Kimi credential file, or
a generated config from a live installation.

## Network boundary

The router, LiteLLM gateway, OAuth forwarder, and API forwarder bind only to
`127.0.0.1`. Every model route requires a random caller capability: Codex carries
it in the managed URL and Cursor sends it as the configured gateway credential.
Internal gateway and forwarder routes require a separate random service key,
and credential-detail health responses are authenticated.
Model requests must use JSON, requests with browser-origin headers are rejected,
and the router sends no CORS permission headers. This remains compatible with
Codex API-key sessions that do not attach a bearer header to the loopback hop.

This blocks drive-by browser requests and processes running without access to
the user's protected files. It does not create a security boundary against
malicious code already running as the same OS user, which can generally read
that user's Codex config and process state. Do not change listeners to
`0.0.0.0`, tunnel the ports, or expose them on a shared network. These controls
are not internet-facing authentication.

Codex may include the request URL in its own error output. Treat the full URL as
sensitive even though it is loopback-only; redact the generated path before
sharing screenshots or logs.

API base URL overrides are trusted-user configuration. A malicious override can
send the matching provider credential to another server. Inspect background
service environment changes and never accept an untrusted `config/providers.json`.

## Configuration safety

The config manager:

- Writes only a marked `openai_base_url` and `model_catalog_json` block.
- Preserves `model`, `model_provider`, reasoning settings, profiles, and ChatGPT
  authentication.
- Refuses to replace an unmarked user-owned base URL or catalog.
- Creates `~/.codex/config.toml.pre-codex-router` before its first change.
- Atomically rewrites the config and restricts it to the current user.
- Recognizes and removes the earlier Kimi-specific managed block during upgrade.
- Snapshots recognized old service definitions and exact config before migration.
- Refuses unknown router catalogs and unrecognized origin URLs during update.

Review the scoped difference with:

```sh
diff -u ~/.codex/config.toml.pre-codex-router ~/.codex/config.toml
```

## Dependency and release hygiene

LiteLLM is version-pinned because it processes prompts, tool calls, streams, and
provider responses. Node dependencies are locked by `package-lock.json`. CI runs
syntax, audit, and route/state tests on macOS, Linux, and Windows. Tagged source
archives include SHA-256 checksums and GitHub build-provenance attestations.

The convenience bootstrap commands track the repository's default branch. Users
who need a fully reviewable or pinned install should download a tagged archive,
verify `SHA256SUMS` and its provenance, inspect it, and run the local installer.

Model discovery is read-only and never edits the registry. The live compatibility
suite requires both `--live` and `--yes` because it sends prompts and consumes
provider quota. Repository workflows receive provider keys only through GitHub
Secrets; pull-request CI never receives them.

Support bundles exclude logs by default and are never uploaded automatically.
The optional redacted log tail can still contain private prompt or response text
and must be inspected before sharing.

Network-facing error handlers do not return or log raw exception text. Detailed
credential state is available only through authenticated local health checks and
the redacted doctor/support workflows.

## Reporting a vulnerability

Use [GitHub Private Vulnerability Reporting](https://github.com/duolahypercho/codex-router/security/advisories/new).
Do not include technical vulnerability details, access tokens, API keys,
credential files, full prompts, response bodies, or unredacted logs in a public
issue.
