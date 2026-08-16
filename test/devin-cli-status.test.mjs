import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { devinCredentialsPath, devinSessionEntry } from "../src/devin-cli-status.mjs";
import { readDevinSession } from "../src/devin-cli-session.mjs";

function withCredentials(contents, run) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "devin-cred-"));
  const file = path.join(directory, "credentials.toml");
  if (contents !== null) writeFileSync(file, contents);
  const previous = process.env.DEVIN_CREDENTIALS_PATH;
  process.env.DEVIN_CREDENTIALS_PATH = file;
  try {
    return run(file);
  } finally {
    if (previous === undefined) delete process.env.DEVIN_CREDENTIALS_PATH;
    else process.env.DEVIN_CREDENTIALS_PATH = previous;
    rmSync(directory, { recursive: true, force: true });
  }
}

test("reads the token and server the Devin CLI wrote", () => {
  const session = devinSessionEntry(
    [
      'windsurf_api_key = "devin-session-token$abc"',
      'api_server_url = "https://server.codeium.com"',
      'devin_api_url = "https://api.devin.ai"',
    ].join("\n"),
  );
  assert.equal(session.apiKey, "devin-session-token$abc");
  assert.equal(session.apiServerUrl, "https://server.codeium.com");
  assert.equal(session.devinApiUrl, "https://api.devin.ai");
});

test("falls back to the documented API server when the file omits one", () => {
  const session = devinSessionEntry('windsurf_api_key = "devin-session-token$abc"');
  assert.equal(session.apiServerUrl, "https://server.codeium.com");
});

test("treats a credentials file without a key as unconfigured, not as an empty session", () => {
  assert.equal(devinSessionEntry('api_server_url = "https://server.codeium.com"'), undefined);
  assert.equal(devinSessionEntry('windsurf_api_key = ""'), undefined);
});

// The structural scanner is fail-closed on purpose: a duplicate assignment has
// no single right answer, and guessing would pick a credential nobody chose.
test("refuses a duplicated key rather than picking one", () => {
  assert.throws(
    () => devinSessionEntry('windsurf_api_key = "a"\nwindsurf_api_key = "b"'),
    /duplicate/i,
  );
});

test("honours DEVIN_CREDENTIALS_PATH so a test never reads the operator's own session", () => {
  withCredentials('windsurf_api_key = "devin-session-token$xyz"', (file) => {
    assert.equal(devinCredentialsPath(), file);
    assert.equal(readDevinSession().apiKey, "devin-session-token$xyz");
  });
});

test("reports a missing session as an auth failure naming the login command", () => {
  withCredentials(null, () => {
    assert.throws(readDevinSession, (error) => {
      assert.equal(error.code, "oauth_unauthorized");
      assert.equal(error.status, 401);
      assert.match(error.message, /devin auth login/);
      return true;
    });
  });
});

test("reports an unreadable session as an auth failure instead of throwing a parse error", () => {
  withCredentials('windsurf_api_key = "a"\nwindsurf_api_key = "b"', () => {
    assert.throws(readDevinSession, (error) => {
      assert.equal(error.code, "oauth_unauthorized");
      return true;
    });
  });
});
