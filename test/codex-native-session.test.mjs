import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, after } from "node:test";

const home = mkdtempSync(path.join(os.tmpdir(), "native-session-"));
const authPath = path.join(home, "auth.json");
process.env.MODEL_ROUTER_CODEX_AUTH = authPath;
process.env.MODEL_ROUTER_STATE_DIR = path.join(home, "state");
const accountPoolPath = path.join(home, "state", "chatgpt-account-pool.json");
const accountHomesDir = path.join(home, "state", "chatgpt-accounts");
process.env.MODEL_ROUTER_CHATGPT_ACCOUNT_POOL = accountPoolPath;
process.env.MODEL_ROUTER_CHATGPT_ACCOUNT_HOMES = accountHomesDir;
delete process.env.CODEX_ROUTER_NATIVE_SESSION_FALLBACK;

// Every test shares one fixture home; take it down once the file finishes so
// repeated runs do not accumulate temp roots.
after(() => {
  rmSync(home, { recursive: true, force: true });
});

const {
  nativeSessionSharingEnabled,
  nativeSessionAvailable,
  nativeSessionHeaders,
  nativeSubscriptionPoolHeaders,
  nativeSessionStatus,
  setNativeSessionSharingEnabled,
  tokenExpiryMs,
} = await import("../src/codex-native-session.mjs");
const {
  chatGPTSubscriptionAccountAuthPath,
  createChatGPTSubscriptionAccount,
  readChatGPTAccountPoolState,
  writeChatGPTAccountPoolState,
} = await import("../src/chatgpt-account-pool.mjs");
const { NATIVE_SESSION_CONSENT_PATH } = await import("../src/paths.mjs");

const { dshNativeModels } = await import("../src/dsh-catalog.mjs");

const ACCESS = "sk-test-access-token";
const ACCOUNT = "acct-0123456789";

function writeAuth(tokens) {
  writeFileSync(authPath, JSON.stringify({ auth_mode: "chatgpt", tokens }), "utf8");
}

function clearAuth() {
  rmSync(authPath, { force: true });
}

test.beforeEach(() => {
  clearAuth();
  setNativeSessionSharingEnabled(false);
  delete process.env.CODEX_ROUTER_NATIVE_SESSION_FALLBACK;
});

test("no session on disk means no fallback rather than an error", () => {
  clearAuth();
  assert.equal(nativeSessionAvailable(), false);
  assert.equal(nativeSessionHeaders(), undefined);
  assert.equal(nativeSessionStatus().present, false);
});

test("a signed-in session stays private until the user authorizes sharing once", () => {
  writeAuth({ access_token: ACCESS, account_id: ACCOUNT });
  assert.equal(nativeSessionSharingEnabled(), false);
  assert.equal(nativeSessionHeaders(), undefined);
  assert.equal(nativeSessionStatus().usable, true, "login usability is reported independently");

  setNativeSessionSharingEnabled(true);
  assert.equal(nativeSessionSharingEnabled(), true);
  assert.deepEqual(nativeSessionHeaders(), {
    authorization: `Bearer ${ACCESS}`,
    "chatgpt-account-id": ACCOUNT,
  });
  assert.equal(nativeSessionAvailable(), true);
  assert.equal(existsSync(NATIVE_SESSION_CONSENT_PATH), true);
  if (process.platform !== "win32") {
    assert.equal(statSync(NATIVE_SESSION_CONSENT_PATH).mode & 0o777, 0o600);
  }
  assert.doesNotMatch(readFileSync(NATIVE_SESSION_CONSENT_PATH, "utf8"), /access|account/i);
});

test("sharing cannot be enabled before the user signs in", () => {
  assert.throws(
    () => setNativeSessionSharingEnabled(true),
    /run `codex login`/i,
  );
  assert.equal(existsSync(NATIVE_SESSION_CONSENT_PATH), false);
});

test("status reports presence, never the credential", () => {
  writeAuth({ access_token: ACCESS, account_id: ACCOUNT });
  setNativeSessionSharingEnabled(true);
  const status = nativeSessionStatus();
  assert.equal(status.present, true);
  assert.equal(status.usable, true);
  assert.equal(status.hasAccountId, true);
  assert.equal(status.sharingEnabled, true);
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
  setNativeSessionSharingEnabled(true);
  process.env.CODEX_ROUTER_NATIVE_SESSION_FALLBACK = "0";
  try {
    assert.equal(nativeSessionHeaders(), undefined);
    assert.equal(nativeSessionAvailable(), false);
    assert.equal(nativeSessionStatus().fallbackEnabled, false);
  } finally {
    delete process.env.CODEX_ROUTER_NATIVE_SESSION_FALLBACK;
  }
});

test("the environment override is explicit in both directions", () => {
  writeAuth({ access_token: ACCESS, account_id: ACCOUNT });
  process.env.CODEX_ROUTER_NATIVE_SESSION_FALLBACK = "1";
  assert.equal(nativeSessionAvailable(), true);

  process.env.CODEX_ROUTER_NATIVE_SESSION_FALLBACK = "yes";
  assert.equal(nativeSessionAvailable(), false, "an ambiguous value is not consent");
});

test("an unrecognized consent marker fails closed", () => {
  writeAuth({ access_token: ACCESS, account_id: ACCOUNT });
  mkdirSync(path.dirname(NATIVE_SESSION_CONSENT_PATH), { recursive: true });
  writeFileSync(NATIVE_SESSION_CONSENT_PATH, "not json", "utf8");
  assert.equal(nativeSessionAvailable(), false);
  writeFileSync(NATIVE_SESSION_CONSENT_PATH, '{"version":99,"sharing":"enabled"}\n', "utf8");
  assert.equal(nativeSessionAvailable(), false);
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
  const PREFIX = "bearer";
  const bearer = (value) => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    if (trimmed.length <= PREFIX.length) return undefined;
    if (trimmed.slice(0, PREFIX.length).toLowerCase() !== PREFIX) return undefined;
    const separator = trimmed[PREFIX.length];
    if (separator !== " " && separator !== "\t") return undefined;
    const token = trimmed.slice(PREFIX.length + 1).trim();
    return token || undefined;
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

// ChatGPT's own backend accepts a narrower request than the public Responses
// API. Codex complies already; a generic client sends sampling parameters it
// rejects one at a time, each as a bare 400. Measured against the live endpoint,
// not guessed -- these are the exact ten it named.
test("a substituted caller's payload is made acceptable to the native endpoint", () => {
  const UNSUPPORTED = [
    "temperature",
    "top_p",
    "presence_penalty",
    "frequency_penalty",
    "max_tokens",
    "max_output_tokens",
    "metadata",
    "seed",
    "user",
    "truncation",
  ];

  // The transform the router applies, kept in step with router.mjs.
  const normalize = (payload) => {
    payload.store = false;
    for (const key of UNSUPPORTED) delete payload[key];
    return payload;
  };

  const sent = {
    model: "gpt-5.6-luna",
    stream: true,
    input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    // Everything a generic OpenAI client would reasonably include.
    temperature: 0.7,
    top_p: 1,
    max_output_tokens: 100,
    metadata: { a: "b" },
    seed: 1,
    user: "someone",
    truncation: "auto",
    // Accepted upstream, so these must survive.
    reasoning: { effort: "low" },
    tool_choice: "auto",
    parallel_tool_calls: true,
    instructions: "be brief",
  };

  const out = normalize({ ...sent });
  assert.equal(out.store, false, "store must be false or the turn is a 400");
  for (const key of UNSUPPORTED) {
    assert.equal(key in out, false, `${key} is rejected upstream and must be stripped`);
  }
  // Stripping must not become a whitelist that quietly drops what works.
  assert.deepEqual(out.reasoning, { effort: "low" });
  assert.equal(out.tool_choice, "auto");
  assert.equal(out.parallel_tool_calls, true);
  assert.equal(out.instructions, "be brief");
  assert.equal(out.model, "gpt-5.6-luna");
  assert.equal(out.stream, true);
  assert.deepEqual(out.input, sent.input);
});

// The gap that made this "works while you also use Codex" rather than "works":
// the access token has a ten-day life, Codex renews it whenever Codex is used,
// and a harness-only stretch longer than that left the router sending a dead
// token and the user staring at 401s.
const jwtWithExp = (epochSeconds) =>
  `header.${Buffer.from(JSON.stringify({ exp: epochSeconds })).toString("base64url")}.sig`;

test("the expiry claim is read without the token leaving the module", () => {
  const at = Math.floor(Date.now() / 1000) + 3600;
  assert.equal(tokenExpiryMs(jwtWithExp(at)), at * 1000);
  // Anything unreadable is treated as usable: refusing to send a token that
  // might be perfectly good is worse than letting the upstream be the judge.
  assert.equal(tokenExpiryMs("not-a-jwt"), undefined);
  assert.equal(tokenExpiryMs(""), undefined);
  assert.equal(tokenExpiryMs("a.notbase64!.c"), undefined);
});

test("an expired session is withheld rather than spent on a certain 401", () => {
  const seconds = Math.floor(Date.now() / 1000);
  // No Codex to run, so the refresh nudge is a no-op and the behaviour under
  // test is the withholding itself.
  process.env.CODEX_BIN = "/nonexistent/codex";
  try {
    process.env.CODEX_ROUTER_NATIVE_SESSION_FALLBACK = "1";
    writeAuth({ access_token: jwtWithExp(seconds - 3600), account_id: ACCOUNT });
    assert.equal(nativeSessionHeaders(), undefined, "a dead token must not be sent");
    assert.equal(nativeSessionStatus().expired, true);
    assert.equal(nativeSessionStatus().usable, false);

    // Inside the skew: still refused, because a token that dies mid-flight
    // costs the whole turn.
    writeAuth({ access_token: jwtWithExp(seconds + 30), account_id: ACCOUNT });
    assert.equal(nativeSessionHeaders(), undefined);

    writeAuth({ access_token: jwtWithExp(seconds + 172800), account_id: ACCOUNT });
    assert.notEqual(nativeSessionHeaders(), undefined, "a live token must still be sent");
    assert.equal(nativeSessionStatus().usable, true);
    assert.ok(nativeSessionStatus().expiresInHours > 47);
  } finally {
    delete process.env.CODEX_BIN;
    delete process.env.CODEX_ROUTER_NATIVE_SESSION_FALLBACK;
  }
});

test("status reports the remaining life, never the token", () => {
  const seconds = Math.floor(Date.now() / 1000);
  writeAuth({ access_token: jwtWithExp(seconds + 36000), account_id: ACCOUNT });
  setNativeSessionSharingEnabled(true);
  const status = nativeSessionStatus();
  assert.ok(status.expiresInHours > 9 && status.expiresInHours <= 10);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(ACCOUNT));
});

test("a subscription pool is available only through the native Codex override", () => {
  clearAuth();
  const account = createChatGPTSubscriptionAccount({
    label: "Pool account",
    filePath: accountPoolPath,
    homesDir: accountHomesDir,
  });
  const accountAuth = chatGPTSubscriptionAccountAuthPath(account.id, { homesDir: accountHomesDir });
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor((Date.now() + 3_600_000) / 1000) })).toString("base64url");
  writeFileSync(accountAuth, JSON.stringify({ tokens: { access_token: `pool.${payload}.token`, account_id: "pool-account" } }), { mode: 0o600 });
  const state = readChatGPTAccountPoolState(accountPoolPath);
  state.policy.enabled = true;
  writeChatGPTAccountPoolState(state, accountPoolPath);
  assert.equal(nativeSessionSharingEnabled(), false, "primary CODEX_HOME consent remains independent");
  assert.equal(nativeSessionHeaders(), undefined, "the pool is not a shared-session fallback");
  assert.deepEqual(nativeSubscriptionPoolHeaders(), {
    authorization: `Bearer pool.${payload}.token`,
    "chatgpt-account-id": "pool-account",
  });
  assert.equal(nativeSessionAvailable(), false);
  state.policy.enabled = false;
  writeChatGPTAccountPoolState(state, accountPoolPath);
});

test("no-discovery blocks subscription fallback before reading pooled credentials", () => {
  const account = createChatGPTSubscriptionAccount({
    label: "No-discovery account",
    filePath: accountPoolPath,
    homesDir: accountHomesDir,
  });
  const accountAuth = chatGPTSubscriptionAccountAuthPath(account.id, { homesDir: accountHomesDir });
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor((Date.now() + 3_600_000) / 1000) })).toString("base64url");
  writeFileSync(accountAuth, JSON.stringify({ tokens: { access_token: `pool.${payload}.token`, account_id: "pool-account" } }), { mode: 0o600 });
  const state = readChatGPTAccountPoolState(accountPoolPath);
  state.policy.enabled = true;
  writeChatGPTAccountPoolState(state, accountPoolPath);

  process.env.CODEX_ROUTER_NO_DISCOVERY = "1";
  try {
    assert.equal(nativeSubscriptionPoolHeaders(), undefined);
    assert.equal(nativeSessionHeaders(), undefined);
    assert.equal(nativeSessionAvailable(), false);
    assert.equal(nativeSessionStatus().present, false);
  } finally {
    delete process.env.CODEX_ROUTER_NO_DISCOVERY;
    state.policy.enabled = false;
    writeChatGPTAccountPoolState(state, accountPoolPath);
  }
});

test("the bearer parser is linear and rejects the shapes it should", () => {
  const PREFIX = "bearer";
  const bearer = (value) => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    if (trimmed.length <= PREFIX.length) return undefined;
    if (trimmed.slice(0, PREFIX.length).toLowerCase() !== PREFIX) return undefined;
    const separator = trimmed[PREFIX.length];
    if (separator !== " " && separator !== "\t") return undefined;
    const token = trimmed.slice(PREFIX.length + 1).trim();
    return token || undefined;
  };

  assert.equal(bearer("Bearer abc"), "abc");
  assert.equal(bearer("bearer\tabc"), "abc");
  assert.equal(bearer("  Bearer   abc  "), "abc");
  // A scheme with no separator is a different scheme, not a malformed one.
  assert.equal(bearer("BearerX"), undefined);
  assert.equal(bearer("Bearer"), undefined);
  assert.equal(bearer("Bearer    "), undefined);
  assert.equal(bearer("Basic abc"), undefined);

  // The header comes from an unauthenticated caller. The old regex backtracked
  // polynomially on this; parsing has to stay linear.
  const hostile = `Bearer${" ".repeat(50_000)}`;
  const started = process.hrtime.bigint();
  assert.equal(bearer(hostile), undefined);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 250, `parsing took ${elapsedMs.toFixed(1)}ms, which suggests backtracking`);
});

test.after(() => {
  rmSync(home, { recursive: true, force: true });
});
