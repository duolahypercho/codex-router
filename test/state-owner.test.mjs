import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The guard canonicalizes every root it compares, so the recorded owner comes
// back in the platform's own form (a drive-qualified, backslash path on
// Windows). Resolve the fixture the same way instead of asserting POSIX
// separators that only ever match on macOS and Linux.
const FOREIGN_OWNER = path.resolve("/somewhere/else/codex-router");

// A state directory records the checkout that installed it. Regenerating the
// catalog or gateway config from a different checkout desynchronizes what Codex
// offers from what the gateway can route, which surfaces to the user as an
// upstream account error rather than a routing error.
function withState({ owner }, run) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "state-owner-"));
  if (owner !== undefined) {
    writeFileSync(
      path.join(stateDir, "install-manifest.json"),
      JSON.stringify({ version: 1, current: { sourceRoot: owner }, history: [] }),
      { mode: 0o600 },
    );
  }
  try {
    return run(stateDir);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

// Overriding the state directory does not redirect everything a run writes.
// `CODEX_AGENTS_DIR` is `$CODEX_HOME/agents`, and `src/catalog.mjs` prunes it
// to whatever the state directory it just read promotes as a subagent. A test
// that isolates the state but inherits the real home therefore deletes the
// operator's own routed agent definitions -- every model promoted by a local
// capability proof rather than by the shipped registry -- while their settings
// files, which live in the isolated state, survive to say the models are still
// enabled. Isolate both, on every spawn in this file.
function isolatedEnv(stateDir, extraEnv = {}) {
  const codexHome = path.join(stateDir, "codex-home");
  mkdirSync(codexHome, { recursive: true });
  return {
    ...process.env,
    CODEX_HOME: codexHome,
    MODEL_ROUTER_STATE_DIR: stateDir,
    ...extraEnv,
  };
}

function ownershipStatus(stateDir, extraEnv = {}) {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import { stateOwnershipStatus } from "./src/state-owner.mjs";' +
        "process.stdout.write(JSON.stringify(stateOwnershipStatus()));",
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: isolatedEnv(stateDir, extraEnv),
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("unowned state belongs to whoever writes it first", () => {
  withState({ owner: undefined }, (stateDir) => {
    const status = ownershipStatus(stateDir);
    assert.equal(status.foreign, false);
    assert.equal(status.owner, undefined);
  });
});

test("state owned by this checkout is not foreign", () => {
  withState({ owner: root }, (stateDir) => {
    assert.equal(ownershipStatus(stateDir).foreign, false);
  });
});

test("state owned by another checkout is reported as foreign", () => {
  withState({ owner: FOREIGN_OWNER }, (stateDir) => {
    const status = ownershipStatus(stateDir);
    assert.equal(status.foreign, true);
    assert.equal(status.owner, FOREIGN_OWNER);
  });
});

test("the documented override clears the conflict", () => {
  withState({ owner: FOREIGN_OWNER }, (stateDir) => {
    const status = ownershipStatus(stateDir, { MODEL_ROUTER_ALLOW_FOREIGN_STATE: "1" });
    assert.equal(status.foreign, true);
    assert.equal(status.overridden, true);
  });
});

test("writing the catalog from a foreign checkout fails with guidance, not a stack trace", () => {
  withState({ owner: FOREIGN_OWNER }, (stateDir) => {
    const result = spawnSync(process.execPath, [path.join(root, "src", "catalog.mjs")], {
      cwd: root,
      encoding: "utf8",
      env: isolatedEnv(stateDir),
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /owned by another checkout/);
    assert.ok(result.stderr.includes(FOREIGN_OWNER), result.stderr);
    assert.doesNotMatch(result.stderr, /at assertStateOwnership/);
  });
});

test("writing the gateway config from a foreign checkout is refused", () => {
  withState({ owner: FOREIGN_OWNER }, (stateDir) => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import { writeLiteLlmConfig } from "./src/litellm-config.mjs";' +
          "try { writeLiteLlmConfig(); process.stdout.write('wrote'); }" +
          "catch (error) { process.stdout.write(error.code || 'other'); }",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: isolatedEnv(stateDir),
      },
    );
    assert.equal(result.stdout, "foreign_state_owner");
  });
});

test("rendering the gateway config to an explicit path stays unguarded", () => {
  withState({ owner: FOREIGN_OWNER }, (stateDir) => {
    const target = path.join(stateDir, "scratch-litellm.yaml");
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import { writeLiteLlmConfig } from "./src/litellm-config.mjs";' +
          `writeLiteLlmConfig(${JSON.stringify(target)});` +
          "process.stdout.write('wrote');",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: isolatedEnv(stateDir),
      },
    );
    assert.equal(result.stdout, "wrote", result.stderr);
  });
});

test("the installer is allowed to take ownership", () => {
  withState({ owner: FOREIGN_OWNER }, (stateDir) => {
    // bin/install exports the override for its whole run because it rebuilds
    // generated state before recording the new owner. This is the one case in
    // this file that clears the guard and runs the catalog for real, so it is
    // the one that used to reach the operator's own `~/.codex/agents`.
    const result = spawnSync(process.execPath, [path.join(root, "src", "catalog.mjs")], {
      cwd: root,
      encoding: "utf8",
      env: isolatedEnv(stateDir, { MODEL_ROUTER_ALLOW_FOREIGN_STATE: "1" }),
    });
    assert.doesNotMatch(result.stderr || "", /owned by another checkout/);
  });
});

test("doctor --fix from a foreign checkout delegates to the recorded owner", () => {
  const owner = mkdtempSync(path.join(os.tmpdir(), "state-owner-checkout-"));
  const marker = path.join(owner, "delegated-doctor-ran");
  mkdirSync(path.join(owner, "bin"), { recursive: true });
  mkdirSync(path.join(owner, "src"), { recursive: true });
  writeFileSync(path.join(owner, "bin", "install"), "#!/bin/sh\n");
  writeFileSync(
    path.join(owner, "src", "doctor.mjs"),
    `import { writeFileSync } from "node:fs";\n` +
      `writeFileSync(${JSON.stringify(marker)}, "ok");\n`,
  );
  try {
    withState({ owner }, (stateDir) => {
      const result = spawnSync(
        process.execPath,
        [path.join(root, "src", "doctor.mjs"), "--fix"],
        {
          cwd: root,
          encoding: "utf8",
          env: isolatedEnv(stateDir),
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(marker), true);
      assert.match(result.stderr, /repairing from the owning checkout/);
    });
  } finally {
    rmSync(owner, { recursive: true, force: true });
  }
});

// The defect this replaces: this file ran the real catalog with a scratch state
// directory and the developer's own `CODEX_HOME`, so `npm test` deleted every
// routed subagent definition the machine had earned through a local capability
// proof. The settings that named those models live in the state directory and
// survived, which is what made it look like a router update had reset the
// subagents rather than a test run having removed the files Codex reads.
//
// Scoped to `path.join(..., "src", "catalog.mjs")` on purpose: that is how a
// spawn of the catalog is spelled here, and matching the bare path string would
// also catch the files that only read `src/catalog.mjs` as source text.
test("no test spawns the catalog without isolating CODEX_HOME", () => {
  const offenders = readdirSync(path.join(root, "test"))
    .filter((entry) => entry.endsWith(".mjs"))
    .filter((entry) => {
      const source = readFileSync(path.join(root, "test", entry), "utf8");
      return (
        /["']src["']\s*,\s*["']catalog\.mjs["']/.test(source) &&
        !source.includes("CODEX_HOME")
      );
    });
  assert.deepEqual(
    offenders,
    [],
    `${offenders.join(", ")} run the catalog against the real Codex home, whose ` +
      "agents directory no state-directory override redirects",
  );
});
