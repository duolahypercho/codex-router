#!/bin/sh
set -eu

# The companion without a Rust toolchain. build-desktop-tray.sh compiles the
# Tauri app and needs cargo; this one installs a runtime npm already knows how
# to fetch, so the only prerequisites are the ones the router install itself
# required.

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
app_dir="$repo_dir/apps/electron"

for command_name in node npm; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf '%s is required to build the desktop companion.\n' "$command_name" >&2
    exit 1
  fi
done

npm ci --prefix "$app_dir" >&2

binary="$app_dir/node_modules/electron/dist/electron"

# npm 11 refuses install scripts unless they are approved, and electron
# downloads its runtime from one. The install then exits 0 having fetched the
# package but not the binary it exists to deliver, and the failure only appears
# much later as an app that will not start. Run the download directly rather
# than asking every user to approve scripts.
if [ ! -x "$binary" ]; then
  printf "npm did not run electron's install script; fetching the runtime directly.\n" >&2
  (cd "$app_dir/node_modules/electron" && node install.js >&2)
fi

# Never report success on a missing binary: that is the whole failure this
# script exists to make impossible.
if [ ! -x "$binary" ]; then
  printf 'The Electron runtime is still missing at %s; the companion cannot start.\n' "$binary" >&2
  exit 1
fi

npm run check --prefix "$app_dir" >&2

printf '%s\n' "$binary"
