import assert from "node:assert/strict";
import test from "node:test";

import {
  scanYamlDocument,
  spliceYamlBlock,
  yamlNode,
  yamlScalar,
} from "../src/yaml-structure.mjs";

function splice(contents, path, rendered) {
  return spliceYamlBlock(scanYamlDocument(contents), path, rendered).join("\n");
}

test("a nested key resolves with its own line range", () => {
  const document = scanYamlDocument("a:\n  b:\n    c: 1\n    d: 2\ne: 3\n");
  const node = yamlNode(document, ["a", "b"]);
  assert.equal(node.index, 1);
  assert.equal(node.endIndex, 3);
  assert.deepEqual(yamlNode(document, ["e"]).index, 4);
  assert.equal(yamlNode(document, ["a", "missing"]), undefined);
});

test("a block sequence's item keys are not document keys", () => {
  // Two list entries carrying the same field is the ordinary shape of a model
  // list, and reading them as siblings reported a duplicate key.
  const document = scanYamlDocument(
    "models:\n  - id: a\n    name: A\n  - id: b\n    name: B\nafter: 1\n",
  );
  assert.deepEqual([...document.root.children.keys()], ["models", "after"]);
  assert.equal(yamlNode(document, ["models"]).endIndex, 4);
});

test("a sequence indented level with its key still belongs to it", () => {
  const document = scanYamlDocument("models:\n- id: a\n- id: b\nafter: 1\n");
  assert.equal(yamlNode(document, ["models"]).endIndex, 2);
  assert.equal(yamlNode(document, ["after"]).index, 3);
});

test("a block scalar cannot introduce keys", () => {
  const document = scanYamlDocument('note: |\n  key: not really\n  another: no\nreal: 1\n');
  assert.deepEqual([...document.root.children.keys()], ["note", "real"]);
});

test("a multi-line flow collection cannot introduce keys", () => {
  const document = scanYamlDocument("list: [\n  1,\n  2,\n]\nafter: 1\n");
  assert.deepEqual([...document.root.children.keys()], ["list", "after"]);
  assert.equal(yamlNode(document, ["list"]).endIndex, 3);
});

test("a trailing comment block belongs to the next key, not the previous one", () => {
  const document = scanYamlDocument("a:\n  b: 1\n\n# about c\nc: 2\n");
  // Taking the comment with `a` would delete somebody's note about `c` on the
  // next write.
  assert.equal(yamlNode(document, ["a"]).endIndex, 1);
});

test("ambiguous documents are refused rather than guessed at", () => {
  const cases = [
    ["a:\n\tb: 1\n", /tab/],
    ["a: 1\n---\nb: 2\n", /multi-document/],
    ["---\na: 1\n---\nb: 2\n", /multi-document/],
    ["a: 1\na: 2\n", /defined twice/],
    ["- a\n- b\n", /root is a sequence/],
    ["a: [1,\n", /unterminated/],
    ["a: 1\n...\nb: 2\n", /ends one document/],
    ["&anchor a: 1\n", /anchor, alias, or tag/],
  ];
  for (const [contents, pattern] of cases) {
    assert.throws(() => scanYamlDocument(contents), pattern, `expected a refusal for ${contents}`);
  }
});

test("a quoted scalar the harness folded across lines is read, not refused", () => {
  // The harness owns `settings.yaml` and rewrites it. Its writer folds a long
  // double-quoted value at its line width and ends the line with a backslash
  // so the break is lossless -- which is what it does to the router's own
  // baseURL. Refusing that meant the router could not republish into a
  // document the harness had touched, which it does routinely.
  const document = scanYamlDocument(
    [
      "route:",
      '  baseURL: "http://127.0.0.1:4202/_codex-router/AAAAAAAAAAAAAAAAAAAA\\',
      '    BBBBBBBBBBBBBBBBBBBB/v1"',
      '  apiKeyEnv: "KEY"',
      "after: 1",
      "",
    ].join("\n"),
  );
  // The continuation line must not become a key, and must extend its own node.
  assert.deepEqual([...yamlNode(document, ["route"]).children.keys()], [
    "baseURL",
    "apiKeyEnv",
  ]);
  assert.equal(yamlNode(document, ["route", "baseURL"]).endIndex, 2);
  assert.equal(yamlNode(document, ["after"]).index, 4);
});

test("a single-quoted scalar folded across lines is read the same way", () => {
  const document = scanYamlDocument("a: 'one\n  two'\nb: 2\n");
  assert.deepEqual([...document.root.children.keys()], ["a", "b"]);
  assert.equal(yamlNode(document, ["a"]).endIndex, 1);
});

test("an apostrophe inside a plain scalar is not an opening quote", () => {
  // `note: don't edit` is an ordinary plain scalar. Reading its apostrophe as
  // the start of a quoted scalar made every line after it a continuation of
  // that scalar, so the document lost its remaining keys and then refused
  // itself at end of file for a quote the user never opened.
  const document = scanYamlDocument(
    "llm-pi-ai:\n  providers:\n    mine:\n      note: don't edit\nafter: 1\n",
  );
  assert.deepEqual([...document.root.children.keys()], ["llm-pi-ai", "after"]);
  assert.equal(yamlNode(document, ["llm-pi-ai", "providers", "mine"]).endIndex, 3);
  assert.equal(yamlNode(document, ["after"]).index, 4);
});

test("an unpaired double quote inside a plain scalar is not an opening quote", () => {
  const document = scanYamlDocument('width: 5" wide\nafter: 1\n');
  assert.deepEqual([...document.root.children.keys()], ["width", "after"]);
});

test("a stray quote does not extend one node over the keys that follow it", () => {
  // The dangerous half of the same mistake: when a later line happens to carry
  // a matching quote the scan finishes without complaint, having silently
  // moved every key in between inside the node that opened it. Splicing then
  // writes the router's block into somebody else's value.
  const document = scanYamlDocument(
    [
      "llm-pi-ai:",
      "  providers:",
      "    mine:",
      "      note: don't edit",
      "theme: plain",
      "prompt: |",
      "  it's a block scalar",
      "",
    ].join("\n"),
  );
  assert.deepEqual([...document.root.children.keys()], ["llm-pi-ai", "theme", "prompt"]);
  assert.equal(yamlNode(document, ["llm-pi-ai"]).endIndex, 3);
});

test("a quote still opens a scalar wherever a node can begin", () => {
  // The rule is positional, not a blanket "ignore quotes": a value that starts
  // with one, and an element or key inside a flow collection, are quoted
  // scalars whose contents must stay opaque to this lexer.
  const document = scanYamlDocument(
    ["a: \"x: not a key\"", "b: ['c: no', \"d: no\"]", "c: 1", ""].join("\n"),
  );
  assert.deepEqual([...document.root.children.keys()], ["a", "b", "c"]);
  assert.throws(() => scanYamlDocument("a: 'one\nb: 2\n"), /quoted scalar is unterminated/);
});

test("a quoted scalar left open at end of file is still refused", () => {
  assert.throws(() => scanYamlDocument('a: "never closed\n'), /quoted scalar is unterminated/);
});

test("a single explicit document marker is fine", () => {
  const document = scanYamlDocument("---\na: 1\n");
  assert.equal(yamlNode(document, ["a"]).index, 1);
});

test("splicing creates every missing ancestor", () => {
  assert.equal(
    splice("", ["one", "two", "three"], ["    three:", "      value: 1"]),
    "one:\n  two:\n    three:\n      value: 1\n",
  );
});

test("splicing into an existing parent leaves its other children alone", () => {
  const before = "one:\n  two:\n    keep: 1\n";
  const after = splice(before, ["one", "two", "add"], ["    add: 2"]);
  assert.equal(after, "one:\n  two:\n    keep: 1\n    add: 2\n");
});

test("splicing replaces the whole range of an existing key", () => {
  const before = "a:\n  b: 1\n  c: 2\nd: 3\n";
  assert.equal(splice(before, ["a"], ["a:", "  b: 9"]), "a:\n  b: 9\nd: 3\n");
});

test("splicing replaces a multi-line flow value in full", () => {
  const before = "a: [\n  1,\n]\nd: 3\n";
  assert.equal(splice(before, ["a"], ["a: 9"]), "a: 9\nd: 3\n");
});

test("extending an inline ancestor is refused", () => {
  assert.throws(
    () => splice("a: {b: 1}\n", ["a", "c"], ["  c: 2"]),
    /inline value rather than a block/,
  );
});

test("yamlScalar quotes values that YAML would otherwise reinterpret", () => {
  assert.equal(yamlScalar("yes"), '"yes"');
  assert.equal(yamlScalar("1.0"), '"1.0"');
  assert.equal(yamlScalar('has "quotes"'), '"has \\"quotes\\""');
});

test("a named root block reads extended keys with their own mapping scope", () => {
  // DeepSeek Harness keys each record `<scope>/<id>`, which this lexer does not
  // read as a key, so the records' fields used to register as the section's
  // own and the second `kind` was refused as a duplicate.
  const contents = [
    "records:",
    "  client-connection/browser-session:",
    "    kind: grant",
    "# a note inside the block does not end it",
    "  client-connection/second-session:",
    "    kind: grant",
    "refs:",
    "  KEY: value",
    "",
  ].join("\n");
  assert.throws(() => scanYamlDocument(contents), /"kind" is defined twice/);
  const document = scanYamlDocument(contents, { extendedPlainKeyRoots: ["records"] });
  const records = yamlNode(document, ["records"]);
  assert.deepEqual([...records.children.keys()], ["client-connection/browser-session", "client-connection/second-session"]);
  assert.equal(yamlNode(document, ["records", "client-connection/second-session", "kind"]).index, 5);
  assert.deepEqual([records.index, records.endIndex], [0, 5]);
  assert.equal(yamlNode(document, ["refs", "KEY"]).index, 7);
  // Only a named root enables extended keys; a nested name stays unchanged.
  const nested = scanYamlDocument("outer:\n  records:\n    inner: 1\n", { extendedPlainKeyRoots: ["records"] });
  assert.equal(yamlNode(nested, ["outer", "records", "inner"]).index, 2);
});

test("extended plain payload keys keep embedded punctuation and quotes literal", () => {
  const keys = ["scope/id", "display name", "日本語", "a:b", "prefix#suffix", 'a"b', "a\\b", "?leading"];
  const contents = "records:\n  client-connection/session:\n    payload:\n" +
    keys.map((key) => `      ${key}: value\n`).join("") + "refs:\n  KEY: preserved\n";
  const document = scanYamlDocument(contents, { extendedPlainKeyRoots: ["records"] });
  assert.deepEqual([...yamlNode(document, ["records", "client-connection/session", "payload"]).children.keys()], keys);
  assert.ok(yamlNode(document, ["refs", "KEY"]));
  assert.throws(
    () => scanYamlDocument('records:\n  scope/id:\n    "escaped\\nkey": value\n', { extendedPlainKeyRoots: ["records"] }),
    /double-quoted key uses an escape sequence/,
  );
});

test("record blocks still refuse malformed values and duplicate mapping keys", () => {
  const options = { extendedPlainKeyRoots: ["records"] };
  const prefix = "version: 1\nrecords:\n  client-connection/session:\n    kind: grant\n    payload:\n";
  const invalid = [
    [prefix + "      token: [unfinished\n", /flow collection is unterminated/],
    [prefix + '      token: "unfinished\n', /quoted scalar is unterminated/],
    [prefix + "      token: [unfinished\nrefs:\n  KEY: old\n", /flow collection is unterminated/],
    [prefix + '      token: "unfinished\nrefs:\n  KEY: old\n', /quoted scalar is unterminated/],
    [prefix + "      token: ]\n", /unmatched flow-collection close/],
    [prefix + "      token: first\n      token: second\n", /defined twice/],
    [prefix + "      token: first\n  client-connection/session:\n    kind: grant\n    payload: second\n", /defined twice/],
  ];
  for (const [contents, pattern] of invalid) {
    assert.throws(() => scanYamlDocument(contents, options), pattern);
  }
});

test("record payloads preserve folded scalars, flow values, and literal blocks", () => {
  const contents = [
    "version: 1",
    "records:",
    "  client-connection/session:",
    "    kind: grant",
    "    payload:",
    '      quoted: "first',
    '      # second"',
    "      flow: [",
    '        "one", "two"',
    "      ]",
    "      scope/id: |",
    "        [not a flow collection",
    '        "not an opening quote',
    "      items:",
    "        - caption/key: |",
    "            [literal text",
    '            "more literal text',
    "          sibling: preserved",
    "        - caption/key: next",
    "refs:",
    "  KEY: value",
    "",
  ].join("\n");
  const document = scanYamlDocument(contents, { extendedPlainKeyRoots: ["records"] });
  assert.equal(yamlNode(document, ["refs", "KEY"]).index, 20);
  assert.equal(yamlNode(document, ["records"]).endIndex, 18);
});

test("single-quoted record keys keep doubled apostrophes and reject duplicates", () => {
  const prefix = "records:\n  scope/id:\n    payload:\n";
  const line = "      'a''b: c': first\n";
  const options = { extendedPlainKeyRoots: ["records"] };
  const document = scanYamlDocument(prefix + line, options);
  assert.ok(yamlNode(document, ["records", "scope/id", "payload", "a'b: c"]));
  assert.throws(() => scanYamlDocument(prefix + line + line, options), /defined twice/);
  assert.throws(() => scanYamlDocument(prefix + "      token: 'has ''literal [\n", options), /quoted scalar is unterminated/);
});

test("record sequence mapping continuations preserve literal and folded text", () => {
  const records = [
    "version: 1",
    "records:",
    "  client-connection/session:",
    "    kind: grant",
    "    payload:",
    "      - first: ordinary",
    "        second: |",
    "          [literal",
    '          "literal',
    "        folded: long",
    "          continuation",
    '          " a literal quote',
    "        child:",
    '          "a quoted child',
    '          continuation"',
    "      - - |",
    "          }literal",
    "          'literal",
    "        - long",
    "          continuation",
    '          " another literal quote',
    "refs:",
    "  KEY: value",
    "",
  ].join("\n");
  const document = scanYamlDocument(records, { extendedPlainKeyRoots: ["records"] });
  assert.equal(yamlNode(document, ["refs", "KEY"]).index, 22);
  assert.equal(yamlNode(document, ["records"]).endIndex, 20);
});

test("folded record text never hides a new malformed child node", () => {
  const prefix = "records:\n  scope/id:\n    payload:\n      - first: ordinary\n";
  for (const body of [
    '        child:\n          "unfinished\n',
    '        child:\n          evil: "unfinished\n',
    '      - "unfinished\n',
  ]) {
    assert.throws(
      () => scanYamlDocument(prefix + body, { extendedPlainKeyRoots: ["records"] }),
      /quoted scalar is unterminated/,
    );
  }
});

test("record keys and root comments cannot hide malformed quoted tokens", () => {
  const prefix = "records:\n  scope/id:\n    payload:\n";
  const options = { extendedPlainKeyRoots: ["records"] };
  for (const raw of ["'a'x", "'a'b'", '"a"b"']) {
    assert.throws(() => scanYamlDocument(prefix + `      ${raw}: value\n`, options), /quoted key is malformed/);
  }
  assert.throws(() => scanYamlDocument(prefix + '      "unfinished\n', options), /quoted scalar is unterminated/);
  assert.throws(() => scanYamlDocument(prefix + '      token: "unfinished\n# root comment"\nrefs:\n  KEY: value\n', options), /quoted scalar is unterminated/);
  assert.throws(() => scanYamlDocument(prefix + "      ? complex\n      : value\n", options), /unsupported indicator/);
});

test("sequence payload keys never become flow delimiters", () => {
  const contents = [
    "records:",
    "  scope/id:",
    "    payload:",
    "      - a[: first",
    "        a]: second",
    "        a{: third",
    '      - {key: "inline flow"}',
    "refs:",
    "  KEY: preserved",
    "",
  ].join("\n");
  const document = scanYamlDocument(contents, { extendedPlainKeyRoots: ["records"] });
  assert.equal(yamlNode(document, ["refs", "KEY"]).index, 8);
});
