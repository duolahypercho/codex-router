import assert from "node:assert/strict";
import test from "node:test";
import { createGrokToolAlternatives } from "../src/grok-tool-alternatives.mjs";
import { CODEX_APP_TOOLS } from "../src/codex-app-tools.mjs";
import { grokToolSchema } from "../src/grok-tool-schema.mjs";

const branch = (mode, extra = {}) => ({ type: "object", properties: { mode: { const: mode }, id: { type: "string", minLength: 1 }, ...extra }, required: ["mode", "id"], additionalProperties: false });
const tool = (parameters, name = "task_update") => ({ type: "function", name, description: "Manage tasks.", strict: true, parameters });

test("each complete variant retains constraints, strictness and reversible names", () => {
  const schema = { type: "object", oneOf: [branch("view"), branch("update", { enabled: { type: "boolean" } })] };
  schema.oneOf[1].required.push("enabled");
  const input = [tool(schema)];
  const serialized = JSON.stringify(input);
  const compiled = createGrokToolAlternatives(input);
  assert.equal(compiled.tools.length, 2);
  compiled.tools.forEach((variant, index) => {
    assert.deepEqual(variant.parameters, schema.oneOf[index]);
    assert.equal(variant.strict, true);
    assert.equal(compiled.originalName(variant.name), "task_update");
    assert.match(variant.name, new RegExp(`task_update__${index ? "update" : "view"}_`));
    assert.match(variant.description, /Manage tasks\./);
    assert.match(variant.description, /Operation variant of task_update: mode=/);
  });
  assert.equal(compiled.nameForCall("task_update", '{"mode":"update","id":"123","enabled":false}'), compiled.tools[1].name);
  assert.equal(compiled.originalName("unrelated"), "unrelated");
  assert.equal(JSON.stringify(input), serialized);
  assert.deepEqual(createGrokToolAlternatives(input).tools, compiled.tools);
});

test("real nested automation union lowers to all six complete operations", () => {
  const inputSchema = CODEX_APP_TOOLS.find((item) => item.name === "codex_app").tools.find((item) => item.name === "automation_update").inputSchema;
  const flattened = grokToolSchema(inputSchema);
  const compiled = createGrokToolAlternatives([tool(inputSchema, "automation_update")]);
  assert.equal(compiled.tools.length, 6);
  compiled.tools.forEach((variant, index) => {
    assert.deepEqual(variant.parameters, { ...flattened.oneOf[index], $defs: inputSchema.$defs, $schema: inputSchema.$schema });
    assert.equal(compiled.originalName(variant.name), "automation_update");
  });
  assert.equal(new Set(compiled.tools.map((item) => item.name)).size, 6);
});

test("root definitions stay at their exact pointer paths, with singleton enum discriminators", () => {
  const left = branch("view"), right = branch("update");
  left.properties.mode = { $ref: "#/definitions/view" };
  right.properties.mode = { $ref: "#/%24defs/update" };
  const schema = { $schema: "http://json-schema.org/draft-07/schema#", anyOf: [left, right], definitions: { view: { enum: ["view"] } }, $defs: { update: { enum: ["update"] } } };
  const compiled = createGrokToolAlternatives([tool(schema)]);
  assert.equal(compiled.tools.length, 2);
  for (const item of compiled.tools) {
    assert.equal(item.parameters.definitions, schema.definitions);
    assert.equal(item.parameters.$defs, schema.$defs);
    assert.equal(item.parameters.$schema, schema.$schema);
  }
  assert.equal(compiled.nameForCall("task_update", '{"mode":"view","id":"x"}'), compiled.tools[0].name);
});

test("root constraints, resources and unsafe branches never lose validation semantics", () => {
  const base = { oneOf: [branch("a"), branch("b")] };
  const variants = [
    ...["properties", "required", "additionalProperties", "unevaluatedProperties", "$ref", "$id", "id", "$anchor", "allOf"].map((key) => ({ ...base, [key]: key === "required" ? ["extra"] : {} })),
    { ...base, type: "array" }, { ...base, anyOf: base.oneOf },
    { ...base, $schema: "http://json-schema.org/draft-04/schema#" },
    { ...base, $schema: "https://example.test/dialect" },
    { oneOf: [branch("a"), { ...branch("b"), $id: "resource.json" }] },
    { oneOf: [branch("a"), { ...branch("b"), $defs: { local: { type: "string" } } }] },
    { oneOf: [branch("a"), { ...branch("b"), $ref: "#/$defs/a" }], $defs: { a: branch("a") } },
    { oneOf: [branch("a"), branch("b", { field: { $ref: "#/oneOf/0/properties/id" } })] },
    { oneOf: [branch("a"), branch("b", { field: { $dynamicRef: "#node" } })] },
    { oneOf: [branch("a")] }, { oneOf: Array.from({ length: 33 }, (_, index) => branch(index)) },
  ];
  for (const parameters of variants) {
    const original = tool(parameters);
    assert.deepEqual(createGrokToolAlternatives([original]).tools, [original]);
  }
});

test("overlap and optional discriminators cannot prove alternatives", () => {
  const cases = [
    [branch("a"), branch("a")],
    [branch("a"), { ...branch("b"), required: ["id"] }],
    [branch("a"), branch("b", { mode: { enum: ["a", "c"] } })],
    [branch(0), branch(-0)],
    [branch({ a: [0] }), branch({ a: [-0] })],
  ];
  for (const branches of cases) for (const keyword of ["oneOf", "anyOf"]) {
    const original = tool({ [keyword]: branches });
    assert.deepEqual(createGrokToolAlternatives([original]).tools, [original]);
  }
  const ref = branch("b", { mode: { $ref: "#/$defs/mode", const: "b" } });
  const original = tool({ oneOf: [branch("a"), ref], $defs: { mode: { const: "a" } } });
  assert.deepEqual(createGrokToolAlternatives([original]).tools, [original]);
});

test("required discriminators across different keys uniquely map history", () => {
  const leaves = [
    branch("view"),
    { ...branch("create", { kind: { const: "cron" } }), required: ["mode", "kind", "id"] },
    { ...branch("create", { kind: { const: "heartbeat" } }), required: ["mode", "kind", "id"] },
  ];
  const compiled = createGrokToolAlternatives([tool({ oneOf: leaves })]);
  assert.equal(compiled.tools.length, 3);
  assert.equal(compiled.nameForCall("task_update", '{"mode":"create","kind":"heartbeat"}'), compiled.tools[2].name);
  for (const value of [undefined, null, {}, "", "{", "null", "[]", '"view"', '{"mode":"create"}', '{"mode":"unknown"}', '{"mode":2}', '{"__proto__":{"mode":"view"}}']) {
    assert.equal(compiled.nameForCall("task_update", value), "task_update");
  }
  assert.equal(compiled.nameForCall("unknown", '{"mode":"view"}'), "unknown");
});

test("names are bounded, descriptive, deterministic and never collide with originals or aliases", () => {
  const parameters = { oneOf: [branch("a / b"), branch("a_b")] };
  const name = "namespace." + "very_long_tool_name_".repeat(6);
  const base = createGrokToolAlternatives([tool(parameters, name)]);
  for (const item of base.tools) {
    assert.ok(item.name.length <= 64);
    assert.match(item.name, /^[a-zA-Z0-9_-]+$/);
  }
  assert.notEqual(base.tools[0].name, base.tools[1].name);
  const occupied = tool({ type: "object", properties: {} }, base.tools[0].name);
  const compiled = createGrokToolAlternatives([tool(parameters, name), occupied]);
  assert.notEqual(compiled.tools[0].name, occupied.name);
  assert.equal(compiled.tools[2], occupied);
  assert.equal(new Set(compiled.tools.map((item) => item.name)).size, 3);
  assert.equal(compiled.originalName(occupied.name), occupied.name);
  const duplicate = tool(parameters);
  assert.deepEqual(createGrokToolAlternatives([duplicate, duplicate]).tools, [duplicate, duplicate]);
});

test("none and explicit tool choice preserve exact client names; auto and required allow lowering", () => {
  const input = [tool({ oneOf: [branch("a"), branch("b")] })];
  for (const toolChoice of ["none", { type: "function", name: "task_update" }, { type: "function", function: { name: "task_update" } }, "task_update", null]) {
    const result = createGrokToolAlternatives(input, { toolChoice });
    assert.equal(result.tools, input);
    assert.equal(result.nameForCall("task_update", '{"mode":"a"}'), "task_update");
  }
  for (const toolChoice of [undefined, "auto", "required"]) assert.equal(createGrokToolAlternatives(input, { toolChoice }).tools.length, 2);
});

test("literal JSON data containing schema identifiers is not mistaken for schema resources", () => {
  const left = { $id: "a", $ref: "#/oneOf/0" }, right = { $id: "b", $ref: "#/oneOf/0" };
  const compiled = createGrokToolAlternatives([tool({ oneOf: [branch(left), branch(right)] })]);
  assert.equal(compiled.tools.length, 2);
  assert.equal(compiled.nameForCall("task_update", JSON.stringify({ mode: right })), compiled.tools[1].name);
});

test("disjoint finite enums preserve every allowed mode and history mapping", () => {
  const schema = { oneOf: [branch("a", { mode: { enum: ["create", "suggested_create"] } }), branch("b", { mode: { enum: ["update", "suggested_update"] } })] };
  const compiled = createGrokToolAlternatives([tool(schema)]);
  assert.equal(compiled.tools.length, 2);
  for (const mode of ["create", "suggested_create"]) assert.equal(compiled.nameForCall("task_update", JSON.stringify({ mode })), compiled.tools[0].name);
  for (const mode of ["update", "suggested_update"]) assert.equal(compiled.nameForCall("task_update", JSON.stringify({ mode })), compiled.tools[1].name);
  assert.deepEqual(compiled.tools.map((item) => item.parameters), schema.oneOf);
});

test("provider tool budget never partially exposes an operation union", () => {
  const union = tool({ oneOf: [branch("a"), branch("b"), branch("c")] });
  const other = tool({ type: "object", properties: {} }, "other");
  const input = [union, other];
  assert.deepEqual(createGrokToolAlternatives(input, { maxTools: 3 }).tools, input);
  assert.equal(createGrokToolAlternatives(input, { maxTools: 4 }).tools.length, 4);
  assert.equal(createGrokToolAlternatives(input, { maxTools: 1 }).tools, input);
  const full = Array.from({ length: 350 }, (_, index) => tool({ type: "object", properties: {} }, `f${index}`));
  full[0] = union;
  assert.deepEqual(createGrokToolAlternatives(full).tools, full);
});
