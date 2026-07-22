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

The status mark is a still dotted Thinking Orbs-style orb while idle and
animates while a model is generating. Starting and error states retain their
colored status dots. A low-contrast edge signal appears only while generating.
The app honors the system's reduced-motion preference.

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
