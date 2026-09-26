# Adaptive subscription worker routing

Goal: evaluate request-boundary effort selection and task-boundary worker selection using existing Codex Router interfaces.

Architecture: an offline replay prepares typed Jev Choices and validates recorded or synthetic answers. Native requests retain their full payload and use the existing model/effort forwarding path. The existing official Claude Code bridge gains optional model and effort flags. No new server or credentials integration.

Stack: Node.js built-ins, existing node:test fixtures, existing Codex Router and Claude Code transports. No new dependencies.

Spec: the acceptance contract and scope below are the binding specification for this increment.

## Scope and constraints

- Implement an offline pilot and optional Claude flags. Automatic live dispatch is a later increment.
- Compare fixed routing, effort changes on one model, and model/harness choices at task boundaries.
- Once a task starts, keep its harness and model. Preserve its session when effort changes. A harness change starts a new session with an explicit handover supplied by the caller.
- Choices contain only explicitly supplied profiles. Model availability and permitted effort levels must be checked against the owning client's current capabilities before a live campaign.
- Invalid, missing or out-of-policy answers stop the replay. There is no automatic retry, paid fallback or quota crossover.
- Synthetic results prove contracts only. They do not measure quality, cache savings, subscription cost or provider availability.
- Preserve default bridge behaviour, prompt-on-stdin, CLI-owned authentication and existing permission restrictions. Do not add tools, token extraction or bare mode.
- No installed configuration changes, restarts, paid requests or vault writes.
- Use maintained open source interfaces. Prepare separable upstream contributions, beginning with Claude flag support. The archived jev-codex-router project is a design reference only.

## Task 1: Claude request controls

Owner: bridge implementer, files src/claude-agent-bridge.mjs, src/agent-bridges.mjs, their two test files, changelog.d/claude-agent-effort.md.

1. Add failing tests for model/effort flags on fresh and resumed sessions, omitted defaults, invalid flags rejected before spawn, overlapping prompts and non-Claude option rejection.
2. Add optional model/effort to prompt and CLI parsing. Validate a non-empty single model token and documented effort values low/medium/high/xhigh/max. Leave model-specific entitlement validation to the official CLI. Exclude ultracode because it also changes workflow.
3. Keep prompts off argv, tools disabled, permissions unchanged and sessions stable. Test public promptAgentBridge wiring through an injected bridge factory if needed.
4. Run focused bridge tests. Add a changelog fragment. Do not commit until whole-branch review.

## Task 2: Offline route replay

Owner: coordinator, files scripts/worker-routing-replay.mjs, test/worker-routing-replay.test.mjs, test/fixtures/worker-routing.json, docs/experiments/adaptive-worker-routing.md.

1. Add failing behavioural tests for fixed policy, effort changes with session reuse, model/harness pinning within a task, fresh sessions across harnesses, invalid Choice answers, unsupported profiles and duplicate request IDs.
2. Build a small pure replay in the script itself, with importable functions for testing. Use the documented Jev answers.route.choice and questions.route.criteria wire shapes. Do not add unused production selection modules.
3. Require explicit request and task identifiers, boundaries and configured profiles. Construct one Choice over eligible model/effort combinations. Replay recorded answers without any network or process execution.
4. Produce metadata-only results with simulated decisions and worker attempts clearly labelled. Preserve unknown costs as null, count rejected work separately from transport success, and report cache only from valid observed token counts.
5. Include a synthetic fixture covering both harnesses; tests cover all policies. Add a command and exact expected interpretation to the experiment guide.

## Task 3: Review and contribution preparation

1. Run the repository maintenance analyser, focused/adjacent tests, script syntax and npm run check. Exercise the Decisions forwarding regression with its loopback fake provider when dependencies permit.
2. Review the complete diff independently, fix findings and repeat affected checks.
3. Update this evidence ledger and publish no claim of live readiness without a capped, separately authorised trial.
4. Prepare a local commit and reviewable upstream contribution. Keep private workspace paths and source notes out of public files.

## Acceptance evidence

| ID | Observable outcome | Status | Evidence |
| --- | --- | --- | --- |
| A1 | The bridge passes optional model and effort flags to the Claude CLI command on new and resumed sessions | verified | Mock process argv tests; no live Claude prompt was sent |
| A2 | Existing bridge defaults and permission restrictions survive | verified | Claude and agent bridge tests, 14 passed |
| A3 | Offline effort changes keep model and session within a task | verified | Replay task and boundary tests |
| A4 | Invalid choices, duplicate attempts and unavailable profiles stop the replay | verified | Negative replay tests |
| A5 | Replay accounting marks unavailable cost/cache values unknown and records rejected work | verified | Synthetic fixture output, accounting and overflow tests |
| A6 | Affected contracts and the patch have been checked | verified | 49 focused/adjacent tests, 2 loopback router tests and `npm run check` passed; independent review found and prompted fixes for Choice privacy wording and numeric overflow. Full unrelated repository suite was stopped before completion due long-running account tests. |
| A7 | Live subscription execution and actual Jev/cache quality are measured | blocked | Needs a dispatcher, exact call/spend cap and verified billing path. No model request was sent. |

## Subsequent increments

1. Confirm official client readiness and exact available model/effort pairs without inference. Use existing login probes, not credential files.
2. Add an explicit dispatcher at the existing bridges boundary with cancellation and one accounted attempt per stage. Native Codex execution needs a real session adapter, not a fake Claude subscription model in the Codex picker.
3. Run paired tasks under fixed, effort-only and task-boundary routing. Score accepted work and corrections first, then latency, cache, usage and separate Jev charges. Set an exact call/spend cap before any paid trial.
4. Consider automatic request routing only after that evidence. Upstream each reusable improvement separately.
