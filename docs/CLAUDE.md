# Claude Desktop target

The Claude target connects the same Kimi and DeepSeek registry to Claude
Desktop's third-party inference mode through a local Anthropic Messages API
gateway. It is isolated from the existing Codex integration and can be enabled,
disabled, or removed independently.

> [!IMPORTANT]
> Anthropic documents third-party gateway mode for serving Claude models.
> Using it with Kimi or DeepSeek is an experimental community compatibility
> path. It may break when Claude Desktop, LiteLLM, or an upstream model changes,
> and Anthropic support should not be expected to troubleshoot those models.

## What stays unchanged

- Standard Claude Desktop data and Anthropic sign-in are not modified.
- Existing local third-party configurations are preserved.
- Codex config, catalog, service, ports, credentials, and provider selection are
  not touched.
- Claude's host-side tools, MCP servers, plugins, skills, hooks, permissions,
  and local workspace remain owned by Claude Desktop.

Third-party mode is a separate deployment mode. It does not convert a Claude
subscription into Kimi or DeepSeek access and does not use Anthropic quota for
external model requests. Provider billing and terms still apply.

## Give the repository to Claude

Paste this into a Claude Desktop Code/Cowork task or Claude Code session:

```text
Install the experimental Claude Desktop target from this public repository:
https://github.com/duolahypercho/codex-router

Follow CLAUDE.md. Preserve my existing Claude configurations, Anthropic account
data, tools, plugins, MCP servers, and Codex setup. Use only the provider
authentication I choose, run the Claude doctor, and leave the final Claude
Desktop restart to me. Never ask me to paste a token or API key into chat.
```

The agent can do the setup and verification. You must perform the final full
app quit and reopen so Claude Desktop loads the newly applied local deployment.

## Guided terminal install

macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/duolahypercho/codex-router/main/install.sh \
  | sh -s -- --target claude --guided
```

Windows PowerShell:

```powershell
$installer = Join-Path $env:TEMP "codex-router-install.ps1"
Invoke-WebRequest https://raw.githubusercontent.com/duolahypercho/codex-router/main/install.ps1 -OutFile $installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -Target claude -Guided
```

Clone-and-review installation:

```sh
git clone https://github.com/duolahypercho/codex-router.git
cd codex-router
./install.sh --target claude --guided
```

Requirements are the latest Claude Desktop on macOS or Windows, Node.js 22.19+
(24 LTS recommended), Git, and `uv` or Python 3.10+ with `venv`. The router
process can run on Linux for development, but this project does not claim a
supported Linux Claude Desktop distribution.

## Commands

```sh
./bin/model-router claude status
./bin/model-router claude doctor
./bin/model-router claude providers
./bin/model-router claude provider-key deepseek set
./bin/model-router claude disable
./bin/model-router claude enable
./bin/model-router claude uninstall
```

On Windows, replace `./bin/model-router` with `./model-router.ps1`.

The optional live check consumes provider quota and requires explicit consent:

```sh
./bin/model-router claude smoke-test --yes
```

## What the installer changes

The Claude target uses its own service and ports:

| Layer | Default |
| --- | --- |
| Claude Messages gateway | `127.0.0.1:4110` |
| Internal LiteLLM adapter | `127.0.0.1:4111` |
| Kimi OAuth forwarder | `127.0.0.1:4112` |
| API-key forwarder | `127.0.0.1:4113` |

State is stored under `~/.local/state/model-router/claude` on macOS/Linux and
`%LOCALAPPDATA%\model-router\claude` on Windows. The service is
`io.github.codex-router.claude` on macOS,
`codex-router-claude.service` on Linux, or `Codex Router - Claude` on Windows.

The config manager adds one owned UUID entry under the current user's
`Claude-3p/configLibrary`, sets it as applied, and records which entry was
previously active. It refuses malformed metadata. Disable or uninstall removes
only the owned entry and restores the previous applied entry when it still
exists. A protected copy of pre-router metadata is retained for recovery.

Claude Desktop's own in-app configuration window remains the supported manual
fallback: enable Developer Mode, open **Developer → Configure Third-Party
Inference…**, choose **Gateway**, use `http://127.0.0.1:4110`, Bearer auth, the
generated Claude caller key, disable discovery, and list the enabled model IDs.
The automated local-library integration is intentionally marked experimental
because Anthropic does not document that on-disk library as a public API.

## Tools, images, and context

Claude Desktop still owns the agent loop, tool execution, workspace, and
conversation storage. It sends tool definitions and multimodal message content
to the selected model through the Messages API; the local adapter translates
that request to the provider's OpenAI-compatible Chat Completions API and
translates the response back.

This means tools and image input work only when all three layers support the
required shape: Claude Desktop, the selected external model, and LiteLLM's
translation. The router does not create missing provider capabilities. Image
generation is a Claude-side tool or MCP/plugin operation, not a model-picker
feature added by this router. Computer-use availability and permissions remain
controlled by Claude Desktop and its deployment policy.

`toolSearchEnabled` is set to `false` because Anthropic documents that enabling
it also enables other experimental beta headers. Tool schemas are therefore
sent inline. Provider context limits still apply; long sessions may need a new
conversation when the external model cannot consume the accumulated history.
Models whose tested registry metadata declares at least a one-million-token
window are marked with Claude Desktop's `supports1m` capability; smaller models
are not.

## Troubleshooting

Start with:

```sh
./bin/model-router claude doctor
```

If Claude opens in standard mode, fully quit it and reopen it. If the local
configuration is ignored, check for an administrator-managed Claude policy;
managed configuration takes precedence over the local library. Use **Help →
Troubleshooting → Copy Managed Configuration Report** for a redacted source
report.

If the picker is empty, verify that at least one provider is both enabled and
authenticated, then run `doctor --fix` and restart Claude Desktop. The router
uses an explicit model list because Claude's automatic gateway discovery
filters IDs that are not recognizable as Claude models.

If a Claude Desktop update changes local configuration behavior, disable the
target, configure the same gateway manually through Claude's in-app window, and
open an issue without including the caller key, provider credentials, prompts,
or raw logs.

Official references:

- [Claude Desktop on third-party overview](https://claude.com/docs/third-party/claude-desktop/overview)
- [LLM gateway requirements](https://claude.com/docs/third-party/claude-desktop/gateway)
- [Single-machine setup](https://claude.com/docs/third-party/claude-desktop/installation#single-machine-setup)
- [In-app configuration](https://claude.com/docs/third-party/claude-desktop/in-app-configuration)
- [Configuration reference](https://claude.com/docs/third-party/claude-desktop/configuration)
