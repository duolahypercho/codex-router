// The Python side of the install is hash-verified: bin/install and install.ps1
// install requirements/python.txt with --require-hashes rather than naming
// packages. These tests fail the moment the lock stops describing
// PYTHON_REQUIREMENTS, which is the failure that stranded the first attempt at
// this work — its pin drifted twelve minor versions behind main and nothing
// noticed.
import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  INSTALLER_SCRIPTS,
  PYTHON_LOCK,
  PYTHON_LOCK_INPUT,
  PYTHON_REQUIREMENTS,
  SOURCE_ROOT,
  installerPythonInstalls,
  installerRequirementDrift,
  lockInputRequirements,
  parseLock,
  pythonInstallCommand,
  pythonLockDrift,
  recordStep,
  stepStatus,
} from "../src/install-plan.mjs";

const LOCK_WORKFLOW = ".github/workflows/python-lock.yml";

function repoFile(relative) {
  return path.join(SOURCE_ROOT, ...relative.split("/"));
}

function lockText() {
  return readFileSync(repoFile(PYTHON_LOCK), "utf8");
}

test("the checked-in lock agrees with PYTHON_REQUIREMENTS", () => {
  assert.deepEqual(pythonLockDrift(), []);
});

test("the compile input is exactly the declared requirements", () => {
  assert.deepEqual(lockInputRequirements(), PYTHON_REQUIREMENTS);
});

test("the lock pins the declared versions and nothing else for those projects", () => {
  const entries = parseLock(lockText());
  for (const requirement of PYTHON_REQUIREMENTS) {
    const [specifier, version] = requirement.split("==");
    const name = specifier.replace(/\[[^\]]*\]$/, "").toLowerCase();
    const locked = entries.filter((entry) => entry.project === name);
    assert.ok(locked.length, `${name} is absent from ${PYTHON_LOCK}`);
    for (const entry of locked) {
      assert.equal(entry.version, version, `${name} drifted in ${PYTHON_LOCK}`);
    }
  }
});

test("every pinned distribution in the lock carries a hash", () => {
  const entries = parseLock(lockText());
  // A closure this size is the point: pinning two packages left the rest
  // unverified, so a lock that suddenly holds a handful of entries is a
  // regeneration that lost the transitive tree.
  assert.ok(entries.length > 50, `${PYTHON_LOCK} pins only ${entries.length} distributions`);
  const unhashed = entries.filter((entry) => !entry.hashes);
  assert.deepEqual(unhashed, [], "every requirement must be hash-verified");
});

test("the lock is universal, not one platform's resolution", () => {
  const contents = lockText();
  assert.match(contents, /--universal/, "regenerate with bin/lock-python");
  assert.match(contents, /--generate-hashes/, "regenerate with bin/lock-python");
  // Markers are how one file serves three operating systems; a resolution
  // compiled for the maintainer's laptop has none and installs nowhere else.
  assert.match(contents, /^pywin32==.* ; sys_platform == 'win32'/m);
  assert.match(contents, /^uvloop==.* ; sys_platform != 'win32'/m);
  assert.match(contents, /^\S+==.* ; python_full_version < '3\.11'/m);
});

test("both installers install the lock with hash checking in every branch", () => {
  assert.deepEqual(installerRequirementDrift(), []);
  // Each installer has a uv branch and a pip branch, and a hash-free branch
  // would quietly reopen the gap for anyone without uv.
  for (const script of [path.join("bin", "install"), "install.ps1"]) {
    const contents = readFileSync(path.join(SOURCE_ROOT, script), "utf8");
    assert.equal(
      installerPythonInstalls(contents).length,
      2,
      `${script} must hash-check both its uv and its pip install`,
    );
    // The literals moved into the lock; leaving a copy behind in the shell is
    // exactly the drift #114 was about.
    for (const requirement of PYTHON_REQUIREMENTS) {
      assert.ok(
        !contents.includes(requirement),
        `${script} still names ${requirement}; the lock is the only pin now`,
      );
    }
  }
});

test("each installer branch yields exactly one runnable install command", () => {
  for (const [platform, script] of Object.entries(INSTALLER_SCRIPTS)) {
    const commands = ["uv", "pip"].map((tool) => pythonInstallCommand(tool, { platform }));
    for (const command of commands) {
      assert.ok(command.includes("--require-hashes"), `${script}: ${command} drops hash checking`);
      assert.ok(command.includes(`-r ${PYTHON_LOCK}`), `${script}: ${command} does not name the lock`);
      // A leading comment marker would mean the matcher picked up prose.
      assert.doesNotMatch(command, /^[#&]?\s*#/, `${script}: matched a comment, not a command`);
    }
    // The uv branch and the pip branch must be two different commands; a
    // matcher that returned the same line twice would leave one branch of the
    // shipped installer completely unexercised by CI.
    assert.notEqual(commands[0], commands[1], `${script}: uv and pip resolved to the same line`);
  }
});

test("an unknown tool or platform is refused rather than guessed", () => {
  assert.throws(() => pythonInstallCommand("poetry"), /Unknown install tool/);
  assert.throws(() => pythonInstallCommand("uv", { platform: "plan9" }), /Unknown installer platform/);
});

// The whole point of the CI job is that it runs the *shipped* command. A future
// edit that pastes a pip line into the workflow would make it possible for CI
// to pass while bin/install fails, which is the gap it was added to close.
test("the lock workflow derives its install command from the installer", () => {
  const workflow = readFileSync(repoFile(LOCK_WORKFLOW), "utf8");
  assert.match(workflow, /install-plan\.mjs python-install-command/);
  const handWritten = workflow
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .filter((line) => /(uv\s+pip|-m\s+pip)\s+install\s/.test(line))
    .filter((line) => line.includes(PYTHON_LOCK));
  assert.deepEqual(handWritten, [], "the workflow must not spell the install command itself");
});

// A paths filter that stops covering an input turns the job off silently for
// exactly the change that needed it.
test("the lock workflow is gated on every input that can invalidate the lock", () => {
  const workflow = readFileSync(repoFile(LOCK_WORKFLOW), "utf8");
  const gated = ["requirements/**", ...Object.values(INSTALLER_SCRIPTS), "src/install-plan.mjs"];
  for (const input of gated) {
    assert.ok(workflow.includes(`"${input}"`), `${LOCK_WORKFLOW} does not run when ${input} changes`);
  }
  // Paths filters cannot see a wheel PyPI yanked under an unchanged lock, so
  // the schedule is part of the gate rather than a nicety.
  assert.match(workflow, /^\s*schedule:/m, `${LOCK_WORKFLOW} must also run on a schedule`);
});

test("a regenerated lock reinstalls even when the pins are unchanged", () => {
  const root = mkdtempSync(path.join(tmpdir(), "python-lock-"));
  try {
    const platform = process.platform === "win32" ? "win32" : "darwin";
    mkdirSync(path.join(root, "requirements"), { recursive: true });
    const lock = path.join(root, "requirements", "python.txt");
    writeFileSync(lock, lockText());
    const site = platform === "win32"
      ? path.join(root, ".venv", "Lib", "site-packages")
      : path.join(root, ".venv", "lib", "python3.12", "site-packages");
    mkdirSync(site, { recursive: true });
    const pythonDirectory = platform === "win32" ? "Scripts" : "bin";
    const pythonName = platform === "win32" ? "python.exe" : "python";
    const python = path.join(root, ".venv", pythonDirectory, pythonName);
    mkdirSync(path.dirname(python), { recursive: true });
    if (platform === "win32") {
      copyFileSync(process.execPath, python);
    } else {
      const quotedExecPath = `'${process.execPath.replaceAll("'", "'\\''")}'`;
      writeFileSync(python, `#!/bin/sh\nexec ${quotedExecPath} "$@"\n`, "utf8");
      chmodSync(python, 0o755);
    }
    writeFileSync(path.join(root, ".venv", "pyvenv.cfg"), "version_info = 3.12\n");
    for (const requirement of PYTHON_REQUIREMENTS) {
      const [specifier, version] = requirement.split("==");
      const name = specifier.replace(/\[[^\]]*\]$/, "");
      mkdirSync(path.join(site, `${name}-${version}.dist-info`), { recursive: true });
    }

    recordStep("python-deps", { root });
    assert.equal(
      stepStatus("python-deps", { root, platform, runtimeProblem: () => undefined }),
      "skip",
    );

    // A transitive-only bump leaves PYTHON_REQUIREMENTS untouched. Without the
    // lock in the fingerprint the installer would report "already matches" and
    // never apply it.
    writeFileSync(lock, `${lockText()}\n# transitive bump\n`);
    assert.equal(
      stepStatus("python-deps", { root, platform, runtimeProblem: () => undefined }),
      "run",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("drift in the compile input is reported rather than tolerated", () => {
  const root = mkdtempSync(path.join(tmpdir(), "python-lock-drift-"));
  try {
    mkdirSync(path.join(root, "requirements"), { recursive: true });
    writeFileSync(repoFileIn(root, PYTHON_LOCK), lockText());
    writeFileSync(repoFileIn(root, PYTHON_LOCK_INPUT), "litellm[proxy]==1.83.9\n");
    const problems = pythonLockDrift(root);
    assert.ok(
      problems.some((problem) => problem.includes(PYTHON_LOCK_INPUT)),
      `expected an input-drift problem, got: ${problems.join(" | ")}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unhashed requirement in the lock is reported", () => {
  const root = mkdtempSync(path.join(tmpdir(), "python-lock-hash-"));
  try {
    mkdirSync(path.join(root, "requirements"), { recursive: true });
    writeFileSync(repoFileIn(root, PYTHON_LOCK_INPUT), `${PYTHON_REQUIREMENTS.join("\n")}\n`);
    writeFileSync(repoFileIn(root, PYTHON_LOCK), `${lockText()}\nsomething-unpinned==1.0.0\n`);
    const problems = pythonLockDrift(root);
    assert.ok(
      problems.some((problem) => problem.includes("without a hash")),
      `expected an unhashed-requirement problem, got: ${problems.join(" | ")}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The CI verifier starts the gateway itself, so it has to hand it the same
// environment src/start.mjs does. The encoding pair is the load-bearing part:
// LiteLLM prints Unicode banners at startup, and on a non-UTF-8 Windows code
// page that raises UnicodeEncodeError before the app finishes coming up. The
// verifier originally omitted it and both Windows legs failed against a lock
// that had installed perfectly -- the check was not starting the proxy the way
// the router does, which is the only thing it claims to test. Two copies of a
// constant is exactly the shape that has drifted in this repo before, so the
// agreement is asserted rather than left to the comment in each file.
test("the CI gateway verifier starts LiteLLM with the environment start.mjs uses", () => {
  const starter = readFileSync(repoFile("src/start.mjs"), "utf8");
  const verifier = readFileSync(
    repoFile("scripts/verify-python-lock.py"),
    "utf8",
  );

  for (const [name, value] of [
    ["PYTHONIOENCODING", "utf-8"],
    ["PYTHONUTF8", "1"],
    ["LITELLM_LOG", "ERROR"],
    ["LITELLM_TELEMETRY", "False"],
    ["NO_COLOR", "1"],
  ]) {
    assert.ok(
      new RegExp(`${name}:\\s*"${value}"`).test(starter),
      `src/start.mjs no longer sets ${name}="${value}"; update the verifier to match`,
    );
    assert.ok(
      new RegExp(`"${name}":\\s*"${value}"`).test(verifier),
      `scripts/verify-python-lock.py does not pass ${name}="${value}" to the gateway`,
    );
  }
});

function repoFileIn(root, relative) {
  return path.join(root, ...relative.split("/"));
}


test("the Python gateway workflow guards the Z.ai LiteLLM usage bridge", () => {
  const workflow = readFileSync(repoFile(LOCK_WORKFLOW), "utf8");
  for (const input of [
    "src/api-forwarder.mjs",
    "src/zai-cache-usage.mjs",
    "scripts/verify-zai-litellm-usage.mjs",
  ]) {
    assert.ok(workflow.includes(`"${input}"`), `${LOCK_WORKFLOW} does not run when ${input} changes`);
  }
  assert.match(
    workflow,
    /node scripts\/verify-zai-litellm-usage\.mjs "\$venv_python"/,
    "the installed LiteLLM bridge must be exercised after the lock is installed",
  );
});
