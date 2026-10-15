# Qwen compaction prompt provenance

The structured prompt and continuation trailer in this directory are adapted from Qwen Code at commit `1162ed9c0abef18398269367ad378b2ba9091eb7`:

- `packages/core/src/core/prompts.ts`, `getCompressionPrompt()` at lines 757-803
- `packages/core/src/services/postCompactAttachments.ts`, `RESUME_TRAILER` and `postProcessSummary()` at lines 476-545

Primary source: https://github.com/QwenLM/qwen-code/tree/1162ed9c0abef18398269367ad378b2ba9091eb7

The official 167-byte `RESUME_TRAILER` is preserved verbatim. The prompt keeps the upstream nine-section `state_snapshot` structure and is modified for Codex to:

- account for user requests retained by Codex after compaction;
- directly extract recorded working state without re-solving, adding findings, or emitting scratchpad text;
- omit credential, token, and one-time authentication callback values while preserving nonsecret status and intent;
- distinguish completed operations from current blockers and pending work; and
- preserve the most recent user steering and still-applicable prior constraints.

The upstream files carry `SPDX-License-Identifier: Apache-2.0`. `prompts.ts` states `Copyright 2025 Google LLC`; `postCompactAttachments.ts` states `Copyright 2025 Qwen Team`. This directory includes the upstream Apache License 2.0 text in `LICENSE`.

The continuity revision also adapts principles from these pinned public references:

- Codex commit `97ebf2d94d62e2ff2045f3ea17b6e11eae9a21fb`, [`codex-rs/models-manager/models.json`](https://github.com/openai/codex/blob/97ebf2d94d62e2ff2045f3ea17b6e11eae9a21fb/codex-rs/models-manager/models.json) (final-response contract) and [`codex-rs/prompts/templates/compact/prompt.md`](https://github.com/openai/codex/blob/97ebf2d94d62e2ff2045f3ea17b6e11eae9a21fb/codex-rs/prompts/templates/compact/prompt.md).
- Piebald-AI/claude-code-system-prompts commit `0b7ce11f583dc8777241e16ea482e69450375f11`, `system-prompts/agent-prompt-conversation-summarization-short-variant.md` and `system-prompts/system-prompt-outcome-first-communication-style.md`: https://github.com/Piebald-AI/claude-code-system-prompts/tree/0b7ce11f583dc8777241e16ea482e69450375f11

The adapted prompt emphasizes file/finding/fix/verification evidence, material older state, rejected approaches, and an intent/authorization ledger without duplicate transcript history. The runtime final-response guidance in `src/qwen-compaction.mjs` uses outcome-first, self-contained reporting, groups evidence and limitations, reports completed changes with verification and important unrun checks, and preserves explicit output formats. These are scoped router instructions, not imported product identities, tool contracts, or an assertion that a generated checkpoint is semantically complete.
