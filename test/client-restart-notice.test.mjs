import test from "node:test";
import assert from "node:assert/strict";

import {
  clientRestartNotice,
  runningClientProcesses,
} from "../src/client-restart-notice.mjs";

// `ps -axo pid=,ppid=,args=` output, which is what the probe parses.
function fakePs(rows, { status = 0 } = {}) {
  const stdout = rows.map(([pid, ppid, args]) => `${pid} ${ppid} ${args}`).join("\n");
  return () => ({ status, stdout });
}

const posix = { platform: "darwin" };

test("the harness is never told to restart, because it reloads its settings", () => {
  assert.equal(clientRestartNotice("dsh"), undefined);
});

test("a client that is not running is not made to sound like a problem", () => {
  const notice = clientRestartNotice("codex", {
    ...posix,
    spawn: fakePs([[1, 0, "/sbin/launchd"]]),
  });
  assert.match(notice, /Codex is not running/);
  assert.doesNotMatch(notice, /right now/);
});

test("a running client is named with the process the user can verify", () => {
  const notice = clientRestartNotice("codex", {
    ...posix,
    spawn: fakePs([
      [1, 0, "/sbin/launchd"],
      [4242, 1, "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"],
    ]),
  });
  assert.match(notice, /running right now \(PID 4242\)/);
  assert.match(notice, /Fully quit and reopen/);
});

test("helper processes fold into the root rather than burying it", () => {
  const notice = clientRestartNotice("codex", {
    ...posix,
    spawn: fakePs([
      [4242, 1, "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"],
      [4243, 4242, "/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helper"],
      [4244, 4242, "/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helper"],
    ]),
  });
  assert.match(notice, /PID 4242 and 2 other processes/);
});

// The router runs from paths with `codex` all over them. Matching those would
// make the notice tell the user to quit the very thing printing it.
test("the router never reports itself as the client", () => {
  const found = runningClientProcesses("codex", {
    ...posix,
    spawn: fakePs([
      [700, 1, "/usr/local/bin/node /Users/x/codex-router/src/router.mjs"],
      [701, 1, "/usr/local/bin/node /Users/x/codex-router/src/start.mjs"],
      [702, 1, "/Users/x/Applications/Codex Router.app/Contents/MacOS/ModelRouterTray"],
    ]),
  });
  assert.deepEqual(found, []);
});

// Failing to look must never be worse than never having looked: the caller
// still prints the unconditional advice.
test("a probe that cannot enumerate processes reports nothing, not a guess", () => {
  const found = runningClientProcesses("codex", {
    ...posix,
    spawn: fakePs([[4242, 1, "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"]], { status: 1 }),
  });
  assert.deepEqual(found, []);
  const notice = clientRestartNotice("codex", {
    ...posix,
    spawn: () => {
      throw new Error("ps is missing");
    },
  });
  assert.match(notice, /not running/);
});

test("Gemini CLI is named as itself", () => {
  const notice = clientRestartNotice("gemini", {
    ...posix,
    spawn: fakePs([[900, 1, "/usr/local/bin/gemini"]]),
  });
  assert.match(notice, /^Gemini CLI is running right now \(PID 900\)/);
});

// Quitting the desktop app leaves Chromium's crash reporter behind, reparented
// to launchd, under the same framework path the Codex pattern matches. Seen on
// a host where Codex had been closed for hours and the install still said to
// quit it.
const CRASHPAD =
  "/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/153.0.8010.53/Helpers/browser_crashpad_handler --monitor-self --monitor-self-annotation=ptype=crashpad-handler --handshake-fd=5";

test("orphaned crash reporters are not a running client", () => {
  const spawn = fakePs([
    [1, 0, "/sbin/launchd"],
    [71348, 1, CRASHPAD],
    [71350, 1, CRASHPAD],
  ]);
  assert.deepEqual(runningClientProcesses("codex", { ...posix, spawn }), []);
  assert.match(clientRestartNotice("codex", { ...posix, spawn }), /Codex is not running/);
});

test("a running app is still named when its crash reporters sit beside it", () => {
  const notice = clientRestartNotice("codex", {
    ...posix,
    spawn: fakePs([
      [71348, 1, CRASHPAD],
      [71350, 1, CRASHPAD],
      [4242, 1, "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"],
      [4243, 4242, "/Applications/ChatGPT.app/Contents/Frameworks/ChatGPT Helper (Renderer).app/Contents/MacOS/ChatGPT Helper (Renderer) --type=renderer"],
    ]),
  });
  assert.match(notice, /running right now \(PID 4242 and 1 other process\)/);
});

test("helpers that outlived their app are not a running client", () => {
  const found = runningClientProcesses("codex", {
    ...posix,
    spawn: fakePs([
      [4243, 1, "/Applications/ChatGPT.app/Contents/Frameworks/ChatGPT Helper (GPU).app/Contents/MacOS/ChatGPT Helper (GPU) --type=gpu-process"],
      [4244, 1, "/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helpers/chrome_crashpad_handler"],
    ]),
  });
  assert.deepEqual(found, []);
});

test("Windows crash reporters are ignored the same way", () => {
  const win = { platform: "win32" };
  const orphans = fakePs([
    [5100, 4, '"C:\\Users\\x\\AppData\\Local\\Programs\\cursor\\Cursor.exe" --type=crashpad-handler --user-data-dir=C:\\x'],
    [5101, 4, '"C:\\Users\\x\\AppData\\Local\\Programs\\cursor\\resources\\crashpad_handler.exe" --database=C:\\x'],
  ]);
  assert.deepEqual(runningClientProcesses("cursor", { ...win, spawn: orphans }), []);
  const running = fakePs([
    [5100, 4, '"C:\\Users\\x\\AppData\\Local\\Programs\\cursor\\Cursor.exe" --type=crashpad-handler --user-data-dir=C:\\x'],
    [5200, 4, '"C:\\Users\\x\\AppData\\Local\\Programs\\cursor\\Cursor.exe"'],
  ]);
  assert.match(
    clientRestartNotice("cursor", { ...win, spawn: running }),
    /^Cursor is running right now \(PID 5200\)/,
  );
});
