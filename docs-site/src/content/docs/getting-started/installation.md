---
title: "Installation"
description: "Install the router, the Control Center, and the tray in one command."
---
This is the default setup: **guided provider setup + Electron Control Center +
tray/menu-bar app + macOS desktop widget**.

## macOS or Linux

Copy and paste this into Terminal:

```sh
curl -fsSL https://raw.githubusercontent.com/duolahypercho/codex-router/main/install.sh \
  | sh -s -- --target codex --guided --with-tray
```

## Windows

Copy and paste this into PowerShell:

```powershell
$installer = Join-Path $env:TEMP "codex-router-install.ps1"
Invoke-WebRequest https://raw.githubusercontent.com/duolahypercho/codex-router/main/install.ps1 -OutFile $installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -Target codex -Guided -WithTray
```

That is the complete installation. It asks which providers you want and keeps
credential entry in private local prompts.

When it finishes:

1. Fully quit and reopen Codex.
2. Start a new task and choose a routed model.
3. Open **Codex Router** to use the Control Center.

On macOS, open **Codex Router** from Spotlight or `~/Applications`; its icon
stays in the menu bar when the Control Center is closed. The desktop widget is
already included: choose **Settings → Dynamic Island → Desktop** from the
menu-bar app to show it. It is a movable Codex Router panel rather than an item
in macOS's **Edit Widgets** gallery.

macOS does not have a public `.dmg` yet; the command above builds and installs
the app locally. That build requires the full Xcode app, not only the standalone
Command Line Tools, because it contains SwiftUI macro and WidgetKit targets. The
installer honors `DEVELOPER_DIR` or the Xcode selected under **Xcode → Settings
→ Locations → Command Line Tools**. If that selection still points at the
standalone tools, it uses `/Applications/Xcode.app` or
`/Applications/Xcode-beta.app` for this build only without changing the global
selection. For an Xcode app in another location, retry the companion with:

```sh
env DEVELOPER_DIR="/path/to/Xcode.app/Contents/Developer" \
  ~/.local/share/codex-router/bin/model-router-tray
```
