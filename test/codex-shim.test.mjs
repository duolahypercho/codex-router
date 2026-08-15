import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SHIM_MARKER,
  chooseShimDirectory,
  installShim,
  isShimFile,
  renderShim,
  resolveRealCodex,
  shimStatus,
  uninstallShim,
} from "../src/codex-shim.mjs";

function scratch() {
  return mkdtempSync(path.join(os.tmpdir(), "codex-shim-"));
}

// A PATH layout that mirrors the one that motivated the ordering rule: the real
// Codex sits in the middle, with writable directories both ahead of and behind
// it. A shim written behind it would never run.
function layout(home, { realIn = "npm-global/bin", extras = ["bin", "early"] } = {}) {
  const dir = (relative) => {
    const full = path.join(home, relative);
    mkdirSync(full, { recursive: true });
    return full;
  };
  const early = dir(extras[1]);
  const mid = dir(extras[0]);
  const realDir = dir(realIn);
  const late = dir("late");
  const realCodex = path.join(realDir, "codex");
  writeFileSync(realCodex, "#!/bin/sh\necho real \"$@\"\n", { mode: 0o755 });
  chmodSync(realCodex, 0o755);
  return {
    early,
    mid,
    realDir,
    late,
    realCodex,
    env: { PATH: [early, mid, realDir, late].join(path.delimiter) },
  };
}

// The shim is a bash script the installer refuses to write on Windows, so the
// two tests that actually execute one are skipped there rather than asserting
// something the platform was never promised. Everything else -- PATH ordering,
// marker handling, the Windows refusal itself -- runs everywhere.
const execRequiresPosix = { skip: process.platform === "win32" ? "the shim is POSIX-only" : false };

test("the real codex is found by PATH order", () => {
  const home = scratch();
  try {
    const paths = layout(home);
    const real = resolveRealCodex(paths.env);
    assert.equal(real.file, paths.realCodex);
    assert.equal(real.index, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("no codex on PATH is reported rather than guessed at", () => {
  assert.equal(resolveRealCodex({ PATH: scratch() }), null);
});

test("the shim goes to the directory closest to the real codex, not the first one", () => {
  const home = scratch();
  try {
    const paths = layout(home);
    const real = resolveRealCodex(paths.env);
    const choice = chooseShimDirectory(real, paths.env, home);
    // `mid` precedes the real Codex and `early` precedes both. Shadowing from as
    // late as possible keeps the shim out of the way of everything in between.
    assert.equal(choice.directory, paths.mid);
    assert.equal(choice.onPath, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a shim behind the real codex is reported as installed but not effective", () => {
  const home = scratch();
  try {
    const paths = layout(home);
    // Write the shim into `late`, which PATH reaches only after the real Codex.
    // This is the failure the `effective` flag exists to name: the file is
    // present, looks installed, and can never run.
    const stranded = path.join(paths.late, "codex");
    writeFileSync(stranded, renderShim({ realCodex: paths.realCodex }), { mode: 0o755 });
    chmodSync(stranded, 0o755);

    const status = shimStatus(paths.env);
    assert.equal(status.installed, true);
    assert.equal(status.shim, stranded);
    assert.equal(status.effective, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("installing writes an executable shim that wraps the resolved codex", () => {
  const home = scratch();
  try {
    const paths = layout(home);
    const result = installShim({ environment: paths.env, platform: "darwin", home });

    assert.equal(result.installed_to, path.join(paths.mid, "codex"));
    // Recorded through realpath on purpose, so the shim keeps working when the
    // link npm put on PATH is rearranged underneath it.
    assert.equal(result.wraps, realpathSync(paths.realCodex));
    assert.equal(result.effective, true);
    assert.equal(result.needs_path_entry, null);
    assert.ok(isShimFile(result.installed_to));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a foreign file named codex is never overwritten", () => {
  const home = scratch();
  try {
    const paths = layout(home);
    // Someone else's wrapper, parked in the directory the shim would otherwise
    // claim. Replacing it silently is indistinguishable from breaking a setup
    // the user built on purpose.
    const foreign = path.join(paths.mid, "codex");
    writeFileSync(foreign, "#!/bin/sh\necho mine\n", { mode: 0o755 });
    chmodSync(foreign, 0o755);

    // With a foreign wrapper ahead of it, *that* is now what resolves as codex,
    // so installation relocates rather than clobbering. Either way the file
    // survives untouched.
    installShim({ environment: paths.env, platform: "darwin", home });
    assert.equal(readFileSync(foreign, "utf8"), "#!/bin/sh\necho mine\n");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("uninstall removes only files carrying the shim marker", () => {
  const home = scratch();
  try {
    const paths = layout(home);
    installShim({ environment: paths.env, platform: "darwin", home });
    const foreign = path.join(paths.late, "codex");
    writeFileSync(foreign, "#!/bin/sh\necho mine\n", { mode: 0o755 });

    const result = uninstallShim(paths.env);
    assert.deepEqual(result.removed, [path.join(paths.mid, "codex")]);
    assert.equal(result.installed, false);
    assert.equal(readFileSync(foreign, "utf8"), "#!/bin/sh\necho mine\n");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Windows is refused rather than given a bash script", () => {
  const home = scratch();
  try {
    const paths = layout(home);
    assert.throws(
      () => installShim({ environment: paths.env, platform: "win32", home }),
      /not available on Windows/,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the generated shim carries its marker so it never execs itself", () => {
  const shim = renderShim({ realCodex: "/usr/bin/codex" });
  assert.match(shim, new RegExp(SHIM_MARKER));
  // The PATH-search fallback must skip anything holding the marker, or a shim
  // that lost its recorded target would re-exec itself forever.
  assert.match(shim, /grep -q '.*MODEL_ROUTER_CODEX_SHIM.*'/);
});

test("a router that never comes up delays Codex but never blocks it", execRequiresPosix, () => {
  const home = scratch();
  try {
    const paths = layout(home);
    // A checkout whose `control` only records that it was called, and port 1,
    // which refuses instantly and stays refused. Together they reproduce the
    // worst case: the router is down and starting it does not help.
    const checkout = path.join(home, "checkout");
    mkdirSync(path.join(checkout, "bin"), { recursive: true });
    const log = path.join(home, "control.log");
    const control = path.join(checkout, "bin", "control");
    writeFileSync(control, `#!/bin/sh\necho called >> ${log}\n`, { mode: 0o755 });
    chmodSync(control, 0o755);

    const shimFile = path.join(paths.mid, "codex");
    // The shim exactly as shipped: the wait is shortened through its documented
    // environment variable rather than by rewriting the generated script, so
    // this covers the real text users get.
    writeFileSync(shimFile, renderShim({ realCodex: paths.realCodex, checkout, port: 1 }), {
      mode: 0o755,
    });
    chmodSync(shimFile, 0o755);

    const output = execFileSync(shimFile, ["hello"], {
      env: { ...process.env, MODEL_ROUTER_SHIM_WAIT: "1" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    // The point of the whole design: a dead router costs a warning and a
    // one-second pause, never a Codex that refuses to start.
    assert.equal(output.trim(), "real hello");
    assert.equal(readFileSync(log, "utf8").trim(), "called");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a healthy router is left alone: the shim never calls control", execRequiresPosix, async () => {
  const home = scratch();
  const server = createServer();
  try {
    const paths = layout(home);
    const checkout = path.join(home, "checkout");
    mkdirSync(path.join(checkout, "bin"), { recursive: true });
    const log = path.join(home, "control.log");
    const control = path.join(checkout, "bin", "control");
    writeFileSync(control, `#!/bin/sh\necho called >> ${log}\n`, { mode: 0o755 });
    chmodSync(control, 0o755);

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();

    const shimFile = path.join(paths.mid, "codex");
    writeFileSync(shimFile, renderShim({ realCodex: paths.realCodex, checkout, port }), {
      mode: 0o755,
    });
    chmodSync(shimFile, 0o755);

    const output = execFileSync(shimFile, ["hello"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    assert.equal(output.trim(), "real hello");
    // Nothing was spawned to check on a router that was already answering. This
    // is what keeps the shim off the critical path of every `codex` you run.
    assert.equal(existsSync(log), false);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

// The router must never resolve `codex` to its own shim.
//
// The shim starts the router when it finds it down, so a router that reaches it
// revives itself: the tray polls `control account` every 30 seconds, that spawns
// Codex through `findCodexBinary`, and the shim restarts the service the tray
// just stopped -- forever.
//
// These assert the invariant rather than an exact path, because `findCodexBinary`
// consults absolute locations (`/Applications/ChatGPT.app/...`, Homebrew) that a
// test cannot remove from the machine it runs on. "Never a shim" is the contract;
// which real Codex it settles on is the machine's business.
test("findCodexBinary never returns a shim named by CODEX_BIN", async (t) => {
  if (process.platform === "win32") return t.skip("no shim is installed on Windows");
  const home = scratch();
  try {
    const shimFile = path.join(home, "codex");
    // A shim by content, not by name: the marker is what identifies one.
    writeFileSync(shimFile, `#!/bin/sh\n# ${SHIM_MARKER}\nexec /nowhere/codex "$@"\n`, {
      mode: 0o755,
    });
    chmodSync(shimFile, 0o755);
    assert.equal(isShimFile(shimFile), true, "fixture must actually look like a shim");

    const { findCodexBinary } = await import(
      `../src/codex-binary.mjs?candidate-shim=${Date.now()}`
    );
    const previousBin = process.env.CODEX_BIN;
    try {
      // CODEX_BIN is the first entry in the candidate list, so this is the
      // strongest possible case for the filter: an explicitly named shim.
      process.env.CODEX_BIN = shimFile;
      const found = findCodexBinary();
      assert.notEqual(found, shimFile, "resolved to its own shim, which is the restart loop");
      if (found) assert.equal(isShimFile(found), false);
    } finally {
      if (previousBin === undefined) delete process.env.CODEX_BIN;
      else process.env.CODEX_BIN = previousBin;
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("findCodexBinary never returns a shim that shadows PATH", async (t) => {
  if (process.platform === "win32") return t.skip("no shim is installed on Windows");
  const home = scratch();
  try {
    const only = path.join(home, "bin");
    mkdirSync(only, { recursive: true });
    const shimFile = path.join(only, "codex");
    writeFileSync(shimFile, `#!/bin/sh\n# ${SHIM_MARKER}\nexec /nowhere/codex "$@"\n`, {
      mode: 0o755,
    });
    chmodSync(shimFile, 0o755);

    const { findCodexBinary } = await import(`../src/codex-binary.mjs?path-shim=${Date.now()}`);
    const previous = { path: process.env.PATH, bin: process.env.CODEX_BIN };
    try {
      process.env.PATH = only;
      delete process.env.CODEX_BIN;
      const found = findCodexBinary();
      assert.notEqual(found, shimFile);
      if (found) assert.equal(isShimFile(found), false, "stepped onto a shim via PATH");
    } finally {
      process.env.PATH = previous.path;
      if (previous.bin !== undefined) process.env.CODEX_BIN = previous.bin;
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// The PATH half of the same rule, isolated from the absolute candidates so it
// can assert the "there is no real Codex" answer exactly.
test("resolveRealCodex reports nothing when the only codex on PATH is a shim", (t) => {
  if (process.platform === "win32") return t.skip("no shim is installed on Windows");
  const home = scratch();
  try {
    const only = path.join(home, "bin");
    mkdirSync(only, { recursive: true });
    const shimFile = path.join(only, "codex");
    writeFileSync(shimFile, `#!/bin/sh\n# ${SHIM_MARKER}\nexec /nowhere/codex "$@"\n`, {
      mode: 0o755,
    });
    chmodSync(shimFile, 0o755);
    // Honest "none" rather than handing back the shim: a caller that spawned it
    // would restart the router, which is the loop this filter exists to break.
    assert.equal(resolveRealCodex({ PATH: only }), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
