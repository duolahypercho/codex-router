import { jsonArgumentsAreUnambiguous } from "./namespace-relay.mjs";

// A pure, deliberately limited representation of native apply_patch. This
// module does not read files, match context, apply edits, or call a provider.
export const GROK_STRUCTURED_PATCH_VERSION = 1;
export function grokStructuredPatchEnabled(route, environment = process.env) {
  return route?.slug === "grok-oauth/grok-4.6" && environment.CODEX_ROUTER_GROK_STRUCTURED_PATCH === "1";
}
export const MAX_STRUCTURED_PATCH_BYTES = 1024 * 1024;
const MAX_OPERATIONS = 128;
const MAX_HUNKS = 512;
const MAX_LINES = 16384;
const MAX_LINE_LENGTH = 65536;

export class StructuredPatchError extends Error {
  constructor(code) {
    super(`Invalid structured apply_patch arguments (${code}).`);
    this.name = "StructuredPatchError";
    this.code = code;
  }
}

function reject(code) {
  throw new StructuredPatchError(code);
}

function object(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject("object_required");
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) reject("plain_object_required");
  const allowed = new Set([...required, ...optional]);
  if (Reflect.ownKeys(value).some((key) => !allowed.has(key))) reject("unknown_field");
  if (required.some((key) => !Object.hasOwn(value, key))) reject("missing_field");
  // Reject accessor-backed object fields before reading them. Wire JSON
  // cannot contain accessors; the object API is intended for plain JSON data.
  if (Object.values(Object.getOwnPropertyDescriptors(value)).some((d) => !Object.hasOwn(d, "value"))) {
    reject("accessor_field");
  }
}

function array(value, min, max) {
  if (!Array.isArray(value) || value.length < min || value.length > max) reject("array_bounds");
  for (let i = 0; i < value.length; i += 1) {
    if (!Object.hasOwn(value, i)) reject("sparse_array");
    if (!Object.hasOwn(Object.getOwnPropertyDescriptor(value, i), "value")) reject("accessor_field");
  }
}

function line(value) {
  if (typeof value !== "string") reject("string_required");
  if (value.length > MAX_LINE_LENGTH) reject("line_too_long");
  if (/[\r\n\0]/u.test(value)) reject("embedded_line_separator");
  if (!value.isWellFormed()) reject("invalid_unicode");
  return value;
}

function path(value) {
  line(value);
  // Native headers trim paths, and Rust's trim also removes Unicode white space
  // (such as U+0085) that JavaScript's leaves. Refuse inputs whose literal path
  // would change under either.
  if (!value || value.trim() !== value || /^\p{White_Space}|\p{White_Space}$/u.test(value)) {
    reject("nonliteral_path");
  }
  return value;
}

/** Serialize the whole edit or throw, never return a partially valid patch. */
export function serializeStructuredPatch(value) {
  object(value, ["operations"]);
  array(value.operations, 1, MAX_OPERATIONS);
  const output = ["*** Begin Patch"];
  let bytes = Buffer.byteLength(output[0], "utf8");
  const append = (text) => {
    bytes += 1 + Buffer.byteLength(text, "utf8");
    if (bytes > MAX_STRUCTURED_PATCH_BYTES) reject("patch_too_large");
    output.push(text);
  };
  const paths = new Set();
  for (const operation of value.operations) {
    object(operation, ["op", "path"], ["lines", "hunks"]);
    const target = path(operation.path);
    if (paths.has(target)) reject("duplicate_path");
    paths.add(target);
    switch (operation.op) {
      case "add": {
        object(operation, ["op", "path", "lines"]);
        array(operation.lines, 0, MAX_LINES);
        append(`*** Add File: ${target}`);
        for (const text of operation.lines) append(`+${line(text)}`);
        break;
      }
      case "delete":
        object(operation, ["op", "path"]);
        append(`*** Delete File: ${target}`);
        break;
      case "update": {
        object(operation, ["op", "path", "hunks"]);
        array(operation.hunks, 1, MAX_HUNKS);
        append(`*** Update File: ${target}`);
        for (const [index, hunk] of operation.hunks.entries()) {
          object(hunk, ["lines"], ["anchor", "endOfFile"]);
          if (Object.hasOwn(hunk, "anchor")) {
            line(hunk.anchor);
            if (!hunk.anchor) reject("empty_anchor");
          }
          if (Object.hasOwn(hunk, "endOfFile") && typeof hunk.endOfFile !== "boolean") {
            reject("boolean_required");
          }
          if (hunk.endOfFile && index !== operation.hunks.length - 1) reject("nonfinal_eof");
          array(hunk.lines, 1, MAX_LINES);
          append(Object.hasOwn(hunk, "anchor") ? `@@ ${hunk.anchor}` : "@@");
          let changed = false;
          for (const entry of hunk.lines) {
            object(entry, ["kind", "text"]);
            const prefix = { context: " ", add: "+", remove: "-" };
            if (typeof entry.kind !== "string" || !Object.hasOwn(prefix, entry.kind)) reject("unsupported_line_kind");
            changed ||= entry.kind !== "context";
            append(`${prefix[entry.kind]}${line(entry.text)}`);
          }
          if (!changed) reject("no_change");
          if (hunk.endOfFile) append("*** End of File");
        }
        break;
      }
      default:
        reject("unsupported_operation");
    }
  }
  append("*** End Patch");
  return output.join("\n");
}

/** Reject duplicate JSON keys rather than accepting JSON.parse's last value. */
export function compileStructuredPatchArguments(argumentsText) {
  return serializeStructuredPatch(normalizeGrokEdit(parseArgumentObject(argumentsText)));
}

function splitLogicalLines(text) {
  if (typeof text !== "string") reject("string_required");
  if (/\r/u.test(text)) reject("crlf_unrepresentable");
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function parseArgumentObject(argumentsText) {
  if (typeof argumentsText !== "string") reject("json_string_required");
  if (Buffer.byteLength(argumentsText, "utf8") > MAX_STRUCTURED_PATCH_BYTES) reject("arguments_too_large");
  if (!jsonArgumentsAreUnambiguous(argumentsText)) reject("ambiguous_or_invalid_json");
  try {
    return JSON.parse(argumentsText);
  } catch {
    reject("ambiguous_or_invalid_json");
  }
}

export function compileSearchReplaceArguments(argumentsText) {
  return serializeStructuredPatch(searchReplaceToOperations(parseArgumentObject(argumentsText)));
}

export function compileWriteArguments(argumentsText) {
  return serializeStructuredPatch(writeToOperations(parseArgumentObject(argumentsText)));
}

function searchReplaceToOperations(value) {
  object(value, ["path", "old_string", "new_string"]);
  if (typeof value.old_string !== "string" || value.old_string.length === 0) reject("empty_old_string");
  if (value.old_string === value.new_string) reject("no_change");
  if (/(?:\n)$/u.test(value.old_string) !== /(?:\n)$/u.test(value.new_string)) {
    reject("trailing_newline_unrepresentable");
  }
  const removed = splitLogicalLines(value.old_string);
  const added = splitLogicalLines(value.new_string);
  if (removed.length === 0 && added.length === 0) reject("no_change");
  if (removed.length === added.length && removed.every((text, index) => text === added[index])) {
    reject("trailing_newline_unrepresentable");
  }
  return {
    operations: [{
      op: "update",
      path: value.path,
      hunks: [{
        lines: [
          ...removed.map((text) => ({ kind: "remove", text })),
          ...added.map((text) => ({ kind: "add", text })),
        ],
      }],
    }],
  };
}

function writeToOperations(value) {
  object(value, ["path", "contents"]);
  if (value.contents !== "" && !/(?:\r?\n)$/u.test(value.contents)) {
    reject("missing_trailing_newline");
  }
  return {
    operations: [{
      op: "add",
      path: value.path,
      lines: splitLogicalLines(value.contents),
    }],
  };
}

function parseOperationsField(operations) {
  if (typeof operations === "string") {
    if (!jsonArgumentsAreUnambiguous(operations)) reject("ambiguous_or_invalid_json");
    try {
      return JSON.parse(operations);
    } catch {
      reject("ambiguous_or_invalid_json");
    }
  }
  return operations;
}

function mergeUpdateOperations(value) {
  const operations = parseOperationsField(value.operations);
  if (!Array.isArray(operations)) return { ...value, operations };
  if (operations.length < 1 || operations.length > MAX_OPERATIONS) reject("array_bounds");
  for (const operation of operations) {
    serializeStructuredPatch({ operations: [operation] });
  }
  const merged = [];
  const updateAt = new Map();
  for (const operation of operations) {
    if (operation && operation.op === "update" && typeof operation.path === "string") {
      const index = updateAt.get(operation.path);
      if (index !== undefined) {
        const current = merged[index];
        merged[index] = {
          ...current,
          hunks: [...current.hunks, ...operation.hunks],
        };
        continue;
      }
      updateAt.set(operation.path, merged.length);
    }
    merged.push(operation);
  }
  return { ...value, operations: merged };
}

function normalizeGrokEdit(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject("object_required");
  if (Object.hasOwn(value, "operations")) return mergeUpdateOperations(value);
  if (Object.hasOwn(value, "old_string") || Object.hasOwn(value, "new_string")) {
    return searchReplaceToOperations(value);
  }
  if (Object.hasOwn(value, "contents")) return writeToOperations(value);
  reject("missing_field");
}

const textSchema = { type: "string", maxLength: MAX_LINE_LENGTH };
const pathSchema = { ...textSchema, minLength: 1 };
const linesSchema = { type: "array", maxItems: MAX_LINES, items: textSchema };
const objectSchema = (properties, required = Object.keys(properties)) => ({
  type: "object", properties, required, additionalProperties: false,
});

// Not installed on any route yet. The request/response bridge must first prove
// history, collisions and streaming safety before this schema can be offered.
export const GROK_STRUCTURED_PATCH_PARAMETERS = objectSchema({
  operations: {
    type: "array", minItems: 1, maxItems: MAX_OPERATIONS,
    items: {
      anyOf: [
        objectSchema({ op: { const: "add", type: "string" }, path: pathSchema, lines: linesSchema }),
        objectSchema({ op: { const: "delete", type: "string" }, path: pathSchema }),
        objectSchema({
          op: { const: "update", type: "string" }, path: pathSchema,
          hunks: {
            type: "array", minItems: 1, maxItems: MAX_HUNKS,
            items: objectSchema({
              anchor: textSchema,
              endOfFile: { type: "boolean" },
              lines: {
                type: "array", minItems: 1, maxItems: MAX_LINES,
                items: objectSchema({
                  kind: { type: "string", enum: ["context", "add", "remove"] },
                  text: textSchema,
                }),
              },
            }, ["lines"]),
          },
        }),
      ],
    },
  },
});

export const GROK_STRUCTURED_PATCH_CODEC = {
  version: GROK_STRUCTURED_PATCH_VERSION,
  parameters: GROK_STRUCTURED_PATCH_PARAMETERS,
  maxArgumentBytes: MAX_STRUCTURED_PATCH_BYTES,
  decodeArguments: compileStructuredPatchArguments,
  description(original) {
    return [
      typeof original === "string" ? original : "Apply a patch to files.",
      "This provider interface accepts structured operations, not raw patch text. Supply literal logical lines without patch delimiters or line prefixes; use context/add/remove kinds inside update hunks. Codex performs the original patch validation and permission checks. Old calls in history may have an input field containing native patch text; that historical envelope is not accepted for new calls.",
    ].filter(Boolean).join("\n\n");
  },
};
