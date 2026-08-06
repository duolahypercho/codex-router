import assert from "node:assert/strict";
import test from "node:test";

import {
  checkForUpdate,
  currentCheckoutInstaller,
  installationNeedsRefresh,
  resolveCommand,
} from "../src/update.mjs";

test("checkout updates preserve the codex target on every platform", () => {
  const windowsCodex = currentCheckoutInstaller("win32", "codex");
  assert.equal(windowsCodex.command, "powershell.exe");
  assert.deepEqual(windowsCodex.args.slice(-2), ["-Target", "codex"]);

  const posixCodex = currentCheckoutInstaller("darwin", "codex");
  assert.match(posixCodex.command, /bin[\\/]install$/);
  assert.deepEqual(posixCodex.args, []);
});

test("a bare invocation updates and an explicit check stays read-only", () => {
  assert.equal(resolveCommand([]), resolveCommand(["update"]));
  assert.equal(resolveCommand(["check"]), checkForUpdate);
  assert.notEqual(resolveCommand(["check"]), resolveCommand(["update"]));
  assert.equal(resolveCommand(["nonsense"]), undefined);
});

test("an update reinstalls a revision pulled outside the updater", () => {
  assert.equal(installationNeedsRefresh(undefined, "new-revision"), true);
  assert.equal(
    installationNeedsRefresh({ current: { commit: "old-revision" } }, "new-revision"),
    true,
  );
  assert.equal(
    installationNeedsRefresh({ current: { commit: "new-revision" } }, "new-revision"),
    false,
  );
});
