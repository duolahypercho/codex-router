import assert from "node:assert/strict";
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureFreshGrokOAuthToken } from "../src/grok-oauth-session.mjs";

async function withSession(session, run) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-oauth-session-"));
  const authPath = path.join(directory, "auth.json");
  const writeSession = (value) => writeFileSync(
    authPath,
    JSON.stringify({ "https://auth.x.ai::test-client-id": value }),
    { mode: 0o600 },
  );
  writeSession(session);
  const previous = process.env.GROK_AUTH_PATH;
  process.env.GROK_AUTH_PATH = authPath;
  try {
    return await run(writeSession);
  } finally {
    if (previous === undefined) delete process.env.GROK_AUTH_PATH;
    else process.env.GROK_AUTH_PATH = previous;
    unlinkSync(authPath);
    rmdirSync(directory);
  }
}

test("keeps an active Grok OAuth session without invoking the CLI", async () => {
  await withSession(
    { key: "active-access", expires_at: "2030-01-01T00:00:00Z" },
    async () => {
      let refreshes = 0;
      const token = await ensureFreshGrokOAuthToken({
        now: Date.parse("2029-12-31T23:00:00Z"),
        refresh: async () => { refreshes += 1; },
      });
      assert.equal(token, "active-access");
      assert.equal(refreshes, 0);
    },
  );
});

test("refreshes an expiring Grok OAuth session through the official CLI hook", async () => {
  await withSession(
    { key: "expiring-access", expires_at: "2030-01-01T00:00:00Z" },
    async (writeSession) => {
      let refreshes = 0;
      const token = await ensureFreshGrokOAuthToken({
        now: Date.parse("2029-12-31T23:58:00Z"),
        refresh: async () => {
          refreshes += 1;
          writeSession({ key: "renewed-access", expires_at: "2030-01-02T00:00:00Z" });
        },
      });
      assert.equal(token, "renewed-access");
      assert.equal(refreshes, 1);
    },
  );
});

test("forces one Grok OAuth renewal after an upstream rejection", async () => {
  await withSession(
    { key: "rejected-access", expires_at: "2030-01-02T00:00:00Z" },
    async (writeSession) => {
      const token = await ensureFreshGrokOAuthToken({
        force: true,
        now: Date.parse("2030-01-01T00:00:00Z"),
        refresh: async () => {
          writeSession({ key: "retried-access", expires_at: "2030-01-02T00:00:00Z" });
        },
      });
      assert.equal(token, "retried-access");
    },
  );
});

test("requires login when the official CLI does not renew a rejected session", async () => {
  await withSession(
    { key: "still-rejected", expires_at: "2030-01-02T00:00:00Z" },
    async () => {
      await assert.rejects(
        ensureFreshGrokOAuthToken({
          force: true,
          now: Date.parse("2030-01-01T00:00:00Z"),
          refresh: async () => {},
        }),
        /not renewed/,
      );
    },
  );
});
