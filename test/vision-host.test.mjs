import assert from "node:assert/strict";
import test from "node:test";

import {
  annotateLocalModels,
  detectLocalRuntimes,
  hostVisionProfile,
  isVisionModelId,
  KNOWN_LOCAL_RUNTIMES,
  ollamaAvailable,
  ollamaInstalledModels,
  probeLocalServer,
  pullOllamaModel,
  suggestLocalVisionSetup,
} from "../src/vision-host.mjs";

const GIB = 1024 ** 3;

test("hardware recommendation scales with memory", () => {
  assert.equal(hostVisionProfile({ totalMemBytes: 4 * GIB }).recommended, "moondream");
  assert.equal(hostVisionProfile({ totalMemBytes: 8 * GIB }).recommended, "qwen2.5vl:3b");
  assert.equal(hostVisionProfile({ totalMemBytes: 16 * GIB }).recommended, "qwen2.5vl:7b");
  assert.equal(hostVisionProfile({ totalMemBytes: 32 * GIB }).recommended, "qwen2.5vl:7b");
});

test("apple silicon is reported as unified memory", () => {
  const mac = hostVisionProfile({ totalMemBytes: 16 * GIB, arch: "arm64", platform: "darwin" });
  assert.equal(mac.appleSilicon, true);
  assert.equal(mac.memoryProxy, "unified");
  const pc = hostVisionProfile({ totalMemBytes: 16 * GIB, arch: "x64", platform: "linux" });
  assert.equal(pc.appleSilicon, false);
  assert.equal(pc.memoryProxy, "system-ram");
});

test("vision model families are recognized by name", () => {
  for (const id of ["qwen2.5vl:3b", "moondream", "llava:7b", "llama3.2-vision:11b", "minicpm-v"]) {
    assert.equal(isVisionModelId(id), true, id);
  }
  for (const id of ["deepseek-v4-pro", "llama3.1:8b", "qwen2.5:7b", "nomic-embed-text"]) {
    assert.equal(isVisionModelId(id), false, id);
  }
});

test("probeLocalServer lists pulled vision models", async () => {
  const server = await probeLocalServer("http://127.0.0.1:11434/v1", {
    fetchImpl: async (url) => {
      assert.equal(url, "http://127.0.0.1:11434/v1/models");
      return new Response(
        JSON.stringify({ object: "list", data: [{ id: "qwen2.5vl:3b" }, { id: "llama3.1:8b" }] }),
        { status: 200 },
      );
    },
  });
  assert.equal(server.reachable, true);
  assert.deepEqual(server.visionModels, ["qwen2.5vl:3b"]);
});

test("an unreachable server degrades to a clear, non-throwing result", async () => {
  const server = await probeLocalServer("http://127.0.0.1:11434/v1", {
    fetchImpl: async () => {
      throw Object.assign(new Error("connect ECONNREFUSED"), { name: "TypeError" });
    },
  });
  assert.equal(server.reachable, false);
  assert.equal(server.error, "not reachable");
  assert.deepEqual(server.visionModels, []);
});

test("an already-pulled vision model wins over the hardware pick", async () => {
  const suggestion = await suggestLocalVisionSetup(
    {},
    {
      host: { totalMemBytes: 16 * GIB }, // hardware would suggest qwen2.5vl:7b
      probe: {
        fetchImpl: async () =>
          new Response(JSON.stringify({ data: [{ id: "moondream" }] }), { status: 200 }),
      },
    },
  );
  assert.equal(suggestion.chosen, "moondream");
  assert.equal(suggestion.needsPull, false);
  assert.equal(suggestion.pullCommand, null);
  assert.match(suggestion.pinCommand, /vision-bridge local moondream$/);
});

test("known runtimes cover ollama, llama.cpp, and lm-studio", () => {
  assert.deepEqual(
    KNOWN_LOCAL_RUNTIMES.map((r) => r.name),
    ["ollama", "llama.cpp", "lm-studio"],
  );
});

test("detectLocalRuntimes finds llama.cpp serving a vision model", async () => {
  const runtimes = await detectLocalRuntimes({
    fetchImpl: async (url) => {
      // Only llama.cpp's port answers, and it serves a Qwen-VL GGUF.
      if (url.startsWith("http://127.0.0.1:8080/")) {
        return new Response(
          JSON.stringify({ data: [{ id: "Qwen2.5-VL-3B-Instruct-GGUF" }] }),
          { status: 200 },
        );
      }
      throw new Error("connection refused");
    },
  });
  const llama = runtimes.find((r) => r.name === "llama.cpp");
  assert.equal(llama.reachable, true);
  assert.deepEqual(llama.visionModels, ["Qwen2.5-VL-3B-Instruct-GGUF"]);
  assert.equal(runtimes.find((r) => r.name === "ollama").reachable, false);
});

test("suggest points the pin at the runtime that is actually up", async () => {
  // Nothing on Ollama's port; llama.cpp (8080) is serving a vision model.
  const suggestion = await suggestLocalVisionSetup(
    {},
    {
      host: { totalMemBytes: 16 * (1024 ** 3) },
      probe: {
        fetchImpl: async (url) => {
          if (url.startsWith("http://127.0.0.1:8080/")) {
            return new Response(JSON.stringify({ data: [{ id: "llava:7b" }] }), { status: 200 });
          }
          throw new Error("refused");
        },
      },
    },
  );
  assert.deepEqual(suggestion.runningRuntimes, ["llama.cpp"]);
  assert.equal(suggestion.chosen, "llava:7b");
  assert.equal(suggestion.baseUrl, "http://127.0.0.1:8080/v1");
  assert.equal(suggestion.pinCommand, "./bin/control vision-bridge local llava:7b http://127.0.0.1:8080/v1");
});

test("with no server, the hardware pick needs a pull", async () => {
  const suggestion = await suggestLocalVisionSetup(
    {},
    {
      host: { totalMemBytes: 8 * GIB },
      probe: { fetchImpl: async () => { throw new Error("down"); } },
    },
  );
  assert.equal(suggestion.chosen, "qwen2.5vl:3b");
  assert.equal(suggestion.needsPull, true);
  assert.equal(suggestion.pullCommand, "ollama pull qwen2.5vl:3b");
});

test("ollamaAvailable reflects whether the CLI runs", () => {
  assert.equal(ollamaAvailable({ spawn: () => ({ status: 0 }) }), true);
  assert.equal(ollamaAvailable({ spawn: () => ({ status: 1 }) }), false);
  assert.equal(
    ollamaAvailable({ spawn: () => { throw Object.assign(new Error("nope"), { code: "ENOENT" }); } }),
    false,
  );
});

test("pullOllamaModel shells out to `ollama pull` and fails loudly", () => {
  let called;
  const model = pullOllamaModel("qwen2.5vl:3b", {
    spawn: (bin, args) => { called = { bin, args }; return { status: 0 }; },
  });
  assert.equal(model, "qwen2.5vl:3b");
  assert.deepEqual(called, { bin: "ollama", args: ["pull", "qwen2.5vl:3b"] });
  assert.throws(
    () => pullOllamaModel("x", { spawn: () => ({ status: 1 }) }),
    /ollama pull x` failed/,
  );
});

test("ollamaInstalledModels parses `ollama list` output", () => {
  const tags = ollamaInstalledModels({
    spawn: () => ({
      status: 0,
      stdout:
        "NAME                ID              SIZE      MODIFIED\n" +
        "llava:latest        8dd30f6b0cb1    4.7 GB    3 days ago\n" +
        "moondream:latest    55fc3abd3867    1.7 GB    3 days ago\n",
    }),
  });
  assert.deepEqual(tags, ["llava:latest", "moondream:latest"]);
  // A missing/failed CLI is an empty list, never a throw.
  assert.deepEqual(ollamaInstalledModels({ spawn: () => ({ status: 1 }) }), []);
});

test("local catalog is annotated with fit and installed state", () => {
  const models = annotateLocalModels({
    profile: hostVisionProfile({ totalMemBytes: 8 * (1024 ** 3) }),
    installed: ["moondream:latest", "llava:latest"],
  });
  const byTag = Object.fromEntries(models.map((m) => [m.tag, m]));
  // 8 GB fits the 8 GB-class models but not the 16 GB ones.
  assert.equal(byTag["qwen2.5vl:3b"].fits, true);
  assert.equal(byTag["qwen2.5vl:7b"].fits, false);
  // `latest`-matching: catalog "llava"/"moondream" recognize installed *:latest.
  assert.equal(byTag["moondream"].installed, true);
  assert.equal(byTag["llava"].installed, true);
  assert.equal(byTag["qwen2.5vl:3b"].installed, false);
  // The recommended default is present and carries size + RAM metadata.
  assert.equal(byTag["qwen2.5vl:3b"].recommended, true);
  assert.equal(byTag["qwen2.5vl:3b"].sizeGb, 3.2);
});

test("the picker ranks proven readers above caption-only models", () => {
  const models = annotateLocalModels({
    profile: hostVisionProfile({ totalMemBytes: 32 * (1024 ** 3) }),
    installed: [],
  });
  // Whatever the sizes, a model that fabricates text must never sort first.
  assert.equal(models[0].accuracy, "accurate");
  assert.equal(models.at(-1).accuracy, "captions-only");
  // Moondream is the smallest download but sorts last on measured accuracy.
  assert.ok(
    models.findIndex((m) => m.tag === "moondream") >
      models.findIndex((m) => m.tag === "qwen2.5vl:3b"),
  );
  // Every entry carries a tier, so the tray always has a badge to show.
  assert.ok(models.every((m) => typeof m.accuracy === "string" && m.accuracy));
});

test("registry manifest sizes are summed across layers", async () => {
  const { fetchRegistrySize } = await import("../src/vision-host.mjs");
  let seenUrl;
  const bytes = await fetchRegistrySize("qwen2.5vl:3b", {
    fetchImpl: async (url) => {
      seenUrl = url;
      return new Response(
        JSON.stringify({ layers: [{ size: 3_200_614_720 }, { size: 487 }, { size: 13 }] }),
        { status: 200 },
      );
    },
  });
  assert.match(seenUrl, /\/v2\/library\/qwen2\.5vl\/manifests\/3b$/);
  assert.equal(bytes, 3_200_614_720 + 487 + 13);
  // A bare name resolves to the :latest manifest.
  await fetchRegistrySize("moondream", {
    fetchImpl: async (url) => {
      seenUrl = url;
      return new Response(JSON.stringify({ layers: [] }), { status: 200 });
    },
  });
  assert.match(seenUrl, /\/manifests\/latest$/);
});

test("an unreachable registry leaves the checked-in size in place", async () => {
  const { fetchRegistrySize } = await import("../src/vision-host.mjs");
  assert.equal(
    await fetchRegistrySize("x", { fetchImpl: async () => { throw new Error("offline"); } }),
    undefined,
  );
  assert.equal(
    await fetchRegistrySize("x", { fetchImpl: async () => new Response("", { status: 404 }) }),
    undefined,
  );
  // With no cached sizes the picker still renders from the catalog values.
  // (An empty map, not `undefined` — that would fall through to the real cache.)
  const models = annotateLocalModels({ installed: [], sizes: {} });
  assert.ok(models.every((m) => m.sizeGb > 0 && m.sizeSource === "catalog"));
});

test("a cached registry size overrides the catalog value, in decimal GB", () => {
  // 3,000,000,000 bytes is 3.0 GB the way Ollama reports it, not 2.8 GiB.
  const models = annotateLocalModels({
    installed: [],
    sizes: { "qwen2.5vl:3b": 3_000_000_000 },
  });
  const qwen = models.find((m) => m.tag === "qwen2.5vl:3b");
  assert.equal(qwen.sizeGb, 3);
  assert.equal(qwen.sizeSource, "registry");
});

test("a locally measured score overrides the shipped label", () => {
  // llava ships as captions-only; if it reads correctly on this machine, the
  // local measurement is what the picker must believe.
  const models = annotateLocalModels({
    installed: ["llava:latest"],
    sizes: {},
    benchmarks: { llava: { percent: 90, textPercent: 92, tier: "accurate", seconds: 12 } },
  });
  const llava = models.find((m) => m.tag === "llava");
  assert.equal(llava.accuracy, "accurate");
  assert.equal(llava.measuredLocally, true);
  assert.equal(llava.measured.textPercent, 92);
  // Re-ranked on the new tier: no longer buried below the caption-only models.
  // (It sits behind qwen2.5vl:3b, which shares the tier and is a smaller
  // download — size only breaks ties within a tier.)
  assert.ok(
    models.findIndex((m) => m.tag === "llava") <
      models.findIndex((m) => m.tag === "moondream"),
  );
  assert.equal(models[0].accuracy, "accurate");
});

test("an installed model outside the catalog appears once it is measured", () => {
  const models = annotateLocalModels({
    installed: ["minicpm-v:latest"],
    sizes: {},
    benchmarks: { "minicpm-v": { percent: 60, textPercent: 50, tier: "partial" } },
  });
  const custom = models.find((m) => m.tag === "minicpm-v");
  assert.ok(custom, "a measured, installed model must be listed");
  assert.equal(custom.custom, true);
  assert.equal(custom.accuracy, "partial");
  // A measured model that is not installed is not invented into the list.
  const absent = annotateLocalModels({
    installed: [],
    sizes: {},
    benchmarks: { "minicpm-v": { percent: 60, textPercent: 50, tier: "partial" } },
  });
  assert.equal(absent.find((m) => m.tag === "minicpm-v"), undefined);
});
