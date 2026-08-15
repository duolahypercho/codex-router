import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "local-models-test-"));
// Capability lookups shell out to `ollama show`, which blocks while Ollama is
// loading a large model -- a real source of intermittent failures. Every test
// that mutates the selection injects this stub instead.
const NO_OLLAMA = { capabilitiesFor: () => ["completion", "tools"] };
process.env.CODEX_ROUTER_STATE_DIR = stateDir;

const {
  CODEX_PROMPT_TOKENS,
  EXPLORE_LOCAL_MODELS,
  LOCAL_MODELS_STATE_PATH,
  describeMachine,
  fitAdvisory,
  isLocalModelEnabled,
  localModelsSnapshot,
  machineCapacity,
  parseGgufContextLength,
  parseOllamaList,
  rateModelFit,
  readLocalModelSelection,
  removeLocalModel,
  renderLocalModels,
  setLocalModelEnabled,
  suggestedLocalModels,
  suggestedExploreModels,
  suggestedVisionModels,
} = await import("../src/local-models.mjs");

// Writes the selection file directly, which is the only way to reproduce state
// left by an older build that stored whatever spelling was typed.
function writeSelectionFile(selection) {
  mkdirSync(path.dirname(LOCAL_MODELS_STATE_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(LOCAL_MODELS_STATE_PATH, `${JSON.stringify(selection)}\n`, "utf8");
}

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
  setLocalModelEnabled("gemma3:4b", true, NO_OLLAMA);
  setLocalModelEnabled("llava:latest", true, NO_OLLAMA);
  assert.deepEqual(readLocalModelSelection().enabled, ["gemma3:4b", "llava:latest"]);
  setLocalModelEnabled("llava:latest", false, NO_OLLAMA);
  assert.deepEqual(readLocalModelSelection().enabled, ["gemma3:4b"]);
});

test("the snapshot joins installed, checked, loaded, and vision state", () => {
  const snapshot = localModelsSnapshot({
    inventory: parseOllamaList(LIST),
    running: ["qwen2.5vl:3b"],
    selection: { version: 1, enabled: ["gemma3:4b"] },
    benchmarks: { "gemma3:4b": { tier: "accurate", textPercent: 100 } },
    runtime: { installed: true, running: true, version: "0.1.0" },
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
  assert.deepEqual(snapshot.runtime, { installed: true, running: true, version: "0.1.0" });
});

test("removing a model needs explicit consent and unchecks it", () => {
  setLocalModelEnabled("doomed:latest", true, NO_OLLAMA);
  assert.throws(
    () => removeLocalModel("doomed:latest", { spawn: () => ({ status: 0 }) }),
    /deletes it from disk/,
  );
  // Refused without consent, so it is still checked and still on disk.
  assert.ok(readLocalModelSelection().enabled.includes("doomed:latest"));

  let called;
  removeLocalModel("doomed:latest", {
    ...NO_OLLAMA,
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
        ...NO_OLLAMA,
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

test("model fit is rated against the machine, not a fixed list", () => {
  const laptop = machineCapacity({ totalMemoryBytes: 8e9, platform: "linux" });
  const workstation = machineCapacity({
    totalMemoryBytes: 32e9,
    gpuMemoryBytes: 24e9,
    platform: "linux",
  });
  const mac = machineCapacity({ totalMemoryBytes: 16e9, unifiedMemory: true, platform: "darwin" });

  // Sizes come from the registry manifest, so any tag can be rated.
  assert.equal(rateModelFit(18.6, laptop), "too-large");
  assert.equal(rateModelFit(18.6, workstation), "fits");
  assert.equal(rateModelFit(4.7, mac), "fits");

  // Without a GPU to fall back from, a model that would consume most of RAM
  // runs but crawls; reporting that as a clean fit is what wastes an evening.
  assert.equal(rateModelFit(4.7, laptop), "tight");
  assert.equal(rateModelFit(1.9, laptop), "fits");

  // An unknown size cannot be rated, and must not read as a refusal.
  assert.equal(rateModelFit(undefined, laptop), undefined);
  assert.equal(rateModelFit(0, laptop), undefined);
});

test("fit advisories name the shortfall and stay silent when a model fits", () => {
  const laptop = machineCapacity({ totalMemoryBytes: 8e9, platform: "linux" });
  assert.equal(fitAdvisory("qwen2.5-coder:3b", 1.9, laptop), undefined);
  assert.match(fitAdvisory("qwen2.5-coder:7b", 4.7, laptop), /close to this machine's limit/);
  const refusal = fitAdvisory("qwen3-coder:30b", 18.6, laptop);
  assert.match(refusal, /needs about 23 GB/);
  assert.match(refusal, /8\.0 GB RAM/);
});

test("a machine description says which memory the number refers to", () => {
  assert.match(
    describeMachine(machineCapacity({ totalMemoryBytes: 16e9, unifiedMemory: true })),
    /unified memory · GPU budget ~12\.0 GB/,
  );
  assert.match(
    describeMachine(machineCapacity({ totalMemoryBytes: 8e9 })),
    /no GPU memory detected/,
  );
  assert.match(
    describeMachine(machineCapacity({ totalMemoryBytes: 32e9, gpuMemoryBytes: 24e9 })),
    /24\.0 GB GPU memory/,
  );
});

test("the download list is rated, filtered, and ordered by size", () => {
  const laptop = machineCapacity({ totalMemoryBytes: 8e9, platform: "linux" });
  const suggestions = suggestedLocalModels({ capacity: laptop });

  // Nothing that cannot run here is ever offered for download.
  assert.ok(suggestions.length > 0);
  assert.ok(suggestions.every((entry) => entry.fit !== "too-large"));
  // Verified first, then size. Ordering is asserted in full by the
  // verification test; here it is enough that the untested tail is by size.
  const untested = suggestions.filter((entry) => entry.codex !== "verified");
  assert.deepEqual(
    untested.map((entry) => entry.sizeGb),
    [...untested.map((entry) => entry.sizeGb)].sort((a, b) => a - b),
  );

  // Tool support decides whether Codex can drive a model, so every entry
  // carries it rather than leaving it to be discovered after the download.
  assert.ok(suggestions.every((entry) => typeof entry.tools === "boolean"));

  // A model already downloaded is not offered again, with or without the
  // implicit :latest Ollama reports.
  const withInstalled = suggestedLocalModels({
    capacity: laptop,
    installed: [{ tag: "llama3.2:3b" }],
  });
  assert.equal(withInstalled.some((entry) => entry.tag === "llama3.2:3b"), false);
});

test("a machine too small for everything still gets an honest empty list", () => {
  const tiny = machineCapacity({ totalMemoryBytes: 1e9, platform: "linux" });
  assert.deepEqual(suggestedLocalModels({ capacity: tiny }), []);
  // Asking for the unusable ones is explicit, never the default.
  assert.ok(suggestedLocalModels({ capacity: tiny, includeUnusable: true }).length > 0);
});

test("every catalog model stays reachable on a machine that cannot run it", () => {
  // The shortlists are recommendations and drop what will not fit. That must
  // not make a model disappear entirely: an 8 GB laptop previously had no list
  // containing qwen2.5-coder:14b, gpt-oss:20b or devstral, so there was no way
  // to install one even on purpose.
  const laptop = machineCapacity({ totalMemoryBytes: 8e9, platform: "linux" });
  const shortlisted = suggestedLocalModels({ capacity: laptop, includeUnusable: true });
  const recommended = new Set(suggestedLocalModels({ capacity: laptop }).map((e) => e.tag));
  const dropped = shortlisted.filter((entry) => !recommended.has(entry.tag));
  assert.ok(dropped.length > 0, "expected this machine to be too small for something");

  const explore = suggestedExploreModels({ capacity: laptop });
  const exploreTags = new Set(explore.map((entry) => entry.tag));
  for (const entry of dropped) {
    assert.ok(exploreTags.has(entry.tag), `${entry.tag} is unreachable`);
  }
  // Reachable, but still honestly labelled, so the caller can warn.
  assert.equal(explore.find((entry) => entry.tag === "gpt-oss:20b").fit, "too-large");
  // Image readers the vision shortlist hid are reachable for the same reason.
  const visionShown = new Set(suggestedVisionModels({ capacity: laptop }).map((e) => e.tag));
  assert.ok(!visionShown.has("qwen2.5vl:7b"));
  assert.ok(exploreTags.has("qwen2.5vl:7b"));

  // One row per model. `devstral` and `devstral:latest` are the same weights
  // spelled two ways across the shortlist and the explore catalog.
  assert.equal(explore.length, exploreTags.size);
  assert.deepEqual(
    explore.filter((entry) => entry.family === "devstral").map((entry) => entry.tag),
    ["devstral"],
  );
  // An already-installed model is still never re-offered.
  const withInstalled = suggestedExploreModels({
    capacity: laptop,
    installed: [{ tag: "gpt-oss:20b" }],
  });
  assert.ok(!withInstalled.some((entry) => entry.tag === "gpt-oss:20b"));
});

test("every catalog entry carries the fields the tray decoder requires", () => {
  // `AvailableLocalModel` in the macOS tray declares these non-optional. Swift
  // fails the whole array on one bad element, so a single catalog entry missing
  // `note` would empty the catalog in the UI without any visible error. The
  // explore list merges three catalogs with different shapes, which is exactly
  // where such a gap would appear.
  const required = { tag: "string", sizeGb: "number", tools: "boolean", note: "string", fit: "string" };
  const machines = [
    machineCapacity({ totalMemoryBytes: 8e9, platform: "linux" }),
    machineCapacity({ totalMemoryBytes: 128e9, unifiedMemory: true, freeDiskBytes: 2e12 }),
  ];
  for (const capacity of machines) {
    for (const entry of suggestedExploreModels({ capacity })) {
      for (const [key, type] of Object.entries(required)) {
        assert.equal(typeof entry[key], type, `${entry.tag} has no usable ${key}`);
      }
    }
  }
});

test("one model checked under two spellings stays one entry", () => {
  // The downloader stores the normalized `devstral:latest`; a hand-typed
  // `devstral` is the same model. Keying the selection on the raw string let
  // both land in the file, and `set devstral off` then cleared neither.
  // The whole file shares one state directory, so put back what was there.
  const restore = readLocalModelSelection();
  try {
    writeSelectionFile({ version: 1, enabled: [] });
    setLocalModelEnabled("devstral:latest", true, NO_OLLAMA);
    setLocalModelEnabled("devstral", true, NO_OLLAMA);
    assert.deepEqual(readLocalModelSelection().enabled, ["devstral:latest"]);
    assert.equal(isLocalModelEnabled("devstral"), true);
    assert.equal(isLocalModelEnabled("devstral:latest"), true);

    // Unchecking through the other spelling has to clear it.
    setLocalModelEnabled("devstral", false, NO_OLLAMA);
    assert.deepEqual(readLocalModelSelection().enabled, []);
    assert.equal(isLocalModelEnabled("devstral:latest"), false);
  } finally {
    writeSelectionFile(restore);
  }
});

test("a legacy bare tag in the selection file is matched and migrated", () => {
  const restore = readLocalModelSelection();
  try {
    // State written before tags were canonicalized holds the bare spelling.
    writeSelectionFile({ version: 1, enabled: ["mistral"] });
    assert.equal(isLocalModelEnabled("mistral:latest"), true);
    // `ollama list` reports the tagged spelling, so the row must read as checked.
    const snapshot = localModelsSnapshot({
      inventory: parseOllamaList(
        "NAME  ID  SIZE  MODIFIED\nmistral:latest  aaa  4.4 GB  1 hour ago\n",
      ),
      running: [],
      capabilities: { "mistral:latest": ["completion", "tools"] },
    });
    assert.equal(snapshot.models[0].enabled, true);
    // The next write leaves one canonical entry behind, not two.
    setLocalModelEnabled("mistral:latest", true, NO_OLLAMA);
    assert.deepEqual(readLocalModelSelection().enabled, ["mistral:latest"]);
  } finally {
    writeSelectionFile(restore);
  }
});

test("the listing renders for a person, not only for the tray", () => {
  const snapshot = localModelsSnapshot({
    inventory: parseOllamaList(
      "NAME  ID  SIZE  MODIFIED\nllama3.2:3b  aaa  2.0 GB  1 hour ago\ngemma3:4b  bbb  3.3 GB  1 hour ago\n",
    ),
    running: ["llama3.2:3b"],
    selection: { version: 1, enabled: ["llama3.2:3b"] },
    capabilities: {
      "llama3.2:3b": ["completion", "tools"],
      "gemma3:4b": ["completion", "vision"],
    },
  });
  const rendered = renderLocalModels(snapshot);

  // The checkbox is what offers a model to Codex, so it leads each row.
  assert.match(rendered, /\[x\] llama3\.2:3b\s+2\.0 GB\s+code\s+· loaded/);
  // A model Codex cannot drive must say so where the choice is made.
  assert.match(rendered, /\[ \] gemma3:4b\s+3\.3 GB\s+images only/);
  // The two groups answer different questions and are never merged.
  assert.match(rendered, /For coding — experimental/);
  assert.match(rendered, /For reading images only — cannot code:/);
  assert.match(rendered, /Explore Ollama tags/);
  assert.match(rendered, /qwen3\.5:cloud\s+cloud only · not downloadable/);
  assert.match(rendered, /control local-models install .* --yes/);
});

test("an empty machine reads as empty rather than as a broken table", () => {
  const rendered = renderLocalModels(
    localModelsSnapshot({ inventory: [], running: [], selection: { version: 1, enabled: [] } }),
  );
  assert.match(rendered, /Installed: none yet/);
  // The whole point of the empty state is that it says what to do next.
  assert.match(rendered, /For coding/);
});

test("coding models are separated from image readers", () => {
  const roomy = machineCapacity({ totalMemoryBytes: 64e9, unifiedMemory: true });

  // Every coding suggestion must be able to do the job: Codex drives through
  // tool calls, and a small window makes a model useless on real code.
  for (const entry of suggestedLocalModels({ capacity: roomy })) {
    assert.equal(entry.tools, true, `${entry.tag} cannot call tools`);
    assert.ok(entry.context >= 32_768, `${entry.tag} has too little context`);
  }

  // Image readers are a different question, so they never appear as coding
  // suggestions and are ranked by what they actually scored, not by size.
  const vision = suggestedVisionModels({ capacity: roomy });
  const codingTags = new Set(suggestedLocalModels({ capacity: roomy }).map((e) => e.tag));
  assert.ok(vision.length > 0);
  assert.ok(vision.every((entry) => !codingTags.has(entry.tag)));
  assert.equal(vision[0].accuracy, "accurate");
  // The smallest reader scored zero on text, so size must not float it up.
  assert.notEqual(vision[0].tag, "moondream");
  assert.ok(vision.at(-1).accuracy === "captions-only");
});

test("the explore catalog groups the requested Ollama families and keeps fit visible", () => {
  const entries = suggestedExploreModels({
    capacity: machineCapacity({ totalMemoryBytes: 16e9, unifiedMemory: true }),
  });
  const tags = new Set(entries.map((entry) => entry.tag));
  for (const tag of [
    "gemma4:e2b-it-q4_K_M",
    "gemma4:12b",
    "gemma4:31b-mlx-bf16",
    "qwen3.5:9b",
    "qwen3.5:35b-a3b-coding-nvfp4",
    "qwen3.6:27b",
    "qwen3.6:35b-a3b-mtp-q4_K_M",
    "qwen3.8:latest",
    "qwen3.8:27b",
    "qwen3.8:27b-mlx",
    "qwen3.8:27b-mlx-bf16",
    "qwen3.8:27b-mtp-q4_K_M",
    "qwen3.8:27b-mtp-q8_0",
    "qwen3.8:27b-mtp-bf16",
    "qwen3.8:27b-mxfp8",
    "qwen3.8:27b-nvfp4",
    "qwen3.8:27b-q4_K_M",
    "qwen3.8:27b-q8_0",
    "qwen3.8:27b-bf16",
    "nemotron-3-super:120b",
    "nemotron-3-super:120b-a12b-q8_0",
    "nemotron-3.5-lightning:latest",
    "nemotron-3.5-lightning:30b",
    "nemotron-3.5-lightning:30b-a3b",
    "nemotron-3.5-lightning:30b-a3b-q4_K_M",
    "nemotron-3.5-lightning:30b-a3b-mlx",
    "nemotron-3.5-lightning:30b-a3b-mlx-bf16",
    "nemotron-3.5-lightning:30b-a3b-mxfp8",
    "nemotron-3.5-lightning:30b-a3b-nvfp4",
    "nemotron-3.5-lightning:30b-a3b-q8_0",
    "nemotron-3.5-lightning:30b-a3b-bf16",
    "nemotron-3.5-lightning:30b-mlx",
    "ornith:9b",
    "ornith:35b-bf16",
    "nemotron3:33b",
    "nemotron3:33b-q8",
    "muse-glimmer:30b",
    "muse-glimmer:30b-mlx-bf16-dflash",
  ]) assert.ok(tags.has(tag), tag);
  assert.equal(entries.find((entry) => entry.tag === "nemotron-3-super:120b").fit, "too-large");
  assert.equal(entries.find((entry) => entry.tag === "gemma4:12b").tools, false);
  assert.equal(EXPLORE_LOCAL_MODELS.length, 201);
  assert.equal(new Set(EXPLORE_LOCAL_MODELS.map((entry) => entry.tag)).size, 201);
  // The qwen3.8 capture (2026-08-15): 12 official 27B tags, 256K context.
  assert.equal(
    entries.find((entry) => entry.tag === "qwen3.8:27b").researchStatus,
    "Official Ollama · 12 tags",
  );
  assert.equal(entries.find((entry) => entry.tag === "qwen3.8:27b").context, 262144);
  const cloud = entries.find((entry) => entry.tag === "qwen3.5:cloud");
  assert.equal(cloud.downloadable, false);
  assert.equal(cloud.fit, "cloud-only");
  assert.equal(cloud.diskFit, "cloud-only");
  assert.equal(entries.find((entry) => entry.tag === "qwen3.5:2b-q4_K_M").sizeGb, 1.9);
  assert.equal(
    entries.find((entry) => entry.tag === "gemma4:latest").researchStatus,
    "Official Ollama · 49 tags",
  );
  assert.deepEqual(
    entries.find((entry) => entry.tag === "gemma4:latest").researchCapabilities,
    ["vision", "tools", "thinking", "audio"],
  );
  assert.equal(
    entries.find((entry) => entry.tag === "muse-glimmer:latest").researchStatus,
    "Official Ollama · 15 tags",
  );
  assert.equal(
    entries.find((entry) => entry.tag === "nemotron-3.5-lightning:latest").researchStatus,
    "Official Ollama · 11 tags",
  );
  assert.equal(
    entries.find((entry) => entry.tag === "qwen3.8:latest").researchStatus,
    "Official Ollama · 12 tags",
  );
  assert.deepEqual(
    entries.find((entry) => entry.tag === "qwen3.8:latest").researchCapabilities,
    ["vision", "tools", "thinking"],
  );
  assert.equal(entries.find((entry) => entry.tag === "qwen3.8:27b-mtp-q8_0").sizeGb, 30);
  assert.deepEqual(
    entries.find((entry) => entry.tag === "nemotron-3.5-lightning:latest").researchCapabilities,
    ["tools", "thinking"],
  );
});

// A GGUF header built by hand, so the parser is tested without the network and
// without a multi-gigabyte fixture.
function ggufHeader(pairs, { magic = 0x46554747, declaredPairs } = {}) {
  const chunks = [];
  const u32 = (value) => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(value);
    return buffer;
  };
  const u64 = (value) => {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64LE(BigInt(value));
    return buffer;
  };
  const str = (value) => {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([u64(bytes.length), bytes]);
  };
  chunks.push(u32(magic), u32(3), u64(0), u64(declaredPairs ?? pairs.length));
  for (const [key, type, value] of pairs) {
    chunks.push(str(key), u32(type));
    if (type === 8) chunks.push(str(value));
    else if (type === 4) chunks.push(u32(value));
    else if (type === 10) chunks.push(u64(value));
    else if (type === 9) {
      // Array of strings, the shape a tokenizer vocabulary takes.
      chunks.push(u32(8), u64(value.length), ...value.map(str));
    }
  }
  return Buffer.concat(chunks);
}

test("context length is read from the model's own GGUF header", () => {
  const buffer = ggufHeader([
    ["general.architecture", 8, "llama"],
    ["general.name", 8, "Llama 3.2 3B Instruct"],
    ["llama.block_count", 4, 28],
    ["llama.context_length", 4, 131072],
  ]);
  assert.equal(parseGgufContextLength(buffer), 131072);

  // The key is namespaced by architecture, so the parser matches the suffix
  // rather than one vendor's spelling.
  assert.equal(
    parseGgufContextLength(
      ggufHeader([["qwen2.context_length", 10, 32768]]),
    ),
    32768,
  );
});

test("a tokenizer array before the key is walked, not guessed past", () => {
  // An array's byte length is only knowable by walking it: skipping blindly
  // would desynchronise the reader and return a garbage context length.
  const buffer = ggufHeader([
    ["general.architecture", 8, "llama"],
    ["tokenizer.ggml.tokens", 9, ["<s>", "</s>", "hello", "world"]],
    ["llama.context_length", 4, 8192],
  ]);
  assert.equal(parseGgufContextLength(buffer), 8192);
});

test("an unreadable header is unknown rather than an error", () => {
  // Not GGUF at all.
  assert.equal(parseGgufContextLength(Buffer.from("not a model file")), undefined);
  // Truncated mid-value: the ranged read ended before the key appeared, which
  // must never fail an install.
  const truncated = ggufHeader([
    ["general.architecture", 8, "llama"],
    ["llama.context_length", 4, 4096],
  ]).subarray(0, 40);
  assert.equal(parseGgufContextLength(truncated), undefined);
  // Claims more pairs than it carries.
  assert.equal(
    parseGgufContextLength(ggufHeader([["general.architecture", 8, "llama"]], { declaredPairs: 9 })),
    undefined,
  );
});

test("only a model observed driving Codex is marked verified", () => {
  const suggestions = suggestedLocalModels({
    capacity: machineCapacity({ totalMemoryBytes: 64e9, unifiedMemory: true }),
  });

  // A tool template predicts capability in neither direction, so nothing may
  // claim more than was observed.
  assert.ok(suggestions.every((entry) => ["verified", "untested"].includes(entry.codex)));
  const verified = suggestions.filter((entry) => entry.codex === "verified");
  assert.deepEqual(verified.map((entry) => entry.tag), ["llama3.2:3b"]);

  // Proven first: an untested model is a thing to try, not a recommendation,
  // and sorting by size alone would bury the only one known to work.
  assert.equal(suggestions[0].tag, "llama3.2:3b");
  assert.ok(suggestions[1].sizeGb < suggestions[0].sizeGb);
});

test("the listing says how little room Codex leaves in the window", () => {
  const rendered = renderLocalModels(
    localModelsSnapshot({ inventory: [], running: [], selection: { version: 1, enabled: [] } }),
  );
  // Native context above the advertised cap buys nothing, so the number that
  // matters is what is left after Codex's own prompt.
  assert.match(rendered, /For coding — experimental/);
  // Derived from the measured constant rather than restated, so the copy and
  // the measurement cannot drift apart.
  assert.match(rendered, new RegExp(`${Math.round(CODEX_PROMPT_TOKENS / 1000)}K of the 32K window`));
  assert.match(rendered, /agent-check/);
});

