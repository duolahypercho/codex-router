---
name: codex-in-app-browser
description: "Drive the Codex in-app browser: open, navigate, click, type, screenshot, and read page state. Use when the task needs the app's browser, such as testing a local page."
---

# Codex In-App Browser

The tool is `mcp__node_repl__js`. It is available in this session.

## First: read the official skill

The official skill is authoritative. Read it before any browser work:

`~/.codex/plugins/cache/openai-bundled/browser/<version>/skills/control-in-app-browser/SKILL.md`

Find the latest `<version>` directory (for example `26.803.41515`).

## Bootstrap (once per session)

Send this as ONE line through `mcp__node_repl__js`:

```js
if (globalThis.agent?.browsers == null) { const { setupBrowserRuntime } = await import("<plugin root>/scripts/browser-client.mjs"); globalThis.agent = await setupBrowserRuntime(); }
```

Replace `<plugin root>` with the browser plugin path. Then bind the
in-app browser and read its documentation:

```js
globalThis.iab = await agent.browsers.get("iab");
nodeRepl.write(await iab.documentation());
```

Read the complete documentation output before interacting with the page.

## Rules

- Send code as ONE line, or use `@file:<path>` with a trailing newline.
  The runtime fires on newline; input without a trailing newline silently
  does nothing.
- Reuse the existing `agent` and `iab` bindings on later turns. Do not
  reinitialize.
- `open_in_codex` only OPENS a tab. It cannot click, type, or read. Use
  `mcp__node_repl__js` for interaction.
- Never start your own node_repl process and never write a side-channel
  driver. Use the tool you were given.

## If the tool is missing

Stop and report that `mcp__node_repl__js` is not in the tool list. Do not
build workarounds.
