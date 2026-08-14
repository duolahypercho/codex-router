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
  the active provider's weekly percentage.
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
- **Usage** shows the active or most recently used model's observed output
  throughput when the upstream reports output tokens. The rate is calculated
  from the streamed generation phase of the latest 20 clean, successful
  replies, excluding queueing, prompt processing, retries, and historical rows
  that predate generation timing.

The status mark uses Thinking Orbs **Shaping** while idle, **Thinking** while a
model is generating, and **Solving** for errors. Starting retains its colored
status dot, and the Error label remains explicit. A low-contrast edge signal
appears only while generating. The app honors the system's reduced-motion
preference.

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
