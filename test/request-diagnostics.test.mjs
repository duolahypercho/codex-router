import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  grokOauthIngressContextBytes,
  measureIngressContextBytes,
  ROUTER_INGRESS_OBSERVATION_POINT,
  safeDiagnosticRequestId,
  sanitizeContextBytes,
  sanitizeGrokStructuredPatch,
  utf8JsonBytes,
  usageDiagnosticMetadata,
} from "../src/request-diagnostics.mjs";

test("missing payload fields measure as zero JSON bytes, present empties do not", () => {
  assert.equal(utf8JsonBytes(undefined), 0);
  assert.equal(utf8JsonBytes(""), Buffer.byteLength(JSON.stringify(""), "utf8"));
  assert.equal(utf8JsonBytes([]), Buffer.byteLength("[]", "utf8"));
  assert.equal(utf8JsonBytes({}), Buffer.byteLength("{}", "utf8"));

  const measured = measureIngressContextBytes({
    model: "grok-oauth/grok-4.6",
    instructions: "system prompt",
    tools: [{ type: "function", name: "read_file" }],
    input: [{ type: "message", role: "user", content: "hello" }],
  });
  assert.equal(measured.observationPoint, ROUTER_INGRESS_OBSERVATION_POINT);
  assert.equal(measured.instructionsBytes, utf8JsonBytes("system prompt"));
  assert.equal(
    measured.toolsBytes,
    utf8JsonBytes([{ type: "function", name: "read_file" }]),
  );
  assert.equal(
    measured.historyBytes,
    utf8JsonBytes([{ type: "message", role: "user", content: "hello" }]),
  );

  const missing = measureIngressContextBytes({ model: "grok-oauth/grok-4.6" });
  assert.deepEqual(missing, {
    observationPoint: ROUTER_INGRESS_OBSERVATION_POINT,
    instructionsBytes: 0,
    toolsBytes: 0,
    historyBytes: 0,
  });
});

test("UTF-8 JSON bytes count serialized payload fields, never token estimates", () => {
  const text = "café — 月";
  assert.equal(utf8JsonBytes(text), Buffer.byteLength(JSON.stringify(text), "utf8"));
  assert.notEqual(utf8JsonBytes(text), text.length);
  const circular = {};
  circular.self = circular;
  assert.equal(utf8JsonBytes(circular), 0);
});

test("contextBytes is only measured for Grok OAuth 4.6 ingress", () => {
  const payload = { instructions: "x", tools: [], input: "hi" };
  assert.equal(
    grokOauthIngressContextBytes(payload, { slug: "grok-oauth/grok-4.5" }),
    undefined,
  );
  assert.equal(
    grokOauthIngressContextBytes(payload, { slug: "openrouter/grok-4.6" }),
    undefined,
  );
  assert.deepEqual(
    grokOauthIngressContextBytes(payload, { slug: "grok-oauth/grok-4.6" }),
    measureIngressContextBytes(payload),
  );
});

test("diagnostic metadata keeps only bounded requestId and contextBytes", () => {
  assert.equal(safeDiagnosticRequestId("12"), "12");
  assert.equal(safeDiagnosticRequestId(7), "7");
  assert.equal(
    safeDiagnosticRequestId("6f1c2a3b-4d5e-6789-abcd-ef0123456789:3"),
    "6f1c2a3b-4d5e-6789-abcd-ef0123456789:3",
  );
  assert.equal(safeDiagnosticRequestId("../secret"), undefined);
  assert.equal(safeDiagnosticRequestId("thread title with spaces"), undefined);
  assert.equal(safeDiagnosticRequestId("/Users/me/.codex/sessions/foo.jsonl"), undefined);
  assert.equal(safeDiagnosticRequestId("https://x.ai/thread"), undefined);

  const leaked = usageDiagnosticMetadata({
    requestId: "thread:Title/with path",
    contextBytes: {
      observationPoint: ROUTER_INGRESS_OBSERVATION_POINT,
      instructionsBytes: 4,
      toolsBytes: 0,
      historyBytes: 8,
      prompt: "never persist",
      headers: { authorization: "secret" },
    },
  });
  assert.deepEqual(leaked, {
    contextBytes: {
      observationPoint: ROUTER_INGRESS_OBSERVATION_POINT,
      instructionsBytes: 4,
      toolsBytes: 0,
      historyBytes: 8,
    },
  });
  assert.equal("requestId" in leaked, false);

  assert.equal(
    sanitizeContextBytes({ observationPoint: "router_upstream", instructionsBytes: 1 }),
    undefined,
  );
});

test("usage events persist requestId and contextBytes without content leakage", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-router-diagnostics-"));
  const previousStateDir = process.env.MODEL_ROUTER_STATE_DIR;
  process.env.MODEL_ROUTER_STATE_DIR = stateDir;
  try {
    const usage = await import(`../src/usage-events.mjs?diag=${Date.now()}`);
    usage.recordUsageEvent({
      model: "grok-oauth/grok-4.6",
      provider: "grok-oauth",
      status: 200,
      durationMs: 10,
      requestId: "42",
      grokStructuredPatch: { enabled: true, applied: true, schemaVersion: 1, prompt: "never persisted" },
      contextBytes: measureIngressContextBytes({
        instructions: "keep this out of the ledger",
        tools: [{ name: "read_file", path: "/secret/notes.md" }],
        input: [{ type: "message", role: "user", content: "private turn" }],
      }),
      prompt: "never persisted",
      headers: { authorization: "secret" },
      threadTitle: "Secret thread",
      path: "/Users/me/.codex/sessions/thread.jsonl",
    });
    const [event] = usage.recentUsageEvents();
    assert.equal(event.requestId, "42");
    assert.deepEqual(event.grokStructuredPatch, { enabled: true, applied: true, schemaVersion: 1 });
    assert.deepEqual(event.contextBytes, {
      observationPoint: ROUTER_INGRESS_OBSERVATION_POINT,
      instructionsBytes: utf8JsonBytes("keep this out of the ledger"),
      toolsBytes: utf8JsonBytes([{ name: "read_file", path: "/secret/notes.md" }]),
      historyBytes: utf8JsonBytes([
        { type: "message", role: "user", content: "private turn" },
      ]),
    });
    const raw = readFileSync(usage.USAGE_EVENTS_PATH, "utf8");
    assert.equal(raw.includes("keep this out of the ledger"), false);
    assert.equal(raw.includes("/secret/notes.md"), false);
    assert.equal(raw.includes("private turn"), false);
    assert.equal(raw.includes("never persisted"), false);
    assert.equal(raw.includes("Secret thread"), false);
    assert.equal(raw.includes("/Users/me/.codex"), false);
    assert.equal("prompt" in event, false);
    assert.equal("headers" in event, false);
    assert.equal("threadTitle" in event, false);
    assert.equal("path" in event, false);
    assert.equal("reasoningOutputTokens" in event, false);
  } finally {
    if (previousStateDir === undefined) delete process.env.MODEL_ROUTER_STATE_DIR;
    else process.env.MODEL_ROUTER_STATE_DIR = previousStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("legacy usage rows without diagnostics keep their exact shape", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-router-diagnostics-legacy-"));
  const previousStateDir = process.env.MODEL_ROUTER_STATE_DIR;
  process.env.MODEL_ROUTER_STATE_DIR = stateDir;
  try {
    const usage = await import(`../src/usage-events.mjs?legacy=${Date.now()}`);
    usage.recordUsageEvent({
      model: "grok-oauth/grok-4.5",
      provider: "grok-oauth",
      status: 200,
      durationMs: 11,
      inputTokens: 3,
      outputTokens: 1,
      totalTokens: 4,
    });
    const [event] = usage.recentUsageEvents();
    assert.equal("requestId" in event, false);
    assert.equal("contextBytes" in event, false);
    assert.equal("reasoningTokens" in event, false);
    assert.deepEqual(Object.keys(event).sort(), [
      "at",
      "durationMs",
      "inputTokens",
      "meteringVersion",
      "model",
      "outputTokens",
      "provider",
      "status",
      "totalTokens",
    ]);
  } finally {
    if (previousStateDir === undefined) delete process.env.MODEL_ROUTER_STATE_DIR;
    else process.env.MODEL_ROUTER_STATE_DIR = previousStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("reasoningTokens zero is distinct from an absent count on the ledger", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-router-reasoning-"));
  const previousStateDir = process.env.MODEL_ROUTER_STATE_DIR;
  process.env.MODEL_ROUTER_STATE_DIR = stateDir;
  try {
    const usage = await import(`../src/usage-events.mjs?reasoning=${Date.now()}`);
    usage.recordUsageEvent({
      model: "grok-oauth/grok-4.6",
      provider: "grok-oauth",
      status: 200,
      durationMs: 8,
      outputTokens: 10,
      reasoningTokens: 0,
    });
    usage.recordUsageEvent({
      model: "grok-oauth/grok-4.6",
      provider: "grok-oauth",
      status: 200,
      durationMs: 9,
      outputTokens: 10,
    });
    const events = usage.recentUsageEvents();
    const zero = events.find((event) => event.durationMs === 8);
    const absent = events.find((event) => event.durationMs === 9);
    assert.equal(zero.reasoningTokens, 0);
    assert.equal("reasoningTokens" in absent, false);
  } finally {
    if (previousStateDir === undefined) delete process.env.MODEL_ROUTER_STATE_DIR;
    else process.env.MODEL_ROUTER_STATE_DIR = previousStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("structured patch diagnostics distinguish opt-in from application and omit arbitrary content", () => {
  for (const [enabled, applied] of [[false, false], [true, false], [true, true]]) {
    const safe = { enabled, applied, schemaVersion: 1 };
    assert.deepEqual(sanitizeGrokStructuredPatch({ ...safe, prompt: "secret", path: "/private" }), safe);
    assert.deepEqual(usageDiagnosticMetadata({ grokStructuredPatch: safe }), { grokStructuredPatch: safe });
  }
  for (const bad of [null, [], "1", {}, { enabled: true, applied: "yes", schemaVersion: 1 }, { enabled: false, applied: true, schemaVersion: 1 }, { enabled: true, applied: true, schemaVersion: 2 }]) {
    assert.equal(sanitizeGrokStructuredPatch(bad), undefined);
    assert.deepEqual(usageDiagnosticMetadata({ grokStructuredPatch: bad }), {});
  }
});

test("client hook diagnostic mode is optional, constrained, and content-free", () => {
  const safe = { enabled: true, applied: true, schemaVersion: 1, mode: "client_hook" };
  assert.deepEqual(sanitizeGrokStructuredPatch({ ...safe, command: "private patch", rawArguments: "private history" }), safe);
  assert.deepEqual(usageDiagnosticMetadata({ grokStructuredPatch: safe }), { grokStructuredPatch: safe });
  for (const mode of ["private prompt", {}, 1, null]) assert.equal(sanitizeGrokStructuredPatch({ ...safe, mode }), undefined);
});
