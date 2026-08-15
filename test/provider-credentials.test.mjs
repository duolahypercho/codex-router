import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-credentials-"));
process.env.CODEX_HOME = path.join(testRoot, "codex");
process.env.CODEX_ROUTER_STATE_DIR = path.join(testRoot, "state");
for (const name of ["ANTHROPIC_API_KEY", "CHUTES_API_KEY", "CLINE_API_KEY", "COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "DEEPSEEK_API_KEY", "KIMI_API_KEY", "MOONSHOT_API_KEY", "XAI_API_KEY", "GROK_API_KEY"]) {
  delete process.env[name];
}

const {
  credentialFileMode,
  keychainProbeCount,
  removeProviderCredential,
  resetKeychainCache,
  resolveProviderCredential,
  writeProviderCredential,
} = await import("../src/provider-credentials.mjs");
const { privateFileIsProtected } = await import("../src/file-security.mjs");

test("provider credentials use protected files and remove legacy managed keys", () => {
  try {
    const anonymous = resolveProviderCredential("opencode-free");
    assert.deepEqual(anonymous, {
      value: undefined,
      source: "official anonymous endpoint",
      persistent: true,
    });
    assert.throws(() => writeProviderCredential("opencode-free", "SHOULD_NOT_BE_STORED"), /Unknown API-key provider/);

    const deepSeekPath = writeProviderCredential("deepseek", "TEST_DEEPSEEK_FILE_KEY");
    assert.equal(privateFileIsProtected(deepSeekPath), true);
    if (process.platform !== "win32") {
      assert.equal(statSync(deepSeekPath).mode & 0o777, 0o600);
      assert.equal(credentialFileMode("deepseek"), 0o600);
    }
    assert.equal(resolveProviderCredential("deepseek")?.value, "TEST_DEEPSEEK_FILE_KEY");

    const xaiPath = writeProviderCredential("grok-api", "TEST_XAI_FILE_KEY");
    assert.equal(privateFileIsProtected(xaiPath), true);
    assert.equal(resolveProviderCredential("grok-api")?.value, "TEST_XAI_FILE_KEY");

    const anthropicPath = writeProviderCredential("anthropic-api", "TEST_ANTHROPIC_FILE_KEY");
    assert.equal(privateFileIsProtected(anthropicPath), true);
    assert.equal(resolveProviderCredential("anthropic-api")?.value, "TEST_ANTHROPIC_FILE_KEY");

    assert.throws(
      () => writeProviderCredential("github-copilot", "ghp_TEST_CLASSIC_TOKEN"),
      /Classic GitHub PATs are not supported/,
    );
    process.env.COPILOT_GITHUB_TOKEN = "ghp_TEST_CLASSIC_ENV_TOKEN";
    assert.equal(resolveProviderCredential("github-copilot"), undefined);
    process.env.GH_TOKEN = "gho_TEST_GH_TOKEN";
    process.env.GITHUB_TOKEN = "ghu_TEST_GITHUB_TOKEN";
    assert.equal(resolveProviderCredential("github-copilot")?.value, "gho_TEST_GH_TOKEN");
    process.env.COPILOT_GITHUB_TOKEN = "github_pat_TEST_PRIMARY_TOKEN";
    assert.equal(
      resolveProviderCredential("github-copilot")?.value,
      "github_pat_TEST_PRIMARY_TOKEN",
    );
    delete process.env.COPILOT_GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    const copilotPath = writeProviderCredential(
      "github-copilot",
      "github_pat_TEST_FINE_GRAINED_TOKEN",
    );
    assert.equal(privateFileIsProtected(copilotPath), true);
    assert.equal(
      resolveProviderCredential("github-copilot")?.value,
      "github_pat_TEST_FINE_GRAINED_TOKEN",
    );

    const clinepassPath = writeProviderCredential("clinepass", "TEST_CLINEPASS_FILE_KEY");
    assert.equal(privateFileIsProtected(clinepassPath), true);
    assert.equal(resolveProviderCredential("clinepass")?.value, "TEST_CLINEPASS_FILE_KEY");

    const chutesPath = writeProviderCredential("chutes", "TEST_CHUTES_FILE_KEY");
    assert.equal(privateFileIsProtected(chutesPath), true);
    assert.equal(resolveProviderCredential("chutes")?.value, "TEST_CHUTES_FILE_KEY");

    const legacyDirectory = path.join(process.env.CODEX_HOME, "kimi-router");
    const legacyPath = path.join(legacyDirectory, "api-key.secret");
    mkdirSync(legacyDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(legacyPath, "TEST_LEGACY_KIMI_KEY\n", { mode: 0o600 });
    assert.equal(resolveProviderCredential("kimi-api")?.value, "TEST_LEGACY_KIMI_KEY");

    assert.equal(removeProviderCredential("kimi-api"), 1);
    assert.equal(existsSync(legacyPath), false);
    assert.equal(removeProviderCredential("deepseek"), 1);
    assert.equal(removeProviderCredential("grok-api"), 1);
    assert.equal(removeProviderCredential("anthropic-api"), 1);
    assert.equal(removeProviderCredential("github-copilot"), 1);
    assert.equal(removeProviderCredential("clinepass"), 1);
    assert.equal(removeProviderCredential("chutes"), 1);
    assert.equal(existsSync(deepSeekPath), false);
    assert.equal(existsSync(xaiPath), false);
    assert.equal(existsSync(anthropicPath), false);
    assert.equal(existsSync(copilotPath), false);
    assert.equal(existsSync(clinepassPath), false);
    assert.equal(existsSync(chutesPath), false);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("--no-discovery blinds the resolver to stored keys without a single keychain spawn", () => {
  try {
    // A credential really is on disk; the kill-switch must refuse to see it.
    writeProviderCredential("deepseek", "TEST_DEEPSEEK_HIDDEN_KEY");
    process.env.DEEPSEEK_API_KEY = "TEST_DEEPSEEK_ENVIRONMENT_KEY";
    process.env.CODEX_ROUTER_NO_DISCOVERY = "1";
    resetKeychainCache();

    const before = keychainProbeCount();
    assert.equal(resolveProviderCredential("deepseek"), undefined);
    assert.equal(resolveProviderCredential("openrouter", { persistent: true }), undefined);
    assert.equal(keychainProbeCount(), before, "the kill-switch still spawned /usr/bin/security");

    // Sources that read nothing keep answering: anonymous and keyless
    // providers carry no secret, so they are not discovery.
    assert.equal(resolveProviderCredential("opencode-free")?.persistent, true);

    delete process.env.CODEX_ROUTER_NO_DISCOVERY;
    assert.equal(
      resolveProviderCredential("deepseek", { persistent: true })?.value,
      "TEST_DEEPSEEK_HIDDEN_KEY",
      "lifting the switch must reveal the stored key again",
    );
  } finally {
    delete process.env.CODEX_ROUTER_NO_DISCOVERY;
    delete process.env.DEEPSEEK_API_KEY;
    removeProviderCredential("deepseek");
  }
});

// The keychain lookup is the only part of resolving a credential that spawns a
// process, and `configuredProviderIds()` runs it once per provider per service
// on the routed request path -- synchronously, so the whole event loop waits.
// This asserts the spawn count directly rather than a duration: a timing bound
// would be flaky, a probe count is exact.
const { TARGET } = await import("../src/paths.mjs");
const keychainProbed = process.platform === "darwin" && TARGET === "codex";

test(
  "a keychain lookup is spawned once per service, not once per resolve",
  { skip: keychainProbed ? false : "the keychain is only consulted on macOS/codex" },
  (t) => {
    t.after(() => rmSync(testRoot, { recursive: true, force: true }));
    resetKeychainCache();
    // "openrouter" has no file credential here, so the resolve falls all the way
    // through to the keychain. Nothing is stored under its service names on a
    // test machine, and an absent item is exactly the case that used to cost a
    // spawn every single time.
    const before = keychainProbeCount();
    resolveProviderCredential("openrouter", { persistent: true });
    const firstPass = keychainProbeCount() - before;
    assert.ok(firstPass >= 1, "the first resolve should have probed the keychain");

    for (let index = 0; index < 20; index += 1) {
      resolveProviderCredential("openrouter", { persistent: true });
    }
    assert.equal(
      keychainProbeCount() - before,
      firstPass,
      "20 further resolves re-spawned /usr/bin/security instead of reusing the memo",
    );

    // Storing a key is the mutation that must not be masked. It lands in a
    // protected file, which is consulted before the keychain, so it is visible
    // at once -- and the memo is dropped as well so nothing downstream can be
    // served a pre-write answer.
    writeProviderCredential("openrouter", "TEST_OPENROUTER_FILE_KEY");
    const credential = resolveProviderCredential("openrouter", { persistent: true });
    assert.equal(credential?.value, "TEST_OPENROUTER_FILE_KEY");
    assert.match(credential.source, /^protected file/);

    // Removing it puts the keychain back in play, and that answer is taken
    // fresh rather than from the memo the write invalidated.
    removeProviderCredential("openrouter");
    const afterRemove = keychainProbeCount();
    resolveProviderCredential("openrouter", { persistent: true });
    assert.ok(
      keychainProbeCount() > afterRemove,
      "removing the stored key left the keychain answer cached from before the write",
    );
  },
);
