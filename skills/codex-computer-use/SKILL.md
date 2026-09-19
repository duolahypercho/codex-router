---
name: codex-computer-use
description: Control local apps through the Codex app's Computer Use runtime. Use when the user asks to operate a desktop app or take a screenshot; prefer a purpose-built API or CLI when one exists.
---

# Codex Computer Use

The runtime is `@oai/sky`, imported through `mcp__node_repl__js` (available
in this session).

## First: read the official skill

The official skill is authoritative. Read it before any computer-use work:

`~/.codex/plugins/cache/openai-bundled/computer-use/<version>/skills/computer-use/SKILL.md`

Find the latest `<version>` directory.

## Load the runtime (once per session)

Send this as ONE line through `mcp__node_repl__js`:

```js
globalThis.sky = (await import("@oai/sky")).sky;
nodeRepl.write("sky: " + typeof sky);
```

Confirm the output says `sky: object` before continuing. The import
connects to the SkyComputerUseService, which is already running.

## Rules

- Send code as ONE line, or use `@file:<path>` with a trailing newline.
  The runtime fires on newline; input without a trailing newline silently
  does nothing.
- Reuse the loaded `sky` runtime on later turns. Do not reinitialize.
- The first computer-use action may need approval in the app
  (Settings → Computer use). Common apps such as Safari and Chrome are
  usually pre-approved.
- Prefer purpose-built connectors, APIs, and CLIs over computer use when
  they exist. Computer use is for reading or operating app UI that nothing
  else can reach.
- Never start your own node_repl process and never write a side-channel
  driver. Use the tool you were given.

## If the tool is missing

Stop and report that `mcp__node_repl__js` is not in the tool list. Do not
build workarounds.
