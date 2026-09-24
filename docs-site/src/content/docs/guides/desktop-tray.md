---
title: "Tray and prebuilt packages"
description: "Build, download, and run the desktop companion."
---
The desktop app combines the Codex Router tray and full Electron Control Center
in one visible installation. It uses the same local control plane and health
endpoint as the command line, so provider selection, quota data, and token
history stay consistent across surfaces. macOS retains its Swift-native tray
and embeds the Control Center in `Codex Router.app`; Windows and Linux use the
Control Center's native Electron tray.

# Platform behavior

| Platform | Native tray | Full Control Center | Open behavior |
| --- | --- | --- | --- |
| macOS 13+ | Swift `NSStatusItem` | Embedded Electron | Open `Codex Router.app` or use **Control Center** in the menu-bar panel |
| Windows 10/11 | Electron `Tray` | Electron window | Left-click the tray icon or use **Open Control Center** |
| Linux | Electron `Tray` | Electron window | Left-click the tray icon or use **Open Control Center** |

Closing the full Control Center window never quits a proven tray owner. On
Windows, and on Linux while a registered StatusNotifier host is available,
clicking the Electron tray item restores the window in the same process. On
macOS, reopen `Codex Router.app` or choose **Control Center** from the native
menu-bar panel. Use the tray menu's **Quit** action to end the complete
Windows/Linux app; quitting the native macOS host also terminates its embedded
Control Center.

Linux tray-only startup verifies the desktop's registered StatusNotifier host.
If that proof is unavailable or negative, including when the system `gdbus`
probe is missing, the launch keeps a visible Control Center window instead of
leaving an invisible background process. Closing that fallback window exits
the process because there is no proven tray surface from which to reopen it.

# What the Control Center shows

- **Dashboard** summarizes router health, the active model and provider,
  request activity, token traffic, and recently observed models.
- **Usage** provides 7-, 30-, and 90-day token views, provider and model
  breakdowns, and the account limits each connected provider reports.
- Quota cards use one **Weekly limit** label and one reset line. A reported
  five-hour window appears as its own **5-hour limit** card.
- Provider cards are absent until that provider has a usable OAuth session or
  API key. Unconnected providers remain available only in **Connections**.
- **Connections** includes a **Use without OpenAI login** switch for new Codex
  sessions. It requires a connected, enabled external provider and restores the
  prior model-provider setting when switched off.
- **Models** groups equivalent routes by model family. Each provider route has
  its own picker visibility, certified subagent selection, and reasoning-effort
  controls; the provider directory can discover and add catalog models.
- **Local LLMs** installs, enables, and removes Ollama models on this machine.
  Installs poll their detached download worker and show live percentage;
  removals keep a visible operation banner even when the installed row
  disappears immediately. A completed download is hidden after its model is
  removed, so stale `ready · 100%` state never implies that it is still on disk.
  If Ollama removal succeeds but the Codex catalog cannot be refreshed, the
  status remains **Model removed** with a catalog-refresh warning rather than
  reporting a false removal failure.
  Both operations expose a persistent status bar while running and a **Cancel**
  action. Cancelling clears the operation card after the worker is stopped. The
  control plane serializes install/removal claims and returns an existing
  operation for repeated requests, so a double-click cannot launch duplicate
  Ollama workers.
  The same Control Center on every platform also exposes the Ollama catalog,
  grouped by family with search, fit warnings, cloud-only labels, and a
  download action for every local tag. New or uncatalogued Ollama tags remain
  installable through the tag or model-page URL field.
- **Usage** shows the active or most recently used model's observed output
  throughput when the upstream reports output tokens. The rate is calculated
  from the streamed generation phase of the latest 20 clean, successful
  replies, excluding queueing, prompt processing, retries, and historical rows
  that predate generation timing.
- **Status** mirrors the macOS live view with in-flight requests, elapsed time,
  model speed, and quota reset times. Usage also includes all-provider and
  tokens-by-model summaries.
- **Connections** includes signed routing, login-free mode, tray presence
  (always or while Codex/ChatGPT is running), one-click OAuth **Install & Sign
  In**, and Update/Fix maintenance actions.
- **Vision bridge** exposes the shared native/hosted engine and effort
  selectors, local vision downloads, benchmark/use actions, and the same
  default-on/fail-closed behavior as macOS.

The Control Center honors the system's reduced-motion preference. The native
macOS host retains its optional Island animations and hover details; Windows
and Linux expose only the normal Control Center window and native Electron tray,
with no separate activity-pill or hover window.

# Opening it in a browser instead

The same panel is served by the router you have already started, so there is
nothing to build, download, or find in the tray:

```powershell
.\codex-router.ps1 panel
```

```sh
./bin/panel
```

That opens your default browser on the companion. The address carries this
machine's router capability, so treat it as a password: the command prints it
redacted, and `--print` is the only way to get the literal URL. Do not paste it
into chat, an issue, or a screen share.

The browser panel is read-only by design. Saving an API key is not something to
expose to any page that learns the capability, so those commands stay in the
tray and the desktop shells.

# Building the unified app

Windows and Linux build `apps/control-center` directly. The compatibility
entrypoints keep their old names so existing automation continues to work, but
they no longer build or select the old Tauri or tray-only Electron shells:

```powershell
.\scripts\build-electron-companion.ps1
.\codex-router.ps1 tray install
```

```sh
./scripts/build-electron-companion.sh
./bin/model-router-tray
```

Both scripts verify the renderer, package the native Electron executable, and
refuse success if the final executable is absent. Node.js 22.19 or newer is the
only additional build runtime; Rust is not required.

# Downloading a prebuilt app

**From a tagged release (unsigned tester builds).** Tagged releases attach the
Windows and Linux Control Center packages, checksummed in `SHA256SUMS` and
covered by the same build provenance attestation as the source archives. These
packages are unsigned frontends, not standalone router installers: install the
same Codex Router version first, then run the matching desktop package.

| Asset | Platform |
| --- | --- |
| `model-router-<version>-windows-x64.exe` | Windows 10/11 unsigned tester installer |
| `model-router-<version>-linux-x64.tar.gz` | Linux archive containing the executable AppImage |

Windows SmartScreen may warn about the unsigned installer. On Linux, extract
the tarball before launching its AppImage; the archive preserves its executable
permission. Do not copy the AppImage out through a tool that strips file modes.

Tagged releases do not publish an ad-hoc-signed macOS app. An ad-hoc signature
only proves bundle integrity on the machine that built it; public macOS
distribution waits for Developer ID signing and notarization.

**From a CI run (for unreleased changes).** Open the **Actions** tab, pick a
green **CI** run, and download the Control Center artifact for Windows/Linux or
the unified macOS app artifact. All are unsigned/test-only; the macOS bundle is
ad-hoc signed, and each package requires a matching router checkout or install.
CI no longer publishes the legacy Tauri shell or a standalone macOS Electron
child.

# Build prerequisites

- Node.js 22.19 or newer
- The normal Codex Router checkout and its installed npm dependencies

The build scripts only report missing prerequisites; they do not install a
system runtime or package manager.

# Build and run

The build commands above create `linux-unpacked/codex-router-control-center` or
`win-unpacked/Codex Router.exe` under `apps/control-center/release`.

# Starting at logon

`install.ps1 -WithTray` builds the companion and registers a `Codex Router
Tray` scheduled task that runs it at logon, separately from the router's own
`Codex Router` task so stopping one never takes the other down. The same task
is managed directly with:

```powershell
node src\control.mjs tray enable    # build required first; also starts it now
node src\control.mjs tray status
node src\control.mjs tray disable
```

Quitting from the tray menu keeps it quit: the restart setting covers a crash,
not a clean exit, so the tray returns at the next logon rather than reappearing
immediately. Linux has no supervisor — launch it with `./bin/model-router-tray`
— and the tray commands say so instead of reporting a silent success.

On Windows the same `Codex Router Tray` task is also managed directly through
the checkout wrapper, which owns the Control Center build and registration.
`companion` remains a deprecated alias of `tray` for one migration release:

```powershell
.\codex-router.ps1 tray status          # JSON: installed, loaded, supported, state
.\codex-router.ps1 tray start          # ask Task Scheduler to run it now
.\codex-router.ps1 tray stop
.\codex-router.ps1 tray restart
.\codex-router.ps1 tray uninstall      # remove the scheduled task
.\codex-router.ps1 tray rebuild        # stop, rebuild, then re-register
.\codex-router.ps1 tray repair         # fix task permissions, then reinstall the companion
```

`tray repair` fixes a `Codex Router Tray` task the current user cannot
otherwise modify — the catch-22 a router reinstall fails with when an earlier
elevated install left the task readable but not writable. It validates the
task's principal, its logon type, and that its action is a genuine companion
(recognized by shape, so repairing from a dev checkout whose task points at
`%LOCALAPPDATA%\codex-router` is allowed), then performs a UAC-elevated DACL
repair and finishes by rebuilding or reinstalling the companion. If you only
meant to fix permissions, expect that reinstall to follow. When Task Scheduler
cannot answer at all, `tray status` prints a JSON document with `"state":
"unknown"` rather than failing the command.

Windows 11 hides new tray icons in the `^` overflow next to the clock. Drag the
icon onto the taskbar to pin it; an unpinned icon is the most common reason the
companion looks like it never started.

The app discovers the router checkout from `MODEL_ROUTER_SOURCE_ROOT`, a saved
bundle pointer, the source tree during development, or the standard install
location (`%LOCALAPPDATA%\codex-router` on Windows and
`~/.local/share/codex-router` on Linux). It displays a useful offline state when
the checkout or router service is unavailable.

# Credential safety

The webview cannot start arbitrary shell commands. Its backend exposes only a
small, validated command set for known provider IDs. API keys cross the local
Electron preload/IPC boundary once and are written to the router control process through
standard input; they are never placed in process arguments, logs, settings, or
the UI after submission. If applying a provider change fails, the previous
provider selection is restored.

Windows, Linux, and the combined macOS bundle build in CI on every change. UI
data shaping, IPC validation, packaging, and lifecycle behavior have focused
tests in addition to the repository-wide checks.
