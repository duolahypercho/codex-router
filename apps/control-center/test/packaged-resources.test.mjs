import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const appDirectory = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(path.join(appDirectory, "package.json"));

test("packaged desktop helper resources include their transitive runtime imports", async () => {
  const { getConfig } = require("app-builder-lib/out/util/config/config.js");
  const config = await getConfig(appDirectory);
  const resources = mkdtempSync(path.join(os.tmpdir(), "control-center-resources-"));
  try {
    const helpers = config.extraResources.filter((entry) => entry.to.startsWith("src/"));
    assert.ok(helpers.length > 0);
    for (const entry of helpers) {
      cpSync(path.resolve(appDirectory, entry.from), path.join(resources, entry.to));
    }
    const script = helpers.map((entry) =>
      `await import(${JSON.stringify(pathToFileURL(path.join(resources, entry.to)).href)});`
    ).join("\n");
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, CODEX_HOME: path.join(resources, "codex-home"), MODEL_ROUTER_STATE_DIR: resources },
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  } finally {
    rmSync(resources, { recursive: true, force: true });
  }
});
