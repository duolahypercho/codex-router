# Making a route usable as a subagent

A model can only be spawned as a Codex subagent if its exact `provider/model`
route is `multiAgentVersion: "v2"`. Everything else in this file is about how a
route gets there, and how to avoid paying to measure the same route twice.

Read this before changing anything under `src/subagent-*.mjs`, `v2_agent/`, or
the Subagents column in the Control Center.

## What "v2" is, and what "v1" is not

`v2` means the route provably carries Codex's native collaboration: the parent
delegates through the encrypted payload relay, the child answers, and it answers
again on a follow-up in the same thread.

`v1` is **not** a lesser working mode. Nothing spawns a v1 route as a subagent:

```js
// src/multi-agent-state.mjs
subagentEligibleModels → model.multiAgentVersion === "v2"
```

and only eligible models get an agent definition written into
`~/.codex/agents/`. A route without a definition cannot be spawned by name at
all. In the registry almost every route has **no** `multiAgentVersion` field;
`"v1"` is the publication default (`multiAgentVersion || "v1"`), so a route
showing v1 means "not certified yet", never "reviewed and rejected".

## The five checks

From `v2_agent/README.md`, in the order a reviewer reproduces them:

| Check | What it proves |
|---|---|
| `streaming` | a streamed Responses turn emits text and completes |
| `toolCall` | a forced function call returns the requested name and valid JSON arguments |
| `encryptedRelay` | a native Codex parent delegates a child through the encrypted payload relay |
| `markerReturn` | the child returns an exact marker |
| `sameThreadFollowUp` | a same-thread follow-up returns a second marker |

Checks 1–2 are cheap and prove almost nothing about delegation. **Never treat
them as evidence of native collaboration** — a route can stream and call tools
perfectly and still fail the relay. That confusion is the whole reason the
promotion gate exists.

## Three ways a route becomes v2

1. **The operator selects it.** This is the ordinary path and the one almost
   everyone uses. `subagents mode selected` plus `subagents set <slug> on`
   promotes that route, writes its agent definition, and Codex can spawn it by
   name. `mode all` does the same for every non-hidden route. See
   `.claude/skills/codex-subagents/SKILL.md`; `applyMultiAgentSettings` is where
   it happens.
2. **The registry.** `multiAgentVersion: "v2"` checked in, alongside an accepted
   `v2_agent/` application. This ships to every installer, so nobody has to
   select it.
3. **A completed local verification.** All five checks passing in one run on
   this machine, recorded in `~/.codex/codex-router/multi-agent-proofs.json`.

An explicit `off` beats all three, and a hidden model is never promoted.

What is **not** a fourth way: the legacy diagnostic statuses in the proofs file
— `candidate`, `experimental`, `proven` — promote nothing, and never have.

> **This regressed once.** `applyMultiAgentSettings` only ever demoted: it read
> `disabled` and `hidden` and nothing else, so modes 1 and its `all` sibling
> were inert and every selection an operator had made was silently discarded.
> An install with twenty routes enabled had four spawnable and one agent
> definition on disk. If you are changing that function, the modes are the
> feature, not a formality — and `subagent-report.mjs` is how you check.

## Signed routing is not itself subagent certification

An older root-OpenAI signed-routing run could not complete checks 3–5 while
Codex was signed in with a ChatGPT account. Codex rejected the routed child in
the parent's own message:

```
The '<provider>/<model>' model is not supported when using Codex with a
ChatGPT account.
```

That result records as **deferred** — never as a refusal — because it did not
exercise the route's collaboration transport. Do not "fix" it by relaxing the
promotion gate.

Current Codex validates an external model id against the selected provider
before it sends an ordinary request. On Codex CLI 0.153.4, with `codex login
status` reporting `Logged in using ChatGPT`, the explicit signed-routing switch
uses the dedicated `codex-router-signed` provider and clears that top-level
provider/model validation while retaining `requires_openai_auth = true`. The
ordinary request then reaches the router's `/v1/responses` edge. This is useful
request-routing evidence, but it is not evidence for any of checks 3–5.

Two things still do not constitute certification:

- **Signed routing** (`set_signed_routing`) establishes the provider/transport
  precondition for ordinary routed turns. No route becomes v2 merely because
  that switch is on; a complete five-check run is still required.
- **Marking the candidate v2 in the catalog** is already done: Codex only
  offers a subagent for a route its catalog marks v2, so the run builds a
  private catalog copy with just the candidate marked. That clears an earlier
  "not supported with the current ChatGPT account" error and gets as far as the
  older root-OpenAI refusal above. A catalog claim alone does not get past it.

The dedicated signed-provider path has not yet completed all five checks under
a ChatGPT account, and the API-key path has not been verified either. Both
remain uncertified and may spend separate quota. Verify before promising either
one works.

## What has already been verified, and what has not

Do not re-run these. They cost quota and the answers are recorded here.

| Question | Answer | Evidence |
|---|---|---|
| Does the caller endpoint serve `chat/completions`? | **No.** It answers Responses at `<callerBase>/responses` and takes the caller key as a bearer. | A 404 was once reported to the operator as "this model cannot run subagents". |
| Can a route stream through the router? | **Yes** for every route tried. | `deepseek/deepseek-v4-flash-vision-exp` returned HTTP 200 with a real SSE stream. |
| Does a forced `tool_choice` work everywhere? | **No.** A reasoning route can reject the forcing mode itself — *"Thinking mode does not support this tool_choice"* — while calling the tool correctly when simply offered it. | `opencode-go/deepseek-v4-flash-vision-exp`: forced → 400, `auto` → 200 with `{"token": "ok"}`. Codex does not force tool_choice in ordinary use. |
| Can checks 3-5 complete under a ChatGPT account? | **Not established.** The older root-OpenAI attempt was deferred; the dedicated signed-provider path has no complete five-check record. | See the versioned evidence above. |
| Does marking the candidate v2 in a private catalog help? | **Partly.** It clears an earlier "not supported with the current ChatGPT account" error and gets as far as the refusal above. It does not get past it. | Already implemented in the runner. |
| Is signed routing enough to certify a route? | **No.** It fixes ordinary provider/model validation only; promotion still requires all five checks. | `managedSignedProviderBlock` and `verifiedForRoute`. |
| Do Ox Alpha, Fugu Ultra or Inkling have a registry certification? | **No.** The registry has seven v2 routes and none of them is one of these. | They reach v2 through operator selection instead. |

Statuses that answer about the account or the moment — 401, 402, 403, 408, 429,
5xx, aborts and timeouts — are recorded as **deferred**, never as a refusal, and
a deferred run clears its record so the switch stays retryable. Only a reply the
provider actually sent can refuse a route.

## Turning a route on

From the Control Center: expand a model and flip the switch in the **Subagents**
column. That selects the route, the router republishes it as v2, and its agent
definition is written — one click from off to spawnable. The same thing from the
CLI:

```bash
bin/model-router codex subagents set <provider>/<model> on
node src/catalog.mjs                 # publish; the Control Center does this for you
```

Then **fully quit and reopen Codex**. It reads the catalog at startup and caches
it; skipping this is the most common reason a change looks like it did nothing.

Neither costs quota. Selection is a statement of intent, not a capability claim
— `mode all` is documented as advertising every route "regardless of whether it
works" — so verify a route before relying on it:

```bash
node --input-type=module -e '
import { checkAgentCapability } from "./src/agent-check.mjs";
console.log(JSON.stringify(checkAgentCapability(process.argv[1]), null, 2));
' "opencode-go/glm-5.2"
```

## Gathering evidence for the registry

Separately from turning a route on, the five-check run produces the artifact a
`v2_agent` application needs:

```bash
bin/model-router codex subagents certify <provider>/<model> [<provider>/<model> ...]
```

**This spends real quota**: two HTTP turns per route, then a Codex parent turn
plus child turns, twice. Routes are checked in parallel; the recording and the
republish happen once, after them. A run stops at its first failure, so a route
that cannot stream never pays for a delegation. On a complete pass it writes
`v2_agent/<provider>/<model>/proof.json` and promotes the route locally.

## Don't measure the same route twice

This is the part that matters for cost.

- **Same machine.** The verified record persists. It does **not** expire on a
  router upgrade — what the checks measure is the provider route, and a patch
  bump does not change the provider. `PROOF_EPOCH` in `src/subagent-proofs.mjs`
  exists to invalidate records deliberately if a future change makes old
  evidence untrue; do not add per-version expiry back.
- **Everyone else.** A passing run writes
  `v2_agent/<provider>/<model>/proof.json` with the real outcomes and
  timestamps. Commit it, open the PR, and once it is accepted **with the
  matching registry change in the same PR**, every installer gets the route as
  v2 and nobody runs the checks again.

So the intended lifecycle is: verify once locally → the artifact is written for
you → PR → registry → nobody pays again.

## Rules for agents changing this code

1. **Never promote on partial evidence.** `verifiedForRoute()` requires all five
   checks passing, the record's slug matching the route exactly, and the current
   epoch. A run that reached three checks must leave a record that promotes
   nothing.
2. **A record promotes only its own route.** `deepseek/deepseek-v4-flash` and
   `openrouter/deepseek-v4-flash` are separate applications: different
   credential, adapter, and tool handling.
3. **A local pass never sets `status: "accepted"`.** Only the PR that also moves
   the registry entry may do that.
4. **Never write secrets into an application.** Outcomes, HTTP statuses, and
   timestamps only. No prompts, response bodies, decrypted payloads, or
   credentials — CI refuses evidence that looks credential-shaped.
5. **Call the endpoint the router serves.** The caller base already ends in
   `/v1`; the router answers Responses at `<callerBase>/responses` and takes the
   caller key as a bearer. `chat/completions` is not served — posting there
   returns 404, which once got reported to the operator as "this model cannot
   run subagents".
6. **Never offer a control that cannot change the outcome.** The Subagents
   column previously showed a "Test subagents" switch whose best case was
   relabelling a route from `Untested` to `Awaiting certification` — still
   unusable. If a control cannot produce the result its label implies, remove it
   or make it produce that result.
7. **Do not show the machinery.** The reader chooses a model; they should never
   need to know what "v2", "relay", or "certification" mean to do it.

## Where things live

| Path | Role |
|---|---|
| `src/subagent-proofs.mjs` | the record store and the promotion gate (`verifiedForRoute`, `applySubagentProofs`) |
| `src/subagent-certify.mjs` | the five-check runner, and the application writer |
| `src/subagent-verify.mjs` | the older cheap two-request probe — **diagnostic only**, do not conflate with the above |
| `src/multi-agent-state.mjs` | resolves effective v2 claims for catalog, agents dir, and doctor |
| `v2_agent/` | applications; the review gate for shipping a route to every installer |

## Tests that must keep passing

- `test/subagent-local-verification.test.mjs` — the promotion gate, including
  the exact failure it exists to prevent (checks 1–2 pass, delegation never ran)
- `test/subagent-certify.test.mjs` — the runner's decision logic and endpoint,
  including the false pass where a parent repeats the marker from its own prompt
- `test/subagent-ui.test.mjs` — that the Control Center never offers a control
  implying a local probe can promote a route
