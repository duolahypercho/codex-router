# Cursor target

The Cursor target exposes the same external-provider registry to Cursor through
a local, credential-isolating **OpenAI-compatible** gateway. It is isolated from
the Codex integration and can be enabled, disabled, or removed
independently.

> [!IMPORTANT]
> Cursor's only hook for external models is its **Override OpenAI Base URL** plus
> a custom OpenAI API key. That mode is *replacement*, not additive: pointing
> Cursor's OpenAI base URL at this gateway changes how Cursor routes
> OpenAI-branded traffic and generally applies to the plan/chat surface rather
> than every Cursor feature. Unlike the Codex target, it cannot purely add
> models while leaving everything else untouched — that is a Cursor limitation,
> not a router one.

## What stays unchanged

- This target **never edits Cursor's own settings**. Cursor stores model
  configuration in an application state database that the router does not touch,
  so your existing Cursor models, subscription, history, and preferences are not
  modified. You paste the router's values into Cursor yourself.
- Codex config, services, ports, credentials, and provider selection are not
  touched.
- Cursor keeps ownership of its agent loop, editor features, and workspace.

Provider billing and terms still apply; the gateway forwards requests to the
external provider you authenticated, not to Cursor's backend.

## Guided terminal install

macOS/Linux (Cursor is cross-platform):

```sh
curl -fsSL https://raw.githubusercontent.com/duolahypercho/codex-router/main/install.sh \
  | sh -s -- --target cursor --guided
```

Windows PowerShell:

```powershell
$installer = Join-Path $env:TEMP "codex-router-install.ps1"
Invoke-WebRequest https://raw.githubusercontent.com/duolahypercho/codex-router/main/install.ps1 -OutFile $installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -Target cursor -Guided
```

Clone-and-review installation:

```sh
git clone https://github.com/duolahypercho/codex-router.git
cd codex-router
./install.sh --target cursor --guided
```

Requirements: Cursor, Node.js 22.19+ (24 LTS recommended), Git, and `uv` or
Python 3.10+ with `venv`.

## Connect Cursor

`model-router cursor setup` prints the exact values to paste into Cursor. In
**Cursor → Settings → Models**, enable **Override OpenAI Base URL** and provide:

- **Base URL:** `http://127.0.0.1:4104/v1`
- **OpenAI API Key:** the generated Cursor caller key (a local capability, shown
  only in your terminal)
- **Add Model:** the exact gateway model ids the setup command lists (for
  example `kimi-api-k3`, `deepseek-v4-pro`)

Then fully quit and reopen Cursor so it reloads the model list. Your other Cursor
models remain available.

## Commands

```sh
./bin/model-router cursor setup --guided
./bin/model-router cursor status
./bin/model-router cursor doctor
./bin/model-router cursor providers
./bin/model-router cursor provider-key deepseek set
./bin/model-router cursor provider-key anthropic-api set
./bin/model-router cursor disable
./bin/model-router cursor enable
./bin/model-router cursor uninstall
```

On Windows, replace `./bin/model-router` with `./model-router.ps1`.

## What the installer changes

The Cursor target uses its own service and ports:

| Layer | Default |
| --- | --- |
| Cursor OpenAI-compatible gateway | `127.0.0.1:4104` |
| Internal LiteLLM adapter | `127.0.0.1:4105` |
| Kimi OAuth forwarder | `127.0.0.1:4106` |
| API-key forwarder | `127.0.0.1:4107` |

State is stored under `~/.local/state/model-router/cursor` on macOS/Linux and
`%LOCALAPPDATA%\model-router\cursor` on Windows. The service is
`io.github.codex-router.cursor` on macOS, `codex-router-cursor.service` on Linux,
or `Codex Router - Cursor` on Windows.

Because Cursor is configured by hand, the Cursor config manager only records
router-side enable/disable state; it writes no Cursor application file, so there
is nothing in Cursor to roll back on disable.

## Tools, images, and context

Cursor still owns the agent loop and editor features. It sends OpenAI Chat
Completions requests to the gateway, which authenticates the caller, validates
the model against the enabled registry, and forwards to the provider. Tools and
image input work only when Cursor, the selected model, and the provider all
support the required shape; the router does not add capabilities a model lacks.

## Troubleshooting

Start with:

```sh
./bin/model-router cursor doctor
```

If Cursor shows no custom models, confirm the Base URL ends in `/v1`, the caller
key matches, and the model ids are exactly those from `cursor setup`, then fully
quit and reopen Cursor. If requests fail, verify at least one provider is both
enabled and authenticated (`doctor`), and that the service is running. Do not
include the caller key, provider credentials, prompts, or raw logs in an issue.
