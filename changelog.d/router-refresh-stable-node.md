- **Router child processes follow the Node runtime the install recorded.** A
  long-running service started from a Homebrew Cellar path kept spawning its
  refresh, publication and restart children through that exact interpreter, so a
  `brew upgrade node` deleted it underneath them and every refresh failed with
  `ENOENT`. Those spawns now prefer `CODEX_ROUTER_NODE_BIN` when the install
  recorded one, and fall back to the current interpreter when it did not.
