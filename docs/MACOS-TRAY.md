# macOS tray app

Model Router Tray is a native macOS menu-bar control panel for the local Codex
router. It shows Codex service state, models exposed by the router, and the
provider selections shared with the existing command-line control plane.

The tray currently focuses on Codex. Claude and Cursor do not appear in this
interface, and the app does not disable, uninstall, or change their existing
router configuration.

## Pinned model and live usage

Select the pin beside any exposed model to keep its short name and live metric
in the menu bar. Hover the pinned-model card to reveal its recent graph.

- ChatGPT/Codex OAuth models show the account's current five-hour usage window,
  weekly percentage, plan label, and reset time. The app reads the existing
  Codex sign-in locally and sends it only to ChatGPT's usage endpoint.
- API and other OAuth models show local request activity for that specific
  routed model. The router records only the timestamp, model, provider, HTTP
  status, and duration. It never puts prompts, responses, API keys, OAuth
  tokens, or token contents in the usage event file.
- Graph history is sampled locally and becomes richer while the router and tray
  continue running. Provider APIs do not supply a historical time series.

The interaction is inspired by
[CodexIsland](https://github.com/ericjypark/codex-island): compact information
at rest, with richer usage detail on hover. This tray remains a standard
menu-bar app rather than taking over the MacBook notch.

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
