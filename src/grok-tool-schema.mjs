import { normalizeSchemaLiterals, providerToolSchema } from "./tool-schema-root.mjs";

const MAPS = ["$defs", "definitions", "properties", "patternProperties", "dependentSchemas", "dependencies"];
const ARRAYS = ["anyOf", "oneOf", "allOf", "prefixItems"];
const CHILDREN = ["additionalProperties", "unevaluatedProperties", "propertyNames", "items", "additionalItems", "unevaluatedItems", "contains", "contentSchema", "if", "then", "else", "not"];
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const union = (schema) => ["oneOf", "anyOf", "allOf"].some((key) => Array.isArray(schema?.[key]));

function resolveLocal(ref, root) {
  if (typeof ref !== "string" || !ref.startsWith("#")) return undefined;
  let pointer;
  try { pointer = decodeURIComponent(ref.slice(1)); } catch { return undefined; }
  if (!/^\/(?:\$defs|definitions)\//.test(pointer)) return undefined;
  let value = root;
  for (const raw of pointer.slice(1).split("/")) {
    if (/~(?:[^01]|$)/.test(raw)) return undefined;
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!object(value) || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return object(value) ? value : undefined;
}

// Definitions stay at their original paths. Moving branches cannot change
// #/$defs references, but a pointer into #/oneOf or a nested schema resource
// would require rebasing. Leave those schemas intact instead of guessing.
function safeToExpand(root) {
  const stack = [root];
  const seen = new Set();
  while (stack.length) {
    const schema = stack.pop();
    if (!object(schema) || seen.has(schema)) continue;
    seen.add(schema);
    if (seen.size > 8192) return false;
    if (["$anchor", "$dynamicAnchor", "$dynamicRef", "$recursiveRef", "$recursiveAnchor"]
      .some((key) => Object.hasOwn(schema, key))) return false;
    if (schema !== root && ["$id", "id", "$schema"].some((key) => Object.hasOwn(schema, key))) return false;
    if (typeof schema.$ref === "string" && schema.$ref.startsWith("#") && !resolveLocal(schema.$ref, root)) return false;
    for (const key of MAPS) if (object(schema[key])) stack.push(...Object.values(schema[key]));
    for (const key of [...ARRAYS, ...CHILDREN]) {
      if (Array.isArray(schema[key])) stack.push(...schema[key]);
      else if (object(schema[key])) stack.push(schema[key]);
    }
  }
  return true;
}

function literalDomain(schema, root, seen = new Set()) {
  if (!object(schema) || seen.has(schema)) return undefined;
  seen = new Set([...seen, schema]);
  // Draft-07 ignores siblings of $ref. A referenced domain is sound in both
  // dialects; a sibling const alone is not a proof for older schemas.
  if (schema.$ref) return literalDomain(resolveLocal(schema.$ref, root), root, seen);
  if (Object.hasOwn(schema, "const")) return [schema.const];
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum;
  return undefined;
}

// JSON Schema compares JSON values mathematically: -0 equals 0, also inside
// arrays/objects. Node's deepStrictEqual deliberately distinguishes them.
function equalJson(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => equalJson(value, right[index]));
  }
  if (!object(left) || !object(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && equalJson(left[key], right[key]));
}

function disjoint(left, right, root) {
  return (left.required || []).some((key) => {
    if (!right.required?.includes(key)) return false;
    const a = literalDomain(left.properties?.[key], root);
    const b = literalDomain(right.properties?.[key], root);
    return a && b && a.every((value) => b.every((other) => !equalJson(value, other)));
  });
}

// Reuse the same conservative reference and literal semantics when lowering
// complete alternatives to separate provider functions.
export { safeToExpand as canExpandGrokToolSchema, literalDomain as grokLiteralDomain, equalJson as equalJsonSchemaValue };

// The xAI proxy accepts a flat union of object branches, but rejects Codex's
// nested/ref-rooted automation union. The shared merger chooses the FIRST
// branch's property schemas and loses other modes and branch requirements.
// Keep complete alternatives instead. anyOf is associative; oneOf is not, so
// flatten it only after proving every leaf pair disjoint through required
// discriminator literals. No validator constraint is discarded or relocated.
export function grokToolSchema(schema) {
  if (!object(schema)) return schema ?? { type: "object", properties: {} };
  if (!union(schema)) return providerToolSchema(schema);
  // Preserve the provider boundary's literal repair even when the union must
  // stay intact. Disjointness must be proved against these normalized domains.
  schema = normalizeSchemaLiterals(schema);
  // const was introduced in Draft-06. Unknown dialects may assign different
  // meaning to the keywords used in the disjointness proof; do not guess.
  if (schema.$schema !== undefined && !/^https?:\/\/json-schema\.org\/(?:draft-0[67]\/schema|draft\/(?:2019-09|2020-12)\/schema)#?$/.test(schema.$schema)) return schema;
  if (Object.hasOwn(schema, "$ref")) return schema;
  const keyword = Array.isArray(schema.oneOf) ? "oneOf" : Array.isArray(schema.anyOf) ? "anyOf" : undefined;
  if (!keyword || !safeToExpand(schema)) return schema;
  let changed = false;
  let visits = 0;
  const expand = (branch, seen = new Set()) => {
    if (!object(branch) || seen.has(branch) || ++visits > 512) return undefined;
    seen = new Set([...seen, branch]);
    if (typeof branch.$ref === "string" && Object.keys(branch).length === 1) {
      const target = resolveLocal(branch.$ref, schema);
      if (!target) return undefined;
      changed = true;
      return expand(target, seen);
    }
    if (Array.isArray(branch[keyword]) && Object.keys(branch).length === 1) {
      changed = true;
      const nested = branch[keyword].map((child) => expand(child, seen));
      return nested.every(Boolean) ? nested.flat() : undefined;
    }
    // Draft-07 ignores every sibling of $ref, including type/properties. A
    // non-pure reference cannot establish an object leaf or discriminator.
    if (Object.hasOwn(branch, "$ref")) return undefined;
    return branch.type === "object" && !union(branch) ? [branch] : undefined;
  };
  const expanded = schema[keyword].map((branch) => expand(branch));
  if (!changed || !expanded.every(Boolean)) return schema;
  const branches = expanded.flat();
  if (keyword === "oneOf" && !branches.every((branch, index) =>
    branches.slice(index + 1).every((other) => disjoint(branch, other, schema)))) return schema;
  return { ...schema, [keyword]: branches };
}
