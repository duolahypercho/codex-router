# Troubleshooting

Start with:

```sh
./bin/model-router codex doctor
./bin/model-router claude doctor
```

Use only the command for the installed target. Claude-specific recovery is in
[the Claude target guide](CLAUDE.md#troubleshooting).

Every `FAIL` includes a targeted fix. To rebuild only repository-managed files,
config, and service state:

```sh
./bin/doctor --fix
```

If a recognized older Kimi router is reported:

```sh
./bin/doctor --fix --migrate-known
```

Neither command prints credential values. Repair refuses unknown router owners.

## External models are missing from the picker

The steps below are for Codex. For Claude Desktop, use
`./bin/model-router claude doctor`, fully restart Claude, and check the Managed
Configuration Report described in the Claude guide.

```sh
./bin/providers
./bin/refresh-catalog
./bin/doctor
```

The intended provider must say both `SHOW` and `ready`. Enable a configured
provider with `./bin/providers enable PROVIDER`.

Then fully quit Codex, reopen it, and create a new task. Closing only a window
does not reload `model_catalog_json`.

Inspect Codex's startup catalog directly:

```sh
codex debug models
```

The config root should contain exactly one `codex-router-managed` block with the
loopback base URL on port 4102, a generated `/_codex-router/.../v1` path, and a catalog under
`$CODEX_HOME/codex-router/merged-models.json`.

The generated path is a local caller capability. Use `./bin/status`, which
redacts it, when sharing diagnostics. Never paste the complete URL into an issue.

## Kimi OAuth is not ready

```sh
kimi login
./bin/providers enable kimi-oauth
./bin/doctor
```

Codex Router reads the official Kimi CLI credential under `$KIMI_CODE_HOME` or
`~/.kimi-code` and refreshes it under a cross-process lock. Do not copy the OAuth
token into Codex config, an API-key file, or an environment variable.

## An API key is missing or invalid

```sh
./bin/provider-key kimi-api set
./bin/provider-key deepseek set
./bin/provider-key anthropic-api set
./bin/provider-key kimi-api status
./bin/provider-key deepseek status
./bin/provider-key anthropic-api status
```

Input is hidden. A key written by the helper is protected for the current user.
Setting or rotating it takes effect on the next request; the background service
does not need a restart.

Confirm the key belongs to the named system. Kimi Code OAuth, Kimi Platform,
DeepSeek, and Anthropic do not share credentials or billing.

## A provider changed its model IDs

Compare the provider's official model-list endpoint with the registry:

```sh
./bin/discover-models deepseek
./bin/discover-models kimi-api
```

Discovery does not edit the registry. A new ID still needs official capability
metadata and an explicitly billed compatibility run covering text, streaming,
tools, and compaction:

```sh
./bin/test-model 'provider/model' --live --yes
```

Open a provider request with the official documentation and test results. Do
not add an untested model directly to every user's picker.

## Native GPT models stopped working

Temporarily return Codex to its native base URL:

```sh
./bin/disable
```

This removes only the marked block and current service; it preserves the
selected model, profiles, provider credentials, and ChatGPT login. If native
models work again, inspect router health and create a support bundle.

## Another process owns ports 4100–4103

macOS/Linux:

```sh
lsof -nP -iTCP:4100 -iTCP:4101 -iTCP:4102 -iTCP:4103 -sTCP:LISTEN
```

Windows PowerShell:

```powershell
Get-NetTCPConnection -LocalPort 4100,4101,4102,4103 -State Listen |
  Select-Object LocalAddress,LocalPort,OwningProcess
```

Do not kill the process until its owner and purpose are known. The installer
migrates only recognized earlier repository services and otherwise stops with a
conflict.

## The background service is stopped

macOS:

```sh
launchctl print "gui/$(id -u)/io.github.codex-router"
./bin/doctor --fix
```

Linux:

```sh
systemctl --user status codex-router.service
journalctl --user -u codex-router.service --since today
./bin/doctor --fix
```

Windows PowerShell:

```powershell
Get-ScheduledTask -TaskName "Codex Router"
./codex-router.ps1 doctor --fix
```

Keep the repository at the absolute path used during installation. Rerun setup
from the new path if it was moved.

## An update failed

The updater normally reinstalls its cached previous revision automatically.
Manual rollback is:

```sh
./bin/rollback
```

Updates refuse dirty checkouts, non-`main` development branches, and unknown
origin URLs rather than overwriting local work.

Legacy migration rollback is separate:

```sh
./bin/migrate rollback
```

## Create a support bundle

```sh
./bin/support-bundle
```

The generated mode-`600` JSON includes versions, doctor checks, service state,
provider presence, config ownership, and file metadata. It excludes credential
values, prompts, responses, and log contents.

Only when log context is necessary:

```sh
./bin/support-bundle --include-logs
```

The log tail is mechanically redacted but may still contain private prompt or
response text. Inspect it before uploading or attaching it anywhere. The tool
never uploads a bundle automatically.

## WebSocket warning followed by HTTP fallback

This is expected. Codex Router declines the optional Responses WebSocket
upgrade, and current Codex falls back to compressed HTTP. A warning alone is not
a failed model request.

## Uninstall retained files

This is intentional. `./bin/uninstall` removes only the active integration and
background service. The state directory may contain credentials, logs, catalog
caches, install history, and rollback snapshots. Inspect it manually before
deleting anything.
