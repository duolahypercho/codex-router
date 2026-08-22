import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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

function withFreshGuidedSetup(confirmation, verify) {
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
    writeFileSync(
      path.join(fakeBin, "npm"),
      `#!/bin/sh
printf '%s\\n' "$*" >"$CODEX_ROUTER_NPM_LOG"
cp -R "$CODEX_ROUTER_TEST_NODE_MODULES" node_modules
`,
      { mode: 0o755 },
    );

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
