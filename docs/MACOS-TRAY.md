# macOS native tray and Control Center

`Codex Router.app` is one installed macOS app with two coordinated surfaces.
Its Swift host owns the native menu-bar item and optional Dynamic-Island-style
overlay; its embedded Electron app supplies the full Control Center window.
The top-center island follows the provider handling the latest request, reveals
live usage on hover, expands on click, and surfaces concurrent model requests
when more than one agent is active. The native tray shows Codex service state,
an all-provider usage overview, active-provider detail, and provider setup
shared with the existing command-line control plane.

The tray focuses on Codex and does not disable, uninstall, or change the
existing router configuration.

## Desktop widget

On macOS 14 or newer, add **Codex Router Usage** or **Codex Router Reset** from
the system widget gallery. The Usage widget shows today's tokens and a true
seven-day cumulative line graph; Medium also shows up to two quota windows.
The Reset widget gives the next reset a large countdown and keeps the relevant
quota windows beside it. Both use the same text-only **Codex Router** header.

Clicking Usage opens that source on the Control Center Usage page. Clicking
Reset opens the same page and focuses the selected account's allowance and
reset details, whether Control Center is already running or starts on demand.

Codex is the default usage source. To show another connected account,
Control-click a widget, choose **Edit Widget**, and select its **Usage Source**.
The picker is populated from the router's current connected providers, so it
does not offer an account the host cannot measure.

The native host publishes a small, size-bounded, secret-free JSON snapshot
after normal status and usage polls. The WidgetKit extension only reads that
snapshot: it does not run router commands and never receives provider
credentials, API keys, prompts, model output, or caller capabilities. A stale
snapshot is called out after 45 minutes instead of presenting old data as live.

Local source builds use ad-hoc signing. Their signed storage mode writes one
private file at
`~/Library/Application Support/Codex Router Widget/usage-widget.json` and the
extension receives only the matching home-relative, read-only temporary
filesystem exception. That exception is local-source-only: it is not present in
production entitlements, and neither process reads or writes the extension's
`~/Library/Containers` directory. Set `MODEL_ROUTER_CODESIGN_IDENTITY` to a
non-ad-hoc signing identity for a provisioned build; that selects the production
storage mode, where both sides use only the `group.io.github.codex-router` App
Group. A redistributable build still needs the host app and extension signed by
the same Apple team with that App Group provisioned for both bundle identifiers.

## Opening it like an app

`./bin/model-router-tray` installs **Codex Router.app** into `~/Applications`,
where Finder, Spotlight, and Launchpad can all find it by name and icon. Every
desktop icon is built from
`apps/macos/ModelRouterTray/Resources/AppIcon.svg`; edit the SVG and run
`scripts/build-app-icon.sh` to regenerate the committed native `.icns` plus
the Control Center PNG and ICO assets used by the sidebar, Dock, Windows, and
Linux. That script needs `sips` and `iconutil`, which is why the generated
assets are committed rather than rasterized during a normal tray build.

The Swift host stays `LSUIElement`, so it does not add a Dock icon. A person
opening `Codex Router.app` gets the embedded Control Center as a normal window;
that process supplies the product's Dock and Command-Tab entry while Control
Center is running, including after the window is closed or you switch away.
Closing the window hides it rather than quitting, so Cmd+Tab and the Dock can
bring it back. Opening the app also reveals the native tray surfaces for 20
seconds if **With Codex** would otherwise hide them. The menu-bar host keeps
running either way; choose **Control Center** from the panel to reopen if the
Dock tile is not showing yet. The temporary reveal also starts the router and
pulses the status dot, then follow mode resumes on its own.

launchd passes `--supervised` when it starts the native host at login. That
starts the menu-bar host without opening the Control Center window or forcing
hidden surfaces visible, so follow mode is not overridden every morning.

## launchd supervision and login startup

`./bin/model-router-tray` installs a per-user LaunchAgent for the native host.
It starts the app at login and restarts it after an abnormal exit, while a clean
**Quit** remains a quit until the next login or manual launch. The app does not
register a second startup mechanism; there is one startup owner and therefore
only one tray host.

The router background service is a separate launchd agent. Reinstalling or
rebuilding the desktop app updates its own agent without merging the two
services or creating another copy of the app.

The Settings tab's **Models** section has two accordions. **Subagent models**
controls which registry-proven v2 models remain available as Codex subagent
overrides; **Model picker** hides or shows individual models without changing
their provider connection. Restart Codex after changing either group so its
model picker reloads the merged catalog.

## Show tray only while Codex runs

The Settings tab's **Show tray** control chooses when the tray surfaces are
visible. **Always** (the default) keeps the menu bar icon present like any
menu bar app. **With Codex** ties every surface — menu bar icon, Dynamic
Island, and desktop panel — to Codex being open, whether that is the Codex or
ChatGPT desktop app (`com.openai.codex`, `com.openai.chat`) or the `codex` CLI:
the tray appears when the first one starts and disappears when the last one
quits. The CLI needs a separate check. It is a terminal process with no bundle
identifier, so `NSRunningApplication` cannot see it; a bundle-only check
reported "Codex is not running" for every terminal session, which hid the menu
bar item immediately and then stopped the router 30 seconds into the work it
was needed for. The watcher therefore also scans the process table (via
`sysctl`, not by spawning `pgrep`, since this runs every five seconds).
The native host itself stays resident as a lightweight watcher; quitting on app
exit would leave nothing around to notice the next launch. Combined with
launchd supervision, this makes the tray automatic: it waits invisibly after a
reboot and shows up exactly while Codex is open. Opening `Codex Router.app`
temporarily reveals the native surfaces and opens the Control Center even while
Codex is closed, so the setting remains reachable. In **With Codex** mode the
router endpoint starts as soon as Codex or ChatGPT appears and stops only after
both remain absent for 30 seconds and active requests have drained. The watcher
also polls the process list every five seconds so a missed workspace
notification cannot strand the next launch. **Always** leaves the endpoint
under launchd continuously.

## Menu bar display mode and custom icons

The Settings tab's **Menu bar** controls allow configuring the menu bar layout and icon to reduce clutter or match your desktop aesthetics:

- **Menu bar mode**:
  - **Standard**: Displays the icon/activity dot alongside the active provider or model name and token usage text.
  - **Icon only** (default): Displays the compact Router mark without provider/model text, taking minimal horizontal space in the macOS menu bar.
- **Show model name**: When using Standard mode, this toggle controls whether the active model/provider short name is rendered.
- **Menu bar icon**:
  - **Router mark** (default when no explicit preference is stored): Renders the smooth monochrome routing glyph from the bundled SVG and follows the menu bar's light or dark appearance. Active states add a status node to the upper route in the same template image.
  - **Activity dot**: Renders a clean status circle tinted by router activity state (idle, thinking, starting, error).
  - **Provider icon**: Renders the logo of the provider handling the request, using the same `ProviderIcon` map as the rest of the tray.
  - **Preset icon**: Lets you choose from built-in SF Symbols (`cpu`, `brain`, `sparkles`, `terminal`, `bolt.horizontal.circle`, `network`).
  - **Custom image**: Copies a PNG, JPEG, SVG, or ICNS file into Application Support via "Choose Image…". If that copy later disappears, Settings shows that the image is missing instead of keeping a stale filename.

These preferences can also be configured via `defaults`:
```bash
# Set icon-only mode
defaults write io.github.codex-router.tray ModelRouterTray.menuBarDisplayMode iconOnly

# Toggle model name visibility
defaults write io.github.codex-router.tray ModelRouterTray.menuBarShowModelName -bool false

# Set icon style (router, provider, indicator, preset, custom)
defaults write io.github.codex-router.tray ModelRouterTray.menuBarIconStyle router
defaults write io.github.codex-router.tray ModelRouterTray.menuBarPresetIcon sparkles
```

## Provider usage

The tray's **All usage** grid shows only connected accounts: ChatGPT when native
account usage is available, and external providers with a configured OAuth
session or API key. Enabling a provider or retaining historical local traffic
does not create a card without credentials. Each quota window gets its own card
with a short limit label and a single reset line. Official account balance is
shown when available; otherwise a connected account falls back to clearly
labeled seven-day traffic measured by this router. Cards can be clicked to
inspect that provider.
ChatGPT is the initial detail view only when native ChatGPT usage is available;
otherwise the tray starts with an existing external provider. The detailed
view and the Island automatically return to the provider handling the next
Codex request. Hover the Island for a quick view or click it for expanded
account usage. During activity, the compact Island shows the provider's
published mark and the Codex session title instead of repeating the provider
name. Additional
concurrent requests appear as a muted, unframed `+N`; hover lists every live
routed session with its status and elapsed time while retaining the seven-day
usage graph and today's usage metrics. When the selected provider reports a
weekly quota, its percentage left stays pinned to the compact Island's trailing
edge during both idle and active sessions.

- ChatGPT shows the subscription limit and daily buckets reported by the
  installed Codex app-server; the tray never reads or copies the ChatGPT
  credential file.
- External OAuth and API providers have separate account meters and local
  traffic graphs. The Island shows today's token total and a fixed seven-day
  daily line graph beside the provider-reported quota percentage left. Kimi
  Code OAuth reads weekly and five-hour quota from Kimi's
  usage API with the existing CLI session. Grok OAuth reads weekly or monthly
  credit usage from the official Grok CLI chat-proxy billing endpoint with the
  existing `~/.grok/auth.json` session. Near expiry, or after one rejected
  request, the router asks the installed official Grok CLI to refresh its own
  OAuth session and retries once. DeepSeek and Kimi Platform API show balance
  from their official API-key endpoints. Anthropic and xAI API keys use the
  clearly labeled local-router traffic fallback because those account balances
  are not exposed here. The app does not silently import browser cookies.
- Local graphs cover only traffic sent through this router on this Mac and are
  labeled that way. A local graph is never presented as provider-wide billing
  or remaining subscription quota.
- Daily token charts in the tray can show 7, 30, or 90 days. Seven-day charts
  label every weekday; longer ranges use spaced date ticks while retaining one
  point per day. The Island uses a fixed seven-day line graph so hover remains
  quick and the longer ranges stay in the tray. Hover any mark for its date and
  displayed token count. Use the `Full`/`M` selector beside the range picker to
  switch between grouped full numbers and millions. When the provider reports a
  quota reset, its local reset
  date and time appear beside the chart title. Usage refreshes every 30 seconds,
  and the detailed view switches when a new request uses a different provider.
  A provider selected manually remains focused for the rest of the current
  request so its usage can be inspected without activity polling overriding the
  selection; automatic following resumes with the next request.
- The Island status mark uses Thinking Orbs **Shaping** while idle,
  **Thinking** while generating, and **Solving** for errors. Starting retains
  its amber status dot, and the Error label remains explicit. The
  daily line draws in once when opened or refreshed. Reduce Motion disables
  decorative movement. The Island is off on a new install and is enabled from
  **Dynamic Island** in the tray Settings (`Off` / `Notch` / `Desktop`). An
  install that already had it on keeps it. The menu-bar panel is the primary
  surface and stays available whichever mode is selected.
- When multiple Codex model requests run at the same time, the Island shows the
  first provider mark and session title plus `+N` for the remaining requests.
  Hover and expand list each live request with its provider mark, session
  title, Thinking status, and elapsed time. Long titles pan to the end and
  bounce back; Reduce Motion leaves them clipped. Session titles are resolved
  from Codex's local session index and are not copied into usage history. The
  focused usage view still follows the newest active request.
- Local routed-model events record timestamp, model, provider, HTTP status,
  duration, and the input/output/total token counts reported by the provider.
  Prompts, responses, and API keys are never stored. Provider metering begins
  after installing this version; older events are not guessed or reassigned.

The overlay interaction is inspired by
[CodexIsland](https://github.com/ericjypark/codex-island): compact information
at rest, richer usage detail on hover, and a full panel on click. On a notched
Mac it sits flush with the screen edge; on other displays it behaves as a
top-center floating island. The menu-bar item remains available as a fallback
and configuration surface.

The provider-meter hierarchy follows the privacy-first pattern demonstrated by
[CodexBar](https://github.com/steipete/CodexBar): show quota, balance, or spend
only when that provider exposes an appropriate source, and keep local traffic
as a distinct fallback.

The tray uses the native macOS popover material and follows the current system
appearance. It intentionally uses standard system typography, controls, and
separators rather than applying a second opaque dashboard skin inside the
popover.

Run it from a stable checkout on macOS:

```sh
./bin/model-router-tray
```

The command builds and verifies a staging bundle, atomically installs it as
`~/Applications/Codex Router.app`, and registers the native host with launchd.
The installed bundle records the checkout path used at build time, so rebuild
it after moving the repository.

`bin/model-router-tray` lets active Control Center mutations drain, replaces the
already-running bundle, and restarts its launchd agent. `codex update` rebuilds
and relaunches the installed app from the updated checkout, so the companion
stays current without creating a second app copy.

Provider changes apply automatically. Enabling, disabling, signing in, or
adding an API key updates Codex immediately; the provider row shows progress
while the router configuration and service are refreshed. If applying fails,
the tray restores the previous provider selection and shows the error.

The **Update & Verify** maintenance button applies the checked-out `main`
revision to the per-user Codex installation, then runs the Codex doctor. It
shows progress while both commands run and reports whether routed model agents
and the rest of the installation passed verification. Restart Codex afterward
to load updated models and custom agents. The command targets the checkout
recorded as the installation owner, so a tray bundle left over from an older
checkout cannot refresh the wrong router instead of the installed one.

The **Use without OpenAI login** switch changes new Codex sessions to the
managed custom router provider. At least one external provider must be connected
and enabled. After applying the change, the tray gracefully quits and reopens
the registered Codex desktop app so the new mode takes effect. It never
force-quits Codex; if the app does not quit or reopen, the mode remains changed
and the tray asks you to restart Codex manually. Turning the switch off restores
the previous root model-provider setting; neither direction reads, changes, or
deletes ChatGPT credentials. The mode keeps the current external model when
possible, otherwise selects the first model from a connected, enabled provider,
and restores the previous model when switched off.

## Adding providers and models

The Providers section is also the onboarding surface for every model source in
the registry. OAuth providers show **Install** when their official CLI is
missing and **Sign In** when the CLI has no usable session. API providers show
**Add Key** and accept the key in a native secure field.

- Kimi OAuth installs the official `@moonshot-ai/kimi-code` CLI.
- Grok OAuth installs the official `@xai-official/grok` CLI.
- API keys are sent to the control process over standard input, written to the
  router's protected credential file, and never placed in process arguments or
  command output.
- Completing sign-in or adding a key automatically enables that provider and
  exposes its models to new Codex tasks.
