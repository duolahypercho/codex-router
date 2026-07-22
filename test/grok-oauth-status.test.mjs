import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { grokOAuthStatus } from "../src/grok-oauth-status.mjs";

function withAuthFile(contents, run) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-oauth-"));
  const authPath = path.join(dir, "auth.json");
  if (contents !== undefined) writeFileSync(authPath, contents, { mode: 0o600 });
  const previous = process.env.GROK_AUTH_PATH;
  process.env.GROK_AUTH_PATH = authPath;
  try {
    return run(authPath);
  } finally {
    if (previous === undefined) delete process.env.GROK_AUTH_PATH;
    else process.env.GROK_AUTH_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("reports configured for an official Grok session and never leaks tokens", () => {
  const status = withAuthFile(
    JSON.stringify({
      "https://auth.x.ai::test-client-id": { key: "secret-access-token-value" },
    }),
    () => grokOAuthStatus(),
  );
  assert.equal(status.configured, true);
  // No token value must appear anywhere in the status object.
  assert.doesNotMatch(JSON.stringify(status), /secret-access-token/);
});

test("reports not configured when the session file is missing", () => {
  const status = withAuthFile(undefined, () => grokOAuthStatus());
  assert.equal(status.configured, false);
  assert.match(status.setup, /grok login/);
});

test("reports not configured when tokens are incomplete", () => {
  const status = withAuthFile(
    JSON.stringify({ "https://auth.x.ai::test-client-id": {} }),
    () => grokOAuthStatus(),
  );
  assert.equal(status.configured, false);
  assert.match(status.setup, /incomplete/);
});

test("reports not configured for an invalid session file", () => {
  const status = withAuthFile("{ not json", () => grokOAuthStatus());
  assert.equal(status.configured, false);
  assert.match(status.setup, /invalid/);
});
