import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-selection-"));
process.env.CODEX_HOME = path.join(testRoot, "codex");
process.env.CODEX_ROUTER_STATE_DIR = path.join(testRoot, "state");
process.env.KIMI_CODE_HOME = path.join(testRoot, "kimi-code");
process.env.GROK_AUTH_PATH = path.join(testRoot, "grok", "auth.json");
process.env.DEVIN_CREDENTIALS_PATH = path.join(testRoot, "devin", "credentials.toml");
const { PROVIDERS } = await import("../src/model-registry.mjs");
// Clearing every registry-declared credential variable keeps the "no provider
// is configured yet" assertions deterministic on a developer machine that has
// real keys exported, and stays correct as providers are added.
for (const provider of PROVIDERS.values()) {
  for (const name of provider.credential?.environment || []) delete process.env[name];
}

const { writeProviderCredential } = await import("../src/provider-credentials.mjs");
const {
  configuredProviderIds,
  defaultProviderIds,
  disableProvider,
  enableProvider,
  providerSelectionStatus,
  pruneUnconfiguredProviders,
  readProviderSelection,
  readProviderSelectionDetail,
  selectedConfiguredListedModels,
  selectedListedModels,
  validateProviderIds,
  writeProviderSelection,
} = await import("../src/provider-selection.mjs");
const { PROVIDER_SELECTION_PATH } = await import("../src/paths.mjs");
const { privateFileIsProtected } = await import("../src/file-security.mjs");
const { addEnvironmentCredentialToPool } = await import("../src/provider-api-key-control.mjs");

// Write the selection file behind the API so a test can stage the exact state a
// newer checkout, or a corrupt write, leaves behind for an older running build.
function stageSelectionFile(contents) {
  mkdirSync(path.dirname(PROVIDER_SELECTION_PATH), { recursive: true });
  writeFileSync(PROVIDER_SELECTION_PATH, contents, { encoding: "utf8", mode: 0o600 });
}

test("a valid official Devin CLI session configures the provider family", () => {
  try {
    mkdirSync(path.dirname(process.env.DEVIN_CREDENTIALS_PATH), { recursive: true });
    writeFileSync(
      process.env.DEVIN_CREDENTIALS_PATH,
      'windsurf_api_key = "TEST_DEVIN_SESSION_ONLY"\napi_server_url = "https://server.invalid"\n',
      { mode: 0o600 },
    );
    assert.ok(configuredProviderIds().includes("devin-cli"));
  } finally {
    rmSync(process.env.DEVIN_CREDENTIALS_PATH, { force: true });
  }
});

test("provider selection keeps backward compatibility and can hide the final provider", () => {
  try {
    // No selection file means every registry provider stays visible; the
    // credential-aware catalog is what hides providers that cannot authenticate.
    assert.deepEqual(readProviderSelection(), [...PROVIDERS.keys()]);
    process.env.KIMI_API_KEY = "TEST_ENVIRONMENT_ONLY_KEY";
    // Local backends are keyless: they serve from this machine, so there is no
    // credential to configure and they are always available. Everything else
    // has to authenticate before it counts.
    assert.deepEqual(configuredProviderIds(), [
      "chatgpt-web",
      "custom",
      "kilo-free",
      "lmstudio",
      "local",
      "opencode-free",
      "opencode-free-responses",
    ]);
    assert.deepEqual(defaultProviderIds(), ["lmstudio", "local"]);
    delete process.env.KIMI_API_KEY;
    writeProviderCredential("deepseek", "TEST_DEEPSEEK_SELECTION_KEY");
    assert.deepEqual(configuredProviderIds(), [
      "chatgpt-web",
      "custom",
      "deepseek",
      "kilo-free",
      "lmstudio",
      "local",
      "opencode-free",
      "opencode-free-responses",
    ]);
    assert.deepEqual(defaultProviderIds(), ["deepseek", "lmstudio", "local"]);

    writeProviderSelection(["chatgpt-oauth"]);
    assert.deepEqual(readProviderSelection(), ["grok-oauth"]);

    writeProviderSelection(["deepseek"]);
    assert.equal(privateFileIsProtected(PROVIDER_SELECTION_PATH), true);
    if (process.platform !== "win32") {
      assert.equal(statSync(PROVIDER_SELECTION_PATH).mode & 0o777, 0o600);
    }
    assert.deepEqual(
      selectedListedModels().map((model) => model.slug),
      [
        "deepseek/deepseek-v4-flash",
        "deepseek/deepseek-v4-flash-vision-exp",
        "deepseek/deepseek-v4-pro",
      ],
    );
    assert.deepEqual(
      selectedConfiguredListedModels().map((model) => model.slug),
      [
        "deepseek/deepseek-v4-flash",
        "deepseek/deepseek-v4-flash-vision-exp",
        "deepseek/deepseek-v4-pro",
      ],
    );

    assert.deepEqual(disableProvider("deepseek"), []);
    assert.deepEqual(selectedListedModels(), []);
    assert.deepEqual(enableProvider("deepseek"), ["deepseek"]);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("opencode Go protocol variants follow their parent as one family", () => {
  try {
    writeProviderCredential("opencode-go", "TEST_OPENCODE_GO_SELECTION_KEY");

    // Selecting any family member stores only the canonical parent, so a
    // selection written before a variant shipped still exposes it on read.
    writeProviderSelection(["opencode-go-messages"]);
    assert.deepEqual(
      JSON.parse(readFileSync(PROVIDER_SELECTION_PATH, "utf8")).providers,
      ["opencode-go"],
    );
    assert.deepEqual(readProviderSelection(), [
      "opencode-go",
      "opencode-go-messages",
      "opencode-go-responses",
      "opencode-zen",
    ]);

    const slugs = selectedConfiguredListedModels().map((model) => model.slug);
    assert.ok(slugs.includes("opencode-go-responses/grok-4.5"));
    assert.ok(slugs.includes("opencode-go-messages/minimax-m3"));
    assert.ok(slugs.includes("opencode-go-messages/qwen3.8-max"));
    assert.ok(slugs.includes("opencode-go-responses/gpt-5.6-luna"));

    // Disabling any member hides the whole family; a variant cannot stay
    // half-enabled behind its parent's back.
    assert.deepEqual(disableProvider("opencode-go-responses"), []);
    assert.deepEqual(selectedListedModels(), []);
    assert.deepEqual(enableProvider("opencode-go"), ["opencode-go"]);
    assert.ok(
      selectedConfiguredListedModels()
        .map((model) => model.slug)
        .includes("opencode-go-messages/minimax-m2.7"),
    );
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("OpenCode Free protocol variants follow the anonymous parent as one family", () => {
  try {
    writeProviderSelection(["opencode-free-responses"]);
    assert.deepEqual(
      JSON.parse(readFileSync(PROVIDER_SELECTION_PATH, "utf8")).providers,
      ["opencode-free"],
    );
    assert.deepEqual(readProviderSelection(), [
      "opencode-free",
      "opencode-free-responses",
    ]);
    assert.deepEqual(disableProvider("opencode-free-responses"), []);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("Command Code protocol variants follow their parent as one family", () => {
  try {
    writeProviderCredential("commandcode", "TEST_COMMANDCODE_SELECTION_KEY");

    writeProviderSelection(["commandcode-messages"]);
    assert.deepEqual(
      JSON.parse(readFileSync(PROVIDER_SELECTION_PATH, "utf8")).providers,
      ["commandcode"],
    );
    assert.deepEqual(readProviderSelection(), [
      "commandcode",
      "commandcode-messages",
    ]);

    const slugs = selectedConfiguredListedModels().map((model) => model.slug);
    assert.ok(slugs.includes("commandcode/deepseek-v4-flash"));
    assert.ok(slugs.includes("commandcode-messages/claude-opus-4.8"));

    assert.deepEqual(disableProvider("commandcode-messages"), []);
    assert.deepEqual(selectedListedModels(), []);
    assert.deepEqual(enableProvider("commandcode"), ["commandcode"]);
    assert.ok(
      selectedConfiguredListedModels()
        .map((model) => model.slug)
        .includes("commandcode-messages/claude-sonnet-5"),
    );
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("an authoritative ready pool publishes its family and an unusable pool masks a legacy key", async () => {
  try {
    rmSync(testRoot, { recursive: true, force: true });
    process.env.OPENCODE_API_KEY = "TEST_POOL_ENVIRONMENT_KEY";
    await addEnvironmentCredentialToPool("opencode-go", "OPENCODE_API_KEY");
    writeProviderSelection(["opencode-go"]);

    const ready = new Set(configuredProviderIds());
    for (const providerId of [
      "opencode-go",
      "opencode-go-messages",
      "opencode-go-responses",
      "opencode-zen",
    ]) {
      assert.equal(ready.has(providerId), true, `${providerId} should follow the ready canonical pool`);
    }
    assert.ok(
      selectedConfiguredListedModels().some((model) => model.provider === "opencode-go-responses"),
      "a ready referenced environment key must publish models without a legacy key file",
    );

    delete process.env.OPENCODE_API_KEY;
    writeProviderCredential("opencode-go", "TEST_LEGACY_KEY_MUST_NOT_BYPASS_POOL");
    const unavailable = new Set(configuredProviderIds());
    for (const providerId of [
      "opencode-go",
      "opencode-go-messages",
      "opencode-go-responses",
      "opencode-zen",
    ]) {
      assert.equal(unavailable.has(providerId), false, `${providerId} must obey the unusable canonical pool`);
    }
    assert.deepEqual(selectedConfiguredListedModels(), []);
  } finally {
    delete process.env.OPENCODE_API_KEY;
    rmSync(testRoot, { recursive: true, force: true });
  }
});

// `PROVIDERS` is frozen at module import, so a selection file naming an id this
// build does not have -- version skew after an update, a CLI run from a newer
// checkout, a provider that was renamed or removed -- used to throw out of the
// first statement of `healthPayload()` and out of every `/responses` turn,
// wedging the whole router until the service restarted.
test("an unknown provider id in the selection file is filtered out, not fatal", () => {
  try {
    stageSelectionFile(
      `${JSON.stringify({
        version: 1,
        providers: ["deepseek", "provider-from-a-newer-build"],
      })}\n`,
    );

    assert.deepEqual(readProviderSelection(), ["deepseek"]);
    const detail = readProviderSelectionDetail();
    assert.deepEqual(detail.ignored, ["provider-from-a-newer-build"]);
    assert.match(detail.degraded, /provider-from-a-newer-build/);
    // The surviving provider still routes and still filters the catalog.
    assert.deepEqual(
      selectedListedModels().map((model) => model.slug),
      [
        "deepseek/deepseek-v4-flash",
        "deepseek/deepseek-v4-flash-vision-exp",
        "deepseek/deepseek-v4-pro",
      ],
    );
    // Doctor and the support bundle read through this, so the damage is
    // reportable instead of arriving as a 502 on every request.
    const status = providerSelectionStatus();
    assert.deepEqual(status.providers, ["deepseek"]);
    assert.deepEqual(status.ignored, ["provider-from-a-newer-build"]);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("a retired provider alias still maps to its successor while unknown ids are dropped", () => {
  try {
    stageSelectionFile(
      `${JSON.stringify({
        version: 1,
        providers: ["chatgpt-oauth", "provider-from-a-newer-build"],
      })}\n`,
    );

    assert.deepEqual(readProviderSelection(), ["grok-oauth"]);
    assert.deepEqual(readProviderSelectionDetail().ignored, ["provider-from-a-newer-build"]);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

// When nothing in the file exists in this build, the operator's stored intent
// says nothing about the providers this build does have, so the read falls back
// to the no-file default rather than stranding the install with no route at
// all. The credential-aware catalog still hides anything that cannot
// authenticate, so this is the same coherent state as a fresh install.
test("a selection naming only unknown providers falls back to the no-file default", () => {
  try {
    stageSelectionFile(
      `${JSON.stringify({
        version: 1,
        providers: ["provider-from-a-newer-build", "provider-that-was-removed"],
      })}\n`,
    );

    assert.deepEqual(readProviderSelection(), [...PROVIDERS.keys()]);
    const detail = readProviderSelectionDetail();
    assert.deepEqual(detail.ignored, [
      "provider-from-a-newer-build",
      "provider-that-was-removed",
    ]);
    assert.match(detail.degraded, /no provider this build knows/);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

// An explicitly empty list is a deliberate choice -- disabling the last
// provider writes `[]` -- so it must not be mistaken for the unknown-id
// fallback above and silently reopen every provider.
test("an explicitly empty selection still hides every provider", () => {
  try {
    stageSelectionFile(`${JSON.stringify({ version: 1, providers: [] })}\n`);

    assert.deepEqual(readProviderSelection(), []);
    assert.deepEqual(readProviderSelectionDetail().ignored, []);
    assert.equal(readProviderSelectionDetail().degraded, undefined);
    assert.deepEqual(selectedListedModels(), []);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("an unreadable or wrong-version selection file degrades instead of throwing", () => {
  try {
    stageSelectionFile("{ not json at all");
    assert.deepEqual(readProviderSelection(), [...PROVIDERS.keys()]);
    assert.match(readProviderSelectionDetail().degraded, /Unreadable provider selection/);

    stageSelectionFile(`${JSON.stringify({ version: 99, providers: ["deepseek"] })}\n`);
    assert.deepEqual(readProviderSelection(), [...PROVIDERS.keys()]);
    assert.match(readProviderSelectionDetail().degraded, /version\/providers are invalid/);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

// The read path degrading must not soften the write path: a person naming a
// provider on the CLI, in `install --providers`, or through the tray still gets
// a hard error for a typo rather than a silently narrower selection.
test("the write path still rejects an unknown provider id", () => {
  try {
    assert.throws(
      () => validateProviderIds(["deepseek", "provider-from-a-newer-build"]),
      /Unknown provider: provider-from-a-newer-build/,
    );
    assert.throws(
      () => writeProviderSelection(["deepseek", "provider-from-a-newer-build"]),
      /Unknown provider: provider-from-a-newer-build/,
    );
    assert.throws(
      () => enableProvider("provider-from-a-newer-build"),
      /Unknown provider: provider-from-a-newer-build/,
    );

    // A rejected write leaves the previous file exactly as it was.
    writeProviderSelection(["deepseek"]);
    assert.throws(
      () => writeProviderSelection(["provider-from-a-newer-build"]),
      /Unknown provider: provider-from-a-newer-build/,
    );
    assert.deepEqual(
      JSON.parse(readFileSync(PROVIDER_SELECTION_PATH, "utf8")).providers,
      ["deepseek"],
    );

    // A CLI run against a file a newer build left behind rewrites it without
    // the unknown id, so the next read is clean again.
    stageSelectionFile(
      `${JSON.stringify({
        version: 1,
        providers: ["deepseek", "provider-from-a-newer-build"],
      })}\n`,
    );
    assert.deepEqual(enableProvider("kimi-api"), ["deepseek", "kimi-api"]);
    assert.deepEqual(
      JSON.parse(readFileSync(PROVIDER_SELECTION_PATH, "utf8")).providers,
      ["deepseek", "kimi-api"],
    );
    assert.deepEqual(readProviderSelectionDetail().ignored, []);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("pruneUnconfiguredProviders drops unknown and uncredentialed ids from the file", () => {
  try {
    writeProviderCredential("deepseek", "TEST_DEEPSEEK_PRUNE_KEY");
    stageSelectionFile(
      `${JSON.stringify({
        version: 1,
        providers: ["deepseek", "kimi-api", "provider-from-a-newer-build"],
      })}\n`,
    );

    const removed = pruneUnconfiguredProviders();
    assert.deepEqual(
      removed.map(({ id, reason }) => [id, reason]).sort(),
      [
        ["kimi-api", "no credential"],
        ["provider-from-a-newer-build", "unrecognised"],
      ],
    );
    assert.deepEqual(
      JSON.parse(readFileSync(PROVIDER_SELECTION_PATH, "utf8")).providers,
      ["deepseek"],
    );
    assert.deepEqual(pruneUnconfiguredProviders(), []);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("pruneUnconfiguredProviders does not invent a selection file", () => {
  try {
    rmSync(testRoot, { recursive: true, force: true });
    assert.equal(existsSync(PROVIDER_SELECTION_PATH), false);
    assert.deepEqual(pruneUnconfiguredProviders(), []);
    assert.equal(existsSync(PROVIDER_SELECTION_PATH), false);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("pruneUnconfiguredProviders deletes a file that names only unknown providers", () => {
  try {
    stageSelectionFile(
      `${JSON.stringify({
        version: 1,
        providers: ["provider-from-a-newer-build", "provider-that-was-removed"],
      })}\n`,
    );

    const removed = pruneUnconfiguredProviders();
    assert.deepEqual(
      removed.map(({ id }) => id).sort(),
      ["provider-from-a-newer-build", "provider-that-was-removed"],
    );
    assert.equal(existsSync(PROVIDER_SELECTION_PATH), false);
    // Same coherent state as a fresh install: no explicit file means show all,
    // and the credential-aware catalog still hides anything that cannot auth.
    assert.deepEqual(readProviderSelection(), [...PROVIDERS.keys()]);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("pruneUnconfiguredProviders keeps anonymous and keyless selections", () => {
  try {
    writeProviderSelection(["opencode-free", "local", "kimi-api"]);
    const removed = pruneUnconfiguredProviders();
    assert.deepEqual(removed, [{ id: "kimi-api", reason: "no credential" }]);
    assert.deepEqual(
      JSON.parse(readFileSync(PROVIDER_SELECTION_PATH, "utf8")).providers,
      ["opencode-free", "local"],
    );
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});
