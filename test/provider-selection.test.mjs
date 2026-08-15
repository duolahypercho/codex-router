import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-selection-"));
process.env.CODEX_HOME = path.join(testRoot, "codex");
process.env.CODEX_ROUTER_STATE_DIR = path.join(testRoot, "state");
process.env.KIMI_CODE_HOME = path.join(testRoot, "kimi-code");
process.env.GROK_AUTH_PATH = path.join(testRoot, "grok", "auth.json");
const { PROVIDERS } = await import("../src/model-registry.mjs");
// Clearing every registry-declared credential variable keeps the "no provider
// is configured yet" assertions deterministic on a developer machine that has
// real keys exported, and stays correct as providers are added.
for (const provider of PROVIDERS.values()) {
  for (const name of provider.credential?.environment || []) delete process.env[name];
  // A CLI sign-in is an external credential too: a developer who has really
  // run `command-code login` must not turn "nothing is configured yet" false.
  const session = provider.credential?.cliSession;
  if (session?.homeEnv) {
    process.env[session.homeEnv] = path.join(testRoot, "cli-sessions", provider.id);
  }
}

const { writeProviderCredential } = await import("../src/provider-credentials.mjs");
const {
  configuredProviderIds,
  defaultProviderIds,
  disableProvider,
  enableProvider,
  providerSelectionStatus,
  readProviderSelection,
  readProviderSelectionDetail,
  selectedConfiguredListedModels,
  selectedListedModels,
  validateProviderIds,
  writeProviderSelection,
} = await import("../src/provider-selection.mjs");
const { PROVIDER_SELECTION_PATH } = await import("../src/paths.mjs");
const { privateFileIsProtected } = await import("../src/file-security.mjs");

// Write the selection file behind the API so a test can stage the exact state a
// newer checkout, or a corrupt write, leaves behind for an older running build.
function stageSelectionFile(contents) {
  mkdirSync(path.dirname(PROVIDER_SELECTION_PATH), { recursive: true });
  writeFileSync(PROVIDER_SELECTION_PATH, contents, { encoding: "utf8", mode: 0o600 });
}

test("provider selection keeps backward compatibility and can hide the final provider", () => {
  try {
    // No selection file means every registry provider stays visible; the
    // credential-aware catalog is what hides providers that cannot authenticate.
    assert.deepEqual(readProviderSelection(), [...PROVIDERS.keys()]);
    process.env.KIMI_API_KEY = "TEST_ENVIRONMENT_ONLY_KEY";
    // `local` is keyless: it serves from this machine, so there is no
    // credential to configure and it is always available. Everything else has
    // to authenticate before it counts.
    assert.deepEqual(configuredProviderIds(), ["kilo-free", "local", "opencode-free"]);
    assert.deepEqual(defaultProviderIds(), ["local"]);
    delete process.env.KIMI_API_KEY;
    writeProviderCredential("deepseek", "TEST_DEEPSEEK_SELECTION_KEY");
    assert.deepEqual(configuredProviderIds(), ["deepseek", "kilo-free", "local", "opencode-free"]);
    assert.deepEqual(defaultProviderIds(), ["deepseek", "local"]);

    writeProviderSelection(["chatgpt-oauth"]);
    assert.deepEqual(readProviderSelection(), ["grok-oauth"]);

    writeProviderSelection(["deepseek"]);
    assert.equal(privateFileIsProtected(PROVIDER_SELECTION_PATH), true);
    if (process.platform !== "win32") {
      assert.equal(statSync(PROVIDER_SELECTION_PATH).mode & 0o777, 0o600);
    }
    assert.deepEqual(
      selectedListedModels().map((model) => model.slug),
      ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro"],
    );
    assert.deepEqual(
      selectedConfiguredListedModels().map((model) => model.slug),
      ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro"],
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
    assert.ok(slugs.includes("opencode-go/grok-4.5"));
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
      ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro"],
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
