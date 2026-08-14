import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  authenticatedRoute,
  callerBaseUrl,
  panelPath,
  panelUrl,
  redactCallerUrl,
} from "../src/caller-auth.mjs";
import { isPanelRoute } from "../src/desktop-panel.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CALLER_KEY = "test-caller-auth-capability-with-sufficient-length";

test("the panel URL is a route the router actually serves", () => {
  const url = panelUrl(4202, CALLER_KEY);
  assert.equal(url, `http://127.0.0.1:4202/_codex-router/${CALLER_KEY}/panel/`);

  // The whole point of the command: what it hands the browser has to survive
  // the capability check and then match a panel route. Asserting the string
  // alone would pass while the router answered 401 or 404.
  const route = authenticatedRoute(new URL(url).pathname, CALLER_KEY);
  assert.equal(route, "/panel/");
  assert.equal(isPanelRoute(route), true);
});

test("a panel URL is refused the same way an API URL is", () => {
  assert.throws(() => panelPath("too-short"), /caller key/i);
  assert.equal(
    authenticatedRoute(
      "/_codex-router/wrong-caller-capability-with-sufficient-length/panel/",
      CALLER_KEY,
    ),
    undefined,
  );
});

// Redaction is what keeps the caller key out of support bundles, doctor output
// and error messages. It matched only `/v1`, so the panel URL -- the same
// secret in the same position -- travelled through all of them verbatim.
test("redaction covers every leaf the capability guards", () => {
  assert.equal(
    redactCallerUrl(panelUrl(4202, CALLER_KEY)),
    "http://127.0.0.1:4202/_codex-router/[REDACTED]/panel/",
  );
  assert.equal(
    redactCallerUrl(callerBaseUrl(4202, CALLER_KEY)),
    "http://127.0.0.1:4202/_codex-router/[REDACTED]/v1",
  );
  for (const value of [
    panelUrl(4202, CALLER_KEY),
    callerBaseUrl(4202, CALLER_KEY),
    `POST ${panelUrl(4202, CALLER_KEY)}invoke failed`,
  ]) {
    assert.equal(
      redactCallerUrl(value).includes(CALLER_KEY),
      false,
      `the caller key survived redaction in: ${value.replace(CALLER_KEY, "…")}`,
    );
  }
});

test("both entry points expose the command", () => {
  const posix = readFileSync(path.join(root, "bin", "panel"), "utf8");
  assert.match(posix, /src\/panel\.mjs/);
  // Asserted against .gitattributes rather than the bytes on disk: a Windows
  // checkout with core.autocrlf=true rewrites the working copy, so reading it
  // would test the machine running the suite instead of what the repository
  // guarantees every checkout receives.
  assert.match(
    readFileSync(path.join(root, ".gitattributes"), "utf8"),
    /^bin\/\* text eol=lf$/m,
    "bin/ holds extensionless POSIX shell scripts and must be pinned to LF",
  );

  const dispatcher = readFileSync(path.join(root, "bin", "model-router"), "utf8");
  assert.match(dispatcher, /\|panel\|/, "model-router must dispatch panel");

  const windows = readFileSync(path.join(root, "codex-router.ps1"), "utf8");
  assert.match(windows, /"panel"/, "codex-router.ps1 must list panel");
  assert.match(windows, /src\\panel\.mjs/);
});
