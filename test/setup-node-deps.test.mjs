import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const PYTHON_AVAILABLE =
  spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

const GUIDED_SETUP_HELPER = String.raw`
import errno
import os
import select
import sys
import termios
import time

node, setup, checkout, home, state_dir, secret, confirmation = sys.argv[1:]
env = os.environ.copy()
env.update({
    "HOME": home,
    "CODEX_HOME": home,
    "CODEX_ROUTER_STATE_DIR": state_dir,
    "MODEL_ROUTER_STATE_DIR": state_dir,
    "MODEL_ROUTER_TARGET": "codex",
    "DEEPSEEK_API_KEY": "",
})
pid, master = os.forkpty()
if pid == 0:
    os.chdir(checkout)
    os.execve(node, [node, setup, "--guided", "--providers", "deepseek", "--selection-only"], env)

output = bytearray()
confirmed = False
key_sent = False
while True:
    ready, _, _ = select.select([master], [], [], 15)
    if not ready:
        os.kill(pid, 9)
        raise SystemExit("timed out waiting for guided setup")
    try:
        chunk = os.read(master, 4096)
    except OSError as error:
        if error.errno == errno.EIO:
            break
        raise
    if not chunk:
        break
    output.extend(chunk)
    if not confirmed and b"Enter DeepSeek API key securely now?" in output:
        os.write(master, confirmation.encode() + b"\n")
        confirmed = True
    if confirmation.lower() == "y" and not key_sent and b"DeepSeek API key: " in output:
        deadline = time.monotonic() + 2
        while termios.tcgetattr(master)[3] & termios.ECHO:
            if time.monotonic() >= deadline:
                os.kill(pid, 9)
                raise SystemExit("provider-key did not disable terminal echo")
            time.sleep(0.01)
        os.write(master, secret.encode() + b"\n")
        key_sent = True

_, status = os.waitpid(pid, 0)
os.close(master)
sys.stdout.buffer.write(output)
raise SystemExit(os.waitstatus_to_exitcode(status))
`;

// A stub that stands in for a working `npm ci`: it records the arguments and
// materializes the dependency tree the run needs.
const NPM_STUB_SUCCEEDS = `#!/bin/sh
printf '%s\\n' "$*" >"$CODEX_ROUTER_NPM_LOG"
cp -R "$CODEX_ROUTER_TEST_NODE_MODULES" node_modules
`;

// What a real `npm ci` failure looks like on disk: the tree is emptied before
// it is refilled, so a run that dies partway leaves no node_modules at all.
const NPM_STUB_FAILS = `#!/bin/sh
printf '%s\\n' "$*" >"$CODEX_ROUTER_NPM_LOG"
rm -rf node_modules
echo "npm error code EAI_AGAIN" >&2
exit 1
`;

function withFreshGuidedSetup(confirmation, verify, { npmStub = NPM_STUB_SUCCEEDS } = {}) {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-guided-deps-"));
  const checkout = path.join(testRoot, "checkout");
  const fakeBin = path.join(testRoot, "bin");
  const stateDir = path.join(testRoot, "state");
  const npmLog = path.join(testRoot, "npm.log");
  const secret = "TEST_DEEPSEEK_GUIDED_KEY";

  try {
    mkdirSync(checkout, { recursive: true });
    cpSync(path.join(root, "src"), path.join(checkout, "src"), { recursive: true });
    cpSync(path.join(root, "config"), path.join(checkout, "config"), { recursive: true });
    copyFileSync(path.join(root, "package.json"), path.join(checkout, "package.json"));
    copyFileSync(path.join(root, "package-lock.json"), path.join(checkout, "package-lock.json"));

    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(path.join(fakeBin, "npm"), npmStub, { mode: 0o755 });

    const result = spawnSync(
      "python3",
      [
        "-c",
        GUIDED_SETUP_HELPER,
        process.execPath,
        path.join(checkout, "src", "setup.mjs"),
        checkout,
        testRoot,
        stateDir,
        secret,
        confirmation,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH || "/usr/local/bin:/usr/bin:/bin"}`,
          CODEX_ROUTER_NPM_LOG: npmLog,
          CODEX_ROUTER_TEST_NODE_MODULES: path.join(root, "node_modules"),
        },
        timeout: 25_000,
      },
    );

    verify({ checkout, npmLog, result, secret, stateDir });
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
}

test(
  "fresh guided setup installs Node dependencies before storing a provider key",
  { skip: process.platform === "win32" || !PYTHON_AVAILABLE },
  () => {
    withFreshGuidedSetup("Y", ({ checkout, npmLog, result, secret, stateDir }) => {
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.doesNotMatch(result.stdout, /ERR_MODULE_NOT_FOUND/);
      assert.equal(readFileSync(npmLog, "utf8"), "ci --omit=dev\n");
      assert.equal(
        readFileSync(path.join(stateDir, "deepseek-api-key.secret"), "utf8"),
        `${secret}\n`,
      );
      assert.equal(existsSync(path.join(checkout, "node_modules", ".package-lock.json")), true);
    });
  },
);

test(
  "fresh guided setup does not install Node dependencies when key setup is declined",
  { skip: process.platform === "win32" || !PYTHON_AVAILABLE },
  () => {
    withFreshGuidedSetup("n", ({ checkout, npmLog, result, stateDir }) => {
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /DeepSeek API setup was cancelled/);
      assert.equal(existsSync(npmLog), false);
      assert.equal(existsSync(path.join(checkout, "node_modules")), false);
      assert.equal(existsSync(path.join(stateDir, "deepseek-api-key.secret")), false);
    });
  },
);

test(
  "a failed dependency install is reported as one, not as a missing credential",
  { skip: process.platform === "win32" || !PYTHON_AVAILABLE },
  () => {
    withFreshGuidedSetup(
      "Y",
      ({ checkout, npmLog, result, stateDir }) => {
        assert.equal(readFileSync(npmLog, "utf8"), "ci --omit=dev\n");
        // Guided runs collect credential gaps and continue. A wiped
        // node_modules is not a credential gap: nothing later in the run works,
        // so it has to fail the run instead of being filed under the provider.
        assert.notEqual(result.status, 0, result.stdout);
        // Exit 2 means "the checkout is healthy, configuration is unfinished"
        // and tells both installers to keep the update. The checkout is not
        // healthy here, so this must not claim that status.
        assert.notEqual(result.status, 2, result.stdout);
        assert.match(result.stdout, /Node dependency installation failed/);
        assert.match(result.stdout, /npm ci exited with status 1/);
        assert.doesNotMatch(result.stdout, /was not configured/);
        assert.doesNotMatch(result.stdout, /Still needs a credential/);
        assert.equal(existsSync(path.join(checkout, "node_modules")), false);
        assert.equal(existsSync(path.join(stateDir, "deepseek-api-key.secret")), false);
      },
      { npmStub: NPM_STUB_FAILS },
    );
  },
);

const GIT_AVAILABLE = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;

function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

// install.sh runs the dependency install after `git pull --ff-only` has already
// moved the managed checkout onto the new code. `npm ci` empties node_modules
// before it refills it, so a failure there without a rollback leaves the
// service on code it has no dependencies for -- strictly worse than the same
// failure inside bin/install, which has always restored the previous revision.
test(
  "install.sh restores the previous revision when the dependency install fails",
  { skip: process.platform === "win32" || !GIT_AVAILABLE },
  () => {
    // Realpath, not the raw temp path: the module's `is this the entry point`
    // check compares `process.argv[1]` against `import.meta.url`, and macOS
    // hands out /var/... temp directories that resolve to /private/var/...,
    // where the two never match and the step silently does nothing.
    const testRoot = realpathSync(
      mkdtempSync(path.join(os.tmpdir(), "codex-router-install-deps-")),
    );
    try {
      const upstream = path.join(testRoot, "upstream");
      const installDir = path.join(testRoot, "checkout");
      const fakeBin = path.join(testRoot, "bin");
      const npmLog = path.join(testRoot, "npm.log");

      mkdirSync(upstream, { recursive: true });
      assert.equal(
        spawnSync("git", ["init", "-b", "main", upstream], { stdio: "ignore" }).status,
        0,
      );
      git(upstream, "config", "user.email", "test@example.invalid");
      git(upstream, "config", "user.name", "codex-router test");
      cpSync(path.join(root, "src"), path.join(upstream, "src"), { recursive: true });
      cpSync(path.join(root, "config"), path.join(upstream, "config"), { recursive: true });
      copyFileSync(path.join(root, "package.json"), path.join(upstream, "package.json"));
      copyFileSync(
        path.join(root, "package-lock.json"),
        path.join(upstream, "package-lock.json"),
      );
      git(upstream, "add", "-A");
      git(upstream, "commit", "-m", "base");

      assert.equal(
        spawnSync("git", ["clone", upstream, installDir], { stdio: "ignore" }).status,
        0,
      );
      const previousRevision = git(installDir, "rev-parse", "HEAD");

      // The update the user is running for: without it there is nothing to
      // restore and the regression is invisible.
      writeFileSync(path.join(upstream, "src", "new-file.mjs"), "export const updated = true;\n");
      git(upstream, "add", "-A");
      git(upstream, "commit", "-m", "update");
      const updatedRevision = git(upstream, "rev-parse", "HEAD");
      assert.notEqual(updatedRevision, previousRevision);

      mkdirSync(fakeBin, { recursive: true });
      writeFileSync(path.join(fakeBin, "npm"), NPM_STUB_FAILS, { mode: 0o755 });

      const result = spawnSync("sh", ["-s", "--", "--deepseek-api-key", "--install-dir", installDir], {
        input: readFileSync(path.join(root, "install.sh"), "utf8"),
        encoding: "utf8",
        cwd: testRoot,
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH || "/usr/local/bin:/usr/bin:/bin"}`,
          HOME: testRoot,
          CODEX_HOME: testRoot,
          CODEX_ROUTER_STATE_DIR: path.join(testRoot, "state"),
          MODEL_ROUTER_STATE_DIR: path.join(testRoot, "state"),
          CODEX_ROUTER_REPOSITORY_URL: upstream,
          CODEX_ROUTER_NPM_LOG: npmLog,
        },
        timeout: 60_000,
      });

      // The run got as far as the dependency step, and stopped there: the key
      // prompt never ran, so no credential was touched.
      assert.equal(readFileSync(npmLog, "utf8"), "ci --omit=dev\n");
      assert.notEqual(result.status, 0, result.stdout);
      assert.match(result.stderr, /installing Node dependencies failed/);
      assert.match(
        result.stderr,
        new RegExp(`the managed source checkout was restored to ${previousRevision}`),
      );
      assert.equal(git(installDir, "rev-parse", "HEAD"), previousRevision);
      assert.equal(existsSync(path.join(installDir, "src", "new-file.mjs")), false);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);
