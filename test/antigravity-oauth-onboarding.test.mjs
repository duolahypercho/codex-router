import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  antigravityCallbackTarget,
  antigravityUserAgent,
  validateAntigravityRedirectUri,
} from "../src/antigravity-oauth-constants.mjs";
import {
  antigravityAuthorizationUrl,
  exchangeAntigravityCode,
  generateAntigravityPkce,
  resolveAntigravityProject,
  signInAntigravity,
} from "../src/antigravity-oauth-onboarding.mjs";

async function reserveLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("generates a PKCE verifier and matching challenge", () => {
  const { verifier, challenge } = generateAntigravityPkce(() =>
    Buffer.alloc(64, 7),
  );
  assert.ok(verifier.length > 40);
  assert.ok(challenge.length > 40);
  assert.notEqual(verifier, challenge);
});

test("builds an authorization URL with PKCE and offline access", () => {
  const { verifier } = generateAntigravityPkce(() => Buffer.alloc(64, 3));
  const url = new URL(antigravityAuthorizationUrl(verifier, "state-123"));
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.equal(url.searchParams.get("state"), "state-123");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("code_challenge"));
});

test("uses the current Antigravity CLI identity on every host platform", () => {
  assert.equal(
    antigravityUserAgent("win32", "x64"),
    "antigravity/cli/1.1.13 (aidev_client; os_type=windows; arch=amd64; cl=964361259; auth_method=consumer)",
  );
  assert.equal(
    antigravityUserAgent("linux", "ia32"),
    "antigravity/cli/1.1.13 (aidev_client; os_type=linux; arch=386; cl=964361259; auth_method=consumer)",
  );
  assert.equal(
    antigravityUserAgent("darwin", "arm64"),
    "antigravity/cli/1.1.13 (aidev_client; os_type=darwin; arch=arm64; cl=964361259; auth_method=consumer)",
  );
});

test("validates and derives the complete loopback callback target", () => {
  assert.throws(
    () => validateAntigravityRedirectUri("https://localhost:51121/oauth-callback"),
    /loopback URL/,
  );
  assert.throws(
    () => validateAntigravityRedirectUri("http://example.com:51121/oauth-callback"),
    /loopback URL/,
  );
  assert.throws(
    () => validateAntigravityRedirectUri("http://localhost:51121/oauth-callback?leak=1"),
    /loopback URL/,
  );
  assert.throws(
    () => validateAntigravityRedirectUri("http://localhost:0/oauth-callback"),
    /loopback URL/,
  );
  assert.deepEqual(
    antigravityCallbackTarget("http://localhost:54321/custom-callback"),
    {
      host: "127.0.0.1",
      port: 54321,
      path: "/custom-callback",
      redirectUri: "http://localhost:54321/custom-callback",
    },
  );
});

test("exchanges an authorization code for tokens", async () => {
  const token = await exchangeAntigravityCode(
    "code",
    "verifier",
    {
      now: () => 1_700_000_000_000,
      fetchImpl: async (url, options) => {
        assert.match(url, /oauth2\.googleapis\.com\/token$/);
        const body = new URLSearchParams(options.body);
        assert.equal(body.get("code"), "code");
        assert.equal(body.get("code_verifier"), "verifier");
        assert.equal(body.get("grant_type"), "authorization_code");
        return new Response(
          JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    },
  );
  assert.equal(token.access_token, "access");
  assert.equal(token.refresh_token, "refresh");
  assert.equal(token.expires_at, 1_700_000_000 + 3600);
});

test("resolves the managed project from loadCodeAssist", async () => {
  const projectId = await resolveAntigravityProject("access", {
    fetchImpl: async (url) =>
      new Response(
        JSON.stringify({ cloudaicompanionProject: "resolved-project" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  });
  assert.equal(projectId, "resolved-project");
});

test("falls back to the default project when discovery fails", async () => {
  const projectId = await resolveAntigravityProject("access", {
    fetchImpl: async () =>
      new Response("{}", { status: 500, headers: { "Content-Type": "application/json" } }),
  });
  assert.equal(projectId, "rising-fact-p41fc");
});

test("ignores a mismatched callback state and completes the original sign-in", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "antigravity-sign-in-"));
  const previousTokenPath = process.env.ANTIGRAVITY_TOKEN_PATH;
  process.env.ANTIGRAVITY_TOKEN_PATH = path.join(directory, "token.json");
  try {
    const port = await reserveLoopbackPort();
    const redirectUri = `http://127.0.0.1:${port}/custom-callback`;
    let openedResolve;
    const opened = new Promise((resolve) => { openedResolve = resolve; });
    const signIn = signInAntigravity({
      redirectUri,
      open: openedResolve,
      projectAttempts: 1,
      projectRetryDelayMs: 0,
      delayImpl: async () => {},
      fetchImpl: async (url) => {
        const value = String(url);
        if (value.includes("oauth2.googleapis.com/token")) {
          return new Response(
            JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (value.includes("userinfo")) {
          return new Response(JSON.stringify({ email: "person@example.test" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (value.includes("loadCodeAssist")) {
          return new Response(JSON.stringify({ cloudaicompanionProject: "managed-project" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        throw new Error(`Unexpected request: ${value}`);
      },
    });

    const authorizationUrl = new URL(await opened);
    const state = authorizationUrl.searchParams.get("state");
    const wrong = await fetch(`${redirectUri}?state=wrong&code=wrong`);
    assert.equal(wrong.status, 400);
    assert.equal(wrong.headers.get("cache-control"), "no-store");
    assert.match(wrong.headers.get("content-security-policy"), /default-src 'none'/);

    const correct = await fetch(`${redirectUri}?state=${encodeURIComponent(state)}&code=code`);
    assert.equal(correct.status, 200);
    const stored = await signIn;
    assert.equal(stored.project_id, "managed-project");
    assert.equal(stored.project_source, "managed");
    assert.equal(stored.email, "person@example.test");
  } finally {
    if (previousTokenPath === undefined) delete process.env.ANTIGRAVITY_TOKEN_PATH;
    else process.env.ANTIGRAVITY_TOKEN_PATH = previousTokenPath;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("guards a valid callback while its token exchange is in progress", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "antigravity-sign-in-"));
  const previousTokenPath = process.env.ANTIGRAVITY_TOKEN_PATH;
  process.env.ANTIGRAVITY_TOKEN_PATH = path.join(directory, "token.json");
  try {
    const port = await reserveLoopbackPort();
    const redirectUri = `http://127.0.0.1:${port}/oauth-callback`;
    let openedResolve;
    const opened = new Promise((resolve) => { openedResolve = resolve; });
    let exchangeStartedResolve;
    const exchangeStarted = new Promise((resolve) => { exchangeStartedResolve = resolve; });
    let releaseExchange;
    const exchangeGate = new Promise((resolve) => { releaseExchange = resolve; });
    const signIn = signInAntigravity({
      redirectUri,
      open: openedResolve,
      timeoutMs: 5_000,
      projectAttempts: 1,
      delayImpl: async () => {},
      fetchImpl: async (url) => {
        const value = String(url);
        if (value.includes("oauth2.googleapis.com/token")) {
          exchangeStartedResolve();
          await exchangeGate;
          return new Response(
            JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (value.includes("userinfo")) {
          return new Response("{}", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ cloudaicompanionProject: "managed" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    const authorizationUrl = new URL(await opened);
    const state = authorizationUrl.searchParams.get("state");
    const callbackUrl = `${redirectUri}?state=${encodeURIComponent(state)}&code=code`;
    const first = fetch(callbackUrl);
    await exchangeStarted;
    const duplicate = await fetch(callbackUrl);
    assert.equal(duplicate.status, 409);
    releaseExchange();
    assert.equal((await first).status, 200);
    assert.equal((await signIn).project_id, "managed");
  } finally {
    if (previousTokenPath === undefined) delete process.env.ANTIGRAVITY_TOKEN_PATH;
    else process.env.ANTIGRAVITY_TOKEN_PATH = previousTokenPath;
    rmSync(directory, { recursive: true, force: true });
  }
});
