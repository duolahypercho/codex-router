# Adaptive effort and subscription workers

This pilot checks routing contracts offline. It does not intercept live Codex requests or dispatch cross-harness coding agents.

## Reuse and contribution path

Use Codex Router's existing Decisions endpoint, native Responses forwarding and official Claude Code bridge. Keep improvements small enough to contribute separately. There is no new proxy, agent framework or dependency.

The [OpenRouter announcement](https://x.com/OpenRouter/status/2103611016735322148) describes [Jev Router](https://openrouter.ai/typesafe/jev-router), a chat route that selects a model and effort on OpenRouter. Its downstream inference uses OpenRouter billing. Subscription routing instead needs a decision followed by execution in the owning client's existing session.

[Antonio's experiment](https://x.com/antonioleivag/status/2100962426439000484) used [jev-codex-router](https://github.com/0xNatoshi/jev-codex-router). That repository was archived on 24 September 2026. Its ideas are useful, but a maintained Codex Router contribution is the preferred implementation path. His [follow-up](https://x.com/antonioleivag/status/2101086190363455551) reports cache problems. Those were different workloads, so they motivate measurement rather than establish a saving or regression rate.

## Run the offline replay

```sh
npm ci --ignore-scripts
node scripts/worker-routing-replay.mjs test/fixtures/worker-routing.json
node --test test/worker-routing-replay.test.mjs test/claude-agent-bridge.test.mjs test/agent-bridges.test.mjs
```

The fixture contains synthetic model names and supplied Jev answers. It makes zero live requests. Expect three simulated worker attempts, three simulated decisions, two accepted outcomes and one rejected outcome. Those outcomes are fixture labels, not evaluations of real models. Cache, duration, Jev cost and subscription cost are unknown.

Profiles enumerate approved harness/model/effort combinations. Their effort names are checked against the existing client vocabularies. This does not prove that a specific model, account or CLI version supports a combination. Verify those capabilities before supplying a live campaign manifest.

| Policy | Eligible choices |
| --- | --- |
| `fixed` | The initial profile throughout the replay; no Jev decision |
| `effort-only` | Different effort profiles on the initial harness and model |
| `task-boundary` | Any supplied profile for a new task, then effort changes on that task's model |

Every step has a unique request ID, task ID, session ID and explicit boundary. Continuing a task keeps its session. New tasks require new session IDs. A cross-harness transition also requires a caller-supplied handover summary. A sequence of completed requests is assumed; this file format is not a scheduler and cannot verify whether an external request is still running.

The prepared request uses the [Jev Decisions contract](https://openrouter.ai/docs/guides/community/jev-tutorial): `questions.route` is a Choice with profile IDs as criteria keys. The response is read from `answers.route.choice`. Missing, failed or out-of-policy answers stop replay without fallback. The `state` contains only explicitly supplied task and step summaries, boundary and current profile ID. The Choice criteria also contain each eligible profile's description, harness, model and effort. Review both summaries and profile descriptions before transmission. Raw conversation history is not copied automatically.

Reports omit summaries and raw answers. Keep identifiers free of personal information. `liveRequests: 0` describes the replay command. `simulatedDecisions` and `simulatedWorkerAttempts` describe the supplied sequence. Recorded or synthetic metrics remain labelled by `evidence`; changing a policy does not create valid counterfactual quality or cost measurements. Use separate real trials for each policy. Missing metrics remain `null`, failed/rejected work remains in the denominator, and cache hit rate is weighted by input tokens. No dollar value is inferred for subscription usage.

## Claude model and effort controls

The existing bridge now accepts optional `--model` and `--effort` for Claude:

```sh
printf '%s' 'Review the supplied excerpt.' |
  ./bin/model-router codex agents prompt anthropic --model sonnet --effort high --cwd "$PWD"
```

This command consumes the owning client's quota. Add `--session SESSION_ID` to resume an existing session. A later prompt may choose a different effort after the prior prompt finishes. The CLI's [model and effort flags](https://code.claude.com/docs/en/cli-reference) apply to that invocation. Supported effort levels depend on the selected model; an unsupported combination remains an official CLI error. `ultracode` is excluded because it also changes workflow.

Authentication stays inside the official CLI. Check `agents probe anthropic` before a trial. A successful login probe does not prove subscription entitlement, request success or billing mode for every launch. In particular, [an API key in the environment can select API billing](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan). This patch neither changes that environment nor promises subscription-only execution. Tools and foreground permission handling retain the existing bridge restrictions.

For native Codex, the existing Responses path already accepts `model` and `reasoning.effort` and normalises effort against available model metadata. This pilot displays those request options but does not alter the full task payload or the installed router.

## Next trial

First contribute the optional Claude controls with their regression tests. Keep the replay experimental until paired real tasks show useful results.

Before live dispatch, add cancellation and attempt accounting at the existing bridge interface, plus a real native Codex session adapter. Confirm exact client versions, capability pairs, account billing and per-task acceptance checks. Preserve full execution context while limiting the separate Jev decision state.

Then run the same bounded tasks with fixed routing, effort-only selection and task-boundary selection. Record accepted results, required corrections, failed attempts, duration, cache token counts, subscription usage where exposed and separate Jev charges. Request an exact call and spend cap before that campaign. Neither a changed effort setting nor a reused session guarantees cache retention.

The [implementation plan](../superpowers/plans/2026-09-26-adaptive-worker-routing-implementation.md) tracks the checks and remaining work.
