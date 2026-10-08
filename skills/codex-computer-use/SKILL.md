---
name: codex-computer-use
description: Control available apps and browsers through the Codex app's Computer Use runtime. Use when the session uses a custom (non-OpenAI) model, for example deepseek-v4-flash or mimo-v2.5, and the user asks to control the computer, operate a desktop app's UI, use Chrome, click or type in an app, or inspect a screenshot. Prefer purpose-built connectors, APIs, or CLIs when they exist.
---

# Codex Computer Use

Prefer purpose-built connectors, APIs, or CLIs when they can perform the task.
For UI work, inspect the actual tool list before choosing a runtime:

- If `mcp__cua_repl__js` is exposed, use the current runtime below.
- Otherwise, if `mcp__node_repl__js` is exposed, read
  [the legacy runtime instructions](references/legacy-runtime.md).
- If neither is exposed, report the missing capability. Do not start a REPL
  process, write a side-channel driver, or synthesize MCP calls.

## Current runtime: cua_repl

Read the live tool instructions. The tool initializes `cua`; do not import
`@oai/sky` or bootstrap `agent.browsers` in this runtime.

On the first invocation, or after a reset, execute exactly one documented
entry-point API call, optionally assigning its result. Do not combine it with
another API call, a wait, a snapshot, or output helpers. Use the entry point
matching the user's requested surface; use `await cua.getState()` only when
an inventory is needed. Read the returned documentation and state before
continuing. For browser work, also read `codex-in-app-browser`.

Use only APIs described in the tool instructions or returned documentation.
Check which surfaces are enabled: browser access does not imply native app
control. If native APIs are disabled, report that limitation for a native app
task. Never guess screen contents or claim an unavailable surface is enabled.

Reuse the existing bindings. After compaction into a summary of an ongoing
computer-use task, call `await cua.rewriteDocumentation()` before continuing.
Follow the live tool's reset and output rules; the legacy runtime's imports
and one-line input rules do not apply here.
