# macOS tray app

Model Router Tray is a native macOS Dynamic-Island-style overlay plus menu-bar
control panel for the local Codex router. The top-center island shows the
pinned model at rest, reveals live usage on hover, and expands on click. The
tray shows Codex service state, models exposed by the router, and provider
selections shared with the existing command-line control plane.

The tray currently focuses on Codex. Claude and Cursor do not appear in this
interface, and the app does not disable, uninstall, or change their existing
router configuration.

## Pinned model and live usage

Select **Pin** beside any exposed model to keep its short name in the menu bar
and Island. Hover the Island for a quick view or click it for account usage.

- Native ChatGPT/Codex limits come from the installed Codex app-server. The tray
  requests only the rate-limit snapshot and daily token buckets; it never reads
  or copies the ChatGPT credential file.
- Daily token bars can show 7, 30, or 90 days. Seven-day charts label every
  weekday; longer ranges use spaced date ticks while retaining one bar per day.
  Hover any bar for its full date and exact token count. Account limits refresh
  every 30 seconds independently of the external provider pinned in the Island.
- The Island uses green for idle, amber while generating, and red after an
  error. It is shown by default and can be toggled from the tray.
- Local routed-model events still record only timestamp, model, provider, HTTP
  status, and duration. Prompts, responses, API keys, and tokens are excluded.

The overlay interaction is inspired by
[CodexIsland](https://github.com/ericjypark/codex-island): compact information
at rest, richer usage detail on hover, and a full panel on click. On a notched
Mac it sits flush with the screen edge; on other displays it behaves as a
top-center floating island. The menu-bar item remains available as a fallback
and configuration surface.

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

Provider changes are intentionally staged. Select **Apply Changes** to apply a
changed provider selection to Codex; this is the same explicit action as
`bin/control apply --targets codex`.

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
- Completing sign-in or adding a key stages that provider for Codex. Select
  **Apply Changes** to expose its models to new Codex tasks.
