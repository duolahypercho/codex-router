import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  checkForUpdate,
  currentCheckoutInstaller,
  installationNeedsRefresh,
  localModificationsMessage,
  parseArguments,
  resolveCommand,
  trayRefreshRequired,
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

test("tray refresh is required when the checkout dist bundle exists", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tray-refresh-dist-"));
  try {
    mkdirSync(path.join(root, "dist", "Model Router.app"), { recursive: true });
    assert.equal(
      trayRefreshRequired({
        platform: "darwin",
        home: path.join(root, "home"),
        sourceRoot: root,
        registeredPath: "",
      }),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tray refresh is required when setup installed the home app bundle", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tray-refresh-home-"));
  try {
    mkdirSync(path.join(root, "home", "Applications", "Model Router.app"), {
      recursive: true,
    });
    assert.equal(
      trayRefreshRequired({
        platform: "darwin",
        home: path.join(root, "home"),
        sourceRoot: path.join(root, "router"),
        registeredPath: "",
      }),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tray refresh is required when only a registered bundle path exists", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tray-refresh-registered-"));
  try {
    const registered = path.join(root, "Model Router.app");
    mkdirSync(registered, { recursive: true });
    assert.equal(
      trayRefreshRequired({
        platform: "darwin",
        home: path.join(root, "home"),
        sourceRoot: path.join(root, "router"),
        registeredPath: registered,
      }),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tray refresh is skipped when no tray bundle exists", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tray-refresh-none-"));
  try {
    assert.equal(
      trayRefreshRequired({
        platform: "darwin",
        home: path.join(root, "home"),
        sourceRoot: path.join(root, "router"),
        registeredPath: "",
      }),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tray refresh is skipped on non-macOS platforms", () => {
  assert.equal(
    trayRefreshRequired({
      platform: "linux",
      home: os.homedir(),
      sourceRoot: path.resolve("."),
      registeredPath: path.resolve("."),
    }),
    false,
  );
});

test("--force is a flag on a command, never mistaken for one", () => {
  assert.equal(resolveCommand(["--force"]), resolveCommand(["update"]));
  assert.equal(resolveCommand(["check", "--force"]), checkForUpdate);

  assert.deepEqual(parseArguments([]), { command: resolveCommand(["update"]), force: false });
  assert.deepEqual(parseArguments(["--force"]), {
    command: resolveCommand(["update"]),
    force: true,
  });
  assert.deepEqual(parseArguments(["rollback", "--force"]), {
    command: resolveCommand(["rollback"]),
    force: true,
  });
  assert.equal(parseArguments(["nonsense"]).command, undefined);
});

test("a refused update names the files in the way and both ways forward", () => {
  const message = localModificationsMessage([" M src/router.mjs", " M bin/install"], "/tmp/checkout");
  assert.match(message, /2 tracked files/);
  // Whoever hits this has to be able to see what is holding the update, or
  // they are stuck on an old version with no way to work out why.
  assert.match(message, /src\/router\.mjs/);
  assert.match(message, /bin\/install/);
  assert.match(message, /git -C \/tmp\/checkout stash/);
  assert.match(message, /--force/);
});

test("a long list of local changes is previewed, not dumped", () => {
  const changes = Array.from({ length: 14 }, (_, index) => ` M src/file-${index}.mjs`);
  const message = localModificationsMessage(changes, "/tmp/checkout");
  assert.match(message, /14 tracked files/);
  assert.match(message, /src\/file-9\.mjs/);
  assert.equal(message.includes("src/file-10.mjs"), false);
  assert.match(message, /\.\.\.and 4 more/);
});

test("a single local change reads as one file, not one files", () => {
  assert.match(localModificationsMessage([" M src/router.mjs"]), /1 tracked file;/);
});
