---
title: "opencode, pi, omp, Command Code, and Hermes"
description: "Five published-into clients, one publisher, one key each."
---
Five more coding clients keep their providers in a configuration document you
also own. The Control Center's Harness page lists each of them, and **Set up**
is the whole integration: install the client's CLI when this router can, then
write the one provider key the router owns into that document.

| Client | Document the router edits | Wire | Install |
| --- | --- | --- | --- |
| opencode | `~/.config/opencode/opencode.json` | Responses | `opencode-ai` |
| pi | `~/.pi/agent/models.json` | Responses | `@earendil-works/pi-coding-agent` |
| omp (oh-my-pi) | `~/.omp/agent/models.yml` | Responses | install omp yourself first ([omp.sh](https://omp.sh/); it runs on Bun) |
| Command Code | `~/.commandcode/providers.json` | Anthropic Messages | `command-code` 1.30.0 or later (setup updates an older one) |
| Hermes Agent | `~/.hermes/config.yaml` | Anthropic Messages | install Hermes yourself first |

opencode honours `OPENCODE_CONFIG`, pi and omp both honour
`PI_CODING_AGENT_DIR`, and omp's `models.yaml` is edited in place when it has
no `models.yml` beside it, so the router writes the file each client actually
reads.

From the terminal, the same action is one command per client:

```sh
./bin/control client-setup opencode
./bin/control client-setup pi
./bin/control client-setup omp
./bin/control client-setup commandcode
./bin/control client-setup hermes

./bin/control client-disconnect opencode
```

**Keeping them current is its own command.** Setup installs a client that is
missing, but deliberately leaves one that is already there at the version you
have — bumping a global coding agent is not something that should happen
because you republished a model list. To move them:

```sh
./bin/control client-update opencode   # runs `opencode upgrade`
./bin/control client-update --all      # every client you actually have
```

Each runs the client's *own* updater (`opencode upgrade`, `pi update --self`,
`command-code update`, `hermes update --yes`) rather than `npm install -g`, so
a CLI you installed with Homebrew or a `curl | sh` script is updated in place
instead of gaining a second npm copy that may win or lose on PATH. omp has
neither, so its row prints the project's own installs. `--all` skips clients
you have not installed and reports each one rather than stopping at the first
failure. The Harness page has the same thing as an **Update** button per row
and **Update all** in the header.

Each client is published *into* rather than installed *as*: there is no
`MODEL_ROUTER_TARGET` for these five and no second service. They share the
router plane every other client uses, so enabling a provider, storing a key, or
curating a model republishes all of them together and no picker is left
advertising a model the others just lost.

**The wire is one the router already serves.** Clients that speak the Responses
API are pointed at the authenticated loopback `/v1` path with the router's own
slugs. Command Code and Hermes have no Responses client, so they are pointed at
the same Anthropic Messages surface Claude Code uses, with
`codex_router/anthropic/<router-slug>` ids. No client is handed a protocol the
router does not implement.

**The router owns one key and nothing else.** That is
`provider.codex-router` (opencode, Command Code) or `providers.codex-router`
(pi, omp, Hermes), plus a private publication marker in the router's own state
directory. YAML documents are spliced by line range rather than parsed and
rewritten, so comments, hand-formatting, and every sibling provider survive a
publish. A JSON document the router cannot round-trip — one carrying `//`
comments, or an `opencode.jsonc` sitting beside `opencode.json` — is refused
with an explanation rather than reformatted.

A `codex-router` provider whose base URL this router did not issue is treated
as somebody else's: both setup and disconnect refuse rather than overwrite it.
opencode's default model is claimed only when you have not chosen one, and is
released again the moment you pick your own. Every published document is
written `0600`, because the base URL carries the local caller capability as a
path segment.

Removing one of these clients never retires the shared service while another
client is still pointed at it:

```sh
./bin/control client-disconnect hermes
```
