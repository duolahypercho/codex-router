import assert from "node:assert/strict";
import test from "node:test";

import {
  GEMINI_ENV_BEGIN,
  GEMINI_ENV_END,
  GEMINI_MANAGED_KEYS,
  conflictingAssignments,
  removeGeminiEnvBlock,
  spliceGeminiEnvBlock,
} from "../src/gemini-env.mjs";

const VALUES = {
  GOOGLE_GEMINI_BASE_URL: "http://127.0.0.1:4202/_codex-router/secret/gemini",
  GEMINI_API_KEY: "secret",
  GEMINI_MODEL: "vendor/model",
};

test("the managed keys are exactly the three the integration needs", () => {
  assert.deepEqual([...GEMINI_MANAGED_KEYS], [
    "GOOGLE_GEMINI_BASE_URL",
    "GEMINI_API_KEY",
    "GEMINI_MODEL",
  ]);
});

test("an empty document gains only the managed block", () => {
  const written = spliceGeminiEnvBlock("", VALUES);
  assert.equal(
    written,
    [
      GEMINI_ENV_BEGIN,
      "GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:4202/_codex-router/secret/gemini",
      "GEMINI_API_KEY=secret",
      "GEMINI_MODEL=vendor/model",
      GEMINI_ENV_END,
      "",
    ].join("\n"),
  );
});

test("publishing twice is byte-identical", () => {
  const once = spliceGeminiEnvBlock("", VALUES);
  assert.equal(spliceGeminiEnvBlock(once, VALUES), once);
});

test("everything that is not ours survives a publish untouched", () => {
  // A `.env` in the user's home is theirs. Comments, blank lines and unrelated
  // assignments are somebody's work and are not the router's to reflow.
  const original = [
    "# my own notes",
    "",
    "SOME_OTHER_TOOL=1",
    "  SPACED = value  ",
    "",
    "# trailing note",
    "",
  ].join("\n");
  const written = spliceGeminiEnvBlock(original, VALUES);
  assert.ok(written.startsWith(original));
  assert.ok(written.includes(GEMINI_ENV_BEGIN));
  assert.equal(removeGeminiEnvBlock(written), original);
});

test("removing the block restores the document exactly", () => {
  const original = ["A=1", "", "# note", "B=2", ""].join("\n");
  const written = spliceGeminiEnvBlock(original, VALUES);
  assert.equal(removeGeminiEnvBlock(written), original);
});

test("removing a block that was never written changes nothing", () => {
  const original = "A=1\n";
  assert.equal(removeGeminiEnvBlock(original), original);
});

test("an updated block replaces in place rather than appending a second one", () => {
  const original = ["A=1", "", "# note", ""].join("\n");
  const first = spliceGeminiEnvBlock(original, VALUES);
  const second = spliceGeminiEnvBlock(first, { ...VALUES, GEMINI_MODEL: "other/model" });
  assert.equal(second.match(/# BEGIN codex-router-gemini/g).length, 1);
  assert.ok(second.includes("GEMINI_MODEL=other/model"));
  assert.ok(!second.includes("GEMINI_MODEL=vendor/model"));
  assert.equal(removeGeminiEnvBlock(second), original);
});

test("a key we omit is absent from the block rather than written empty", () => {
  // The default model is opt-out. Writing `GEMINI_MODEL=` would out-rank the
  // user's own settings.json choice with an empty string.
  const written = spliceGeminiEnvBlock("", { ...VALUES, GEMINI_MODEL: undefined });
  assert.ok(!written.includes("GEMINI_MODEL"));
  assert.ok(written.includes("GEMINI_API_KEY=secret"));
});

test("a managed key assigned outside our block is reported, not overwritten", () => {
  // dotenv lets the last assignment in a file win, so a duplicate below our
  // block silently decides the base URL. Refusing and naming the line costs a
  // command; guessing rewrites a file whose only copy is on the user's disk.
  const document = ["# mine", "GEMINI_API_KEY=my-real-google-key", ""].join("\n");
  assert.deepEqual(conflictingAssignments(document), [
    { key: "GEMINI_API_KEY", line: 2 },
  ]);
});

test("assignments inside our own block are not conflicts", () => {
  const written = spliceGeminiEnvBlock("", VALUES);
  assert.deepEqual(conflictingAssignments(written), []);
});

test("`export KEY=` and leading whitespace are recognized as assignments", () => {
  const document = ["export GOOGLE_GEMINI_BASE_URL=https://example", "   GEMINI_MODEL=x"].join(
    "\n",
  );
  assert.deepEqual(conflictingAssignments(document), [
    { key: "GOOGLE_GEMINI_BASE_URL", line: 1 },
    { key: "GEMINI_MODEL", line: 2 },
  ]);
});

test("a commented-out assignment is not a conflict", () => {
  assert.deepEqual(conflictingAssignments("# GEMINI_API_KEY=old\n"), []);
});

test("a value that needs quoting gets it", () => {
  const written = spliceGeminiEnvBlock("", {
    ...VALUES,
    GEMINI_MODEL: "vendor/model with space",
  });
  assert.ok(written.includes('GEMINI_MODEL="vendor/model with space"'));
});

test("a document missing its end marker is refused rather than half-edited", () => {
  const broken = ["A=1", GEMINI_ENV_BEGIN, "GEMINI_API_KEY=x", ""].join("\n");
  assert.throws(() => spliceGeminiEnvBlock(broken, VALUES), /end marker/i);
  assert.throws(() => removeGeminiEnvBlock(broken), /end marker/i);
});

test("a document with two begin markers is refused", () => {
  const broken = [GEMINI_ENV_BEGIN, GEMINI_ENV_END, GEMINI_ENV_BEGIN, GEMINI_ENV_END, ""].join(
    "\n",
  );
  assert.throws(() => spliceGeminiEnvBlock(broken, VALUES), /more than once/i);
});

test("CRLF documents keep their line endings", () => {
  const original = "A=1\r\n# note\r\n";
  const written = spliceGeminiEnvBlock(original, VALUES);
  assert.ok(written.includes("\r\n"));
  assert.ok(!/[^\r]\n/.test(written));
  assert.equal(removeGeminiEnvBlock(written), original);
});
