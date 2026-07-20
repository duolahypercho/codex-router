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
for (const name of ["DEEPSEEK_API_KEY", "KIMI_API_KEY", "MOONSHOT_API_KEY"]) {
  delete process.env[name];
}

const {
  credentialFileMode,
  removeProviderCredential,
  resolveProviderCredential,
  writeProviderCredential,
} = await import("../src/provider-credentials.mjs");

test("provider credentials use protected files and remove legacy managed keys", () => {
  try {
    const deepSeekPath = writeProviderCredential("deepseek", "TEST_DEEPSEEK_FILE_KEY");
    assert.equal(statSync(deepSeekPath).mode & 0o777, 0o600);
    assert.equal(credentialFileMode("deepseek"), 0o600);
    assert.equal(resolveProviderCredential("deepseek")?.value, "TEST_DEEPSEEK_FILE_KEY");

    const legacyDirectory = path.join(process.env.CODEX_HOME, "kimi-router");
    const legacyPath = path.join(legacyDirectory, "api-key.secret");
    mkdirSync(legacyDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(legacyPath, "TEST_LEGACY_KIMI_KEY\n", { mode: 0o600 });
    assert.equal(resolveProviderCredential("kimi-api")?.value, "TEST_LEGACY_KIMI_KEY");

    assert.equal(removeProviderCredential("kimi-api"), 1);
    assert.equal(existsSync(legacyPath), false);
    assert.equal(removeProviderCredential("deepseek"), 1);
    assert.equal(existsSync(deepSeekPath), false);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});
