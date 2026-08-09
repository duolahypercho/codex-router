---
name: codex-subagents
description: Set up, verify, and troubleshoot spawning subagents on non-OpenAI models through codex-router. Use when the user wants Codex to delegate work to subagents, asks which models can act as subagents, says spawning a subagent fails or picks the wrong model, or wants to orchestrate parallel agents across routed providers.
---

# Spawning subagents through codex-router

Codex can delegate a task to a subagent running on a different model. codex-router
decides which models Codex is allowed to pick. This skill covers getting the right
models offered, proving they actually work, and fixing it when they don't.

Run every command from the codex-router checkout.

## Start here, always

```bash
node .claude/skills/codex-subagents/subagent-report.mjs
```

This answers the only question that matters — *if I ask Codex to spawn a subagent
right now, what can it pick?* — and it is the one question `control subagents status`
does not answer. That command reports your **intent**. The merged catalog is what
Codex actually **reads**. They drift apart silently, and the report catches the drift.

If the report says a model is spawnable, it is offered to Codex. If it doesn't
appear there, nothing else you do in Codex will surface it.

## How a model becomes spawnable

A model carries `multiAgentVersion: "v2"` in the catalog. Three modes decide who gets it:

| Mode | Effect |
|---|---|
| `proven` | Only models the registry ships as verified. Conservative default. |
| `selected` | Proven models plus ones you explicitly turn on. **Use this.** |
| `all` | Every non-hidden model, regardless of whether it works. |

```bash
./bin/control subagents status                    # current mode, enabled, disabled
./bin/control subagents mode selected
./bin/control subagents set opencode-go/glm-5.2 on
./bin/control subagents set qwen-plan/qwen3.6-flash off
./bin/control subagents select-all                # turn every model on
./bin/control subagents unselect-all              # clear the list, back to a clean slate
```

An explicit `off` beats every mode, including `all`. That is how you keep a model
out without leaving `all` — verified: under `mode: all`, a model in `disabled`
still resolves to `v1`.

`unselect-all` is the fastest way out of a crowded list when the models you want
have been pushed past what Codex advertises.

**After any change:**

```bash
node src/catalog.mjs
```

then **fully quit and reopen Codex**. Not a new window — the whole app. Codex reads
the catalog at startup and caches it. Skipping this is the single most common reason
a change appears to do nothing, and the report flags it as `STALE`.

## Two traps that waste the most time

**Codex advertises only a small priority-ordered subset.** Turning on twelve models
does not give you twelve choices — it buries the ones you wanted behind ones you
didn't. The report prints models in Codex's ranking order and marks where the cut
probably falls. If a model you want sits far down that list, turn off the ones above
it rather than adding more.

**`mode all` is not "make everything work".** It advertises every model as capable,
including models that cannot drive Codex at all. A model that emits tool calls as
prose will be offered, accepted, and then fail mid-task with nothing useful in the
log. Prefer `selected` plus a real check.

## Proving a model actually works

Capability is not predictable from size, a tool-support flag, or a hand-written probe.
A 3B model that emits perfect tool calls on a short prompt answers *about* its
instructions when Codex's real ~24K-token prompt is in front of it. The only honest
test runs the real client:

```bash
./bin/control local-models agent-check <model-tag>     # local models
```

For a routed (non-local) model, call the same checker directly:

```bash
node --input-type=module -e '
import { checkAgentCapability } from "./src/agent-check.mjs";
console.log(JSON.stringify(checkAgentCapability(process.argv[1]), null, 2));
' "opencode-go/glm-5.2"
```

This runs `codex exec` through the router with the real prompt and tools, twice —
one run is luck, not a verdict. Verdicts:

| Verdict | Meaning |
|---|---|
| `agent` | Ran a tool, read real output. Safe to enable. |
| `text-tool-calls` | Emitted a tool call as prose. No client can dispatch it. |
| `invents-tools` | Called a tool that was never offered. |
| `no-tool-use` | Answered without using a tool. |
| `flaky` | Mixed across runs. Do not rely on it. |

**This spends provider quota** — it is a real turn against a real model. Get the
user's approval before running it, and say which provider it will bill.

## Spawning, once a model is offered

Ask Codex in plain language: *"spawn a subagent on glm-5.2 to audit src/router.mjs
for unhandled promise rejections."* Codex picks from the models the report listed.
There is no router-side command that spawns an agent — the router only controls
what Codex is allowed to choose.

For parallel work, ask for several in one message so they run concurrently rather
than in sequence.

## When it goes wrong

**Model not offered in Codex.** Run the report. Not listed → `subagents set <slug> on`,
rebuild, restart. Listed but far down → crowded out; turn off higher-priority models.

**Subagent starts, then fails or stalls.** Run the agent check. A `text-tool-calls`
or `invents-tools` verdict means the model cannot do this job; turn it off rather
than retrying.

**Change had no effect.** Almost always a missed `node src/catalog.mjs` or a Codex
that was never fully quit. The report's `STALE` line catches the first.

**Everything fails at once, on every model.** Not a subagent problem. Check the
router itself:

```bash
./bin/model-router codex doctor
```

A provider named in `enabled-providers.json` that this build doesn't know used to
502 every request while the process stayed alive and looked healthy. `doctor` now
reports it as a warning naming the ignored ids.

## Rules worth keeping

- Never set `multiAgentVersion: "v2"` in the checked-in registry to make something
  work locally. That claims support for every user. Local opt-in is
  `./bin/control subagents set`, which only changes this machine's catalog.
- The registry uses camelCase (`multiAgentVersion`); the merged catalog is Codex's
  wire format and uses snake_case (`multi_agent_version`). Reading the wrong key
  reports zero capable models on a healthy install.
- Curated models from `bin/curate-models` are **not** implicitly approved as
  subagents. They need an explicit `subagents set <slug> on`.
