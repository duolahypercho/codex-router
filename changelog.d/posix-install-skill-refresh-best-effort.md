- **A failed skill-pack refresh no longer fails a macOS or Linux install or
  update.** `bin/install` ran the managed Codex skill refresh bare under
  `set -eu`, so any skill error exited the installer non-zero after the router
  itself was already installed, and `update` read that as a failed update and
  rolled the checkout back — then re-ran the same failing step while restoring,
  which is how the Node 26.10 skill error surfaced as "Update failed and
  automatic rollback also failed". The refresh is now best effort with a
  warning, matching `install.ps1` and `bin/uninstall`.
