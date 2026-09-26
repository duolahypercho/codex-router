- **Upgrading Node with Homebrew no longer breaks Codex's login-free
  routing, the `claude-router` and `cursor-router-agent` launchers, or a
  repaired service.** Each of them recorded this process's own Node path,
  which on Homebrew is the versioned keg (`…/Cellar/node/26.9.0/bin/node`)
  that `brew upgrade node` deletes, so Codex failed to run its caller auth
  command on every routed turn. Worse, the config manager matched that path
  literally when deciding whether it still owned its login-free provider
  block, so the next `update`, `enable`, or `doctor --fix` refused with "lost
  ownership" and left the dead command in place. A keg is now recorded as its
  formula's `opt` link; the auth command keeps a working, non-keg Node it
  already names and otherwise uses the router's own Node binary, never a
  launcher or version-manager shim; and its path is no longer treated as
  ownership evidence, which also recovers a command an older Control Center
  recorded as its Electron app. The service restart and client-disconnect
  spawns resolve Node the same way. `doctor` fails on an auth command whose
  Node is gone or is not Node at all, and warns while it names a keg;
  `./bin/doctor --fix` rewrites it.
