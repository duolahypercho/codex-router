---
name: codex-router
description: Orientation for custom (non-OpenAI) models running in the Codex app through the codex-router proxy. Explains that the app's native tools arrive as flattened codex_app__ and mcp__ names, that the router restores them so the app executes them, which companion skills to read before threads, browser, or computer-use work, and that a turn with no tool call ends the task. Use when the session uses a custom (non-OpenAI) model, for example deepseek-v4-flash or mimo-v2.5, when codex_app__ or mcp__ tool names appear in the tool list, when a tool result just arrived and more work remains, or when thread, browser, or computer-use work is requested.
---

# Codex Router (custom models in the Codex app)

You are a custom model. The Codex app routes your traffic through codex-router.

## How your tools work

- The app's native tools appear in your tool list with flattened names:
  `codex_app__create_thread`, `codex_app__list_threads`,
  `mcp__node_repl__js`, `mcp__peekaboo__create_task`, and so on.
- Call them with exactly those names. The router restores the original
  namespace (for example `create_thread` in `codex_app`) before the app
  sees the call, so the app executes it natively.
- The router never executes an app tool. It only relays definitions and
  results. If a call fails, fix your arguments; do not try to run the tool
  yourself.
- Never spawn a side-channel driver. Do not start your own node_repl
  process, do not fake MCP metadata, do not write driver scripts. The tools
  you need are already in your tool list.

## Before each kind of work, read the matching skill

- Threads, automations, navigation: read `codex-app-threads`.
- In-app browser: read `codex-in-app-browser`.
- Computer use: read `codex-computer-use`.

## When a tool rejects your arguments

The app answers `received invalid arguments.` when you missed a required
field. Stop guessing. Read the matching skill for the exact shape, then
retry once with the correct arguments. Repeated guessing burns tokens and
turns.

## Golden rules

1. Use the tools you were given. Do not build workarounds.
2. Read the companion skill before the relevant work.
3. When a call fails, fix the arguments from the skill, then retry.
4. A turn with no tool call ends the task. After a tool result, if more work
   still needs a tool, call it in the same turn. Do not only announce the next
   step. Text-only is for when the user's request is fully done.

## Spawned threads and model inheritance

For a new local Codex thread, omit the `model` field unless the user
explicitly requested one. The router selects the parent routed model, while an
explicit model remains a separate user-visible task choice. In-session
subagents are always pinned to the routed parent's model because their tool
arguments are model-generated and must not silently cross a provider or billing
boundary. Follow-up messages retain the target thread's settings, and cloud
tasks choose their model outside this relay.

## What the token and usage numbers mean

- The router meter records provider-reported counts verbatim. When the
  provider reports `input_tokens: 0`, the router substitutes a byte-based
  estimate and stores it in a separate `estimatedInputTokens` field; the
  provider's zero is preserved in the row. Treat `estimatedInputTokens` as
  an approximation, never as a real provider count.
- A turn whose upstream stream dies mid-flight is recorded with status 502
  and a `streamAborted` marker. A client cancel records status 0. If you see
  many `streamAborted` rows, the upstream connection is flaky; do not treat
  them as model behavior.
- The app's displayed context window is 95% of the model's advertised
  window. The per-turn input number you see in the app can include the
  estimate; the running total can therefore exceed the real context usage.

## If the session seems to stop mid-task

Check the meter at `~/.codex/codex-router/usage-events.jsonl` for the
session's model first. Causes, in order of likelihood: a spawned thread died
on a native usage limit while the parent waited; an upstream stream dropped
mid-flight; the app compacted early on inflated estimated totals; the router
restarted. The router service restarts are normally supervised by launchd
and are not a production crash loop unless the log shows repeated exits
without an external trigger.
