import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(
  readFileSync(path.join(root, "package.json"), "utf8"),
).version;

for (const args of [["--version"], ["codex", "--version"]]) {
  test(
    `model-router ${args.join(" ")} reports the package version`,
    { skip: process.platform === "win32" },
    () => {
      const result = spawnSync(path.join(root, "bin", "model-router"), args, {
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), version);
    },
  );
}
