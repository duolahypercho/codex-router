import assert from "node:assert/strict";
import test from "node:test";

import { CODEX_APP_TOOLS } from "../src/codex-app-tools.mjs";
import { toResponsesRequest } from "../src/grok-oauth-forwarder.mjs";
import {
  hasObjectRoot,
  normalizeSchemaLiterals,
  objectRootToolSchema,
  providerToolSchema,
} from "../src/tool-schema-root.mjs";

test("object-rooted schemas are returned untouched", () => {
  const schema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
  assert.equal(objectRootToolSchema(schema), schema);
});

test("a schema with properties but no type counts as object-rooted", () => {
  const schema = { properties: { path: { type: "string" } } };
  assert.equal(objectRootToolSchema(schema), schema);
});

// The shape the live Codex client actually sends: an object root that also
// carries a root-level union. xAI rejects it on the union alone, so declaring
// `type: "object"` must not buy a pass.
test("an object root carrying a root union is still rewritten", () => {
  const flattened = objectRootToolSchema({
    type: "object",
    properties: { mode: { type: "string" } },
    required: ["mode"],
    oneOf: [
      { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    ],
  });
  assert.equal(flattened.oneOf, undefined, "the root union is gone");
  assert.deepEqual(Object.keys(flattened.properties).sort(), ["id", "mode", "name"]);
  // "mode" binds every branch; "id" and "name" are alternatives.
  assert.deepEqual(flattened.required, ["mode"]);
  assert.equal(hasObjectRoot(flattened), true);
});

test("union roots flatten into one object with every branch property", () => {
  const flattened = objectRootToolSchema({
    oneOf: [
      { type: "object", properties: { mode: { const: "view" }, id: { type: "string" } }, required: ["mode", "id"] },
      { type: "object", properties: { mode: { const: "delete" }, force: { type: "boolean" } }, required: ["mode"] },
    ],
  });
  assert.equal(flattened.type, "object");
  assert.deepEqual(Object.keys(flattened.properties).sort(), ["force", "id", "mode"]);
  // "mode" is required by both branches, "id" only by the first.
  assert.deepEqual(flattened.required, ["mode"]);
  assert.equal(flattened.additionalProperties, true);
});

test("branches behind local $refs are resolved", () => {
  const flattened = objectRootToolSchema({
    $defs: {
      create: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
    anyOf: [{ $ref: "#/$defs/create" }, { type: "null" }],
  });
  assert.deepEqual(Object.keys(flattened.properties), ["name"]);
  // The null branch is unreachable once the root must be an object, so the
  // surviving branch's own requirement stands.
  assert.deepEqual(flattened.required, ["name"]);
  assert.ok(flattened.$defs, "keeps $defs so nested refs still resolve");
});

test("self-referential $refs terminate", () => {
  const flattened = objectRootToolSchema({
    $defs: { loop: { anyOf: [{ $ref: "#/$defs/loop" }] } },
    oneOf: [{ $ref: "#/$defs/loop" }],
  });
  assert.equal(flattened.type, "object");
  assert.deepEqual(flattened.properties, {});
});

test("a union with no object branch still yields a permissive object", () => {
  const flattened = objectRootToolSchema({ anyOf: [{ type: "string" }, { type: "number" }] });
  assert.equal(flattened.type, "object");
  assert.equal(flattened.additionalProperties, true);
});

test("non-schema input yields an empty object schema", () => {
  assert.deepEqual(objectRootToolSchema(undefined), { type: "object", properties: {} });
  assert.deepEqual(objectRootToolSchema("nonsense"), { type: "object", properties: {} });
});

// The regression this exists for: xAI answers
// "[invalid_client_tool_schema] codex_app__automation_update: tool parameter
// root must be an object type" and fails the entire request, so a Grok session
// could not complete a single turn while the Codex app toolset was attached.
test("every Codex app tool reaches xAI with an object root", () => {
  const appTools = CODEX_APP_TOOLS.flatMap((entry) =>
    entry.type === "namespace" ? entry.tools : [entry],
  );
  const unionRooted = appTools.filter((tool) => !hasObjectRoot(tool.inputSchema));
  assert.ok(
    unionRooted.length > 0,
    "expected at least one union-rooted app tool, or this test proves nothing",
  );

  const request = toResponsesRequest({
    model: "grok-4.6",
    messages: [{ role: "user", content: "hi" }],
    tools: appTools.map((tool) => ({
      type: "function",
      function: { name: `codex_app__${tool.name}`, parameters: tool.inputSchema },
    })),
  });
  for (const tool of request.tools.filter((entry) => entry.type === "function")) {
    assert.ok(
      hasObjectRoot(tool.parameters),
      `${tool.name} would be rejected by xAI: root is not an object`,
    );
  }
});

test("automation_update keeps its branch fields after flattening", () => {
  const automationUpdate = CODEX_APP_TOOLS.flatMap((entry) =>
    entry.type === "namespace" ? entry.tools : [entry],
  ).find((tool) => tool.name === "automation_update");
  assert.ok(automationUpdate, "automation_update is still part of the app toolset");

  const flattened = objectRootToolSchema(automationUpdate.inputSchema);
  assert.equal(flattened.type, "object");
  assert.ok(
    Object.keys(flattened.properties).includes("mode"),
    "the discriminating field survives the merge",
  );
});

// Regression for #179: Moonshot rejects the whole request when an enum literal
// contradicts the type its own node declares. The reported path was
// `properties.appTaskLane.properties.enabled.enum`, from a client-supplied
// schema, so it cannot be repaired in the bundled snapshot.
test("literals that contradict their declared type are dropped", () => {
  const schema = {
    type: "object",
    properties: {
      appTaskLane: {
        type: "object",
        properties: {
          enabled: { type: "string", enum: [true] },
          mode: { type: "string", enum: ["auto", "manual"] },
        },
      },
    },
  };

  const normalized = normalizeSchemaLiterals(schema);
  assert.deepEqual(normalized.properties.appTaskLane.properties.enabled, { type: "string" });
  assert.deepEqual(normalized.properties.appTaskLane.properties.mode.enum, ["auto", "manual"]);
  assert.deepEqual(
    schema.properties.appTaskLane.properties.enabled.enum,
    [true],
    "the client's schema object is never mutated",
  );
});

test("a clean schema is returned by identity, with no copy", () => {
  const schema = { type: "object", properties: { mode: { type: "string", enum: ["a"] } } };
  assert.equal(normalizeSchemaLiterals(schema), schema);
  assert.equal(providerToolSchema(schema), schema);
});

test("integers satisfy a declared number type", () => {
  assert.deepEqual(normalizeSchemaLiterals({ type: "number", enum: [1, 2.5] }).enum, [1, 2.5]);
});

test("a const contradicting its declared type is dropped", () => {
  assert.deepEqual(normalizeSchemaLiterals({ type: "string", const: 5 }), { type: "string" });
});

test("an untyped enum is left alone", () => {
  const schema = { enum: [true, "a"] };
  assert.equal(normalizeSchemaLiterals(schema), schema);
});

test("contradicting literals are dropped through $defs and unions", () => {
  const schema = {
    $defs: { lane: { type: "string", enum: [1] } },
    oneOf: [{ type: "object", properties: { flag: { type: "boolean", enum: ["yes"] } } }],
  };
  const normalized = normalizeSchemaLiterals(schema);
  assert.equal("enum" in normalized.$defs.lane, false, "an emptied enum is removed, not left empty");
  assert.equal("enum" in normalized.oneOf[0].properties.flag, false);
});

test("providerToolSchema fixes a union root and its literals together", () => {
  const schema = {
    oneOf: [
      { type: "object", properties: { mode: { type: "string", enum: [true, "view"] } } },
      { type: "object", properties: { id: { type: "string" } } },
    ],
  };
  const normalized = providerToolSchema(schema);
  assert.equal(normalized.type, "object");
  assert.deepEqual(normalized.properties.mode.enum, ["view"]);
});

// providerToolSchema runs on every namespace and MCP tool, where schemas are
// server-defined. objectRootToolSchema collapses any root it cannot recognize
// into an empty object -- correct for xAI, which rejects every non-object root,
// but it would silently replace a real MCP schema with one accepting anything.
test("a non-object root that is not a union is left alone", () => {
  for (const schema of [
    { type: "array", items: { type: "string" } },
    { type: "string" },
    {},
  ]) {
    assert.equal(providerToolSchema(schema), schema, JSON.stringify(schema));
  }
});

test("a union root is still merged into an object", () => {
  const merged = providerToolSchema({
    oneOf: [
      { type: "object", properties: { mode: { type: "string" } } },
      { type: "object", properties: { id: { type: "string" } } },
    ],
  });
  assert.equal(merged.type, "object");
  assert.deepEqual(Object.keys(merged.properties).sort(), ["id", "mode"]);
});

test("literals are still normalized inside a schema that keeps its root", () => {
  const normalized = providerToolSchema({
    type: "array",
    items: { type: "string", enum: [true, "ok"] },
  });
  assert.equal(normalized.type, "array");
  assert.deepEqual(normalized.items.enum, ["ok"]);
});

// xAI reads the root `type` literally. A nullable object root is legal JSON
// Schema and is rejected with the same `tool parameter root must be an object
// type` as a union -- confirmed against the live backend, where
// `type: ["object", "null"]` 400s and plain `"object"` does not.
test("a nullable object root is rewritten to a plain object root", () => {
  const rewritten = objectRootToolSchema({
    type: ["object", "null"],
    properties: { id: { type: "string" } },
    required: ["id"],
  });
  assert.equal(rewritten.type, "object");
  assert.deepEqual(Object.keys(rewritten.properties), ["id"]);
  assert.deepEqual(rewritten.required, ["id"]);
});

test("hasObjectRoot rejects a declared type that is not exactly object", () => {
  assert.equal(hasObjectRoot({ type: ["object", "null"], properties: { id: {} } }), false);
  assert.equal(hasObjectRoot({ type: "object", properties: { id: {} } }), true);
  // No declared type at all still falls back to `properties`, which xAI accepts.
  assert.equal(hasObjectRoot({ properties: { id: {} } }), true);
});

// Rewriting a root that merged nothing has no branch ambiguity to paper over,
// so it must not quietly widen a schema that closed itself.
test("a rewrite that merged no union keeps its own additionalProperties", () => {
  const closed = objectRootToolSchema({
    type: ["object", "null"],
    properties: { id: {} },
    additionalProperties: false,
  });
  assert.equal(closed.additionalProperties, false);
  const merged = objectRootToolSchema({
    oneOf: [
      { type: "object", properties: { a: {} } },
      { type: "object", properties: { b: {} } },
    ],
  });
  assert.equal(merged.additionalProperties, true);
});

// A nullable object root is rejected by name by two independent upstreams --
// xAI ("tool parameter root must be an object type") and DeepSeek ("schema must
// be a JSON Schema of 'type: \"object\"', got 'type: [\"object\",\"null\"]'") --
// both reproduced live, so the shared relay repairs it for every provider.
test("the shared relay repairs a nullable object root", () => {
  const repaired = providerToolSchema({
    type: ["object", "null"],
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  });
  assert.equal(repaired.type, "object");
  assert.deepEqual(Object.keys(repaired.properties), ["id"]);
  assert.deepEqual(repaired.required, ["id"]);
  // Nothing was merged, so the schema keeps the door it closed.
  assert.equal(repaired.additionalProperties, false);
});

// Still narrow: the relay runs on every namespace and MCP tool, so a root it
// merely finds unusual must survive untouched rather than be replaced with one
// that accepts anything.
test("the shared relay leaves other roots alone", () => {
  const plain = { type: "object", properties: { id: {} } };
  assert.equal(providerToolSchema(plain), plain);
  const typeless = { properties: { id: {} } };
  assert.equal(providerToolSchema(typeless), typeless);
  // No "object" member means collapsing it would destroy the schema, not fix it.
  const notObject = { type: ["string", "null"] };
  assert.equal(providerToolSchema(notObject), notObject);
});
