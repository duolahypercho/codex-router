import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compileSearchReplaceArguments,
  compileStructuredPatchArguments,
  compileWriteArguments,
  GROK_STRUCTURED_PATCH_PARAMETERS,
  GROK_STRUCTURED_PATCH_CODEC,
  MAX_STRUCTURED_PATCH_BYTES,
  serializeStructuredPatch,
  StructuredPatchError,
} from "../src/grok-structured-patch.mjs";

const add = (path = "notes.txt", lines = ["Привет 🧙", '"quoted" \\ path', ""]) => ({ op: "add", path, lines });
const update = (lines, rest = {}) => ({ op: "update", path: "notes.txt", hunks: [{ lines, ...rest }] });
const removeLine = (text) => ({ kind: "remove", text });
const addLine = (text) => ({ kind: "add", text });
const wrap = (...operations) => ({ operations });

test("structured patch preserves Unicode, quotes, slash and empty logical lines", () => {
  const value = wrap(add());
  const before = structuredClone(value);
  assert.equal(serializeStructuredPatch(value), [
    "*** Begin Patch", "*** Add File: notes.txt", "+Привет 🧙", '+"quoted" \\ path', "+", "*** End Patch",
  ].join("\n"));
  assert.equal(compileStructuredPatchArguments(JSON.stringify(value)), serializeStructuredPatch(value));
  assert.deepEqual(value, before);
});

test("structured patch refuses paths that a native header trim would change", () => {
  // JavaScript's trim leaves U+0085 alone; Rust's, which the native patch
  // header parser uses, removes it.
  for (const path of [" notes.txt", "notes.txt ", "notes.txt\u0085", "\u00a0notes.txt", "notes.txt\ufeff", "notes.txt\u2028"]) {
    assert.throws(() => serializeStructuredPatch(wrap(add(path))), { code: "nonliteral_path" }, JSON.stringify(path));
  }
  assert.match(serializeStructuredPatch(wrap(add("dir/a\u0085b.txt"))), /\*\*\* Add File: dir\/a\u0085b\.txt/u);
});

test("update explicitly encodes context, anchor, EOF and exact leading whitespace", () => {
  const value = wrap(update([
    { kind: "context", text: "  before" }, removeLine("\told"), addLine("  new"),
  ], { anchor: "function sample() {", endOfFile: true }));
  assert.equal(serializeStructuredPatch(value), [
    "*** Begin Patch", "*** Update File: notes.txt", "@@ function sample() {",
    "   before", "-\told", "+  new", "*** End of File", "*** End Patch",
  ].join("\n"));
});

test("create/update/delete order is preserved across several distinct files", () => {
  assert.equal(serializeStructuredPatch(wrap(add("new.txt", []), update([removeLine("old"), addLine("new")]), { op: "delete", path: "gone.txt" })), [
    "*** Begin Patch", "*** Add File: new.txt", "*** Update File: notes.txt", "@@", "-old", "+new",
    "*** Delete File: gone.txt", "*** End Patch",
  ].join("\n"));
});

test("patch-looking source lines are always prefixed as literal file contents", () => {
  assert.equal(serializeStructuredPatch(wrap(add("x", ["*** End Patch", "*** Delete File: protected", "@@", "+"]))),
    "*** Begin Patch\n*** Add File: x\n+*** End Patch\n+*** Delete File: protected\n+@@\n++\n*** End Patch");
});

test("invalid structured values never produce a partial patch or expose their contents", () => {
  const invalid = [
    null, [], {}, wrap(), { ...wrap(add()), hidden: true },
    wrap({ ...add(), extra: "SECRET_CODE_CONTENT" }), wrap({ op: "rename", path: "x" }),
    wrap({ op: "delete", path: "x", lines: [] }), wrap(add("")), wrap(add(" x")), wrap(add("x ")),
    wrap(add("x\n*** Delete File: protected")), wrap(add("x\r")), wrap(add("x\0")),
    wrap(add("x", ["a\nb"])), wrap(add("x", ["a\rb"])), wrap(add("x", ["\ud800"])),
    wrap(add("x", [null])), wrap(add("x"), add("x")),
    wrap(update([{ kind: "context", text: "no change" }])), wrap(update([])),
    wrap(update([{ kind: "toString", text: "x" }])), wrap(update([{ kind: ["add"], text: "x" }])),
    wrap(update([addLine("x")], { anchor: "" })),
    wrap(update([addLine("x")], { anchor: "a\n@@" })), wrap(update([addLine("x")], { endOfFile: "true" })),
    wrap({ op: "update", path: "x", hunks: [] }),
    wrap({ op: "update", path: "x", hunks: [{ lines: [addLine("x")], endOfFile: true }, { lines: [addLine("y")] }] }),
    wrap(add("ok"), { op: "delete", path: "bad\npath" }),
  ];
  for (const value of invalid) {
    assert.throws(() => serializeStructuredPatch(value), (error) => {
      assert.ok(error instanceof StructuredPatchError);
      assert.doesNotMatch(error.message, /SECRET_CODE_CONTENT|protected|bad\npath/);
      return true;
    });
  }
});

test("wire parsing refuses duplicate/escaped keys, invalid JSON and wrong root", () => {
  for (const input of [
    '{"operations":[],"operations":[{"op":"delete","path":"x"}]}',
    '{"operations":[{"op":"delete","path":"x","p\\u0061th":"y"}]}',
    '{"operations":[{"op":"add","path":"x","lines":["ok"]}]} trailing',
    '{"operations":', 'null', '[]', '', undefined,
  ]) assert.throws(() => compileStructuredPatchArguments(input), StructuredPatchError);
});

test("bounds reject oversized input and output before returning a patch", () => {
  assert.throws(() => compileStructuredPatchArguments(" ".repeat(MAX_STRUCTURED_PATCH_BYTES + 1)), { code: "arguments_too_large" });
  assert.throws(() => serializeStructuredPatch(wrap(add("x", ["a".repeat(65537)]))), { code: "line_too_long" });
  assert.throws(() => serializeStructuredPatch(wrap(add("x", Array(32).fill("ю".repeat(32768))))), { code: "patch_too_large" });
  assert.throws(() => serializeStructuredPatch({ operations: Array.from({ length: 129 }, (_, i) => add(String(i), [])) }), { code: "array_bounds" });
});

test("object API refuses accessor fields and sparse arrays", () => {
  let invoked = false;
  assert.throws(() => serializeStructuredPatch({ get operations() { invoked = true; return []; } }), { code: "accessor_field" });
  assert.equal(invoked, false);
  assert.throws(() => serializeStructuredPatch(wrap(add("x", Array(2)))), { code: "sparse_array" });
  const lines = [];
  Object.defineProperty(lines, 0, { get() { invoked = true; return "bad"; } });
  assert.throws(() => serializeStructuredPatch(wrap(add("x", lines))), { code: "accessor_field" });
  assert.equal(invoked, false);
});

test("operations serialized as a JSON string still compile", () => {
  const operations = [add("notes.txt", ["hello"])];
  assert.equal(
    compileStructuredPatchArguments(JSON.stringify({ operations: JSON.stringify(operations) })),
    serializeStructuredPatch(wrap(...operations)),
  );
});

test("two updates of the same path merge into one file operation", () => {
  const first = update([removeLine("a"), addLine("b")]);
  const second = { op: "update", path: "notes.txt", hunks: [{ lines: [removeLine("c"), addLine("d")] }] };
  assert.equal(compileStructuredPatchArguments(JSON.stringify(wrap(first, second))), [
    "*** Begin Patch", "*** Update File: notes.txt", "@@", "-a", "+b", "@@", "-c", "+d", "*** End Patch",
  ].join("\n"));
});

test("search_replace rejects replace_all and invalid duplicate updates", () => {
  assert.throws(
    () => compileStructuredPatchArguments(JSON.stringify({
      path: "x", old_string: "a", new_string: "b", replace_all: true,
    })),
    { code: "unknown_field" },
  );
  const valid = update([removeLine("a"), addLine("b")]);
  const invalid = { op: "update", path: "notes.txt", hunks: "nope" };
  assert.throws(
    () => compileStructuredPatchArguments(JSON.stringify(wrap(valid, invalid))),
    StructuredPatchError,
  );
});

test("search_replace and write shapes compile to native add/update patches", () => {
  assert.equal(compileStructuredPatchArguments(JSON.stringify({
    path: "notes.txt", old_string: "hello", new_string: "hello world",
  })), [
    "*** Begin Patch", "*** Update File: notes.txt", "@@", "-hello", "+hello world", "*** End Patch",
  ].join("\n"));
  assert.equal(compileStructuredPatchArguments(JSON.stringify({
    path: "new.txt", contents: "Привет\n",
  })), [
    "*** Begin Patch", "*** Add File: new.txt", "+Привет", "*** End Patch",
  ].join("\n"));
  assert.throws(
    () => compileStructuredPatchArguments(JSON.stringify({ path: "new.txt", contents: "hello" })),
    { code: "missing_trailing_newline" },
  );
  assert.throws(
    () => compileStructuredPatchArguments(JSON.stringify({
      path: "notes.txt", old_string: "hello\n", new_string: "hello",
    })),
    { code: "trailing_newline_unrepresentable" },
  );
  assert.throws(
    () => compileStructuredPatchArguments(JSON.stringify({
      path: "notes.txt", old_string: "hello", new_string: "hello\n",
    })),
    { code: "trailing_newline_unrepresentable" },
  );
  assert.throws(
    () => compileStructuredPatchArguments(JSON.stringify({
      path: "notes.txt", old_string: "a\n", new_string: "b",
    })),
    { code: "trailing_newline_unrepresentable" },
  );
  assert.throws(
    () => compileSearchReplaceArguments(JSON.stringify({
      path: "notes.txt", old_string: "", new_string: "hello",
    })),
    { code: "empty_old_string" },
  );
  assert.throws(
    () => compileWriteArguments(JSON.stringify({ path: "new.txt", contents: "a\r\nb\r\n" })),
    { code: "crlf_unrepresentable" },
  );
  assert.throws(
    () => compileSearchReplaceArguments(JSON.stringify({
      operations: [{ op: "delete", path: "victim" }],
    })),
    { code: "unknown_field" },
  );
});

test("schema only offers add/update/delete with typed lines, no raw patch escape hatch", () => {
  const alternatives = GROK_STRUCTURED_PATCH_PARAMETERS.properties.operations.items.anyOf;
  assert.deepEqual(alternatives.map((s) => s.properties.op.const), ["add", "delete", "update"]);
  assert.deepEqual(GROK_STRUCTURED_PATCH_PARAMETERS.required, ["operations"]);
  assert.equal(GROK_STRUCTURED_PATCH_PARAMETERS.additionalProperties, false);
  assert.ok(alternatives.every((s) => s.additionalProperties === false));
  assert.equal(JSON.stringify(GROK_STRUCTURED_PATCH_PARAMETERS).includes('"raw_patch"'), false);
});


test("whole-line replacement emits no skip anchor and preserves unchanged selection context", () => {
  const patch = compileSearchReplaceArguments(JSON.stringify({
    path: "sample.js", old_string: "function sample() {\n  return 1;\n}",
    new_string: "function sample() {\n  return 2;\n}",
  }));
  assert.equal(patch, ["*** Begin Patch", "*** Update File: sample.js", "@@",
    "-function sample() {", "-  return 1;", "-}", "+function sample() {", "+  return 2;", "+}", "*** End Patch"].join("\n"));
  assert.ok(!patch.includes("@@ function"));
});


test("advertised logical lines and paths reject compiler-incompatible characters", () => {
  const branches = GROK_STRUCTURED_PATCH_PARAMETERS.properties.operations.items.anyOf;
  const lineSchema = branches[0].properties.lines.items;
  const linePattern = new RegExp(lineSchema.pattern, "u");
  for (const value of ["", "Привет 🧙", "  indented", "a\u0085b", "*** End Patch"]) {
    assert.ok(linePattern.test(value), JSON.stringify(value));
    assert.doesNotThrow(() => serializeStructuredPatch(wrap(add("x", [value]))));
  }
  for (const value of ["a\nb", "a\n", "\r", "a\0b"]) {
    assert.equal(linePattern.test(value), false, JSON.stringify(value));
    assert.throws(() => serializeStructuredPatch(wrap(add("x", [value]))), { code: "embedded_line_separator" });
  }
  for (const branch of branches) {
    const pattern = new RegExp(branch.properties.path.pattern, "u");
    for (const value of ["x", "a b.txt", "dir/a\u0085b.txt", "🧙.txt"]) assert.ok(pattern.test(value), value);
    for (const value of [" x", "x ", "x\n", "x\r", "x\0", "\u0085x", "x\ufeff", "x\u2028", "x\u3000"]) {
      assert.equal(pattern.test(value), false, JSON.stringify(value));
      assert.throws(() => serializeStructuredPatch(wrap(add(value))), StructuredPatchError);
    }
  }
});

test("advertised hunks require a nonempty optional anchor and at least one change", () => {
  const hunk = GROK_STRUCTURED_PATCH_PARAMETERS.properties.operations.items.anyOf[2].properties.hunks.items;
  assert.equal(hunk.required.includes("anchor"), false);
  assert.equal(hunk.properties.anchor.minLength, 1);
  const change = hunk.properties.lines.contains;
  assert.deepEqual(change.required, ["kind"]);
  assert.deepEqual(change.properties.kind.enum, ["add", "remove"]);
  assert.doesNotThrow(() => serializeStructuredPatch(wrap(update([addLine("x")]))));
  assert.throws(() => serializeStructuredPatch(wrap(update([addLine("x")], { anchor: "" }))), { code: "empty_anchor" });
  assert.throws(() => serializeStructuredPatch(wrap(update([{ kind: "context", text: "x" }]))), { code: "no_change" });
});

test("codec diagnostics disclose only recognized compiler-owned categories", () => {
  assert.equal(GROK_STRUCTURED_PATCH_CODEC.argumentErrorCode(new StructuredPatchError("empty_anchor")), "empty_anchor");
  for (const error of [new Error("PRIVATE_ARGUMENT"), { code: "empty_anchor" }, new StructuredPatchError("PRIVATE_ARGUMENT")]) {
    assert.equal(GROK_STRUCTURED_PATCH_CODEC.argumentErrorCode(error), undefined);
  }
});


test("JSON diagnostics distinguish argument and encoded operations failures without values", () => {
  for (const [text, category] of [
    ["", "empty_json"], [" \n\t", "empty_json"],
    ['{"PRIVATE_SOURCE_TEXT":', "invalid_json"],
    ['{"PRIVATE_SOURCE_TEXT":1,"PRIVATE_SOURCE_TEXT":2}', "ambiguous_json"],
    ['{"number":9007199254740993}', "ambiguous_json"],
  ]) {
    for (const scope of ["arguments", "operations"]) {
      const input = scope === "arguments" ? text : JSON.stringify({ operations: text });
      const code = `${scope}_${category}`;
      assert.throws(() => compileStructuredPatchArguments(input), error => {
        assert.equal(error.code, code);
        assert.equal(GROK_STRUCTURED_PATCH_CODEC.argumentErrorCode(error), code);
        assert.equal(error.message, `Invalid structured apply_patch arguments (${code}).`);
        return true;
      });
    }
  }
});

test("separator diagnostics identify paths, anchors and file lines without their contents", () => {
  for (const separator of ["\n", "\r", "\0"]) {
    const privateText = `PRIVATE_SOURCE_TEXT${separator}PRIVATE_FILE_NAME`;
    for (const [value, code] of [
      [wrap(add(privateText)), "embedded_path_separator"],
      [wrap(update([addLine("x")], { anchor: privateText })), "embedded_anchor_separator"],
      [wrap(add("x", [privateText])), "embedded_line_separator"],
      [wrap(update([addLine(privateText)])), "embedded_line_separator"],
    ]) {
      assert.throws(() => compileStructuredPatchArguments(JSON.stringify(value)), error => {
        assert.equal(error.code, code);
        assert.equal(GROK_STRUCTURED_PATCH_CODEC.argumentErrorCode(error), code);
        assert.doesNotMatch(error.message, /PRIVATE_SOURCE_TEXT|PRIVATE_FILE_NAME/);
        return true;
      });
    }
  }
});
