import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DIRTY_PREVIEW_LIMIT, localModificationsMessage } from "../src/update.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Nothing on a non-Windows machine can execute PowerShell -- the parse test in
// this file is skipped off Windows for exactly that reason -- so the Windows
// assertions here read the shipped scripts as text instead. That still catches
// the class of defect at issue: wrappers that silently drop the arguments they
// were handed, and a refusal message that drifts from the one it mirrors.
function windowsSwitchBranches(source) {
  const start = source.indexOf("switch ($Command) {");
  assert.notEqual(start, -1, "codex-router.ps1 must dispatch on $Command");
  const body = source.slice(start);
  const branches = new Map();
  const opener = /"([a-z-]+)"\s*\{/g;
  let match;
  while ((match = opener.exec(body))) {
    let depth = 1;
    let index = opener.lastIndex;
    while (depth > 0 && index < body.length) {
      if (body[index] === "{") depth += 1;
      else if (body[index] === "}") depth -= 1;
      index += 1;
    }
    branches.set(match[1], body.slice(opener.lastIndex, index - 1));
  }
  return branches;
}

// A comment may legitimately name a command the code must never run.
function withoutComments(source) {
  return source
    .split("\n")
    .filter((line) => !/^\s*(#|\/\/)/.test(line))
    .join("\n");
}

// PowerShell forwards an argument array either as a value ($Arguments) or by
// splatting it into a named-parameter call (@Arguments); both count.
const FORWARDS_ARGUMENTS = /[@$]Arguments\b/;

// Line endings are normalized because these assertions and the extraction below
// anchor on "\n". A Windows checkout without the .gitattributes rule -- or with
// a global core.autocrlf -- hands back "\r\n" and every anchor silently stops
// matching, which reads as "the shipped script lost this code" rather than as a
// checkout artifact. Normalizing keeps the failure honest either way.
function readScript(...parts) {
  return readFileSync(path.join(root, ...parts), "utf8").replace(/\r\n/g, "\n");
}

// The refusal that blocks an update on a dirty checkout is written three times
// -- once in Node for the installed updater, once in PowerShell and once in
// POSIX shell for the two bootstrap installers, neither of which can import
// from src/. Three copies is how the first fix ended up incomplete, so every
// property that matters is asserted against all three here.
const BOOTSTRAP_INSTALLERS = [
  {
    name: "install.sh",
    source: readScript("install.sh"),
    previewLimit: /^dirty_preview_limit=(\d+)$/m,
    forceGuard: /if \[ "\$force" != true \]; then/,
    reset: /git -C "\$install_dir" reset --hard HEAD/,
  },
  {
    name: "install.ps1",
    source: readScript("install.ps1"),
    previewLimit: /^\$DirtyPreviewLimit = (\d+)$/m,
    forceGuard: /if \(-not \$Force\) \{ throw \(Get-LocalModificationMessage/,
    reset: /git -C \$Directory reset --hard HEAD/,
  },
];

// Unlike PowerShell, POSIX shell runs everywhere the suite does -- `sh -n` is
// already relied on above -- so install.sh gets executed rather than pattern
// matched. Lifting the helpers straight out of the shipped file keeps the test
// honest: it runs the code that ships, not a copy of it.
function posixDirtyHelpers() {
  const source = readScript("install.sh");
  const start = source.indexOf("dirty_preview_limit=");
  const messageStart = source.indexOf("local_modifications_message() {");
  assert.notEqual(start, -1, "install.sh must declare dirty_preview_limit");
  assert.ok(messageStart > start, "install.sh must define local_modifications_message");
  const end = source.indexOf("\n}\n", messageStart);
  assert.notEqual(end, -1, "local_modifications_message must be a complete function");
  return source.slice(start, end + 3);
}

function runPosixHelper(call, args, options = {}) {
  const result = spawnSync("sh", ["-s", ...args], {
    input: `${posixDirtyHelpers()}\n${call}\n`,
    encoding: "utf8",
    ...options,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("install.sh is valid POSIX shell", () => {
  const result = spawnSync("sh", ["-n", path.join(root, "install.sh")], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});

test(
  "POSIX install and enable preserve the PATH-selected Node wrapper",
  { skip: process.platform === "win32" },
  () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-node-wrapper-"));
    const wrapperDir = path.join(testRoot, "runtime bin % wrapper");
    const wrapper = path.join(wrapperDir, "node");
    const callLog = path.join(testRoot, "wrapper calls.log");
    const servicePath = `${wrapperDir}:${process.env.PATH || "/usr/local/bin:/usr/bin:/bin"}`;
    const baseEnv = { ...process.env };
    delete baseEnv.CODEX_ROUTER_NODE_BIN;
    try {
      mkdirSync(wrapperDir, { recursive: true });
      writeFileSync(
        wrapper,
        `#!/bin/sh
printf '%s\\t%s\\t' "$CODEX_ROUTER_NODE_BIN" "$PATH" >>"$CODEX_ROUTER_WRAPPER_LOG"
printf '<%s>' "$@" >>"$CODEX_ROUTER_WRAPPER_LOG"
printf '\\n' >>"$CODEX_ROUTER_WRAPPER_LOG"
if [ "\${1:-}" = src/install-plan.mjs ] && [ "\${2:-}" = status ]; then
  printf 'skip\\n'
fi
`,
        { mode: 0o755 },
      );
      const env = {
        ...baseEnv,
        PATH: servicePath,
        HOME: testRoot,
        CODEX_HOME: path.join(testRoot, "codex home"),
        CODEX_ROUTER_STATE_DIR: path.join(testRoot, "router state"),
        MODEL_ROUTER_STATE_DIR: path.join(testRoot, "router state"),
        CODEX_ROUTER_WRAPPER_LOG: callLog,
      };

      for (const [script, args, expectedCall] of [
        [path.join(root, "bin", "install"), ["--prepare-only"], "<src/catalog.mjs>"],
        [path.join(root, "bin", "enable"), [], "<src/service.mjs><install>"],
      ]) {
        writeFileSync(callLog, "", "utf8");
        const result = spawnSync(script, args, { cwd: root, encoding: "utf8", env });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const calls = readFileSync(callLog, "utf8").trim().split("\n");
        assert.ok(calls.some((line) => line.includes(expectedCall)), calls.join("\n"));
        const routedCalls = calls.filter((line) => line.includes("\t<src/"));
        assert.ok(
          routedCalls.every((line) => line.startsWith(`${wrapper}\t${servicePath}\t`)),
          calls.join("\n"),
        );
      }
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);

test(
  "install.ps1 parses under powershell.exe",
  { skip: process.platform !== "win32" },
  () => {
    // The POSIX installer is covered by `sh -n` everywhere, but nothing on a
    // non-Windows machine can parse install.ps1 -- it ships edits that no
    // developer without Windows can validate. Running the real parser here is
    // the only place that gap closes.
    const escaped = path.join(root, "install.ps1").replaceAll("'", "''");
    const check = [
      "$tokens = $null; $errors = $null",
      `[System.Management.Automation.Language.Parser]::ParseFile('${escaped}', [ref]$tokens, [ref]$errors) | Out-Null`,
      "if ($errors.Count) { $errors | ForEach-Object { $_.Message }; exit 1 }",
    ].join("; ");
    execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", check], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
  },
);

test("both installers keep the update when setup reports exit 2", () => {
  // setup.mjs exits 2 for "the checkout is healthy, configuration is
  // unfinished". The number is the contract between three files that cannot
  // import each other, so losing the branch in either installer silently
  // restores the trap where a declined prompt discards the code update.
  const posix = readFileSync(path.join(root, "install.sh"), "utf8");
  const windows = readFileSync(path.join(root, "install.ps1"), "utf8");

  assert.match(posix, /setup_status["\s]*-eq["\s]*2/);
  assert.match(windows, /\$SetupExitCode\s+-eq\s+2/);

  // The rollback must stay reachable for every other non-zero status, so an
  // unrecognized failure still restores the previous revision.
  assert.match(posix, /switch --detach "\$previous_revision"/);
  assert.match(windows, /switch --detach \$PreviousRevision/);
});

test("broken virtual environments use the venv tools' exact-target clear mode", () => {
  const posix = readFileSync(path.join(root, "bin", "install"), "utf8");
  const windows = readFileSync(path.join(root, "install.ps1"), "utf8");

  assert.doesNotMatch(posix, /rm\s+-rf\s+\.venv/);
  assert.match(posix, /uv venv --clear --python 3\.12 \.venv/);
  assert.match(posix, /python3 -m venv --clear \.venv/);
  assert.doesNotMatch(windows, /Remove-Item\s+-Recurse.*\.venv/);
  assert.match(windows, /uv venv --clear --python 3\.12 \.venv/);
  assert.match(windows, /-m venv --clear \.venv/);
});

test("the kept-update message names the way back", () => {
  // Keeping the update on exit 2 is the right default, but a user who wanted
  // the old revision needs to be told the escape hatch exists; the retained
  // ref is invisible otherwise.
  const posix = readFileSync(path.join(root, "install.sh"), "utf8");
  const windows = readFileSync(path.join(root, "install.ps1"), "utf8");
  assert.match(posix, /\.\/bin\/rollback/);
  assert.match(windows, /codex-router\.ps1 rollback/);
});

test("the Windows wrapper hands every command its own arguments", () => {
  // A hardcoded argument list is invisible: the command still runs, it just
  // runs without the flag the caller typed. `rollback --force` was lost this
  // way, leaving a Windows user with tracked edits no documented route to the
  // force path at all.
  const branches = windowsSwitchBranches(
    readFileSync(path.join(root, "codex-router.ps1"), "utf8"),
  );
  assert.ok(branches.size >= 16, `only found ${branches.size} branches`);

  // bin/disable and bin/uninstall accept no arguments, so their
  // branches pass fixed node subcommand names rather than user input.
  const takesNoArguments = new Set(["disable", "uninstall"]);
  for (const [command, body] of branches) {
    if (takesNoArguments.has(command)) {
      assert.equal(
        FORWARDS_ARGUMENTS.test(body),
        false,
        `the ${command} branch forwards arguments its POSIX counterpart rejects`,
      );
      continue;
    }
    assert.ok(
      FORWARDS_ARGUMENTS.test(body),
      `the ${command} branch drops the caller's arguments`,
    );
  }
});

test("native catalog adoption is inside both installer rollback transactions", () => {
  const posix = readFileSync(path.join(root, "bin", "install"), "utf8");
  const windows = readFileSync(path.join(root, "install.ps1"), "utf8");

  assert.ok(
    posix.indexOf("trap rollback EXIT HUP INT TERM") <
      posix.indexOf("prepare-from-config"),
    "POSIX adoption must start after the rollback trap",
  );
  assert.match(posix, /clear-pending/);
  assert.match(windows, /\$AdoptionPending\s*=\s*\$true/);
  assert.match(windows, /native-catalog-source\.mjs clear-pending/);
  assert.match(windows, /elseif \(\$AdoptionPending\)/);
});

test("rollback --force reaches the updater on Windows", () => {
  // bin/rollback runs `update.mjs rollback "$@"`: the subcommand is fixed and
  // the caller's flags are appended to it. Replacing the whole list with
  // @("rollback") is what silently dropped --force.
  const branches = windowsSwitchBranches(
    readFileSync(path.join(root, "codex-router.ps1"), "utf8"),
  );
  assert.match(branches.get("rollback"), /@\("rollback"\)\s*\+\s*\$Arguments/);
});

test("Windows exposes signed-routing and the shared refresh transaction", () => {
  const windows = readScript("codex-router.ps1");
  const branches = windowsSwitchBranches(windows);
  assert.match(windows, /"signed-routing"/);
  assert.match(windows, /"refresh-catalog"/);
  assert.match(
    branches.get("signed-routing"),
    /control\.mjs"\s+\(@\("signed-routing"\)\s*\+\s*\$Arguments\)/,
  );
  assert.match(branches.get("refresh-catalog"), /refresh-catalog\.mjs"\s+\$Arguments/);

  const posix = readScript("bin", "refresh-catalog");
  assert.match(posix, /exec node .*src\/refresh-catalog\.mjs" "\$@"/);
});

test("both bootstrap installers refuse on tracked edits only", () => {
  // Run without -CheckoutInstall / from a pipe, these are the curl|sh and
  // irm|iex self-update paths. They reimplement requireReplaceableCheckout()
  // because a piped script has no checkout to import from -- so they have to
  // agree with it. Counting untracked files is what stranded people on an old
  // version with no way to work out why.
  for (const { name, source } of BOOTSTRAP_INSTALLERS) {
    assert.match(source, /status --porcelain --untracked-files=no/, name);
    assert.equal(
      /status --porcelain(?! --untracked-files=no)/.test(source),
      false,
      `an untracked-file-counting status check is back in ${name}`,
    );
  }
});

test("every copy of the refusal previews at the same limit", () => {
  for (const { name, source, previewLimit } of BOOTSTRAP_INSTALLERS) {
    const declared = source.match(previewLimit);
    assert.ok(declared, `${name} must declare its own preview limit`);
    assert.equal(Number(declared[1]), DIRTY_PREVIEW_LIMIT, name);
  }
});

test("the POSIX installer's refusal is byte-identical to src/update.mjs", () => {
  // Not a pattern match: install.sh's own helper is executed and its output
  // compared with the Node original. A reword on either side fails here, which
  // is the coupling that was missing when the first fix landed in one file.
  for (const changes of [
    ["M src/router.mjs"],
    ["M src/router.mjs", "M bin/install"],
    Array.from({ length: 14 }, (_, index) => `M src/file-${index}.mjs`),
  ]) {
    const posix = runPosixHelper('local_modifications_message "$1" "$2"', [
      changes.join("\n"),
      "/tmp/checkout",
    ]);
    assert.equal(posix, `${localModificationsMessage(changes, "/tmp/checkout")}\n`);
  }
});

test("the POSIX installer counts tracked edits and ignores untracked files", () => {
  // The behaviour change every curl|sh user gets: a checkout carrying nothing
  // but an untracked file now updates instead of refusing forever.
  const checkout = mkdtempSync(path.join(os.tmpdir(), "posix-dirty-"));
  const git = (...args) =>
    execFileSync("git", ["-C", checkout, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    });
  try {
    git("init", "--quiet");
    writeFileSync(path.join(checkout, "tracked.txt"), "original\n");
    git("add", "tracked.txt");
    git("commit", "--quiet", "-m", "seed");

    const modifications = () => runPosixHelper('local_modifications "$1"', [checkout]);
    assert.equal(modifications(), "");

    writeFileSync(path.join(checkout, "stray.txt"), "not git's business\n");
    assert.equal(modifications(), "", "an untracked file must not block the update");

    writeFileSync(path.join(checkout, "tracked.txt"), "edited\n");
    assert.equal(modifications(), "M tracked.txt\n");
    // ...and only the tracked one, so the message never names a file the user
    // is about to be told to stash.
    assert.equal(modifications().includes("stray.txt"), false);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("the Windows installer's refusal says what src/update.mjs says", () => {
  // PowerShell cannot run here, so this is the string-level equivalent of the
  // executed POSIX comparison above: each sentence of the Node original is
  // checked against the PowerShell literal that has to reproduce it.
  const windows = readScript("install.ps1");
  const reference = localModificationsMessage(["M src/router.mjs"], "/tmp/checkout");

  assert.ok(reference.startsWith("The checkout has local changes to 1 tracked file;"));
  assert.match(
    windows,
    /"The checkout has local changes to \$\(\$Changes\.Count\) tracked file\$\{Plural\}; refusing to replace them during update:"/,
  );
  assert.equal(windows.includes("has local changes; automatic update"), false);

  assert.match(reference, /^Keep them: {4}git -C \/tmp\/checkout stash$/m);
  assert.match(windows, /"Keep them: {4}git -C \$Directory stash"/);
  // The one deliberate difference: PowerShell spells its switch -Force.
  assert.match(reference, /^Discard them: re-run the same command with --force$/m);
  assert.match(windows, /"Discard them: re-run the same command with -Force"/);
  assert.match(windows, /^\s*\[switch\]\$Force,$/m);

  assert.match(windows, /Select-Object -First \$DirtyPreviewLimit/);
  assert.match(windows, /"  \.\.\.and \$Remainder more"/);
});

test("the POSIX installer's force escape follows its own flag conventions", () => {
  // install.sh parses long flags in a case statement and sets a shell boolean;
  // --force is wired the same way rather than inventing a new mechanism.
  const posix = readScript("install.sh");
  assert.match(posix, /^\s*--force\)$/m);
  assert.match(posix, /^force=false$/m);
  assert.match(posix, /^\s*force=true$/m);
  assert.match(posix, /--force {12}Discard edits to tracked files/);
});

test("no force path anywhere can destroy untracked files", () => {
  const node = readScript("src", "update.mjs");
  for (const { name, source, forceGuard, reset } of BOOTSTRAP_INSTALLERS) {
    // Refusing is the default; discarding happens only when asked for.
    assert.match(source, forceGuard, name);
    // `reset --hard` restores tracked files and leaves untracked ones alone.
    assert.match(source, reset, name);
  }
  assert.match(node, /if \(!force\) throw new Error\(localModificationsMessage\(changes\)\)/);
  assert.match(node, /git\(\["reset", "--hard", "HEAD"\]/);

  // `git clean` would delete work git was never asked to track. No copy of
  // this refusal has one, and none may grow one.
  const sources = [...BOOTSTRAP_INSTALLERS, { name: "src/update.mjs", source: node }];
  for (const { name, source } of sources) {
    assert.equal(
      /git\b[^\n]*\bclean\b/.test(withoutComments(source)),
      false,
      `${name} must not run git clean`,
    );
  }
});

test("the documented rollback behaviour matches the exit-2 contract", () => {
  // The docs previously said a failed install always restores the previous
  // revision, which stopped being true when exit 2 was introduced.
  const docs = readFileSync(path.join(root, "docs", "INSTALL.md"), "utf8");
  assert.match(docs, /exits 2/);
  assert.match(docs, /the update is kept/);
});

// The skill-pack install is best-effort and must never roll the router back.
// Two structural properties guard that: --prepare-only must exit before the
// skills step touches ~/.codex/skills, and the skills step must run after the
// rollback trap is disarmed, so a skills failure cannot undo config/service.
test("prepare-only exits before the skills step", () => {
  const source = readScript("bin", "install");
  const prepareExit = source.indexOf("Dependencies and local Codex router files are prepared");
  const skillsStep = source.indexOf("skills-install.mjs install");
  assert.notEqual(prepareExit, -1, "bin/install must keep the prepare-only exit");
  assert.notEqual(skillsStep, -1, "bin/install must call the skills step");
  assert.ok(prepareExit < skillsStep, "--prepare-only must exit before the skills step");
});

test("the skills step runs after the rollback trap is disarmed", () => {
  const source = readScript("bin", "install");
  const trapDisarmed = source.indexOf("trap - EXIT HUP INT TERM");
  const skillsStep = source.indexOf("skills-install.mjs install");
  assert.notEqual(trapDisarmed, -1, "bin/install must disarm the rollback trap");
  assert.notEqual(skillsStep, -1, "bin/install must call the skills step");
  assert.ok(trapDisarmed < skillsStep, "skills step must run after the trap is disarmed");
});

test("uninstall removes the managed skills", () => {
  const source = readScript("bin", "uninstall");
  assert.match(source, /skills-install\.mjs uninstall/, "bin/uninstall must remove the managed skills");
  const uninstallStep = source.indexOf("skills-install.mjs uninstall");
  const serviceStep = source.indexOf("src/service.mjs uninstall");
  assert.ok(serviceStep < uninstallStep, "skills removal must follow the service removal");
});
