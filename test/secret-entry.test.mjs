import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MIN_DOUBLED_SECRET_LENGTH,
  looksDoubledSecret,
  secretEntryFeedback,
  secretEntryProblem,
} from "../src/secret-entry.mjs";

test("secretEntryFeedback reports how many characters were captured", () => {
  assert.equal(secretEntryFeedback("example-key"), "Received 11 characters.");
});

test("secretEntryFeedback counts the trimmed value that will be saved", () => {
  assert.equal(secretEntryFeedback("  example-key  \r"), "Received 11 characters.");
});

test("secretEntryFeedback uses a singular label for one character", () => {
  assert.equal(secretEntryFeedback("k"), "Received 1 character.");
});

test("secretEntryFeedback reports empty input without failing", () => {
  assert.equal(secretEntryFeedback(""), "No characters were received.");
  assert.equal(secretEntryFeedback("   "), "No characters were received.");
  assert.equal(secretEntryFeedback(undefined), "No characters were received.");
});

test("secretEntryFeedback counts characters, not UTF-8 bytes", () => {
  assert.equal(secretEntryFeedback("k€y-¢ode"), "Received 8 characters.");
});

test("looksDoubledSecret detects the same value pasted twice back-to-back", () => {
  assert.equal(looksDoubledSecret("test-key-1234test-key-1234"), true);
});

test("looksDoubledSecret detects a doubled paste separated by whitespace", () => {
  assert.equal(looksDoubledSecret("test-key-1234 test-key-1234"), true);
});

test("looksDoubledSecret trims before checking", () => {
  assert.equal(looksDoubledSecret("  test-key-1234test-key-1234  "), true);
});

test("looksDoubledSecret accepts normal keys", () => {
  assert.equal(looksDoubledSecret("test-key-1234"), false);
  assert.equal(looksDoubledSecret("plan-key-example-value"), false);
  assert.equal(looksDoubledSecret(""), false);
});

test("looksDoubledSecret ignores short repeated fragments", () => {
  assert.equal(looksDoubledSecret("abab"), false);
  assert.equal(looksDoubledSecret("aa"), false);
});

test("looksDoubledSecret requires the halves to match exactly", () => {
  assert.equal(looksDoubledSecret("test-key-1234test-key-9999"), false);
  assert.equal(looksDoubledSecret("test-key-1234_test-key-1234"), false);
});

test("secretEntryProblem flags empty input", () => {
  assert.equal(secretEntryProblem(""), "empty");
  assert.equal(secretEntryProblem("   "), "empty");
  assert.equal(secretEntryProblem(undefined), "empty");
});

test("secretEntryProblem flags doubled input", () => {
  assert.equal(secretEntryProblem("test-key-1234test-key-1234"), "doubled");
});

test("secretEntryProblem accepts a normal key", () => {
  assert.equal(secretEntryProblem("test-key-1234"), undefined);
});

test("MIN_DOUBLED_SECRET_LENGTH is a positive integer", () => {
  assert.ok(
    Number.isInteger(MIN_DOUBLED_SECRET_LENGTH) && MIN_DOUBLED_SECRET_LENGTH > 0,
  );
});
