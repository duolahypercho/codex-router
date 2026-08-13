import assert from "node:assert/strict";
import test from "node:test";

import {
  commandOnPath,
  escapeWindowsShellArgument,
  isWindowsBatchShim,
  preferSpawnablePath,
  spawnableCommand,
} from "../src/spawnable-command.mjs";

// `where.exe <name>` on an npm global install lists the extensionless POSIX
// shim first. Node cannot spawn it, and every caller that took the first line
// then blamed the resulting spawn error on something else entirely.
const NPM_WHERE_OUTPUT = [
  "C:\\Users\\ann\\AppData\\Roaming\\npm\\grok",
  "C:\\Users\\ann\\AppData\\Roaming\\npm\\grok.cmd",
  "",
];

function fakeFinder(lines) {
  return (command, args) => {
    assert.deepEqual(args.length, 1);
    return `${lines.join("\r\n")}\r\n`;
  };
}

test("a PATH lookup skips the shim Windows cannot spawn", () => {
  assert.equal(
    commandOnPath("grok", { platform: "win32", exec: fakeFinder(NPM_WHERE_OUTPUT) }),
    "C:\\Users\\ann\\AppData\\Roaming\\npm\\grok.cmd",
  );
});

test("a PATH lookup keeps the first hit on POSIX", () => {
  assert.equal(
    commandOnPath("grok", {
      platform: "darwin",
      exec: fakeFinder(["/opt/homebrew/bin/grok", "/usr/local/bin/grok"]),
    }),
    "/opt/homebrew/bin/grok",
  );
});

test("a PATH lookup reports nothing when the finder fails", () => {
  assert.equal(
    commandOnPath("grok", {
      platform: "win32",
      exec: () => {
        throw Object.assign(new Error("not found"), { status: 1 });
      },
    }),
    undefined,
  );
  assert.equal(
    commandOnPath("grok", { platform: "win32", exec: fakeFinder(["", "   "]) }),
    undefined,
  );
});

test("only a Windows batch shim is treated as one", () => {
  assert.equal(isWindowsBatchShim("C:\\npm\\grok.cmd", "win32"), true);
  assert.equal(isWindowsBatchShim("C:\\npm\\grok.BAT", "win32"), true);
  assert.equal(isWindowsBatchShim("C:\\npm\\grok.exe", "win32"), false);
  assert.equal(isWindowsBatchShim("/usr/bin/grok.cmd", "darwin"), false);
  assert.equal(isWindowsBatchShim(undefined, "win32"), false);
});

test("preferSpawnablePath ranks a real executable above a batch shim", () => {
  assert.equal(
    preferSpawnablePath(["C:\\shim\\codex.cmd", "C:\\real\\codex.exe"], "win32"),
    "C:\\real\\codex.exe",
  );
  assert.equal(preferSpawnablePath(["C:\\odd\\codex"], "win32"), "C:\\odd\\codex");
  assert.equal(preferSpawnablePath([], "win32"), undefined);
});

// Node's own `shell: true` joins the argument list on spaces, so a single
// argument containing one arrives at the child as several. Every prompt this
// router hands Codex is a whole sentence, so that split is not theoretical.
test("an argument containing spaces survives as one argument", () => {
  const target = spawnableCommand(
    "C:\\npm\\codex.cmd",
    ["exec", "list the files, then say how many"],
    "win32",
  );
  const line = target.args[3];
  assert.equal(target.options.windowsVerbatimArguments, true);
  // Each argument is quoted as a unit, and the spaces inside it are escaped
  // rather than left as separators.
  assert.ok(line.includes("list^^^ the^^^ files"), line);
  assert.equal(line.split(" ").length > 1, true);
});

test("a quoted argument value keeps its quotes as data", () => {
  const escaped = escapeWindowsShellArgument('model_reasoning_effort="high"', true);
  // The inner quotes are backslash-escaped so the child's parser sees them,
  // and every cmd.exe metacharacter is neutralized twice for a batch file.
  assert.ok(escaped.includes('\\^^^"high'), escaped);
});

test("a command path containing spaces is escaped, not split", () => {
  const target = spawnableCommand("C:\\Program Files\\npm\\codex.cmd", [], "win32");
  assert.match(target.command, /cmd\.exe$/i);
  assert.deepEqual(target.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.ok(target.args[3].startsWith('"C:\\Program^ Files\\npm\\codex.cmd'), target.args[3]);
});

test("everything that is not a Windows batch shim is spawned untouched", () => {
  assert.deepEqual(spawnableCommand("/usr/bin/codex", ["a b"], "linux"), {
    command: "/usr/bin/codex",
    args: ["a b"],
    options: {},
  });
  assert.deepEqual(spawnableCommand("C:\\Programs\\codex.exe", ["a b"], "win32"), {
    command: "C:\\Programs\\codex.exe",
    args: ["a b"],
    options: {},
  });
});

test("the caller's argument array is never mutated", () => {
  const args = ["login", "status"];
  spawnableCommand("C:\\npm\\codex.cmd", args, "win32");
  assert.deepEqual(args, ["login", "status"]);
});
