---
title: "OpenClaw"
description: "Publish a router-owned Responses provider into OpenClaw."
---
The `openclaw` target is the one-click path from the Control Center's Harness
page. **Set up** installs the official `openclaw@latest` npm package when it is
missing, then publishes every selected, credentialed router model under one
OpenClaw provider:

```sh
./install.sh --target openclaw --auto --providers configured
# or add OpenClaw to an existing router
./bin/model-router openclaw enable

openclaw
```

The router owns only `models.providers.codex-router` and a private publication
marker. It writes the provider through `openclaw config patch --stdin`, so the
local caller capability never appears in command arguments. Existing OpenClaw
agents, channels, plugins, and other providers stay untouched. If no default
model exists on first setup, the router selects its highest-priority route; an
existing default or a later user override is preserved.

OpenClaw model references use `codex-router/<router-slug>` and speak
`openai-responses` to the same authenticated loopback path as the other local
clients. Context windows, text/image input, and the router's exact reasoning
effort ladder are published with each model. Disable removes only the managed
provider and removes the default only when it is still the value the router
set:

```sh
./bin/model-router openclaw doctor
./bin/model-router openclaw status
./bin/model-router openclaw disable
```

OpenClaw's AgentHarnessV2 API is a native runtime-plugin boundary, not a new
HTTP model protocol. The router therefore remains an ordinary Responses model
provider; when no native plugin claims the route, OpenClaw correctly uses its
embedded runtime. No restart is required after publication.

The optional live check makes one small request per selected provider and may
consume paid quota:

```sh
./bin/model-router codex smoke-test --yes
```

`disable` removes only the selected client integration and retires the shared
service only when no installed client still uses it.
`uninstall` intentionally retains the checkout, logs, backups, internal keys,
and provider credentials so routine removal cannot destroy authentication or
recovery data.
