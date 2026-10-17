# Codex edit concurrency: ownership and reproducible evidence

## Why the catalog does not disable parallel calls

Codex deliberately removed `ModelInfo.supports_parallel_tool_calls` in
[86b1123 (2026-08-14)](https://github.com/openai/codex/commit/86b1123ff6b5d089a146be4e603a324cf454223a).
Regular generation and remote compaction now enable parallel calls without
consulting model metadata. Responses Lite retains its separate restriction;
selecting that protocol to force serialization would change an unrelated
contract. Router retains the old catalog field for older clients, rather than
mistaking it for a current scheduling control.

The request flag permits multiple model-authored calls. It does not specify
whether the client executes those calls concurrently. At the reviewed official
source revision
[`ce0323f`](https://github.com/openai/codex/tree/ce0323f2f2d3b25e82806cd555237da3db4e1897):

- [`ToolCallRuntime`](https://github.com/openai/codex/blob/ce0323f2f2d3b25e82806cd555237da3db4e1897/codex-rs/core/src/tools/parallel.rs)
  uses a shared/exclusive lock according to the registered tool's parallel
  capability. The lock covers an invocation, not a process lifetime or all chats.
- [`exec_command`](https://github.com/openai/codex/blob/ce0323f2f2d3b25e82806cd555237da3db4e1897/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs)
  and `write_stdin` advertise parallel support unconditionally. The scheduler
  therefore allows two arbitrary shell programs to modify the same file.
- Native `apply_patch` uses the default exclusive invocation policy and verifies
  expected source context. That is not a workspace-wide transaction, exact
  version comparison, or protection against other processes/chats.

The source snapshot is not asserted to be byte-identical to the installed
Desktop binary. Its behavior was independently measured below.

## Installed-client evidence (2026-10-17)

Codex **0.162.0-alpha.17.2** was driven through Router, locked LiteLLM 1.96.2,
Grok forwarder and a mock xAI provider. Each case supplies two tool calls in one
response, then checks both actual tool outputs and the filesystem in the next
request. Catalog `false` produced wire `true` at ingress and upstream in all
three cases. No live model, OAuth session or quota was used.

| Case | Asserted result | Meaning |
| --- | --- | --- |
| `read` | Both calls read the original file and reach a shared barrier before either can finish | Useful parallel execution is real; synchronization markers are the only writes |
| `race` | Both shell calls read `old`, exit 0, A writes `old+A`, then B writes its stale `old+B`; final contents omit A | A lost update is reproduced in the actual native execution chain |
| `patch` | One expected-context patch succeeds and one reports a conflict; either may win | This typed edit path surfaces the stale-input conflict instead of silently losing a write |

Each case completes in **two provider requests**. Barriers, call IDs, exit
status, feedback and final bytes are asserted; elapsed time alone is not the
oracle. The `race` diagnostic intentionally asserts an existing failure. A
client fix should make it fail until the expected result is deliberately
updated. It is not a regression test claiming that lost updates are desirable.

Run separately for `read`, `race`, and `patch`:

```sh
node scripts/verify-grok-apply-patch-guidance.mjs /path/to/locked/venv/bin/python \
  --structured --native-tool-policy --native-scheduler=race \
  --codex=/path/to/codex
```

This creates an isolated home, workspace, gateway and fake provider. Native
workspace-write permissions remain enabled; an outer sandbox must permit those
temporary writes. A barrier has an eight-second deadline. Verification was on
macOS; Windows execution of these additional diagnostics is not claimed.
The existing `--native-tool-policy` mode still checks three dependent edits in
four requests, without supplying concurrent actions.

## What a root fix needs to own

The model chooses whether to use unsafe parallel whole-file replacements; the
client executor allows them; Router faithfully relays them. This is not evidence
of duplicate dispatch by Router or a measure of how often Grok makes that choice.
Typed editing already reaches the native executor through the current bridge.

A complete correction belongs at the client execution/filesystem boundary:

1. Trusted, enforced read-only operations may share access. Structured edits
   need canonical resource identity, exclusive access to conflicting resources,
   and validation of the expected content/version within the protected write.
   Disjoint resources can retain parallel execution. A model's declaration of
   being read-only is insufficient for an arbitrary program.
2. Unknown-effect shell programs need a conservative workspace policy or an
   enforced restricted filesystem capability. A command-text regex cannot
   establish their actual effects. Long-lived servers and build output require
   an explicit scope/lifetime design rather than an indefinite blanket lock.
3. A write lease must follow a yielded process until its process tree exits or
   is canceled. Returning `session_id` and dropping an invocation lock leaves
   the original race possible. Polling must not deadlock behind the lease of
   the process it is waiting for. Cross-chat protection requires a shared
   coordinator; external writers require version/conflict detection too.

Changing the catalog, forcing `parallel_tool_calls=false`, prompt advice, or
serializing only HTTP requests does not implement this contract. Router cannot
add these guarantees without taking over native execution and its permission
boundary. No native-client scheduling fix or performance gain is claimed by
this diagnostic update; the installed Codex still permits the reproduced shell
race.
