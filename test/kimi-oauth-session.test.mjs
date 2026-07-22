import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function writeToken(credentialsPath, value) {
  writeFileSync(credentialsPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function token(accessToken, refreshToken, expiresAt) {
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: expiresAt,
    expires_in: 3600,
    scope: "kimi-code",
    token_type: "Bearer",
  };
}

test("Kimi OAuth refresh coordinates with the official CLI and handles terminal state", async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), "kimi-oauth-session-"));
  const credentialsDirectory = path.join(home, "credentials");
  const oauthDirectory = path.join(home, "oauth");
  const credentialsPath = path.join(credentialsDirectory, "kimi-code.json");
  const devicePath = path.join(home, "device_id");
  const lockTarget = path.join(oauthDirectory, "kimi-code");
  const lockDirectory = `${lockTarget}.lock`;
  mkdirSync(credentialsDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(devicePath, "test-device-id\n", { mode: 0o600 });

  const responses = [];
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(Buffer.concat(chunks).toString("utf8"));
    const next = responses.shift();
    if (!next) {
      response.writeHead(500);
      response.end();
      return;
    }
    await next.wait;
    response.writeHead(next.status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(next.body));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const previousHome = process.env.KIMI_CODE_HOME;
  const previousHost = process.env.KIMI_CODE_OAUTH_HOST;
  process.env.KIMI_CODE_HOME = home;
  process.env.KIMI_CODE_OAUTH_HOST = `http://127.0.0.1:${server.address().port}`;

  try {
    const { ensureFreshKimiOAuthToken } = await import(
      `../src/kimi-oauth-session.mjs?test=${Date.now()}`
    );

    await t.test("uses the official Kimi lock convention and rotates credentials", async () => {
      writeToken(credentialsPath, token("old-access", "old-refresh", Math.floor(Date.now() / 1000) + 120));
      responses.push({
        status: 200,
        body: {
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
          scope: "kimi-code",
          token_type: "Bearer",
        },
      });

      assert.equal(await ensureFreshKimiOAuthToken(), "new-access");
      const saved = JSON.parse(readFileSync(credentialsPath, "utf8"));
      assert.equal(saved.access_token, "new-access");
      assert.equal(saved.refresh_token, "new-refresh");
      assert.equal(existsSync(lockTarget), true);
      assert.equal(existsSync(lockDirectory), false);
      assert.match(requests.at(-1), /grant_type=refresh_token/);
      assert.match(requests.at(-1), /refresh_token=old-refresh/);
    });

    await t.test("keeps a hard-valid token, then gives forced recovery its own refresh", async () => {
      writeToken(credentialsPath, token("rejected-access", "retry-refresh", Math.floor(Date.now() / 1000) + 120));
      let markFirstRequest;
      let releaseFirstRequest;
      const firstRequest = new Promise((resolve) => { markFirstRequest = resolve; });
      const firstRelease = new Promise((resolve) => { releaseFirstRequest = resolve; });
      responses.push(
        { status: 503, body: { error: "temporarily_unavailable" }, wait: firstRelease },
        { status: 503, body: { error: "temporarily_unavailable" } },
        { status: 503, body: { error: "temporarily_unavailable" } },
        {
          status: 200,
          body: {
            access_token: "forced-access",
            refresh_token: "forced-refresh",
            expires_in: 3600,
          },
        },
      );
      const requestCount = requests.length;
      const early = ensureFreshKimiOAuthToken();
      const requestPoll = setInterval(() => {
        if (requests.length > requestCount) markFirstRequest();
      }, 5);
      await firstRequest;
      clearInterval(requestPoll);
      const forced = ensureFreshKimiOAuthToken({ force: true });
      releaseFirstRequest();

      assert.equal(await early, "rejected-access");
      assert.equal(await forced, "forced-access");
      assert.equal(requests.length, requestCount + 4);
    });

    await t.test("tombstones a rejected refresh token and stops retrying it", async () => {
      writeToken(credentialsPath, token("dead-access", "dead-refresh", Math.floor(Date.now() / 1000) + 3600));
      responses.push({
        status: 401,
        body: { error: "invalid_grant", error_description: "refresh token revoked" },
      });
      await assert.rejects(
        ensureFreshKimiOAuthToken({ force: true }),
        (error) => error?.status === 401 && error?.code === "oauth_unauthorized",
      );
      const afterRejection = requests.length;
      const saved = JSON.parse(readFileSync(credentialsPath, "utf8"));
      assert.equal(saved.access_token, "");
      assert.equal(saved.refresh_token, "");
      assert.equal(saved.expires_at, 0);

      await assert.rejects(
        ensureFreshKimiOAuthToken(),
        (error) => error?.status === 401 && /login/.test(error.message),
      );
      assert.equal(requests.length, afterRejection);
    });
  } finally {
    if (previousHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previousHome;
    if (previousHost === undefined) delete process.env.KIMI_CODE_OAUTH_HOST;
    else process.env.KIMI_CODE_OAUTH_HOST = previousHost;
    await new Promise((resolve) => server.close(resolve));
    if (existsSync(lockDirectory)) rmdirSync(lockDirectory);
    if (existsSync(lockTarget)) unlinkSync(lockTarget);
    if (existsSync(credentialsPath)) unlinkSync(credentialsPath);
    if (existsSync(devicePath)) unlinkSync(devicePath);
    if (existsSync(oauthDirectory)) rmdirSync(oauthDirectory);
    rmdirSync(credentialsDirectory);
    rmdirSync(home);
  }
});
