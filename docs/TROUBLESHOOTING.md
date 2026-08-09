# Troubleshooting

Start with:

```sh
./bin/model-router codex doctor
```

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

## State directory belongs to another checkout

If `doctor` reports a state ownership failure, you are running from a clone
that did not perform the install. The safe fix is to repair through the
checkout that owns the installed state:

```sh
./bin/model-router codex doctor --fix
```

When the recorded owner still exists, this command runs the repair there and
keeps the installed checkout unchanged. It deliberately transfers ownership to
the current checkout only when the recorded owner is gone or you set
`MODEL_ROUTER_ALLOW_FOREIGN_STATE=1`.

To inspect the recorded owner:

```sh
# Find the owning checkout from the state manifest.
STATE_DIR="${MODEL_ROUTER_STATE_DIR:-${CODEX_ROUTER_STATE_DIR:-${KIMI_CODEX_STATE_DIR:-${HOME}/.codex/codex-router}}}"
cat "$STATE_DIR/install-manifest.json" | sed -n '1,80p'
```

To deliberately switch ownership to the checkout you are running from:

```sh
MODEL_ROUTER_ALLOW_FOREIGN_STATE=1 ./bin/model-router codex doctor --fix
```

## External models are missing from the picker

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

## Routed model agents are missing

Pulling `main` updates only the source checkout. Apply that revision to the
per-user Codex installation and verify the generated custom agents:

```sh
./bin/model-router codex update
./bin/model-router codex doctor
```

The doctor should report `OK` for `Routed model agents`. If it does not:

```sh
./bin/model-router codex doctor --fix
```

Then fully quit Codex, reopen it, and create a new task. The generated personal
agent definitions are stored under `$CODEX_HOME/agents/` (normally
`~/.codex/agents/`).

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

## Windows blocks the Grok OAuth CLI

On Windows, first confirm that the installed official CLI can launch:

```powershell
grok --version
```

If that command reports `spawn UNKNOWN`, "An Application Control policy has
blocked this file," or a Smart App Control notification, Grok OAuth cannot
complete login or refresh its session. Keep Smart App Control enabled; it does
not offer a safe per-app bypass for this failure. Until xAI publishes an
official CLI build that Windows allows, use the API-key provider instead:

```powershell
./model-router.ps1 codex provider-key grok-api set
./model-router.ps1 codex providers enable grok-api
./model-router.ps1 codex doctor
```

An OAuth session created while the executable was allowed is not a durable
workaround. The router invokes the official CLI again near token expiry, so the
session eventually stops refreshing if Windows blocks the executable later.

## An API key is missing or invalid

```sh
./bin/provider-key kimi-api set
./bin/provider-key deepseek set
./bin/provider-key anthropic-api set
./bin/provider-key kimi-api status
./bin/provider-key deepseek status
./bin/provider-key anthropic-api status
```

Input is hidden. After you press Enter, the prompt reports how many characters
it received, so you can tell a paste registered, and it asks before saving a
value that looks like the same key pasted twice. A key written by the helper is
protected for the current user.
Setting or rotating it takes effect on the next request; the background service
does not need a restart.

Confirm the key belongs to the named system. Kimi Code OAuth, Kimi Platform,
DeepSeek, Anthropic, Alibaba Model Studio plans, and the Z.ai GLM Coding Plan
do not share credentials or billing. Alibaba plan keys (`sk-sp-` prefix) are
separate from pay-as-you-go Model Studio keys and only work with the plan's
dedicated base URL. The Z.ai coding key is also distinct from general Z.ai
platform keys; only the Coding Plan subscription key works with the coding
endpoint.

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

To use a newly discovered model locally without waiting for a registry
release, curate it for your own machine:

```sh
./bin/curate-models deepseek
```

Curated entries live in the state directory's `user-models.json` with the
context window, image support, and reasoning efforts you provide during
curation (conservative defaults otherwise), are skipped automatically if a
later registry update ships the same model, and are removed by re-running
the command and deselecting them.

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

The task runs `start-codex-router-hidden.vbs` from the state directory under
`wscript.exe`, which starts `start-codex-router.cmd` without a console window,
so a missing window is not a sign that the router is down. Read `router.log` in
the same directory for its output.

Keep the repository at the absolute path used during installation. Rerun setup
from the new path if it was moved.

## An update failed

The updater normally reinstalls its cached previous revision automatically.
Manual rollback is:

```sh
./bin/rollback
```

Updates refuse edits to tracked files, non-`main` development branches, and
unknown origin URLs rather than overwriting local work. Untracked files never
block an update; the refusal names the tracked files that do, and re-running the
same command with `--force` discards those edits without deleting anything
untracked.

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

## Voice Mode reports an unsupported `/v1/live` route

Codex Voice uses native realtime endpoints that are separate from the Responses
API. Current installs keep the WebRTC call and its sideband WebSocket on Codex's
native endpoints instead of sending them through the Responses-only router.

Run `./bin/enable` again after updating, fully quit Codex, and reopen it so the
managed realtime overrides take effect. User-owned realtime endpoint overrides
are preserved.

## Uninstall retained files

This is intentional. `./bin/uninstall` removes only the active integration and
background service. The state directory may contain credentials, logs, catalog
caches, install history, and rollback snapshots. Inspect it manually before
deleting anything.
