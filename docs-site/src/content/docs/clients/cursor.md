---
title: "Cursor"
description: "Cursor Agent over loopback, and Cursor App over a keyed public edge."
---
The `cursor` target serves both official clients through different edges:

- `cursor-router-agent` launches Cursor Agent against the router's authenticated
  loopback Connect/protobuf adapter.
- Cursor App uses OpenAI BYOK. Retail Cursor sends those requests through
  Cursor's backend, so a loopback URL is rejected; the app needs a stable public
  HTTPS tunnel forwarding to the app-only edge on `127.0.0.1:4214`.

This is the same network shape used by CLIProxyAPI Cursor recipes: the proxy
provides OpenAI-compatible endpoints, Cursor is pointed at their base URL, and
a named tunnel makes the endpoint reachable by Cursor's backend. CLIProxyAPI
does not contain a private local-Cursor connector that removes that public hop.
Cursor Agent is different and remains fully local through `cursor-router-agent`.

In the Control Center's Harness page, nothing Cloudflare-related runs during
detection or page load. **Connect Cursor** is one resumable action: it installs
the fixed connector when needed, opens `cloudflared tunnel login`, resolves the
domain selected during browser authorization, creates a unique named hostname,
waits for Cursor to be fully quit, publishes and verifies the routed catalog,
then reopens Cursor. Progress stays inside the Cursor row. The Cloudflare token
is used only for that one zone-name lookup and is never returned to the
renderer, logged, or copied into router state.

A domain managed by the user's Cloudflare account is the only external
prerequisite. Cursor's retail BYOK backend cannot call a loopback-only service,
and Cloudflare cannot create stable public DNS without a domain. Users who
already have a preferred public hostname can expand **Use an existing
Cloudflare hostname**; everyone else leaves it blank.
The equivalent CLI path is to install `cloudflared`, run `cloudflared tunnel
login` once, and then give the router a hostname on that Cloudflare account. It
adds the DNS route, writes the edge-only ingress, and keeps the connector
running with the router service:

```sh
./install.sh --target cursor --auto --providers configured \
  --cursor-hostname cursor-router.example.com

# Or add Cursor to an existing router. Fully quit Cursor first.
./bin/model-router cursor enable \
  --hostname cursor-router.example.com
```

An already-managed tunnel remains supported with `--cursor-public-url
https://cursor-router.example.com`; that is the advanced/manual path.

The public hostname must not point at the main router port. Port 4214 exposes
only the secret-bearing `/v1/models` and `/v1/chat/completions` app surface;
accepted requests re-enter the same `/v1/responses` path used by Codex. Cursor
misclassifies a custom id that contains one of its built-in model ids and then
rejects it with “This model does not support custom API keys.” The router
therefore publishes readable, collision-safe ids such as
`codex_router/gpt_5_6_sol__419255f2/high`. The suffix is the reasoning effort;
choose another row for Low, Medium, High, and so on. Cursor does not expose its
native effort control for ordinary user-added BYOK models.

```sh
cursor-router-agent --list-models
# Copy one exact id from that list, including its effort suffix.
cursor-router-agent --model 'PASTE_ID_FROM_THE_LIST' --print "Reply with OK"
```

Reopen Cursor App and choose a `codex_router/...` model. Cursor's base-URL override
is global, so Cursor-managed models (`Auto`/`default`, `grok-4.6`, Claude, Composer,
and other first-party ids) are also sent to the custom endpoint while it is enabled
and then rejected with “This model does not support custom API keys.” Turn the
override off when switching back to Cursor's own models. `cursor enable` switches
the composer selection away from those Cursor-managed ids onto a published
`codex_router/...` alias.

Cursor Agent text turns are supported and verified against the official CLI.
Its local read/shell/edit/write loop is also mapped onto Cursor's controlled-
exec protocol: Cursor applies its permission mode and performs the operation,
then the router resumes the selected model with the typed result. Cursor MCP
tools use a separate exec shape and are not advertised yet. Cursor App Agent
requests continue through Cursor's own orchestration.

`./bin/model-router cursor disable` removes router-owned aliases and restores
the prior base URL and BYOK toggle when they still match the published values.
Cursor must be fully stopped for enable, repair, or disable because it owns its
SQLite settings database while running.
