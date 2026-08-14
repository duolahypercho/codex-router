import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  commandOnPath,
  escapeWindowsShellArgument,
  isWindowsBatchShim,
  needsDoubleEscape,
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
  assert.ok(line.includes("list^ the^ files"), line);
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

// Everything above asserts the shape of a command line without running it, and
// that is precisely how a wrong second layer of `^` escaping reached CI: the
// rendered string looked plausible and Windows answered "The syntax of the
// command is incorrect". These run a real shim and read back what the child
// actually received, which is the only assertion that can settle the question.
const windowsOnly = { skip: process.platform !== "win32" ? "Windows only" : false };

const TRICKY_ARGUMENTS = [
  "debug",
  "list the files, then say how many",
  'model_reasoning_effort="high"',
  "C:\\Program Files (x86)\\thing",
  "a&b",
  "100%",
  "caret^value",
];

// Deliberately awkward, and all of it legal on Windows: the runner's own temp
// path has no spaces, so nothing here would otherwise exercise the escaping
// that a real "C:\\Program Files (x86)" install depends on.
const AWKWARD_DIRECTORY = "shim dir (x86) & co";

function shimDirectory() {
  const directory = path.join(
    mkdtempSync(path.join(os.tmpdir(), "codex-router-shim-")),
    AWKWARD_DIRECTORY,
  );
  mkdirSync(directory, { recursive: true });
  return directory;
}

function argumentDumper(directory) {
  const dumper = path.join(directory, "dump-argv.mjs");
  writeFileSync(dumper, "console.log(JSON.stringify(process.argv.slice(2)));\n");
  return dumper;
}

function runThroughShim(shimPath) {
  const target = spawnableCommand(shimPath, TRICKY_ARGUMENTS);
  const result = spawnSync(target.command, target.args, {
    ...target.options,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout.trim().split(/\r?\n/).pop());
}

test("a plain batch shim receives every argument intact", windowsOnly, () => {
  const directory = shimDirectory();
  try {
    const dumper = argumentDumper(directory);
    const shim = path.join(directory, "probe.cmd");
    writeFileSync(shim, `@echo off\r\nnode "${dumper}" %*\r\n`);
    assert.deepEqual(runThroughShim(shim), TRICKY_ARGUMENTS);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an npm global shim receives every argument intact", windowsOnly, () => {
  // The shape npm actually writes into %APPDATA%\npm for a global install --
  // the case this router hits most, and the one that decides whether the
  // double-escape branch applies here. It does not: this template reaches the
  // program without re-entering cmd.exe.
  const directory = shimDirectory();
  try {
    const dumper = argumentDumper(directory);
    const shim = path.join(directory, "probe.cmd");
    writeFileSync(
      shim,
      [
        "@ECHO off",
        "GOTO start",
        ":find_dp0",
        "SET dp0=%~dp0",
        "EXIT /b",
        ":start",
        "SETLOCAL",
        "CALL :find_dp0",
        'IF EXIST "%dp0%\\node.exe" (',
        '  SET "_prog=%dp0%\\node.exe"',
        ") ELSE (",
        '  SET "_prog=node"',
        "  SET PATHEXT=%PATHEXT:;.JS;=;%",
        ")",
        `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "${dumper}" %*`,
        "",
      ].join("\r\n"),
    );
    assert.deepEqual(runThroughShim(shim), TRICKY_ARGUMENTS);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a path no file name could hold is refused rather than escaped", () => {
  assert.throws(
    () => spawnableCommand('C:\\npm\\co"dex.cmd', ["login"], "win32"),
    /Refusing to run a Windows path/,
  );
  assert.throws(
    () => spawnableCommand("C:\\npm\\codex\r\nshutdown.exe.cmd", [], "win32"),
    /Refusing to run a Windows path/,
  );
  // A path that never reaches a shell needs no such guard: without cmd.exe in
  // the middle there is no command line for a stray character to break out of.
  assert.doesNotThrow(() =>
    spawnableCommand('C:\\npm\\co"dex.exe', ["login"], "win32"),
  );
  // Characters that are legal in a Windows path stay escaped, not rejected.
  assert.ok(spawnableCommand("C:\\Program Files (x86)\\a&b\\codex.cmd", [], "win32").args[3]);
});

test("only an npm cmd-shim under node_modules/.bin takes the second escape layer", () => {
  assert.equal(needsDoubleEscape("C:\\p\\node_modules\\.bin\\codex.cmd"), true);
  assert.equal(needsDoubleEscape("C:\\p\\node_modules\\.bin\\codex.CMD"), true);
  assert.equal(needsDoubleEscape("C:\\Users\\ann\\AppData\\Roaming\\npm\\codex.cmd"), false);
  assert.equal(needsDoubleEscape("C:\\tools\\codex.cmd"), false);
});

test("an ordinary token is passed through bare, so a shim's %1 still matches", () => {
  // Windows CI caught this: quoting every argument turned `debug` into
  // `"debug"`, and a batch shim comparing %1 textually stopped matching. A
  // real program never notices -- argv parsing strips the quotes -- but shims
  // that read their own arguments do.
  const line = spawnableCommand("C:\\npm\\codex.cmd", ["debug", "models"], "win32").args[3];
  assert.ok(line.endsWith('codex.cmd debug models"'), line);

  for (const bare of ["--version", "login", "app-server", "gpt-5.6-sol", "@xai-official/grok"]) {
    assert.equal(escapeWindowsShellArgument(bare), bare);
  }
  for (const quoted of ["a b", 'say "hi"', "a&b", "100%", "a^b", "a(b)", "a,b", ""]) {
    assert.notEqual(escapeWindowsShellArgument(quoted), quoted);
  }
});
