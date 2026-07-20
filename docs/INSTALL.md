# Installation guide

## Supported setup

The automatic installer targets the Codex desktop app on macOS. The runtime is
Node.js plus LiteLLM; Linux and Windows background-service installers are not
included yet.

Required software:

- Codex App or Codex CLI, already signed into ChatGPT.
- Node.js 22.19 or newer. Node 24 LTS is recommended.
- `uv`, or Python 3.10+ with the standard `venv` module.
- At least one configured external-provider credential.

## Ask Codex to install it

Send this message to Codex:

```text
Install this model router in my Codex App:
https://github.com/duolahypercho/codex-router

Follow AGENTS.md, preserve my existing Codex defaults and ChatGPT login,
configure only the credentials I request, run the doctor, and tell me when it
is ready to restart. Do not quit Codex for me.
```

Codex should clone to `~/.local/share/codex-router`, run `./install.sh`,
configure requested credentials through hidden prompts, and finish with
`./bin/doctor`.

## 1. Choose authentication

Kimi Code OAuth reuses the official CLI session:

```sh
kimi login
```

Kimi Platform and Kimi Code are separate services. For Kimi Platform billing,
configure its API key after installation:

```sh
./bin/provider-key kimi-api set
```

For DeepSeek API access:

```sh
./bin/provider-key deepseek set
```

The key prompts disable terminal echo and write mode-`600` files. Never put a
credential in chat, shell history, `config/providers.json`, or a tracked file.

## 2. Install

Keep the checkout in a stable location because the LaunchAgent stores its
absolute path. From the repository root:

```sh
./install.sh
```

Or bootstrap the stable checkout directly:

```sh
curl -fsSL https://raw.githubusercontent.com/duolahypercho/codex-router/main/install.sh | sh
```

Useful installer options:

```sh
./install.sh --deepseek-api-key
./install.sh --kimi-api-key
./install.sh --prepare-only
./install.sh --help
```

The installer:

1. Installs Node and LiteLLM dependencies.
2. Generates a random loopback-only internal service key.
3. Captures the current native Codex model catalog.
4. Adds every listed model from `config/providers.json`.
5. Generates the LiteLLM gateway configuration from the same registry.
6. Adds the marked `openai_base_url` and `model_catalog_json` block.
7. Registers `io.github.codex-router` as a user LaunchAgent.
8. Waits for the complete router stack to report healthy.

If another proxy owns ports 4100 through 4103, the health identity check fails
and the installer rolls back its config change. It does not kill unknown
processes.

## 3. Restart Codex

`model_catalog_json` is loaded at app startup. Fully quit with `Command-Q`,
reopen Codex, and create a new task. The picker should contain:

- `Kimi K3 (OAuth)`
- `Kimi K3 (API)`
- `DeepSeek V4 Flash (API)`
- `DeepSeek V4 Pro (API)`

Native GPT models and the previously selected default remain intact.

## Verify

```sh
./bin/doctor
codex debug models | jq -r '.models[] | select(.slug | contains("/")) | .display_name'
```

Provider smoke tests:

```sh
codex exec --model 'kimi-oauth/k3' 'Reply with exactly OAUTH_OK'
codex exec --model 'kimi-api/kimi-k3' 'Reply with exactly KIMI_API_OK'
codex exec --model 'deepseek/deepseek-v4-flash' 'Reply with exactly FLASH_OK'
codex exec --model 'deepseek/deepseek-v4-pro' 'Reply with exactly PRO_OK'
```

Only run tests for credentials you configured; each call may consume provider
quota.

## DeepSeek model lifecycle

DeepSeek's official `/models` documentation currently lists
`deepseek-v4-flash` and `deepseek-v4-pro`. Both support 1M context, tools, and
thinking/non-thinking modes. The router lists both.

The older `deepseek-chat` and `deepseek-reasoner` aliases are hidden but remain
CLI-routable as `deepseek/deepseek-chat` and
`deepseek/deepseek-reasoner`. DeepSeek states that those aliases stop working
on July 24, 2026 at 15:59 UTC.

## Upgrades

For the managed stable checkout, running the bootstrap command again performs a
fast-forward update and reinstall. From an existing checkout:

```sh
git pull --ff-only
./install.sh
```

After a Codex App update or provider-registry change:

```sh
./bin/refresh-catalog
```

Then restart Codex so it reloads the generated catalog.

## Disable and uninstall

```sh
./bin/disable
./bin/enable
./bin/uninstall
```

Uninstall removes the marked config block and LaunchAgent. It intentionally
retains the checkout, logs, cached catalogs, backups, internal key, and
provider API keys so routine uninstall cannot silently destroy credentials or
diagnostic data.
