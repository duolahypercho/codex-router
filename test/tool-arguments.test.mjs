import assert from "node:assert/strict";
import test from "node:test";

import { coerceFunctionCallArguments } from "../src/tool-arguments.mjs";

test("coerceFunctionCallArguments rewrites a complete JSON string only when needed", () => {
  const original = '{"command":"git status","timeout_ms":20000.0}';
  const rewritten = coerceFunctionCallArguments(original);
  assert.equal(rewritten, '{"command":"git status","timeout_ms":20000}');
  assert.ok(!rewritten.includes("20000.0"));
  assert.deepEqual(JSON.parse(rewritten), { command: "git status", timeout_ms: 20000 });
  assert.equal(Number.isInteger(JSON.parse(rewritten).timeout_ms), true);

  const alreadyInt = '{"timeout_ms":20000}';
  assert.equal(coerceFunctionCallArguments(alreadyInt), alreadyInt);

  const invalid = "{not json";
  assert.equal(coerceFunctionCallArguments(invalid), invalid);

  const fraction = '{"x":3.14}';
  assert.equal(coerceFunctionCallArguments(fraction), fraction);

  const quoted = '{"label":"20000.0","timeout_ms":2.0e4}';
  assert.equal(coerceFunctionCallArguments(quoted), '{"label":"20000.0","timeout_ms":20000}');
});

test("coerceFunctionCallArguments ignores non-strings", () => {
  assert.equal(coerceFunctionCallArguments(undefined), undefined);
  assert.deepEqual(coerceFunctionCallArguments({ timeout_ms: 1.0 }), { timeout_ms: 1.0 });
});

test("trailing .0 is dropped even past MAX_SAFE_INTEGER", () => {
  assert.equal(
    coerceFunctionCallArguments('{"n":9007199254740993.0}'),
    '{"n":9007199254740993}',
  );
  assert.equal(
    coerceFunctionCallArguments('{"n":9007199254740992.0}'),
    '{"n":9007199254740992}',
  );
});

test("fractions that JS Number would round are left alone", () => {
  assert.equal(coerceFunctionCallArguments('{"n":1e-324}'), '{"n":1e-324}');
  assert.equal(
    coerceFunctionCallArguments('{"n":9007199254740991.4}'),
    '{"n":9007199254740991.4}',
  );
});

test("whole scientific and extra-zero decimals become plain integers", () => {
  assert.equal(coerceFunctionCallArguments('{"n":20000.00}'), '{"n":20000}');
  assert.equal(coerceFunctionCallArguments('{"n":2e4}'), '{"n":20000}');
  assert.equal(coerceFunctionCallArguments('{"n":-0.0}'), '{"n":0}');
});
