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
  // No capability lookup here: this asserts the selection, and shelling out to
  // the machine's real Ollama would make it slow and environment-dependent.
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
    // Supplied so the test never shells out to the machine's real Ollama.
    capabilities: {
      "gemma3:4b": ["completion", "vision"],
      "qwen2.5vl:3b": ["completion", "vision"],
      "llava:latest": ["completion", "vision"],
    },
  });
  assert.equal(snapshot.installed, 3);
  assert.equal(snapshot.enabled, 1);
  assert.equal(snapshot.totalGb, 11.2);
  const byTag = Object.fromEntries(snapshot.models.map((m) => [m.tag, m]));
  assert.equal(byTag["gemma3:4b"].enabled, true);
  assert.equal(byTag["gemma3:4b"].accuracy, "accurate");
  assert.equal(byTag["qwen2.5vl:3b"].running, true);
  // Vision comes from Ollama's own report, so gemma3 counts as vision-capable
  // even though nothing in its name says so.
  assert.equal(byTag["qwen2.5vl:3b"].vision, true);
  assert.equal(byTag["gemma3:4b"].vision, true);
  // None of these can call tools, so none can be a Codex chat model.
  assert.equal(snapshot.usableAsChat, 0);
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

test("ollama's reported capabilities are parsed, not guessed from the name", async () => {
  const { parseOllamaCapabilities } = await import("../src/local-models.mjs");
  const show = `  Model
    architecture        gemma3
    parameters          4.3B

  Capabilities
    completion
    vision

  Parameters
    stop  "<end_of_turn>"
`;
  assert.deepEqual(parseOllamaCapabilities(show), ["completion", "vision"]);
  // The block ends at the next heading, so later sections are not swallowed.
  assert.ok(!parseOllamaCapabilities(show).includes("stop"));
  assert.deepEqual(parseOllamaCapabilities("no capabilities section here"), []);
});

test("a model without tool support is never published to the Codex picker", async () => {
  const { syncLocalUserModels } = await import("../src/local-models.mjs");
  const caps = {
    "qwen3:4b": ["completion", "tools"],
    "qwen2.5vl:3b": ["completion", "vision", "tools"],
    "gemma3:4b": ["completion", "vision"],
    "moondream:latest": ["completion", "vision"],
  };
  const entries = syncLocalUserModels({
    enabled: ["qwen3:4b", "qwen2.5vl:3b", "gemma3:4b", "moondream:latest"],
    capabilitiesFor: (tag) => caps[tag] || [],
  });
  // Codex cannot drive a toolless model, so publishing one hands the operator
  // a picker entry that fails on its first turn.
  assert.deepEqual(entries.map((e) => e.upstreamModel), ["qwen3:4b", "qwen2.5vl:3b"]);
  // Image input is claimed only where Ollama reports vision.
  const byId = Object.fromEntries(entries.map((e) => [e.upstreamModel, e]));
  assert.deepEqual(byId["qwen3:4b"].inputModalities, ["text"]);
  assert.deepEqual(byId["qwen2.5vl:3b"].inputModalities, ["text", "image"]);
});

test("the snapshot reports how many checked models Codex can actually drive", async () => {
  const { localModelsSnapshot, parseOllamaList } = await import("../src/local-models.mjs");
  const snapshot = localModelsSnapshot({
    inventory: parseOllamaList(
      "NAME  ID  SIZE  MODIFIED\nqwen3:4b  aaa  2.6 GB  1 hour ago\ngemma3:4b  bbb  3.3 GB  1 hour ago\n",
    ),
    running: [],
    selection: { version: 1, enabled: ["qwen3:4b", "gemma3:4b"] },
    capabilities: { "qwen3:4b": ["completion", "tools"], "gemma3:4b": ["completion", "vision"] },
  });
  assert.equal(snapshot.enabled, 2);
  assert.equal(snapshot.usableAsChat, 1);
  const byTag = Object.fromEntries(snapshot.models.map((m) => [m.tag, m]));
  assert.equal(byTag["gemma3:4b"].tools, false);
  assert.equal(byTag["gemma3:4b"].vision, true);
});

test("tool support is read from the registry template before downloading", async () => {
  const { fetchRegistryCapabilities } = await import("../src/local-models.mjs");
  const manifest = {
    layers: [
      { mediaType: "application/vnd.ollama.image.model", size: 2_000_000_000 },
      { mediaType: "application/vnd.ollama.image.template", size: 1429, digest: "sha256:abc" },
    ],
  };
  const withTemplate = (body) => async (url, init) => {
    if (url.includes("/manifests/")) return new Response(JSON.stringify(manifest), { status: 200 });
    // Blob URLs redirect to a CDN; the fetch must be told to follow.
    assert.equal(init.redirect, "follow");
    return new Response(body, { status: 200 });
  };

  const tooled = await fetchRegistryCapabilities("llama3.2:3b", {
    fetchImpl: withTemplate("{{- if .Tools }}You may call tools{{ end }}"),
  });
  assert.equal(tooled.tools, true);
  assert.equal(tooled.sizeGb, 2);

  const plain = await fetchRegistryCapabilities("gemma3:4b", {
    fetchImpl: withTemplate("<start_of_turn>{{ .Prompt }}<end_of_turn>"),
  });
  assert.equal(plain.tools, false);

  // Offline stays advisory: an unknown answer must not block an install.
  assert.equal(
    await fetchRegistryCapabilities("x", { fetchImpl: async () => { throw new Error("offline"); } }),
    undefined,
  );
});
