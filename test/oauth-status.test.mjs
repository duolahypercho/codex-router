import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { kimiOAuthStatus } from "../src/oauth-status.mjs";

function withCredentialsFile(contents, run) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kimi-oauth-"));
  const credentialsPath = path.join(dir, "credentials", "kimi-code.json");
  if (contents !== undefined) {
    mkdirSync(path.dirname(credentialsPath), { recursive: true });
    writeFileSync(credentialsPath, contents, { mode: 0o600 });
  }
  const previous = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = dir;
  try {
    return run(credentialsPath);
  } finally {
    if (previous === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

function futureSeconds() {
  return Math.floor(Date.now() / 1000) + 3600;
}

test("reports configured for a credential with a valid future expiry", () => {
  const status = withCredentialsFile(
    JSON.stringify({
      access_token: "access-value",
      refresh_token: "refresh-value",
      expires_at: futureSeconds(),
      scope: "kimi-code",
    }),
    () => kimiOAuthStatus(),
  );
  assert.equal(status.configured, true);
  assert.equal(status.scope, "kimi-code");
  // No token value must appear anywhere in the status object.
  assert.doesNotMatch(JSON.stringify(status), /access-value|refresh-value/);
});

test("reports not configured when the expiry is already past", () => {
  const status = withCredentialsFile(
    JSON.stringify({
      access_token: "access-value",
      refresh_token: "refresh-value",
      expires_at: futureSeconds() - 7200,
    }),
    () => kimiOAuthStatus(),
  );
  assert.equal(status.configured, false);
  assert.match(status.setup, /expired/);
});

test("reports not configured when the expiry is the epoch garbage value", () => {
  // A broken login flow left 1970-01-22 behind: fields are present, but the
  // expiry is decades past and must not count as a usable session.
  const status = withCredentialsFile(
    JSON.stringify({
      access_token: "access-value",
      refresh_token: "refresh-value",
      expires_at: 1900800,
    }),
    () => kimiOAuthStatus(),
  );
  assert.equal(status.configured, false);
  assert.match(status.setup, /expired/);
});

test("accepts a millisecond-since-epoch expiry", () => {
  const status = withCredentialsFile(
    JSON.stringify({
      access_token: "access-value",
      refresh_token: "refresh-value",
      expires_at: Date.now() + 3600_000,
    }),
    () => kimiOAuthStatus(),
  );
  assert.equal(status.configured, true);
});

test("rejects a non-numeric or zero expiry", () => {
  for (const expires_at of ["not-a-number", 0, -5]) {
    const status = withCredentialsFile(
      JSON.stringify({ access_token: "a", refresh_token: "r", expires_at }),
      () => kimiOAuthStatus(),
    );
    assert.equal(status.configured, false, `expires_at=${expires_at}`);
    assert.match(status.setup, /expired/);
  }
});

test("treats a missing expiry conservatively as configured", () => {
  // Older CLI builds may never write the field; token presence stays the
  // signal those builds trusted, so it must not regress into "incomplete".
  const status = withCredentialsFile(
    JSON.stringify({
      access_token: "access-value",
      refresh_token: "refresh-value",
    }),
    () => kimiOAuthStatus(),
  );
  assert.equal(status.configured, true);
});

test("reports not configured when the credential file is missing", () => {
  const status = withCredentialsFile(undefined, () => kimiOAuthStatus());
  assert.equal(status.configured, false);
  assert.match(status.setup, /kimi login/);
});

test("reports not configured when tokens are incomplete", () => {
  const status = withCredentialsFile(
    JSON.stringify({
      access_token: "access-value",
      expires_at: futureSeconds(),
    }),
    () => kimiOAuthStatus(),
  );
  assert.equal(status.configured, false);
  assert.match(status.setup, /incomplete/);
});

test("reports not configured for an invalid credential file", () => {
  const status = withCredentialsFile("{ not json", () => kimiOAuthStatus());
  assert.equal(status.configured, false);
  assert.match(status.setup, /invalid/);
});
