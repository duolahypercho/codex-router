- **A Codex `config.toml` that lost its comments no longer strands the router.**
  The config manager recognizes what it wrote by comment markers, and a writer
  that re-serializes the file — a TOML library round trip, a formatter — keeps
  every table but drops every comment. The router's provider table then read
  as user-owned, so `update`, `enable`, and `doctor --fix` refused with
  "Refusing to replace user-owned model provider codex-router", and login-free
  mode on your own provider table refused with "lost ownership" and could not
  even be turned off. The router now takes back its provider table, realtime
  endpoints, and multi-agent feature on the evidence the markers carried — the
  root keys still name its own port and private catalog, or the protected
  login-free state still names the table — and only when every value decodes
  to exactly what it writes, including the padded and multi-line arrays Python's
  `toml` and `tomli_w` write back. Anything else, including a comment inside
  its tables, is still left alone, and a comment above the next table is never
  removed with them. `disable` retires what it took back, so no router setting
  outlives it and a later reinstall is not refused by an orphan. A saved
  provider section containing `$'`, `$&`, or `$$` — a bearer token, say — is
  also restored exactly again when login-free mode is turned off.
