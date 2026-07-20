# Codex Router installation instructions

These instructions apply when a user asks Codex to install this repository.

## Goal

Install Codex Router for the current macOS user, preserve their existing Codex
defaults, configure only the external-provider credentials they request,
verify the result, and leave the user with only the final Codex restart when
authentication is already configured.

## Procedure

1. Confirm the host is macOS and that the Codex App is installed. Do not install
   missing system package managers or runtimes without the user's permission.
2. If the repository is not already in a stable checkout, clone it to
   `~/.local/share/codex-router`. The LaunchAgent retains the checkout's absolute
   path, so do not use a temporary directory.
3. Never ask the user to paste an OAuth token or API key into chat, command-line
   arguments, logs, or a tracked file.
4. Run `./install.sh` from the stable checkout. It installs every listed model
   from `config/providers.json` and reuses an existing Kimi Code CLI OAuth
   session automatically.
5. If the user requests an API-key provider, run the matching secure command in
   an interactive terminal after installation: `./bin/provider-key kimi-api set`
   or `./bin/provider-key deepseek set`. Input must remain hidden. OAuth and API
   credentials are separate.
6. Run `./bin/doctor`. Installation is successful when its core catalog,
   service-key, background-service, router-health, and Codex-catalog checks are
   `OK`. At least one authentication method the user intends to use should also
   be `OK`; unused providers may be `WARN`.
7. Do not terminate the Codex App from the installation task. Tell the user to
   fully quit with Command-Q, reopen Codex, and create a new task.

## Safety boundaries

- The installer may add only its marked `openai_base_url` and
  `model_catalog_json` block to `~/.codex/config.toml`.
- Do not change `model`, `model_provider`, `model_reasoning_effort`, profiles, or
  the user's ChatGPT authentication.
- Do not kill an unknown process occupying ports 4100 through 4103. Report the
  conflicting process or proxy and ask the user whether it should be disabled.
- Do not delete retained credentials, logs, backups, or another proxy's files.
- If Kimi OAuth is not configured, run `kimi login` only in an interactive
  terminal. If the Kimi CLI is missing, report that prerequisite with the
  official setup link from the README.
- If an API provider is not configured, use `bin/provider-key`; never write a
  key directly or print credential-file contents.
