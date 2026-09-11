import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  accountRefusal,
  CHECK_LABELS,
  checksComplete,
  firstFailure,
  newMarker,
  parseEventLines,
  readDelegation,
  runDeferred,
} from "../src/subagent-certify.mjs";
import { VERIFICATION_CHECKS } from "../src/subagent-proofs.mjs";

test("every check has a label a reader can act on", () => {
  for (const name of VERIFICATION_CHECKS) {
    assert.equal(typeof CHECK_LABELS[name], "string", `${name} needs a label`);
    assert.doesNotMatch(CHECK_LABELS[name], /v2|certif|relay protocol/i);
  }
});

test("a run is complete only when all five checks passed", () => {
  const all = {};
  for (const name of VERIFICATION_CHECKS) all[name] = { outcome: "pass" };
  assert.equal(checksComplete(all), true);
  assert.equal(firstFailure(all), undefined);

  for (const name of VERIFICATION_CHECKS) {
    const partial = { ...all, [name]: { outcome: "fail", detail: "nope" } };
    assert.equal(checksComplete(partial), false);
    assert.equal(firstFailure(partial).check, name);
    assert.equal(firstFailure(partial).label, CHECK_LABELS[name]);
  }
});

test("the first failure is reported in reviewer order", () => {
  const checks = {
    streaming: { outcome: "pass" },
    toolCall: { outcome: "fail", detail: "no tool call" },
    encryptedRelay: { outcome: "fail" },
    markerReturn: { outcome: "pending" },
    sameThreadFollowUp: { outcome: "pending" },
  };
  assert.equal(firstFailure(checks).check, "toolCall");
  assert.equal(firstFailure(checks).detail, "no tool call");
});

test("account refusal detects ChatGPT blocking for custom provider models", () => {
  // Issue #689: Custom provider models with GPT-6-like slugs are blocked by
  // Codex server when signed in with a ChatGPT account.
  const errorResponse = {
    detail: "The 'unorouter/gpt-6-astra' model is not supported when using Codex with a ChatGPT account.",
  };
  const events = [errorResponse];
  const refusal = accountRefusal(events);
  assert.equal(typeof refusal, "string");
  assert.match(refusal, /Codex will not spawn this route/i);
  assert.match(refusal, /ChatGPT account/i);
});

test("account refusal detects renamed slug variants", () => {
  // Issue #689: Even renaming the slug (e.g., unorouter/agi-1) doesn't help if
  // the upstream model ID still triggers the pattern.
  const errorResponse = {
    detail: "The 'unorouter/agi-1' model is not supported when using Codex with a ChatGPT account.",
  };
  const events = [errorResponse];
  const refusal = accountRefusal(events);
  assert.equal(typeof refusal, "string");
  assert.match(refusal, /Codex will not spawn this route/i);
});

test("account refusal does not trigger for other provider errors", () => {
  const events = [
    { error: "Rate limit exceeded" },
    { error: "Invalid API key" },
    { detail: "Model not found" },
  ];
  const refusal = accountRefusal(events);
  assert.equal(refusal, undefined);
});

test("markers are unique per run so a stale transcript cannot pass a route", () => {
  const seen = new Set();
  for (let index = 0; index < 200; index += 1) seen.add(newMarker());
  assert.equal(seen.size, 200);
});

test("a parent echoing the marker itself does not count as delegation", () => {
  const marker = "CRV-ABC123";
  // The parent was told the marker, so it appears in its own message. No child
  // ever started; treating this as a pass is exactly how a v1 route would slip
  // into Codex's v2 subagent list.
  const events = [
    { type: "item.completed", item: { type: "agent_message", text: `I will ask for ${marker}` } },
    { type: "turn.completed" },
  ];
  const result = readDelegation(events, { agentName: "router_deepseek_deepseek_v4_flash", marker });
  assert.equal(result.childStarted, false);
  assert.equal(result.markerReturned, false);
});

test("a child that starts and answers is a delegation", () => {
  const marker = "CRV-ABC123";
  const agentName = "router_deepseek_deepseek_v4_flash";
  const events = [
    { type: "item.started", item: { type: "agent_call", agent_type: agentName } },
    { type: "item.completed", item: { type: "agent_call", output: marker } },
    { type: "turn.completed" },
  ];
  const result = readDelegation(events, { agentName, marker });
  assert.equal(result.childStarted, true);
  assert.equal(result.markerReturned, true);
});

test("a child that starts but never returns the marker fails the marker check", () => {
  const agentName = "router_vendor_model";
  const events = [
    { type: "item.started", item: { type: "agent_call", agent_type: agentName } },
    { type: "item.completed", item: { type: "agent_call", output: "I could not comply." } },
  ];
  const result = readDelegation(events, { agentName, marker: "CRV-ZZZ" });
  assert.equal(result.childStarted, true);
  assert.equal(result.markerReturned, false);
});

test("event parsing survives interleaved non-JSON output", () => {
  const stdout = [
    '{"type":"turn.started"}',
    "warning: something on stderr got interleaved",
    '{"type":"turn.completed"}',
    "",
  ].join("\n");
  const events = parseEventLines(stdout);
  assert.equal(events.length, 3);
  assert.equal(events[0].type, "turn.started");
  assert.equal(typeof events[1], "string");
  assert.equal(events[2].type, "turn.completed");
});

test("the checks call the endpoint the router actually serves", async () => {
  // A 404 from `chat/completions` was reported to the operator as "this model
  // cannot run subagents". The caller endpoint speaks Responses and takes the
  // caller key as a bearer; both are part of the check, not incidental.
  const source = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "subagent-certify.mjs"),
    "utf8",
  );
  assert.match(source, /\$\{baseUrl\}\/responses/);
  // Only the comment explaining the original bug may still name that path.
  assert.doesNotMatch(source, /fetch\([^)]*chat\/completions/);
  assert.doesNotMatch(source, /`\$\{baseUrl\}\/chat\/completions`/);
  assert.match(source, /authorization: `Bearer \$\{secret\}`/);
  // Responses puts the forced call in `output`, not in a chat `message`.
  assert.match(source, /\(payload\?\.output \|\| \[\]\)\.find\(\(item\) => item\?\.type === "function_call"\)/);
  // Forced first, because that is the strongest evidence; the fallback to an
  // offered call is covered by its own test below.
  assert.match(source, /toolProbe\(\{ type: "function", name: "codex_router_probe" \}\)/);
  assert.match(source, /tool_choice: choice/);
});

test("independent routes fan out, but recording and publishing do not", () => {
  // Two control processes racing read-modify-write on the proofs file would
  // silently drop a verdict, so the fan-out has to live inside one process
  // with the recording after it.
  const source = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "control.mjs"),
    "utf8",
  );
  const block = source.slice(
    source.indexOf('} else if (action === "certify")'),
    source.indexOf('} else if (action === "set")'),
  );
  assert.ok(block, "the certify verb must exist");
  assert.match(block, /await Promise\.all\(\s*slugs\.map/);
  // Recording happens after the fan-out, once per route, in this process.
  assert.ok(block.indexOf("await Promise.all(") < block.indexOf("recordVerification(slug"));
  // One republish for the whole batch, and only when something was promoted.
  assert.match(block, /if \(promoted\) await refreshModelSettingsCatalog\(\)/);
  assert.equal(block.match(/refreshModelSettingsCatalog\(\)/g)?.length, 1);
  // One route's crash is not a verdict on the others.
  assert.match(block, /catch \(error\) \{[\s\S]{0,200}return \{ slug, error/);
});

test("a rate limit is not a verdict about the route", () => {
  // A 429 on the tool call recorded "Cannot run subagents" against a route
  // that had never been asked a question it could fail.
  const source = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "subagent-certify.mjs"),
    "utf8",
  );
  assert.match(source, /STATUS_ABOUT_THE_ACCOUNT = new Set\(\[401, 402, 403, 408, 429, 500, 502, 503, 504\]\)/);
  assert.match(source, /outcome: "deferred"/);
  assert.equal(runDeferred({ streaming: { outcome: "pass" }, toolCall: { outcome: "deferred" } }), true);
  assert.equal(runDeferred({ streaming: { outcome: "pass" }, toolCall: { outcome: "fail" } }), false);

  const control = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "control.mjs"),
    "utf8",
  );
  // Deferring clears the record so the switch stays retryable.
  assert.match(control, /if \(!result\.ok && runDeferred\(result\.checks\)\) \{[\s\S]{0,120}clearSubagentProof\(slug\)/);
});

test("the delegation run is configured to reach the router at all", () => {
  // Without a provider declaration and a real Codex home, no child can start
  // for any route -- which is what "no child ran on this route" reported for
  // five different providers in a row.
  const source = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "subagent-certify.mjs"),
    "utf8",
  );
  assert.match(source, /model_providers\.codex-router\.base_url=/);
  assert.match(source, /model_providers\.codex-router\.wire_api="responses"/);
  assert.match(source, /model_catalog_json=/);
  // The disposable thing is the working directory, never the Codex home.
  assert.match(source, /codex-router-certify-/);
  assert.doesNotMatch(source, /mkdtempSync[^)]*\)\s*;\s*\n\s*try \{[\s\S]{0,80}codexHome/);
  // An agent definition written only for the check must not outlive it.
  assert.match(source, /if \(!preExisting\) rmSync\(agentFile, \{ force: true \}\)/);

  const control = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "control.mjs"),
    "utf8",
  );
  assert.match(control, /codexHome: CODEX_HOME/);
  assert.match(control, /catalogPath: MERGED_CATALOG_PATH/);
});

test("a run that got no answer is not a refusal either", () => {
  // A client-side timeout recorded "Cannot run subagents" against Command Code
  // -- for a model that answers tool calls fine on three other providers. Only
  // a reply the provider actually sent can refuse a route.
  const source = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "subagent-certify.mjs"),
    "utf8",
  );
  assert.doesNotMatch(source, /results\.streaming = fail\(error/);
  assert.doesNotMatch(source, /results\.toolCall = fail\(error/);
  assert.match(source, /results\.streaming = deferred\(undefined, error/);
  assert.match(source, /results\.toolCall = deferred\(undefined, error/);
  // A parent killed at the ceiling ran out of time; it did not refuse.
  assert.match(source, /first\.timedOut\s*\?\s*deferred\(/);
  assert.equal(runDeferred({ streaming: { outcome: "deferred" } }), true);
});
