---
name: codex-in-app-browser
description: Drive the Codex in-app browser to open, navigate, click, type, inspect, or screenshot pages. Use when the session uses a custom (non-OpenAI) model, for example deepseek-v4-flash or mimo-v2.5, and the user asks to use the in-app browser or test a page in the Codex browser panel.
---

# Codex In-App Browser

Inspect the actual tool list:

- Prefer `mcp__cua_repl__js` when exposed, following the current runtime below.
- Otherwise, if `mcp__node_repl__js` is exposed, read
  [the legacy browser instructions](references/legacy-runtime.md).
- If neither is exposed, report the missing capability. Do not start another
  REPL, install a browser driver, or synthesize MCP calls.

## Current runtime: cua_repl

Read the live tool instructions. The tool initializes `cua`; do not import
the old browser client or initialize `agent.browsers`.

The first invocation, or the first after a reset, must contain exactly one
documented entry-point API call, optionally assigning its result. Choose the
first matching option in the live instructions for the user's tab mention,
existing tab, or specified browser. Reuse an existing tab when requested;
use its observed ID or URL instead of inventing one.

For a new page explicitly requested in the Codex in-app browser:

```js
let tab = await cua.createBrowserTab("iab", url, { visible: true });
```

Here `url` is the requested URL. Do not add another API call, a wait, a
snapshot, or output helpers to this initial invocation. Read the returned
documentation and initial UI state before interacting. Selecting a browser
alone does not open a tab.

Use only documented browser APIs, and inspect fresh page state to choose
interaction targets. Reuse existing bindings; after compaction into a summary
of an ongoing browser task, call `await cua.rewriteDocumentation()` before
continuing. Follow the live tool's reset and output rules.

`open_in_codex` can show a tab but cannot inspect or interact with its page.
Use the exposed browser runtime for those operations. Honor the enabled
surfaces and the user's browser choice; do not substitute a different browser
or claim native app control is available merely because a browser is enabled.
