import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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

function scratch(prefix) {
  return mkdtempSync(path.join(realpathSync(os.tmpdir()), prefix));
}

// Lifting the shipped function out of bin/install and running it, rather than
// asserting on its text, is the same technique installer-scripts.test.mjs uses
// for the dirty-checkout refusal: the test exercises the code that ships.
function packagedRefusalFunction() {
  const source = readFileSync(path.join(root, "bin", "install"), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf("packaged_dependency_refusal() {");
  assert.notEqual(start, -1, "bin/install must define packaged_dependency_refusal");
  const end = source.indexOf("\n}\n", start);
  assert.notEqual(end, -1, "packaged_dependency_refusal must be a complete function");
  return source.slice(start, end + 3);
}

function runRefusal(packageManager, label) {
  return spawnSync("sh", ["-s"], {
    input: `${packagedRefusalFunction()}\nCODEX_ROUTER_PACKAGE_MANAGER=${packageManager}\npackaged_dependency_refusal ${label}\n`,
    encoding: "utf8",
  });
}

test("bin/install is valid POSIX shell", () => {
  const result = spawnSync("sh", ["-n", path.join(root, "bin", "install")], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("a Homebrew install is told to use brew reinstall", () => {
  // The alternative is npm or uv failing on EACCES inside the keg, which names
  // a path the user cannot write and no command that would fix it.
  const result = runRefusal("homebrew", "LiteLLM");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /brew reinstall codex-router/);
  assert.match(result.stderr, /LiteLLM/);
  assert.equal(result.stdout, "", "the refusal belongs on stderr");
});

test("an unrecognized package manager still gets an actionable refusal", () => {
  // The env var is deliberately not an enum -- a future scoop or apt package
  // sets its own name -- so the fallback has to say something useful.
  const result = runRefusal("scoop", "Node");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Reinstall the codex-router package/);
  assert.match(result.stderr, /scoop/);
});

test("both dependency steps are behind the packaging guard", () => {
  // One guarded branch and one unguarded is the failure this asserts against:
  // the unguarded half still writes into a directory the package manager owns,
  // and only on the machines where that step is the one that runs.
  const source = readFileSync(path.join(root, "bin", "install"), "utf8");
  const guards = source
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .filter((line) => line.includes("packaged_dependency_refusal"));
  // One definition plus one call per dependency tree.
  assert.equal(guards.length, 3, `expected 3 references, found ${guards.length}`);
});

// A fake application root is enough to observe which arguments doctor hands the
// installer: SOURCE_ROOT is an env override, while doctor's own imports resolve
// from its real location, so the stub below is the only bin/install it can find.
function fakeSourceRoot() {
  const dir = scratch("codex-router-packaged-doctor-");
  const fake = path.join(dir, "libexec");
  mkdirSync(path.join(fake, "bin"), { recursive: true });
  for (const entry of ["config", "skills", "package.json", "requirements", "node_modules", "src"]) {
    const target = path.join(root, entry);
    if (existsSync(target)) symlinkSync(target, path.join(fake, entry));
  }
  // A packaged repair may regenerate configuration and services only when the
  // package-owned dependency tree is healthy. Keep this fixture on that path;
  // dependency-repair.test.mjs separately covers refusal for a damaged venv.
  const venvBin = path.join(fake, ".venv", process.platform === "win32" ? "Scripts" : "bin");
  mkdirSync(venvBin, { recursive: true });
  const venvPython = path.join(venvBin, "python");
  const liteLlm = path.join(venvBin, "litellm");
  if (process.platform === "win32") {
    // The health probe intentionally initializes Python's stdlib, so a copied
    // Node executable is no longer a truthful fixture. Windows CI images ship
    // Python; link the first launcher that passes the exact production probe.
    const python = ["python.exe", "py.exe"]
      .flatMap((command) => {
        const found = spawnSync("where.exe", [command], { encoding: "utf8" });
        return found.status === 0 ? found.stdout.split(/\r?\n/).filter(Boolean) : [];
      })
      .find((candidate) =>
        spawnSync(
          candidate,
          ["-I", "-c", "import encodings, sys; print(sys.prefix)"],
          { encoding: "utf8" },
        ).status === 0
      );
    assert.ok(python, "Windows test host needs a runnable Python launcher");
    symlinkSync(python, `${venvPython}.exe`, "file");
    copyFileSync(process.execPath, `${liteLlm}.exe`);
  } else {
    writeFileSync(venvPython, "#!/bin/sh\nexit 0\n");
    writeFileSync(liteLlm, "#!/bin/sh\nexit 0\n");
    chmodSync(venvPython, 0o755);
    chmodSync(liteLlm, 0o755);
  }
  const marker = path.join(dir, "installer-argv");
  const stub = path.join(fake, "bin", "install");
  writeFileSync(
    stub,
    `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(marker)}\nexit 0\n`,
  );
  chmodSync(stub, 0o755);
  if (process.platform === "win32") {
    const markerPath = marker.replaceAll("'", "''");
    writeFileSync(
      path.join(fake, "install.ps1"),
      `$ErrorActionPreference = "Stop"\n$args | Set-Content -LiteralPath '${markerPath}'\nexit 0\n`,
    );
  }
  return { dir, fake, marker };
}

function runFix(env) {
  const { dir, fake, marker } = fakeSourceRoot();
  try {
    const result = spawnSync(process.execPath, [path.join(root, "src", "doctor.mjs"), "--fix"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_ROUTER_SOURCE_ROOT: fake,
        CODEX_HOME: path.join(dir, "codex home"),
        MODEL_ROUTER_STATE_DIR: path.join(dir, "state"),
        ...env,
      },
    });
    return {
      result,
      argv: existsSync(marker)
        ? readFileSync(marker, "utf8").split(/\r?\n/).filter(Boolean)
        : undefined,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("doctor --fix rebuilds dependencies in a checkout", () => {
  // The baseline the packaged case departs from: --force-deps is what makes
  // repair able to fix a corrupted node_modules, and it must not be lost for
  // everyone in the course of exempting packaged installs.
  const { result, argv } = runFix({ CODEX_ROUTER_PACKAGE_MANAGER: "" });
  assert.notEqual(argv, undefined, `installer was never invoked: ${result.stderr}`);
  assert.deepEqual(
    argv,
    process.platform === "win32"
      ? ["-CheckoutInstall", "-Target", "codex", "-ForceDeps"]
      : ["--force-deps"],
  );
});

test("doctor --fix repairs a packaged install without rebuilding dependencies", () => {
  // Everything else repair does -- generated catalogs, the Codex config block,
  // the service -- lives outside the keg and is still worth doing, so the flag
  // is dropped rather than the whole repair being refused.
  const { result, argv } = runFix({ CODEX_ROUTER_PACKAGE_MANAGER: "homebrew" });
  assert.notEqual(argv, undefined, `installer was never invoked: ${result.stderr}`);
  assert.deepEqual(
    argv,
    process.platform === "win32" ? ["-CheckoutInstall", "-Target", "codex"] : [],
  );
  assert.match(result.stdout, /brew reinstall codex-router/);
});

test("the packaged repair note stays out of --json output", () => {
  // doctor --json is parsed by the tray; a prose line on stdout breaks it.
  const { dir, fake } = fakeSourceRoot();
  try {
    const result = spawnSync(
      process.execPath,
      [path.join(root, "src", "doctor.mjs"), "--fix", "--json"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_ROUTER_SOURCE_ROOT: fake,
          CODEX_ROUTER_PACKAGE_MANAGER: "homebrew",
          CODEX_HOME: path.join(dir, "codex home"),
          MODEL_ROUTER_STATE_DIR: path.join(dir, "state"),
        },
      },
    );
    assert.doesNotMatch(result.stdout, /brew reinstall/);
    assert.doesNotThrow(
      () => JSON.parse(result.stdout),
      `doctor --fix --json did not emit JSON: ${result.stdout.slice(0, 400)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
