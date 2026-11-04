import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { spawnableCommand } from "../src/spawnable-command.mjs";

// Importing setup starts its interactive flow. Execute its actual command
// runner with an intercepted spawn instead of logging in or installing a CLI.
const source = readFileSync(new URL("../src/setup.mjs", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const start = source.indexOf("function run(command,");
assert.notEqual(start, -1);
const end = source.indexOf("\n}\n", start);
assert.ok(end > start);
const runner = source.slice(start, end + 2);
function fixture(platform, result) {
  const calls = [];
  const run = vm.runInNewContext(`(${runner})`, {
    SOURCE_ROOT: "/synthetic/source",
    process: { env: { SYNTHETIC: "1" } },
    path,
    spawnableCommand: (command, args) => spawnableCommand(command, args, platform),
    spawnSync: (...args) => { calls.push(args); return result; },
  });
  return { run, calls };
}

test("guided setup launches Windows batch OAuth commands through the shared adapter", () => {
  const { run, calls } = fixture("win32", { status: 0 });
  assert.equal(run("C:\\npm\\grok.cmd", ["login", "account with spaces"]), 0);
  assert.match(calls[0][0], /cmd\.exe$/i);
  assert.equal(calls[0][2].windowsVerbatimArguments, true);
  assert.equal(calls[0][2].stdio, "inherit");
  assert.equal(calls[0][2].cwd, "/synthetic/source");
  assert.ok(calls[0][1][3].includes("account^ with^ spaces"));
});

test("native setup commands preserve argv and nonzero/cancelled status handling", () => {
  const { run, calls } = fixture("linux", { status: 2 });
  assert.equal(run("/synthetic/kimi", ["login", "a b"], { allowFailure: true }), 2);
  assert.deepEqual([...calls[0][1]], ["login", "a b"]);
  assert.throws(() => run("/synthetic/kimi", ["login"]), /exited with status 2/);
  const error = new Error("synthetic spawn failure");
  assert.throws(() => fixture("linux", { error }).run("/synthetic/kimi", []), (actual) => actual === error);
});
