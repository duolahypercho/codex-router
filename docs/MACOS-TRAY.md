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

Select the pin beside any exposed model to keep its short name and live metric
in the menu bar. Hover the pinned-model card to reveal its recent graph.

- API and OAuth models show local request activity for that specific
  routed model. The router records only the timestamp, model, provider, HTTP
  status, and duration. It never puts prompts, responses, API keys, OAuth
  tokens, or token contents in the usage event file.
- Graph history becomes richer while the router and tray continue running.

The overlay interaction is inspired by
[CodexIsland](https://github.com/ericjypark/codex-island): compact information
at rest, richer usage detail on hover, and a full panel on click. On a notched
Mac it sits flush with the screen edge; on other displays it behaves as a
top-center floating island. The menu-bar item remains available as a fallback
and configuration surface.

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
