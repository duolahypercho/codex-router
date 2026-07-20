# Security model

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

No credential value is written to the model registry, catalog, Codex config,
generated LiteLLM config, logs, or health responses.

## Local secret storage

Sensitive state lives under `$CODEX_HOME/codex-router` by default:

| File | Purpose | Mode |
| --- | --- | --- |
| `internal-secret` | Random loopback service key | `600` |
| `kimi-api-key.secret` | Optional Kimi Platform key | `600` |
| `deepseek-api-key.secret` | Optional DeepSeek key | `600` |
| `native-models.json` | Cached native Codex catalog | `600` |
| `merged-models.json` | Native plus registry model catalog | `600` |
| `litellm.yaml` | Generated routes with environment references only | `600` |
| `enabled-providers.json` | Picker visibility, no credential values | `600` |
| `install-manifest.json` | Installed version and rollback metadata | `600` |
| `migrations/` | Protected config/service rollback snapshots | private |
| `support/` | Locally generated diagnostic bundles | `600` files |

The router can read provider keys from process environment or compatible macOS
Keychain services. The interactive helper writes protected local files so the
per-user background service can access them without copying secrets into its
service definition. Files use mode `600` on POSIX systems. On Windows, the
helper removes inherited ACL entries and grants access only to the current user
SID.

Installers deliberately do not copy API-key environment variables into launchd,
systemd, or Task Scheduler definitions. Environment-only credentials work for a
foreground router process, but background setup requires a protected file or a
compatible Keychain entry.

Kimi OAuth remains under `$KIMI_CODE_HOME` or `~/.kimi-code`; Codex Router does
not copy it into its own state directory.

Never commit either state directory, a provider key, a Kimi credential file, or
a generated config from a live installation.

## Network boundary

The router, LiteLLM gateway, OAuth forwarder, and API forwarder bind only to
`127.0.0.1`. Do not change them to `0.0.0.0`, tunnel the ports, or expose them on
a shared network. The internal key is defense in depth for local process
separation, not an internet-facing authentication system.

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
- Atomically rewrites the config while preserving file permissions.
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

## Reporting a vulnerability

Open a private GitHub security advisory for the repository when available. Do
not include access tokens, API keys, credential files, full prompts, response
bodies, or unredacted logs in an issue.
