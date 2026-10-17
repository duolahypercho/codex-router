import assert from "node:assert/strict";
import test from "node:test";
import { grokToolSchema } from "../src/grok-tool-schema.mjs";
import { CODEX_APP_TOOLS } from "../src/codex-app-tools.mjs";

const branch = (mode, extra = {}) => ({ type: "object", properties: { mode: { const: mode }, id: { type: "string" }, ...extra }, required: ["mode", "id"], additionalProperties: false });

test("literal normalization precedes every root-union preservation or expansion decision", () => {
  const malformed = branch("update", { id: { type: "string", enum: [true], const: false } });
  const normalized = branch("update", { id: { type: "string" } });
  const cases = [
    [malformed, normalized],
    [{ oneOf: [malformed] }, { oneOf: [normalized] }],
    [{ anyOf: [malformed], $anchor: "keep" }, { anyOf: [normalized], $anchor: "keep" }],
    [{ allOf: [malformed] }, { allOf: [normalized] }],
    [{ $schema: "https://example.test/dialect", oneOf: [malformed] },
      { $schema: "https://example.test/dialect", oneOf: [normalized] }],
    [{ $ref: "#/$defs/update", oneOf: [malformed], $defs: { update: malformed } },
      { $ref: "#/$defs/update", oneOf: [normalized], $defs: { update: normalized } }],
    [{ oneOf: [branch("view"), { oneOf: [{ $ref: "#/$defs/update" }] }], $defs: { update: malformed } },
      { oneOf: [branch("view"), normalized], $defs: { update: normalized } }],
  ];
  for (const [schema, expected] of cases) {
    const before = structuredClone(schema);
    const adapted = grokToolSchema(schema);
    assert.deepEqual(adapted, expected);
    assert.deepEqual(schema, before, "normalization never mutates client input");
    assert.equal(grokToolSchema(adapted), adapted, "normalized output is stable");
  }
});

test("invalid discriminator literals cannot prove exclusivity before normalization", () => {
  const invalid = branch(true);
  invalid.properties.mode.type = "string";
  const schema = { oneOf: [branch("view"), { oneOf: [invalid, branch("update")] }] };
  const adapted = grokToolSchema(schema);
  assert.equal(adapted.oneOf.length, 2, "removed discriminator leaves exclusivity unproven");
  assert.deepEqual(adapted.oneOf[1].oneOf[0].properties.mode, { type: "string" });
  assert.equal(schema.oneOf[1].oneOf[0].properties.mode.const, true);
});

test("Grok keeps every automation operation and its original required fields", () => {
  const schema = CODEX_APP_TOOLS.find((tool) => tool.name === "codex_app").tools.find((tool) => tool.name === "automation_update").inputSchema;
  const original = JSON.stringify(schema);
  const adapted = grokToolSchema(schema);
  assert.notEqual(adapted, schema);
  assert.equal(adapted.oneOf.length, 6);
  assert.equal(adapted.$defs, schema.$defs);
  assert.deepEqual(adapted.oneOf, [schema.oneOf[0], schema.$defs.__schema2, schema.$defs.__schema15,
    ...schema.oneOf[2].oneOf, schema.oneOf[3]]);
  assert.ok(adapted.oneOf.every((item) => item.type === "object" && item.required.length && item.additionalProperties === false));
  assert.equal(JSON.stringify(schema), original, "client schema remains untouched");
  assert.equal(grokToolSchema(adapted), adapted, "last provider hop cannot collapse the union again");
});

test("Grok keeps existing object schemas and flat alternatives by identity", () => {
  for (const schema of [branch("view"), { oneOf: [branch("view"), branch("update")] }]) {
    assert.equal(grokToolSchema(schema), schema);
  }
});

test("nested exclusive alternatives flatten only with a proof of disjoint required discriminators", () => {
  const a = branch("view"), b = branch("create"), c = branch("update");
  const schema = { oneOf: [a, { oneOf: [b, c] }] };
  assert.deepEqual(grokToolSchema(schema), { oneOf: [a, b, c] });
  for (const unsafe of [
    { oneOf: [a, { oneOf: [a, c] }] },
    { oneOf: [a, { oneOf: [{ ...b, required: ["id"] }, c] }] },
    { oneOf: [a, { oneOf: [b, c], required: ["extra"] }] },
  ]) assert.equal(grokToolSchema(unsafe), unsafe, "do not weaken unprovable exclusivity or branch constraints");
});

test("nested anyOf is associative even when leaf alternatives overlap", () => {
  const a = branch("view"), b = branch("update");
  const schema = { anyOf: [a, { anyOf: [a, b] }] };
  assert.deepEqual(grokToolSchema(schema), { anyOf: [a, a, b] });
});

test("local definition references keep escaped pointers and literal data unchanged", () => {
  const a = branch("view"), b = branch("update", { literal: { const: { $ref: "#/oneOf/0", $id: "literal" } } });
  const schema = { oneOf: [a, { oneOf: [{ $ref: "#/%24defs/a~1b~0c" }] }], $defs: { "a/b~c": b } };
  const adapted = grokToolSchema(schema);
  assert.deepEqual(adapted.oneOf, [a, b]);
  assert.equal(adapted.$defs, schema.$defs);
  assert.equal(adapted.oneOf[1].properties.literal, b.properties.literal);
});

test("unsafe pointer/resource moves are left intact instead of rebased heuristically", () => {
  for (const variant of [
    { $ref: "#/oneOf/0" }, { $ref: "#" }, { $ref: "#anchor" }, { $dynamicRef: "#node" },
    { $anchor: "name" }, { $id: "nested.json" }, { $schema: "http://json-schema.org/draft-07/schema#" },
  ]) {
    const schema = { oneOf: [branch("view"), { oneOf: [{ $ref: "#/$defs/update" }] }],
      $defs: { update: branch("update", { resource: variant }) } };
    assert.equal(grokToolSchema(schema), schema);
  }
});

test("cyclic and unresolved root references never expand or erase the definition", () => {
  for (const ref of ["#/$defs/loop", "#/$defs/missing", "https://example.test/schema"]) {
    const schema = { oneOf: [branch("view"), { $ref: ref }], $defs: { loop: { $ref: "#/$defs/loop" } } };
    assert.equal(grokToolSchema(schema), schema);
  }
});

test("Draft07 ref sibling const is not a disjointness proof", () => {
  const left = branch("same");
  const right = branch("other");
  right.properties.mode = { $ref: "#/$defs/mode", const: "other" };
  const schema = { $schema: "http://json-schema.org/draft-07/schema#", oneOf: [left, { oneOf: [right] }], $defs: { mode: { const: "same" } } };
  assert.equal(grokToolSchema(schema), schema);
});


test("Draft07 ref siblings cannot invent disjoint object leaf branches", () => {
  const same = branch("a");
  const schema = { $schema: "http://json-schema.org/draft-07/schema#", definitions: { same },
    oneOf: [same, { oneOf: [
      { $ref: "#/definitions/same", ...branch("b") },
      { $ref: "#/definitions/same", ...branch("c") },
    ] }] };
  assert.equal(grokToolSchema(schema), schema);
});


test("Draft04 and unknown dialects cannot use const as an exclusivity proof", () => {
  for (const dialect of ["http://json-schema.org/draft-04/schema#", "https://example.test/custom-dialect"]) {
    const schema = { $schema: dialect, oneOf: [branch("a"), { oneOf: [branch("b"), branch("c")] }] };
    assert.equal(grokToolSchema(schema), schema);
  }
});

test("JSON Schema equality treats negative zero as zero, including nested discriminator literals", () => {
  for (const literal of [(n) => n, (n) => ({ values: [n] })]) {
    const leaf = (a, b) => ({ type: "object", required: ["a", "b"], properties: { a: { const: literal(a) }, b: { const: literal(b) } } });
    const schema = { oneOf: [leaf(-0, -0), { oneOf: [leaf(0, -0), leaf(0, 0)] }] };
    assert.equal(grokToolSchema(schema), schema);
  }
});
