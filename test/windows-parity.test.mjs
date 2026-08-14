import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Three Windows defects in this repository were the same mistake made in
// different files: resolve a command the way POSIX does, spawn it the way
// POSIX does, or run a POSIX shell script outright. Each one surfaced as a
// spawn error that the caller then misread as something else -- "signed out",
// "blocked by Windows application control", a check that quietly passed. None
// of them can be caught by the Linux and macOS legs of CI, and the Windows leg
// cannot exercise an operator's npm install either, so the invariants are
// asserted against the source instead.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(root, "src");

const sources = readdirSync(sourceDir)
  .filter((name) => name.endsWith(".mjs"))
  .map((name) => ({ name, text: readFileSync(path.join(sourceDir, name), "utf8") }));

test("command lookup lives in one place, so no file takes the finder's first line", () => {
  // `where.exe <name>` lists the extensionless npm shim before the .cmd shim
  // that Windows can actually run. Four copies of the same helper each took
  // line one; spawnable-command.mjs is now the only module allowed to ask.
  const offenders = sources
    .filter(({ name }) => name !== "spawnable-command.mjs")
    .filter(({ text }) => /"where\.exe"/.test(text))
    .map(({ name }) => name);
  assert.deepEqual(offenders, [], `these must use commandOnPath(): ${offenders.join(", ")}`);
});

test("no POSIX bin/ script is spawned without a Windows counterpart", () => {
  // bin/* are `#!/bin/sh` scripts. Windows reaches the same work through
  // install.ps1, the way doctor --fix and curate-models already do.
  const spawnsBinScript = /(?:spawnSync|spawn|execFileSync)\(\s*path\.join\([^)]*"bin",\s*"[a-z-]+"\s*\)/;
  const offenders = sources
    .filter(({ text }) => spawnsBinScript.test(text))
    .filter(({ text }) => !text.includes("install.ps1"))
    .map(({ name }) => name);
  assert.deepEqual(
    offenders,
    [],
    `these spawn a POSIX shell script with no win32 branch: ${offenders.join(", ")}`,
  );
});

test("every detached worker is spawned without a console window", () => {
  // A detached child gets its own console on Windows. The vision-model worker
  // missed the flag and left a console open for the length of a multi-gigabyte
  // pull, while its local-model twin two hundred lines away hid correctly.
  for (const { name, text } of sources) {
    let index = text.indexOf("detached: true");
    while (index !== -1) {
      const options = text.slice(index, index + 240);
      assert.ok(
        options.includes("windowsHide: true"),
        `${name}: a detached spawn near "${options.split("\n")[0].trim()}" must set windowsHide`,
      );
      index = text.indexOf("detached: true", index + 1);
    }
  }
});
