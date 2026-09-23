function ambiguousToml(line, detail) {
  throw new Error(`Refusing ambiguous TOML structure at line ${line}: ${detail}.`);
}

function tomlBasicKey(raw) {
  let decoded = "";
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (character !== "\\") {
      decoded += character;
      continue;
    }
    const escape = raw[++index];
    const simple = {
      b: "\b",
      t: "\t",
      n: "\n",
      f: "\f",
      r: "\r",
      '"': '"',
      "\\": "\\",
    }[escape];
    if (simple !== undefined) {
      decoded += simple;
      continue;
    }
    const digits = escape === "u" ? 4 : escape === "U" ? 8 : 0;
    const code = digits ? raw.slice(index + 1, index + 1 + digits) : "";
    if (!digits || !new RegExp(`^[0-9a-fA-F]{${digits}}$`).test(code)) {
      return undefined;
    }
    const value = Number.parseInt(code, 16);
    if (value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return undefined;
    decoded += String.fromCodePoint(value);
    index += digits;
  }
  return decoded;
}

function tomlDottedKey(raw) {
  const parts = [];
  let index = 0;
  while (index < raw.length) {
    while (/\s/.test(raw[index] || "")) index += 1;
    if (index >= raw.length) return undefined;
    const quote = raw[index] === '"' || raw[index] === "'" ? raw[index++] : undefined;
    let value = "";
    if (quote) {
      let closed = false;
      while (index < raw.length) {
        if (raw[index] === quote) {
          index += 1;
          closed = true;
          break;
        }
        if (quote === '"' && raw[index] === "\\") {
          const escapeStart = index;
          index += 2;
          if (raw[escapeStart + 1] === "u") index += 4;
          else if (raw[escapeStart + 1] === "U") index += 8;
          value += raw.slice(escapeStart, index);
        } else {
          value += raw[index++];
        }
      }
      if (!closed) return undefined;
      if (quote === '"') value = tomlBasicKey(value);
      if (value === undefined) return undefined;
    } else {
      const start = index;
      while (index < raw.length && raw[index] !== "." && !/\s/.test(raw[index])) {
        index += 1;
      }
      value = raw.slice(start, index);
      if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
    }
    parts.push(value);
    while (/\s/.test(raw[index] || "")) index += 1;
    if (index === raw.length) return parts;
    if (raw[index] !== ".") return undefined;
    index += 1;
  }
  return undefined;
}

function tableHeaderAtLine(line, lineNumber) {
  let index = 0;
  while (/\s/.test(line[index] || "")) index += 1;
  if (line[index] !== "[") return undefined;
  const array = line[index + 1] === "[";
  index += array ? 2 : 1;
  const start = index;
  let quote;
  let escaped = false;
  let end = -1;
  while (index < line.length) {
    const character = line[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      index += 1;
      continue;
    }
    if (quote === "'") {
      if (character === quote) quote = undefined;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      index += 1;
      continue;
    }
    if (character === "[") {
      ambiguousToml(lineNumber, "an unquoted opening bracket appears in a table header");
    }
    if (character === "]") {
      if (array && line[index + 1] !== "]") {
        ambiguousToml(lineNumber, "an array-table header has only one closing bracket");
      }
      end = index;
      index += array ? 2 : 1;
      break;
    }
    index += 1;
  }
  if (quote) ambiguousToml(lineNumber, "a quoted table key is unterminated");
  if (end === -1) ambiguousToml(lineNumber, "a table header is unterminated");
  const remainder = line.slice(index).trimStart();
  if (remainder && !remainder.startsWith("#")) {
    ambiguousToml(lineNumber, "unexpected text follows a table header");
  }
  const path = tomlDottedKey(line.slice(start, end).trim());
  if (!path) ambiguousToml(lineNumber, "the table key cannot be decoded safely");
  return path;
}

function assignmentAtLine(line, lineNumber) {
  let quote;
  let escaped = false;
  let equals = -1;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (quote === "'") {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#") break;
    if (character === "=") {
      equals = index;
      break;
    }
  }
  if (equals === -1) return undefined;
  const key = tomlDottedKey(line.slice(0, equals).trim());
  if (!key) ambiguousToml(lineNumber, "an assignment key cannot be decoded safely");
  const rawValue = line.slice(equals + 1).trimStart();
  const quoteCharacter = rawValue[0];
  if (quoteCharacter !== '"' && quoteCharacter !== "'") {
    return { key, kind: "other" };
  }
  if (rawValue.startsWith(quoteCharacter.repeat(3))) {
    return { key, kind: "multiline-string" };
  }
  let index = 1;
  let body = "";
  let closed = false;
  while (index < rawValue.length) {
    if (quoteCharacter === '"' && rawValue[index] === "\\") {
      const start = index;
      index += 2;
      if (rawValue[start + 1] === "u") index += 4;
      else if (rawValue[start + 1] === "U") index += 8;
      body += rawValue.slice(start, index);
      continue;
    }
    if (rawValue[index] === quoteCharacter) {
      index += 1;
      closed = true;
      break;
    }
    body += rawValue[index++];
  }
  if (!closed) ambiguousToml(lineNumber, "a single-line string is unterminated");
  const remainder = rawValue.slice(index).trimStart();
  if (remainder && !remainder.startsWith("#")) {
    ambiguousToml(lineNumber, "unexpected text follows a string assignment");
  }
  const value = quoteCharacter === '"' ? tomlBasicKey(body) : body;
  if (value === undefined) ambiguousToml(lineNumber, "a basic string escape is invalid");
  return { key, kind: "string", value };
}

// A small fail-closed structural lexer, not a general TOML value parser. It
// identifies real table boundaries and active assignments while ignoring
// table-looking text and assignments inside multiline strings.
export function scanTomlDocument(contents, { rootOnly = false } = {}) {
  const lines = String(contents || "").split("\n");
  const headers = [];
  const assignments = [];
  const comments = [];
  let tablePath = [];
  let multiline;
  let arrayDepth = 0;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const lineNumber = lineIndex + 1;
    if (!multiline && arrayDepth === 0) {
      const header = tableHeaderAtLine(line, lineNumber);
      if (header) {
        tablePath = header;
        headers.push({ index: lineIndex, path: header });
        if (rootOnly) break;
        continue;
      }
      if (line.trimStart().startsWith("#")) comments.push(lineIndex);
      const assignment = assignmentAtLine(line, lineNumber);
      if (assignment) {
        assignments.push({ index: lineIndex, tablePath: [...tablePath], ...assignment });
      }
    }

    let index = 0;
    while (index < line.length) {
      if (multiline) {
        const quote = multiline === "basic" ? '"' : "'";
        if (multiline === "basic" && line[index] === "\\") {
          index += 2;
          continue;
        }
        if (line[index] !== quote) {
          index += 1;
          continue;
        }
        let run = 1;
        while (line[index + run] === quote) run += 1;
        if (run >= 3) multiline = undefined;
        index += run;
        continue;
      }

      const character = line[index];
      if (character === "#") break;
      if (character === '"' || character === "'") {
        const quote = character;
        let run = 1;
        while (line[index + run] === quote) run += 1;
        if (run >= 3) {
          multiline = quote === '"' ? "basic" : "literal";
          index += 3;
          continue;
        }
        index += 1;
        let closed = false;
        while (index < line.length) {
          if (quote === '"' && line[index] === "\\") {
            index += 2;
            continue;
          }
          if (line[index] === quote) {
            index += 1;
            closed = true;
            break;
          }
          index += 1;
        }
        if (!closed) ambiguousToml(lineNumber, "a single-line string is unterminated");
        continue;
      }
      if (character === "[") arrayDepth += 1;
      else if (character === "]") {
        if (arrayDepth === 0) ambiguousToml(lineNumber, "an unmatched closing bracket was found");
        arrayDepth -= 1;
      }
      index += 1;
    }
  }

  if (multiline) {
    ambiguousToml(lines.length, `an unterminated multiline ${multiline} string was found`);
  }
  if (arrayDepth !== 0) ambiguousToml(lines.length, "an unterminated array was found");
  return { lines, headers, assignments, comments };
}

function samePath(left, right) {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

export function tomlStringValue(document, tablePath, key) {
  const matches = document.assignments.filter(
    (assignment) =>
      samePath(assignment.tablePath, tablePath) &&
      assignment.key.length === 1 &&
      assignment.key[0] === key,
  );
  if (matches.length > 1) {
    throw new Error(`Refusing duplicate TOML assignments for ${[...tablePath, key].join(".")}.`);
  }
  if (matches.length === 0) return undefined;
  if (matches[0].kind !== "string") {
    throw new Error(`${[...tablePath, key].join(".")} must be a single-line TOML string.`);
  }
  return matches[0].value;
}
