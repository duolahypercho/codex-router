import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "signed-coexistence-state-test-"));
process.env.MODEL_ROUTER_STATE_DIR = stateDir;

const {
  readSignedCoexistence,
  setSignedCoexistenceModel,
  signedCoexistenceSnapshot,
} = await import("../src/signed-coexistence-state.mjs");

test("signed-in coexistence defaults off", () => {
  assert.deepEqual(readSignedCoexistence(), { version: 1, model: null });
});

test("signed-in coexistence stores one protected external model selection", () => {
  const enabled = setSignedCoexistenceModel("clinepass/kimi-k3");
  assert.equal(enabled.model, "clinepass/kimi-k3");
  assert.equal(statSync(enabled.path).mode & 0o777, 0o600);
  assert.equal(signedCoexistenceSnapshot().model, "clinepass/kimi-k3");

  const disabled = setSignedCoexistenceModel(null);
  assert.equal(disabled.model, null);
});
