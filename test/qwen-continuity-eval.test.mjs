import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { fixtureManifest, goldenExtraction, loadFixtures, REMOTE_PYTHON, scoreExtraction, transport, validateCompletion, validateSnapshot } from "../scripts/eval-qwen-continuity.mjs";

const fixtures = loadFixtures().filter((fixture) => fixture.type === "retention");
const copy = (value) => structuredClone(value);
const localPythonAvailable = spawnSync("python3", ["--version"], { encoding: "utf8", timeout: 2000 }).status === 0;
const missingPythonReason = "Optional local Python 3 runtime is unavailable";

for (const fixture of fixtures) {
  test(`${fixture.id}: known-good full associations pass`, () => {
    const result = scoreExtraction(JSON.stringify(goldenExtraction(fixture)), fixture);
    assert.equal(result.passed, true, JSON.stringify(result.failures));
    assert.equal(result.passedFacts, fixture.expected.records.length);
  });

  test(`${fixture.id}: missing fact and swapped path associations fail`, () => {
    const missing = goldenExtraction(fixture);
    missing.records.splice(0, 1);
    assert.equal(scoreExtraction(JSON.stringify(missing), fixture).passed, false);
    const swapped = goldenExtraction(fixture);
    [swapped.records[0].path, swapped.records[1].path] = [swapped.records[1].path, swapped.records[0].path];
    assert.equal(scoreExtraction(JSON.stringify(swapped), fixture).passedFacts, fixture.expected.records.length - 2);
  });

  test(`${fixture.id}: correct markers with wrong fix, verification, owner or status fail`, () => {
    for (const field of ["fix", "verification", "owner", "status", "dependency"]) {
      const changed = goldenExtraction(fixture);
      const index = field === "dependency" ? fixture.expected.records.findIndex((record) => record.golden.dependency !== "none") : 0;
      changed.records[index][field] = field === "status" ? "pending" : "unrelated";
      const score = scoreExtraction(JSON.stringify(changed), fixture);
      assert.equal(score.passed, false, field);
      assert.equal(score.facts[index].passed, false, field);
    }
  });

  test(`${fixture.id}: obsolete correction, missing actions and missing boundaries fail`, () => {
    const changed = goldenExtraction(fixture);
    const corrected = fixture.expected.records.findIndex((record) => record.status === "blocked");
    changed.records[corrected].status = "pending";
    changed.records[corrected].owner = "agent";
    changed.actions = [];
    changed.constraints = [];
    changed.rejected_approaches = [];
    const score = scoreExtraction(JSON.stringify(changed), fixture);
    assert.equal(score.passed, false);
    assert(score.failures.some((failure) => failure.startsWith("action:")));
    assert(score.failures.some((failure) => failure.startsWith("constraint:")));
    assert(score.failures.some((failure) => failure.startsWith("rejected:")));
  });

  test(`${fixture.id}: secret leakage and untrusted authorization are detected`, () => {
    const leaked = goldenExtraction(fixture);
    leaked.constraints.push(fixture.forbiddenValues[0]);
    assert(scoreExtraction(JSON.stringify(leaked), fixture).failures.includes("secret_leakage"));
    const promoted = goldenExtraction(fixture);
    promoted.actions.push({ task: fixture.unauthorizedPositiveControl, owner: "agent", dependency: "none" });
    assert(scoreExtraction(JSON.stringify(promoted), fixture).failures.some((failure) => failure.startsWith("unauthorized_action:")));
  });

  test(`${fixture.id}: malformed or fenced JSON is invalid, not a retention zero`, () => {
    for (const content of ["{", "```json\n{}\n```", JSON.stringify({ records: [null], constraints: [], rejected_approaches: [], actions: [] })]) {
      assert.equal(scoreExtraction(content, fixture).valid, false);
    }
  });
}

test("transport rejection detects HTTP errors, malformed, missing, empty and length outputs", () => {
  const good = { httpStatus: 200, body: { model: "synthetic", choices: [{ finish_reason: "stop", message: { content: "result" } }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } } };
  assert.equal(validateCompletion(good, ["synthetic"]).valid, true);
  const length = copy(good); length.body.choices[0].finish_reason = "length";
  const empty = copy(good); empty.body.choices[0].message.content = " ";
  const missingUsage = copy(good); delete missingUsage.body.usage;
  const badUsage = copy(good); badUsage.body.usage.total_tokens = 3;
  for (const item of [{ httpStatus: 503 }, { httpStatus: 200, malformed: true }, { httpStatus: 200, body: { choices: [] } }, length, empty, missingUsage, badUsage]) assert.equal(validateCompletion(item, ["synthetic"]).valid, false);
  assert.equal(validateCompletion(good, ["other"]).reason, "unmeasured_model");
  assert.equal(validateCompletion(good).reason, "unmeasured_model");
});

test("remote Python source compiles and the compile check rejects invalid source", { skip: localPythonAvailable ? false : missingPythonReason }, () => {
  const compile = (input) => spawnSync("python3", ["-c", "import sys; compile(sys.stdin.read(), '<remote-transport>', 'exec')"], { input, encoding: "utf8" });
  assert.equal(compile(REMOTE_PYTHON).status, 0, compile(REMOTE_PYTHON).stderr);
  assert.notEqual(compile("def invalid syntax").status, 0);
});

test("actual SSH command shell and Python HTTP transport preserve structured stdin", {
  skip: process.platform === "win32" ? "POSIX shell transport qualification is not supported on Windows" : localPythonAvailable ? false : missingPythonReason,
}, async () => {
  const received = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      received.push(body ? JSON.parse(body) : null);
      if (request.url === "/malformed") { response.end("not-json"); return; }
      if (request.url === "/failure") { response.writeHead(503); response.end("raw-failure"); return; }
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ model: "synthetic", choices: [{ finish_reason: "stop", message: { content: "verified", reasoning_content: "discard" } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const options = { sshHost: "synthetic-host", sshCommand: process.execPath, sshPrefixArgs: [fileURLToPath(new URL("./fixtures/qwen-continuity/ssh-stub.mjs", import.meta.url))] };
    const payload = { messages: [{ role: "user", content: "A quote ' and \" plus `literal` $(not-a-command)\nsecond line" }] };
    const result = await transport(payload, { ...options, endpoint: `${base}/success` });
    assert.deepEqual(received[0], payload);
    assert.equal(validateCompletion(result, ["synthetic"]).valid, true);
    assert.equal(result.body.choices[0].message.reasoning_content, undefined);
    const malformed = await transport(payload, { ...options, endpoint: `${base}/malformed` });
    assert.equal(malformed.raw, "not-json");
    assert.equal(validateCompletion(malformed, ["synthetic"]).valid, false);
    const failed = await transport(payload, { ...options, endpoint: `${base}/failure` });
    assert.equal(failed.httpStatus, 503);
    assert.equal(failed.raw, "raw-failure");
    await assert.rejects(transport(payload), /explicit --ssh-host/);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("nine-section snapshot shape rejects missing, duplicated, reordered and wrapped output", () => {
  const tags = ["primary_request_and_intent", "key_technical_concepts", "files_and_code_sections", "errors_and_fixes", "problem_solving", "all_user_messages", "pending_tasks", "current_work", "next_step"];
  const valid = `<state_snapshot>${tags.map((tag) => `<${tag}>value</${tag}>`).join("")}</state_snapshot>`;
  assert.equal(validateSnapshot(valid).valid, true);
  for (const invalid of [valid.replace("<next_step>value</next_step>", ""), valid.replace("</state_snapshot>", "<next_step>duplicate</next_step></state_snapshot>"), valid.replace("<next_step>value</next_step>", "<analysis>secret</analysis><next_step>value</next_step>"), `preface\n${valid}`]) assert.equal(validateSnapshot(invalid).valid, false);
});

test("fixtures and declared call plan remain bounded and synthetic", () => {
  const loaded = loadFixtures();
  const manifest = fixtureManifest(loaded);
  assert.equal(manifest.requestPlan.total, 22);
  assert(manifest.requestPlan.total <= manifest.maxCalls);
  assert.equal(manifest.requestPlan.maxConcurrent, 2);
  for (const fixture of fixtures) {
    assert(fixture.expected.records.length >= 10);
    assert(fixture.firstHistory.some((item) => item.type === "function_call_output"));
    assert(fixture.secondHistory.some((item) => item.role === "user"));
    const bytes = Buffer.byteLength(JSON.stringify(fixture.firstHistory));
    assert(bytes >= 35000 && bytes <= 100000, `${fixture.id}: ${bytes}`);
    for (const record of fixture.expected.records) assert(record.path.startsWith("/workspace/demo/"));
  }
});
