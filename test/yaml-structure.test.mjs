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
