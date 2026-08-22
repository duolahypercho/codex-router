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
import re
import select
import sys
import termios
import time

node, setup, checkout, home, state_dir, secret, confirmation, models = sys.argv[1:]
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
    args = [node, setup, "--guided", "--providers", "deepseek"]
    # The cancel run has to reach the "Proceed?" gate, which lives past the
    # --selection-only return.
    if models != "cancel":
        args.append("--selection-only")
    os.execve(node, args, env)

output = bytearray()
models_cleared = False
flash_selected = False
models_confirmed = False
confirmed = False
proceeded = False
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
    model_prompts = output.count(b"Toggle model numbers")
    # Whatever the step offers, checked or not: the number is what gets typed,
    # and which mark it carries is the assertion's business, not the driver's.
    flash = re.search(br"\[[ x]\]\s+(\d+)\. DeepSeek V4 Flash \(API\)", output)
    if models == "defaults":
        # The operator who reads the list and presses Enter, which is the one
        # keystroke that decides what a first install puts in the picker.
        if not models_confirmed and model_prompts >= 1:
            os.write(master, b"\n")
            models_confirmed = True
    elif not models_cleared and model_prompts >= 1:
        os.write(master, b"n\n")
        models_cleared = True
    elif models_cleared and not flash_selected and model_prompts >= 2:
        if flash is None:
            os.kill(pid, 9)
            raise SystemExit("DeepSeek V4 Flash was not listed")
        os.write(master, flash.group(1) + b"\n")
        flash_selected = True
    elif flash_selected and not models_confirmed and model_prompts >= 3:
        os.write(master, b"\n")
        models_confirmed = True
    if models == "cancel" and not proceeded and b"Proceed?" in output:
        os.write(master, b"n\n")
        proceeded = True
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

function withFreshGuidedSetup(confirmation, verify, models = "select-flash") {
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
        models,
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
      // `--selection-only` is documented as saving the provider selection
      // without installing, and the model step reports its answer the same
      // way: the picker is rewritten by the install, not by the preview.
      assert.equal(existsSync(path.join(stateDir, "model-picker.json")), false);
      assert.match(result.stdout, /"models":\s*\[\s*"deepseek\/deepseek-v4-flash"\s*\]/);
      assert.match(result.stdout, /DeepSeek V4 Flash \(API\)/);
      assert.match(result.stdout, /DeepSeek V4 Pro \(API\)/);
      assert.doesNotMatch(result.stdout, /Kimi K3/);
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
  "guided model selection starts empty so a first install opts in model by model",
  { skip: process.platform === "win32" || !PYTHON_AVAILABLE },
  () => {
    withFreshGuidedSetup(
      "n",
      ({ result, stateDir }) => {
        assert.equal(result.status, 0, result.stderr || result.stdout);
        // Enabling a provider offers its models; it does not choose them.
        assert.match(result.stdout, /\[ \] \d+\. DeepSeek V4 Flash \(API\)/);
        assert.match(result.stdout, /\[ \] \d+\. DeepSeek V4 Pro \(API\)/);
        assert.doesNotMatch(result.stdout, /\[x\] \d+\. DeepSeek V4/);
        assert.match(result.stdout, /"models":\s*\[\s*\]/);
        assert.equal(existsSync(path.join(stateDir, "model-picker.json")), false);
      },
      "defaults",
    );
  },
);

test(
  "a cancelled guided setup leaves the model picker exactly as it found it",
  { skip: process.platform === "win32" || !PYTHON_AVAILABLE },
  () => {
    withFreshGuidedSetup(
      "n",
      ({ result, stateDir }) => {
        assert.notEqual(result.status, 0);
        assert.match(result.stdout, /Setup was cancelled before installing the service/);
        assert.match(result.stdout, /Models: deepseek\/deepseek-v4-flash/);
        // Answering "n" to "Proceed?" installs nothing, so it must also have
        // rewritten none of this machine's protected picker state.
        assert.equal(existsSync(path.join(stateDir, "model-picker.json")), false);
      },
      "cancel",
    );
  },
);
