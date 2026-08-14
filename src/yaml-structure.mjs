// A small fail-closed structural lexer for block-mapping YAML, not a general
// YAML parser. It exists so the router can splice one provider route into a
// settings document DeepSeek Harness owns, without disturbing a single other
// byte of it — the harness itself writes leaf-level diffs and preserves the
// user's comments, so anything coarser than that would quietly delete work.
//
// Everything it cannot read plainly is refused rather than guessed at. A
// refusal leaves the user's document untouched and names the line; a wrong
// guess rewrites a file whose only copy is on their disk.

function ambiguousYaml(line, detail) {
  throw new Error(`Refusing ambiguous YAML structure at line ${line}: ${detail}.`);
}

// Plain and quoted keys only. A key carrying an anchor, an alias, a tag, or a
// complex `? ` mapping key is legal YAML this lexer will not edit around.
const PLAIN_KEY = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

function decodeKey(raw, lineNumber) {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    if (trimmed.length < 2 || trimmed.at(-1) !== quote) return undefined;
    const body = trimmed.slice(1, -1);
    if (quote === "'") return body.replaceAll("''", "'");
    // Escapes in a key are legal and rare. Rather than implement YAML's
    // double-quoted escape table for a case nothing here produces, refuse.
    if (body.includes("\\")) {
      ambiguousYaml(lineNumber, "a double-quoted key uses an escape sequence");
    }
    return body;
  }
  if (trimmed.startsWith("&") || trimmed.startsWith("*") || trimmed.startsWith("!")) {
    ambiguousYaml(lineNumber, "a key carries an anchor, alias, or tag");
  }
  return PLAIN_KEY.test(trimmed) ? trimmed : undefined;
}

// Splits `key: value` at the mapping colon, honouring quotes. Returns
// undefined for a line that is not a mapping entry at all.
function mappingEntry(line, lineNumber) {
  const indent = line.length - line.trimStart().length;
  const body = line.slice(indent);
  if (!body || body.startsWith("#")) return undefined;
  if (body.startsWith("- ") || body === "-") {
    return { indent, sequence: true };
  }
  let quote;
  let colon = -1;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (quote) {
      if (character === "\\" && quote === '"') index += 1;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#" && index > 0 && /\s/.test(body[index - 1])) break;
    if (character === ":" && (index + 1 === body.length || /\s/.test(body[index + 1]))) {
      colon = index;
      break;
    }
  }
  // A quote still open at end of line is a scalar continued onto the next one,
  // which the caller tracks. It is not a mapping entry this line can describe.
  if (quote) return undefined;
  if (colon === -1) return undefined;
  const key = decodeKey(body.slice(0, colon), lineNumber);
  if (key === undefined) return undefined;
  return { indent, key, value: body.slice(colon + 1).trim() };
}

/**
 * Reports what a line leaves open: unclosed flow-collection depth, and a
 * quoted scalar still running at the end of it.
 *
 * A quoted scalar legitimately spans lines, and the harness's own writer
 * produces one: it folds a long double-quoted value at its line width and ends
 * the line with a backslash so the break is lossless. Refusing that meant the
 * router could not republish into a document the harness had rewritten -- which
 * it does routinely, since it owns the file. Neither a continuation line nor a
 * flow collection can hold a key this lexer owns, so tracking both is enough to
 * skip past them safely.
 */
function scanValue(value, openQuote) {
  let depth = 0;
  let quote = openQuote;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === "\\" && quote === '"') index += 1;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#" && (index === 0 || /\s/.test(value[index - 1]))) break;
    if (character === "[" || character === "{") depth += 1;
    else if (character === "]" || character === "}") depth -= 1;
  }
  return { depth, openQuote: quote };
}

function blockScalarIndicator(value) {
  return /^[|>][+-]?\d*\s*(#.*)?$/.test(value);
}

/**
 * Scans a block-mapping YAML document into nodes carrying their line ranges.
 *
 * A node's `endIndex` is the last line that belongs to it, with trailing blank
 * lines and trailing comment lines excluded: a comment sitting above the next
 * key is that key's annotation, and taking it with the node above would delete
 * somebody's note about a route the router does not own.
 */
export function scanYamlDocument(contents) {
  const lines = String(contents ?? "").split("\n");
  const root = { path: [], indent: -1, index: -1, endIndex: lines.length - 1, children: new Map() };
  const stack = [root];
  let documents = 0;
  let flowDepth = 0;
  let blockScalar;
  // A block sequence's items and everything nested under them are opaque: they
  // hold mapping keys (`- id: …`, then `  name: …`) that are not siblings of
  // anything in the surrounding document, and registering them was how two
  // list entries with the same field read as one mapping with a duplicate key.
  let sequenceIndent;
  // A double-quoted scalar the harness folded across lines. Its continuation
  // lines are not mapping entries however much they look like one.
  let openQuote;

  const consume = (text, lineNumber) => {
    const scanned = scanValue(text, openQuote);
    openQuote = scanned.openQuote;
    flowDepth += scanned.depth;
    if (flowDepth < 0) {
      ambiguousYaml(lineNumber, "an unmatched flow-collection close was found");
    }
  };

  const close = (indent, lastContentIndex) => {
    while (stack.length > 1 && stack.at(-1).indent >= indent) {
      stack.pop().endIndex = lastContentIndex;
    }
  };

  let lastContentIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    if (/^[ ]*\t/.test(line)) {
      ambiguousYaml(lineNumber, "indentation uses a tab, which YAML forbids");
    }
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (blockScalar !== undefined) {
      if (!trimmed || indent > blockScalar) {
        if (trimmed) lastContentIndex = index;
        continue;
      }
      blockScalar = undefined;
    }
    if (sequenceIndent !== undefined) {
      // A block sequence may be indented level with its own key, so the column
      // alone cannot end it: at that column a `- ` is the next item while
      // anything else is the next sibling key.
      const insideSequence =
        indent > sequenceIndent ||
        (indent === sequenceIndent && (trimmed === "-" || trimmed.startsWith("- ")));
      if (!trimmed || insideSequence) {
        if (trimmed) {
          lastContentIndex = index;
          consume(line, lineNumber);
        }
        continue;
      }
      if (flowDepth > 0) ambiguousYaml(lineNumber, "a flow collection is unterminated");
      if (openQuote) ambiguousYaml(lineNumber, "a quoted scalar is unterminated");
      sequenceIndent = undefined;
    }
    // A folded quoted scalar or an open flow collection swallows the line
    // whole: it extends the node it sits inside and registers no key.
    if (openQuote || flowDepth > 0) {
      consume(line, lineNumber);
      lastContentIndex = index;
      continue;
    }
    if (!trimmed) continue;
    if (trimmed === "---" || trimmed.startsWith("--- ")) {
      // A `---` after content ends an implicit first document, so it is the
      // second one even though it is the first marker in the file.
      documents += lastContentIndex >= 0 ? 2 : 1;
      if (documents > 1) {
        ambiguousYaml(lineNumber, "the file is a multi-document stream");
      }
      close(0, lastContentIndex);
      continue;
    }
    if (trimmed === "...") {
      ambiguousYaml(lineNumber, "the file ends one document and may begin another");
    }
    if (trimmed.startsWith("#")) continue;

    const entry = mappingEntry(line, lineNumber);
    if (!entry) {
      // A continuation of a multi-line plain scalar, or something this lexer
      // does not model. It cannot introduce a key, so it only extends the
      // node it sits inside.
      lastContentIndex = index;
      continue;
    }
    if (entry.sequence) {
      if (stack.length === 1) {
        ambiguousYaml(lineNumber, "the document root is a sequence rather than a mapping");
      }
      // The sequence belongs to the key currently on the stack, so nothing is
      // popped: its lines extend that key's range and register no children.
      sequenceIndent = entry.indent;
      lastContentIndex = index;
      consume(line, lineNumber);
      continue;
    }

    close(entry.indent, lastContentIndex);
    const parent = stack.at(-1);
    if (parent.children.has(entry.key)) {
      ambiguousYaml(lineNumber, `the key "${entry.key}" is defined twice in one mapping`);
    }
    const node = {
      path: [...parent.path, entry.key],
      key: entry.key,
      indent: entry.indent,
      index,
      endIndex: index,
      inline: entry.value !== "" && !entry.value.startsWith("#"),
      children: new Map(),
    };
    parent.children.set(entry.key, node);
    stack.push(node);
    lastContentIndex = index;

    if (blockScalarIndicator(entry.value)) {
      blockScalar = entry.indent;
      continue;
    }
    consume(entry.value, lineNumber);
  }

  if (flowDepth > 0) ambiguousYaml(lines.length, "a flow collection is unterminated");
  if (openQuote) ambiguousYaml(lines.length, "a quoted scalar is unterminated");
  close(0, lastContentIndex);
  root.endIndex = lastContentIndex;
  return { lines, root };
}

/** Resolves a node by its key path, or undefined when any step is missing. */
export function yamlNode(document, path) {
  let node = document.root;
  for (const key of path) {
    node = node.children.get(key);
    if (!node) return undefined;
  }
  return node;
}

/**
 * Replaces the lines of `path` with `rendered`, or inserts them when the path
 * does not exist yet. Every ancestor that has to be created is emitted too, so
 * a document with no `llm-pi-ai:` section at all is a valid starting point.
 *
 * Returns the new line array. The caller renders `rendered` already indented
 * for its depth; this function only decides where the lines go.
 */
export function spliceYamlBlock(document, path, rendered) {
  if (!path.length) throw new Error("A YAML splice needs a key path.");
  const lines = [...document.lines];
  const existing = yamlNode(document, path);
  if (existing) {
    // Replacing a key we own is safe however it was written, inline value
    // included: the node's line range already covers a flow collection that
    // ran across several lines. Only *extending* something inline is not.
    lines.splice(existing.index, existing.endIndex - existing.index + 1, ...rendered);
    return lines;
  }

  // Walk down to the deepest ancestor that does exist, then append the
  // remaining levels under it.
  let depth = 0;
  let anchor = document.root;
  while (depth < path.length) {
    const child = anchor.children.get(path[depth]);
    if (!child) break;
    anchor = child;
    depth += 1;
  }
  if (anchor !== document.root && anchor.inline) {
    throw new Error(
      `Refusing to extend ${anchor.path.join(".")}: it is written as an inline value rather than a block.`,
    );
  }
  const missing = path.slice(depth, -1);
  const indentOf = (level) => "  ".repeat(depth + level);
  const block = [
    ...missing.map((key, level) => `${indentOf(level)}${key}:`),
    ...rendered,
  ];
  // `endIndex` already excludes the trailing blank lines and the comment block
  // that annotates whatever comes next, so inserting just past it lands after
  // the anchor's own content without pushing a blank line into the middle of
  // the document on every write.
  lines.splice(anchor.endIndex + 1, 0, ...block);
  return lines;
}

/** Renders a string as a YAML scalar. JSON string syntax is valid YAML. */
export function yamlScalar(value) {
  return JSON.stringify(String(value));
}
