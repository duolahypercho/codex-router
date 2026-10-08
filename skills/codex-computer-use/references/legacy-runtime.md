# Legacy computer-use runtime

Use this path only when `mcp__cua_repl__js` is absent and
`mcp__node_repl__js` is exposed. Read the installed official skill first:

`~/.codex/plugins/cache/openai-bundled/computer-use/<version>/skills/computer-use/SKILL.md`

Find the latest installed version. Its instructions and the live tool schema
are authoritative. If the skill or required runtime is missing, report the
missing capability instead of building a substitute.

When the official skill uses `@oai/sky`, load it once through the exposed
`mcp__node_repl__js` tool:

```js
globalThis.sky = (await import("@oai/sky")).sky;
nodeRepl.write("sky: " + typeof sky);
```

Confirm `sky: object` before continuing and reuse the binding. Follow the
official runtime's one-line input or `@file:<path>` with a trailing newline
requirements where applicable. Follow the app's computer-use approvals and
enabled-surface restrictions. Do not launch a separate REPL or driver.
