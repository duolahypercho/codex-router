import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { chatgptOAuthStatus } from "../src/chatgpt-oauth-status.mjs";

function withAuthFile(contents, run) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "chatgpt-oauth-"));
  const authPath = path.join(dir, "auth.json");
  if (contents !== undefined) writeFileSync(authPath, contents, { mode: 0o600 });
  const previous = process.env.CHATGPT_AUTH_PATH;
  process.env.CHATGPT_AUTH_PATH = authPath;
  try {
    return run(authPath);
  } finally {
    if (previous === undefined) delete process.env.CHATGPT_AUTH_PATH;
    else process.env.CHATGPT_AUTH_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("reports configured for a complete Codex session and never leaks tokens", () => {
  const status = withAuthFile(
    JSON.stringify({
      tokens: {
        access_token: "secret-access-token-value",
        refresh_token: "secret-refresh-token-value",
        account_id: "acct_123",
      },
      last_refresh: "2026-07-20T00:00:00Z",
    }),
    () => chatgptOAuthStatus(),
  );
  assert.equal(status.configured, true);
  assert.equal(status.accountId, true);
  assert.equal(status.lastRefresh, "2026-07-20T00:00:00Z");
  // No token value must appear anywhere in the status object.
  assert.doesNotMatch(JSON.stringify(status), /secret-(access|refresh)-token/);
});

test("reports not configured when the session file is missing", () => {
  const status = withAuthFile(undefined, () => chatgptOAuthStatus());
  assert.equal(status.configured, false);
  assert.match(status.setup, /codex login/);
});

test("reports not configured when tokens are incomplete", () => {
  const status = withAuthFile(
    JSON.stringify({ tokens: { access_token: "only-access" } }),
    () => chatgptOAuthStatus(),
  );
  assert.equal(status.configured, false);
  assert.match(status.setup, /incomplete/);
});

test("reports not configured for an invalid session file", () => {
  const status = withAuthFile("{ not json", () => chatgptOAuthStatus());
  assert.equal(status.configured, false);
  assert.match(status.setup, /invalid/);
});
