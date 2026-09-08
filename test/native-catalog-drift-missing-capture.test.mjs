// Own file: paths.mjs freezes its constants at first import, so the state
// directory this scenario needs has to be in the environment before anything
// under src/ is loaded.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = mkdtempSync(path.join(os.tmpdir(), "native-drift-missing-"));
const stateDir = path.join(tempDir, "state");
const codexHome = path.join(tempDir, "codex");
mkdirSync(stateDir, { recursive: true });
mkdirSync(codexHome, { recursive: true });
process.env.MODEL_ROUTER_STATE_DIR = stateDir;
process.env.CODEX_HOME = codexHome;
process.env.MODEL_ROUTER_TARGET = "codex";

const { nativeCatalogDriftDetected } = await import("../src/native-catalog-drift.mjs");
const { CONFIG_PATH, NATIVE_CATALOG_PATH } = await import("../src/paths.mjs");

test.after(() => rmSync(tempDir, { recursive: true, force: true }));

test("a missing native capture is drift, not 'nothing to compare'", () => {
  writeFileSync(
    CONFIG_PATH,
    '# BEGIN codex-router-managed\nopenai_base_url = "http://test"\n# END codex-router-managed\n',
  );
  writeFileSync(
    path.join(codexHome, "models_cache.json"),
    JSON.stringify({ models: [{ slug: "gpt-6-astra", visibility: "list" }] }),
  );

  // The published catalog was built from a capture that is gone. Nothing else
  // notices the account gaining a model, so answering "no drift" here strands
  // the picker on whatever was published last (issue #645).
  assert.equal(existsSync(NATIVE_CATALOG_PATH), false);
  assert.equal(
    nativeCatalogDriftDetected(),
    true,
    "a missing capture with a valid account cache must republish",
  );
});

test("an uninstalled Codex integration still reports no drift", () => {
  rmSync(CONFIG_PATH, { force: true });
  assert.equal(
    nativeCatalogDriftDetected(),
    false,
    "without managed config there is no picker to republish",
  );
});

test("a stale resolved Codex is reported instead of freezing the picker silently", async () => {
  const { republishOnNativeDrift } = await import("../src/native-catalog-drift.mjs");
  const errors = [];
  const original = console.error;
  console.error = (message) => errors.push(String(message));
  try {
    const republished = await republishOnNativeDrift({
      refreshAccountCatalog: async () => ({ status: "stale-client" }),
      nativeDriftDetected: () => false,
      routedAgentDriftDetected: () => false,
      refreshTargetPicker: () => { throw new Error("no republish expected"); },
    });
    assert.equal(republished, false);
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 1);
  assert.match(errors[0], /older than the client that wrote the account model cache/);
  assert.match(errors[0], /CODEX_BIN/);
});

test("an ordinary refresh status stays quiet", async () => {
  const { republishOnNativeDrift } = await import("../src/native-catalog-drift.mjs");
  const errors = [];
  const original = console.error;
  console.error = (message) => errors.push(String(message));
  try {
    for (const status of ["fresh", "unchanged", "not-modified", "updated", "failed"]) {
      await republishOnNativeDrift({
        refreshAccountCatalog: async () => ({ status }),
        nativeDriftDetected: () => false,
        routedAgentDriftDetected: () => false,
      });
    }
  } finally {
    console.error = original;
  }
  assert.deepEqual(errors, []);
});
