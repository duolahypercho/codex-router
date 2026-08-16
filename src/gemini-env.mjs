// The one document the Gemini integration writes: `$GEMINI_HOME/.env`.
//
// Gemini CLI resolves its endpoint, its credential, and its default model from
// the environment (`GOOGLE_GEMINI_BASE_URL`, `GEMINI_API_KEY`, `GEMINI_MODEL`),
// and loads a `.env` for them at startup. That is the whole integration: no
// edit to the user's `settings.json`, which is JSONC and carries their comments,
// and no second copy of the model catalog to keep in step.
//
// The file may still be theirs. So the router owns a marker-delimited block and
// treats every other byte as somebody else's work: publishing twice is
// byte-identical, removing the block restores the document exactly, and a
// document the lexer cannot read plainly is refused with the file untouched and
// the reason named. `dotenv` lets the last assignment of a key win, so a
// duplicate below our block would silently decide the base URL -- that is
// reported rather than rewritten.

export const GEMINI_ENV_BEGIN = "# BEGIN codex-router-gemini";
export const GEMINI_ENV_END = "# END codex-router-gemini";

// Ordered: the block is rendered in this sequence, which is what makes a
// republish byte-identical rather than merely equivalent.
export const GEMINI_MANAGED_KEYS = Object.freeze([
  "GOOGLE_GEMINI_BASE_URL",
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
]);

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

function newline(document) {
  return document.includes("\r\n") ? "\r\n" : "\n";
}

function splitLines(document) {
  return document.split(/\r\n|\n/);
}

// Locates our block, and refuses anything ambiguous.
//
// A missing end marker or a second begin marker means somebody edited the file
// by hand in a way this lexer cannot resolve. Splicing on a guess there rewrites
// a document whose only copy is on the user's disk; refusing costs a command.
function locateBlock(lines) {
  const begins = [];
  const ends = [];
  lines.forEach((line, index) => {
    if (line.trim() === GEMINI_ENV_BEGIN) begins.push(index);
    if (line.trim() === GEMINI_ENV_END) ends.push(index);
  });
  if (!begins.length && !ends.length) return undefined;
  if (begins.length > 1) {
    throw new Error(
      `${GEMINI_ENV_BEGIN} appears more than once; resolve the duplicate by hand before publishing.`,
    );
  }
  if (!begins.length) {
    throw new Error(
      `${GEMINI_ENV_END} appears with no begin marker; resolve it by hand before publishing.`,
    );
  }
  const end = ends.find((index) => index > begins[0]);
  if (end === undefined) {
    throw new Error(
      `The managed block has no end marker (${GEMINI_ENV_END}); resolve it by hand before publishing.`,
    );
  }
  return { start: begins[0], end };
}

// `.env` values are unquoted by default. Anything with whitespace, a quote, or
// a `#` needs quoting or dotenv reads a truncated value -- and a truncated base
// URL is a caller capability that no longer authenticates.
function renderValue(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_\-./:@+=~]*$/.test(text)) return text;
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function renderBlock(values) {
  const lines = [GEMINI_ENV_BEGIN];
  for (const key of GEMINI_MANAGED_KEYS) {
    const value = values?.[key];
    // Omitted, never blank: `GEMINI_MODEL=` out-ranks the user's own
    // `settings.json` choice with an empty string, which reads to the CLI as a
    // model named "".
    if (value === undefined || value === null || value === "") continue;
    lines.push(`${key}=${renderValue(value)}`);
  }
  lines.push(GEMINI_ENV_END);
  return lines;
}

/** Every managed key assigned outside our block, with its 1-based line number. */
export function conflictingAssignments(document) {
  const lines = splitLines(String(document ?? ""));
  const block = locateBlock(lines);
  const found = [];
  lines.forEach((line, index) => {
    if (block && index >= block.start && index <= block.end) return;
    const match = ASSIGNMENT.exec(line);
    if (!match) return;
    if (!GEMINI_MANAGED_KEYS.includes(match[1])) return;
    found.push({ key: match[1], line: index + 1 });
  });
  return found;
}

/** The document with the managed block written, replaced in place if present. */
export function spliceGeminiEnvBlock(document, values) {
  const text = String(document ?? "");
  const eol = newline(text);
  const lines = splitLines(text);
  const block = locateBlock(lines);
  const rendered = renderBlock(values);
  if (block) {
    const next = [...lines.slice(0, block.start), ...rendered, ...lines.slice(block.end + 1)];
    return next.join(eol);
  }
  // Appended, so an existing document keeps its own leading content and its own
  // trailing newline discipline. A file that did not end in a newline gains one
  // here because the block has to start on its own line.
  const prefix = text === "" ? [] : lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
  return [...prefix, ...rendered, ""].join(eol);
}

/** The document with the managed block removed, byte-identical to before it was written. */
export function removeGeminiEnvBlock(document) {
  const text = String(document ?? "");
  const eol = newline(text);
  const lines = splitLines(text);
  const block = locateBlock(lines);
  if (!block) return text;
  const next = [...lines.slice(0, block.start), ...lines.slice(block.end + 1)];
  // The block was appended onto a document that already ended in a newline, so
  // its removal leaves the trailing empty element that split produced. Anything
  // else in the document is left exactly as it was found.
  return next.join(eol);
}
