#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
tray_dir="$repo_dir/apps/macos/ModelRouterTray"
bundle_dir=${1:-"$repo_dir/dist/Model Router.app"}
configuration=${MODEL_ROUTER_TRAY_CONFIGURATION:-release}
binary_dir="$tray_dir/.build/$configuration"

swift build -c "$configuration" --package-path "$tray_dir"
mkdir -p "$bundle_dir/Contents/MacOS" "$bundle_dir/Contents/Resources"
cp "$binary_dir/ModelRouterTray" "$bundle_dir/Contents/MacOS/ModelRouterTray"
cp "$tray_dir/Resources/Info.plist" "$bundle_dir/Contents/Info.plist"
printf '%s\n' "$repo_dir" > "$bundle_dir/Contents/Resources/router-root"

printf '%s\n' "$bundle_dir"
