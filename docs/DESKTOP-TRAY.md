# Windows and Linux tray app

The desktop tray app brings the Model Router activity surface to Windows and
Linux without changing the native macOS app. It uses the same local control
plane and health endpoint as the command line, so provider selection, quota
data, and token history stay consistent across surfaces.

## Platform behavior

| Platform | Tray panel | Top-center activity pill | Open behavior |
| --- | --- | --- | --- |
| Windows 10/11 | Yes | Yes | Left-click the tray icon or use its menu |
| Linux on X11 | Yes | Yes | Use **Open Model Router** in the tray menu |
| Linux on Wayland | Yes | Disabled | Use **Open Model Router** in the tray menu |

Wayland intentionally uses the tray-only fallback. Compositors control absolute
window placement, so claiming a stable top-center pill would create inconsistent
behavior across GNOME, KDE, Sway, and other compositors. The panel explains this
and disables its activity-pill switch; router monitoring continues normally.

## What it shows

- The compact pill shows router state, the active model, today's tokens, and
  the active provider's weekly percentage left.
- Hovering the pill expands a seven-day daily token graph. The series is
  refreshed in the background rather than recalculated on every hover.
- The panel shows the same daily graph at a larger size. Hover any point for
  its date and exact token count.
- Quota cards use one **Weekly limit** label and one reset line. A reported
  five-hour window appears as its own **5-hour limit** card.
- Provider cards are absent until that provider has a usable OAuth session or
  API key. Unconnected providers remain available only in **Connections**.
- **Connections** includes a **Use without OpenAI login** switch for new Codex
  sessions. It requires a connected, enabled external provider and restores the
  prior model-provider setting when switched off.
- **Models** has three accordions: **Subagent models** controls which
  registry-proven v2 models remain available as Codex subagent overrides, and
  **Model picker** hides or shows individual models without changing their
  provider connection.
- **Local LLMs** installs, enables, and removes Ollama models on this machine.
  Installs poll their detached download worker and show live percentage;
  removals keep a visible operation banner even when the installed row
  disappears immediately. A completed download is hidden after its model is
  removed, so stale `ready · 100%` state never implies that it is still on disk.
  If Ollama removal succeeds but the Codex catalog cannot be refreshed, the
  status remains **Model removed** with a catalog-refresh warning rather than
  reporting a false removal failure.
  Both operations expose a persistent status bar and **Cancel** action. The
  control plane serializes install/removal claims and returns an existing
  operation for repeated requests, so a double-click cannot launch duplicate
  Ollama workers.
  The Windows/Linux panel also shows the full router catalog under **Discover
  Ollama**, grouped by family with search, fit warnings, cloud-only labels, and
  a download action for every local tag. New or uncatalogued Ollama tags remain
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
  default-on/fail-closed behavior as macOS. Windows follow mode polls the
  `ChatGPT.exe`/`codex.exe` process list, hides the companion when both quit,
  and stops/restarts the router only after the same idle grace period.

The status mark uses Thinking Orbs **Shaping** while idle, **Thinking** while a
model is generating, and **Solving** for errors. Starting retains its colored
status dot, and the Error label remains explicit. A low-contrast edge signal
appears only while generating. The app honors the system's reduced-motion
preference.

## Opening it in a browser instead

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

## Building without a Rust toolchain

The Tauri companion needs Rust and Cargo. If they are not installed,
`tray install` builds the Electron shell instead, which needs only the Node the
router install already required:

```powershell
.\codex-router.ps1 companion
```

It renders `apps/desktop/ui` verbatim through the same command table, so it is
the same companion in a different host, and it registers the same logon task.
Select it explicitly with the command above; `companion status`, `start`,
`stop`, `restart`, and `uninstall` behave as the tray actions do.

On Linux, `./bin/model-router-tray` makes the same choice and falls back the
same way.

One caveat worth knowing: npm 11 refuses install scripts unless they are
approved, and electron downloads its runtime from one. `npm ci` therefore exits
0 with the package installed and no runtime, and the app then fails to start
with nothing pointing at the cause. `scripts/build-electron-companion.ps1`
fetches the runtime directly and refuses to report success without it, so use
that script rather than a bare `npm ci`.

## Downloading a prebuilt binary

Building needs a Rust toolchain and several minutes of compilation, which is a
lot to ask of someone who only wants to run the companion. You do not have to:

**From a release (recommended).** Every release attaches the companion for
Windows and Linux, checksummed in `SHA256SUMS` and covered by the same build
provenance attestation as the source archives:

| Asset | Platform |
| --- | --- |
| `codex-router-tray-<version>-windows-x64.exe` | Windows 10/11 |
| `codex-router-tray-<version>-linux-x64` | Linux |

Download it and run it. Nothing else to install.

**From a CI run (for unreleased changes).** Open the **Actions** tab, pick a
green **CI** run, and download the **codex-router-tray-Windows** artifact (or
**codex-router-tray-Linux**) from its Artifacts section. Unzip and run
`codex-router-desktop.exe`.

Windows 10 and 11 already ship the WebView2 runtime the companion needs, so
there is nothing else to install. To have it start at logon as well, point the
tray command at the downloaded binary's location, or build in place with
`./codex-router.ps1 tray`.

## Build prerequisites

- Node.js 22.19 or newer
- Rust stable and Cargo
- The normal Model Router checkout and its installed npm dependencies

On Debian or Ubuntu, install Tauri's native libraries first:

```sh
sudo apt-get update
sudo apt-get install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
```

The build scripts only report missing prerequisites; they do not install a
system runtime or package manager.

## Build and run

Linux:

```sh
./scripts/build-desktop-tray.sh
./bin/model-router-tray
```

The first command creates the native packages supported by the current Linux
host. The second builds a release binary when needed and starts it. For a faster
unbundled build, use `./scripts/build-desktop-tray.sh --binary-only`.

Windows PowerShell:

```powershell
.\scripts\build-desktop-tray.ps1
Start-Process .\apps\desktop\src-tauri\target\release\codex-router-desktop.exe
```

Pass `-BinaryOnly` for an unbundled executable. Installer artifacts are written
under `apps\desktop\src-tauri\target\release\bundle` by a full build.

## Starting at logon

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

Windows 11 hides new tray icons in the `^` overflow next to the clock. Drag the
icon onto the taskbar to pin it; an unpinned icon is the most common reason the
companion looks like it never started.

The app discovers the router checkout from `MODEL_ROUTER_SOURCE_ROOT`, a saved
bundle pointer, the source tree during development, or the standard install
location (`%LOCALAPPDATA%\codex-router` on Windows and
`~/.local/share/codex-router` on Linux). It displays a useful offline state when
the checkout or router service is unavailable.

## Credential safety

The webview cannot start arbitrary shell commands. Its backend exposes only a
small, validated command set for known provider IDs. API keys cross the local
Tauri IPC boundary once and are written to the router control process through
standard input; they are never placed in process arguments, logs, settings, or
the UI after submission. If applying a provider change fails, the previous
provider selection is restored.

Windows and Linux builds run in CI on every change. UI data shaping and chart
behavior have platform-neutral Node tests, while the Rust tests cover provider
validation, health parsing, and multi-monitor placement math.

## Troubleshooting: WebKitGTK crashes on NVIDIA

WebKitGTK's DMA-BUF renderer shares GPU buffers with the Wayland compositor
(Hyprland, GNOME, KDE, ...) through the graphics driver. With the proprietary
NVIDIA kernel driver that handoff crashed (SIGSEGV in `libnvidia-eglcore.so`
on the `SkiaGPUWorker` thread) as soon as the tray panel was shown, which also
took down the tray app.

The companion now detects the proprietary NVIDIA kernel driver via
`/proc/driver/nvidia/version` and disables only the DMA-BUF renderer
(`WEBKIT_DISABLE_DMABUF_RENDERER=1`) before the webviews are created, falling
back to `wl_shm`. Accelerated compositing stays enabled, and non-NVIDIA
systems keep the DMA-BUF fast path. Set `CODEX_ROUTER_WEBKIT_DMABUF=1` to
force the renderer back on (for example after a driver update fixes the
crash) or `CODEX_ROUTER_WEBKIT_DMABUF=0` to force it off on any system.

To reproduce the exact window-show path in a smoke test, start the binary with
`CODEX_ROUTER_SHOW_PANEL=1`; the panel opens on startup instead of waiting for
a tray interaction.
