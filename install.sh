#!/bin/sh
set -eu

repository_url=${CODEX_ROUTER_REPOSITORY_URL:-https://github.com/duolahypercho/codex-router.git}
default_data_dir=${XDG_DATA_HOME:-$HOME/.local/share}
install_dir=$default_data_dir/codex-router
prepare_only=false
configure_api_key=false

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Install Kimi K3 routes for the Codex App.

Options:
  --install-dir PATH  Stable checkout used by the background service
  --prepare-only      Install dependencies without changing Codex
  --api-key           Prompt securely for a Kimi Platform API key after install
  -h, --help          Show this help

When run from a checkout, this script installs that checkout. When piped from
GitHub, it clones or updates ~/.local/share/codex-router first.
EOF
}

die() {
  printf 'codex-router: %s\n' "$*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-dir)
      [ "$#" -ge 2 ] || die "--install-dir requires a path"
      install_dir=$2
      shift 2
      ;;
    --prepare-only)
      prepare_only=true
      shift
      ;;
    --api-key)
      configure_api_key=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

repo_dir=
case "$0" in
  install.sh|*/install.sh)
    candidate_dir=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || true)
    if [ -n "$candidate_dir" ] &&
      [ -x "$candidate_dir/bin/install" ] &&
      [ -f "$candidate_dir/package.json" ] &&
      grep -q '"name": "kimi-codex-router"' "$candidate_dir/package.json"; then
      repo_dir=$candidate_dir
    fi
    ;;
esac

if [ -z "$repo_dir" ]; then
  command -v git >/dev/null 2>&1 || die "git is required to download codex-router"

  if [ -d "$install_dir/.git" ]; then
    origin_url=$(git -C "$install_dir" remote get-url origin 2>/dev/null || true)
    case "$origin_url" in
      "$repository_url"|https://github.com/duolahypercho/codex-router|https://github.com/duolahypercho/codex-router.git|git@github.com:duolahypercho/codex-router.git)
        ;;
      *)
        die "$install_dir already contains a different Git repository"
        ;;
    esac

    [ -z "$(git -C "$install_dir" status --porcelain)" ] ||
      die "$install_dir has local changes; review them before updating"
    current_branch=$(git -C "$install_dir" branch --show-current)
    [ "$current_branch" = "main" ] ||
      die "$install_dir must be on its main branch before updating"
    printf 'Updating %s...\n' "$install_dir"
    git -C "$install_dir" pull --ff-only origin main
  elif [ -e "$install_dir" ]; then
    die "$install_dir already exists and is not a codex-router checkout"
  else
    mkdir -p "$(dirname -- "$install_dir")"
    printf 'Cloning codex-router to %s...\n' "$install_dir"
    git clone --depth 1 "$repository_url" "$install_dir"
  fi
  repo_dir=$install_dir
fi

if [ "$prepare_only" = true ]; then
  "$repo_dir/bin/install" --prepare-only
  exit 0
fi

"$repo_dir/bin/install"

if [ "$configure_api_key" = true ]; then
  "$repo_dir/bin/api-key" set
fi

printf '\nVerifying installation...\n'
"$repo_dir/bin/doctor"

cat <<'EOF'

Kimi K3 is installed. Fully quit Codex with Command-Q, reopen it, and start a
new task. The model picker will show Kimi K3 (OAuth) and Kimi K3 (API).
EOF
