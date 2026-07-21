# macOS tray app

Model Router Tray is a native macOS menu-bar control panel for the local Codex
router. It shows Codex service state, models exposed by the router, and the
provider selections shared with the existing command-line control plane.

The tray currently focuses on Codex. Claude and Cursor do not appear in this
interface, and the app does not disable, uninstall, or change their existing
router configuration.

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
