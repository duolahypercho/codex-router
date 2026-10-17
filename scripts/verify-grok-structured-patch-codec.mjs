// Offline proof against the installed stock Codex patch parser, not an LLM run
// or proof of Desktop dispatch, sandbox enforcement, or provider compatibility.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileSearchReplaceArguments, serializeStructuredPatch } from "../src/grok-structured-patch.mjs";

const codex = process.argv[2];
if (!codex || !path.isAbsolute(codex)) {
  throw new Error("usage: node scripts/verify-grok-structured-patch-codec.mjs <absolute-codex-binary>");
}
const directory = mkdtempSync(path.join(os.tmpdir(), "grok-structured-patch-codec-"));
const cases = [];
function run(name, patch, success = true) {
  const result = spawnSync(codex, ["--codex-run-as-apply-patch", patch], {
    cwd: directory,
    env: { ...process.env, CODEX_HOME: path.join(directory, "codex-state") },
    encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined, name);
  assert.equal(result.signal, null, name);
  assert.equal(result.status, success ? 0 : 1, `${name}: ${result.stderr}`);
  cases.push({ name, exitCode: result.status, expectedSuccess: success });
}
function compiled(name, operations, success = true) {
  run(name, serializeStructuredPatch({ operations }), success);
}
const text = (kind, value) => ({ kind, text: value });

try {
  run("observed_bad_delimiters_rejected", "*** Begin Patch ***\n*** Add File: rejected.txt\n+bad\n*** End Patch ***", false);
  assert.equal(existsSync(path.join(directory, "rejected.txt")), false);

  compiled("create_unicode_quotes_empty_line", [{ op: "add", path: "notes.txt", lines: ["Привет 🧙", '"quotes" \\ slash', ""] }]);
  assert.equal(readFileSync(path.join(directory, "notes.txt"), "utf8"), 'Привет 🧙\n"quotes" \\ slash\n\n');
  writeFileSync(path.join(directory, "native-update.txt"), readFileSync(path.join(directory, "notes.txt")));
  run("change_existing_native_control", "*** Begin Patch\n*** Update File: native-update.txt\n@@\n-Привет 🧙\n+Hello 🧙\n*** End Patch");
  compiled("change_existing", [{ op: "update", path: "notes.txt", hunks: [{ lines: [text("remove", "Привет 🧙"), text("add", "Hello 🧙")] }] }]);
  assert.deepEqual(readFileSync(path.join(directory, "notes.txt")), readFileSync(path.join(directory, "native-update.txt")));
  assert.match(readFileSync(path.join(directory, "notes.txt"), "utf8"), /^Hello 🧙\n/);

  const before = readFileSync(path.join(directory, "notes.txt"));
  compiled("unmatched_context_rejected_without_change", [{ op: "update", path: "notes.txt", hunks: [{ lines: [text("remove", "absent-context"), text("add", "bad")] }] }], false);
  assert.deepEqual(readFileSync(path.join(directory, "notes.txt")), before);

  // Reproduces the observed repeated-anchor failure: @@ skips the anchor,
  // so a hunk that starts by removing the same line searches after it.
  const anchorOriginal = "function sample() {\n  return 1;\n}\n";
  writeFileSync(path.join(directory, "anchor.txt"), anchorOriginal);
  compiled("repeated_anchor_rejected_native_control", [{ op: "update", path: "anchor.txt", hunks: [{
    anchor: "function sample() {", lines: [text("remove", "function sample() {"), text("add", "function renamed() {")],
  }] }], false);
  assert.equal(readFileSync(path.join(directory, "anchor.txt"), "utf8"), anchorOriginal);
  run("whole_lines_avoid_repeated_anchor", compileSearchReplaceArguments(JSON.stringify({
    path: "anchor.txt", old_string: "function sample() {\n  return 1;", new_string: "function renamed() {\n  return 1;",
  })));
  assert.equal(readFileSync(path.join(directory, "anchor.txt"), "utf8"), "function renamed() {\n  return 1;\n}\n");

  // These are native parser semantics, deliberately not advertised as an exact
  // substring/unique-match edit contract. The router does not inspect files.
  writeFileSync(path.join(directory, "matching.txt"), "same\nsame\n");
  run("whole_lines_duplicate_match_uses_first_native_match", compileSearchReplaceArguments(JSON.stringify({
    path: "matching.txt", old_string: "same", new_string: "first",
  })));
  assert.equal(readFileSync(path.join(directory, "matching.txt"), "utf8"), "first\nsame\n");
  writeFileSync(path.join(directory, "matching.txt"), "  indented  \n");
  run("whole_lines_native_whitespace_tolerance", compileSearchReplaceArguments(JSON.stringify({
    path: "matching.txt", old_string: "indented", new_string: "changed",
  })));
  assert.equal(readFileSync(path.join(directory, "matching.txt"), "utf8"), "changed\n");
  writeFileSync(path.join(directory, "matching.txt"), "prefix needle suffix\n");
  run("whole_lines_are_not_substring_replacement", compileSearchReplaceArguments(JSON.stringify({
    path: "matching.txt", old_string: "needle", new_string: "changed",
  })), false);
  assert.equal(readFileSync(path.join(directory, "matching.txt"), "utf8"), "prefix needle suffix\n");
  writeFileSync(path.join(directory, "matching.txt"), "before\nremove\nafter\n");
  run("whole_lines_delete_with_surrounding_context", compileSearchReplaceArguments(JSON.stringify({
    path: "matching.txt", old_string: "before\nremove\nafter", new_string: "before\nafter",
  })));
  assert.equal(readFileSync(path.join(directory, "matching.txt"), "utf8"), "before\nafter\n");

  compiled("create_empty_file", [{ op: "add", path: "empty.txt", lines: [] }]);
  assert.equal(readFileSync(path.join(directory, "empty.txt")).length, 0);

  // The native parser owns CRLF and missing-final-newline semantics. Compare
  // the generated edit to the same explicit native edit, not assumed bytes.
  for (const [label, original] of [["crlf", "before\r\nold\r\n"], ["no_final_newline", "before\nold"]]) {
    writeFileSync(path.join(directory, "native.txt"), original);
    writeFileSync(path.join(directory, "structured.txt"), original);
    run(`${label}_native_control`, "*** Begin Patch\n*** Update File: native.txt\n@@ before\n-old\n+new\n*** End of File\n*** End Patch");
    compiled(`${label}_structured_equivalence`, [{ op: "update", path: "structured.txt", hunks: [{ anchor: "before", lines: [text("remove", "old"), text("add", "new")], endOfFile: true }] }]);
    assert.deepEqual(readFileSync(path.join(directory, "structured.txt")), readFileSync(path.join(directory, "native.txt")));
  }

  compiled("multiple_files_and_literal_patch_markers", [
    { op: "add", path: "marker.txt", lines: ["*** End Patch", "*** Delete File: notes.txt"] },
    { op: "delete", path: "empty.txt" },
  ]);
  assert.equal(readFileSync(path.join(directory, "marker.txt"), "utf8"), "*** End Patch\n*** Delete File: notes.txt\n");
  assert.ok(existsSync(path.join(directory, "notes.txt")));
  assert.equal(existsSync(path.join(directory, "empty.txt")), false);

  compiled("delete_existing", [{ op: "delete", path: "notes.txt" }]);
  assert.equal(existsSync(path.join(directory, "notes.txt")), false);
  process.stdout.write(`${JSON.stringify({ tool: "stock Codex patch parser", scope: "offline codec only", cases, allAssertionsPassed: true }, null, 2)}\n`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
