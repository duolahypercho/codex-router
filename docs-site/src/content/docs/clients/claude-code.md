---
title: "Claude Code"
description: "Route Claude Code through the router-owned launcher."
---
The `claude` target adds a private `claude-router` launcher. It does not edit
Claude Code's settings or replace its login. The launcher points only that
process at the router's loopback Anthropic Messages surface and enables gateway
model discovery:

```sh
./install.sh --target claude --auto --providers configured
# or add Claude Code to an existing router
./bin/model-router claude enable

claude-router
# then use /model and choose codex_router/anthropic/<provider>/<model>
```

All selected, credentialed routes are discoverable—not only Anthropic models.
Messages, tools, tool results, images, streaming, and token estimates are
translated into the router's canonical `/v1/responses` request path, so the
same failover, usage accounting, provider credentials, and model selection
apply. Anthropic documents gateways for Claude models; non-Claude routed models
work through this compatibility layer but are not an Anthropic-supported Claude
Code configuration.

Claude models in Codex Router remain the other direction: enable
`anthropic-api` and store an Anthropic API key through the hidden prompt. A
Claude.ai subscription login is not converted into a reusable API credential.

…or `gemini` to act on the Gemini CLI integration:

```sh
./bin/model-router gemini enable         # publish the routed models
./bin/model-router gemini doctor
./bin/model-router gemini status
./bin/model-router gemini disable        # remove the managed block, keep the rest
```

…or `cursor` for Cursor Agent and Cursor App (quit Cursor before mutations):

```sh
./bin/model-router cursor enable --hostname cursor-router.example.com
./bin/model-router cursor doctor
./bin/model-router cursor status
./bin/model-router cursor disable
```

…or `claude` for Claude Code:

```sh
./bin/model-router claude enable
./bin/model-router claude doctor
./bin/model-router claude status
./bin/model-router claude disable
```
