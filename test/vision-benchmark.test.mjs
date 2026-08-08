import assert from "node:assert/strict";
import test from "node:test";

import {
  BENCHMARK_GROUND_TRUTH,
  accuracyTier,
  scoreTranscript,
} from "../src/vision-benchmark.mjs";

const everything = Object.values(BENCHMARK_GROUND_TRUTH).flat().join(" ");

test("a perfect transcript scores 100", () => {
  const score = scoreTranscript(everything);
  assert.equal(score.percent, 100);
  assert.equal(accuracyTier(score), "accurate");
});

test("currency and separator formatting does not cost points", () => {
  // A model writing "1155.00" instead of "$1,155.00" read it correctly.
  const score = scoreTranscript("INV-7734-QX 3417.62 1155.00 162.60 2100.02 82.50 27.10 2026-03-14 2026-04-13 RC-2291-BB77 Widget A-12 Cable K-9");
  assert.equal(score.groups.numbers.found, 6);
  assert.equal(score.groups.codes.found, 4);
  assert.equal(score.groups.dates.found, 2);
  assert.equal(accuracyTier(score), "accurate");
});

test("a captioner that names shapes but no text is tiered captions-only", () => {
  // This is the real failure mode: it sounds plausible and contains nothing.
  const score = scoreTranscript("A purple pentagon and a green circle above an invoice table.");
  assert.equal(score.groups.shapes.found, 2);
  assert.equal(score.groups.codes.found, 0);
  assert.equal(accuracyTier(score), "captions-only");
});

test("partial text recovery is tiered between the two", () => {
  const score = scoreTranscript("INV-7734-QX 3,417.62 2026-03-14 RC-2291-BB77 1,155.00");
  assert.equal(accuracyTier(score), "partial");
});

test("the tier ignores shapes and colors, which are not the bridge's job", () => {
  const textOnly = "INV-7734-QX RC-2291-BB77 Widget A-12 Cable K-9 3,417.62 1,155.00 162.60 2,100.02 82.50 27.10 2026-03-14 2026-04-13";
  // No shape or colour words at all, yet every code/number/date is present.
  assert.equal(accuracyTier(scoreTranscript(textOnly)), "accurate");
  assert.ok(scoreTranscript(textOnly).percent < 100);
});
