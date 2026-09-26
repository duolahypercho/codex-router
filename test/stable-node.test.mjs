import assert from "node:assert/strict";
import test from "node:test";

import {
  childNodeBinary,
  homebrewStableNodePath,
  stableNodeBinary,
} from "../src/stable-node.mjs";

const posix = process.platform !== "win32";
const onDisk = (...paths) => (candidate) => paths.includes(candidate);

test("a Homebrew keg path is recorded as its formula's opt link", () => {
  const exists = onDisk("/opt/homebrew/opt/node/bin/node", "/usr/local/opt/node@22/bin/node");
  assert.equal(
    homebrewStableNodePath("/opt/homebrew/Cellar/node/26.9.0/bin/node", { exists }),
    "/opt/homebrew/opt/node/bin/node",
  );
  // A keg-only versioned formula stays on its own formula, revision suffix
  // and all, rather than moving to whatever `node` links.
  assert.equal(
    homebrewStableNodePath("/usr/local/Cellar/node@22/22.19.0_1/bin/node", { exists }),
    "/usr/local/opt/node@22/bin/node",
  );
  assert.equal(
    homebrewStableNodePath("/home/linuxbrew/.linuxbrew/Cellar/node/26.10.0/bin/node", {
      exists: onDisk("/home/linuxbrew/.linuxbrew/opt/node/bin/node"),
    }),
    "/home/linuxbrew/.linuxbrew/opt/node/bin/node",
  );
});

test("any other path, or a keg without an opt link, is left alone", () => {
  const exists = onDisk();
  for (const nodePath of [
    "/opt/homebrew/bin/node",
    "/opt/homebrew/opt/node/bin/node",
    "/Users/me/.nvm/versions/node/v26.9.0/bin/node",
    "/opt/homebrew/Cellar/node/26.9.0/bin/node",
    "/opt/homebrew/Cellar/node/26.9.0/libexec/bin/npm",
    "C:\\Program Files\\nodejs\\node.exe",
    "",
  ]) {
    assert.equal(homebrewStableNodePath(nodePath, { exists }), nodePath);
  }
});

test("an existing configured runtime wins, a stale one falls through", { skip: !posix }, () => {
  assert.equal(
    stableNodeBinary({
      environment: { CODEX_ROUTER_NODE_BIN: "/stable/node" },
      execPath: "/other/node",
      electron: false,
      exists: onDisk("/stable/node", "/other/node"),
    }),
    "/stable/node",
  );
  assert.equal(
    stableNodeBinary({
      environment: { CODEX_ROUTER_NODE_BIN: "/removed/node" },
      execPath: "/other/node",
      electron: false,
      exists: onDisk("/other/node"),
    }),
    "/other/node",
  );
  // A relative value is never trusted; it would resolve against whatever
  // directory the reader happens to run in.
  assert.equal(
    stableNodeBinary({
      environment: { CODEX_ROUTER_NODE_BIN: "bin/node" },
      execPath: "/other/node",
      electron: false,
      exists: () => true,
    }),
    "/other/node",
  );
});

test("this process's keg resolves to its opt link even after the upgrade deleted it", { skip: !posix }, () => {
  assert.equal(
    stableNodeBinary({
      environment: {},
      execPath: "/opt/homebrew/Cellar/node/26.9.0/bin/node",
      electron: false,
      exists: onDisk("/opt/homebrew/opt/node/bin/node"),
    }),
    "/opt/homebrew/opt/node/bin/node",
  );
  // A configured keg path is mapped the same way.
  assert.equal(
    stableNodeBinary({
      environment: { CODEX_ROUTER_NODE_BIN: "/opt/homebrew/Cellar/node/26.10.0/bin/node" },
      execPath: "/elsewhere/node",
      electron: false,
      exists: onDisk(
        "/opt/homebrew/Cellar/node/26.10.0/bin/node",
        "/opt/homebrew/opt/node/bin/node",
        "/elsewhere/node",
      ),
    }),
    "/opt/homebrew/opt/node/bin/node",
  );
});

test("an Electron host is never named; PATH and the usual locations are searched", { skip: !posix }, () => {
  assert.equal(
    stableNodeBinary({
      environment: { PATH: "/custom/bin" },
      execPath: "/Applications/Codex Router.app/Contents/MacOS/Codex Router",
      electron: true,
      exists: onDisk("/Applications/Codex Router.app/Contents/MacOS/Codex Router", "/custom/bin/node"),
    }),
    "/custom/bin/node",
  );
  assert.throws(
    () => stableNodeBinary({ environment: {}, execPath: "/app/host", electron: true, exists: onDisk() }),
    /Node\.js is unavailable/,
  );
});

test("a child spawn falls back to this process when no Node can be found", () => {
  assert.equal(
    childNodeBinary({ environment: {}, execPath: "/app/host", electron: true, exists: onDisk() }),
    "/app/host",
  );
  if (posix) {
    assert.equal(
      childNodeBinary({
        environment: {},
        execPath: "/opt/homebrew/Cellar/node/26.9.0/bin/node",
        electron: false,
        exists: onDisk("/opt/homebrew/opt/node/bin/node"),
      }),
      "/opt/homebrew/opt/node/bin/node",
    );
  }
});
