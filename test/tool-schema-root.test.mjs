import assert from "node:assert/strict";
import test from "node:test";

import { CODEX_APP_TOOLS } from "../src/codex-app-tools.mjs";
import { toResponsesRequest } from "../src/grok-oauth-forwarder.mjs";
import {
  hasObjectRoot,
  inlineForeignRefs,
  nonRecursiveToolSchema,
  normalizeSchemaLiterals,
  objectRootToolSchema,
  providerToolSchema,
  stripCodexEncryptedSchemaAnnotation,
} from "../src/tool-schema-root.mjs";

test("Codex encrypted annotations are removed only from JSON-Schema nodes", () => {
  const ordinary = {
    type: "object",
    properties: { value: { type: "string" } },
  };
  assert.equal(stripCodexEncryptedSchemaAnnotation(ordinary), ordinary);

  const schema = {
    type: "object",
    encrypted: true,
    properties: {
      encrypted: {
        type: "string",
        description: "A legitimate user property named encrypted.",
      },
      nested: {
        type: "object",
        properties: {
          value: { type: "string", encrypted: true },
        },
      },
    },
    default: { encrypted: true },
    examples: [{ encrypted: true }],
  };
  const repaired = stripCodexEncryptedSchemaAnnotation(schema);
  assert.notEqual(repaired, schema);
  assert.equal("encrypted" in repaired, false);
  assert.deepEqual(repaired.properties.encrypted, {
    type: "string",
    description: "A legitimate user property named encrypted.",
  });
  assert.equal("encrypted" in repaired.properties.nested.properties.value, false);
  assert.deepEqual(repaired.default, { encrypted: true });
  assert.deepEqual(repaired.examples, [{ encrypted: true }]);
  assert.equal(schema.encrypted, true, "the caller's schema must not be mutated");
  assert.equal(schema.properties.nested.properties.value.encrypted, true);
});

test("recursive local refs keep definitions and only the cycle edge becomes permissive", () => {
  const schema = {
    type: "object",
    properties: { node: { $ref: "#/$defs/node" } },
    $defs: {
      node: {
        type: "object",
        properties: {
          label: { type: "string" },
          child: { $ref: "#/$defs/node", description: "optional child" },
        },
      },
    },
  };
  const repaired = nonRecursiveToolSchema(schema);
  assert.notEqual(repaired, schema);
  assert.equal(repaired.properties.node.$ref, "#/$defs/node");
  assert.equal(repaired.$defs.node.type, "object");
  assert.equal(repaired.$defs.node.properties.label.type, "string");
  assert.deepEqual(repaired.$defs.node.properties.child, {
    description: "optional child",
  });
  assert.equal(
    schema.$defs.node.properties.child.$ref,
    "#/$defs/node",
    "the caller's recursive schema is not mutated",
  );
});

test("mutually recursive refs retain their shared definitions and break one back edge", () => {
  const schema = {
    type: "object",
    properties: { first: { $ref: "#/$defs/a" } },
    $defs: {
      a: {
        type: "object",
        properties: { name: { type: "string" }, next: { $ref: "#/$defs/b" } },
      },
      b: {
        type: "object",
        properties: { count: { type: "integer" }, previous: { $ref: "#/$defs/a" } },
      },
    },
  };
  const repaired = nonRecursiveToolSchema(schema);
  assert.equal(repaired.properties.first.$ref, "#/$defs/a");
  assert.equal(repaired.$defs.a.properties.next.$ref, "#/$defs/b");
  assert.deepEqual(repaired.$defs.b.properties.previous, {});
});

test("local ref pointers repair root and array cycles without resolving anchors", () => {
  const root = nonRecursiveToolSchema({
    properties: { self: { $ref: "#", description: "recursive root" } },
  });
  assert.deepEqual(root.properties.self, { description: "recursive root" });

  const array = nonRecursiveToolSchema({
    anyOf: [
      {
        properties: {
          self: { $ref: "#/anyOf/0" },
          anchor: { $ref: "#node" },
        },
      },
    ],
  });
  assert.deepEqual(array.anyOf[0].properties.self, {});
  assert.equal(array.anyOf[0].properties.anchor.$ref, "#node");
});

test("shared ref DAGs stay bounded when another definition is recursive", () => {
  const $defs = {
    d0: { type: "string" },
  };
  for (let depth = 1; depth <= 18; depth += 1) {
    $defs[`d${depth}`] = {
      anyOf: [
        { $ref: `#/$defs/d${depth - 1}` },
        { $ref: `#/$defs/d${depth - 1}` },
      ],
    };
  }
  $defs.recursive = {
    type: "object",
    properties: { child: { $ref: "#/$defs/recursive" } },
  };
  const schema = {
    type: "object",
    properties: {
      dag: { $ref: "#/$defs/d18" },
      recursive: { $ref: "#/$defs/recursive" },
    },
    $defs,
  };
  const sourceBytes = Buffer.byteLength(JSON.stringify(schema));
  const repaired = nonRecursiveToolSchema(schema);
  const repairedBytes = Buffer.byteLength(JSON.stringify(repaired));

  assert.equal(repaired.properties.dag.$ref, "#/$defs/d18");
  assert.equal(repaired.$defs.d18.anyOf[0].$ref, "#/$defs/d17");
  assert.deepEqual(repaired.$defs.recursive.properties.child, {});
  assert.ok(
    repairedBytes < sourceBytes * 2,
    `shared DAG expanded from ${sourceBytes} to ${repairedBytes} bytes`,
  );
});

test("cycle repair preserves boolean and unresolved local refs", () => {
  const schema = {
    type: "object",
    properties: {
      allowed: { $ref: "#/$defs/allowed" },
      unknown: { $ref: "#/$defs/missing" },
      recursive: { $ref: "#/$defs/recursive" },
    },
    $defs: {
      allowed: true,
      recursive: {
        type: "object",
        properties: { next: { $ref: "#/$defs/recursive" } },
      },
    },
  };
  const repaired = nonRecursiveToolSchema(schema);
  assert.equal(repaired.$defs.allowed, true);
  assert.equal(repaired.properties.allowed.$ref, "#/$defs/allowed");
  assert.equal(repaired.properties.unknown.$ref, "#/$defs/missing");
  assert.deepEqual(repaired.$defs.recursive.properties.next, {});
});

// The recursive implementation overflowed at depth 2,000 on the supported
// Node 22 runtime. Use 4,000 so this regression remains effective on runtimes
// whose JavaScript stack happens to be larger.
test("a 4,000-level recursive schema is repaired", () => {
  const depth = 4_000;
  let node = {
    properties: { cycle: { $ref: "#/$defs/node" } },
  };
  for (let index = 0; index < depth; index += 1) {
    node = { properties: { next: node } };
  }
  const repaired = nonRecursiveToolSchema({ $defs: { node } });
  let cursor = repaired.$defs.node;
  for (let index = 0; index < depth; index += 1) {
    cursor = cursor.properties.next;
  }
  assert.deepEqual(cursor.properties.cycle, {});
});

test("cycle repair never interprets refs inside literal JSON Schema payloads", () => {
  const literalPayloads = {
    const: {
      $ref: "#/$defs/recursive",
      nested: { $ref: "#/properties/payload" },
    },
    default: { $ref: "#/$defs/recursive" },
    examples: [{ $ref: "#/$defs/recursive" }],
    enum: [{ $ref: "#/$defs/recursive" }, { ordinary: true }],
  };
  const schema = {
    type: "object",
    properties: {
      payload: { type: "object", ...literalPayloads },
      recursive: { $ref: "#/$defs/recursive" },
    },
    $defs: {
      recursive: {
        type: "object",
        properties: { next: { $ref: "#/$defs/recursive" } },
      },
    },
  };
  const before = JSON.stringify(literalPayloads);

  const repaired = nonRecursiveToolSchema(schema);
  const payload = repaired.properties.payload;
  assert.equal(
    JSON.stringify({
      const: payload.const,
      default: payload.default,
      examples: payload.examples,
      enum: payload.enum,
    }),
    before,
  );
  assert.deepEqual(repaired.$defs.recursive.properties.next, {});
});

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

// Moonshot rejects every `$ref` that does not point into `#/$defs/`, and the
// Codex App connector pack ships plenty that do not: Wego `_flights_search`
// points `inboundTotalDurationRange` at its own sibling `priceRange`. The
// rejection fails the whole request, so one connector tool kills a kimi session
// that never searches a flight (issue #353).
function flightsSearchSchema() {
  return {
    type: "object",
    properties: {
      filters: {
        type: "object",
        properties: {
          priceRange: {
            type: "object",
            properties: {
              min: { type: "number" },
              max: { type: "number" },
            },
            required: ["min"],
            additionalProperties: false,
          },
          inboundTotalDurationRange: {
            $ref: "#/properties/filters/properties/priceRange",
            description: "Inbound duration window, in minutes.",
          },
        },
      },
    },
  };
}

function refPointers(value, found = []) {
  if (Array.isArray(value)) {
    for (const entry of value) refPointers(entry, found);
    return found;
  }
  if (!value || typeof value !== "object") return found;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "$ref" && typeof entry === "string") found.push(entry);
    else refPointers(entry, found);
  }
  return found;
}

test("a sibling-property ref is inlined with the target's constraints", () => {
  const schema = flightsSearchSchema();
  const inlined = inlineForeignRefs(schema);
  assert.notEqual(inlined, schema);
  assert.deepEqual(refPointers(inlined), []);
  const inbound = inlined.properties.filters.properties.inboundTotalDurationRange;
  assert.equal(inbound.type, "object");
  assert.deepEqual(Object.keys(inbound.properties), ["min", "max"]);
  assert.deepEqual(inbound.required, ["min"]);
  assert.equal(inbound.additionalProperties, false);
  // A constraint declared beside the `$ref` is the client's own and outranks
  // whatever the target says.
  assert.equal(inbound.description, "Inbound duration window, in minutes.");
  // The client's schema is never mutated.
  assert.deepEqual(schema, flightsSearchSchema());
});

// A foreign `$ref` plus a validation sibling is a conjunction. Blind object
// spread is only lossless when overlapping keywords agree: replacing the
// target's tighter maxLength with the sibling's looser value would widen what
// the caller's tool accepts. When that conjunction cannot be represented by a
// simple inline, keep the original ref and let the strict provider fail closed.
test("a conflicting foreign ref validation sibling is not widened", () => {
  const schema = {
    type: "object",
    properties: {
      base: { type: "string", maxLength: 5 },
      alias: { $ref: "#/properties/base", maxLength: 10 },
    },
  };
  const inlined = inlineForeignRefs(schema);
  assert.equal(inlined, schema);
  assert.deepEqual(inlined.properties.alias, {
    $ref: "#/properties/base",
    maxLength: 10,
  });
});
test("a $defs ref is the form Moonshot asks for and survives untouched", () => {
  const schema = {
    type: "object",
    properties: {
      window: { $ref: "#/$defs/range" },
      alias: { $ref: "#/properties/window" },
    },
    $defs: { range: { type: "object", properties: { min: { type: "number" } } } },
  };
  const inlined = inlineForeignRefs(schema);
  assert.equal(inlined.properties.window.$ref, "#/$defs/range");
  // The alias pointed at a property, not a definition, so it is expanded -- and
  // what it expands to is the `$defs` pointer the property itself carries.
  assert.equal(inlined.properties.alias.$ref, "#/$defs/range");
  assert.deepEqual(inlined.$defs, schema.$defs);
});

test("a $defs ref with sibling keywords is inlined for Moonshot", () => {
  const schema = {
    type: "object",
    properties: {
      targetThreadId: { $ref: "#/$defs/__schema20" },
    },
    $defs: {
      __schema2: { type: "string", minLength: 1 },
      __schema20: {
        $ref: "#/$defs/__schema2",
        type: "string",
        minLength: 1,
        format: "uuid",
        description: "Target thread UUID for heartbeat automations.",
      },
    },
  };
  const inlined = inlineForeignRefs(schema);
  assert.equal(inlined.properties.targetThreadId.$ref, "#/$defs/__schema20");
  assert.deepEqual(inlined.$defs.__schema2, { type: "string", minLength: 1 });
  assert.deepEqual(inlined.$defs.__schema20, {
    type: "string",
    minLength: 1,
    format: "uuid",
    description: "Target thread UUID for heartbeat automations.",
  });
  assert.deepEqual(schema.$defs.__schema20.$ref, "#/$defs/__schema2");
});

test("a decorated $defs alias chain resolves through pure aliases", () => {
  const schema = {
    type: "object",
    properties: { value: { $ref: "#/$defs/decorated" } },
    $defs: {
      base: { type: "string", minLength: 2 },
      alias: { $ref: "#/$defs/base" },
      decorated: {
        $ref: "#/$defs/alias",
        type: "string",
        minLength: 2,
        format: "uuid",
        description: "Decorated alias.",
      },
    },
  };
  const inlined = inlineForeignRefs(schema);
  assert.equal(inlined.properties.value.$ref, "#/$defs/decorated");
  assert.deepEqual(inlined.$defs.alias, { $ref: "#/$defs/base" });
  assert.deepEqual(inlined.$defs.decorated, {
    type: "string",
    minLength: 2,
    format: "uuid",
    description: "Decorated alias.",
  });
  assert.deepEqual(schema.$defs.decorated.$ref, "#/$defs/alias");
});

test("a conflicting $defs ref sibling remains intact", () => {
  const schema = {
    type: "object",
    properties: { value: { $ref: "#/$defs/narrow" } },
    $defs: {
      base: { type: "string", minLength: 2 },
      narrow: {
        $ref: "#/$defs/base",
        type: "string",
        minLength: 1,
      },
    },
  };
  assert.deepEqual(inlineForeignRefs(schema).$defs.narrow, {
    $ref: "#/$defs/base",
    type: "string",
    minLength: 1,
  });
});

test("a conflicting stricter $defs ref sibling also remains intact", () => {
  const schema = {
    type: "object",
    properties: { value: { $ref: "#/$defs/narrow" } },
    $defs: {
      base: { type: "string", minLength: 1 },
      narrow: {
        $ref: "#/$defs/base",
        type: "string",
        minLength: 2,
      },
    },
  };
  assert.deepEqual(inlineForeignRefs(schema).$defs.narrow, {
    $ref: "#/$defs/base",
    type: "string",
    minLength: 2,
  });
});

test("a cyclic $defs ref sibling remains intact", () => {
  const schema = {
    type: "object",
    properties: { node: { $ref: "#/$defs/node" } },
    $defs: {
      node: {
        $ref: "#/$defs/node",
        type: "object",
        description: "Cyclic node.",
      },
    },
  };
  assert.deepEqual(inlineForeignRefs(schema).$defs.node, {
    $ref: "#/$defs/node",
    type: "object",
    description: "Cyclic node.",
  });
});

test("an unresolvable ref is left alone rather than guessed at", () => {
  const schema = {
    type: "object",
    properties: {
      dangling: { $ref: "#/properties/missing" },
      anchor: { $ref: "#namedAnchor" },
      remote: { $ref: "https://example.com/schema.json" },
      resolvable: { $ref: "#/properties/known" },
      known: { type: "string", minLength: 2 },
    },
  };
  const inlined = inlineForeignRefs(schema);
  assert.equal(inlined.properties.dangling.$ref, "#/properties/missing");
  assert.equal(inlined.properties.anchor.$ref, "#namedAnchor");
  assert.equal(inlined.properties.remote.$ref, "https://example.com/schema.json");
  assert.deepEqual(inlined.properties.resolvable, { type: "string", minLength: 2 });
});

test("a self-referential foreign ref terminates and keeps the cycle edge", () => {
  const schema = {
    type: "object",
    properties: {
      node: {
        type: "object",
        properties: {
          label: { type: "string" },
          child: { $ref: "#/properties/node" },
        },
      },
      root: { $ref: "#" },
    },
  };
  const inlined = inlineForeignRefs(schema);
  // The expansion stops at the edge that would close the cycle: the innermost
  // `child` still carries the pointer instead of another copy of `node`.
  const child = inlined.properties.node.properties.child;
  assert.equal(child.type, "object");
  assert.equal(child.properties.label.type, "string");
  assert.equal(child.properties.child.$ref, "#/properties/node");
  assert.equal(inlined.properties.root.type, "object");
});

test("a mutually recursive pair terminates", () => {
  const schema = {
    type: "object",
    properties: {
      a: { type: "object", properties: { next: { $ref: "#/properties/b" } } },
      b: { type: "object", properties: { previous: { $ref: "#/properties/a" } } },
    },
  };
  const inlined = inlineForeignRefs(schema);
  assert.equal(inlined.properties.a.properties.next.type, "object");
  assert.equal(
    inlined.properties.a.properties.next.properties.previous.properties.next.$ref,
    "#/properties/b",
  );
});

// Expanding a shared ref DAG can grow exponentially, so an inlined copy that
// outgrows its budget is worse than the rejection it was meant to avoid: it
// would ship megabytes of duplicated schema on every turn. The original comes
// back instead, refs and all.
test("an expansion past the byte budget falls back to the original schema", () => {
  const enormous = {
    type: "string",
    enum: Array.from({ length: 4000 }, (_, index) => `option-${index}-${"x".repeat(16)}`),
  };
  const properties = { enormous };
  for (let index = 0; index < 12; index += 1) {
    properties[`copy${index}`] = { $ref: "#/properties/enormous" };
  }
  const schema = { type: "object", properties };
  assert.equal(inlineForeignRefs(schema), schema);
});

test("a schema with no foreign ref keeps identity", () => {
  const schema = {
    type: "object",
    properties: { window: { $ref: "#/$defs/range" } },
    $defs: { range: { type: "object" } },
  };
  assert.equal(inlineForeignRefs(schema), schema);
  const notObject = ["not", "a", "schema"];
  assert.equal(inlineForeignRefs(notObject), notObject);
});
