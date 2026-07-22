#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
desktop_dir="$repo_dir/apps/desktop"
binary_only=false

if [ "${1:-}" = "--binary-only" ]; then
  binary_only=true
elif [ "$#" -gt 0 ]; then
  printf 'Usage: %s [--binary-only]\n' "$0" >&2
  exit 2
fi

for command_name in node npm cargo; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'codex-router: %s is required to build the desktop tray app.\n' "$command_name" >&2
    exit 1
  fi
done

npm ci --prefix "$desktop_dir"
npm run check --prefix "$desktop_dir"

if [ "$binary_only" = true ]; then
  npm run build:binary --prefix "$desktop_dir"
else
  npm run build --prefix "$desktop_dir"
fi

printf '%s\n' "$desktop_dir/src-tauri/target/release/codex-router-desktop"
