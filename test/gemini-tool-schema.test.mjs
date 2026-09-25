import assert from "node:assert/strict";
import test from "node:test";

import {
  geminiToolSchema,
  repairGeminiToolSchema,
  repairGeminiToolSchemas,
} from "../src/gemini-tool-schema.mjs";

// The two fields Codex ships inside `image_gen__imagegen` that reach Gemini
// through Command Code. The array field is the one the live rejection named:
// "parameters.referenced_image_paths schema specified other fields alongside
// any_of. When using any_of, it must be the only field set."
function imageGenParameters() {
  return {
    type: "object",
    properties: {
      prompt: { type: "string", description: "What to draw." },
      referenced_image_paths: {
        type: ["array", "null"],
        items: { type: "string" },
        description: "Paths to images the edit should reference.",
      },
      num_last_images_to_include: { type: ["number", "null"] },
    },
    required: ["prompt"],
  };
}

test("the image_gen nullable fields become explicit nullable unions", () => {
  const repaired = geminiToolSchema(imageGenParameters());
  const paths = repaired.properties.referenced_image_paths;
  // The union node carries no sibling keyword at all -- that is exactly the
  // shape Gemini's validator demands -- and the array constraints and
  // description move onto the branch they describe.
  assert.deepEqual(Object.keys(paths), ["anyOf"]);
  assert.deepEqual(paths, {
    anyOf: [
      {
        type: "array",
        items: { type: "string" },
        description: "Paths to images the edit should reference.",
      },
      { type: "null" },
    ],
  });
  assert.deepEqual(repaired.properties.num_last_images_to_include, {
    anyOf: [{ type: "number" }, { type: "null" }],
  });
  // Everything else about the tool is untouched.
  assert.equal(repaired.type, "object");
  assert.deepEqual(repaired.required, ["prompt"]);
  assert.deepEqual(repaired.properties.prompt, imageGenParameters().properties.prompt);
});

// A local model of the upstream conversion the error came from, kept to the
// paths this repair depends on: `@ai-sdk/google`'s
// convert-json-schema-to-openapi-schema.ts turns a nullable type array into
// `anyOf` plus `nullable` and then keeps the node's other keywords, while an
// explicit one-non-null-branch `anyOf` plus `{type:"null"}` is flattened into
// the converted branch with no surviving `anyOf`. It is a test oracle for the
// failure mode, not a reimplementation of the provider; the route itself is
// verified live against Command Code.
function convertToGeminiSchema(jsonSchema) {
  const result = {};
  if (jsonSchema.description) result.description = jsonSchema.description;
  if (jsonSchema.required) result.required = jsonSchema.required;
  if (jsonSchema.type) {
    if (Array.isArray(jsonSchema.type)) {
      const nonNull = jsonSchema.type.filter((entry) => entry !== "null");
      if (nonNull.length === 0) {
        result.type = "null";
      } else {
        result.anyOf = nonNull.map((entry) => ({ type: entry }));
        if (jsonSchema.type.includes("null")) result.nullable = true;
      }
    } else {
      result.type = jsonSchema.type;
    }
  }
  if (jsonSchema.properties) {
    result.properties = {};
    for (const [name, child] of Object.entries(jsonSchema.properties)) {
      result.properties[name] = convertToGeminiSchema(child);
    }
  }
  if (jsonSchema.items) result.items = convertToGeminiSchema(jsonSchema.items);
  if (jsonSchema.anyOf) {
    const nullable = jsonSchema.anyOf.some((branch) => branch?.type === "null");
    const nonNull = jsonSchema.anyOf.filter((branch) => branch?.type !== "null");
    if (nullable && nonNull.length === 1) {
      result.nullable = true;
      Object.assign(result, convertToGeminiSchema(nonNull[0]));
    } else {
      result.anyOf = jsonSchema.anyOf.map(convertToGeminiSchema);
      if (nullable) result.nullable = true;
    }
  }
  return result;
}

test("the repaired schema converts without any_of beside other fields", () => {
  const original = imageGenParameters().properties.referenced_image_paths;
  // The shipping shape is the failing one: the converter leaves `anyOf` and
  // `items` on the same node, which is the reported rejection.
  const broken = convertToGeminiSchema(original);
  assert.deepEqual(broken.anyOf, [{ type: "array" }]);
  assert.deepEqual(broken.items, { type: "string" });

  const repaired = geminiToolSchema(imageGenParameters());
  const converted = convertToGeminiSchema(repaired).properties.referenced_image_paths;
  assert.equal(converted.anyOf, undefined);
  assert.equal(converted.type, "array");
  assert.equal(converted.nullable, true);
  // The array's item constraint is still there.
  assert.deepEqual(converted.items, { type: "string" });
  assert.equal(converted.description, "Paths to images the edit should reference.");
  assert.deepEqual(
    convertToGeminiSchema(repaired).properties.num_last_images_to_include,
    { type: "number", nullable: true },
  );
});

test("the rewrite is idempotent and leaves compatible schemas by identity", () => {
  const repaired = geminiToolSchema(imageGenParameters());
  assert.equal(geminiToolSchema(repaired), repaired);
  assert.deepEqual(geminiToolSchema(repaired), repaired);

  const ordinary = {
    type: "object",
    properties: {
      window: { type: "array", items: { type: "number" }, minItems: 1 },
      label: { type: "string", maxLength: 8 },
    },
  };
  assert.equal(geminiToolSchema(ordinary), ordinary);

  // An explicit union already states its alternative, and the converter
  // collapses it on its own -- rewriting it would only add risk.
  const explicit = {
    type: "object",
    properties: {
      value: { anyOf: [{ type: "string" }, { type: "null" }], description: "Either." },
    },
  };
  assert.equal(geminiToolSchema(explicit), explicit);
});

test("shapes the rewrite deliberately does not claim are left alone", () => {
  const cases = [
    // A union of several non-null types is not the observed shape.
    { type: ["string", "number", "null"] },
    // A node whose null alternative carries a literal would make the converter
    // throw if `enum` were moved into the non-null branch.
    { type: ["string", "null"], enum: ["a", null] },
    { type: ["string", "null"], const: "a" },
    // Explicit composition and reference keywords stay where they are.
    { type: ["array", "null"], allOf: [{ maxItems: 3 }] },
    { type: ["array", "null"], $ref: "#/$defs/list" },
    { type: ["null"] },
  ];
  for (const schema of cases) {
    assert.equal(geminiToolSchema(schema), schema, JSON.stringify(schema));
  }
});

test("literal data that looks like a schema is never rewritten", () => {
  const literal = { type: ["array", "null"], items: { type: "string" } };
  const schema = {
    type: "object",
    properties: { value: { type: ["string", "null"] } },
    default: literal,
    examples: [literal],
  };
  const repaired = geminiToolSchema(schema);
  assert.equal(repaired.default, literal);
  assert.deepEqual(repaired.examples, [literal]);
  assert.deepEqual(repaired.default, { type: ["array", "null"], items: { type: "string" } });
});

test("nullable array constraints and special property names survive serialization", () => {
  const schema = JSON.parse('{"type":"object","properties":{"__proto__":{"type":["array","null"],"items":{"type":"string"},"minItems":1,"maxItems":2}},"required":["__proto__"],"additionalProperties":false}');
  const repaired = JSON.parse(JSON.stringify(geminiToolSchema(schema)));
  assert.deepEqual(repaired.required, ["__proto__"]);
  assert.equal(repaired.additionalProperties, false);
  assert.ok(Object.hasOwn(repaired.properties, "__proto__"));
  assert.deepEqual(repaired.properties.__proto__, {
    anyOf: [{ type: "array", items: { type: "string" }, minItems: 1, maxItems: 2 }, { type: "null" }],
  });
});

test("nested schema positions are repaired in place", () => {
  const schema = {
    type: "object",
    properties: {
      list: {
        type: "array",
        // A nullable element schema, one level deeper than the observed field.
        items: { type: ["string", "null"] },
      },
      bag: { type: "object", additionalProperties: { type: ["number", "null"] } },
    },
  };
  const repaired = geminiToolSchema(schema);
  assert.deepEqual(repaired.properties.list.items, {
    anyOf: [{ type: "string" }, { type: "null" }],
  });
  assert.deepEqual(repaired.properties.bag.additionalProperties, {
    anyOf: [{ type: "number" }, { type: "null" }],
  });
  assert.deepEqual(schema.properties.list.items, { type: ["string", "null"] });
});

test("the tool walker repairs parameters and inputSchema and keeps identity", () => {
  const parameters = imageGenParameters();
  const tool = {
    type: "function",
    name: "image_gen__imagegen",
    description: "Generate or edit images.",
    parameters,
    inputSchema: parameters,
  };
  const repaired = repairGeminiToolSchema(tool);
  assert.equal(repaired.type, "function");
  assert.equal(repaired.name, "image_gen__imagegen");
  assert.equal(repaired.description, "Generate or edit images.");
  assert.deepEqual(repaired.parameters.properties.referenced_image_paths, {
    anyOf: [
      {
        type: "array",
        items: { type: "string" },
        description: "Paths to images the edit should reference.",
      },
      { type: "null" },
    ],
  });
  assert.deepEqual(repaired.inputSchema, repaired.parameters);
  assert.ok(repaired.inputSchema.properties.referenced_image_paths.anyOf);
  // The caller's tool is not mutated, and a clean tool keeps its identity.
  assert.deepEqual(tool.parameters, parameters);
  const clean = { type: "function", name: "plain", parameters: { type: "object", properties: {} } };
  assert.equal(repairGeminiToolSchema(clean), clean);
  const list = [clean];
  assert.equal(repairGeminiToolSchemas(list), list);
});

test("namespace entries keep their shape and have children repaired", () => {
  const namespace = {
    type: "namespace",
    name: "image_gen",
    description: "Media tools.",
    tools: [
      {
        type: "function",
        name: "imagegen",
        inputSchema: imageGenParameters(),
      },
    ],
  };
  const repaired = repairGeminiToolSchemas([namespace]);
  assert.equal(repaired.length, 1);
  assert.equal(repaired[0].type, "namespace");
  assert.equal(repaired[0].name, "image_gen");
  assert.equal(repaired[0].description, "Media tools.");
  assert.equal(repaired[0].tools[0].name, "imagegen");
  assert.deepEqual(repaired[0].tools[0].inputSchema.properties.num_last_images_to_include, {
    anyOf: [{ type: "number" }, { type: "null" }],
  });

  const cleanNamespace = {
    type: "namespace",
    name: "clean",
    tools: [{ type: "function", name: "child", inputSchema: { type: "object" } }],
  };
  assert.equal(repairGeminiToolSchema(cleanNamespace), cleanNamespace);
});
