#!/bin/sh
set -eu

repository_url=${CODEX_ROUTER_REPOSITORY_URL:-https://github.com/duolahypercho/codex-router.git}
default_data_dir=${XDG_DATA_HOME:-$HOME/.local/share}
install_dir=$default_data_dir/codex-router
prepare_only=false
configure_provider_keys=
guided=auto
providers=
migrate_known=false
smoke_test=false
previous_revision=
target=codex

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Install external model routes for Codex or Claude Desktop.

Options:
  --install-dir PATH  Stable checkout used by the background service
  --target APP        Install for "codex" (default) or "claude"
  --prepare-only      Install dependencies without changing either app
  --api-key           Alias for --kimi-api-key
  --kimi-api-key      Prompt securely for a Kimi Platform API key
  --deepseek-api-key  Prompt securely for a DeepSeek API key
  --guided           Walk through provider selection and authentication
  --auto             Use configured credentials without questions
  --providers LIST   Enable comma-separated provider ids (or "configured")
  --migrate-known    Snapshot and replace recognized earlier router installs
  --smoke-test       Make one small billed request per enabled provider
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
    --target)
      [ "$#" -ge 2 ] || die "--target requires codex or claude"
      target=$2
      shift 2
      ;;
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
      configure_provider_keys="$configure_provider_keys kimi-api"
      shift
      ;;
    --kimi-api-key)
      configure_provider_keys="$configure_provider_keys kimi-api"
      shift
      ;;
    --deepseek-api-key)
      configure_provider_keys="$configure_provider_keys deepseek"
      shift
      ;;
    --guided)
      guided=true
      shift
      ;;
    --auto)
      guided=false
      shift
      ;;
    --providers)
      [ "$#" -ge 2 ] || die "--providers requires a comma-separated list"
      providers=$2
      guided=false
      shift 2
      ;;
    --migrate-known)
      migrate_known=true
      shift
      ;;
    --smoke-test)
      smoke_test=true
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

case "$target" in
  codex|claude|cursor) ;;
  *) die "--target must be codex, claude, or cursor" ;;
esac
if [ "$target" != codex ] && [ "$migrate_known" = true ]; then
  die "--migrate-known applies only to the Codex target"
fi
host_platform=$(uname -s 2>/dev/null || true)
if [ "$target" = claude ] && [ "$host_platform" = Linux ] && [ "$prepare_only" != true ]; then
  die "Claude Desktop third-party mode is supported on macOS and Windows; use --prepare-only for Linux development"
fi
MODEL_ROUTER_TARGET=$target
export MODEL_ROUTER_TARGET

repo_dir=
case "$0" in
  install.sh|*/install.sh)
    candidate_dir=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || true)
    if [ -n "$candidate_dir" ] &&
      [ -x "$candidate_dir/bin/install" ] &&
      [ -f "$candidate_dir/package.json" ] &&
      grep -q '"name": "codex-model-router"' "$candidate_dir/package.json"; then
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
    previous_revision=$(git -C "$install_dir" rev-parse HEAD)
    git -C "$install_dir" update-ref refs/codex-router/rollback "$previous_revision"
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

command -v node >/dev/null 2>&1 ||
  die "Node.js 22.19+ is required; install Node.js 24 LTS from https://nodejs.org/"
command -v npm >/dev/null 2>&1 ||
  die "npm is required and is normally included with Node.js"

for provider_id in $configure_provider_keys; do
  "$repo_dir/bin/provider-key" "$provider_id" set
done

if [ "$guided" = auto ]; then
  if [ -t 1 ] && [ -r /dev/tty ] && [ -w /dev/tty ]; then
    guided=true
  else
    guided=false
  fi
fi

set --
if [ "$guided" = true ]; then set -- "$@" --guided; fi
if [ -n "$providers" ]; then set -- "$@" --providers "$providers"; fi
if [ "$migrate_known" = true ]; then set -- "$@" --migrate-known; fi
if [ "$smoke_test" = true ]; then set -- "$@" --smoke-test; fi
if ! "$repo_dir/bin/setup" "$@"; then
  if [ -n "$previous_revision" ]; then
    git -C "$repo_dir" switch --detach "$previous_revision" >/dev/null 2>&1 || true
    die "setup failed; the managed source checkout was restored to $previous_revision"
  fi
  die "setup failed"
fi

if [ "$target" = claude ]; then
  cat <<'EOF'

Claude Router is installed. Fully quit and reopen Claude Desktop. The app will
use its local third-party inference configuration and show the enabled routes.
EOF
else
  cat <<'EOF'

Codex Router is installed. Fully quit Codex, reopen it, and start a new task.
The model picker will show only the providers you enabled while preserving
native GPT models.
EOF
fi
