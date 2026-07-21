# macOS tray app

Model Router Tray is a native macOS Dynamic-Island-style overlay plus menu-bar
control panel for the local Codex router. The top-center island follows the
provider handling the latest request, reveals live usage on hover, and expands
on click. The tray shows Codex service state, an all-provider usage overview,
active-provider detail, and provider setup shared with the existing
command-line control plane.

The tray currently focuses on Codex. Claude and Cursor do not appear in this
interface, and the app does not disable, uninstall, or change their existing
router configuration.

## Provider usage

The tray's **All usage** grid shows ChatGPT plus every configured, enabled, or
previously used external provider at once. Each card shows official account
quota or balance when available; otherwise it shows clearly labeled seven-day
traffic measured by this router. The detailed **Current usage** view and the
Island automatically follow the provider handling the latest Codex request.
Hover the Island for a quick view or click it for expanded account usage.

- ChatGPT shows the subscription limit and daily buckets reported by the
  installed Codex app-server; the tray never reads or copies the ChatGPT
  credential file.
- External OAuth and API providers have separate account meters and local
  traffic graphs. Kimi Code OAuth reads weekly and five-hour quota from Kimi's
  usage API with the existing CLI session. Grok OAuth reads weekly or monthly
  credit usage from the official Grok CLI chat-proxy billing endpoint with the
  existing `~/.grok/auth.json` session. DeepSeek and Kimi Platform API show
  balance from their official API-key endpoints. The app does not silently
  import browser cookies.
- Local graphs cover only traffic sent through this router on this Mac and are
  labeled that way. A local graph is never presented as provider-wide billing
  or remaining subscription quota.
- Daily token bars can show 7, 30, or 90 days. Seven-day charts label every
  weekday; longer ranges use spaced date ticks while retaining one bar per day.
  Hover any bar for its full date and exact token count. Usage refreshes every
  30 seconds, and the detailed view switches when a request uses a different
  provider.
- The Island uses green for idle, amber while generating, and red after an
  error. It is shown by default and can be toggled from the tray.
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

The app builds a local `dist/Model Router.app` bundle and opens it. The bundle
records the checkout path used at build time, so rebuild it after moving the
repository.

Provider changes apply automatically. Enabling, disabling, signing in, or
adding an API key updates Codex immediately; the provider row shows progress
while the router configuration and service are refreshed. If applying fails,
the tray restores the previous provider selection and shows the error.

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
