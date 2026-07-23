import assert from "node:assert/strict";
import test from "node:test";

import {
  formatErrorForLog,
  httpErrorStatus,
  isAbortError,
} from "../src/http-utils.mjs";

test("isAbortError recognizes AbortError and abort messages", () => {
  const abort = new Error("This operation was aborted");
  abort.name = "AbortError";
  assert.equal(isAbortError(abort), true);

  const coded = new Error("canceled");
  coded.code = "ABORT_ERR";
  assert.equal(isAbortError(coded), true);

  assert.equal(isAbortError(new Error("premature close")), true);
  assert.equal(isAbortError(new Error("upstream 500")), false);
});

test("httpErrorStatus maps aborts to 499 and preserves explicit status", () => {
  const abort = new Error("aborted");
  abort.name = "AbortError";
  assert.equal(httpErrorStatus(abort), 499);

  const typed = new Error("too large");
  typed.status = 413;
  assert.equal(httpErrorStatus(typed), 413);
  assert.equal(httpErrorStatus(new Error("boom")), 502);
});

test("formatErrorForLog redacts caller secrets and includes code", () => {
  const error = new Error(
    "failed http://127.0.0.1:4102/_codex-router/super-secret-token/v1/responses",
  );
  error.name = "TypeError";
  error.code = "ECONNRESET";
  const text = formatErrorForLog(error);
  assert.match(text, /TypeError/);
  assert.match(text, /code=ECONNRESET/);
  assert.match(text, /\[REDACTED\]/);
  assert.doesNotMatch(text, /super-secret-token/);
});
