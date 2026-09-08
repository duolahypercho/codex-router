import assert from "node:assert/strict";
import test from "node:test";

import {
  CHECKPOINT_WARNING,
  COMPACTION_PROMPT,
  decodeCompaction,
  encodeCheckpoint,
  finalizeCheckpoint,
  KCR1_PREFIX,
  KCR2_PREFIX,
  LEGACY_V1_SUMMARY_PREFIX,
  LEGACY_WARNING,
  prepareCompaction,
  renderCheckpoint,
  renderCompactionValue,
} from "../src/compaction-checkpoint.mjs";

function message(role, text) {
  return { type: "message", role, content: [{ type: `${role === "user" ? "input" : "output"}_text`, text }] };
}

function call(id, name = "exec_command", args = "{}") {
  return { type: "function_call", call_id: id, name, arguments: args };
}

function output(id, value) {
  return { type: "function_call_output", call_id: id, output: value };
}

function modelSummary(overrides = {}) {
  return JSON.stringify({
    objective: "Continue the requested task.",
    requirement_refs: ["U001"],
    attempt_refs: ["C001"],
    observation_refs: ["R001"],
    unverified: [],
    unknowns: [],
    blockers: [],
    next_step: "Re-read current state before changing it.",
    ...overrides,
  });
}

function rawKcr2(checkpoint) {
  return KCR2_PREFIX + Buffer.from(JSON.stringify(checkpoint), "utf8").toString("base64");
}

test("describes C as a tool-call request without claiming execution started", () => {
  assert.match(COMPACTION_PROMPT, /model requested a tool call/u);
  assert.match(COMPACTION_PROMPT, /does not prove that execution started or completed/u);
  assert.doesNotMatch(COMPACTION_PROMPT, /tool was attempted/u);
});

test("compaction prompt forbids copying example strings into objective", () => {
  // Muse Spark 1.3 copied the old example objective "short navigation only"
  // verbatim and failed the live compatibility probe; placeholders must stay
  // visibly non-copyable and the prompt must say so.
  assert.match(COMPACTION_PROMPT, /Angle-bracket placeholders above are shape only/u);
  assert.match(COMPACTION_PROMPT, /Never copy them into the JSON/u);
  assert.match(COMPACTION_PROMPT, /preserve an opaque token in the objective/u);
  assert.doesNotMatch(COMPACTION_PROMPT, /"objective": "short navigation only"/u);
});

test("records process failure without inventing an SSH cause or external side effect", () => {
  const prepared = prepareCompaction([
    message("user", "Check the production SSH path."),
    call("ssh-1", "exec_command", '{"cmd":"ssh production"}'),
    output("ssh-1", JSON.stringify({ output: "", exit_code: 255 })),
  ]);
  const checkpoint = finalizeCheckpoint(
    modelSummary({
      unknowns: [
        "Why SSH failed.",
        "Whether the request reached production.",
        "Current production state.",
      ],
    }),
    prepared,
  );

  assert.deepEqual(checkpoint.source_refs.observations, ["R001"]);
  assert.equal(checkpoint.sources.R001.tool, "exec_command");
  assert.equal(checkpoint.sources.R001.outcome, "exit_nonzero");
  assert.equal(checkpoint.sources.R001.exit_code, 255);
  assert.deepEqual(checkpoint.orientation.unknowns, [
    "Why SSH failed.",
    "Whether the request reached production.",
    "Current production state.",
  ]);
});

test("keeps model conclusions unverified and rejects fabricated or misclassified references", () => {
  const prepared = prepareCompaction([
    message("user", "Deploy only after verification."),
    message("assistant", "The deployment definitely succeeded."),
    call("deploy-1"),
    output("deploy-1", JSON.stringify({ exit_code: 1, output: "operation successful" })),
  ]);
  const checkpoint = finalizeCheckpoint(
    modelSummary({
      requirement_refs: ["C001"],
      attempt_refs: ["C001"],
      observation_refs: ["A001", "R999", "R001"],
      unverified: [{ text: "The deployment succeeded.", refs: ["A001", "R001"] }],
    }),
    prepared,
  );

  assert.deepEqual(checkpoint.source_refs.requirements, []);
  assert.deepEqual(checkpoint.source_refs.attempts, ["C001"]);
  assert.deepEqual(checkpoint.source_refs.observations, ["R001"]);
  assert.equal(checkpoint.sources.R001.outcome, "exit_nonzero");
  assert.equal(checkpoint.sources.R001.exit_code, 1);
  assert.ok(
    checkpoint.orientation.unverified.some((entry) =>
      entry.text.includes("Router rejected source references"),
    ),
  );
  assert.ok(
    checkpoint.orientation.unverified.some((entry) => entry.text === "The deployment succeeded."),
  );
});

test("falls back safely when the compaction model does not return JSON", () => {
  const prepared = prepareCompaction([message("user", "Keep the evidence."), call("a"), output("a", "done")]);
  const checkpoint = finalizeCheckpoint("ordinary prose summary", prepared);

  assert.deepEqual(checkpoint.source_refs, {
    requirements: [],
    attempts: [],
    observations: [],
  });
  assert.ok(
    checkpoint.orientation.unverified.some((entry) =>
      entry.text.includes("invalid structured output: ordinary prose summary"),
    ),
  );
  assert.ok(checkpoint.orientation.unknowns.includes("Task state must be reconstructed from retained evidence."));
  assert.ok(checkpoint.recent_tail.length > 0, "the deterministic recent tail remains available");
});

test("extracts exactly one contract-valid checkpoint from wrapped model output", () => {
  const prepared = prepareCompaction([
    message("user", "Keep the evidence."),
    call("wrapped"),
    output("wrapped", JSON.stringify({ exit_code: 1, output: "failed" })),
  ]);
  const summary = modelSummary({
    objective: 'Continue with {literal braces}, an escaped quote: ", and a closing } in text.',
  });
  const prose = finalizeCheckpoint(`The requested JSON checkpoint follows.\n${summary}`, prepared);
  const fenced = finalizeCheckpoint(
    `Here is the checkpoint.\n\`\`\`json\n${summary}\n\`\`\`\nDone.`,
    prepared,
  );
  const oneValid = finalizeCheckpoint(
    `Diagnostic metadata: {"note":"not a checkpoint"}\n${summary}`,
    prepared,
  );

  for (const checkpoint of [prose, fenced, oneValid]) {
    assert.deepEqual(checkpoint.source_refs.requirements, ["U001"]);
    assert.deepEqual(checkpoint.source_refs.attempts, ["C001"]);
    assert.deepEqual(checkpoint.source_refs.observations, ["R001"]);
    assert.equal(checkpoint.sources.R001.outcome, "exit_nonzero");
  }
});

test("rejects ambiguous, incomplete, excessive, and oversized embedded JSON", () => {
  const prepared = prepareCompaction([
    message("user", "Keep the evidence."),
    call("bounded"),
    output("bounded", "returned"),
  ]);
  const valid = modelSummary();
  const values = [
    `I will draft the checkpoint.\n\`\`\`json\n${valid}\n\`\`\`\n` +
      `The draft looks correct. Final answer:\n\`\`\`json\n${valid}\n\`\`\``,
    valid.slice(0, -1),
    `${Array.from({ length: 8 }, (_, index) => JSON.stringify({ note: index })).join("\n")}\n${valid}`,
    `${"x".repeat(256 * 1024)}${valid}`,
  ];

  for (const value of values) {
    const checkpoint = finalizeCheckpoint(value, prepared);
    assert.deepEqual(checkpoint.source_refs, {
      requirements: [],
      attempts: [],
      observations: [],
    });
    assert.ok(
      checkpoint.orientation.unverified.some((entry) =>
        entry.text.includes("invalid structured output"),
      ),
    );
  }
});

test("falls back safely when structured output violates the field or quantity contract", () => {
  const prepared = prepareCompaction([
    message("user", "Keep this requirement."),
    call("contract"),
    output("contract", "returned"),
  ]);
  const checkpoint = finalizeCheckpoint(
    modelSummary({
      objective: ["not a string"],
      requirement_refs: Array.from({ length: 33 }, () => "U001"),
    }),
    prepared,
  );

  assert.deepEqual(checkpoint.source_refs, {
    requirements: [],
    attempts: [],
    observations: [],
  });
  assert.ok(
    checkpoint.orientation.unverified.some((entry) =>
      entry.text.includes("invalid structured output"),
    ),
  );
  assert.ok(checkpoint.orientation.unknowns.includes("Task state must be reconstructed from retained evidence."));
  assert.ok(checkpoint.recent_tail.length > 0);
});

test("treats an explicit tool error as an error even when output text looks successful", () => {
  const prepared = prepareCompaction([
    message("user", "Run the tool."),
    call("errored"),
    {
      type: "function_call_output",
      call_id: "errored",
      output: JSON.stringify({ exit_code: 0, output: "operation successful" }),
      isError: true,
    },
  ]);
  const checkpoint = finalizeCheckpoint(modelSummary(), prepared);

  assert.equal(checkpoint.sources.R001.outcome, "tool_error");
  assert.equal(checkpoint.sources.R001.exit_code, undefined);
});

test("preserves source IDs and unresolved unknowns across repeated kcr2 compaction", () => {
  const firstPrepared = prepareCompaction([
    message("user", "Check SSH."),
    call("ssh-old"),
    output("ssh-old", JSON.stringify({ exit_code: 255, output: "" })),
  ]);
  const first = finalizeCheckpoint(
    modelSummary({ unknowns: ["Whether production was reached."] }),
    firstPrepared,
  );
  const encoded = encodeCheckpoint(first);
  const secondPrepared = prepareCompaction([
    { type: "compaction", id: "cmp_old", encrypted_content: encoded },
    message("user", "Run a fresh read-only probe."),
    call("ssh-new"),
    output("ssh-new", JSON.stringify({ exit_code: 0, output: "probe returned" })),
  ]);

  assert.ok(secondPrepared.sources.has("R001"));
  assert.ok(secondPrepared.sources.has("R002"));
  const second = finalizeCheckpoint(
    modelSummary({
      requirement_refs: ["U002"],
      attempt_refs: ["C002"],
      observation_refs: ["R001", "R002"],
      unknowns: [],
    }),
    secondPrepared,
  );
  assert.deepEqual(second.source_refs.observations, ["R001", "R002"]);
  assert.ok(second.orientation.unknowns.includes("Whether production was reached."));
  assert.equal(second.sources.R001.exit_code, 255);
  assert.equal(second.sources.R002.exit_code, 0);

  const fallback = finalizeCheckpoint(
    "not JSON",
    prepareCompaction([
      { type: "compaction", id: "cmp_second", encrypted_content: encodeCheckpoint(second) },
    ]),
  );
  assert.deepEqual(fallback.source_refs.observations, ["R001", "R002"]);
});

test("allows a later valid checkpoint to replace old references without renumbering sources", () => {
  const firstInput = Array.from({ length: 32 }, (_, index) =>
    message("user", `old requirement ${index + 1}`),
  );
  const first = finalizeCheckpoint(
    modelSummary({
      requirement_refs: Array.from({ length: 32 }, (_, index) =>
        `U${String(index + 1).padStart(3, "0")}`,
      ),
      attempt_refs: [],
      observation_refs: [],
    }),
    prepareCompaction(firstInput),
  );
  const prepared = prepareCompaction([
    { type: "compaction", id: "cmp_full", encrypted_content: encodeCheckpoint(first) },
    message("user", "new requirement"),
  ]);
  const second = finalizeCheckpoint(
    modelSummary({
      requirement_refs: ["U033"],
      attempt_refs: [],
      observation_refs: [],
    }),
    prepared,
  );

  assert.deepEqual(second.source_refs.requirements, ["U033"]);
  assert.equal(second.sources.U033.excerpt, "new requirement");
  assert.equal(second.counters.U, 34);
});

test("uses the prior recent tail, not source-map order, to retain the latest two turns", () => {
  const firstPrepared = prepareCompaction([
    message("user", "old turn"),
    message("user", "penultimate turn"),
    message("user", "latest prior turn"),
  ]);
  const first = finalizeCheckpoint(
    modelSummary({
      requirement_refs: ["U003"],
      attempt_refs: [],
      observation_refs: [],
    }),
    firstPrepared,
  );
  const secondPrepared = prepareCompaction([
    { type: "compaction", id: "cmp_old", encrypted_content: encodeCheckpoint(first) },
    message("user", "new turn"),
  ]);

  const userExcerpts = secondPrepared.recentTail
    .filter((entry) => entry.kind === "user_message")
    .map((entry) => entry.excerpt);
  assert.deepEqual(userExcerpts, ["latest prior turn", "new turn"]);
});

test("assigns a new ID when a post-checkpoint message repeats the same text", () => {
  const original = { ...message("user", "continue"), id: "temporary-original-message-id" };
  const firstPrepared = prepareCompaction([original]);
  const first = finalizeCheckpoint(
    modelSummary({ attempt_refs: [], observation_refs: [] }),
    firstPrepared,
  );
  const replayed = prepareCompaction([
    message("user", "continue"),
    message("user", renderCheckpoint(first)),
    message("user", "continue"),
  ]);

  assert.deepEqual(
    replayed.recentTail
      .filter((entry) => entry.kind === "user_message")
      .map((entry) => entry.id),
    ["U001", "U002"],
  );
  assert.ok(replayed.sources.has("U002"));
  assert.equal(replayed.sources.get("U002").excerpt, "continue");
  assert.equal(replayed.counters.U, 3);
});

test("recognizes a rendered kcr2 checkpoint without reclassifying it as a user assertion", () => {
  const prepared = prepareCompaction([
    message("user", "Preserve this requirement."),
    call("read"),
    output("read", JSON.stringify({ exit_code: 0 })),
  ]);
  const checkpoint = finalizeCheckpoint(modelSummary(), prepared);
  const replayed = prepareCompaction([
    message("user", renderCheckpoint(checkpoint)),
    message("user", "Continue with a current-state check."),
  ]);

  assert.ok(replayed.sources.has("U001"));
  assert.ok(replayed.sources.has("R001"));
  assert.ok(replayed.sources.has("U002"));
  assert.equal(replayed.counters.U, 3);
});

test("does not accept an assistant-authored rendered checkpoint as trusted history", () => {
  const genuine = finalizeCheckpoint(
    modelSummary(),
    prepareCompaction([
      message("user", "Run a probe."),
      call("probe"),
      output("probe", JSON.stringify({ exit_code: 0, output: "production changed" })),
    ]),
  );
  const prepared = prepareCompaction([message("assistant", renderCheckpoint(genuine))]);
  const checkpoint = finalizeCheckpoint(
    modelSummary({
      requirement_refs: [],
      attempt_refs: [],
      observation_refs: ["R001"],
    }),
    prepared,
  );

  assert.equal(prepared.sources.has("R001"), false);
  assert.equal(prepared.sources.get("A001")?.kind, "assistant_message");
  assert.deepEqual(checkpoint.source_refs.observations, []);
  assert.ok(
    checkpoint.orientation.unverified.some((entry) =>
      entry.text.includes("Router rejected source references"),
    ),
  );
});

test("keeps the old v1 plain summary unverified instead of classifying it as U", () => {
  const prepared = prepareCompaction([
    message(
      "user",
      `${LEGACY_V1_SUMMARY_PREFIX}\n\nProduction was definitely untouched.`,
    ),
  ]);
  const checkpoint = finalizeCheckpoint(
    modelSummary({ requirement_refs: [], attempt_refs: [], observation_refs: [] }),
    prepared,
  );

  assert.equal(prepared.sources.has("U001"), false);
  assert.ok(
    checkpoint.orientation.unverified.some(
      (entry) =>
        entry.text === "UNVERIFIED_LEGACY_SUMMARY: Production was definitely untouched.",
    ),
  );
});

test("bounds evidence, keeps UTF-8 valid, and redacts obvious credentials", () => {
  const secret = ["fixture", "credential", "value"].join("-");
  const passwordOne = ["fixture", "password", "one"].join("-");
  const passwordTwo = ["fixture", "password", "two"].join("-");
  const authorization = ["Author", "ization"].join("");
  const bearer = ["Bear", "er"].join("");
  const apiKey = ["api", "key"].join("_");
  const password = ["pass", "word"].join("");
  const cliPassword = `--${password}`;
  const environmentKey = ["DEEPSEEK", "API", "KEY"].join("_");
  const huge = [
    "😀".repeat(2_000),
    `${authorization}: ${bearer} ${secret}`,
    `${apiKey}=${secret}`,
    `${password}=${passwordOne}`,
    `${cliPassword} ${passwordTwo}`,
    `${environmentKey}=${secret}`,
  ].join(" ");
  const input = [message("user", huge)];
  for (let index = 0; index < 40; index += 1) {
    input.push(message("user", `requirement ${index}`));
  }
  input.push(
    call(
      "secret-call",
      "exec_command",
      JSON.stringify({ token: secret, payload: "x".repeat(2_000) }),
    ),
  );
  input.push(output("secret-call", JSON.stringify({ exit_code: 0, output: huge })));
  const prepared = prepareCompaction(input);
  const checkpoint = finalizeCheckpoint(
    modelSummary({
      requirement_refs: Array.from({ length: 30 }, (_, index) => `U${String(index + 12).padStart(3, "0")}`),
      attempt_refs: ["C001"],
      observation_refs: ["R001"],
    }),
    prepared,
  );
  const encoded = encodeCheckpoint(checkpoint);
  const serialized = Buffer.from(encoded.slice(KCR2_PREFIX.length), "base64");
  const rendered = renderCheckpoint(checkpoint);

  assert.equal(Object.keys(checkpoint.sources).length, 32);
  assert.equal(checkpoint.source_refs.requirements.length, 30);
  assert.ok(serialized.length <= 96 * 1024);
  assert.ok(!rendered.includes(secret));
  assert.ok(!rendered.includes(passwordOne));
  assert.ok(!rendered.includes(passwordTwo));
  assert.doesNotMatch(rendered, /�/u);
  assert.equal(checkpoint.sources.C001.truncated, true);
  assert.equal(checkpoint.sources.R001.truncated, true);
  assert.match(checkpoint.sources.R001.excerpt, /\.\.\.\[truncated\]\.\.\./u);
  for (const source of Object.values(checkpoint.sources)) {
    assert.ok(Buffer.byteLength(source.excerpt, "utf8") <= 1_024);
    if (source.kind === "tool_call" && source.arguments) {
      assert.ok(Buffer.byteLength(source.arguments, "utf8") <= 512);
    }
  }
  assert.ok(Buffer.byteLength(JSON.stringify(checkpoint.recent_tail), "utf8") <= 32 * 1024);
});

test("redacts managed caller URLs and known GitHub token prefixes", () => {
  const callerCapability = ["caller", "capability", "fixture", "value"].join("-");
  const fineGrainedToken = [["github", "pat"].join("_"), "fixture", "credential", "value"].join("_");
  const classicToken = `${["gh", "p"].join("")}_${"a".repeat(24)}`;
  const callerUrl = `http://127.0.0.1:4202/_codex-router/${callerCapability}/v1/responses`;
  const prepared = prepareCompaction([
    message(
      "user",
      [
        "Keep this non-secret route context.",
        "https://github.com/example/repository",
        callerUrl,
        fineGrainedToken,
        classicToken,
      ].join("\n"),
    ),
  ]);
  const checkpoint = finalizeCheckpoint(
    modelSummary({
      requirement_refs: ["U001"],
      attempt_refs: [],
      observation_refs: [],
    }),
    prepared,
  );
  const rendered = renderCheckpoint(checkpoint);

  assert.match(rendered, /Keep this non-secret route context\./u);
  assert.match(rendered, /https:\/\/github\.com\/example\/repository/u);
  assert.match(rendered, /\/_codex-router\/\[REDACTED\]\/v1\/responses/u);
  assert.ok(!rendered.includes(callerCapability));
  assert.ok(!rendered.includes(fineGrainedToken));
  assert.ok(!rendered.includes(classicToken));
});

test("reserves the latest two user messages when the last two turns exceed 32 KiB", () => {
  const input = [message("user", "first retained turn")];
  for (let index = 0; index < 40; index += 1) {
    input.push(message("assistant", `${index}: ${"a".repeat(2_000)}`));
  }
  input.push(message("user", "latest turn"));
  for (let index = 0; index < 40; index += 1) {
    input.push(message("assistant", `latest ${index}: ${"b".repeat(2_000)}`));
  }
  const prepared = prepareCompaction(input);

  assert.equal(prepared.recentTailTruncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(prepared.recentTail), "utf8") <= 32 * 1024);
  assert.match(prepared.recentTail.at(-1).excerpt, /^latest 39:/u);
  assert.deepEqual(
    prepared.recentTail
      .filter((entry) => entry.kind === "user_message")
      .map((entry) => entry.excerpt),
    ["first retained turn", "latest turn"],
  );
});

test("shows the latest two user messages before early requirements and recent tool floods", () => {
  const input = [];
  for (let index = 1; index <= 40; index += 1) {
    input.push(message("user", `early requirement ${index}: ${"u".repeat(2_000)}`));
  }
  input.push(message("user", "penultimate current requirement"));
  for (let index = 0; index < 60; index += 1) {
    input.push(call(`before-latest-${index}`, "exec_command", "x".repeat(4_000)));
  }
  input.push(message("user", "latest current requirement"));
  for (let index = 0; index < 60; index += 1) {
    input.push(call(`after-latest-${index}`, "exec_command", "y".repeat(4_000)));
  }

  const prepared = prepareCompaction(input);

  assert.equal(prepared.catalogSourceIds.has("U041"), true);
  assert.equal(prepared.catalogSourceIds.has("U042"), true);
  assert.deepEqual(
    prepared.recentTail
      .filter((entry) => entry.kind === "user_message")
      .map((entry) => entry.id),
    ["U041", "U042"],
  );
  assert.ok(Buffer.byteLength(prepared.catalogText, "utf8") <= 96 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(prepared.recentTail), "utf8") <= 32 * 1024);
});

test("fits the final serialized checkpoint when JSON escaping expands bounded sources", () => {
  const input = [];
  for (let index = 1; index <= 32; index += 1) {
    input.push({
      type: "function_call",
      call_id: `${"\\".repeat(240)}${index}`,
      name: "\\".repeat(1_000),
      arguments: "\\".repeat(4_000),
    });
  }
  const checkpoint = finalizeCheckpoint(
    modelSummary({
      requirement_refs: [],
      attempt_refs: Array.from(
        { length: 32 },
        (_, index) => `C${String(index + 1).padStart(3, "0")}`,
      ),
      observation_refs: [],
    }),
    prepareCompaction(input),
  );
  const serializedBytes = Buffer.byteLength(JSON.stringify(checkpoint), "utf8");

  assert.ok(serializedBytes <= 96 * 1024);
  assert.doesNotThrow(() => encodeCheckpoint(checkpoint));
  assert.ok(Object.keys(checkpoint.sources).length < 32);
  assert.ok(
    checkpoint.orientation.unknowns.includes(
      "Some candidate sources were omitted before model selection because the 96 KiB source-catalog limit was reached.",
    ),
  );
  for (const refs of Object.values(checkpoint.source_refs)) {
    assert.ok(refs.every((id) => checkpoint.sources[id]));
  }
});

test("rejects unsafe source IDs and counters without generating Infinity IDs", () => {
  const hugeId = `U${"9".repeat(400)}`;
  const base = {
    version: 2,
    orientation: {
      objective: "Continue safely.",
      unverified: [],
      unknowns: [],
      blockers: [],
      next_step: "Re-read state.",
    },
    source_refs: { requirements: [], attempts: [], observations: [] },
    sources: {},
    recent_tail: [],
    recent_tail_truncated: false,
    counters: { U: 2, A: 1, C: 1, R: 1 },
  };

  assert.equal(
    decodeCompaction(rawKcr2({ ...base, sources: { [hugeId]: {
      kind: "user_message",
      excerpt: "unsafe",
      truncated: false,
    } } })),
    undefined,
  );
  assert.equal(
    decodeCompaction(rawKcr2({
      ...base,
      counters: { ...base.counters, U: Number.MAX_SAFE_INTEGER },
    })),
    undefined,
  );

  const prepared = prepareCompaction([
    { type: "compaction", encrypted_content: rawKcr2({ ...base, sources: { [hugeId]: {
      kind: "user_message",
      excerpt: "unsafe",
      truncated: false,
    } } }) },
    message("user", "Continue from directly readable state."),
  ]);
  assert.ok([...prepared.sources.keys()].every((id) => !id.includes("Infinity")));
  assert.ok(Object.values(prepared.counters).every(Number.isSafeInteger));
});

test("caps the model-visible catalog and rejects valid but undisclosed source IDs", () => {
  const input = [];
  for (let index = 1; index <= 256; index += 1) {
    input.push(call(
      `${"\\".repeat(1_024)}-${index}`,
      `${"\\".repeat(1_024)}-tool-${index}`,
      JSON.stringify({ payload: "\\".repeat(4_096), index }),
    ));
  }
  const prepared = prepareCompaction(input);
  const catalogBytes = Buffer.byteLength(prepared.catalogText, "utf8");
  const omittedId = [...prepared.sources.keys()].find(
    (id) => !prepared.catalogSourceIds.has(id),
  );

  assert.ok(catalogBytes <= 96 * 1024);
  assert.equal(prepared.catalogTruncated, true);
  assert.ok(omittedId, "the catalog budget should omit at least one existing source");
  for (const source of prepared.sources.values()) {
    assert.ok(Buffer.byteLength(source.call_id || "", "utf8") <= 256);
    assert.ok(Buffer.byteLength(source.tool || "", "utf8") <= 256);
  }

  const checkpoint = finalizeCheckpoint(
    modelSummary({
      requirement_refs: [],
      attempt_refs: [omittedId],
      observation_refs: [],
      unverified: [{ text: "Guessed historical source.", refs: [omittedId] }],
    }),
    prepared,
  );
  assert.deepEqual(checkpoint.source_refs.attempts, []);
  assert.equal(checkpoint.sources[omittedId], undefined);
  assert.ok(
    checkpoint.orientation.unverified.some((entry) =>
      entry.text.includes("Router rejected source references")),
  );
  assert.ok(
    checkpoint.orientation.unknowns.includes(
      "Some candidate sources were omitted before model selection because the 96 KiB source-catalog limit was reached.",
    ),
  );
});

test("decodes kcr2 and labels kcr1 as unverified legacy material", () => {
  const prepared = prepareCompaction([message("user", "Continue safely.")]);
  const checkpoint = finalizeCheckpoint(
    modelSummary({ attempt_refs: [], observation_refs: [] }),
    prepared,
  );
  const encoded = encodeCheckpoint(checkpoint);
  const decoded = decodeCompaction(encoded);
  assert.equal(decoded.kind, "checkpoint");
  assert.ok(renderCompactionValue(encoded).includes(CHECKPOINT_WARNING));

  const legacy = KCR1_PREFIX + Buffer.from("old model summary", "utf8").toString("base64");
  const legacyDecoded = decodeCompaction(legacy);
  assert.deepEqual(legacyDecoded, { kind: "legacy", summary: "old model summary" });
  assert.ok(renderCompactionValue(legacy).includes(LEGACY_WARNING));
  assert.match(renderCompactionValue(legacy), /old model summary/u);
});


test("encoding degrades to a minimal checkpoint instead of throwing", () => {
  // A compaction has nowhere to retry: throwing out of the encode step turns
  // it into a 5xx, and a failed compaction ends the session. Every shape
  // normalizedCheckpoint rejects must still produce a readable kcr2 value.
  const base = {
    version: 2,
    orientation: {
      objective: "",
      unverified: [],
      unknowns: [],
      blockers: [],
      next_step: "",
    },
    source_refs: { requirements: [], attempts: [], observations: [] },
    sources: {},
    recent_tail: [],
    recent_tail_truncated: false,
  };
  const rejected = [
    // Missing counters object.
    base,
    // Counters present but not positive safe integers.
    { ...base, counters: { U: 0, A: 1, C: 1, R: 1 } },
    // Unparseable recent_tail source id.
    { ...base, counters: { U: 1, A: 1, C: 1, R: 1 }, recent_tail: [{ id: "Z999" }] },
    // No checkpoint at all, which is what finalizeCheckpoint returns when
    // normalization of its own result fails.
    undefined,
  ];
  for (const checkpoint of rejected) {
    let encoded;
    assert.doesNotThrow(() => {
      encoded = encodeCheckpoint(checkpoint);
    });
    assert.ok(encoded.startsWith(KCR2_PREFIX));
    const decoded = decodeCompaction(encoded);
    assert.equal(decoded.kind, "checkpoint");
    assert.ok(
      decoded.checkpoint.orientation.unknowns.some((entry) =>
        entry.includes("could not encode a checkpoint"),
      ),
      "the degraded checkpoint says what was lost",
    );
    // Rendering degrades the same way, so the v1 replay path never emits a
    // bare "unreadable format" line for a checkpoint this router produced.
    const rendered = renderCheckpoint(checkpoint);
    assert.match(rendered, /BEGIN_CODEX_ROUTER_CHECKPOINT_V2/u);
    assert.match(rendered, /could not encode a checkpoint/u);
  }
});
