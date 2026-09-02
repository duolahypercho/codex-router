import assert from "node:assert/strict";
import test from "node:test";

import { antigravityBootstrapFailure } from "../src/antigravity-project.mjs";

const PROJECT_NUMBER = "123456789012";

// The exact shape Google returns for a private API the caller's project is not
// allowlisted for, reproduced from issue #566.
function serviceDisabledBody(service = "cloudcode-pa.googleapis.com") {
  return JSON.stringify({
    error: {
      code: 403,
      status: "PERMISSION_DENIED",
      message:
        `Cloud Code Private API has not been used in project ${PROJECT_NUMBER} before ` +
        "or it is disabled. Enable it by visiting " +
        `https://console.developers.google.com/apis/api/${service}/overview?project=${PROJECT_NUMBER}` +
        " then retry.",
      details: [{ reason: "SERVICE_DISABLED", metadata: { service } }],
    },
  });
}

test("a disabled private API is named as an allowlist problem, not a credential one", () => {
  const message = antigravityBootstrapFailure(403, serviceDisabledBody());
  assert.match(message, /HTTP 403/);
  assert.match(message, /not allowlisted/);
  assert.match(message, /cloudcode-pa\.googleapis\.com/);
  assert.match(message, /private Google API that an ordinary project cannot enable/);
  // Sign-in works; saying otherwise sends the operator back through a flow
  // that is not broken.
  assert.match(message, /sign-in succeeded/);
});

test("the operator's project number and console URL never reach the message", () => {
  // The free-text message embeds both, and this string is printed and logged.
  const message = antigravityBootstrapFailure(403, serviceDisabledBody());
  assert.doesNotMatch(message, new RegExp(PROJECT_NUMBER));
  assert.doesNotMatch(message, /console\.developers\.google\.com/);
  assert.doesNotMatch(message, /https?:\/\//);
});

test("another disabled service is reported without the allowlist explanation", () => {
  // The explanation is true of the private API specifically; an ordinary
  // service really can be enabled, and claiming otherwise would misdirect.
  const message = antigravityBootstrapFailure(403, serviceDisabledBody("translate.googleapis.com"));
  assert.match(message, /HTTP 403/);
  assert.match(message, /PERMISSION_DENIED/);
  assert.match(message, /SERVICE_DISABLED/);
  assert.match(message, /translate\.googleapis\.com/);
  assert.doesNotMatch(message, /cannot enable/);
});

test("a structured error without SERVICE_DISABLED still surfaces its status", () => {
  const body = JSON.stringify({
    error: { code: 401, status: "UNAUTHENTICATED", message: "Invalid credentials." },
  });
  const message = antigravityBootstrapFailure(401, body);
  assert.match(message, /HTTP 401/);
  assert.match(message, /UNAUTHENTICATED/);
});

test("a body that is absent, empty, malformed, or not an error object degrades to the bare status", () => {
  for (const body of [
    undefined,
    "",
    "<html>502 Bad Gateway</html>",
    "{ not json",
    JSON.stringify({ ok: true }),
    JSON.stringify({ error: "a string, not an object" }),
    JSON.stringify({ error: { details: "not an array" } }),
  ]) {
    assert.equal(antigravityBootstrapFailure(403, body), "HTTP 403", JSON.stringify(body));
  }
});

test("an oversized body cannot make the parser do unbounded work", () => {
  const padded = `{"error":{"status":"X","details":[]},"pad":"${"a".repeat(64 * 1024)}"}`;
  // Truncation makes it unparseable, which degrades to the bare status rather
  // than parsing megabytes of an untrusted response.
  assert.equal(antigravityBootstrapFailure(403, padded), "HTTP 403");
});
