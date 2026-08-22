// xAI rejects any tool whose parameter schema does not have an object at the
// root: "tool parameter root must be an object type (root schema is an
// anyOf/oneOf union with a non-object branch)". The rejection fails the whole
// request, not the one tool, so a single union-rooted definition makes every
// turn on that provider a 400.
//
// Codex ships exactly such a tool: `codex_app__automation_update` roots its
// schema in a `oneOf` over the view/create/update/delete shapes. The router
// relays the app toolset to routed providers verbatim, which is how a Grok
// session that never touches automations still dies on its first message.
//
// Flattening keeps the tool callable: the branches are merged into one object
// so the model still sees every field it may send, with `required` narrowed to
// the fields every branch demands (usually none, because the branches are
// alternatives). Validation of which combination is legal stays where it
// already was -- the Codex app executes these calls and checks its own
// arguments.

const MAX_DEPTH = 8;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Resolves only local URI-fragment JSON Pointers: `#` and `#/...`. RFC 6901
// fragment decoding happens before `~1` / `~0` token decoding. Object own keys
// and canonical in-range array indexes are traversable; malformed fragments,
// anchors such as `#node`, and unsupported targets remain unresolved. The
// cycle repair deliberately does not infer semantics for `$dynamicRef` or
// `$recursiveRef` -- only an actual `$ref` crosses this boundary.
function resolveRef(ref, root) {
  if (typeof ref !== "string" || !ref.startsWith("#")) return undefined;
  let pointer;
  try {
    pointer = decodeURIComponent(ref.slice(1));
  } catch {
    return undefined;
  }
  if (pointer === "") return isPlainObject(root) ? root : undefined;
  if (!pointer.startsWith("/")) return undefined;

  let node = root;
  for (const rawSegment of pointer.slice(1).split("/")) {
    if (/~(?:[^01]|$)/.test(rawSegment)) return undefined;
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(node)) {
      if (!/^(?:0|[1-9]\d*)$/.test(segment)) return undefined;
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index >= node.length || !(index in node)) {
        return undefined;
      }
      node = node[index];
      continue;
    }
    if (!isPlainObject(node) || !Object.hasOwn(node, segment)) return undefined;
    node = node[segment];
  }
  return isPlainObject(node) ? node : undefined;
}

// OpenCode's Responses-compatible surfaces reject recursive local refs in a
// tool schema before the model sees the request. Keep definitions and every
// acyclic, boolean, or unresolved ref intact: expanding a shared ref DAG can
// grow exponentially, while deleting `$defs` leaves those refs dangling.
//
// A graph DFS marks only ref occurrences whose targets are still on the active
// stack. It follows only JSON Schema keywords that actually contain schemas;
// `$ref` strings inside const/default/examples/enum objects are literal data.
// Removing the marked back edges makes the reference graph acyclic. The second
// pass clones once and removes `$ref` only from the marked occurrence,
// preserving any sibling constraints. Both passes are iterative so a valid
// deeply nested tool schema cannot exhaust the JavaScript call stack. Schemas
// with no cycle keep identity.
const REF_SCHEMA_MAP_KEYWORDS = [
  "$defs",
  "definitions",
  "properties",
  "patternProperties",
  "dependentSchemas",
];
const REF_SCHEMA_ARRAY_KEYWORDS = ["allOf", "anyOf", "oneOf", "prefixItems"];
const REF_SCHEMA_CHILD_KEYWORDS = [
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

function schemaEdges(node, root) {
  const edges = [];
  const resolved = resolveRef(node.$ref, root);
  if (isPlainObject(resolved)) edges.push({ node: resolved, ref: true });

  for (const keyword of REF_SCHEMA_MAP_KEYWORDS) {
    const schemas = node[keyword];
    if (!isPlainObject(schemas)) continue;
    for (const schema of Object.values(schemas)) {
      if (isPlainObject(schema)) edges.push({ node: schema, ref: false });
    }
  }
  for (const keyword of REF_SCHEMA_ARRAY_KEYWORDS) {
    const schemas = node[keyword];
    if (!Array.isArray(schemas)) continue;
    for (const schema of schemas) {
      if (isPlainObject(schema)) edges.push({ node: schema, ref: false });
    }
  }
  for (const keyword of REF_SCHEMA_CHILD_KEYWORDS) {
    const schema = node[keyword];
    if (Array.isArray(schema)) {
      // Drafts before 2020-12 allowed tuple schemas directly under `items`.
      for (const entry of schema) {
        if (isPlainObject(entry)) edges.push({ node: entry, ref: false });
      }
    } else if (isPlainObject(schema)) {
      edges.push({ node: schema, ref: false });
    }
  }
  // Draft-07 `dependencies` mixes property-name arrays with schema values.
  const dependencies = node.dependencies;
  if (isPlainObject(dependencies)) {
    for (const schema of Object.values(dependencies)) {
      if (isPlainObject(schema)) edges.push({ node: schema, ref: false });
    }
  }
  return edges;
}

function cycleClosingLocalRefs(schema) {
  const state = new WeakMap();
  const closing = new WeakSet();
  let count = 0;
  state.set(schema, 1);
  const stack = [{ node: schema, edges: schemaEdges(schema, schema), index: 0 }];
  while (stack.length) {
    const frame = stack.at(-1);
    if (frame.index >= frame.edges.length) {
      state.set(frame.node, 2);
      stack.pop();
      continue;
    }
    const edge = frame.edges[frame.index];
    frame.index += 1;
    const targetState = state.get(edge.node);
    if (targetState === 1) {
      if (edge.ref && !closing.has(frame.node)) {
        closing.add(frame.node);
        count += 1;
      }
      continue;
    }
    if (targetState === 2) continue;
    state.set(edge.node, 1);
    stack.push({ node: edge.node, edges: schemaEdges(edge.node, schema), index: 0 });
  }
  return { closing, count };
}

function cloneWithoutClosingRefs(root, closing) {
  const clones = new WeakMap();
  const rootCopy = {};
  clones.set(root, rootCopy);
  const stack = [{ source: root, target: rootCopy }];
  while (stack.length) {
    const { source, target } = stack.pop();
    const entries = Array.isArray(source)
      ? source.map((value, index) => [index, value])
      : Object.entries(source);
    for (const [key, value] of entries) {
      if (key === "$ref" && closing.has(source)) continue;
      if (!Array.isArray(value) && !isPlainObject(value)) {
        target[key] = value;
        continue;
      }
      let copy = clones.get(value);
      if (!copy) {
        copy = Array.isArray(value) ? [] : {};
        clones.set(value, copy);
        stack.push({ source: value, target: copy });
      }
      target[key] = copy;
    }
  }
  return rootCopy;
}

export function nonRecursiveToolSchema(schema) {
  if (!isPlainObject(schema)) return schema;
  const { closing, count } = cycleClosingLocalRefs(schema);
  if (!count) return schema;
  return cloneWithoutClosingRefs(schema, closing);
}

// Every object-typed leaf reachable from `schema` through unions and local
// refs. `seen` guards the self-referential `$defs` Codex generates.
function objectBranches(schema, root, seen, depth = 0) {
  if (!isPlainObject(schema) || depth > MAX_DEPTH) return [];
  if (typeof schema.$ref === "string") {
    if (seen.has(schema.$ref)) return [];
    seen.add(schema.$ref);
    return objectBranches(resolveRef(schema.$ref, root), root, seen, depth + 1);
  }
  const branches = [];
  for (const keyword of ["anyOf", "oneOf", "allOf"]) {
    if (!Array.isArray(schema[keyword])) continue;
    for (const branch of schema[keyword]) {
      branches.push(...objectBranches(branch, root, seen, depth + 1));
    }
  }
  if (schema.type === "object" || isPlainObject(schema.properties)) branches.push(schema);
  return branches;
}

const UNION_KEYWORDS = ["anyOf", "oneOf", "allOf"];

function hasRootUnion(schema) {
  return UNION_KEYWORDS.some((keyword) => Array.isArray(schema[keyword]));
}

// xAI's rule is about the root *keywords*, not the declared type: a schema may
// say `type: "object"` and still be rejected for carrying a `oneOf` beside it.
// Checking only `type`/`properties` here is what let the live client's
// `automation_update` -- which sends both -- through untouched.
//
// A declared type is read literally, which is why a nullable root is not an
// object root. `type: ["object", "null"]` is a legal JSON Schema object that
// also permits null, and xAI rejects it with the same
// `tool parameter root must be an object type` as a union -- verified against
// the live backend. Only the exact string passes; a declared type that is
// anything else sends the schema down the rewrite path, and the `properties`
// fallback is left for schemas that declare no type at all.
export function hasObjectRoot(schema) {
  if (!isPlainObject(schema)) return false;
  if (hasRootUnion(schema)) return false;
  if (schema.type !== undefined) return schema.type === "object";
  return isPlainObject(schema.properties);
}

// Returns `schema` unchanged when its root is already a plain object, so the
// common case costs one type check and no copy.
export function objectRootToolSchema(schema) {
  if (!isPlainObject(schema)) return { type: "object", properties: {} };
  if (hasObjectRoot(schema)) return schema;

  const branches = objectBranches(schema, schema, new Set());
  const properties = {};
  // Root-level properties apply to every branch, so they win over branch
  // definitions of the same name.
  if (isPlainObject(schema.properties)) Object.assign(properties, schema.properties);
  for (const branch of branches) {
    if (!isPlainObject(branch.properties)) continue;
    for (const [name, property] of Object.entries(branch.properties)) {
      if (!(name in properties)) properties[name] = property;
    }
  }
  // Required only where every branch requires it: a field the view branch
  // demands is optional for the delete branch, and marking it required would
  // reject calls the app accepts. Root-level requirements are separate -- they
  // bind every branch, so they survive whatever the branches disagree about.
  const rootRequired = Array.isArray(schema.required) ? schema.required : [];
  const unionBranches = branches.filter((branch) => branch !== schema);
  const shared = unionBranches.length
    ? unionBranches
        .map((branch) => (Array.isArray(branch.required) ? branch.required : []))
        .reduce((left, right) => left.filter((name) => right.includes(name)))
    : [];
  const required = [...new Set([...rootRequired, ...shared])];

  return {
    ...(schema.$schema ? { $schema: schema.$schema } : {}),
    ...(schema.$defs ? { $defs: schema.$defs } : {}),
    ...(schema.definitions ? { definitions: schema.definitions } : {}),
    ...(typeof schema.description === "string" ? { description: schema.description } : {}),
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    // The merged object cannot describe which branch a call belongs to, so it
    // must not reject fields that only one branch declares. A root that was
    // rewritten without merging anything -- a nullable `type: ["object","null"]`
    // becoming plain `"object"` -- has no such ambiguity, so it keeps whatever
    // it declared rather than being quietly opened up.
    ...(unionBranches.length || schema.additionalProperties === undefined
      ? { additionalProperties: true }
      : { additionalProperties: schema.additionalProperties }),
  };
}

// Moonshot validates every enum/const literal against the type its own node
// declares, and rejects the whole request -- not the one tool -- on a mismatch:
//
//   tools.function.parameters is not a valid moonshot flavored json schema,
//   details: <At path 'properties.appTaskLane.properties.enabled.enum':
//            enum value (true) does not match any type in [string]>
//
// The contradiction is the client's: mergeCodexAppTools lets client-provided
// definitions win, so it cannot be repaired in the bundled snapshot. Drop the
// offending literal rather than coercing it. A literal that contradicts its own
// declared type could never validate, so dropping it cannot change a well-formed
// schema; coercing `true` to `"true"` would instead tell the model to send a
// value the app never asked for.

const MAX_LITERAL_DEPTH = 32;
const SCHEMA_MAP_KEYWORDS = ["properties", "patternProperties", "$defs", "definitions"];
const SCHEMA_LIST_KEYWORDS = ["anyOf", "oneOf", "allOf", "prefixItems"];
const SCHEMA_CHILD_KEYWORDS = [
  "items",
  "additionalProperties",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "propertyNames",
];

function jsonTypeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "object") return "object";
  return undefined;
}

function declaredTypes(schema) {
  if (typeof schema.type === "string") return [schema.type];
  if (Array.isArray(schema.type)) return schema.type.filter((entry) => typeof entry === "string");
  return [];
}

function matchesDeclaredType(value, types) {
  const actual = jsonTypeOf(value);
  if (actual === undefined) return false;
  if (types.includes(actual)) return true;
  // JSON Schema counts every integer as a number.
  return actual === "integer" && types.includes("number");
}

// Returns `schema` by identity when nothing contradicts, so a clean toolset
// costs one walk and no copy, and the client's object is never mutated.
export function normalizeSchemaLiterals(schema, depth = 0) {
  if (!isPlainObject(schema) || depth > MAX_LITERAL_DEPTH) return schema;
  let next = schema;
  const replace = (key, value) => {
    if (next === schema) next = { ...schema };
    if (value === undefined) delete next[key];
    else next[key] = value;
  };

  const types = declaredTypes(schema);
  if (types.length) {
    if (Array.isArray(schema.enum)) {
      const kept = schema.enum.filter((value) => matchesDeclaredType(value, types));
      if (kept.length !== schema.enum.length) replace("enum", kept.length ? kept : undefined);
    }
    if ("const" in schema && !matchesDeclaredType(schema.const, types)) {
      replace("const", undefined);
    }
  }

  for (const keyword of SCHEMA_MAP_KEYWORDS) {
    const node = schema[keyword];
    if (!isPlainObject(node)) continue;
    let changed = false;
    const rewritten = {};
    for (const [name, child] of Object.entries(node)) {
      const sanitized = normalizeSchemaLiterals(child, depth + 1);
      if (sanitized !== child) changed = true;
      rewritten[name] = sanitized;
    }
    if (changed) replace(keyword, rewritten);
  }

  for (const keyword of [...SCHEMA_LIST_KEYWORDS, ...SCHEMA_CHILD_KEYWORDS]) {
    const node = schema[keyword];
    if (Array.isArray(node)) {
      let changed = false;
      const rewritten = node.map((child) => {
        const sanitized = normalizeSchemaLiterals(child, depth + 1);
        if (sanitized !== child) changed = true;
        return sanitized;
      });
      if (changed) replace(keyword, rewritten);
      continue;
    }
    if (!isPlainObject(node)) continue;
    const sanitized = normalizeSchemaLiterals(node, depth + 1);
    if (sanitized !== node) replace(keyword, sanitized);
  }

  return next;
}

// The one provider-facing normalization: literals aligned with the type their
// own node declares, and a union root merged into a plain object. Returns
// `schema` unchanged when neither applies.
//
// Deliberately narrower than objectRootToolSchema alone. That function collapses
// *any* root it cannot recognize -- an array root, a bare `type: "string"`, an
// empty object -- into `{type:"object", properties:{}}`, discarding the real
// schema. That is the right trade for xAI, which rejects every non-object root
// outright. It is the wrong trade here: this runs on every namespace and MCP
// tool, where a server-defined schema that merely looks unusual would be
// silently replaced with one accepting anything. Only a union root is the
// documented strict-upstream rejection, so only a union root is rewritten.
// A root `type` array that offers "object" among others -- the nullable object
// root. Narrow on purpose: an array that cannot be an object at all is left
// alone, because collapsing it would replace a real schema with one accepting
// anything, which is the trade this function exists to avoid.
function hasNullableObjectRoot(schema) {
  return Array.isArray(schema.type) && schema.type.includes("object");
}

export function providerToolSchema(schema) {
  const normalized = normalizeSchemaLiterals(schema);
  if (!isPlainObject(normalized)) return normalized;
  // Two independent upstreams reject a nullable object root by name, which is
  // what promotes it from "unusual" to documented alongside the union:
  //
  //   xAI:      tool parameter root must be an object type
  //   DeepSeek: schema must be a JSON Schema of 'type: "object"',
  //             got 'type: ["object","null"]'
  //
  // Both were reproduced live. The repair is lossless here -- properties,
  // required and additionalProperties all survive -- because only the root's
  // own `null` alternative is dropped, and a tool call whose entire argument
  // object is null is not a call any of these providers can dispatch.
  if (!hasRootUnion(normalized) && !hasNullableObjectRoot(normalized)) return normalized;
  return objectRootToolSchema(normalized);
}
