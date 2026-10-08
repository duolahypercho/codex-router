- **`bin/uninstall` no longer stops halfway when the managed Codex skills can't
  be removed.** Under `set -eu` a failed skill removal (for example a symlinked
  skills root) aborted the script before it removed the `codex` shim and
  retired the background service. Skill removal is now best effort, matching
  the install-side refresh.
