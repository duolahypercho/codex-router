# Troubleshooting

Start with:

```sh
./bin/doctor
./bin/status
```

Neither command prints credential values.

## External models are missing from the picker

1. Run `./bin/doctor` and fix any `FAIL` result.
2. Run `./bin/refresh-catalog` after a Codex App or registry update.
3. Fully quit Codex with `Command-Q`; closing the window is not enough.
4. Reopen Codex and create a new task.
5. Confirm the generated entries:

```sh
codex debug models | jq -r '.models[] | select(.slug | contains("/")) | [.slug, .display_name] | @tsv'
```

The config root should contain the `codex-router-managed` block with
`openai_base_url` on port 4102 and a catalog under
`~/.codex/codex-router/merged-models.json`.

## Kimi OAuth fails

```sh
kimi login
./bin/doctor
```

The router reads the official Kimi CLI credential in `~/.kimi-code` and refreshes
it under a cross-process lock. Do not paste the OAuth token into Codex or an
environment variable.

## Kimi or DeepSeek says the API key is missing

```sh
./bin/provider-key kimi-api set
./bin/provider-key deepseek set
./bin/provider-key kimi-api status
./bin/provider-key deepseek status
```

The prompts hide input. No service restart is needed after setting or rotating a
key. Confirm the key belongs to the named provider; Kimi Code OAuth, Kimi
Platform, and DeepSeek are separate account systems.

## A DeepSeek model returns an upstream model error

DeepSeek's primary API model IDs are `deepseek-v4-flash` and
`deepseek-v4-pro`. Run `git pull --ff-only`, reinstall, refresh the catalog, and
retry. The hidden `deepseek-chat` and `deepseek-reasoner` compatibility aliases
are scheduled to stop working on July 24, 2026.

Inspect the provider response without exposing your key:

```sh
tail -n 200 "${CODEX_HOME:-$HOME/.codex}/codex-router/router.log"
```

Redact prompts and provider response bodies before sharing logs.

## Native GPT models stopped working

Temporarily restore native routing:

```sh
./bin/disable
```

If native models work again, inspect router health and the log. The native route
forwards only an allow-list of Codex headers and removes
`previous_response_id` on normal requests to avoid stale backend state.

## Another proxy owns the ports

```sh
lsof -nP -iTCP:4100 -iTCP:4101 -iTCP:4102 -iTCP:4103 -sTCP:LISTEN
```

Stop the older proxy before installing this one. Do not kill an unknown process
until its owner and purpose are clear. The installer migrates the earlier
`io.github.kimi-codex-router` LaunchAgent, but it does not remove unrelated
third-party proxies.

## The LaunchAgent is not running

```sh
launchctl print "gui/$(id -u)/io.github.codex-router"
tail -n 200 "${CODEX_HOME:-$HOME/.codex}/codex-router/router.log"
./bin/enable
```

Keep the repository at the same absolute path used during installation. If it
was moved, rerun `./install.sh` from the new stable location.

## WebSocket warning followed by HTTP fallback

This is expected. The router declines the optional Responses WebSocket upgrade,
and current Codex retries with compressed HTTP. A warning alone is not a failed
request.

## Uninstall did not delete credentials or logs

This is intentional. `./bin/uninstall` removes only the integration config and
LaunchAgent. Inspect `~/.codex/codex-router` manually before deleting retained
state; it can contain API keys, logs, catalogs, and the internal service key.
