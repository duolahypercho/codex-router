# Codex Router

The control center is an Electron interface over the existing Codex Router
control plane. It does not duplicate router state, provider
credentials, or service logic in the renderer.

## Sections

- Usage: ChatGPT plan windows, provider quota or balance, and all-retained
  local-router token and request accounting, with daily, provider, and model
  charts. OpenAI account-reported history is shown separately and is never
  added to the router total.
- Status: running chats and agents, live requests, model speed, cached-context
  savings, and upcoming quota resets.
- Models: one provider-first directory showing every canonical provider,
  combining enablement, API credential entry, CLI sign-in, plan notes, account
  metrics, backend-advertised catalog sources, picker visibility, and native v2
  subagent controls. Live catalogs are cached for review and never bulk-added
  without an explicit model selection.
- Local: Ollama runtime controls, installable and installed models, downloads,
  enablement, removal, benchmarks, and local image readers.
- Harness: one row each for Cursor, Claude Code, Gemini CLI, DeepSeek Harness, and Codex. Every row
  reports client detection, router publication, routed models, and indexed
  sessions, then exposes fixed setup, launch, terminal, session, and
  documentation actions. Setup publishes the same shared router plane into the
  selected client instead of creating another credential or service store.
  Claude Code publishes routed models through `claude-router`. Claude Code,
  Cursor Agent, and Gemini CLI show optional official-client agent availability
  inside the matching row, separate from the routed-model count.
- Context Manager: one metadata-only session index across Cursor, DeepSeek
  Harness, and Codex, with search, client filters, context use, and resume
  actions in the session's owning client.
- Settings: signed routing, presence, safe service start/status,
  tray, language,
  appearance, Token maxxing, vision, and read-only maintenance
  guidance. Updates and repairs remain interactive-terminal workflows.

The Control Center and tray ship as one visible application on every platform.
On macOS, `Codex Router.app` keeps the existing Swift-native menu-bar item,
notch overlay, and desktop widget, and embeds this Electron window inside the
same signed bundle. On Windows and Linux, this Electron process owns the
operating system tray directly. Closing the window leaves a proven tray owner
running; opening the app or clicking the tray restores the existing window.
When Linux cannot positively verify a registered StatusNotifier host, tray-only
startup keeps the window visible and closing that fallback exits the process.

## Platform support

The Electron window and the router control surface are designed for macOS,
Windows, and Linux. They use the same installed router state and fixed
`control.mjs` commands on every platform; provider selection, API credentials,
models, local runtime controls, health, usage, and settings are the cross-platform
contract for this beta.

The macOS host sets `CODEX_ROUTER_EMBEDDED_CONTROL_CENTER=1` only for its
bundled Electron child. That suppresses a duplicate Electron tray. The child
shows the shared product icon in the Dock and Command-Tab while its window is
open, then hides that entry when the window closes; standalone development and
Windows/Linux packages keep their own tray.

Service stop and restart remain intentional terminal operations during the
beta because either can interrupt active turns or downloads. The Control Center
can inspect service health and start an offline service without exposing those
destructive shortcuts.

Login-free mode is also terminal-only in this beta. Its catalog and Codex
transport change must become one rollback-safe backend transaction before the
desktop app exposes it as a one-click mutation.

Install the Control Center and router from the same beta build. The app keeps
read-only status and documentation available when it detects version skew, but
refuses router mutations until the installed checkout exposes the matching
control protocol. This prevents a newer UI from sending changed command
arguments to an older installation.

Convenience actions that must open another native application are deliberately
narrower. This beta opens Cursor.app, Codex.app, the DeepSeek Harness web UI,
provider OAuth CLIs, and Cursor/DeepSeek/Codex CLI sessions from macOS. On
Windows and Linux, run interactive CLI sign-in or resume commands in your own
terminal, then refresh the Control Center. The UI disables actions it cannot
launch instead of guessing a terminal or constructing a platform shell command.

The Harness page configures Cursor Agent locally and Cursor App through one
managed named-tunnel flow. Detection is read-only: no Cloudflare command runs
when the page loads. On macOS and Windows, **Install connector** runs the fixed
platform package-manager command in the background and shows sanitized progress
inside the Cursor row; unsupported platforms open the official installer
instructions. **Sign in** runs the fixed `cloudflared tunnel login` command in
the background while browser authorization and progress remain visible in the
app. After those explicit, one-time actions, entering a
hostname and pressing **Connect** creates the tunnel and DNS route, publishes
every selected `codex_router/...` model, and supervises the connector with the
router service. Cursor must be fully quit while its settings database is
updated. Only the separately keyed app edge at `127.0.0.1:4214` is exposed;
the main router port and caller capability remain private.

The main window keeps the operating system's native window controls. On macOS,
the frameless window uses a hidden-inset title bar so native traffic lights sit
over the content while the sidebar controls and page toolbar share the same top
row as Codex; the renderer marks that row draggable without recreating the
controls. Windows and Linux hide the system title bar the same way so the
toolbar occupies that row, and the renderer draws macOS-style traffic lights
on the left. The File/Edit/View application menu is removed on Windows and
Linux. macOS keeps native traffic lights. Close, minimize, maximize, keyboard
shortcuts, and accessibility behavior still work. The routing mark from the
native app's `AppIcon.svg` is used consistently for the sidebar, Electron
window, Dock entry, application bundles, and installers.

## Development

```sh
npm ci
npm run electron:dev
```

The application resolves the router from `CODEX_ROUTER_SOURCE_ROOT` (or the
compatible `MODEL_ROUTER_SOURCE_ROOT` override), the source checkout containing
it, the install manifest, or the stable user checkout: `%LOCALAPPDATA%\codex-router`
on Windows and `${XDG_DATA_HOME:-~/.local/share}/codex-router` on macOS/Linux.
The resolved root must pass ownership and write-permission checks.

## Verification and packaging

```sh
npm run check
npm test
npm run build
npm run electron:build
```

`electron:build` can create a standalone developer artifact for the current
host. Shipped Windows and Linux artifacts are NSIS/AppImage packages. Shipped
macOS builds use `scripts/build-macos-tray-app.sh`, which embeds the packaged
Electron child inside the one outer `Codex Router.app`; CI and releases do not
publish the child separately. Beta artifacts are unsigned unless signing
credentials are configured. Public macOS distribution additionally requires
Developer ID signing/notarization, and Windows requires Authenticode.

## Security boundary

- `contextIsolation`, renderer sandboxing, and web security stay enabled.
- The preload exposes named, positional operations that construct fixed IPC
  payloads. There is no generic command, arbitrary payload, or shell bridge.
- Commands run through a trusted `src/control.mjs` with `shell: false`, bounded
  output, timeouts, and whole-process-tree termination on either bound.
- Harness actions accept fixed harness and surface identifiers. Session resume
  accepts validated session IDs and opens only known app or terminal commands.
- Agent-bridge actions accept only `anthropic`, `cursor`, or `gemini`. OAuth
  remains in the official client; the renderer receives no token, account
  identity, arbitrary executable, or argv.
- API credentials are delivered once over IPC and then through child stdin.
  They never enter argv, browser storage, or returned snapshots.
- Context Manager reads bounded metadata only: Codex rollout headers, DeepSeek
  workspace/session file names and timestamps, and selected Cursor conversation
  index columns. DeepSeek compressed transcripts and Cursor branch/message
  payloads are never read into the renderer.
- Navigation and new renderer windows are denied. External links are HTTPS-only
  and open through the operating system.
- Packaged builds ignore development-server environment variables, IPC accepts
  only the top-level bundled renderer, permissions are denied by default, and a
  single-instance lock prevents duplicate pollers and mutation races.
- Router mutations run through one main-process queue. Reads remain concurrent,
  and a failed mutation releases the queue for the next action. Normal app quit
  waits for the queue (including timeout cleanup) to drain.
