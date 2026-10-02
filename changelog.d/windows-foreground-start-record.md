- **`codex-router.ps1 start --foreground` runs again on Windows.** Since the
  foreground path started entering through `src/foreground-start.mjs`, it
  failed during startup on every install with a working LiteLLM environment:
  "The Windows service could not verify its own start.mjs process identity;
  refusing to run without a stoppable process record." That record is how the
  Windows service manager stops the tree it launched, and it only accepts a
  command line that names `src/start.mjs`. The foreground supervisor is the
  explicit unmanaged debugging path, so it no longer claims the record; the
  logon task's direct `src/start.mjs` still records itself and still refuses
  to run without it. A foreground router holds the service lifecycle lock for
  as long as it runs, so `codex-router.ps1 stop`, `start` and `restart` wait
  and then fail until it exits. Run `codex-router.ps1 stop` before
  `start --foreground`, or the logon task keeps relaunching the managed router
  every minute into the ports the foreground router holds.
