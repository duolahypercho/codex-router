import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "local-llm-test-"));
process.env.CODEX_ROUTER_STATE_DIR = stateDir;
process.env.MODEL_ROUTER_LOCAL_DOWNLOAD_STATE = path.join(stateDir, "download.json");
process.env.MODEL_ROUTER_LOCAL_BENCHMARKS = path.join(stateDir, "benchmarks.json");
process.env.MODEL_ROUTER_OLLAMA_RUNTIME_STATE = path.join(stateDir, "runtime.json");
process.env.MODEL_ROUTER_OLLAMA_LOG = path.join(stateDir, "ollama.log");

const {
  canonicalLocalModelTag,
  localModelDisplayName,
  normalizeLocalModelTag,
  splitLocalModelTag,
} = await import("../src/local-model-ref.mjs");
const {
  ensureOllamaHeadless,
  localOllamaRuntimeSnapshot,
  ollamaRuntimeStateOwnsProcess,
  ollamaHostForUrl,
  ollamaInstallPlan,
  ollamaUpdatePlan,
  parseOllamaVersion,
  probeOllama,
  stopManagedOllama,
} = await import("../src/ollama-runtime.mjs");
const { benchmarkLocalModel, readLocalBenchmarks } = await import("../src/local-benchmark.mjs");
const {
  claimLocalOperation,
  cancelLocalDownload,
  downloadLocalModel,
  readLocalDownload,
  reconcileLocalDownload,
  writeLocalDownload,
} = await import("../src/local-download.mjs");
const {
  readVisionBridgeSettings,
  setVisionBridgeEnabled,
  setVisionBridgeEngine,
} = await import("../src/vision-bridge-state.mjs");
const { localModelsSnapshot } = await import("../src/local-models.mjs");

test("Ollama model URLs normalize to explicit family and variant tags", () => {
  assert.equal(normalizeLocalModelTag("gemma4:12b"), "gemma4:12b");
  assert.equal(normalizeLocalModelTag("https://ollama.com/library/muse-glimmer"), "muse-glimmer:latest");
  assert.equal(
    normalizeLocalModelTag("https://ollama.com/frob/deepseek-v4-flash:284b-a13b-mxfp4"),
    "frob/deepseek-v4-flash:284b-a13b-mxfp4",
  );
  assert.deepEqual(splitLocalModelTag("hf.co/acme/model:Q4_K_M"), {
    tag: "hf.co/acme/model:Q4_K_M",
    name: "hf.co/acme/model",
    model: "model",
    namespace: "hf.co/acme",
    variant: "Q4_K_M",
    family: "hf.co/acme/model",
  });
  assert.equal(localModelDisplayName("gemma4:12b"), "Gemma4 · 12b");
  assert.throws(() => normalizeLocalModelTag("https://example.com/model"), /Ollama model-page/);
  // A family overview page carries no tag, so it must be rejected rather than
  // guessed at. The namespace form is the only two-segment shape that is one.
  assert.throws(
    () => normalizeLocalModelTag("https://ollama.com/library"),
    /does not contain an Ollama model tag/,
  );
  assert.throws(
    () => normalizeLocalModelTag("https://ollama.com/search/gemma"),
    /does not contain an Ollama model tag/,
  );
});

test("tag spellings canonicalize so one model is never two entries", () => {
  assert.equal(canonicalLocalModelTag("devstral"), "devstral:latest");
  assert.equal(canonicalLocalModelTag("devstral:latest"), "devstral:latest");
  assert.equal(canonicalLocalModelTag(" gemma4:12b "), "gemma4:12b");
  assert.equal(
    canonicalLocalModelTag("https://ollama.com/library/muse-glimmer"),
    "muse-glimmer:latest",
  );
  // Unparseable input is inert rather than fatal: this runs over stored state,
  // and one corrupt entry must not break reading the rest of the file.
  assert.equal(canonicalLocalModelTag("--force"), "--force");
  assert.equal(canonicalLocalModelTag(""), "");
  assert.equal(canonicalLocalModelTag(undefined), "");
});

test("runtime helpers keep Ollama headless and expose safe install plans", () => {
  assert.equal(parseOllamaVersion("ollama version is 0.32.6"), "0.32.6");
  assert.equal(ollamaHostForUrl("http://127.0.0.1:11434/v1"), "127.0.0.1:11434");
  assert.equal(ollamaHostForUrl("http://localhost/v1"), "localhost:11434");
  assert.equal(ollamaHostForUrl("https://example.com/v1"), undefined);

  const fakeSpawn = (command, args) => {
    if (command === "brew" && args[0] === "--version") return { status: 0 };
    if (command === "ollama" && args[0] === "--version") {
      return { status: 0, stdout: "ollama version is 0.32.6", stderr: "" };
    }
    return { status: 1 };
  };
  assert.deepEqual(ollamaInstallPlan({ platform: "darwin", spawn: fakeSpawn }).args, [
    "install",
    "ollama",
  ]);
  assert.equal(
    ollamaInstallPlan({ platform: "linux", spawn: fakeSpawn, interactive: true }).command,
    "sh",
  );
  assert.equal(
    ollamaInstallPlan({ platform: "linux", spawn: fakeSpawn, interactive: false }).command,
    undefined,
  );
  const policyKitSpawn = (command, args) => {
    if (command === "pkexec" && args[0] === "--version") return { status: 0 };
    return fakeSpawn(command, args);
  };
  assert.equal(
    ollamaInstallPlan({ platform: "linux", spawn: policyKitSpawn, interactive: false }).command,
    "pkexec",
  );
  const noPackageManager = () => ({ status: 1 });
  assert.equal(
    ollamaInstallPlan({ platform: "darwin", spawn: noPackageManager, interactive: false }).command,
    "/usr/bin/osascript",
  );
  // Every macOS path that runs the official installer must keep it headless.
  // Without OLLAMA_NO_START the installer launches the Ollama desktop app, and
  // the router would end up talking to a GUI process it does not own.
  for (const interactive of [true, false]) {
    const plan = ollamaInstallPlan({ platform: "darwin", spawn: noPackageManager, interactive });
    assert.ok(
      plan.args.some((argument) => argument.includes("OLLAMA_NO_START=1")),
      `darwin interactive=${interactive} must not start the Ollama app`,
    );
  }
  // Homebrew installs the headless CLI formula, never the desktop cask.
  assert.deepEqual(ollamaInstallPlan({ platform: "darwin", spawn: fakeSpawn }).args, [
    "install",
    "ollama",
  ]);
});

test("runtime updates use Homebrew only when it owns the Ollama formula", () => {
  const officialSpawn = (command, args) => {
    if (command === "ollama" && args[0] === "--version") return { status: 0 };
    if (command === "brew" && args[0] === "--version") return { status: 0 };
    if (command === "brew" && args[0] === "list") return { status: 1 };
    return { status: 1 };
  };
  assert.equal(
    ollamaUpdatePlan({
      platform: "darwin",
      spawn: officialSpawn,
      interactive: false,
      resolveCommand: () => "/Applications/Ollama.app/Contents/Resources/ollama",
    }).source,
    "official-app",
  );
  assert.equal(
    ollamaUpdatePlan({
      platform: "darwin",
      spawn: officialSpawn,
      interactive: false,
      resolveCommand: () => "/Applications/Ollama.app/Contents/Resources/ollama",
    }).command,
    "/usr/bin/osascript",
  );
  const homebrewSpawn = (command, args) => {
    if (command === "ollama" && args[0] === "--version") return { status: 0 };
    if (command === "brew" && args[0] === "--version") return { status: 0 };
    if (command === "brew" && args[0] === "list") return { status: 0 };
    return { status: 1 };
  };
  assert.equal(
    ollamaUpdatePlan({
      platform: "darwin",
      spawn: homebrewSpawn,
      resolveCommand: () => "/opt/homebrew/Cellar/ollama/0.32.6/bin/ollama",
    }).source,
    "homebrew",
  );
  const caskSpawn = (command, args) => {
    if (command === "ollama" && args[0] === "--version") return { status: 0 };
    if (command === "brew" && args[0] === "--version") return { status: 0 };
    if (
      command === "brew" &&
      args[0] === "list" &&
      args[1] === "--cask" &&
      args[2] === "ollama-app"
    ) {
      return { status: 0 };
    }
    return { status: 1 };
  };
  assert.deepEqual(
    ollamaUpdatePlan({
      platform: "darwin",
      spawn: caskSpawn,
      resolveCommand: () => "/Applications/Ollama.app/Contents/Resources/ollama",
    }),
    {
      command: "brew",
      args: ["upgrade", "--cask", "ollama-app"],
      source: "homebrew-cask",
    },
  );
});

test("noninteractive Linux updates require PolicyKit or an interactive terminal", () => {
  const withoutPolicyKit = (command, args) => {
    if (command === "ollama" && args[0] === "--version") return { status: 0 };
    return { status: 1 };
  };
  assert.throws(
    () => ollamaUpdatePlan({ platform: "linux", spawn: withoutPolicyKit, interactive: false }),
    /administrator permission/,
  );
  assert.equal(
    ollamaUpdatePlan({ platform: "linux", spawn: withoutPolicyKit, interactive: true }).command,
    "sh",
  );
});

test("runtime status verifies the daemon instead of trusting managed state", () => {
  const fakeSpawn = (command, args) => {
    assert.equal(command, "ollama");
    if (args[0] === "--version") {
      return { status: 0, stdout: "ollama version is 0.32.6", stderr: "" };
    }
    assert.deepEqual(args, ["list"]);
    return { status: 1, stdout: "", stderr: "connection refused" };
  };
  const snapshot = localOllamaRuntimeSnapshot({ spawn: fakeSpawn, platform: "linux" });
  assert.equal(snapshot.installed, true);
  assert.equal(snapshot.running, false);
  assert.equal(snapshot.managed, false);
});

test("stale or dead local download workers become retryable errors", () => {
  const alive = reconcileLocalDownload(
    {
      version: 1,
      tag: "gemma4:12b",
      status: "downloading",
      startedAt: 1_000,
      updatedAt: 1_900,
      workerPid: 42,
    },
    { now: 2_000, kill: () => {}, persist: false },
  );
  assert.equal(alive.status, "downloading");

  const dead = reconcileLocalDownload(
    {
      version: 1,
      tag: "gemma4:12b",
      status: "downloading",
      startedAt: 1_000,
      updatedAt: 1_900,
      workerPid: 42,
    },
    {
      now: 2_000,
      kill: () => {
        const error = new Error("missing");
        error.code = "ESRCH";
        throw error;
      },
      persist: false,
    },
  );
  assert.equal(dead.status, "error");
  assert.equal(dead.detail, "interrupted");
  assert.match(dead.error, /Retry the install/);

  const stale = reconcileLocalDownload(
    {
      version: 1,
      tag: "gemma4:12b",
      status: "downloading",
      startedAt: 1_000,
      updatedAt: 1_000,
      workerPid: 42,
    },
    { now: 1_000_000, kill: () => {}, timeoutMs: 10_000, persist: false },
  );
  assert.equal(stale.status, "error");

  const legacyStale = reconcileLocalDownload(
    {
      version: 1,
      tag: "gemma4:12b",
      status: "downloading",
      startedAt: 1_000,
      updatedAt: 1_000,
    },
    { now: 1_000_000, timeoutMs: 10_000, persist: false },
  );
  assert.equal(legacyStale.status, "error");
});

test("active local downloads and removals can be cancelled without a second worker", () => {
  const signals = [];
  writeLocalDownload({
    version: 1,
    kind: "download",
    tag: "gemma4:12b",
    status: "downloading",
    startedAt: 1_000,
    updatedAt: 2_000,
    workerPid: 42,
  });
  const cancelled = cancelLocalDownload("gemma4:12b", {
    now: () => 2_000,
    kill: (pid, signal) => {
      signals.push([pid, signal]);
    },
    platform: "linux",
  });
  assert.equal(cancelled.cancelled, true);
  assert.equal(readLocalDownload().status, "cancelled");
  assert.deepEqual(signals, [[42, 0], [42, "SIGTERM"]]);

  writeLocalDownload({
    version: 1,
    kind: "uninstall",
    tag: "gemma4:12b",
    status: "uninstalling",
    startedAt: 3_000,
    updatedAt: 4_000,
    workerPid: 43,
  });
  const removal = cancelLocalDownload("gemma4:12b", {
    now: () => 4_000,
    kill: () => {},
    spawn: (command, args) => {
      assert.equal(command, "taskkill");
      assert.deepEqual(args, ["/PID", "43", "/T", "/F"]);
      return { status: 0 };
    },
    platform: "win32",
  });
  assert.equal(removal.state.kind, "uninstall");
  assert.equal(readLocalDownload().status, "cancelled");
  writeLocalDownload({
    version: 1,
    kind: "download",
    tag: "gemma4:12b",
    status: "downloading",
    startedAt: 5_000,
    updatedAt: 6_000,
    workerPid: 44,
  });
  assert.throws(
    () => cancelLocalDownload("other:latest", { now: () => 6_000, kill: () => {} }),
    /active local model operation/,
  );
  writeLocalDownload({
    version: 1,
    kind: "download",
    tag: "gemma4:12b",
    status: "cancelled",
    detail: "Download cancelled",
    updatedAt: 6_000,
  });
});

test("a removed model with a failed catalog refresh stays a completed removal", () => {
  const catalogError = "The model was removed, but the Codex catalog could not be refreshed.";
  writeLocalDownload({
    version: 1,
    kind: "uninstall",
    tag: "gemma4:12b",
    status: "error",
    detail: "Removal failed",
    error: catalogError,
    updatedAt: 12_000,
  });
  const snapshot = localModelsSnapshot({
    inventory: [],
    running: [],
    selection: { enabled: [] },
    capabilities: {},
    agentChecks: {},
  });
  assert.equal(snapshot.installed, 0);
  assert.equal(snapshot.download.status, "done");
  assert.equal(snapshot.download.detail, "Model removed · catalog refresh needed");
  assert.equal(snapshot.download.catalogError, catalogError);
  assert.equal(snapshot.download.error, undefined);
});

test("local operation claims serialize concurrent controllers", () => {
  const claimPath = path.join(stateDir, "operation.claim");
  const first = claimLocalOperation("gemma4:12b", "download", {
    claimPath,
    now: () => 10_000,
    kill: () => {},
  });
  assert.equal(first.acquired, true);
  const second = claimLocalOperation("gemma4:12b", "download", {
    claimPath,
    now: () => 10_001,
    kill: () => {},
  });
  assert.equal(second.acquired, false);
  first.release();
  const third = claimLocalOperation("gemma4:12b", "uninstall", {
    claimPath,
    now: () => 10_002,
    kill: () => {},
  });
  assert.equal(third.acquired, true);
  third.release();
});

test("a cancelled worker cannot resurrect the download state", async () => {
  writeLocalDownload({
    version: 1,
    kind: "download",
    tag: "gemma4:12b",
    status: "cancelled",
    detail: "Download cancelled",
    updatedAt: 11_000,
  });
  let runtimeCalled = false;
  const result = await downloadLocalModel("gemma4:12b", {
    ensureRuntime: async () => {
      runtimeCalled = true;
    },
  });
  assert.deepEqual(result, { tag: "gemma4:12b", status: "cancelled", cancelled: true });
  assert.equal(runtimeCalled, false);
  assert.equal(readLocalDownload().status, "cancelled");
  writeLocalDownload({
    version: 1,
    kind: "download",
    tag: "gemma4:12b",
    status: "done",
    detail: "ready",
    percent: 100,
    updatedAt: 11_000,
  });
});

test("runtime probe and headless reuse never open the Ollama GUI", async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    return new Response(JSON.stringify({ models: [{ name: "gemma4:12b" }] }), { status: 200 });
  };
  const spawnSync = (command, args) => {
    assert.equal(command, "ollama");
    assert.deepEqual(args, ["--version"]);
    return { status: 0, stdout: "ollama version is 0.32.6", stderr: "" };
  };
  assert.deepEqual(await probeOllama({ fetchImpl }), {
    reachable: true,
    models: ["gemma4:12b"],
  });
  const result = await ensureOllamaHeadless({ fetchImpl, spawnSyncImpl: spawnSync });
  assert.equal(result.running, true);
  assert.equal(result.managed, false);
  assert.equal(result.version, "0.32.6");
  assert.deepEqual(requests, ["http://127.0.0.1:11434/api/tags", "http://127.0.0.1:11434/api/tags"]);
});

test("a router-started Ollama daemon is detached, headless, and identity-owned", async () => {
  const runtimePath = process.env.MODEL_ROUTER_OLLAMA_RUNTIME_STATE;
  const calls = [];
  let probe = 0;
  const result = await ensureOllamaHeadless({
    fetchImpl: async () => {
      probe += 1;
      if (probe === 1) throw new Error("connection refused");
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    },
    spawnSyncImpl: (command, args) => {
      assert.equal(command, "ollama");
      assert.deepEqual(args, ["--version"]);
      return { status: 0, stdout: "ollama version is 0.32.6", stderr: "" };
    },
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return { pid: 84, unref() {}, kill() {} };
    },
    processIdentity: (pid) => {
      assert.equal(pid, 84);
      return "verified-process-start|ollama";
    },
    timeoutMs: 100,
  });
  assert.equal(result.managed, true);
  assert.equal(result.pid, 84);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "ollama");
  assert.deepEqual(calls[0].args, ["serve"]);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio[0], "ignore");
  assert.equal(calls[0].options.env.OLLAMA_HOST, "127.0.0.1:11434");
  const state = JSON.parse(readFileSync(runtimePath, "utf8"));
  assert.equal(state.managed, true);
  assert.equal(state.pid, 84);
  assert.equal(state.processIdentity, "verified-process-start|ollama");
});

test("a reachable external Ollama server is never adopted from stale managed state", async () => {
  writeFileSync(
    process.env.MODEL_ROUTER_OLLAMA_RUNTIME_STATE,
    `${JSON.stringify({
      version: 1,
      managed: true,
      pid: 42,
      processIdentity: "router-owned-process",
    })}\n`,
    { mode: 0o600 },
  );
  const result = await ensureOllamaHeadless({
    fetchImpl: async () => new Response(JSON.stringify({ models: [] }), { status: 200 }),
    spawnSyncImpl: (command, args) => {
      assert.equal(command, "ollama");
      assert.deepEqual(args, ["--version"]);
      return { status: 0, stdout: "ollama version is 0.32.6", stderr: "" };
    },
    processIdentity: () => "different-process",
  });
  assert.equal(result.running, true);
  assert.equal(result.managed, false);
  assert.equal(existsSync(process.env.MODEL_ROUTER_OLLAMA_RUNTIME_STATE), false);
});

test("managed Ollama ownership requires both the recorded PID and process identity", () => {
  const state = {
    version: 1,
    managed: true,
    pid: 42,
    processIdentity: "same-process",
  };
  assert.equal(
    ollamaRuntimeStateOwnsProcess(state, { identity: () => "same-process" }),
    true,
  );
  assert.equal(
    ollamaRuntimeStateOwnsProcess(state, { identity: () => "replacement-process" }),
    false,
  );
  assert.equal(
    ollamaRuntimeStateOwnsProcess({ ...state, processIdentity: undefined }, {
      identity: () => "same-process",
    }),
    false,
  );
});

test("router shutdown stops only its verified headless Ollama process", async () => {
  const runtimePath = process.env.MODEL_ROUTER_OLLAMA_RUNTIME_STATE;
  const state = {
    version: 1,
    managed: true,
    pid: 42,
    processIdentity: "same-process",
  };
  writeFileSync(runtimePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  const signals = [];
  let alive = true;
  const result = await stopManagedOllama({
    identity: () => (alive ? "same-process" : undefined),
    kill: (pid, signal) => {
      signals.push([pid, signal]);
      alive = false;
    },
    timeoutMs: 100,
    intervalMs: 1,
  });
  assert.deepEqual(result, { stopped: true, pid: 42 });
  assert.deepEqual(signals, [[42, "SIGTERM"]]);
  assert.equal(existsSync(runtimePath), false);

  writeFileSync(runtimePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  const externalSignals = [];
  const external = await stopManagedOllama({
    identity: () => "replacement-process",
    kill: (...args) => externalSignals.push(args),
  });
  assert.deepEqual(external, { stopped: false, reason: "ownership-lost" });
  assert.deepEqual(externalSignals, []);
  assert.equal(existsSync(runtimePath), false);
});

test("local speed benchmark records Ollama eval tokens per second", async () => {
  const result = await benchmarkLocalModel("gemma4:12b", {
    fetchImpl: async (url, init) => {
      assert.equal(url, "http://127.0.0.1:11434/api/chat");
      const body = JSON.parse(init.body);
      assert.equal(body.model, "gemma4:12b");
      assert.equal(body.stream, false);
      return new Response(
        JSON.stringify({
          total_duration: 3_000_000_000,
          load_duration: 1_000_000_000,
          prompt_eval_count: 20,
          prompt_eval_duration: 500_000_000,
          eval_count: 64,
          eval_duration: 2_000_000_000,
        }),
        { status: 200 },
      );
    },
  });
  assert.equal(result.tokensPerSecond, 32);
  assert.equal(result.promptTokensPerSecond, 40);
  assert.equal(readLocalBenchmarks()["gemma4:12b"].speedStatus, "measured");
});

test("a completed local pull checks tool-capable models on automatically", async () => {
  const enabled = [];
  const restarts = [];
  const result = await downloadLocalModel("https://ollama.com/library/gemma4:12b", {
    ensureRuntime: async () => ({ running: true, managed: true }),
    pull: async (tag, { onProgress }) => {
      assert.equal(tag, "gemma4:12b");
      onProgress({ detail: "success", percent: 100 });
    },
    capabilitiesFor: () => ["completion", "tools"],
    enable: async (tag) => enabled.push(tag),
    restartService: async () => {
      restarts.push("restart");
      return true;
    },
    refreshCatalog: false,
  });
  assert.equal(result.status, "done");
  assert.deepEqual(enabled, ["gemma4:12b"]);
  // The running router only loads user models at startup, so a newly checked
  // local model must also restart the router or its first request falls
  // through to the native backend.
  assert.deepEqual(restarts, ["restart"]);
  assert.equal(readLocalDownload().detail, "ready");
});

test("control persists a visible terminal error when install preflight fails", () => {
  const childState = mkdtempSync(path.join(os.tmpdir(), "local-llm-control-"));
  const result = spawnSync(
    process.execPath,
    [path.resolve("src/control.mjs"), "local-models", "install", "status-probe:latest", "--yes"],
    {
      cwd: path.resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_ROUTER_STATE_DIR: childState,
        MODEL_ROUTER_LOCAL_DOWNLOAD_STATE: path.join(childState, "download.json"),
        MODEL_ROUTER_OLLAMA_RUNTIME_STATE: path.join(childState, "runtime.json"),
        MODEL_ROUTER_OLLAMA_LOG: path.join(childState, "ollama.log"),
        MODEL_ROUTER_LOCAL_BASE_URL: "https://example.com",
        MODEL_ROUTER_OLLAMA_REGISTRY: "http://127.0.0.1:9",
      },
    },
  );
  assert.notEqual(result.status, 0);
  const state = JSON.parse(readFileSync(path.join(childState, "download.json"), "utf8"));
  assert.equal(state.status, "error");
  assert.equal(state.detail, "failed");
  assert.match(state.error, /not loopback/);
});

// Runs `control local-models ...` against a throwaway state directory whose
// local endpoint is deliberately not loopback, so the command fails at a known
// point after argument parsing.
function runLocalModels(...args) {
  const childState = mkdtempSync(path.join(os.tmpdir(), "local-llm-args-"));
  const result = spawnSync(process.execPath, [path.resolve("src/control.mjs"), "local-models", ...args], {
    cwd: path.resolve("."),
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_ROUTER_STATE_DIR: childState,
      MODEL_ROUTER_LOCAL_DOWNLOAD_STATE: path.join(childState, "download.json"),
      MODEL_ROUTER_OLLAMA_RUNTIME_STATE: path.join(childState, "runtime.json"),
      MODEL_ROUTER_OLLAMA_LOG: path.join(childState, "ollama.log"),
      MODEL_ROUTER_LOCAL_BASE_URL: "https://example.com",
      MODEL_ROUTER_OLLAMA_REGISTRY: "http://127.0.0.1:9",
    },
  });
  return { ...result, childState, output: `${result.stdout || ""}${result.stderr || ""}` };
}

test("install accepts --yes and --force together, in either order", () => {
  // A single flag slot made these mutually exclusive, yet they answer different
  // questions: --yes consents to installing Ollama itself, --force to a model
  // this machine is rated too small for. Installing an oversized model on a
  // machine without Ollama needs both at once.
  for (const flags of [["--yes", "--force"], ["--force", "--yes"]]) {
    const result = runLocalModels("install", "flag-probe:latest", ...flags);
    assert.notEqual(result.status, 0);
    const state = JSON.parse(readFileSync(path.join(result.childState, "download.json"), "utf8"));
    // Reaching the loopback check proves both were read as flags rather than
    // mistaken for the tag, and that --yes was still honored beside --force.
    assert.match(state.error, /not loopback/, flags.join(" "));
  }
});

test("a missing Ollama is named as installable rather than reported as absent", () => {
  // Without --yes the command must say what to do next, not just that Ollama is
  // missing: one flag installs the runtime headlessly and then the model.
  const result = runLocalModels("install", "flag-probe:latest");
  assert.notEqual(result.status, 0);
  // On a machine that already has Ollama this reaches the loopback guard
  // instead; either way it must never claim the model started downloading.
  assert.match(result.output, /Re-run with --yes|not loopback/);
});

test("the usage text names both consent flags", () => {
  const result = runLocalModels("no-such-action");
  assert.notEqual(result.status, 0);
  assert.match(result.output, /--force/);
  assert.match(result.output, /--yes/);
  assert.match(result.output, /install <tag-or-url>/);
});

test("a configured-off vision bridge is never re-enabled by a local pull", async () => {
  setVisionBridgeEnabled(false);
  const result = await downloadLocalModel("qwen2.5vl:3b", {
    ensureRuntime: async () => ({ running: true, managed: true }),
    pull: async () => {},
    capabilitiesFor: () => ["completion", "vision"],
    refreshCatalog: false,
  });
  assert.equal(result.adoptedVision, false);
  assert.equal(readVisionBridgeSettings().enabled, false);
});

test("a vision-only local pull is adopted as the first image reader, not a Codex chat route", async () => {
  setVisionBridgeEnabled(true);
  setVisionBridgeEngine(null);
  const result = await downloadLocalModel("qwen2.5vl:3b", {
    ensureRuntime: async () => ({ running: true, managed: true }),
    pull: async () => {},
    capabilitiesFor: () => ["completion", "vision"],
    enable: async () => assert.fail("vision-only model must not be published as chat"),
    refreshCatalog: false,
  });
  assert.equal(result.canChat, false);
  assert.equal(result.adoptedVision, true);
  assert.equal(readLocalDownload().detail, "ready for images");
});
