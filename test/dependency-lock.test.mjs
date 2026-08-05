import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFileSync(path.join(root, relativePath), "utf8");

test("LiteLLM is installed from the committed hash-verified lock", () => {
  const input = read("requirements/litellm.in");
  const lock = read("requirements/litellm.lock");
  const posixInstaller = read("bin/install");
  const windowsInstaller = read("install.ps1");

  assert.match(input, /^litellm\[proxy\]==\d+\.\d+\.\d+$/m);
  assert.match(lock, /^litellm==\d+\.\d+\.\d+ \\/m);
  assert.match(lock, /--hash=sha256:/);
  assert.match(posixInstaller, /pip sync --require-hashes.*requirements\/litellm\.lock/);
  assert.match(posixInstaller, /pip install --require-hashes -r requirements\/litellm\.lock/);
  assert.match(windowsInstaller, /pip sync --require-hashes.*requirements\\litellm\.lock/);
  assert.match(windowsInstaller, /pip install --require-hashes -r requirements\\litellm\.lock/);
});
