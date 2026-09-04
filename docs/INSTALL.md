# Installation, migration, and upgrades

This page covers the Codex target:

```sh
./bin/model-router codex doctor
```

## Supported hosts

| Host | Codex surface |
| --- | --- |
| macOS | Codex App or CLI |
| Windows | Codex App or CLI |
| Linux | Codex CLI |

Required software:

- Node.js 22.19+ (Node.js 24 LTS recommended)
- `uv`, or Python 3.10+ with `venv`
- Git for managed one-command installation and rollback
- At least one Kimi OAuth, Kimi API, or DeepSeek API credential
- On Windows, Windows PowerShell in `FullLanguage` mode with application-control
  policy that permits `Add-Type`. The bounded process-tree owner fails before
  launching a mutation command when that host capability is unavailable.

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
curl -fsSL https://raw.githubusercontent.com/duolahypercho/codex-router/main/install.sh \
  | sh -s -- --target codex --guided --with-tray
```

Windows PowerShell:

```powershell
$installer = Join-Path $env:TEMP "codex-router-install.ps1"
Invoke-WebRequest https://raw.githubusercontent.com/duolahypercho/codex-router/main/install.ps1 -OutFile $installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -Target codex -Guided -WithTray
```

Clone-and-review installation is also supported:

```sh
git clone https://github.com/duolahypercho/codex-router.git
cd codex-router
./install.sh --target codex --guided --with-tray
```

```powershell
git clone https://github.com/duolahypercho/codex-router.git
Set-Location codex-router
./install.ps1 -Target codex -Guided -WithTray
```

The recommended commands install the complete desktop experience without an
extra question: the macOS menu-bar app with its Electron Control Center and
desktop widget, or the Windows/Linux Electron Control Center and tray.
`--no-tray` omits it; leaving out both tray flags makes guided setup ask. On
Windows the matching options are `-WithTray` and `-NoTray`.

On macOS one `Codex Router.app` bundle is placed in `~/Applications`. It keeps
the Swift-native menu-bar tray and embeds the Electron Control Center, so the
build needs the full Xcode app plus the Node runtime the router already
requires. The standalone Command Line Tools are insufficient for the SwiftUI
macro plug-ins used by recent macOS SDKs and do not provide the `xcodebuild`
needed by the WidgetKit extension. The build honors `DEVELOPER_DIR` and the
Xcode selected under **Xcode → Settings → Locations → Command Line Tools**. If
that selection names the standalone tools, a standard
`/Applications/Xcode.app` or `/Applications/Xcode-beta.app` is used for this
build only; nonstandard installations can be selected with `DEVELOPER_DIR`.
A missing full Xcode installation skips the companion with guidance instead of
failing the already-installed router. Opening the app shows the Control Center,
while a supervised login start keeps only the native tray visible. On Windows
the packaged Electron Control Center owns both the native tray and the full
window and is registered as the single `Codex Router Tray` logon task. Linux
uses the same packaged Control Center and native Electron tray. Neither
platform requires Rust.
Guided setup walks through numbered steps: a provider list you toggle by
number (`a` selects all, `n` clears, Enter continues) with a live
ready/needs-key/needs-sign-in status per provider, credential onboarding for
anything you selected that is not connected yet, and a review summary before
any change is made.

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
./bin/provider-key anthropic-api set
./bin/provider-key ollama-cloud set
./bin/provider-key qwen-plan set
./bin/provider-key zai-coding set
./bin/provider-key zai-api set
./bin/provider-key github-copilot set
./bin/provider-key orca set
```

Replace a stored key by running `set` again. Delete one with `remove`, which
also hides the provider from every installed client's model picker:

```sh
./bin/provider-key deepseek remove
```

The desktop app and macOS tray expose the same two actions per API provider:
**Replace key** and **Remove**. Removal only deletes the key files the router
manages — a key that also lives in the macOS Keychain or in an environment
variable is reported as still active so you can clear it at the source.

Grok OAuth uses the official Grok CLI session:

```sh
npm install -g @xai-official/grok
grok login --oauth
./bin/model-router codex providers enable grok-oauth
```

The OAuth token remains in `~/.grok/auth.json` and is sent only to xAI's Grok
CLI inference proxy. The separate `grok-api` provider continues to use a
separately billed xAI API key.

Antigravity OAuth uses a router-managed browser sign-in; it does not require a
Gemini API key or a separate CLI. **The Google Cloud project behind your OAuth
client must be allowlisted for `cloudcode-pa.googleapis.com`, a private Google
API.** Most projects are not allowlisted, and you cannot enable this API
yourself: it requires the producer-side `servicemanagement.services.bind`
permission, so `gcloud services enable` fails even for the project owner.
Sign-in will succeed, but the live probe will fail with `SERVICE_DISABLED` if
your project is not allowlisted. If your project is not allowlisted, this
provider cannot currently be used. Sign in, run the explicit live compatibility
probe, then enable the provider; these commands do not replace or disable any
other provider already selected.

macOS/Linux:

Create a Google OAuth **Desktop app** client in a Google Cloud project you own.
In Google Cloud Console, configure **APIs & Services > OAuth consent screen**
for your account with a truthful name such as **Codex Router**, not Antigravity
(including a test user when applicable), then choose **APIs & Services >
Credentials > Create credentials > OAuth client ID > Desktop app**.
Keep the resulting pair in that private browser tab. The login command binds
`127.0.0.1` on an OS-assigned port, then opens a local page where you enter the
matching pair. Only a loopback URL reaches the OS browser command; neither
client value enters argv or terminal output. Do not reuse the official `agy`
or Antigravity credential store.

An older incompatible router record is preserved until you explicitly run
`providers disconnect antigravity-oauth`; sign-in never overwrites or reuses
it automatically.

```sh
./bin/model-router codex providers login antigravity-oauth
./bin/model-router codex providers probe antigravity-oauth --live --yes
./bin/model-router codex providers enable antigravity-oauth
```

Windows PowerShell:

```powershell
.\model-router.ps1 codex providers login antigravity-oauth
.\model-router.ps1 codex providers probe antigravity-oauth --live --yes
.\model-router.ps1 codex providers enable antigravity-oauth
```

The client pair and tokens are stored together in the router's owner-only state
directory and can be removed from the desktop connection panel or with
`providers disconnect antigravity-oauth`. They are not copied into the service
definition. The live probe sends a small prompt and uses provider quota; add
`--provision-project` only if you explicitly authorize project creation. It
creates nothing unless a successful, schema-valid bootstrap response explicitly
advertises the tier to provision; auth errors, server errors, malformed
responses, and missing tiers fail closed. It identifies itself as Codex Router,
and the provider remains disabled unless
Google accepts that truthful identity. This is an unofficial compatibility
path over Google's internal Antigravity service, so model availability and wire
behavior may change independently of the public Gemini API.

A successful probe records a nonpublishable pending generation and restarts an
installed router service. Startup may boot that exact proof, then promotes it
only after the complete local stack is healthy; restart failure or process
death leaves it disabled. Earlier v2 proof records without activation metadata
are unverified and must pass this explicit live probe again. The Antigravity
forwarder is intentionally absent
before proof exists, so an unrelated process occupying its unused port cannot
break the rest of the router. A foreground development router must be restarted
by its operator; the command reports this instead of claiming the route is live.

Windows:

```powershell
./codex-router.ps1 provider-key kimi-api set
./codex-router.ps1 provider-key deepseek set
./codex-router.ps1 provider-key grok-api set
./codex-router.ps1 provider-key anthropic-api set
./codex-router.ps1 provider-key github-copilot set
./codex-router.ps1 provider-key orca set
```

Kimi OAuth, Kimi Platform, DeepSeek, xAI, Anthropic, GitHub Copilot, and OrcaRouter are separate account and billing
systems. Never put a credential in chat, a command argument, shell history,
the provider registry, or a tracked file.

OrcaRouter is catalog-only: after storing its key, use
`./bin/curate-models orca` to choose from the account-visible live
catalog, or `./bin/curate-models orca --free-only --apply` to add its
current concrete zero-price chat deployments. They appear under OrcaRouter
with a **Free** badge; the moving `orcarouter/free` meta-router is excluded.
Free inference still requires the key.

GitHub Copilot requires a fine-grained PAT with the **Copilot Requests**
permission. After storing it, run `./bin/curate-models github-copilot`; the
provider publishes no fixed model list because model and protocol availability
depends on the account's plan and organization policy. The router does not read
the official Copilot CLI credential store.

Noninteractive setup can reuse already configured credentials:

```sh
./install.sh --auto --providers configured --migrate-known
```

Or choose an exact set:

```sh
./install.sh --auto --providers kimi-oauth
./install.sh --kimi-api-key --auto
./install.sh --deepseek-api-key --auto
./install.sh --anthropic-api-key --auto
./install.sh --auto --providers kimi-oauth,kimi-api,deepseek
```

`--smoke-test` makes one small live request per provider and may use paid quota;
it is never enabled by default.

An API key found only in the installer's shell environment is valid for
foreground commands but is not copied into launchd, systemd, or Task Scheduler.
Use `provider-key ... set` so the per-user background service has persistent,
protected access.

## Outbound proxy

The router follows Node's explicit proxy opt-in. Set
`NODE_USE_ENV_PROXY=1` together with `http_proxy`, `https_proxy`, and
`no_proxy` (including their uppercase forms) before running setup or install.
On Node releases that support the flag, `--use-env-proxy` or
`NODE_OPTIONS=--use-env-proxy` is equivalent. The generated per-user
background service preserves the opt-in and values so a service started
outside the login shell uses the same proxy. Without the opt-in, inherited
proxy variables remain unused by the router.

Include `localhost`, `127.0.0.1`, and `::1` in `no_proxy` because the router's
own processes communicate over loopback.

### GUI clients and the system proxy

`no_proxy` covers processes that inherit your shell. Apps launched from the
Dock, Finder, or an IDE inherit nothing and fall back to the operating
system's proxy settings instead, whose bypass list routinely omits loopback.
When that happens the client sends its router request to the proxy, the proxy
closes the connection, and the client reports a bare transport failure such as
`stream disconnected before completion: error sending request for url`. Nothing
reaches the router, so `router.log` stays empty and `doctor` still reports the
service healthy -- the terminal keeps working the whole time, because a shell
exports `no_proxy`.

`doctor` detects this and names the remedy. On macOS, put loopback into the
session every GUI app inherits:

```sh
launchctl setenv NO_PROXY "localhost,127.0.0.1,::1"
```

Then fully quit and reopen the client; apps read this only at launch. The
setting lasts until you log out. To make it permanent, add a login agent at
`~/Library/LaunchAgents/local.noproxy-loopback.plist` that runs the same
command with `RunAtLoad`, and load it with
`launchctl bootstrap gui/$(id -u) <plist>`.

Adding loopback to the system bypass list (System Settings -> Network ->
Details -> Proxies) is equivalent in principle, but VPN clients that manage
the system proxy tend to rewrite that list whenever they reconnect, and some
clients do not honour it for literal loopback addresses.

`all_proxy` / `ALL_PROXY` is also preserved for child processes that support
it, but the router's Undici transport requires `http_proxy` or `https_proxy` to
enable proxy routing. After changing these variables, rerun install to refresh
the background service definition.

## Installer transaction

Setup performs these operations in order:

1. Validates provider selection and credential presence.
2. Detects other model-catalog owners and earlier Codex Router variants.
3. With approval, snapshots and stops only recognized older variants.
4. Installs locked Node dependencies and pinned LiteLLM in `.venv`.
5. Generates separate random Codex caller and internal-service keys.
6. Captures the native Codex model catalog and adds only selected provider models.
7. Generates gateway routes from the split registry tree under `config/`.
8. Adds the marked capability-bearing base URL and catalog block. When the user
   has not set an agent concurrency limit, it also configures six spawned-agent
   slots so native Kimi/Grok/GPT collaboration does not remain on Codex's small
   v2 default. Existing `[agents]` limits are preserved.
9. Protects the Codex config and its backup for the current user.
10. Installs the platform's per-user background service.
11. Waits for every local layer to report its expected service identity.
12. Records the installed commit and provider selection.
13. Runs the doctor.

If config or service installation fails, the new service and marked config block
are removed. If a legacy migration was part of the transaction, its exact config
and service definition are restored as well.

The installer does not kill an unknown process on ports 4200–4203 and does not
replace an unmarked user-owned `openai_base_url`, `model_catalog_json`, or agent
concurrency value. Disabling the router removes only its marked concurrency
default; a user-owned value remains intact.

## Credential-free (idle) install

For validating the router's install, lifecycle, network, and uninstall
behavior before trusting it with any credential, both installers accept an
explicit idle mode:

```sh
./install.sh --target codex --no-provider --no-discovery --no-tray
```

```powershell
./install.ps1 -Target codex -NoProvider -NoDiscovery -NoTray
```

`--no-provider` installs with an explicit empty provider selection: no
provider is selected, no credential is prompted for or written, and the
default-provider discovery scan is skipped. It conflicts with `--guided`,
`--providers`, and the key-prompt flags. On its own it does not disable
credential discovery — the doctor and tray may still look at what exists, and
Codex's native passthrough keeps working exactly as it does for an operator
who hides every provider by hand.

`--no-discovery` (requires `--no-provider`) additionally persists a discovery
kill-switch in the state directory (`discovery-mode.json`). While it is set:

- Provider credential files, the macOS Keychain, other CLIs' OAuth and
  session files, and Codex's own `auth.json` are never read.
- The `codex login status` sign-in probe is never spawned against the real
  `CODEX_HOME`. (The catalog build still runs `codex debug models --bundled`,
  which reads a static model list, not credentials.)
- The merged catalog publishes no models, so Codex's picker is empty by
  design while pointed at the router.
- Codex traffic reaching the router gets a local
  `503 router_idle_no_provider` error instead of native or provider
  forwarding. Nothing leaves the machine; every listener stays on
  `127.0.0.1` as always.

The full lifecycle works in this state:

```sh
./bin/model-router codex status
./bin/model-router codex doctor    # exits 0; idle state reports as warnings
./bin/model-router codex stop
./bin/model-router codex start     # starts the background service again
./bin/model-router codex uninstall
```

Uninstall is the undo path: it removes the managed config block and, once no
client integration remains, the background service and its LaunchAgent.
`rollback` is not — it reverts the managed *source checkout* to the previous
revision, not the installation.

To leave idle mode, re-run setup or the installer without the flags (for
example `./bin/setup --guided`); every setup run rewrites the discovery
marker, so a normal install re-enables discovery. `CODEX_ROUTER_NO_DISCOVERY=1`
(or `=0`) overrides the marker either way for one process.

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

If `model_catalog_json` points to a user-owned native Codex catalog rather than
another router, you can explicitly keep it as Codex Router's merge base:

```sh
./install.sh --auto --providers configured --adopt-native-catalog
```

```powershell
./install.ps1 -Auto -Providers configured -AdoptNativeCatalog
```

Adoption is accepted only when the path is absolute, the JSON contains at
least one native model, none of its slugs are already routed by Codex Router,
and no custom `openai_base_url` is configured. The file stays user-owned and
is read in place on every catalog rebuild, so moving, deleting, or making it
invalid stops the rebuild with an explicit error. Disabling Codex Router
restores that exact catalog path. A failed install clears a pending adoption
and leaves the original Codex config intact.

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
./bin/smoke-test --yes
./bin/test-model 'kimi-oauth/k3' --live --yes
```

## Starting the router when Codex starts

The router normally runs continuously under launchd, and the macOS tray starts
it again whenever Codex appears. Both learn about a new Codex by polling, so a
cold start can race: the CLI can send its first request a second or two before
the gateway is accepting connections.

The optional `codex` shim closes that window by doing the check in the one place
that is provably earlier than Codex — in front of it:

```sh
./bin/model-router codex shim install
./bin/model-router codex shim status
./bin/model-router codex shim uninstall
```

It is never installed automatically, because putting a file named `codex` on
your PATH shadows a command the router was not asked to own.

Install picks the writable directory closest to the real Codex but still ahead
of it on PATH, and refuses to overwrite any `codex` it did not write. If nothing
suitable is on PATH, the shim lands in the router's state directory and prints
the one `export PATH=...` line to add — it does not edit shell startup files on
your behalf. `status` distinguishes *installed* from *effective*, since a shim
that ends up behind the real Codex on PATH is a silent no-op.

When the router is already listening, the shim costs one loopback connection and
no processes at all. When it is not, the shim starts the service, waits up to
`MODEL_ROUTER_SHIM_WAIT` seconds (45 by default), and then runs Codex regardless
— a router problem must never become "codex will not start". Set
`MODEL_ROUTER_SHIM=0` for a single run to bypass the check entirely.

The shim is a bash script and is not available on Windows.

## Update and rollback

```sh
./bin/update check
./bin/update
./bin/rollback
```

Windows:

```powershell
./codex-router.ps1 update check
./codex-router.ps1 update
./codex-router.ps1 rollback
```

The updater requires the recognized GitHub origin and a checkout with no edits
to tracked files. It fetches `origin/main`, retains the current revision under
`refs/codex-router/rollback`, fast-forwards, and reinstalls. A failed install
automatically checks out and reinstalls the previous revision. `update check`
only compares the revisions and changes nothing.

Untracked files never block an update; only edits to tracked files do, and the
refusal names them. Keep them with `git -C <checkout> stash`, or discard them by
re-running the same command with `--force` (`./bin/update --force`,
`./bin/rollback --force`, `./codex-router.ps1 rollback --force`). The bootstrap
installers take the same escape: `--force` for the `curl | sh` script and
`-Force` for the `irm | iex` one. Every force path discards tracked edits only;
none of them delete untracked files.

Setup distinguishes a broken checkout from unfinished configuration. When it
exits 2 — a declined prompt, a missing credential, an invalid `--providers`
value — the update is kept, because none of those say anything about the code
that was just fetched, and discarding it means the next attempt repeats the
same failure with the same code. Rolling back there is what made a setup-path
bug impossible to fix by updating: the fix was fetched and then thrown away.
Any other non-zero exit still restores the previous revision. Re-run setup to
continue, or `./bin/rollback` (`./codex-router.ps1 rollback` on Windows) to
return to the retained revision deliberately.

For checkout installs, the reinstall skips dependency work whose inputs are
unchanged, so an update that carries no `package-lock.json` or LiteLLM pin
change costs a service restart rather than a full `npm ci` and PyPI resolution.
`./bin/doctor --fix` rebuilds checkout-owned dependencies regardless, as does
`./bin/install --force-deps` (`./install.ps1 -CheckoutInstall -ForceDeps` on
Windows). Homebrew owns the dependency tree in its formula prefix: its normal
doctor repair regenerates config and services without mutating that tree, and a
missing or broken package file must be repaired with `brew reinstall
codex-router`.

Homebrew packages only the router and CLI. Guided setup does not offer the
Electron Control Center, tray/menu-bar app, or macOS desktop widget, and an
explicit `--with-tray` is refused with guidance back to the complete source
installer. This keeps setup from downloading or compiling desktop application
code inside a Homebrew-managed installation.

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
Existing Codex Router installs that used the former 4100–4103/4108 defaults are
migrated on the next install or update: the managed Codex URL and generated
systemd/launchd/task service are rewritten as one install transaction, and the
old service is stopped before the new unit is started. Explicit
`MODEL_ROUTER_*_PORT` (or legacy `CODEX_ROUTER_*_PORT`) environment settings
remain authoritative for operators who intentionally keep a custom or legacy
block.
