import assert from "node:assert/strict";
import test from "node:test";

import { currentCheckoutInstaller } from "../src/update.mjs";

test("checkout updates preserve the selected app target on every platform", () => {
  const windowsCodex = currentCheckoutInstaller("win32", "codex");
  assert.deepEqual(windowsCodex.args.slice(-2), ["-Target", "codex"]);

  const windowsCursor = currentCheckoutInstaller("win32", "cursor");
  assert.equal(windowsCursor.command, "powershell.exe");
  assert.deepEqual(windowsCursor.args.slice(-2), ["-Target", "cursor"]);

  const posixCursor = currentCheckoutInstaller("darwin", "cursor");
  assert.match(posixCursor.command, /bin[\\/]install$/);
  assert.deepEqual(posixCursor.args, []);
});
