import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dispatcher = path.join(root, "bin", "codex-router");
const posixOnly = process.platform === "win32" ? "the POSIX dispatcher is not the Windows entry point" : false;

function run(args, options = {}) {
  return spawnSync(dispatcher, args, { encoding: "utf8", ...options });
}

// The dispatcher exists so a packaged install can expose one name on PATH. A
// checkout user links it onto PATH by hand, and a dispatcher that does not walk
// that symlink chain looks for its siblings beside the link and reports every
// command as unknown. test/bin-symlink-resolution.test.mjs covers the siblings,
// and the linked-directory case the Homebrew layout actually produces.
function linkedCopy(target) {
  const dir = mkdtempSync(path.join(realpathSync(os.tmpdir()), "codex-router-cli-"));
  const link = path.join(dir, target);
  symlinkSync(dispatcher, link);
  return { dir, link };
}

test("bin/codex-router is valid POSIX shell", () => {
  const result = spawnSync("sh", ["-n", dispatcher], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("bin/codex-router is executable", { skip: posixOnly }, () => {
  assert.ok(statSync(dispatcher).mode & 0o111, "bin/codex-router must be executable");
});

test("the dispatcher resolves its root through a symlink", { skip: posixOnly }, () => {
  const { dir, link } = linkedCopy("codex-router");
  try {
    const result = spawnSync(link, ["--version"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the dispatcher resolves a chain of symlinks", { skip: posixOnly }, () => {
  // A user stacks two by hand: `~/bin/x -> ~/.local/bin/x -> checkout/bin/...`.
  // Homebrew itself ships a wrapper script here, not a link; its only link is the
  // `opt/<formula>` directory, which `[ -L ]` on the file never sees.
  const { dir, link } = linkedCopy("codex-router");
  try {
    const chained = path.join(dir, "chained");
    symlinkSync(link, chained);
    const result = spawnSync(chained, ["--version"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a bare invocation and --help print the usage", { skip: posixOnly }, () => {
  for (const args of [[], ["help"], ["--help"], ["-h"]]) {
    const result = run(args);
    assert.equal(result.status, 0, `codex-router ${args.join(" ")}: ${result.stderr}`);
    assert.match(result.stdout, /^Usage: codex-router <command>/);
  }
});

test("a command name may not reach outside bin/", { skip: posixOnly }, () => {
  // Without this the dispatcher is an arbitrary-execution primitive: the command
  // is interpolated straight into the path it runs.
  for (const argument of ["../install.sh", "..", "./setup", "a/b", ".hidden", "..\\install.ps1"]) {
    const result = run([argument]);
    assert.equal(result.status, 2, `${argument} was not rejected`);
    assert.match(result.stderr, /unknown command/);
  }
});

test("an unknown command names the way to the list", { skip: posixOnly }, () => {
  const result = run(["definitely-not-a-command"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /codex-router help/);
});

test("the dispatcher refuses install", { skip: posixOnly }, () => {
  // `bin/install` rewrites the directory it lives in. A packaged install has no
  // writable one, and offering the command through the packaged entry point is
  // how someone would find that out the hard way.
  const result = run(["install"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown command/);
});

test("the dispatcher forwards arguments verbatim", { skip: posixOnly }, () => {
  // A wrapper that drops flags still runs the command, just not the one the
  // caller asked for -- the defect `rollback --force` hit on Windows.
  const dir = mkdtempSync(path.join(realpathSync(os.tmpdir()), "codex-router-args-"));
  try {
    const fakeRoot = path.join(dir, "root");
    const fakeBin = path.join(fakeRoot, "bin");
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(path.join(fakeBin, "codex-router"), readFileSync(dispatcher, "utf8"));
    chmodSync(path.join(fakeBin, "codex-router"), 0o755);
    const probe = path.join(fakeBin, "probe");
    writeFileSync(probe, '#!/bin/sh\nfor a in "$@"; do printf "[%s]" "$a"; done\n');
    chmodSync(probe, 0o755);
    const result = spawnSync(path.join(fakeBin, "codex-router"), ["probe", "--force", "a b", "--", "-x"], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "[--force][a b][--][-x]");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every command the usage advertises exists in bin/", { skip: posixOnly }, () => {
  // Usage text is the only place a user learns the command set, so it drifting
  // from bin/ is indistinguishable from the command being broken.
  const usage = run(["help"]).stdout;
  const advertised = usage
    .split("\n")
    .map((line) => line.match(/^ {2}([a-z][a-z-]*) {2,}\S/))
    .filter(Boolean)
    .map((match) => match[1]);
  assert.ok(advertised.length >= 15, `usage advertises only ${advertised.length} commands`);
  for (const command of advertised) {
    const target = path.join(root, "bin", command);
    assert.ok(statSync(target).mode & 0o111, `bin/${command} is advertised but not executable`);
  }
});

test("the POSIX dispatcher covers the Windows command set", () => {
  // codex-router.ps1 is the same entry point for Windows. A command reachable on
  // one platform and not the other is a documentation trap: the README cannot
  // name it without qualifying which OS the reader is on. Some of the Windows
  // verbs are intentionally aliases for older POSIX entry points rather than
  // duplicate implementations (for example, `signed-routing` is a focused
  // spelling of `control signed-routing`, while the tray launcher owns the
  // companion build and supervision flow). Keep that mapping here so adding a
  // platform wrapper does not silently create two implementations to maintain.
  const windows = readFileSync(path.join(root, "codex-router.ps1"), "utf8");
  const declared = windows.match(/\$Commands = @\(([\s\S]*?)\)/);
  assert.ok(declared, "codex-router.ps1 must declare $Commands");
  const commands = [...declared[1].matchAll(/"([a-z-]+)"/g)].map((match) => match[1]);
  assert.ok(commands.length >= 16, `only found ${commands.length} Windows commands`);
  const posixAliases = {
    "signed-routing": "control",
    activity: "control",
    tray: "model-router-tray",
    companion: "model-router-tray",
  };
  // `activity` is a focused spelling of `control activity`; routed-worker
  // guidance names it on both platforms, so Windows must dispatch it there.
  assert.match(
    windows,
    /"activity"\s*\{\s*Invoke-RouterNode "src\\control\.mjs" \(@\("activity"\) \+ \$Arguments\)\s*\}/,
  );
  for (const command of commands) {
    // `install` is refused on both sides of the packaged boundary; the Windows
    // wrapper only still offers it because it is also the checkout installer.
    if (command === "install") continue;
    const target = path.join(root, "bin", posixAliases[command] ?? command);
    assert.ok(statSync(target), `codex-router.ps1 offers ${command} but its POSIX entry point is missing: ${target}`);
    if (!posixOnly) {
      assert.ok(
        statSync(target).mode & 0o111,
        `codex-router.ps1 offers ${command} but its POSIX entry point is not executable: ${target}`,
      );
    }
  }
});

test("the dispatcher is the only bin/ entry that is not a plain command", { skip: posixOnly }, () => {
  // Guards the `[ -x "$bin_dir/$command" ]` check: a non-executable helper in
  // bin/ is unreachable through the dispatcher, which is intended, but a new
  // *executable* helper becomes a command whether or not it was meant to be.
  const entries = readdirSync(path.join(root, "bin"))
    .filter((entry) => statSync(path.join(root, "bin", entry)).mode & 0o111)
    .filter((entry) => entry !== "codex-router");
  for (const entry of entries) {
    assert.doesNotMatch(entry, /\.(mjs|js)$/, `bin/${entry} is executable but is a module, not a command`);
  }
});
