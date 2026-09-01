import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DIRTY_PREVIEW_LIMIT, localModificationsMessage } from "../src/update.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Windows does not guarantee a POSIX shell. Run these executable-shell
// assertions wherever `sh` is available (including Git Bash on CI), and skip
// them honestly on a native Windows checkout that has no such runtime.
const POSIX_SHELL_AVAILABLE = spawnSync("sh", ["-c", "exit 0"], { stdio: "ignore" }).status === 0;

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

function posixVenvHelper() {
  const source = readScript("bin", "install");
  const start = source.indexOf("ensure_uv_venv() {");
  assert.notEqual(start, -1, "bin/install must define ensure_uv_venv");
  const end = source.indexOf("\n}\n", start);
  assert.notEqual(end, -1, "ensure_uv_venv must be a complete function");
  return source.slice(start, end + 3);
}

test("install.sh is valid POSIX shell", { skip: !POSIX_SHELL_AVAILABLE }, () => {
  const result = spawnSync("sh", ["-n", path.join(root, "install.sh")], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("Homebrew setup never reconciles package-manager-owned dependencies", () => {
  const installer = readScript("bin", "install");
  const policy = installer.slice(
    installer.indexOf("install_step() {"),
    installer.indexOf("node src/secret.mjs ensure"),
  );
  assert.match(policy, /CODEX_ROUTER_PACKAGE_MANAGER:-.*= homebrew/);
  assert.match(policy, /echo managed/);
  assert.match(policy, /case "\$\(install_step node-deps\)" in\n\s*managed\)/);
  assert.match(policy, /case "\$\(install_step python-deps\)" in\n\s*managed\)/);
  assert.ok(
    policy.indexOf("CODEX_ROUTER_PACKAGE_MANAGER") < policy.indexOf('"$force_deps" = true'),
    "--force-deps must not mutate Homebrew's managed dependency tree",
  );
});

test("POSIX updates republish every installed companion client", () => {
  const installer = readScript("bin", "install");
  assert.match(installer, /\$target" != dsh[\s\S]*dsh-models\.json[\s\S]*dsh-config-manager\.mjs install/);
  assert.match(installer, /\$target" != gemini[\s\S]*gemini-models\.json[\s\S]*gemini-config-manager\.mjs install/);
  assert.match(installer, /\$target" != cursor[\s\S]*cursor-models\.json[\s\S]*cursor-config-manager\.mjs install/);
  assert.match(installer, /\$target" != claude[\s\S]*claude-models\.json[\s\S]*claude-code-config-manager\.mjs install/);
  assert.match(installer, /\$target" != openclaw[\s\S]*openclaw-models\.json[\s\S]*openclaw-config-manager\.mjs install/);
  const windows = readScript("install.ps1");
  assert.match(windows, /\$Target -ne "dsh"[\s\S]*dsh-models\.json[\s\S]*dsh-config-manager\.mjs install/);
  assert.match(windows, /\$Target -ne "gemini"[\s\S]*gemini-models\.json[\s\S]*gemini-config-manager\.mjs install/);
  assert.match(windows, /\$Target -ne "cursor"[\s\S]*cursor-models\.json[\s\S]*cursor-config-manager\.mjs install/);
  assert.match(windows, /\$Target -ne "claude"[\s\S]*claude-models\.json[\s\S]*claude-code-config-manager\.mjs install/);
  assert.match(windows, /\$Target -ne "openclaw"[\s\S]*openclaw-models\.json[\s\S]*openclaw-config-manager\.mjs install/);
});

test("guided Windows setup forwards the selected client target to the installer", () => {
  const setup = readScript("src", "setup.mjs");
  assert.match(setup, /"-File",[\s\S]*"install\.ps1"[\s\S]*"-CheckoutInstall",[\s\S]*"-Target",[\s\S]*TARGET/);
});

test("OpenClaw installers enforce its Node matrix before dependency or catalog work", () => {
  const posixInstall = withoutComments(readScript("bin", "install"));
  assert.ok(
    posixInstall.indexOf("openclaw-install.mjs\" preflight") < posixInstall.indexOf("npm ci --omit=dev"),
  );
  const windowsInstall = withoutComments(readScript("install.ps1"));
  assert.ok(
    windowsInstall.indexOf("openclaw-install.mjs\") preflight") < windowsInstall.indexOf("npm ci --omit=dev"),
  );
  const enable = withoutComments(readScript("bin", "enable"));
  assert.ok(
    enable.indexOf("openclaw-install.mjs preflight") < enable.indexOf("provider-selection.mjs ensure-configured"),
  );
});

test("Windows doctor repair forwards the active client target", () => {
  const doctor = readScript("src", "doctor.mjs");
  assert.match(doctor, /const windowsArguments = \[[\s\S]*"-Target",[\s\S]*TARGET/);
});

test("client-independent smoke tests accept every supported target", () => {
  const smoke = readScript("bin", "smoke-test");
  assert.match(smoke, /codex\|dsh\|gemini\|cursor\|claude\|openclaw/);
});

test("both installers preflight pending login-free refreshes before catalog publication", () => {
  const posix = withoutComments(readScript("bin", "install"));
  assert.ok(
    posix.indexOf("login-free-refresh-journal.mjs assert-clear") <
      posix.indexOf("node src/catalog.mjs"),
  );
  const windows = withoutComments(readScript("install.ps1"));
  assert.ok(
    windows.indexOf("login-free-refresh-journal.mjs assert-clear") <
      windows.indexOf("src/catalog.mjs"),
  );
  const doctor = readScript("src", "doctor.mjs");
  assert.match(doctor, /path\.join\(SOURCE_ROOT, "bin", "install"\)/);
  assert.match(doctor, /path\.join\(SOURCE_ROOT, "install\.ps1"\)/);
});

test("POSIX installer refuses a pending login-free refresh before catalog publication", {
  skip: process.platform === "win32" || !POSIX_SHELL_AVAILABLE,
}, () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-pending-install-"));
  const runtimeDir = path.join(testRoot, "bin");
  const stateDir = path.join(testRoot, "state");
  const callLog = path.join(testRoot, "calls.log");
  const nodeWrapper = path.join(runtimeDir, "node");
  try {
    mkdirSync(runtimeDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(stateDir, "login-free-refresh.json"),
      `${JSON.stringify({
        version: 1,
        phase: "refreshing",
        operationId: "1".repeat(32),
        providerStateVersion: 1,
        ownershipId: null,
        providerStateSha256: "2".repeat(64),
        canonicalModel: "external/model",
        displayModel: "native-alias",
      })}\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      nodeWrapper,
      `#!/bin/sh
printf '%s\n' "$*" >>"$CODEX_ROUTER_TEST_CALL_LOG"
case "\${1:-}" in
  -e) exec "$CODEX_ROUTER_TEST_REAL_NODE" "$@" ;;
  src/install-plan.mjs) [ "\${2:-}" = status ] && printf 'skip\n'; exit 0 ;;
  src/login-free-refresh-journal.mjs) exec "$CODEX_ROUTER_TEST_REAL_NODE" "$@" ;;
  *) exit 0 ;;
esac
`,
      { mode: 0o755 },
    );
    const result = spawnSync(path.join(root, "bin", "install"), [], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${runtimeDir}:${process.env.PATH || "/usr/bin:/bin"}`,
        HOME: testRoot,
        CODEX_HOME: path.join(testRoot, "codex-home"),
        CODEX_ROUTER_STATE_DIR: stateDir,
        MODEL_ROUTER_STATE_DIR: stateDir,
        CODEX_ROUTER_TEST_CALL_LOG: callLog,
        CODEX_ROUTER_TEST_REAL_NODE: process.execPath,
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /rerun bin\/refresh-catalog/);
    const calls = readFileSync(callLog, "utf8");
    assert.match(calls, /login-free-refresh-journal\.mjs assert-clear/);
    assert.doesNotMatch(calls, /src\/catalog\.mjs/);

  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("Homebrew force-deps fails early with the package-manager repair command", { skip: !POSIX_SHELL_AVAILABLE }, () => {
  const result = spawnSync("sh", [path.join(root, "bin", "install"), "--force-deps"], {
    encoding: "utf8",
    env: { ...process.env, CODEX_ROUTER_PACKAGE_MANAGER: "homebrew" },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /brew reinstall codex-router/);
  assert.doesNotMatch(result.stdout, /npm ci|LiteLLM|service|catalog/i);
});

test(
  "POSIX install and enable preserve the PATH-selected Node wrapper",
  { skip: process.platform === "win32" },
  () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-node-wrapper-"));
    const wrapperDir = path.join(testRoot, "runtime bin % wrapper");
    const wrapper = path.join(wrapperDir, "node");
    // One file per call rather than appends to a shared log. `bin/install`
    // invokes the wrapper more than once, and two `printf` appends of four
    // NUL-separated fields interleave: the field count stays a multiple of
    // four while the values shift, so a PATH lands where the marker belongs
    // and the run fails with a torn record. Order is irrelevant here -- every
    // assertion below is `some`/`filter` over the calls.
    const callDir = path.join(testRoot, "wrapper calls");
    const servicePath = `${wrapperDir}:${process.env.PATH || "/usr/local/bin:/usr/bin:/bin"}`;
    const baseEnv = { ...process.env };
    delete baseEnv.CODEX_ROUTER_NODE_BIN;
    try {
      mkdirSync(wrapperDir, { recursive: true });
      writeFileSync(
        wrapper,
        `#!/bin/sh
logged_arguments=
for argument in "$@"; do
  logged_arguments="\${logged_arguments}<\${argument}>"
done
record="$(mktemp "$CODEX_ROUTER_WRAPPER_DIR/call.XXXXXX")"
printf 'codex-router-wrapper-call\\0%s\\0%s\\0%s\\0' "$CODEX_ROUTER_NODE_BIN" "$PATH" "$logged_arguments" >"$record"
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
        CODEX_ROUTER_WRAPPER_DIR: callDir,
      };

      for (const [script, args, expectedCall] of [
        [path.join(root, "bin", "install"), ["--prepare-only"], "<src/catalog.mjs>"],
        [path.join(root, "bin", "enable"), [], "<src/service.mjs><install>"],
      ]) {
        rmSync(callDir, { recursive: true, force: true });
        mkdirSync(callDir, { recursive: true });
        const result = spawnSync(script, args, { cwd: root, encoding: "utf8", env });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const callRecords = [];
        for (const entry of readdirSync(callDir).sort()) {
          const fields = readFileSync(path.join(callDir, entry), "utf8").split("\0");
          assert.equal(fields.pop(), "", `unterminated wrapper record ${entry}`);
          assert.equal(fields.length, 4, `malformed wrapper record ${entry}`);
          const [marker, nodeBin, pathValue, loggedArguments] = fields;
          assert.equal(marker, "codex-router-wrapper-call", `malformed wrapper record ${entry}`);
          callRecords.push({ nodeBin, pathValue, loggedArguments });
        }
        const renderedCalls = JSON.stringify(callRecords, null, 2);
        assert.ok(
          callRecords.some(({ loggedArguments }) => loggedArguments.includes(expectedCall)),
          renderedCalls,
        );
        const routedCalls = callRecords.filter(({ loggedArguments }) =>
          loggedArguments.includes("<src/"),
        );
        assert.ok(routedCalls.length > 0, renderedCalls);
        for (const call of routedCalls) {
          assert.equal(call.nodeBin, wrapper, renderedCalls);
          assert.equal(call.pathValue, servicePath, renderedCalls);
        }
      }
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);

test(
  "POSIX install finds the runtime a desktop launcher named instead of refusing",
  { skip: process.platform === "win32" || !POSIX_SHELL_AVAILABLE },
  () => {
    // A GUI app, launchd, and systemd all start without the login-shell PATH.
    // Refusing a routine catalog update as "node is required but was not found
    // on PATH" while the app is running on that very Node is the failure this
    // covers: the recorded runtime is honored before the PATH lookup.
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-desktop-path-"));
    const runtimeDir = path.join(testRoot, "runtime");
    const callLog = path.join(testRoot, "calls.log");
    try {
      mkdirSync(runtimeDir, { recursive: true });
      for (const name of ["node", "npm"]) {
        writeFileSync(
          path.join(runtimeDir, name),
          `#!/bin/sh
printf '%s\\n' "${name}" >>"$CODEX_ROUTER_WRAPPER_LOG"
if [ "\${1:-}" = src/install-plan.mjs ] && [ "\${2:-}" = status ]; then
  printf 'skip\\n'
fi
`,
          { mode: 0o755 },
        );
      }
      const result = spawnSync(path.join(root, "bin", "install"), ["--prepare-only"], {
        cwd: root,
        encoding: "utf8",
        env: {
          // Deliberately no runtime on PATH, exactly as a Finder-launched app sees it.
          PATH: "/usr/bin:/bin",
          HOME: testRoot,
          CODEX_HOME: path.join(testRoot, "codex-home"),
          CODEX_ROUTER_STATE_DIR: path.join(testRoot, "state"),
          MODEL_ROUTER_STATE_DIR: path.join(testRoot, "state"),
          CODEX_ROUTER_NODE_BIN: path.join(runtimeDir, "node"),
          CODEX_ROUTER_WRAPPER_LOG: callLog,
        },
      });
      assert.doesNotMatch(result.stderr, /is required but was not found on PATH/);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(readFileSync(callLog, "utf8"), /node/);
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
  assert.match(posix, /\.venv\/bin\/python -I -c 'import encodings, sys'/);
  assert.doesNotMatch(windows, /Remove-Item\s+-Recurse.*\.venv/);
  assert.match(windows, /uv venv --clear --python 3\.12 \.venv/);
  assert.match(windows, /-m venv --clear \.venv/);
  assert.match(windows, /\$Python -I -c "import encodings, sys"/);
  assert.match(windows, /-not \$VenvHomeOk -or -not \$VenvRuntimeOk/);
});

test(
  "a present venv with no Python launcher is cleared before uv recreates it",
  { skip: !POSIX_SHELL_AVAILABLE },
  () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), "codex-router-missing-python-"));
    const bin = path.join(fixture, "bin");
    const calls = path.join(fixture, "uv-calls");
    try {
      mkdirSync(path.join(fixture, ".venv"), { recursive: true });
      mkdirSync(bin, { recursive: true });
      writeFileSync(
        path.join(bin, "uv"),
        `#!/bin/sh\nprintf '%s\\n' "$*" >>${JSON.stringify(calls)}\n`,
        { mode: 0o755 },
      );
      const result = spawnSync("sh", ["-s"], {
        cwd: fixture,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH || ""}` },
        input: `${posixVenvHelper()}\nensure_uv_venv\n`,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(calls, "utf8"), "venv --clear --python 3.12 .venv\n");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  },
);

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

  // bin/disable, bin/uninstall, and bin/stop accept no arguments, so their
  // branches pass fixed node subcommand names rather than user input.
  const takesNoArguments = new Set(["disable", "uninstall", "stop"]);
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

test("the POSIX installer's refusal is byte-identical to src/update.mjs", { skip: !POSIX_SHELL_AVAILABLE }, () => {
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

test("the POSIX installer counts tracked edits and ignores untracked files", { skip: !POSIX_SHELL_AVAILABLE }, () => {
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
test("both installers declare, validate, and forward the idle-install flags", () => {
  // The flags exist so issue #224's credential-free lifecycle validation can
  // run identically on every platform; a flag that lands in only one
  // installer silently narrows that promise to one OS.
  const posix = readFileSync(path.join(root, "install.sh"), "utf8");
  assert.match(posix, /--no-provider\)/);
  assert.match(posix, /--no-discovery\)/);
  assert.match(posix, /--no-discovery requires --no-provider/);
  assert.match(posix, /--no-provider cannot be combined with/);
  assert.match(posix, /set -- "\$@" --no-provider/);
  assert.match(posix, /set -- "\$@" --no-discovery/);

  const windows = readFileSync(path.join(root, "install.ps1"), "utf8");
  assert.match(windows, /\[switch\]\$NoProvider/);
  assert.match(windows, /\[switch\]\$NoDiscovery/);
  assert.match(windows, /-NoDiscovery requires -NoProvider/);
  assert.match(windows, /-NoProvider cannot be combined with/);
  assert.match(windows, /\$SetupArguments \+= "--no-provider"/);
  assert.match(windows, /\$SetupArguments \+= "--no-discovery"/);
});

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

// A reinstall over a working router must not be able to leave the machine
// worse than it found it. `service.mjs install` waits up to 300 s for /health,
// and a LiteLLM gateway with a large model set can lose that race on a cold
// start -- retryable, not broken. The rollback used to disable the client
// config and uninstall the LaunchAgent unconditionally, so that timeout took a
// working, routed machine and left it unrouted with no service at all.
test("installer rollback undoes only what the run created", () => {
  const posix = readFileSync(path.join(root, "bin", "install"), "utf8");
  const windows = readFileSync(path.join(root, "install.ps1"), "utf8");

  // Both installers must read the pre-existing state before they mutate it.
  assert.match(posix, /config_was_enabled=/);
  assert.match(posix, /service_was_installed=/);
  assert.ok(
    posix.indexOf("service_was_installed=false") < posix.indexOf("rollback() {"),
    "POSIX must capture prior state before defining the rollback that reads it",
  );
  assert.match(windows, /\$ConfigWasEnabled\s*=/);
  assert.match(windows, /\$ServiceWasInstalled\s*=/);

  // ...and both teardowns must be gated on it.
  assert.match(
    posix,
    /\[ "\$service_installed" = true \] && \[ "\$service_was_installed" != true \]/,
  );
  assert.match(posix, /\[ "\$config_was_enabled" != true \]/);
  assert.match(windows, /\$ServiceInstalled -and -not \$ServiceWasInstalled/);
  assert.match(windows, /-not \$ConfigWasEnabled/);
});

// The manifest names the checkout that owns the generated state, and the
// desktop app resolves its source root from it. Recording it only after the
// health wait meant a timeout left the manifest naming the previous owner
// while the installed service pointed at the new one. It must also precede
// the service step itself: the service refuses to boot while the manifest
// still names another checkout, so a record that runs after the service step
// -- which contains the health wait -- can never run at all.
test("both installers record the manifest before waiting on health", () => {
  const posix = readFileSync(path.join(root, "bin", "install"), "utf8");
  const windows = readFileSync(path.join(root, "install.ps1"), "utf8");

  assert.ok(
    posix.indexOf("install-manifest.mjs record") < posix.indexOf("wait-health.mjs"),
    "POSIX must record the manifest before the health wait",
  );
  assert.ok(
    windows.indexOf("install-manifest.mjs record") < windows.indexOf("wait-health.mjs"),
    "Windows must record the manifest before the health wait",
  );
  assert.ok(
    posix.indexOf("install-manifest.mjs record") < posix.indexOf("node src/service.mjs install"),
    "POSIX must record the manifest before installing the service",
  );
  assert.ok(
    windows.indexOf("install-manifest.mjs record") <
      windows.indexOf("& node src/service.mjs install"),
    "Windows must record the manifest before installing the service",
  );
});

// The foreign-state override is what lets a checkout rebuild state that
// another checkout owns. It must be scoped to a full ownership-transferring
// install and to nothing else: a --prepare-only run rewrites the same
// generated state but exits before the manifest record, so an override there
// would let a second checkout rebuild foreign-owned state with no ownership
// transfer ever recorded. On Windows the same override is what makes a full
// cross-checkout install possible at all, and because it manipulates the
// caller's environment it must be restored whatever the run's outcome.
test("the foreign-state override is scoped to a full ownership-transferring install", () => {
  const posix = readFileSync(path.join(root, "bin", "install"), "utf8");
  const windows = readFileSync(path.join(root, "install.ps1"), "utf8");
  // Snapshot the caller environment before any installer step can fail. A
  // prepare-only run never sets the override, but its finally still restores
  // this snapshot, so capturing it only inside the full-install branch would
  // delete a value the caller already had.
  const pushIndex = windows.indexOf("Push-Location $ScriptDirectory");
  const outerTryIndex = windows.indexOf("try {", pushIndex);
  const hadSnapshotIndex = windows.indexOf(
    "$HadForeignStateOverride = $null -ne (Get-Item Env:\\MODEL_ROUTER_ALLOW_FOREIGN_STATE",
  );
  const valueSnapshotIndex = windows.indexOf(
    "$SavedForeignStateOverride = $env:MODEL_ROUTER_ALLOW_FOREIGN_STATE",
  );
  assert.ok(
    hadSnapshotIndex !== -1 && hadSnapshotIndex < outerTryIndex,
    "Windows must snapshot whether the caller had the override before the installer can fail",
  );
  assert.ok(
    valueSnapshotIndex !== -1 && valueSnapshotIndex < outerTryIndex,
    "Windows must snapshot the caller's override value before the installer can fail",
  );

  // POSIX: exported only after the arguments are known, and only for a full
  // install -- a prepare-only run must meet the guard like any other writer.
  const parseIndex = posix.indexOf("--prepare-only) prepare_only=true ;;");
  const exportIndex = posix.indexOf("MODEL_ROUTER_ALLOW_FOREIGN_STATE=1");
  assert.notEqual(parseIndex, -1, "bin/install must parse --prepare-only");
  assert.notEqual(exportIndex, -1, "bin/install must export the override");
  assert.ok(
    exportIndex > parseIndex,
    "the override must be exported only after --prepare-only is parsed",
  );
  assert.match(
    posix,
    /if \[ "\$prepare_only" != true \]; then\n  MODEL_ROUTER_ALLOW_FOREIGN_STATE=1\n  export MODEL_ROUTER_ALLOW_FOREIGN_STATE\nfi/,
    "the override must be guarded on a full install",
  );
  if (POSIX_SHELL_AVAILABLE) {
    const syntax = spawnSync("sh", ["-n", path.join(root, "bin", "install")], {
      encoding: "utf8",
    });
    assert.equal(syntax.status, 0, syntax.stderr);
  }

  // Windows: set only when -PrepareOnly is off, in place before the generated
  // state is rebuilt, and restored in the outer finally -- removed when the
  // caller had none, put back verbatim when they did.
  assert.match(
    windows,
    /if \(-not \$PrepareOnly\) \{[\s\S]{0,600}?\$env:MODEL_ROUTER_ALLOW_FOREIGN_STATE = "1"/,
    "the override must be set only for a full install",
  );
  const setIndex = windows.indexOf('$env:MODEL_ROUTER_ALLOW_FOREIGN_STATE = "1"');
  assert.ok(
    setIndex !== -1 && setIndex < windows.indexOf("src/catalog.mjs"),
    "the override must be in place before the generated state is rebuilt",
  );
  const finallyBody = windows.slice(windows.lastIndexOf("} finally {"));
  assert.match(
    finallyBody,
    /\$env:MODEL_ROUTER_ALLOW_FOREIGN_STATE = \$SavedForeignStateOverride/,
    "a pre-existing override value must be restored",
  );
  assert.match(
    finallyBody,
    /Remove-Item Env:\\MODEL_ROUTER_ALLOW_FOREIGN_STATE/,
    "an override the caller never had must be removed",
  );
  assert.ok(
    finallyBody.indexOf("Pop-Location") >
      finallyBody.indexOf("MODEL_ROUTER_ALLOW_FOREIGN_STATE"),
    "the environment restore belongs in the same finally as the location restore",
  );
});

test("Windows prepare-only restores the caller foreign-state override live", {
  skip: process.platform !== "win32" && "requires Windows PowerShell",
}, () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-windows-env-"));
  try {
    const shimDir = path.join(testRoot, "shims");
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(
      path.join(shimDir, "node.cmd"),
      [
        "@echo off",
        'if /I "%~1"=="-p" (',
        "  echo 24.0.0",
        "  exit /b 0",
        ")",
        'if defined CODEX_ROUTER_TEST_FAIL_LEGACY if /I "%~1"=="src\\legacy-migration.mjs" exit /b 17',
        'if defined CODEX_ROUTER_TEST_FAIL_LEGACY if /I "%~1"=="src/legacy-migration.mjs" exit /b 17',
        'if /I "%~1"=="src/install-plan.mjs" if /I "%~2"=="status" (',
        "  echo skip",
        "  exit /b 0",
        ")",
        "exit /b 0",
        "",
      ].join("\r\n"),
    );
    writeFileSync(path.join(shimDir, "npm.cmd"), "@echo off\r\nexit /b 0\r\n");

    const harnessPath = path.join(testRoot, "assert-restore.ps1");
    writeFileSync(
      harnessPath,
      [
        "param([string] $Installer, [string] $FixtureRoot, [string] $ShimDir)",
        '$env:PATH = "$ShimDir;$env:PATH"',
        '$env:CODEX_HOME = Join-Path $FixtureRoot "codex-home"',
        '$env:CODEX_ROUTER_STATE_DIR = Join-Path $FixtureRoot "router-state"',
        '$env:MODEL_ROUTER_STATE_DIR = Join-Path $FixtureRoot "router-state"',
        '$env:MODEL_ROUTER_ALLOW_FOREIGN_STATE = "caller-value"',
        "& $Installer -CheckoutInstall -PrepareOnly",
        'if ($env:MODEL_ROUTER_ALLOW_FOREIGN_STATE -ne "caller-value") {',
        '  throw "prepare-only did not preserve the caller override"',
        "}",
        "Remove-Item Env:\\MODEL_ROUTER_ALLOW_FOREIGN_STATE",
        "& $Installer -CheckoutInstall -PrepareOnly",
        "if (Test-Path Env:\\MODEL_ROUTER_ALLOW_FOREIGN_STATE) {",
        '  throw "prepare-only introduced an override the caller did not have"',
        "}",
        '$env:MODEL_ROUTER_ALLOW_FOREIGN_STATE = "early-failure-value"',
        '$env:CODEX_ROUTER_TEST_FAIL_LEGACY = "1"',
        "$SawExpectedFailure = $false",
        "try {",
        "  & $Installer -CheckoutInstall -PrepareOnly",
        "} catch {",
        "  $SawExpectedFailure = $true",
        "} finally {",
        "  Remove-Item Env:\\CODEX_ROUTER_TEST_FAIL_LEGACY",
        "}",
        'if (-not $SawExpectedFailure) { throw "expected the legacy probe to fail" }',
        'if ($env:MODEL_ROUTER_ALLOW_FOREIGN_STATE -ne "early-failure-value") {',
        '  throw "early failure did not restore the caller override"',
        "}",
        "",
      ].join("\r\n"),
    );

    const result = spawnSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        harnessPath,
        path.join(root, "install.ps1"),
        testRoot,
        shimDir,
      ],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});
