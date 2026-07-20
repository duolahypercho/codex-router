# Installation guide

## Supported setup

The automatic installer currently targets the Codex desktop app on macOS. The
runtime itself is plain Node.js plus LiteLLM, but Linux and Windows service
installers are not included yet.

Required software:

- Codex App or Codex CLI, already signed into ChatGPT.
- Node.js 22.19 or newer. Node 24 LTS is recommended.
- `uv`, or Python 3.10+ with the standard `venv` module.
- Kimi Code CLI for OAuth, or a Kimi Platform API key for API billing.

Check the local tools:

```sh
node --version
python3 --version
codex --version
kimi --version
```

## Ask Codex to install it

The recommended path is to send this message to Codex:

```text
Install Kimi K3 from https://github.com/duolahypercho/codex-router.
Follow the repository's AGENTS.md installation instructions, preserve my
existing Codex defaults, and verify the installation. Do not quit Codex for me;
tell me when it is ready to restart.
```

Codex should clone the project to `~/.local/share/codex-router`, run the root
`install.sh`, and finish with `bin/doctor`. With an existing Kimi OAuth login,
the user only needs to restart Codex after the agent reports success.

## 1. Prepare Kimi authentication

For Kimi Code OAuth, install the official Kimi CLI and run:

```sh
kimi login
```

The official CLI uses a device-code OAuth flow and stores its state under
`~/.kimi-code` by default. The router reads and refreshes that same session; it
does not ask you to paste the OAuth token.

For the Kimi Platform API, you may skip `kimi login`. Obtain an API key from
the Kimi Platform console, then configure it after installation with
`./bin/api-key set`.

Do not interchange these credentials. The Kimi Code managed service and Kimi
Platform API use different account systems and base URLs.

## 2. Install the router

Keep the cloned repository in a stable location because the LaunchAgent stores
its absolute path. From the repository root, run the convenience installer:

```sh
./install.sh
```

It delegates to `bin/install`, then runs `bin/doctor`. The same script can
bootstrap a stable checkout when fetched directly:

```sh
curl -fsSL https://raw.githubusercontent.com/duolahypercho/codex-router/main/install.sh | sh
```

Pass `--api-key` to invoke the hidden Kimi Platform API-key prompt immediately
after installation, or `--prepare-only` to install dependencies without
changing Codex. Run `./install.sh --help` for all options.

If another Codex proxy or an earlier prototype already owns ports `4100` to
`4103`, disable that service first. The installer verifies the health endpoint's
service identity and rolls back its config block if a different process owns the
router port.

The installer performs these operations:

1. Installs the small Node dependency set with `npm ci`.
2. Creates `.venv` and installs `litellm[proxy]`.
3. Generates a random internal service key with mode `600`.
4. Captures the current native Codex model catalog.
5. Adds the two Kimi catalog entries without removing native models.
6. Adds a marked `openai_base_url` and `model_catalog_json` block to Codex.
7. Registers `io.github.kimi-codex-router` as a user LaunchAgent.
8. Waits until the complete router stack reports healthy.

If you only want to prepare dependencies and inspect the files without changing
Codex or installing a service:

```sh
./install.sh --prepare-only
```

## 3. Configure the optional API key

The recommended path is an interactive, protected local file:

```sh
./bin/api-key set
./bin/api-key status
```

Input is hidden, the file is written with mode `600`, and the key is never
printed. The running service reads the file on every request, so no restart is
needed.

Credential lookup order is:

1. `KIMI_API_KEY` or `MOONSHOT_API_KEY` in the service environment.
2. `$CODEX_HOME/kimi-router/api-key.secret`.
3. macOS Keychain service `kimi-codex-api`, account `default`.

The helper uses option 2 because shell environment variables are not normally
inherited by GUI LaunchAgents.

## 4. Restart Codex

`model_catalog_json` is a startup-only setting. Fully quit Codex with
`Command-Q`, reopen it, and create a new task. The picker should contain:

- `Kimi K3 (OAuth)`
- `Kimi K3 (API)`

The model that was already configured as your default remains selected.

## Verify

```sh
./bin/doctor
codex debug models | jq -r '.models[] | select(.slug | startswith("kimi-")) | .display_name'
```

OAuth smoke test:

```sh
codex exec --model 'kimi-oauth/k3' 'Reply with exactly OAUTH_OK'
```

API smoke test after setting a key:

```sh
codex exec --model 'kimi-api/kimi-k3' 'Reply with exactly API_OK'
```

## Upgrades

After updating the repository:

```sh
git pull --ff-only
./install.sh
```

After a Codex App update, refresh its native model entries and restart Codex:

```sh
./bin/refresh-catalog
```

The refresh command temporarily removes only the marked router block while it
captures the native catalog, then restores the integration.

## Disable or uninstall

Temporarily disable routing:

```sh
./bin/disable
```

Restore it:

```sh
./bin/enable
```

Remove the configuration block and LaunchAgent:

```sh
./bin/uninstall
```

Uninstall intentionally retains the repository, logs, cached native catalog,
internal key, and optional Kimi API key. This prevents a routine uninstall from
silently destroying credentials or diagnostic data.
