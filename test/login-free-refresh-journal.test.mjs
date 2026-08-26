import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { writePrivateJson } from "../src/file-security.mjs";

const root = path.resolve(".");
const journalModule = path.join(root, "src", "login-free-refresh-journal.mjs");
const journalUrl = pathToFileURL(journalModule).href;

function environment(stateDir) {
  return {
    ...process.env,
    CODEX_ROUTER_STATE_DIR: stateDir,
    MODEL_ROUTER_STATE_DIR: stateDir,
  };
}

function validJournal() {
  return `${JSON.stringify({
    version: 1,
    phase: "refreshing",
    operationId: "1".repeat(32),
    providerStateVersion: 1,
    ownershipId: null,
    providerStateSha256: "2".repeat(64),
    canonicalModel: "external/model",
    displayModel: "native-alias",
  })}\n`;
}

test("malformed and non-private refresh journals fail closed without mutation", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-journal-invalid-"));
  const journalPath = path.join(stateDir, "login-free-refresh.json");
  try {
    for (const source of ["{malformed\n", validJournal()]) {
      writePrivateJson(journalPath, {}, { directoryMode: 0o700 });
      writeFileSync(journalPath, source);
      if (source !== "{malformed\n" && process.platform !== "win32") {
        chmodSync(journalPath, 0o644);
      }
      const before = readFileSync(journalPath, "utf8");
      const result = spawnSync(process.execPath, [journalModule, "assert-clear"], {
        cwd: root,
        encoding: "utf8",
        env: environment(stateDir),
      });
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        source === "{malformed\n" ? /Invalid login-free refresh journal/ : /not private/,
      );
      assert.equal(readFileSync(journalPath, "utf8"), before);
      if (process.platform === "win32") break;
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("symlinked refresh state and journal are refused without changing their targets", {
  skip: process.platform === "win32",
}, () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-journal-symlink-"));
  const journalTarget = path.join(stateDir, "journal-target.json");
  const journalPath = path.join(stateDir, "login-free-refresh.json");
  const stateTarget = path.join(stateDir, "provider-state-target.json");
  const statePath = path.join(stateDir, "codex-provider-mode.json");
  try {
    writeFileSync(journalTarget, validJournal(), { mode: 0o600 });
    symlinkSync(journalTarget, journalPath);
    const journalBefore = readFileSync(journalTarget, "utf8");
    const journalResult = spawnSync(process.execPath, [journalModule, "assert-clear"], {
      cwd: root,
      encoding: "utf8",
      env: environment(stateDir),
    });
    assert.notEqual(journalResult.status, 0);
    assert.match(journalResult.stderr, /journal is a symlink/);
    assert.equal(readFileSync(journalTarget, "utf8"), journalBefore);
    rmSync(journalPath);

    const stateSource = `${JSON.stringify({
      version: 1,
      previousPresent: true,
      previousModelProvider: "openai",
      previousModelPresent: true,
      previousModel: "gpt-5.6-sol",
    })}\n`;
    writeFileSync(stateTarget, stateSource, { mode: 0o600 });
    symlinkSync(stateTarget, statePath);
    const driver = `
      const { beginLoginFreeRefresh } = await import(${JSON.stringify(journalUrl)});
      beginLoginFreeRefresh({ canonicalModel: "external/model", displayModel: "native-alias" });
    `;
    const stateResult = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", driver],
      { cwd: root, encoding: "utf8", env: environment(stateDir) },
    );
    assert.notEqual(stateResult.status, 0);
    assert.match(stateResult.stderr, /symlinked login-free provider state/);
    assert.equal(readFileSync(stateTarget, "utf8"), stateSource);
    assert.equal(existsSync(journalPath), false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
