# Codex Router installation instructions

These instructions apply when a user asks Codex to install this repository.

## Outcome

Install Codex Router for the current user, preserve every unrelated Codex
setting and ChatGPT authentication artifact, expose only the external providers
the user wants, verify the integration, and leave the final Codex restart to the
user.

## Procedure

1. Read the host platform and check for Codex, Git, Node.js 22.19+, and `uv` or
   Python 3.10+. Read-only checks are allowed. Do not install a package manager
   or system runtime without the user's permission.
2. Use a stable checkout: `~/.local/share/codex-router` on macOS/Linux, or
   `%LOCALAPPDATA%\codex-router` on Windows. Do not install the service from a
   temporary clone.
3. Never ask the user to paste OAuth tokens or API keys into chat, command
   arguments, logs, environment snippets, or tracked files.
4. Determine which provider IDs the user requested: `kimi-oauth`, `kimi-api`,
   and/or `deepseek`. If they did not specify and credentials already exist, use
   `configured` rather than showing providers that cannot authenticate.
5. For Kimi OAuth, reuse a valid `kimi login` session. If login is needed, run
   the official CLI only in an interactive terminal. For API providers, invoke
   `bin/provider-key PROVIDER set` in a PTY so the repository's hidden prompt
   receives the value directly; do not relay it through chat.
6. Run read-only legacy detection. It is safe to pass `--migrate-known` when the
   detector identifies a repository-recognized older Codex Router: migration is
   scoped, snapshotted, and reversible. Never migrate, stop, delete, or replace
   an unknown router automatically.
7. On macOS/Linux, run `./install.sh --auto --providers IDS --migrate-known`
   from the stable checkout. On Windows, run
   `./install.ps1 -Auto -Providers IDS -MigrateKnown`. Omit `-MigrateKnown` only
   when detection found nothing. Do not enable `--smoke-test` unless the user
   agrees to a quota-consuming request.
8. Run `bin/doctor` (or `./codex-router.ps1 doctor` on Windows). Core config,
   catalog, internal key, service, router health, and selected credentials must
   be `OK`. Unselected credentials may be `WARN`.
9. If a managed layer fails, use `bin/doctor --fix`; add `--migrate-known` only
   for a recognized older installation. If repair still fails, create
   `bin/support-bundle` and report its path without automatically uploading it.
10. Do not terminate Codex. Tell the user to fully quit it, reopen it, create a
    new task, and choose the new model.

## Safety boundaries

- The config manager may change only its marked root `openai_base_url` and
  `model_catalog_json` block.
- Preserve `model`, `model_provider`, reasoning settings, profiles, projects,
  trust, MCP configuration, features, and ChatGPT authentication.
- Do not kill unknown processes on ports 4100–4103.
- Do not print or read credential-file contents. Status commands report presence
  and source only.
- Do not delete retained keys, logs, backups, snapshots, or old state
  directories.
- Do not restart or quit the Codex App from the installation task.
