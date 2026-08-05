#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
tray_dir="$repo_dir/apps/macos/ModelRouterTray"
bundle_dir=${1:-"$repo_dir/dist/Model Router.app"}
configuration=${MODEL_ROUTER_TRAY_CONFIGURATION:-release}
binary_dir="$tray_dir/.build/$configuration"

# Keep the bundle path as the only stdout value so callers such as
# bin/model-router-tray can safely capture it. SwiftPM's build progress is
# still shown to the user on stderr.
swift build -c "$configuration" --package-path "$tray_dir" >&2
mkdir -p "$bundle_dir/Contents/MacOS" "$bundle_dir/Contents/Resources"
cp "$binary_dir/ModelRouterTray" "$bundle_dir/Contents/MacOS/ModelRouterTray"
cp "$tray_dir/Resources/Info.plist" "$bundle_dir/Contents/Info.plist"
if [ -d "$binary_dir/ModelRouterTray_ModelRouterTray.bundle" ]; then
  rm -rf "$bundle_dir/Contents/Resources/ModelRouterTray_ModelRouterTray.bundle" \
    "$bundle_dir/ModelRouterTray_ModelRouterTray.bundle"
  cp -R "$binary_dir/ModelRouterTray_ModelRouterTray.bundle" "$bundle_dir/Contents/Resources/"
  # SwiftPM's generated accessor resolves resources from Bundle.main.bundleURL
  # (the .app itself) and falls back to the build directory — it never looks in
  # Contents/Resources. Without this copy the app runs only while .build
  # survives, and dies with a fatalError once that is cleaned.
  cp -R "$binary_dir/ModelRouterTray_ModelRouterTray.bundle" "$bundle_dir/"
fi
printf '%s\n' "$repo_dir" > "$bundle_dir/Contents/Resources/router-root"

printf '%s\n' "$bundle_dir"
