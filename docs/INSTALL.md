# Installation, migration, and upgrades

This page covers the stable Codex target. The same checkout also contains an
isolated experimental Claude Desktop target; see [Claude Desktop target](CLAUDE.md)
for its one-command install, compatibility boundary, and rollback behavior.

Use the target-qualified command when both integrations may be present:

```sh
./bin/model-router codex doctor
./bin/model-router claude doctor
```

## Supported hosts

| Host | Stable Codex surface | Experimental Claude surface |
| --- | --- | --- |
| macOS | Codex App or CLI | Claude Desktop |
| Windows | Codex App or CLI | Claude Desktop |
| Linux | Codex CLI | Router development only |

Required software:

- Node.js 22.19+ (Node.js 24 LTS recommended)
- `uv`, or Python 3.10+ with `venv`
- Git for managed one-command installation and rollback
- At least one Kimi OAuth, Kimi API, or DeepSeek API credential

The installer does not silently install a system package manager or runtime.
When a prerequisite is missing, install it from its official source and rerun
the same command.

## Ask Codex to install it

```text
Install Codex Router from:
https://github.com/duolahypercho/codex-router

Follow AGENTS.md. Preserve all of my existing Codex settings and ChatGPT login.
Use only the provider authentication I choose, safely migrate recognized older
versions with a rollback snapshot, run the doctor, and do not quit Codex for me.
Never ask me to paste a token or API key into chat.
```

Codex should use a stable checkout, not a temporary directory. The service
definition stores the checkout's absolute path.

## Guided terminal install

macOS or Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/duolahypercho/codex-router/main/install.sh | sh -s -- --guided
```

Windows PowerShell:

```powershell
$installer = Join-Path $env:TEMP "codex-router-install.ps1"
Invoke-WebRequest https://raw.githubusercontent.com/duolahypercho/codex-router/main/install.ps1 -OutFile $installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -Guided
```

Clone-and-review installation is also supported:

```sh
git clone https://github.com/duolahypercho/codex-router.git
cd codex-router
./install.sh --guided
```

```powershell
git clone https://github.com/duolahypercho/codex-router.git
Set-Location codex-router
./install.ps1 -Guided
```

## Authentication choices

Kimi Code OAuth reuses the official CLI session. Guided setup offers to run the
login command when the CLI exists:

```sh
kimi login
```

API-key providers use hidden prompts:

```sh
./bin/provider-key kimi-api set
./bin/provider-key deepseek set
./bin/provider-key grok-api set
```

xAI documents API keys for third-party inference. Grok Build browser OAuth
remains scoped to the official Grok CLI and is not imported by this router.

Windows:

```powershell
./codex-router.ps1 provider-key kimi-api set
./codex-router.ps1 provider-key deepseek set
./codex-router.ps1 provider-key grok-api set
```

Kimi OAuth, Kimi Platform, DeepSeek, and xAI are separate account and billing
systems. Never put a credential in chat, a command argument, shell history,
the provider registry, or a tracked file.

Noninteractive setup can reuse already configured credentials:

```sh
./install.sh --auto --providers configured --migrate-known
```

Or choose an exact set:

```sh
./install.sh --auto --providers kimi-oauth
./install.sh --kimi-api-key --auto
./install.sh --deepseek-api-key --auto
./install.sh --auto --providers kimi-oauth,kimi-api,deepseek
```

`--smoke-test` makes one small live request per provider and may use paid quota;
it is never enabled by default.

An API key found only in the installer's shell environment is valid for
foreground commands but is not copied into launchd, systemd, or Task Scheduler.
Use `provider-key ... set` so the per-user background service has persistent,
protected access.

## Installer transaction

Setup performs these operations in order:

1. Validates provider selection and credential presence.
2. Detects other model-catalog owners and earlier Codex Router variants.
3. With approval, snapshots and stops only recognized older variants.
4. Installs locked Node dependencies and pinned LiteLLM in `.venv`.
5. Generates separate random Codex caller and internal-service keys.
6. Captures the native Codex model catalog and adds only selected provider models.
7. Generates gateway routes from `config/providers.json`.
8. Adds the marked capability-bearing base URL and catalog block, then protects
   the Codex config and its backup for the current user.
9. Installs the platform's per-user background service.
10. Waits for every local layer to report its expected service identity.
11. Records the installed commit and provider selection.
12. Runs the doctor.

If config or service installation fails, the new service and marked config block
are removed. If a legacy migration was part of the transaction, its exact config
and service definition are restored as well.

The installer does not kill an unknown process on ports 4100–4103 and does not
replace an unmarked user-owned `openai_base_url` or `model_catalog_json`.

## Recognized older installations

Read-only detection:

```sh
./bin/migrate detect
```

The migration engine recognizes:

- `io.github.kimi-codex-router` with `~/.codex/kimi-router`
- `com.ziwenxu.kimi-codex-proxy` with `~/.codex/kimi-proxy`
- complete or malformed start-only Kimi managed config markers

Approved migration stops only those services, retains their state directories,
moves their service definitions into `$CODEX_HOME/codex-router/migrations`, and
stores the original config with protected permissions. Restore it with:

```sh
./bin/migrate rollback
```

An unknown catalog owner requires a manual decision; automatic setup stops
without changing it.

## Restart and verify

`model_catalog_json` is loaded at Codex startup. Fully quit the app, reopen it,
and create a new task. On macOS use Command-Q; on Windows use the app's Quit
command or end it from the tray if present.

```sh
./bin/doctor
./bin/providers
codex debug models
```

The doctor reports exact remediation beneath each failed layer. Safe managed
state can be rebuilt with:

```sh
./bin/doctor --fix
```

Live quota-consuming verification is separate:

```sh
./bin/smoke-test
./bin/test-model 'kimi-oauth/k3' --live --yes
```

## Update and rollback

```sh
./bin/update
./bin/rollback
```

Windows:

```powershell
./codex-router.ps1 update
./codex-router.ps1 rollback
```

The updater requires a clean checkout on the recognized GitHub origin. It
fetches `origin/main`, retains the current revision under
`refs/codex-router/rollback`, fast-forwards, and reinstalls. A failed install
automatically checks out and reinstalls the previous revision.

When upgrading from a release without caller capabilities, the installer
generates one, replaces only the marked managed URL, tightens config permissions,
and restarts the per-user router service. Fully quit and reopen Codex afterward
so it reloads the new URL.

`./bin/rollback` switches to the cached previous revision and reinstalls it. A
later `./bin/update` returns the managed checkout to `main` before updating.

For a source archive without `.git`, download and install a newer tagged archive
instead. Release pages provide SHA-256 checksums and provenance attestations.

## Disable and uninstall

```sh
./bin/disable
./bin/enable
./bin/uninstall
```

Windows:

```powershell
./codex-router.ps1 disable
./codex-router.ps1 enable
./codex-router.ps1 uninstall
```

Uninstall removes the marked integration config and current background service.
It intentionally retains the checkout, native catalog cache, logs, backups,
migration snapshots, internal key, and provider credentials. This prevents a
routine uninstall from silently destroying authentication or recovery data.
