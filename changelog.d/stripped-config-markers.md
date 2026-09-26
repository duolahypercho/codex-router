- **A Codex `config.toml` that lost its comments no longer strands the router.**
  The config manager recognizes its own tables by comment markers, and a writer
  that re-serializes the file (a TOML library round trip, a formatter) keeps
  every table but drops every comment. The router's provider table then read as
  user-owned, so `update`, `enable`, and `doctor --fix` refused with "Refusing to
  replace user-owned model provider codex-router", and login-free mode on your
  own provider table refused with "lost ownership" and could not even be turned
  off. The router now re-adopts those tables on the evidence the markers
  carried — the root keys still name its own port and private catalog, or the
  protected login-free state still names the table — and only when every field
  is exactly what it writes; anything else is still left alone. `disable` also
  retires a stripped provider table, so a later reinstall is not refused by the
  orphan.
