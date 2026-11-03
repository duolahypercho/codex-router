import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const hook = fileURLToPath(new URL("../hooks/codex-stop-grok-oauth.mjs", import.meta.url));
test("the retired manual Stop hook permits answers without reading transcripts or writing state", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "retired-stop-hook-"));
  try {
    for (const input of [
      JSON.stringify({ model: "grok-oauth/grok", last_assistant_message: "42", transcript_path: "missing" }),
      JSON.stringify({ model: "gpt-6.1-sol", last_assistant_message: "An example:" }),
      "not JSON",
    ]) {
      const output = execFileSync(process.execPath, [hook], {
        input, encoding: "utf8", timeout: 10_000, windowsHide: true,
        env: { CODEX_HOME: directory, SystemRoot: process.env.SystemRoot },
      });
      assert.deepEqual(JSON.parse(output), { continue: true });
      assert.equal(existsSync(path.join(directory, "codex-router")), false);
    }
  } finally {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  }
});
