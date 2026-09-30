- **Uninstalling the Codex integration on Windows now removes the managed
  Codex skills.** `install.ps1` installs the router's skill pack into the Codex
  skills directory, but `codex-router.ps1 uninstall` only disabled the Codex
  configuration, so the skills stayed behind after the router was gone —
  `bin/uninstall` has always removed them on macOS and Linux. Removal is best
  effort, as it is there: a failure is reported as a warning and the shared
  service is still retired. `codex-router.ps1 disable` keeps the skills,
  matching `bin/disable`.
