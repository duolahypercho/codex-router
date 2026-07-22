import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function render(script, platform, testRoot, target = "codex", sourceRoot = root) {
  const nodeArgs = sourceRoot === root ? [] : ["--preserve-symlinks", "--preserve-symlinks-main"];
  return execFileSync(process.execPath, [...nodeArgs, path.join(sourceRoot, "src", script), "render"], {
    cwd: sourceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_HOME: path.join(testRoot, "codex home"),
      CODEX_ROUTER_STATE_DIR: path.join(testRoot, "router state"),
      MODEL_ROUTER_STATE_DIR: path.join(testRoot, `${target} router state`),
      MODEL_ROUTER_TARGET: target,
      CODEX_ROUTER_SERVICE_PLATFORM: platform,
      XDG_CONFIG_HOME: path.join(testRoot, "xdg config"),
    },
  });
}

test("background service definitions render for macOS, Linux, and Windows", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-services-"));
  try {
    const launchd = render("service-macos.mjs", "darwin", testRoot);
    assert.match(launchd, /<string>io\.github\.codex-router<\/string>/);
    assert.match(launchd, /CODEX_ROUTER_STATE_DIR/);

    const systemd = render("service-linux.mjs", "linux", testRoot);
    assert.match(systemd, /\[Service\]/);
    assert.match(systemd, /ExecStart=/);
    assert.match(systemd, /Environment="CODEX_ROUTER_STATE_DIR=/);

    const windows = render("service-windows.mjs", "win32", testRoot);
    assert.match(windows, /@echo off\r?\n/);
    assert.match(windows, /set "CODEX_ROUTER_STATE_DIR=/);
    assert.match(windows, /litellm|start\.mjs/);

    const cursorLaunchd = render("service-macos.mjs", "darwin", testRoot, "cursor");
    assert.match(cursorLaunchd, /<string>io\.github\.codex-router\.cursor<\/string>/);
    assert.match(cursorLaunchd, /<string>cursor<\/string>/);
    assert.match(cursorLaunchd, /<string>4104<\/string>/);

    const cursorSystemd = render("service-linux.mjs", "linux", testRoot, "cursor");
    assert.match(cursorSystemd, /Description=Cursor Router/);
    assert.match(cursorSystemd, /Environment="MODEL_ROUTER_TARGET=cursor"/);
    assert.match(cursorSystemd, /MODEL_ROUTER_PORT=4104/);

    const cursorWindows = render("service-windows.mjs", "win32", testRoot, "cursor");
    assert.match(cursorWindows, /set "MODEL_ROUTER_TARGET=cursor"/);
    assert.match(cursorWindows, /set "MODEL_ROUTER_PORT=4104"/);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test(
  "systemd WorkingDirectory is unquoted and escapes literal specifiers",
  { skip: process.platform === "win32" },
  () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-systemd-path-"));
    const linkedRoot = path.join(testRoot, "router %u");
    symlinkSync(root, linkedRoot, "dir");
    try {
      const systemd = render("service-linux.mjs", "linux", testRoot, "codex", linkedRoot);
      const workingDirectory = systemd
        .split(/\r?\n/)
        .find((line) => line.startsWith("WorkingDirectory="));
      assert.equal(
        workingDirectory,
        `WorkingDirectory=${linkedRoot.replaceAll("%", "%%")}`,
      );
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);
