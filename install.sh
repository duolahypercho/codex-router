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
with_tray=false
no_tray=false
previous_revision=
force=false
target=codex

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Install external model routes for Codex or DeepSeek Harness.

Options:
  --install-dir PATH  Stable checkout used by the background service
  --target APP        Install for "codex" (default) or "dsh" (DeepSeek Harness)
  --prepare-only      Install dependencies without changing either app
  --api-key           Alias for --kimi-api-key
  --kimi-api-key      Prompt securely for a Kimi Platform API key
  --deepseek-api-key  Prompt securely for a DeepSeek API key
  --grok-api-key      Prompt securely for an xAI API key
  --anthropic-api-key Prompt securely for an Anthropic API key
  --guided           Walk through provider selection and authentication
  --auto             Use configured credentials without questions
  --providers LIST   Enable comma-separated provider ids (or "configured")
  --migrate-known    Snapshot and replace recognized earlier router installs
  --smoke-test       Make one small billed request per enabled provider
  --with-tray        Also build and launch the desktop companion app
  --no-tray          Never offer the desktop companion app
  --force            Discard edits to tracked files in the managed checkout
                     before updating it. Untracked files are never touched.
  -h, --help          Show this help

When run from a checkout, this script installs that checkout. When piped from
GitHub, it clones or updates ~/.local/share/codex-router first.
EOF
}

die() {
  printf 'codex-router: %s\n' "$*" >&2
  exit 1
}

# Mirrors DIRTY_PREVIEW_LIMIT in src/update.mjs and $DirtyPreviewLimit in
# install.ps1. test/installer-scripts.test.mjs compares all three, so they
# cannot drift apart.
dirty_preview_limit=10

# Mirrors localModifications() in src/update.mjs. Only tracked edits are at
# stake: a fast-forward pull never replaces an untracked file, and git refuses
# the rare collision on its own with a precise message. Counting untracked
# files as "local changes" only ever stranded people -- one stray file in the
# checkout and every later self-update was refused, with nothing in the error
# to say which file or how to get past it.
local_modifications() {
  status_output=$(git -C "$1" status --porcelain --untracked-files=no) || return 1
  printf '%s\n' "$status_output" | sed -e 's/^[[:space:]]*//' -e '/^$/d'
}

# Mirrors localModificationsMessage() in src/update.mjs. Naming the files and
# both ways forward is the whole point: the old message named neither, so
# anyone blocked by a single stray edit had nothing to act on.
local_modifications_message() {
  changes=$1
  directory=$2
  count=$(printf '%s\n' "$changes" | wc -l)
  count=$((count))
  if [ "$count" -eq 1 ]; then
    counted="1 tracked file"
  else
    counted="$count tracked files"
  fi
  printf 'The checkout has local changes to %s; refusing to replace them during update:\n' "$counted"
  printf '%s\n' "$changes" | head -n "$dirty_preview_limit" | sed 's/^/  /'
  if [ "$count" -gt "$dirty_preview_limit" ]; then
    printf '  ...and %s more\n' "$((count - dirty_preview_limit))"
  fi
  printf '\n'
  printf 'Keep them:    git -C %s stash\n' "$directory"
  printf 'Discard them: re-run the same command with --force\n'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --target)
      [ "$#" -ge 2 ] || die "--target requires codex or dsh"
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
    --grok-api-key)
      configure_provider_keys="$configure_provider_keys grok-api"
      shift
      ;;
    --anthropic-api-key)
      configure_provider_keys="$configure_provider_keys anthropic-api"
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
    --with-tray)
      with_tray=true
      shift
      ;;
    --no-tray)
      no_tray=true
      shift
      ;;
    --migrate-known)
      migrate_known=true
      shift
      ;;
    --smoke-test)
      smoke_test=true
      shift
      ;;
    --force)
      force=true
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
  codex|dsh) ;;
  *) die "--target must be codex or dsh" ;;
esac
# Legacy migration replaces an older router's managed Codex config block, and
# the native catalog is the ChatGPT-plan model list Codex adopts. Neither has a
# counterpart in the harness, whose integration is one settings section.
if [ "$target" != codex ] && [ "$migrate_known" = true ]; then
  die "--migrate-known applies only to the Codex target"
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

    # Mirrors requireReplaceableCheckout() in src/update.mjs, including its
    # refusal to reach for `git clean`: --force restores files git already
    # tracks and leaves untracked files exactly where they are, because an
    # update has no business deleting work git was never asked to track.
    changes=$(local_modifications "$install_dir") ||
      die "unable to read the Git status of $install_dir"
    if [ -n "$changes" ]; then
      if [ "$force" != true ]; then
        local_modifications_message "$changes" "$install_dir" >&2
        exit 1
      fi
      git -C "$install_dir" reset --hard HEAD ||
        die "unable to discard the local changes in $install_dir"
    fi
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
if [ "$with_tray" = true ]; then set -- "$@" --with-tray; fi
if [ "$no_tray" = true ]; then set -- "$@" --no-tray; fi
setup_status=0
"$repo_dir/bin/setup" "$@" || setup_status=$?
# Exit 2 means setup left configuration unfinished (a declined prompt, a
# missing credential) and says nothing about the code that was just pulled.
# Rolling back there discards the update the user ran this for, and if the
# unfinished step is itself the bug being fixed, every retry repeats it. Any
# other non-zero status still restores the checkout, so the running service is
# never left on half-applied code by an unrecognized failure.
if [ "$setup_status" -eq 2 ]; then
  printf 'setup did not finish configuring; the update was kept. Re-run setup to continue, or ./bin/rollback to return to the previous revision.\n' >&2
  exit 2
elif [ "$setup_status" -ne 0 ]; then
  if [ -n "$previous_revision" ]; then
    git -C "$repo_dir" switch --detach "$previous_revision" >/dev/null 2>&1 || true
    die "setup failed; the managed source checkout was restored to $previous_revision"
  fi
  die "setup failed"
fi

cat <<'EOF'

Codex Router is installed. Fully quit Codex, reopen it, and start a new task.
The model picker will show only the providers you enabled while preserving
native GPT models.
EOF
