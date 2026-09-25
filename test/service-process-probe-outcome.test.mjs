import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeServiceProcessState } from "../src/service-process.mjs";

// Restore an environment name, including the case where it was never set --
// assigning `undefined` would store the literal string instead.
function restoreEnvironment(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

// A refusal has to name the probe that failed. The original message -- "could
// not verify its own start.mjs process identity" -- was true of three different
// situations and named none of them; measured 2026-09-23, identifying a
// cold-host startup failure meant reconstructing the cause from twenty-two
// unrelated ACL-timeout lines in the same log.
//
// On Windows the shadowing below makes PowerShell genuinely unusable, which is
// the case the patch was written for: the absolute system path is hidden by
// pointing SystemRoot at a directory that does not exist, and the PATH lookup is
// shadowed with a file CreateProcess rejects. Off Windows the same run fails for
// a different but equally valid reason -- this process is not the router's
// start.mjs -- so the named-outcome assertion holds everywhere while the
// unanswerable-probe assertion is Windows-specific.
//
// Environment mutation is safe here because `node --test` gives each file its
// own process, and it is restored in the finally block regardless.
test("a startup refusal names the probe that failed", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-probe-outcome-"));
  const original = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
  };
  try {
    const shadow = path.join(directory, "shadow");
    mkdirSync(shadow);
    writeFileSync(path.join(shadow, "powershell.exe"), "not an executable\n");
    process.env.SystemRoot = path.join(directory, "no-such-windows");
    process.env.WINDIR = process.env.SystemRoot;
    process.env.PATH = `${shadow};${original.PATH}`;

    assert.throws(
      () => writeServiceProcessState({ statePath: path.join(directory, "service-process.json") }),
      (error) => {
        // Named, and the name is one of the probe outcomes rather than a
        // generic "could not verify". The list is exactly what
        // probeServiceProcessState can emit.
        assert.match(
          error.message,
          /\((pid-invalid|identity-unavailable|command-line-unavailable|command-line-mismatch): /,
        );
        if (process.platform === "win32") {
          // The shadowed interpreter is what this test is named for: the refusal
          // must say the probe could not answer, not imply the identity was
          // checked and rejected.
          assert.match(error.message, /probe did not answer within its budget/);
        }
        return true;
      },
    );
  } finally {
    restoreEnvironment("PATH", original.PATH);
    restoreEnvironment("SystemRoot", original.SystemRoot);
    restoreEnvironment("WINDIR", original.WINDIR);
    rmSync(directory, { recursive: true, force: true });
  }
});
