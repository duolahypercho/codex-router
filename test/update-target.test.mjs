import assert from "node:assert/strict";
import test from "node:test";

import { currentCheckoutInstaller } from "../src/update.mjs";

test("checkout updates preserve the selected app target on every platform", () => {
  const windowsClaude = currentCheckoutInstaller("win32", "claude");
  assert.equal(windowsClaude.command, "powershell.exe");
  assert.deepEqual(windowsClaude.args.slice(-2), ["-Target", "claude"]);

  const windowsCodex = currentCheckoutInstaller("win32", "codex");
  assert.deepEqual(windowsCodex.args.slice(-2), ["-Target", "codex"]);

  const posixClaude = currentCheckoutInstaller("darwin", "claude");
  assert.match(posixClaude.command, /bin[\\/]install$/);
  assert.deepEqual(posixClaude.args, []);
});
