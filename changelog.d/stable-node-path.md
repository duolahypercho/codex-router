- **Upgrading Node with Homebrew no longer breaks Codex's login-free
  routing, the `claude-router` and `cursor-router-agent` launchers, or a
  repaired service.** Each of them recorded this process's own Node path,
  which on Homebrew is the versioned keg (`…/Cellar/node/26.9.0/bin/node`)
  that `brew upgrade node` deletes, so Codex failed to run its caller auth
  command on every routed turn. Worse, the config manager matched that path
  literally when deciding whether it still owned its login-free provider
  block, so the next `update`, `enable`, or `doctor --fix` refused with "lost
  ownership" and left the dead command in place. Recorded paths now name the
  formula's `opt` link (or an explicit `CODEX_ROUTER_NODE_BIN`), the auth
  command's Node path is no longer treated as ownership evidence, and the
  service restart and client-disconnect spawns resolve Node the same way.
  `doctor` reports a caller auth command whose Node is gone, and warns while it
  still names a keg; `./bin/doctor --fix` rewrites it.
