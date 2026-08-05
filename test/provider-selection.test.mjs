import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
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
}

const { writeProviderCredential } = await import("../src/provider-credentials.mjs");
const {
  configuredProviderIds,
  disableProvider,
  enableProvider,
  readProviderSelection,
  selectedConfiguredListedModels,
  selectedListedModels,
  writeProviderSelection,
} = await import("../src/provider-selection.mjs");
const { PROVIDER_SELECTION_PATH } = await import("../src/paths.mjs");
const { privateFileIsProtected } = await import("../src/file-security.mjs");

test("provider selection keeps backward compatibility and can hide the final provider", () => {
  try {
    // No selection file means every registry provider stays visible; the
    // credential-aware catalog is what hides providers that cannot authenticate.
    assert.deepEqual(readProviderSelection(), [...PROVIDERS.keys()]);
    process.env.KIMI_API_KEY = "TEST_ENVIRONMENT_ONLY_KEY";
    assert.deepEqual(configuredProviderIds(), []);
    delete process.env.KIMI_API_KEY;
    writeProviderCredential("deepseek", "TEST_DEEPSEEK_SELECTION_KEY");
    assert.deepEqual(configuredProviderIds(), ["deepseek"]);

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
