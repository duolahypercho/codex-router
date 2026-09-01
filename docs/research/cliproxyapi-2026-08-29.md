# CLIProxyAPI research — 2026-08-29

## Question

Can [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) be reused to
publish codex-router's selected models into Cursor Agent and Cursor App?

## Findings

CLIProxyAPI is an MIT-licensed Go proxy with a broad inference compatibility
surface. It exposes OpenAI Chat Completions, OpenAI Responses, Anthropic
Messages, and Gemini-shaped endpoints; supports streaming, tools, multimodal
payloads, account pooling, and several CLI/OAuth-backed upstreams. It is a
router/gateway, not a Cursor client adapter.

The most relevant behavior is in
`sdk/api/handlers/openai/openai_handlers.go`: on `/v1/chat/completions`, it
detects a Responses-shaped request (`input` or `instructions`, with no
`messages`) and translates it instead of rejecting the body. That matches a
current Cursor App behavior observed in the retail client and is adopted in
`src/cursor-surface.mjs`.

CLIProxyAPI does **not** implement Cursor Agent's current proprietary endpoints:

- `/auth/exchange_user_api_key`
- `/aiserver.v1.AiService/GetUsableModels`
- `/aiserver.v1.AiService/GetDefaultModelForCli`
- `/agent.v1.AgentService/RunSSE`
- `/aiserver.v1.BidiService/BidiAppend`

Those use Connect/protobuf rather than an OpenAI-shaped API. Consequently,
putting CLIProxyAPI between Cursor Agent and codex-router would not make the CLI
work. It would solve only the OpenAI-compatible half of Cursor App, which is
small enough to translate directly before re-entering codex-router's canonical
Responses path.

## Security and operational fit

CLIProxyAPI can bind beyond loopback when its `host` is left empty. That is a
reasonable server default but conflicts with codex-router's local caller-
capability boundary. Cursor App does require a public endpoint because retail
BYOK is server-mediated; the safe shape is therefore a separate loopback edge
with a separate capability and only two routes, published through an explicit
HTTPS tunnel. The main router, its panel, the Cursor CLI control plane, and the
shared caller capability remain private.

Running CLIProxyAPI as another daemon would also create a second provider
catalog, credential surface, retry policy, usage ledger, and failure boundary.
It would bypass or duplicate codex-router behavior such as provider selection,
tool-result ageing, vision bridging, failover, and accounting unless every
request translated and re-entered `/v1/responses` anyway.

## Decision

Do not add CLIProxyAPI as a runtime dependency or sidecar. Reuse its proven
request-shape compatibility idea and keep one router plane:

1. Cursor App: accept both Chat Completions and Responses-shaped bodies on the
   app-only edge, translate, and re-enter `/v1/responses`.
2. Cursor Agent: implement the measured Connect/protobuf control plane directly
   behind the local caller capability.
3. Keep provider credentials, selection, retries, failover, and usage in the
   existing codex-router service.

## Sources

- [CLIProxyAPI repository](https://github.com/router-for-me/CLIProxyAPI)
- [CLIProxyAPI basic configuration](https://github.com/router-for-me/CLIProxyAPIDocs/blob/main/docs/en/configuration/basic.md)
- [Responses payload discussion, issue 659](https://github.com/router-for-me/CLIProxyAPI/issues/659)
- [Chat Completions compatibility report, issue 3805](https://github.com/router-for-me/CLIProxyAPI/issues/3805)
- [Cursor API-key and custom endpoint help](https://prod.cursor.com/help/models-and-usage/api-keys)
