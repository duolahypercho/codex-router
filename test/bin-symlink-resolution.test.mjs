import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binDir = path.join(root, "bin");
const posixOnly = process.platform === "win32" ? "the bin/ commands are not the Windows entry points" : false;

// Every command in bin/ locates the checkout from its own path, and two things
// can go wrong with that. A checkout user puts a command on PATH by hand --
// `ln -s .../bin/doctor ~/.local/bin/doctor`, or a link to that link -- and
// `dirname $0` alone resolves beside the link, so the command fails on a missing
// src/ before it can say anything useful. Separately, most modules in src/ only
// run as a command when `path.resolve(process.argv[1])` equals their own path,
// and node realpaths a main module while leaving argv[1] as written, so a root
// that still contains a linked directory makes those commands exit 0 having done
// nothing. The second shape is what a packaged install has: the Homebrew wrapper
// execs the dispatcher at `<prefix>/opt/<formula>/libexec/bin/codex-router`,
// where the file is not a link but `opt/<formula>` is one into the versioned keg.
const rootLocators = readdirSync(binDir).filter((entry) => {
  const source = readFileSync(path.join(binDir, entry), "utf8");
  return source.startsWith("#!/bin/sh\n") && /^repo_dir=/m.test(source);
});

function tempDir(prefix) {
  return mkdtempSync(path.join(realpathSync(os.tmpdir()), prefix));
}

test("bin/ has shell commands that locate the repository root", () => {
  assert.ok(rootLocators.length >= 30, `only ${rootLocators.length} bin/ commands compute repo_dir`);
});

test("every bin/ command walks the symlink chain and resolves its root physically", () => {
  for (const entry of rootLocators) {
    const source = readFileSync(path.join(binDir, entry), "utf8");
    const where = `bin/${entry}`;
    assert.match(source, /^self=\$0$/m, `${where} does not start from $0`);
    assert.match(source, /^while \[ -L "\$self" \]; do$/m, `${where} does not walk the symlink chain`);
    assert.match(source, /^    \/\*\) self=\$link ;;$/m, `${where} does not take an absolute link target as is`);
    assert.match(
      source,
      /^    \*\) self=\$\(dirname -- "\$self"\)\/\$link ;;$/m,
      `${where} does not rebase a relative link target on the link's directory`,
    );
    assert.match(
      source,
      /^repo_dir=\$\(CDPATH=(''|) cd -P -- "(\$\(dirname -- "\$self"\)|\$bin_dir)\/\.\." && pwd -P\)$/m,
      `${where} does not derive a physical repo_dir from the resolved path`,
    );
    assert.doesNotMatch(source, /dirname -- "\$0"/, `${where} still derives a path from the unresolved $0`);
  }
});

function isolatedEnv(dir) {
  return {
    ...process.env,
    HOME: dir,
    CODEX_HOME: path.join(dir, ".codex"),
    MODEL_ROUTER_STATE_DIR: path.join(dir, "state"),
    MODEL_ROUTER_TARGET: "codex",
  };
}

// Commands whose usage comes from the module the shell script execs, so a root
// resolved beside the link surfaces as node failing to find that module. skills
// and agents reach modules that guard main on argv[1], so they also surface a
// root that merely keeps a linked directory, which is a silent exit 0; doctor
// prints its usage unguarded and covers only the missing-module shape. Each
// prints usage without reading or writing configuration.
const probes = [
  { command: "skills", args: [], status: 2, usage: /Usage: skills-install/ },
  { command: "agents", args: ["--help"], status: 2, usage: /Usage: agent-bridges/ },
  { command: "doctor", args: ["--help"], status: 0, usage: /Usage: doctor/ },
];

function assertBehavesLikeDirect(probe, entry, env) {
  const direct = spawnSync(path.join(binDir, probe.command), probe.args, { encoding: "utf8", env });
  const result = spawnSync(entry, probe.args, { encoding: "utf8", env });
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, probe.status, `${entry}: ${output}`);
  assert.match(output, probe.usage, entry);
  assert.doesNotMatch(output, /Cannot find module/, entry);
  // Through the link the command behaves exactly as it does at its real path.
  assert.equal(result.status, direct.status, entry);
  assert.equal(output, `${direct.stdout}${direct.stderr}`, entry);
}

for (const probe of probes) {
  test(`bin/${probe.command} resolves its root through a symlink`, { skip: posixOnly }, () => {
    const dir = tempDir("codex-router-bin-");
    try {
      const target = path.join(binDir, probe.command);
      const absolute = path.join(dir, probe.command);
      symlinkSync(target, absolute);
      // A relative target takes the branch that rebases it on the link's own
      // directory, which is how package managers and dotfile tools write links.
      const relative = path.join(dir, `${probe.command}-relative`);
      symlinkSync(path.relative(dir, target), relative);
      // A link to a link: `ln -s ~/.local/bin/x ~/bin/x` on top of the first one.
      const chained = path.join(dir, `${probe.command}-chained`);
      symlinkSync(absolute, chained);
      for (const entry of [absolute, relative, chained]) {
        assertBehavesLikeDirect(probe, entry, isolatedEnv(dir));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`bin/${probe.command} resolves its root through a linked directory`, { skip: posixOnly }, () => {
    // Here $0 is not itself a link, so only the physical resolution of the root
    // stands between the command and a silent no-op.
    const dir = tempDir("codex-router-dir-");
    try {
      // The whole bin/ directory linked onto PATH: `ln -s <checkout>/bin ~/cr-bin`.
      const linkedBin = path.join(dir, "cr-bin");
      symlinkSync(binDir, linkedBin);
      assertBehavesLikeDirect(probe, path.join(linkedBin, probe.command), isolatedEnv(dir));
      // The checkout itself reached through a link, as under macOS /tmp or a
      // linked ~/code, with the command linked from inside that view of it.
      const aliased = path.join(dir, "aliased");
      symlinkSync(root, aliased);
      mkdirSync(path.join(dir, "bin"));
      const viaAlias = path.join(dir, "bin", probe.command);
      symlinkSync(path.join(aliased, "bin", probe.command), viaAlias);
      assertBehavesLikeDirect(probe, viaAlias, isolatedEnv(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("a packaged keg layout reaches its commands through the dispatcher", { skip: posixOnly }, () => {
  // The shape packaging/homebrew/codex-router.rb produces: a generated wrapper in
  // the formula's bin/ exports CODEX_ROUTER_SOURCE_ROOT and execs the dispatcher
  // under `opt/<formula>`, a symlink to the versioned keg. Nothing on that path is
  // a link the walk can see, so the physical root is the whole of what makes the
  // commands behind it run. rmSync unlinks a directory symlink rather than
  // descending through it, so the checkout the keg points at is not touched.
  const dir = tempDir("codex-router-keg-");
  try {
    const keg = path.join(dir, "Cellar", "codex-router", "1.0.0");
    mkdirSync(keg, { recursive: true });
    symlinkSync(root, path.join(keg, "libexec"));
    mkdirSync(path.join(dir, "opt"));
    symlinkSync(path.join("..", "Cellar", "codex-router", "1.0.0"), path.join(dir, "opt", "codex-router"));
    const optLibexec = path.join(dir, "opt", "codex-router", "libexec");
    const wrapper = path.join(dir, "bin", "codex-router");
    mkdirSync(path.join(dir, "bin"));
    writeFileSync(
      wrapper,
      `#!/bin/sh\nCODEX_ROUTER_PACKAGE_MANAGER=homebrew\nCODEX_ROUTER_SOURCE_ROOT="${optLibexec}"\n` +
        `export CODEX_ROUTER_PACKAGE_MANAGER CODEX_ROUTER_SOURCE_ROOT\nexec "${optLibexec}/bin/codex-router" "$@"\n`,
    );
    chmodSync(wrapper, 0o755);
    for (const probe of probes) {
      const env = isolatedEnv(dir);
      const result = spawnSync(wrapper, [probe.command, ...probe.args], { encoding: "utf8", env });
      const output = `${result.stdout}${result.stderr}`;
      assert.equal(result.status, probe.status, `${probe.command} through the keg: ${output}`);
      assert.match(output, probe.usage, `${probe.command} through the keg`);
      assert.doesNotMatch(output, /Cannot find module/, probe.command);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the walk and the physical cd are what make a linked command find its root", { skip: posixOnly }, () => {
  // The same script minus the walk reports the link's grandparent, which is the
  // failure every command had. The resolver is taken verbatim from a shipped
  // command so this control keeps tracking what actually ships.
  const dir = tempDir("codex-router-walk-");
  try {
    const home = path.join(dir, "home");
    const fakeRoot = path.join(home, "src", "root");
    mkdirSync(path.join(fakeRoot, "bin"), { recursive: true });
    const resolver = readFileSync(path.join(binDir, "skills"), "utf8").match(/^self=\$0\n[\s\S]*?^repo_dir=.*$/m);
    assert.ok(resolver, "bin/skills carries the resolver");
    const walked = path.join(fakeRoot, "bin", "walked");
    const bare = path.join(fakeRoot, "bin", "bare");
    writeFileSync(walked, `#!/bin/sh\nset -eu\n${resolver[0]}\nprintf '%s' "$repo_dir"\n`);
    writeFileSync(
      bare,
      '#!/bin/sh\nset -eu\nrepo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nprintf \'%s\' "$repo_dir"\n',
    );
    chmodSync(walked, 0o755);
    chmodSync(bare, 0o755);
    const links = path.join(home, "links", "bin");
    mkdirSync(links, { recursive: true });
    symlinkSync(walked, path.join(links, "walked"));
    symlinkSync(path.relative(links, walked), path.join(links, "walked-relative"));
    symlinkSync(bare, path.join(links, "bare"));
    // A dotfiles layout: ~/bin is itself a link, and the command inside it is a
    // relative link that climbs out with `..`. The kernel follows ~/bin to its
    // target before applying `..`; a logical cd strips `..` textually instead and
    // lands one level up, where nothing exists, so the command aborts.
    mkdirSync(path.join(home, "dotfiles", "bin"), { recursive: true });
    symlinkSync(path.join("dotfiles", "bin"), path.join(home, "bin"));
    symlinkSync(path.join("..", "..", "src", "root", "bin", "walked"), path.join(home, "dotfiles", "bin", "walked"));
    const run = (entry) => spawnSync(entry, [], { encoding: "utf8" });
    assert.equal(run(path.join(links, "walked")).stdout, fakeRoot);
    assert.equal(run(path.join(links, "walked-relative")).stdout, fakeRoot);
    assert.equal(run(path.join(links, "bare")).stdout, path.join(home, "links"));
    const stowed = run(path.join(home, "bin", "walked"));
    assert.equal(stowed.status, 0, stowed.stderr);
    assert.equal(stowed.stdout, fakeRoot);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
