import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "local-models-test-"));
process.env.CODEX_ROUTER_STATE_DIR = stateDir;

const {
  localModelsSnapshot,
  parseOllamaList,
  readLocalModelSelection,
  removeLocalModel,
  setLocalModelEnabled,
} = await import("../src/local-models.mjs");

const LIST = `NAME                ID              SIZE      MODIFIED
gemma3:4b           a2af6cc3eb7f    3.3 GB    19 minutes ago
qwen2.5vl:3b        fb90415cde1e    3.2 GB    2 hours ago
llava:latest        8dd30f6b0cb1    4.7 GB    3 days ago
`;

test("ollama list is parsed into tag, size, and age", () => {
  const models = parseOllamaList(LIST);
  assert.deepEqual(models.map((m) => m.tag), ["gemma3:4b", "qwen2.5vl:3b", "llava:latest"]);
  assert.equal(models[0].sizeGb, 3.3);
  assert.equal(models[0].modified, "19 minutes ago");
  // An empty store is an empty list, never a crash.
  assert.deepEqual(parseOllamaList("NAME  ID  SIZE  MODIFIED\n"), []);
});

test("checking a model is separate from installing or deleting it", () => {
  assert.deepEqual(readLocalModelSelection().enabled, []);
  setLocalModelEnabled("gemma3:4b", true);
  setLocalModelEnabled("llava:latest", true);
  assert.deepEqual(readLocalModelSelection().enabled, ["gemma3:4b", "llava:latest"]);
  setLocalModelEnabled("llava:latest", false);
  assert.deepEqual(readLocalModelSelection().enabled, ["gemma3:4b"]);
});

test("the snapshot joins installed, checked, loaded, and vision state", () => {
  const snapshot = localModelsSnapshot({
    inventory: parseOllamaList(LIST),
    running: ["qwen2.5vl:3b"],
    selection: { version: 1, enabled: ["gemma3:4b"] },
    benchmarks: { "gemma3:4b": { tier: "accurate", textPercent: 100 } },
  });
  assert.equal(snapshot.installed, 3);
  assert.equal(snapshot.enabled, 1);
  assert.equal(snapshot.totalGb, 11.2);
  const byTag = Object.fromEntries(snapshot.models.map((m) => [m.tag, m]));
  assert.equal(byTag["gemma3:4b"].enabled, true);
  assert.equal(byTag["gemma3:4b"].accuracy, "accurate");
  assert.equal(byTag["qwen2.5vl:3b"].running, true);
  // Vision capability is recognised by family name.
  assert.equal(byTag["qwen2.5vl:3b"].vision, true);
  assert.equal(byTag["gemma3:4b"].vision, false);
});

test("removing a model needs explicit consent and unchecks it", () => {
  setLocalModelEnabled("doomed:latest", true);
  assert.throws(
    () => removeLocalModel("doomed:latest", { spawn: () => ({ status: 0 }) }),
    /deletes it from disk/,
  );
  // Refused without consent, so it is still checked and still on disk.
  assert.ok(readLocalModelSelection().enabled.includes("doomed:latest"));

  let called;
  removeLocalModel("doomed:latest", {
    confirmed: true,
    spawn: (bin, args) => { called = { bin, args }; return { status: 0 }; },
  });
  assert.deepEqual(called, { bin: "ollama", args: ["rm", "doomed:latest"] });
  // A model that is gone must not stay checked.
  assert.ok(!readLocalModelSelection().enabled.includes("doomed:latest"));
});

test("a failed removal surfaces ollama's own message", () => {
  assert.throws(
    () =>
      removeLocalModel("missing", {
        confirmed: true,
        spawn: () => ({ status: 1, stderr: "model 'missing' not found" }),
      }),
    /model 'missing' not found/,
  );
});
