#!/bin/sh
set -eu

source_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
formula_path="$source_root/Formula/codex-router.rb"
tap_name="local/codex-router-readiness"
install_formula=false
installed_by_check=false

case "${1:-}" in
  "") ;;
  --install) install_formula=true ;;
  *)
    echo "Usage: check-core-readiness.sh [--install]" >&2
    exit 2
    ;;
esac

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew is required to check the formula." >&2
  exit 1
fi

if brew tap | grep -qx "$tap_name"; then
  echo "Temporary tap $tap_name already exists; remove it before rerunning." >&2
  exit 1
fi

cleanup() {
  if [ "$installed_by_check" = true ]; then
    brew uninstall "$tap_name/codex-router" >/dev/null 2>&1 || true
  fi
  brew untap "$tap_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

brew tap-new --no-git "$tap_name" >/dev/null
tap_root=$(brew --repository "$tap_name")
cp "$formula_path" "$tap_root/Formula/codex-router.rb"

brew style "$tap_root/Formula/codex-router.rb"
brew audit --new --formula "$tap_name/codex-router"

if [ "$install_formula" = true ]; then
  if brew list --formula codex-router >/dev/null 2>&1; then
    echo "codex-router is already installed; refusing to replace the user's formula." >&2
    exit 1
  fi
  brew install --build-from-source "$tap_name/codex-router"
  installed_by_check=true
  brew test "$tap_name/codex-router"
  brew uninstall "$tap_name/codex-router"
  installed_by_check=false
fi

echo "Homebrew core readiness checks passed."
