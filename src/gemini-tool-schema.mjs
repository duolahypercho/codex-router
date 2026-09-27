// Gemini rejected image_gen's nullable type arrays after upstream translation
// introduced anyOf with sibling fields. Spell one concrete type plus null as
// an explicit union instead; retain its type-specific constraints on the
// non-null branch. The Google AI SDK recognizes this shape and flattens it to
// a nullable concrete type, without the invalid anyOf siblings:
// https://github.com/vercel/ai/blob/main/packages/google/src/convert-json-schema-to-openapi-schema.ts
//
// Only simple nullable nodes are rewritten. Composition and reference keywords
// can constrain null or depend on their location; enum/const use a separate
// upstream conversion path. Leave those shapes unchanged.
const REWRITE_BLOCKERS = [
  // Composition and conditional keywords apply regardless of the instance
  // type, so moving them onto one branch could change what the schema accepts.
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  // Identity and container keywords are not constraints; moving them would
  // change how references inside the schema resolve.
  "$ref",
  "$defs",
  "definitions",
  "$id",
  "$anchor",
  "$dynamicAnchor",
  "$dynamicRef",
  "$recursiveRef",
  "$schema",
  // Literals: see the note above.
  "enum",
  "const",
];

// JSON Schema positions. `$defs`, `properties` and friends are maps of
// schemas, the union keywords are arrays of schemas, and the remaining
// keywords each hold one schema. Literal data under `const`, `default`,
// `examples` and `enum` is never entered: an object that merely looks like a
// schema there is a value the tool accepts, not a schema.
const SCHEMA_MAP_KEYWORDS = [
  "$defs",
  "definitions",
  "properties",
  "patternProperties",
  "dependentSchemas",
];
const SCHEMA_LIST_KEYWORDS = ["allOf", "anyOf", "oneOf", "prefixItems"];
const SCHEMA_CHILD_KEYWORDS = [
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
];

const MAX_DEPTH = 32;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The single non-null member of a nullable type array, or undefined when the
// shape is anything else -- including `["null"]` alone, which the converter
// already turns into a bare `type: "null"`, and a multi-type union, which it
// still emits as `anyOf` with siblings and is not a shape this route has
// demonstrated.
function nullableTypeMember(type) {
  if (!Array.isArray(type) || !type.includes("null")) return undefined;
  const nonNull = type.filter((entry) => entry !== "null");
  if (nonNull.length !== 1 || typeof nonNull[0] !== "string") return undefined;
  return nonNull[0];
}

// Returns `schema` by identity when the shape is not the one to repair, so an
// ordinary node costs one check and no copy.
function rewriteNullableTypeArray(schema) {
  const nonNullType = nullableTypeMember(schema.type);
  if (nonNullType === undefined) return schema;
  if (REWRITE_BLOCKERS.some((keyword) => Object.hasOwn(schema, keyword))) return schema;
  const { type: _nullableTypeArray, ...branch } = schema;
  return {
    anyOf: [{ type: nonNullType, ...branch }, { type: "null" }],
  };
}

function repairSchemaNode(schema, depth) {
  if (!isPlainObject(schema) || depth > MAX_DEPTH) return schema;
  let next = rewriteNullableTypeArray(schema);
  // Copy-on-write: `next` is already this function's own object when the node
  // was rewritten, and a copy of the caller's object otherwise.
  const replace = (key, value) => {
    if (next === schema) next = { ...schema };
    next[key] = value;
  };
  const repairChild = (child) => repairSchemaNode(child, depth + 1);

  for (const keyword of SCHEMA_MAP_KEYWORDS) {
    const schemas = next[keyword];
    if (!isPlainObject(schemas)) continue;
    let changed = false;
    const rewritten = Object.create(null);
    for (const [name, child] of Object.entries(schemas)) {
      const repaired = repairChild(child);
      if (repaired !== child) changed = true;
      rewritten[name] = repaired;
    }
    if (changed) replace(keyword, rewritten);
  }

  for (const keyword of [...SCHEMA_LIST_KEYWORDS, ...SCHEMA_CHILD_KEYWORDS]) {
    const children = next[keyword];
    if (Array.isArray(children)) {
      // Drafts before 2020-12 allowed tuple schemas directly under `items`.
      let changed = false;
      const rewritten = children.map((child) => {
        const repaired = repairChild(child);
        if (repaired !== child) changed = true;
        return repaired;
      });
      if (changed) replace(keyword, rewritten);
      continue;
    }
    if (!isPlainObject(children)) continue;
    const repaired = repairChild(children);
    if (repaired !== children) replace(keyword, repaired);
  }

  // Draft-07 `dependencies` mixes property-name arrays with schema values.
  const dependencies = next.dependencies;
  if (isPlainObject(dependencies)) {
    let changed = false;
    const rewritten = Object.create(null);
    for (const [name, child] of Object.entries(dependencies)) {
      const repaired = isPlainObject(child) ? repairChild(child) : child;
      if (repaired !== child) changed = true;
      rewritten[name] = repaired;
    }
    if (changed) replace("dependencies", rewritten);
  }

  return next;
}

// One parameter schema, in the shape the provider will convert. Returns the
// input by identity when it carries no nullable type array, so a clean toolset
// is never copied and the caller's object is never mutated. Applying the
// result again is a no-op: the rewritten node has `anyOf` and no `type` array.
export function geminiToolSchema(schema) {
  if (!isPlainObject(schema)) return schema;
  return repairSchemaNode(schema, 0);
}

// The provider-facing `parameters` and the client's native `inputSchema` both
// reach the wire on a flattened namespace child, so both are repaired. Native
// namespace entries keep their shape and have their children repaired.
export function repairGeminiToolSchema(tool) {
  if (tool?.type === "namespace" && Array.isArray(tool.tools)) {
    let changed = false;
    const children = tool.tools.map((child) => {
      const repaired = repairGeminiToolSchema(child);
      if (repaired !== child) changed = true;
      return repaired;
    });
    return changed ? { ...tool, tools: children } : tool;
  }

  let repairedTool = tool;
  let changed = false;
  if (tool?.function?.parameters !== undefined) {
    const parameters = geminiToolSchema(tool.function.parameters);
    if (parameters !== tool.function.parameters) {
      repairedTool = {
        ...repairedTool,
        function: { ...repairedTool.function, parameters },
      };
      changed = true;
    }
  }
  for (const field of ["parameters", "inputSchema"]) {
    const schema = tool?.[field];
    if (schema === undefined) continue;
    const repaired = geminiToolSchema(schema);
    if (repaired === schema) continue;
    repairedTool = { ...repairedTool, [field]: repaired };
    changed = true;
  }
  return changed ? repairedTool : tool;
}

// Array form for the router's tool boundary. Returns the original array when
// nothing needed repair, so an ordinary request is not copied.
export function repairGeminiToolSchemas(tools) {
  if (!Array.isArray(tools)) return tools;
  let changed = false;
  const repaired = tools.map((tool) => {
    const next = repairGeminiToolSchema(tool);
    if (next !== tool) changed = true;
    return next;
  });
  return changed ? repaired : tools;
}
