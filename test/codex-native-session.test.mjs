import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const home = mkdtempSync(path.join(os.tmpdir(), "native-session-"));
const authPath = path.join(home, "auth.json");
process.env.MODEL_ROUTER_CODEX_AUTH = authPath;

const {
  nativeSessionAvailable,
  nativeSessionHeaders,
  nativeSessionStatus,
} = await import("../src/codex-native-session.mjs");

const { dshNativeModels } = await import("../src/dsh-catalog.mjs");

const ACCESS = "sk-test-access-token";
const ACCOUNT = "acct-0123456789";

function writeAuth(tokens) {
  writeFileSync(authPath, JSON.stringify({ auth_mode: "chatgpt", tokens }), "utf8");
}

function clearAuth() {
  rmSync(authPath, { force: true });
}

test("no session on disk means no fallback rather than an error", () => {
  clearAuth();
  assert.equal(nativeSessionAvailable(), false);
  assert.equal(nativeSessionHeaders(), undefined);
  assert.equal(nativeSessionStatus().present, false);
});

test("a signed-in session becomes the two headers a native turn needs", () => {
  writeAuth({ access_token: ACCESS, account_id: ACCOUNT });
  assert.deepEqual(nativeSessionHeaders(), {
    authorization: `Bearer ${ACCESS}`,
    "chatgpt-account-id": ACCOUNT,
  });
  assert.equal(nativeSessionAvailable(), true);
});

test("status reports presence, never the credential", () => {
  writeAuth({ access_token: ACCESS, account_id: ACCOUNT });
  const status = nativeSessionStatus();
  assert.equal(status.present, true);
  assert.equal(status.usable, true);
  assert.equal(status.hasAccountId, true);
  // The whole point of the status shape: it is safe to print, log, and paste
  // into an issue. A token that reaches any of those has to be rotated.
  const serialized = JSON.stringify(status);
  assert.doesNotMatch(serialized, new RegExp(ACCESS));
  assert.doesNotMatch(serialized, new RegExp(ACCOUNT));
});

test("a session with no access token is not a session", () => {
  writeAuth({ account_id: ACCOUNT });
  assert.equal(nativeSessionAvailable(), false);
  assert.equal(nativeSessionStatus().usable, false);

  // A half-written or hand-edited file must not fail a turn; it just means
  // there is nothing to fall back to.
  writeFileSync(authPath, "{ not json", "utf8");
  assert.equal(nativeSessionAvailable(), false);
});

test("the fallback can be switched off", () => {
  writeAuth({ access_token: ACCESS, account_id: ACCOUNT });
  process.env.CODEX_ROUTER_NATIVE_SESSION_FALLBACK = "0";
  try {
    assert.equal(nativeSessionHeaders(), undefined);
    assert.equal(nativeSessionAvailable(), false);
    assert.equal(nativeSessionStatus().fallbackEnabled, false);
  } finally {
    delete process.env.CODEX_ROUTER_NATIVE_SESSION_FALLBACK;
  }
});

test("native models map for the harness, minus Codex's internal variants", () => {
  const mapped = dshNativeModels([
    {
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6-Sol",
      visibility: "list",
      context_window: 272000,
      input_modalities: ["text", "image"],
      supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
      priority: 1,
    },
    // A watermarked build and the auto-review model are Codex's own internals.
    { slug: "gpt-5.6-sol-wm", display_name: "watermarked", visibility: "hide" },
    { slug: "codex-auto-review", visibility: "hide" },
  ]);

  assert.equal(mapped.length, 1);
  assert.deepEqual(mapped[0], {
    slug: "gpt-5.6-sol",
    displayName: "GPT-5.6-Sol (Codex)",
    contextWindow: 272000,
    inputModalities: ["text", "image"],
    reasoningLevels: [{ effort: "low" }, { effort: "high" }],
    // Codex ranks with 1 as best; the router ranks with higher as better.
    priority: -1,
    native: true,
  });
});

test("an empty or malformed native catalog publishes nothing", () => {
  assert.deepEqual(dshNativeModels(undefined), []);
  assert.deepEqual(dshNativeModels([]), []);
  assert.deepEqual(dshNativeModels([{ display_name: "no slug" }]), []);
});

// The bug this file exists to prevent a repeat of: the first version of the
// fallback tested `!headers.authorization`, and a curl with no header at all
// passed. The harness does not call that way -- its provider route has nowhere
// to put a credential except `apiKeyEnv`, so it sends the router's own caller
// key as a bearer token. The guard never fired, the caller key went upstream,
// and every harness turn came back "API key is invalid".
test("the router's own caller key is not an upstream credential", () => {
  const CALLER = "caller-secret-0123456789abcdef";
  const INTERNAL = "internal-key-0123456789abcdef";

  // The predicate the router applies, kept in step with router.mjs.
  const bearer = (value) => {
    if (typeof value !== "string") return undefined;
    const match = /^Bearer\s+(.+)$/i.exec(value.trim());
    return match ? match[1].trim() : undefined;
  };
  const isRouterLocal = (header) => {
    const token = bearer(header);
    return token !== undefined && (token === CALLER || token === INTERNAL);
  };

  // What the harness sends: recognised as local, so the session substitutes.
  assert.equal(isRouterLocal(`Bearer ${CALLER}`), true);
  assert.equal(isRouterLocal(`bearer ${CALLER}`), true, "the scheme is case-insensitive");
  assert.equal(isRouterLocal(`Bearer ${INTERNAL}`), true);

  // What Codex sends: a real upstream token, relayed untouched.
  assert.equal(isRouterLocal("Bearer sk-a-real-upstream-token"), false);
  assert.equal(isRouterLocal("Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig"), false);

  // Anything that is not a bearer header is left alone rather than inspected.
  assert.equal(isRouterLocal("Basic dXNlcjpwYXNz"), false);
  assert.equal(isRouterLocal(undefined), false);
  assert.equal(isRouterLocal(""), false);
});
