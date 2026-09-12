import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// `paths.mjs` resolves every document location once, at import time, so the
// redirection has to be in place before the first import of anything that
// reaches it. Nothing in this file may touch a real client's home.
const root = mkdtempSync(path.join(os.tmpdir(), "routed-harness-test-"));
const stateDir = path.join(root, "state");
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const SECRET = "c".repeat(48);
writeFileSync(path.join(stateDir, "caller-secret"), `${SECRET}\n`, { mode: 0o600 });

const DOCUMENTS = Object.freeze({
  opencode: path.join(root, "opencode", "opencode.json"),
  pi: path.join(root, "pi", "models.json"),
  omp: path.join(root, "omp", "models.yml"),
  commandcode: path.join(root, "commandcode", "providers.json"),
  hermes: path.join(root, "hermes", "config.yaml"),
});

process.env.MODEL_ROUTER_STATE_DIR = stateDir;
process.env.MODEL_ROUTER_OPENCODE_CONFIG = DOCUMENTS.opencode;
process.env.MODEL_ROUTER_PI_MODELS = DOCUMENTS.pi;
process.env.MODEL_ROUTER_OMP_MODELS = DOCUMENTS.omp;
process.env.MODEL_ROUTER_COMMANDCODE_PROVIDERS = DOCUMENTS.commandcode;
process.env.MODEL_ROUTER_HERMES_CONFIG = DOCUMENTS.hermes;

const { ROUTED_HARNESS_IDS, routedHarness, routedHarnesses } = await import(
  "../src/routed-harness-catalog.mjs"
);
const { createRoutedHarnessManager } = await import("../src/routed-harness-manager.mjs");
const {
  installRoutedHarness,
  routedHarnessInstallable,
  routedHarnessOutdated,
  routedHarnessUpdatable,
  updateRoutedHarness,
} = await import("../src/routed-harness-install.mjs");
const { applyYamlValue, removeYamlValue, yamlLeafScalar } = await import(
  "../src/routed-harness-document.mjs"
);
const { ROUTED_HARNESS_CATALOG_PATHS } = await import("../src/paths.mjs");

const MODELS = [
  {
    slug: "moonshot/kimi-k3",
    displayName: "Kimi K3",
    contextWindow: 262_144,
    autoCompact: 222_822,
    inputModalities: ["text"],
    reasoningLevels: [{ effort: "low" }, { effort: "high" }],
    priority: 10,
  },
  {
    slug: "x-ai/grok-4.6",
    displayName: "Grok 4.6",
    contextWindow: 2_000_000,
    inputModalities: ["text", "image"],
    reasoningLevels: [],
    priority: 5,
  },
];

function manager(id, overrides = {}) {
  return createRoutedHarnessManager(id, {
    modelSource: () => ({ models: MODELS, engine: null }),
    // Detection is not what these tests are about, and a machine that happens
    // to have one of these CLIs installed must not change the result.
    findCli: () => "/nonexistent/bin/harness",
    ...overrides,
  });
}

function reset() {
  for (const target of Object.values(DOCUMENTS)) rmSync(path.dirname(target), { recursive: true, force: true });
  for (const id of ROUTED_HARNESS_IDS) rmSync(path.join(stateDir, `${id}-models.json`), { force: true });
}

test("every routed harness publishes the whole routed catalog and takes it back out", () => {
  for (const harness of routedHarnesses()) {
    reset();
    const client = manager(harness.id);
    const result = client.install();
    assert.equal(result.harness, harness.id);
    assert.equal(result.models, MODELS.length);

    const published = readFileSync(DOCUMENTS[harness.id], "utf8");
    // Every model reaches every client. The id differs by wire -- the
    // Anthropic surface takes prefixed ids -- but the *set* never does.
    for (const model of MODELS) assert.match(published, new RegExp(model.slug.replaceAll(".", "\\.")));

    const status = client.status();
    assert.equal(status.installed, true);
    assert.equal(status.providerInstalled, true);
    assert.equal(status.baseUrlManaged, true);
    assert.equal(status.configValid, true, `${harness.id}: ${status.configError || ""}`);
    assert.equal(status.catalogFresh, true);
    assert.equal(status.publishedModels, MODELS.length);
    // The caller secret is a path segment of the base URL, so status output --
    // which reaches doctor and support bundles -- must never carry it.
    assert.doesNotMatch(JSON.stringify(status), new RegExp(SECRET));

    const removed = client.uninstall();
    assert.equal(removed.removed, true);
    assert.doesNotMatch(readFileSync(DOCUMENTS[harness.id], "utf8"), /codex-router/);
    assert.equal(existsSync(path.join(stateDir, `${harness.id}-models.json`)), false);
  }
});

test("each harness is pointed at a wire the router actually serves", () => {
  reset();
  for (const harness of routedHarnesses()) {
    manager(harness.id).install();
    const published = readFileSync(DOCUMENTS[harness.id], "utf8");
    if (harness.wire === "anthropic") {
      // The Anthropic surface is reached at the `/anthropic` leaf with
      // `claude-model-id.mjs` ids; a bare slug there would 404 on a model the
      // surface never published.
      assert.match(published, /_codex-router\/[^"\s]+\/anthropic/);
      assert.match(published, /codex_router\/anthropic\/moonshot\/kimi-k3/);
    } else {
      assert.match(published, /_codex-router\/[^"\s]+\/v1/);
      assert.match(published, /openai-responses|@ai-sdk\/openai/);
    }
    // Chat Completions is the one OpenAI-compatible wire the caller endpoint
    // does not answer, so no adapter may ever declare it.
    assert.doesNotMatch(published, /openai-completions|openai-compatible/);
  }
});

test("a published document is private, because its base URL is the capability", () => {
  reset();
  for (const harness of routedHarnesses()) {
    manager(harness.id).install();
    // Windows carries this as an ACL, not a POSIX mode: Node reports 0o666
    // there whatever `protectPrivateFile` did. `privateFileIsProtected` is the
    // check that is meaningful on both, and doctor already runs it.
    if (process.platform !== "win32") {
      const mode = statSync(DOCUMENTS[harness.id]).mode & 0o777;
      assert.equal(mode & 0o077, 0, `${harness.id} document is group/other readable`);
    }
  }
});

test("publishing preserves comments, sibling providers, and unrelated settings", () => {
  reset();
  mkdirSync(path.dirname(DOCUMENTS.hermes), { recursive: true });
  writeFileSync(DOCUMENTS.hermes, [
    "# my hermes config",
    "model:",
    '  provider: "openrouter"',
    '  default: "anthropic/claude-opus-4.8"',
    "providers:",
    "  # a local server I run",
    "  local:",
    "    api: http://localhost:8080/v1",
    "    transport: chat_completions",
    "terminal:",
    "  backend: docker",
    "",
  ].join("\n"));

  const client = manager("hermes");
  client.install();
  const published = readFileSync(DOCUMENTS.hermes, "utf8");
  assert.match(published, /# my hermes config/);
  assert.match(published, /# a local server I run/);
  assert.match(published, /backend: docker/);
  assert.match(published, /codex-router:/);

  client.uninstall();
  const restored = readFileSync(DOCUMENTS.hermes, "utf8");
  assert.doesNotMatch(restored, /codex-router/);
  assert.match(restored, /# a local server I run/);
  assert.match(restored, /transport: chat_completions/);
  assert.match(restored, /backend: docker/);
});

test("a JSON client keeps every provider it already had", () => {
  reset();
  mkdirSync(path.dirname(DOCUMENTS.opencode), { recursive: true });
  writeFileSync(DOCUMENTS.opencode, `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    autoupdate: true,
    provider: { mine: { npm: "@ai-sdk/openai-compatible" } },
  }, null, 2)}\n`);

  const client = manager("opencode");
  client.install();
  const published = JSON.parse(readFileSync(DOCUMENTS.opencode, "utf8"));
  assert.equal(published.autoupdate, true);
  assert.deepEqual(published.provider.mine, { npm: "@ai-sdk/openai-compatible" });
  // No default was set, so the router claims it.
  assert.equal(published.model, "codex-router/moonshot/kimi-k3");

  client.uninstall();
  const restored = JSON.parse(readFileSync(DOCUMENTS.opencode, "utf8"));
  assert.deepEqual(restored.provider, { mine: { npm: "@ai-sdk/openai-compatible" } });
  assert.equal(restored.model, undefined);
});

test("a default model the user chose is neither taken over nor removed", () => {
  reset();
  mkdirSync(path.dirname(DOCUMENTS.opencode), { recursive: true });
  writeFileSync(DOCUMENTS.opencode, `${JSON.stringify({ model: "anthropic/claude-sonnet-5" }, null, 2)}\n`);

  const client = manager("opencode");
  const result = client.install();
  assert.equal(result.defaultOwned, false);
  assert.equal(JSON.parse(readFileSync(DOCUMENTS.opencode, "utf8")).model, "anthropic/claude-sonnet-5");

  client.uninstall();
  assert.equal(JSON.parse(readFileSync(DOCUMENTS.opencode, "utf8")).model, "anthropic/claude-sonnet-5");
});

test("a default this router owned, then the user changed, stays the user's", () => {
  reset();
  const client = manager("opencode");
  assert.equal(client.install().defaultOwned, true);

  const document = JSON.parse(readFileSync(DOCUMENTS.opencode, "utf8"));
  document.model = "anthropic/claude-opus-4.8";
  writeFileSync(DOCUMENTS.opencode, `${JSON.stringify(document, null, 2)}\n`);

  assert.equal(client.install().defaultOwned, false);
  assert.equal(JSON.parse(readFileSync(DOCUMENTS.opencode, "utf8")).model, "anthropic/claude-opus-4.8");
  client.uninstall();
  assert.equal(JSON.parse(readFileSync(DOCUMENTS.opencode, "utf8")).model, "anthropic/claude-opus-4.8");
});

test("a codex-router provider this router did not write is never replaced or removed", () => {
  reset();
  mkdirSync(path.dirname(DOCUMENTS.omp), { recursive: true });
  const foreign = [
    "providers:",
    "  codex-router:",
    "    baseUrl: https://someone-elses-proxy.example.com/v1",
    "    api: openai-completions",
    "",
  ].join("\n");
  writeFileSync(DOCUMENTS.omp, foreign);

  const client = manager("omp");
  assert.throws(() => client.install(), /unmanaged codex-router provider/);
  assert.equal(readFileSync(DOCUMENTS.omp, "utf8"), foreign);
  assert.throws(() => client.uninstall(), /Refusing to remove an unmanaged/);
  assert.equal(readFileSync(DOCUMENTS.omp, "utf8"), foreign);
});

test("a JSON document with comments is refused rather than reformatted", () => {
  reset();
  mkdirSync(path.dirname(DOCUMENTS.commandcode), { recursive: true });
  const commented = '// my providers\n{\n  "provider": {}\n}\n';
  writeFileSync(DOCUMENTS.commandcode, commented);
  assert.throws(() => manager("commandcode").install(), /not plain JSON/);
  assert.equal(readFileSync(DOCUMENTS.commandcode, "utf8"), commented);
});

test("opencode refuses to publish while a JSONC sibling it also reads exists", () => {
  reset();
  mkdirSync(path.dirname(DOCUMENTS.opencode), { recursive: true });
  writeFileSync(path.join(path.dirname(DOCUMENTS.opencode), "opencode.jsonc"), "// hi\n{}\n");
  assert.throws(() => manager("opencode").install(), /opencode\.jsonc/);
  assert.equal(existsSync(DOCUMENTS.opencode), false);
});

test("a failed marker write puts the client's document back", () => {
  reset();
  mkdirSync(path.dirname(DOCUMENTS.pi), { recursive: true });
  writeFileSync(DOCUMENTS.pi, `${JSON.stringify({ providers: { ollama: { baseUrl: "http://localhost:11434/v1" } } }, null, 2)}\n`);
  const before = readFileSync(DOCUMENTS.pi, "utf8");

  const client = manager("pi", {
    writeMarker: () => {
      throw new Error("marker write failed");
    },
  });
  assert.throws(() => client.install(), /marker write failed/);
  assert.equal(readFileSync(DOCUMENTS.pi, "utf8"), before);
});

test("a failed first publication leaves no document behind, not an empty one", () => {
  // Rolling a never-published client "back" to an empty string leaves a
  // zero-byte opencode.json or models.json, which is not valid JSON and is
  // worse for the client than the absence this path exists to restore.
  for (const harness of routedHarnesses()) {
    reset();
    assert.equal(existsSync(DOCUMENTS[harness.id]), false);
    const client = manager(harness.id, {
      writeMarker: () => {
        throw new Error("marker write failed");
      },
    });
    assert.throws(() => client.install(), /marker write failed/);
    assert.equal(existsSync(DOCUMENTS[harness.id]), false, `${harness.id} left a document behind`);
  }
});

test("a malformed publication marker refuses to change client state", () => {
  reset();
  manager("pi").install();
  writeFileSync(path.join(stateDir, "pi-models.json"), '{"version":2}\n', { mode: 0o600 });
  assert.throws(() => manager("pi").install(), /malformed shape/);
  assert.throws(() => manager("pi").uninstall(), /malformed shape/);
  assert.equal(manager("pi").status().stateValid, false);
});

test("publishing with no routable models is refused before anything is written", () => {
  reset();
  const client = manager("hermes", { modelSource: () => ({ models: [], engine: null }) });
  assert.throws(() => client.install(), /No routed models are selected/);
  assert.equal(existsSync(DOCUMENTS.hermes), false);
});

test("the catalog names one wire, one document, and one provider key per client", () => {
  assert.deepEqual(ROUTED_HARNESS_IDS, ["opencode", "pi", "omp", "commandcode", "hermes"]);
  const documents = new Set();
  for (const harness of routedHarnesses()) {
    assert.ok(["json", "yaml"].includes(harness.format));
    assert.ok(["responses", "anthropic"].includes(harness.wire));
    assert.equal(harness.providerPath.at(-1), "codex-router");
    assert.ok(harness.baseUrlPath.length >= 1);
    assert.equal(documents.has(harness.documentKey), false, "two clients must not share one document");
    documents.add(harness.documentKey);
  }
  // Hermes ships no package-registry install, so this router never offers to
  // install it; the others are installable where their package has a build.
  assert.equal(routedHarness("hermes").npmPackage, undefined);
  assert.equal(routedHarnessInstallable("hermes"), false);
  // omp's npm package runs on Bun, so an npm install without Bun would leave an
  // `omp` that cannot start. It is installed from its own instructions.
  assert.equal(routedHarnessInstallable("omp"), false);
  assert.deepEqual(routedHarness("omp").executables, ["omp"]);
  assert.equal(routedHarnessInstallable("opencode"), true);
});

test("opencode gets a limit its schema accepts, compacting where Codex does", () => {
  reset();
  manager("opencode").install();
  const { models } = JSON.parse(readFileSync(DOCUMENTS.opencode, "utf8")).provider["codex-router"];
  // opencode rejects the whole document when `limit` lacks `output`.
  assert.deepEqual(models["moonshot/kimi-k3"].limit, { context: 262_144, input: 222_822, output: 39_322 });
  // No compaction threshold, no limit: unknown rather than a guess.
  assert.equal(models["x-ai/grok-4.6"].limit, undefined);
});

test("Command Code models carry only the fields its loader reads", () => {
  reset();
  manager("commandcode").install();
  const { models } = JSON.parse(readFileSync(DOCUMENTS.commandcode, "utf8")).provider["codex-router"];
  assert.deepEqual(models["codex_router/anthropic/moonshot/kimi-k3"], {
    name: "Kimi K3",
    contextWindow: 262_144,
    reasoningEfforts: ["low", "high"],
  });
  assert.deepEqual(models["codex_router/anthropic/x-ai/grok-4.6"], { name: "Grok 4.6", contextWindow: 2_000_000 });
});

test("a Command Code too old to read providers.json is updated, not published past", () => {
  const installs = [];
  const upgraded = installRoutedHarness("commandcode", {
    find: () => "/usr/local/bin/command-code",
    version: () => (installs.length ? "1.53.0" : "1.26.0"),
    install: (spec) => installs.push(spec),
  });
  assert.deepEqual(installs, ["command-code@latest"]);
  assert.equal(upgraded.upgraded, true);

  const current = installRoutedHarness("commandcode", {
    find: () => "/usr/local/bin/command-code",
    version: () => "1.30.0",
    install: () => assert.fail("a current CLI must not be reinstalled"),
  });
  assert.equal(current.changed, false);

  // npm updated its copy but an older install still wins on PATH.
  assert.throws(
    () => installRoutedHarness("commandcode", { find: () => "/opt/cc", version: () => "1.26.0", install: () => {} }),
    /still older than 1\.30\.0/,
  );
  assert.throws(
    () => installRoutedHarness("omp", { find: () => undefined, install: () => assert.fail("omp is never npm-installed") }),
    /omp\.sh/,
  );

  assert.equal(routedHarnessOutdated("commandcode", "1.29.9"), true);
  assert.equal(routedHarnessOutdated("commandcode", "command-code 1.30.0"), false);
  assert.equal(routedHarnessOutdated("commandcode", undefined), false);
  assert.equal(routedHarnessOutdated("opencode", "0.0.1"), false);

  const status = manager("commandcode", { cliVersion: () => "1.26.0" }).status();
  assert.equal(status.cliOutdated, true);
  assert.equal(status.cliVersion, "1.26.0");
  assert.equal(status.cliMinimumVersion, "1.30.0");
});

test("an injected marker file is the one read back, not the state directory's", () => {
  reset();
  const markerFile = path.join(root, "elsewhere", "pi-marker.json");
  const client = manager("pi", { markerFile });
  client.install();
  assert.equal(existsSync(markerFile), true);
  assert.equal(existsSync(path.join(stateDir, "pi-models.json")), false);
  const status = client.status();
  assert.equal(status.installed, true);
  assert.equal(status.catalogFresh, true);
  assert.equal(client.uninstall().removed, true);
  assert.equal(existsSync(markerFile), false);
  rmSync(path.dirname(markerFile), { recursive: true, force: true });
});

test("pi, omp, and Command Code documents resolve the way those clients resolve them", async () => {
  const { execFileSync } = await import("node:child_process");
  const home = path.join(root, "home");
  const agentDir = path.join(root, "agent-override");
  const resolve = (extra) => {
    const env = { ...process.env, HOME: home, USERPROFILE: home, ...extra };
    for (const key of ["MODEL_ROUTER_PI_MODELS", "MODEL_ROUTER_OMP_MODELS", "MODEL_ROUTER_COMMANDCODE_PROVIDERS"]) {
      delete env[key];
    }
    if (!extra.PI_CODING_AGENT_DIR) delete env.PI_CODING_AGENT_DIR;
    const script =
      "const p = await import(process.argv[1]);" +
      "console.log(JSON.stringify({ pi: p.PI_MODELS_PATH, omp: p.OMP_MODELS_PATH, commandcode: p.COMMANDCODE_PROVIDERS_PATH }));";
    return JSON.parse(execFileSync(
      process.execPath,
      ["--input-type=module", "-e", script, new URL("../src/paths.mjs", import.meta.url).href],
      { env, encoding: "utf8" },
    ));
  };

  const defaults = resolve({});
  assert.equal(defaults.pi, path.join(home, ".pi", "agent", "models.json"));
  // `~/.omp`, the upstream's home -- not the `~/.oh-omp` a fork reads.
  assert.equal(defaults.omp, path.join(home, ".omp", "agent", "models.yml"));
  assert.equal(defaults.commandcode, path.join(home, ".commandcode", "providers.json"));

  const overridden = resolve({ PI_CODING_AGENT_DIR: agentDir });
  assert.equal(overridden.pi, path.join(agentDir, "models.json"));
  assert.equal(overridden.omp, path.join(agentDir, "models.yml"));

  // omp reads `models.yaml` when there is no `models.yml`; creating one would
  // shadow the user's file.
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(path.join(agentDir, "models.yaml"), "providers: {}\n");
  assert.equal(resolve({ PI_CODING_AGENT_DIR: agentDir }).omp, path.join(agentDir, "models.yaml"));
});

test("the YAML helpers only ever touch the key they are given", () => {
  const document = [
    "root:",
    "  keep: 1",
    "  providers:",
    "    other:",
    "      api: https://example.com",
    "",
  ].join("\n");
  const written = applyYamlValue(document, ["root", "providers", "codex-router"], {
    api: "http://127.0.0.1:4202/x",
    models: { "a/b:c": {} },
  });
  assert.match(written, /keep: 1/);
  assert.match(written, /other:/);
  // A model id carrying `/` and `:` has to be quoted, or the mapping key
  // silently becomes something else.
  assert.match(written, /"a\/b:c": \{\}/);
  assert.equal(
    yamlLeafScalar(written, ["root", "providers", "codex-router", "api"]),
    "http://127.0.0.1:4202/x",
  );
  const cleared = removeYamlValue(written, ["root", "providers", "codex-router"]);
  assert.doesNotMatch(cleared, /codex-router/);
  assert.match(cleared, /other:/);
  assert.match(cleared, /keep: 1/);
});

test("updating a client runs that client's own updater, not npm", () => {
  // A CLI installed by Homebrew or a `curl | sh` script is not an npm package.
  // Reinstalling it as one leaves two copies and lets PATH order decide which
  // runs — the failure where the row reports the new version and the shell
  // keeps running the old one. Every client that ships an updater gets it.
  for (const [id, expected] of [
    ["opencode", ["upgrade"]],
    ["pi", ["update", "--self"]],
    ["commandcode", ["update"]],
    ["hermes", ["update", "--yes"]],
  ]) {
    const ran = [];
    const result = updateRoutedHarness(id, {
      find: () => `/usr/local/bin/${id}`,
      version: () => (ran.length ? "9.9.9" : "1.0.0"),
      install: () => assert.fail(`${id} must update through its own CLI, not npm`),
      run: (command, args) => ran.push([command, args]),
    });
    assert.deepEqual(ran.at(-1)[1].slice(-expected.length), expected);
    assert.deepEqual(
      { from: result.from, to: result.to, changed: result.changed },
      { from: "1.0.0", to: "9.9.9", changed: true },
    );
  }
});

test("a client with no updater of its own is reinstalled at latest, or explained", () => {
  // pi moved publishers; installing the abandoned name pins a stale agent that
  // still answers `pi --version`, so nothing downstream would call it wrong.
  assert.equal(routedHarness("pi").npmPackage, "@earendil-works/pi-coding-agent@latest");

  // omp has neither a package this router installs nor a self-update
  // subcommand, so the only honest answer is the project's own instructions.
  assert.equal(routedHarnessUpdatable("omp"), false);
  assert.throws(
    () => updateRoutedHarness("omp", {
      find: () => "/usr/local/bin/omp",
      version: () => "1.0.0",
      install: () => assert.fail("omp is never npm-installed"),
      run: () => assert.fail("omp has no updater to run"),
    }),
    /omp\.sh|brew install/,
  );

  // Hermes has no package but does maintain its own checkout.
  assert.equal(routedHarnessInstallable("hermes"), false);
  assert.equal(routedHarnessUpdatable("hermes"), true);

  // A client that reports no version cannot be claimed to have changed.
  const silent = updateRoutedHarness("opencode", {
    find: () => "/usr/local/bin/opencode",
    version: () => undefined,
    install: () => {},
    run: () => {},
  });
  assert.deepEqual(
    { changed: silent.changed, versionReported: silent.versionReported },
    { changed: false, versionReported: false },
  );
});

test("a failing updater reports the command that failed", () => {
  assert.throws(
    () => updateRoutedHarness("opencode", {
      find: () => "/usr/local/bin/opencode",
      version: () => "1.0.0",
      install: () => {},
      run: () => { throw Object.assign(new Error("spawn failed"), { stderr: "network unreachable" }); },
    }),
    /opencode upgrade.*network unreachable/s,
  );
});

test("the Control Center's copy of the harness table matches the router's", async () => {
  // The app must be able to draw the Harness tab before it can load a module
  // out of the installed router, so `ipc.mjs` keeps its own detection table.
  // A drift between the two is silent and looks like "nothing is published",
  // which is exactly the failure this asserts away.
  const source = await import("node:fs/promises").then((fs) => fs.readFile(
    new URL("../apps/control-center/electron/ipc.mjs", import.meta.url),
    "utf8",
  ));
  const rows = source.slice(
    source.indexOf("const ROUTED_HARNESS_ROWS = Object.freeze(["),
    source.indexOf("const ROUTED_HARNESS_IDS = ROUTED_HARNESS_ROWS"),
  );
  assert.ok(rows.length > 0, "the Control Center harness table should be readable");
  assert.deepEqual(
    [...rows.matchAll(/^    id: "([a-z-]+)",$/gm)].map((match) => match[1]),
    ROUTED_HARNESS_IDS,
  );
  for (const harness of routedHarnesses()) {
    assert.match(rows, new RegExp(`marker: "${harness.id}-models\\.json"`));
    assert.match(rows, new RegExp(`binEnv: "${harness.binEnv}"`));
    assert.match(rows, new RegExp(`docs: "${harness.docsUrl.replaceAll("/", "\\/")}"`));
    assert.match(rows, new RegExp(`site: "${harness.siteUrl.replaceAll("/", "\\/")}"`));
    // The Update button's tooltip promises a specific command. If the app's
    // copy drifts from the catalog the button lies about what it will run.
    assert.match(
      rows,
      harness.updateCommand
        ? new RegExp(`updater: "${harness.executables[0]} ${harness.updateCommand.join(" ")}"`)
        : /updater: null/,
    );
    // The marker filename the app looks for has to be the one the publisher
    // writes, or a published client renders as "Not published" forever.
    assert.equal(
      path.basename(ROUTED_HARNESS_CATALOG_PATHS[harness.id]),
      `${harness.id}-models.json`,
    );
  }
});

test.after(() => rmSync(root, { recursive: true, force: true }));
