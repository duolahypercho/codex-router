// Editing exactly one key of somebody else's configuration document.
//
// Every routed harness keeps its providers in a file the user also edits, and
// that its own UI writes beside ours. So the rule these helpers exist to
// enforce is the one `dsh-config-manager.mjs` states first: this router owns a
// single key path and treats every other byte as somebody else's work.
// Anything that cannot be read plainly is refused with the file untouched,
// rather than reformatted into something we can read.
//
// Two document formats, because the clients chose differently:
//
//   json  opencode, pi, Command Code   parse, set one key, re-serialize
//   yaml  omp, Hermes Agent            splice one block, leave the rest as text
//
// The JSON path round-trips through `JSON.parse`, which loses comments — so a
// document that is not plain JSON is refused rather than silently stripped.
// The YAML path never parses the file at all: it locates the router's block by
// line range and replaces those lines, which is why a user's comments,
// anchors, and hand-formatting survive a publish.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { protectPrivateFile } from "./file-security.mjs";
import { scanYamlDocument, spliceYamlBlock, yamlNode, yamlScalar } from "./yaml-structure.mjs";

/** Reads a client's document, or "" when it does not exist yet. */
export function readHarnessDocument(target) {
  return existsSync(target) ? readFileSync(target, "utf8") : "";
}

/**
 * Writes a client's document atomically, private to this user.
 *
 * Every document this module writes carries the caller base URL, and that URL
 * *is* the local authentication capability — the secret is a path segment. So
 * these files are 0600 under a 0700 directory whether or not the client would
 * have created them that way itself.
 */
export function writeHarnessDocument(target, contents) {
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp.${process.pid}`;
  writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
  try {
    protectPrivateFile(temporary);
    renameSync(temporary, target);
    protectPrivateFile(target);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
  return target;
}

// ---------------------------------------------------------------------------
// JSON documents
// ---------------------------------------------------------------------------

function parseJsonDocument(contents, label) {
  const text = String(contents ?? "").trim();
  if (!text) return {};
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    // JSONC is legal in several of these clients, and a `//` comment is the
    // likeliest reason a real file lands here. Re-serializing would delete it,
    // so say what is wrong and change nothing.
    throw new Error(
      `${label} is not plain JSON (comments and trailing commas cannot be preserved by this router); ` +
        "fix or move it, then publish again.",
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} does not hold a JSON object; refusing to change client state.`);
  }
  return value;
}

function jsonAt(document, keyPath) {
  let node = document;
  for (const key of keyPath) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return undefined;
    node = node[key];
  }
  return node;
}

function assertJsonContainers(document, keyPath, label) {
  let node = document;
  for (const key of keyPath.slice(0, -1)) {
    const next = node[key];
    if (next === undefined) return;
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      throw new Error(
        `${label} holds "${keyPath.slice(0, keyPath.indexOf(key) + 1).join(".")}" as something other ` +
          "than an object; refusing to change client state.",
      );
    }
    node = next;
  }
}

/** The current value at `keyPath`, or undefined. Throws on an unreadable document. */
export function jsonDocumentValue(contents, keyPath, label) {
  return jsonAt(parseJsonDocument(contents, label), keyPath);
}

/** Returns the document text with `keyPath` set to `value`, creating parents. */
export function applyJsonValue(contents, keyPath, value, label) {
  const document = parseJsonDocument(contents, label);
  assertJsonContainers(document, keyPath, label);
  let node = document;
  for (const key of keyPath.slice(0, -1)) {
    if (!node[key] || typeof node[key] !== "object" || Array.isArray(node[key])) node[key] = {};
    node = node[key];
  }
  node[keyPath.at(-1)] = value;
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * Returns the document text with `keyPath` removed.
 *
 * A container left holding nothing is removed with it, but only when this
 * removal is what emptied it: a `provider: {}` the user wrote themselves is
 * their file, not litter from ours.
 */
export function removeJsonValue(contents, keyPath, label) {
  const document = parseJsonDocument(contents, label);
  const chain = [document];
  for (const key of keyPath.slice(0, -1)) {
    const next = chain.at(-1)?.[key];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      return `${JSON.stringify(document, null, 2)}\n`;
    }
    chain.push(next);
  }
  delete chain.at(-1)[keyPath.at(-1)];
  for (let depth = chain.length - 1; depth > 0; depth -= 1) {
    if (Object.keys(chain[depth]).length) break;
    delete chain[depth - 1][keyPath[depth - 1]];
  }
  return `${JSON.stringify(document, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// YAML documents
// ---------------------------------------------------------------------------

function joinLines(lines) {
  const text = lines.join("\n");
  return text.endsWith("\n") || text === "" ? text : `${text}\n`;
}

// Splitting on newlines yields a trailing empty element for the final newline,
// and splicing beside it is how a document grows one blank line per write.
// Leading blanks are the same story for a file that started empty.
function normalizeTrailing(lines) {
  const copy = [...lines];
  while (copy.length > 1 && copy.at(-1) === "" && copy.at(-2) === "") copy.pop();
  while (copy.length > 1 && copy[0] === "") copy.shift();
  return copy;
}

// A mapping key that is a plain identifier can be written bare; anything else —
// a routed slug carrying `/`, `.`, or `:` — is quoted. Getting this wrong is
// not cosmetic: `codex_router/anthropic/x-ai/grok-4.6: {}` parses, but
// `anthropic/claude: {}` inside a flow context does not, and a model id
// beginning with a YAML indicator would silently become something else.
function yamlKey(key) {
  return /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(String(key)) ? String(key) : yamlScalar(key);
}

function yamlValueScalar(value) {
  if (value === null) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : yamlScalar(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return yamlScalar(value);
}

/**
 * Renders a plain object as block YAML at `indent`.
 *
 * Only the shapes these adapters produce are covered: nested mappings, arrays
 * of scalars, and arrays of flat mappings. `undefined` entries are dropped so a
 * builder can omit a field by leaving it out rather than by branching.
 */
export function renderYamlMapping(value, indent = "", lines = []) {
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    if (Array.isArray(entry)) {
      if (!entry.length) {
        lines.push(`${indent}${yamlKey(key)}: []`);
        continue;
      }
      lines.push(`${indent}${yamlKey(key)}:`);
      for (const item of entry) {
        if (item && typeof item === "object") {
          const nested = [];
          renderYamlMapping(item, `${indent}    `, nested);
          lines.push(`${indent}  - ${nested[0].trimStart()}`, ...nested.slice(1));
        } else {
          lines.push(`${indent}  - ${yamlValueScalar(item)}`);
        }
      }
      continue;
    }
    if (entry && typeof entry === "object") {
      // An empty mapping has to be written inline: a bare `key:` reads as null,
      // and Hermes tells apart "this model has no declared options" from "this
      // model is null" the same way every YAML reader does.
      if (!Object.keys(entry).length) {
        lines.push(`${indent}${yamlKey(key)}: {}`);
        continue;
      }
      lines.push(`${indent}${yamlKey(key)}:`);
      renderYamlMapping(entry, `${indent}  `, lines);
      continue;
    }
    lines.push(`${indent}${yamlKey(key)}: ${yamlValueScalar(entry)}`);
  }
  return lines;
}

/** Returns the document text with `keyPath` replaced by `value`, as block YAML. */
// Lines inside `node`'s indented region that none of its registered children
// account for.
//
// Two separate blind spots make `children.size` an unsafe proxy for "this node
// holds nothing but ours":
//
//   - `children` is the lexer's map of mapping keys it was able to register. A
//     block sequence, a merge key, or a key `PLAIN_KEY` declines is invisible
//     there while still living inside the node. This is how removal came to
//     splice away a whole `providers:` sequence and leave a zero-byte file.
//   - `endIndex` deliberately stops before a trailing comment block, so a
//     comment the publish step pushed below our key sits outside the node's
//     own range while still being spliced away with it.
//
// So the region is walked by indentation -- every following line that is blank
// or indented deeper than the node -- rather than read off `endIndex`.
function unaccountedLines(document, node) {
  const covered = new Set();
  for (const child of node.children.values()) {
    for (let index = child.index; index <= child.endIndex; index += 1) covered.add(index);
  }
  const rest = [];
  for (let index = node.index + 1; index < document.lines.length; index += 1) {
    const text = String(document.lines[index] ?? "");
    if (/^\s*$/.test(text)) continue;
    const indent = text.length - text.replace(/^\s*/, "").length;
    if (indent <= node.indent) break;
    if (covered.has(index)) continue;
    rest.push({ index, text });
  }
  return rest;
}

export function applyYamlValue(contents, keyPath, value) {
  const document = scanYamlDocument(contents);
  const parent = keyPath.length > 1 ? yamlNode(document, keyPath.slice(0, -1)) : undefined;
  if (parent?.inline) {
    throw new Error(
      `Refusing to edit ${keyPath.slice(0, -1).join(".")}: it is written as an inline value rather than a block.`,
    );
  }
  // The mapping we are about to add a key to must be one the lexer read whole.
  // If it holds a line no registered child accounts for, the shape on disk is
  // not the shape `children` describes -- a block sequence, or a key such as
  // `openrouter/free:` that the key grammar declines -- and splicing a mapping
  // entry in either produces invalid YAML or nests our key inside the user's
  // provider while every status read agrees it went in cleanly. Refuse with the
  // file untouched, as the rest of this module does.
  const unreadable = parent && unaccountedLines(document, parent).filter(
    (line) => !/^\s*#/.test(line.text),
  );
  if (unreadable?.length) {
    throw new Error(
      `Refusing to edit ${keyPath.slice(0, -1).join(".")}: line ${unreadable[0].index + 1} `
        + `(${unreadable[0].text.trim()}) is not a mapping entry this reader can account for.`,
    );
  }
  // Follow whatever indentation the document already uses for a sibling entry
  // rather than assuming two spaces: a block indented differently from the ones
  // beside it parses, but reads as though something went wrong.
  const sibling = parent && [...parent.children.values()][0];
  const indent = sibling
    ? " ".repeat(sibling.indent)
    : parent
      ? " ".repeat(parent.indent + 2)
      : "  ".repeat(keyPath.length - 1);
  const leaf = yamlKey(keyPath.at(-1));
  const rendered = value && typeof value === "object" && !Array.isArray(value)
    ? [`${indent}${leaf}:`, ...renderYamlMapping(value, `${indent}  `, [])]
    : [`${indent}${leaf}: ${yamlValueScalar(value)}`];
  return joinLines(normalizeTrailing(spliceYamlBlock(document, keyPath, rendered)));
}

/**
 * Returns the document text with `keyPath` removed.
 *
 * A parent mapping left holding nothing goes with it. An empty mapping is not
 * the same as an absent one — a valueless key reads as null, not as "no
 * providers" — and the only way one can be left behind is that publishing
 * created it.
 */
export function removeYamlValue(contents, keyPath) {
  const document = scanYamlDocument(contents);
  const node = yamlNode(document, keyPath);
  if (!node) return joinLines(normalizeTrailing(document.lines));
  let removal = node;
  for (let depth = keyPath.length - 1; depth > 0; depth -= 1) {
    const parent = yamlNode(document, keyPath.slice(0, depth));
    if (!parent || parent.children.size !== 1) break;
    // `children.size === 1` only says one *registered* key lives here. Stop if
    // anything else does -- a sequence item, a merge key, a key the grammar
    // declined, or the user's own comment. Leaving an empty `providers:` behind
    // is a cosmetic cost; splicing the user's content away is not recoverable.
    if (unaccountedLines(document, parent).length) break;
    removal = parent;
  }
  const lines = [...document.lines];
  lines.splice(removal.index, removal.endIndex - removal.index + 1);
  return joinLines(normalizeTrailing(lines));
}

/** Whether a block exists at `keyPath`. */
export function yamlValuePresent(contents, keyPath) {
  return Boolean(yamlNode(scanYamlDocument(contents), keyPath));
}

/**
 * Reads one scalar leaf out of a YAML document.
 *
 * Deliberately not a parse: the router only ever needs to answer "is the base
 * URL under this key one we issued", and reading a single `key: value` line is
 * the whole of that question. Anything that is not a plain scalar on one line
 * reads as absent, which is the safe answer — an unrecognized base URL is
 * treated as somebody else's provider and left alone.
 */
export function yamlLeafScalar(contents, keyPath) {
  const document = scanYamlDocument(contents);
  const node = yamlNode(document, keyPath);
  if (!node || node.index < 0 || node.endIndex !== node.index) return undefined;
  const line = document.lines[node.index];
  const match = String(line).match(/^\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:]+):\s*(.*?)\s*$/);
  const raw = match?.[1];
  if (!raw) return undefined;
  if (raw.startsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (raw.startsWith("'")) return raw.slice(1, -1).replaceAll("''", "'");
  return raw.startsWith("#") ? undefined : raw;
}
