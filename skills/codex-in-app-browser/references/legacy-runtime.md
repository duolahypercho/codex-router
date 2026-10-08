# Legacy in-app browser runtime

Use this path only when `mcp__cua_repl__js` is absent and
`mcp__node_repl__js` is exposed. Read the installed official skill first:

`~/.codex/plugins/cache/openai-bundled/browser/<version>/skills/control-in-app-browser/SKILL.md`

Find the latest installed version. Its instructions and the live tool schema
are authoritative. If the skill or required runtime is missing, report the
missing capability instead of building a substitute.

When the official skill uses `setupBrowserRuntime`, bootstrap once through
the exposed `mcp__node_repl__js` tool:

```js
if (globalThis.agent?.browsers == null) { const { setupBrowserRuntime } = await import("<plugin root>/scripts/browser-client.mjs"); globalThis.agent = await setupBrowserRuntime(); }
```

Replace `<plugin root>` with the installed browser plugin path. Then bind the
in-app browser and read its complete documentation before interacting:

```js
globalThis.iab = await agent.browsers.get("iab");
nodeRepl.write(await iab.documentation());
```

Reuse `agent` and `iab`. Follow the official runtime's one-line input or
`@file:<path>` with a trailing newline requirements where applicable. Use
documented browser APIs and honor enabled surfaces. Do not launch a separate
REPL or driver.
