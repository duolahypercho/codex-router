# Model Router installation instructions for Claude

These instructions apply when a user asks Claude Code, Claude Desktop Code, or
Claude Desktop Cowork to install this repository for Claude Desktop.

## Outcome

Install the experimental Claude Desktop target for the current user, preserve
all existing Claude configurations and Anthropic account data, expose only the
external providers the user chooses, verify the local gateway, and leave the
final Claude Desktop restart to the user.

## Procedure

1. Confirm the user asked for the `claude` target. Read-only checks for the
   operating system, Claude Desktop, Git, Node.js 22.19+, and `uv` or Python
   3.10+ are allowed. Do not install a system package manager or runtime without
   permission.
2. Explain one compatibility boundary before changing anything: Anthropic
   documents Claude Desktop third-party gateway mode for Claude models. Routing
   Kimi or DeepSeek through that interface is a community compatibility layer,
   not an Anthropic-supported model configuration.
3. Use a stable checkout: `~/.local/share/codex-router` on macOS/Linux, or
   `%LOCALAPPDATA%\codex-router` on Windows. Do not install a background service
   from a temporary clone.
4. Never ask the user to paste OAuth tokens or API keys into chat, command
   arguments, logs, environment snippets, or tracked files.
5. Determine which provider IDs the user requested: `anthropic-api`,
   `kimi-oauth`, `kimi-api`, `deepseek`, and/or `grok-api`. If unspecified, use `configured` only when a credential is
   already available for the Claude target. Otherwise use guided setup.
6. For Kimi OAuth, reuse a valid official `kimi login` session. If login is
   needed, run the official CLI in an interactive terminal. For API providers,
   invoke `bin/model-router claude provider-key PROVIDER set` in a PTY so the
   hidden prompt receives the value directly; never relay it through chat.
7. On macOS run
   `./install.sh --target claude --auto --providers IDS` from the stable
   checkout. On Windows run
   `./install.ps1 -Target claude -Auto -Providers IDS`. Use `--guided` or
   `-Guided` when authentication still needs setup. Never pass
   `--migrate-known` for Claude. Do not enable the smoke test unless the user
   agrees to a quota-consuming request.
8. Run `./bin/model-router claude doctor` (or
   `./model-router.ps1 claude doctor` on Windows). The generated gateway,
   caller key, service, local Claude configuration, and router health must be
   `OK`. An unselected credential may be `WARN`.
9. If a managed layer fails, use `model-router claude doctor --fix`. If repair
   still fails, report the exact failed check and point the user to
   `docs/CLAUDE.md`; do not upload logs or configuration automatically.
10. Do not terminate Claude Desktop. Tell the user to fully quit and reopen it,
    then choose the local third-party inference deployment when prompted.

## Safety boundaries

- Claude and Codex targets have separate state directories, ports, caller keys,
  provider selections, services, and application configuration.
- The Claude config manager may add or update only its own UUID-named entry in
  the per-user `Claude-3p/configLibrary`, update that library's entry index, and
  restore the previously applied entry when disabled.
- Preserve every unrelated config-library entry, standard Claude user data,
  Anthropic authentication, MCP configuration, plugins, skills, hooks, and
  tool permissions.
- Refuse malformed or unrecognized config-library metadata. Do not replace it
  automatically.
- Do not kill unknown processes on ports 4110-4113.
- Do not print or read credential-file contents. Status commands report only
  credential presence and source.
- Do not delete retained keys, logs, backups, or old state directories.
- Do not restart or quit Claude Desktop from the installation task.
- Do not install the Claude target on Linux. Anthropic distributes this Claude
  Desktop mode for macOS and Windows; Linux is router development only and may
  use `--prepare-only` without changing an app.
