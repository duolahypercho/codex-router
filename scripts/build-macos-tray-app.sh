#!/bin/sh
set -eu

repo_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
tray_dir="$repo_dir/apps/macos/ModelRouterTray"
widget_dir="$repo_dir/apps/macos/RouterUsageWidget"
control_center_dir="$repo_dir/apps/control-center"
# The macOS 27 SDK exposes SwiftUI state through platform macro plug-ins that
# the standalone Command Line Tools do not ship. The bundled widget has always
# needed xcodebuild as well. Honor an explicit or selected full Xcode first,
# then use a standard Xcode installation for this child build only; never
# change the machine-wide xcode-select setting as an installer side effect.
developer_dir=$(node "$repo_dir/src/macos-developer-tools.mjs")
export DEVELOPER_DIR="$developer_dir"
signing_identity=${MODEL_ROUTER_CODESIGN_IDENTITY:--}
if [ "$signing_identity" = "-" ]; then
  widget_storage_mode=local
  widget_entitlements="$widget_dir/RouterUsageWidget/RouterUsageWidget.local.entitlements"
else
  widget_storage_mode=app-group
  widget_entitlements="$widget_dir/RouterUsageWidget/RouterUsageWidget.entitlements"
fi
# One companion per user, not one per checkout. A default inside the
# repository built a separate bundle for every clone and left launchd pointing
# at whichever one installed last; ~/Applications is also a LaunchServices
# location, so the app resolves by name and can be found and quit normally.
# src/tray-install.mjs trayBundleDir() holds the same path for the Node side.
bundle_dir=${1:-"$HOME/Applications/Codex Router.app"}
configuration=${MODEL_ROUTER_TRAY_CONFIGURATION:-release}
app_version=$(node -e '
  const fs = require("node:fs");
  const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (typeof doc.version !== "string" || !doc.version) process.exit(2);
  process.stdout.write(doc.version);
' "$control_center_dir/package.json")
control_protocol=$(node -e '
  const fs = require("node:fs");
  const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (!Number.isInteger(doc.controlProtocol) || doc.controlProtocol < 1) process.exit(2);
  process.stdout.write(String(doc.controlProtocol));
' "$control_center_dir/package.json")
short_version=${app_version%%-*}
bundle_version=${MODEL_ROUTER_BUILD_NUMBER:-${GITHUB_RUN_NUMBER:-1}}
node -e '
  const [shortVersion, buildVersion] = process.argv.slice(1);
  if (!/^\d+(?:\.\d+){0,2}$/.test(shortVersion)) process.exit(2);
  if (!/^\d+(?:\.\d+){0,2}$/.test(buildVersion)) process.exit(3);
' "$short_version" "$bundle_version" || {
  printf 'Invalid macOS bundle versions: short=%s build=%s\n' "$short_version" "$bundle_version" >&2
  exit 1
}

# Callers capture this script's stdout as the bundle path, so compiler
# progress must not land there.
if [ "${MODEL_ROUTER_TRAY_UNIVERSAL:-0}" = "1" ]; then
  # The generic CI artifact must launch on every supported Mac. SwiftPM and
  # electron-builder both need the same two-architecture request or the outer
  # app can launch while its embedded Control Center cannot (or vice versa).
  swift build -c "$configuration" --package-path "$tray_dir" \
    --arch arm64 --arch x86_64 1>&2
  binary_dir=$(swift build -c "$configuration" --package-path "$tray_dir" \
    --arch arm64 --arch x86_64 --show-bin-path)
  electron_arch=universal
  widget_arch=universal
else
  swift build -c "$configuration" --package-path "$tray_dir" 1>&2
  binary_dir=$(swift build -c "$configuration" --package-path "$tray_dir" --show-bin-path)
  case $(uname -m) in
    arm64) electron_arch=arm64; widget_arch=arm64 ;;
    x86_64) electron_arch=x64; widget_arch=x86_64 ;;
    *) printf 'Unsupported macOS architecture: %s\n' "$(uname -m)" >&2; exit 1 ;;
  esac
fi
(
  cd "$control_center_dir"
  npm ci 1>&2
  npm run check 1>&2
  npm test 1>&2
  npm run build 1>&2
)
electron_output=$(mktemp -d "${TMPDIR:-/tmp}/model-router-control-center.XXXXXX")
cleanup_electron_output() {
  rm -rf "$electron_output"
}
trap cleanup_electron_output EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
(
  cd "$control_center_dir"
  CSC_IDENTITY_AUTO_DISCOVERY=false ./node_modules/.bin/electron-builder \
    --mac dir \
    "--$electron_arch" \
    --publish never \
    "--config.directories.output=$electron_output" 1>&2
)
control_center_bundle=$(find "$electron_output" -maxdepth 3 -type d -name 'Codex Router.app' -print -quit)
if [ -z "$control_center_bundle" ] || [ ! -d "$control_center_bundle" ]; then
  printf 'The packaged Electron Control Center was not produced.\n' >&2
  exit 1
fi
mkdir -p "$bundle_dir/Contents/MacOS" "$bundle_dir/Contents/Resources"
cp "$binary_dir/ModelRouterTray" "$bundle_dir/Contents/MacOS/ModelRouterTray"
cp "$tray_dir/Resources/Info.plist" "$bundle_dir/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $short_version" \
  "$bundle_dir/Contents/Info.plist"
if ! /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $bundle_version" \
  "$bundle_dir/Contents/Info.plist" 2>/dev/null; then
  /usr/libexec/PlistBuddy -c "Add :CFBundleVersion string $bundle_version" \
    "$bundle_dir/Contents/Info.plist"
fi
/usr/libexec/PlistBuddy -c "Add :ModelRouterControlVersion string $app_version" \
  "$bundle_dir/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Add :ModelRouterControlProtocol integer $control_protocol" \
  "$bundle_dir/Contents/Info.plist"
# The icon is committed as a built .icns, not rasterized here: scripts/build-app-icon.sh
# needs sips and iconutil, and a tray build must not start depending on them.
# Without this file the bundle falls back to the generic macOS app icon, which
# is what made Codex Router unfindable in Finder, Launchpad, and Spotlight.
if [ -f "$tray_dir/Resources/AppIcon.icns" ]; then
  cp "$tray_dir/Resources/AppIcon.icns" "$bundle_dir/Contents/Resources/AppIcon.icns"
else
  printf 'codex-router: AppIcon.icns is missing; run scripts/build-app-icon.sh.\n' >&2
fi
if [ -d "$binary_dir/ModelRouterTray_ModelRouterTray.bundle" ]; then
  rm -rf "$bundle_dir/Contents/Resources/ModelRouterTray_ModelRouterTray.bundle" \
    "$bundle_dir/ModelRouterTray_ModelRouterTray.bundle"
  cp -R "$binary_dir/ModelRouterTray_ModelRouterTray.bundle" "$bundle_dir/Contents/Resources/"
fi
rm -rf "$bundle_dir/Contents/PlugIns"
mkdir -p "$bundle_dir/Contents/PlugIns"
MODEL_ROUTER_WIDGET_ARCH="$widget_arch" \
  "$repo_dir/scripts/build-macos-widget.sh" \
  "$bundle_dir/Contents/PlugIns/RouterUsageWidget.appex" \
  "$short_version" "$bundle_version" 1>&2
rm -rf "$bundle_dir/Contents/Resources/Control Center.app"
cp -R "$control_center_bundle" "$bundle_dir/Contents/Resources/Control Center.app"
printf '%s\n' "$repo_dir" > "$bundle_dir/Contents/Resources/Control Center.app/Contents/Resources/router-root"
# Seal the checkout relationship into Info.plist itself. An external symlink is
# invalid inside a strict macOS code-signed bundle; a loose text resource would
# be executable-path input. This value is covered by the final signature, so
# changing the selected checkout also invalidates verification.
/usr/libexec/PlistBuddy -c "Add :ModelRouterSourceRoot string $repo_dir" \
  "$bundle_dir/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :ModelRouterWidgetStorageMode $widget_storage_mode" \
  "$bundle_dir/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :ModelRouterWidgetStorageMode $widget_storage_mode" \
  "$bundle_dir/Contents/PlugIns/RouterUsageWidget.appex/Contents/Info.plist"

# Every bundle mutation is complete before signing starts. Nested code must be
# signed before the containing app. Ad-hoc builds use one narrow, read-only
# exception for the local-source snapshot; provisioned builds use only the App
# Group contract.
/usr/bin/codesign --force --deep --sign "$signing_identity" \
  "$bundle_dir/Contents/Resources/Control Center.app"
/usr/bin/codesign --force --sign "$signing_identity" \
  --entitlements "$widget_entitlements" \
  "$bundle_dir/Contents/PlugIns/RouterUsageWidget.appex"
# The copied SwiftPM executable carries an ad-hoc signature. Sign only after
# every executable, resource, and link is in its final location; mutating the
# live signed bundle is what produced taskgated "Invalid Page" terminations.
if [ "$signing_identity" = "-" ]; then
  /usr/bin/codesign --force --sign "$signing_identity" "$bundle_dir"
else
  /usr/bin/codesign --force --sign "$signing_identity" \
    --entitlements "$tray_dir/Resources/ModelRouterTray.entitlements" \
    "$bundle_dir"
fi
/usr/bin/codesign --verify --deep --strict "$bundle_dir"

trap - EXIT HUP INT TERM
cleanup_electron_output

printf '%s\n' "$bundle_dir"
