import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runner = String.raw`
import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [root, mode, focusName] = process.argv.slice(1);
process.env.CODEX_BIN = process.execPath;
const load = (name) => import(pathToFileURL(path.join(root, "src", name)).href);
const security = await load("file-security.mjs");
const paths = await load("paths.mjs");
const targets = { capture: paths.NATIVE_CATALOG_PATH, aliases: paths.NATIVE_ALIAS_PATH,
  announcements: paths.ANNOUNCED_MODELS_PATH, merged: paths.MERGED_CATALOG_PATH };
const watched = Object.values(targets);
const publicationFiles = [targets.merged, targets.aliases, targets.announcements];
const focus = targets[focusName];
const nativeModel = (slug) => ({ slug, display_name: "Synthetic native 目录", visibility: "list", priority: 10,
  base_instructions: "Synthetic native instructions", apply_patch_tool_type: "freeform" });
const freshNative = { models: [nativeModel("gpt-native-fixture")] };
const previous = new Map();
fs.mkdirSync(paths.CODEX_HOME, { recursive: true, mode: 0o700 });
fs.mkdirSync(paths.STATE_DIR, { recursive: true, mode: 0o700 });
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const selected = "deepseek/deepseek-v4-flash";
fs.writeFileSync(paths.PROVIDER_SELECTION_PATH, json({ version: 1, providers: ["deepseek"] }));
fs.writeFileSync(path.join(paths.STATE_DIR, "deepseek-api-key.secret"), "SYNTHETIC_CATALOG_KEY\n");
fs.writeFileSync(path.join(paths.STATE_DIR, "model-picker.json"), json({ version: 1, visible: [selected], hidden: [], seeded: [selected] }));
const config = 'model = "gpt-native-fixture"\n# caller-owned 目录\n';
fs.writeFileSync(paths.CONFIG_PATH, config);
if (mode !== "fresh" && mode !== "rollback-absent") {
  const old = new Map([
    [targets.capture, { captured_with: "old", models: [nativeModel("gpt-old-fixture")] }],
    [targets.aliases, { version: 1, aliases: { old: "old-route" } }],
    [targets.announcements, { version: 1, models: { "retired/fixture": 0 } }],
    [targets.merged, { models: [{ slug: "previous-目录" }] }],
  ]);
  for (const [file, value] of old) {
    const bytes = Buffer.from(" \r\n" + JSON.stringify(value) + "\r\n");
    previous.set(file, bytes);
    fs.writeFileSync(file, bytes, { mode: 0o600 });
  }
  security.protectPrivateFile(targets.capture);
}

const original = { exec: cp.execFileSync, read: fs.readFileSync, open: fs.openSync,
  write: fs.writeFileSync, close: fs.closeSync, rename: fs.renameSync, unlink: fs.unlinkSync };
const temporaryFor = (file, target) => typeof file === "string" && file.startsWith(target + ".tmp.");
const isTemporary = (file) => watched.some((target) => temporaryFor(file, target));
const isFocused = (file) => temporaryFor(file, focus);
const temporaries = new Set();
const descriptors = new Map();
const stranger = Buffer.from("UNOWNED_CATALOG_TEMPORARY\n");
let unowned;
let displaced;
let attempted;
let retained;
let injected = false;
let restoreFailed = false;
let forbiddenReads = 0;
let helperCalls = 0;
const primary = new Error("injected catalog publication failure");
const secondary = new Error("injected catalog restore failure");
const publications = [];
if (mode === "legacy-collision") {
  unowned = focus + ".tmp." + process.pid;
  original.write(unowned, stranger, { mode: 0o600 });
}
cp.execFileSync = (command, args, options = {}) => {
  if (command === process.execPath) {
    if (args[0] === "--version") return "codex-cli 99.0.0\n";
    if (args[0] === "login" && args[1] === "status") return "";
    if (args[0] === "debug" && args[1] === "models") return JSON.stringify(freshNative);
    throw new Error("unexpected synthetic Codex command");
  }
  if (command === "/usr/bin/security") throw Object.assign(new Error("synthetic Keychain is empty"), { status: 1 });
  if (options.env?.CODEX_ROUTER_PRIVATE_FILES) {
    const files = JSON.parse(options.env.CODEX_ROUTER_PRIVATE_FILES);
    if (files.some((file) => isTemporary(file) || watched.includes(file))) {
      helperCalls += 1;
      if (mode === "harden-failure" && files.some(isFocused) && !injected) {
        injected = true;
        throw primary;
      }
    }
    return original.exec(command, args, options);
  }
  if (options.env?.CODEX_ROUTER_PRIVATE_FILE) return original.exec(command, args, options);
  throw new Error("unexpected external command in synthetic catalog publication");
};
const inside = (base, file) => { const relative = path.relative(base, file); return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative)); };
fs.readFileSync = (file, options) => {
  const target = file instanceof URL ? fileURLToPath(file) : file;
  if (typeof target === "string" && target !== process.execPath && !inside(root, target) && !inside(path.dirname(paths.CODEX_HOME), target)) {
    forbiddenReads += 1;
    throw new Error("synthetic catalog must not read operator files");
  }
  return original.read(file, options);
};
fs.openSync = (file, flags, permission) => {
  if (isTemporary(file) && flags === "wx") {
    assert.equal(permission, 0o600);
    assert.equal(temporaries.has(file), false, "every replacement needs its own temporary");
    if (mode === "exclusive-collision" && isFocused(file) && !injected) {
      injected = true;
      unowned = file;
      const fd = original.open(file, "wx", 0o600);
      try { original.write(fd, stranger); } finally { original.close(fd); }
    }
  }
  const fd = original.open(file, flags, permission);
  if (isTemporary(file) && flags === "wx") { temporaries.add(file); descriptors.set(fd, file); }
  return fd;
};
fs.writeFileSync = (file, bytes, options) => {
  if (mode === "write-failure" && isFocused(descriptors.get(file)) && !injected) {
    injected = true;
    original.write(file, "PARTIAL");
    throw primary;
  }
  return original.write(file, bytes, options);
};
fs.closeSync = (fd) => {
  const file = descriptors.get(fd);
  descriptors.delete(fd);
  const result = original.close(fd);
  if (mode === "close-failure" && isFocused(file) && !injected) { injected = true; throw primary; }
  return result;
};
fs.renameSync = (temporary, target) => {
  if (watched.includes(target)) {
    assert.equal(path.dirname(temporary), path.dirname(target));
    assert.equal(descriptors.size, 0, "close completed bytes before publication");
    assert.equal(security.privateFileIsProtected(temporary), true, "catalog bytes must be private before publication");
    if (["rename-failure", "cleanup-failure", "leaf-race", "rollback-absent", "rollback-failure", "capture-failure"].includes(mode) && target === focus && !injected) {
      injected = true;
      if (mode === "leaf-race") {
        attempted = fs.readFileSync(temporary);
        displaced = temporary + ".displaced";
        original.rename(temporary, displaced);
        unowned = temporary;
        original.write(unowned, stranger, { mode: 0o600 });
      }
      throw primary;
    }
    if (mode === "rollback-failure" && injected && target === targets.announcements) {
      restoreFailed = true;
      throw secondary;
    }
    publications.push(target);
  }
  return original.rename(temporary, target);
};
fs.unlinkSync = (file) => {
  if (mode === "cleanup-failure" && isFocused(file) && temporaries.has(file) && !retained) {
    retained = file;
    throw new Error("injected catalog cleanup failure");
  }
  return original.unlink(file);
};
syncBuiltinESMExports();
globalThis.fetch = () => { throw new Error("synthetic catalog must not access the network"); };
const permissionControl = path.join(paths.STATE_DIR, "permission-control");
fs.writeFileSync(permissionControl, "SYNTHETIC_PUBLIC_CONTROL\n", { mode: 0o644 });
fs.chmodSync(permissionControl, 0o644);
assert.equal(security.privateFileIsProtected(permissionControl), false, "privacy detector must reject the public control");
security.protectPrivateFile(permissionControl);
assert.equal(security.privateFileIsProtected(permissionControl), true, "privacy detector must accept the protected control");
const catalog = await load("catalog.mjs");
let error;
let result;
try {
  result = catalog.publishCatalog({ refreshNative: true, output: false });
  if (mode === "repeat") {
    const first = new Map(watched.map((file) => [file, fs.readFileSync(file)]));
    result = catalog.publishCatalog({ refreshNative: false, output: false });
    for (const [file, bytes] of first) assert.deepEqual(fs.readFileSync(file), bytes, "repeat publication preserves catalog bytes");
  }
} catch (cause) { error = cause; }
assert.equal(forbiddenReads, 0, "all catalog/account/session inputs must belong to the synthetic fixture");
assert.equal(fs.readFileSync(paths.CONFIG_PATH, "utf8"), config);
assert.equal(fs.existsSync(path.join(paths.CODEX_HOME, "auth.json")), false);
if (unowned) {
  assert.equal(fs.existsSync(unowned), true, "a colliding temporary belongs to another writer");
  assert.deepEqual(fs.readFileSync(unowned), stranger);
}
const failure = ["write-failure", "close-failure", "harden-failure", "rename-failure", "cleanup-failure", "leaf-race", "exclusive-collision", "rollback-absent", "rollback-failure"].includes(mode);
if (failure) {
  assert.equal(injected, true);
  assert.ok(error);
  if (mode === "rollback-failure") {
    assert.equal(restoreFailed, true);
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [primary, secondary]);
    assert.notEqual(error.catalogRollbackSafe, true);
  } else {
    assert.equal(error.catalogRollbackSafe, true);
    if (mode === "exclusive-collision") assert.equal(error.code, "EEXIST");
    else if (mode === "harden-failure") assert.match(error.message, /^Failed to protect private file ACL: injected catalog publication failure/);
    else assert.equal(error, primary);
  }
  for (const file of publicationFiles) {
    if (mode === "rollback-failure" && file === targets.announcements) {
      assert.notDeepEqual(fs.readFileSync(file), previous.get(file));
    } else if (previous.has(file)) assert.deepEqual(fs.readFileSync(file), previous.get(file), "rollback restores exact original whitespace and Unicode bytes");
    else assert.equal(fs.existsSync(file), false, "rollback removes initially absent publication files");
  }
  if (mode === "cleanup-failure") assert.match(error.cleanupError?.message || "", /injected catalog cleanup/);
  if (mode === "leaf-race") {
    assert.equal(error.cleanupError?.code, "ESTALE");
    assert.deepEqual(fs.readFileSync(displaced), attempted);
    assert.equal(security.privateFileIsProtected(displaced), true);
  }
} else {
  assert.equal(error, undefined);
  assert.equal(result.path, targets.merged);
  const merged = JSON.parse(fs.readFileSync(targets.merged, "utf8"));
  const nativeSlug = mode === "capture-failure" ? "gpt-old-fixture" : "gpt-native-fixture";
  assert.ok(merged.models.some((model) => model.slug === nativeSlug));
  assert.equal(merged.models.find((model) => model.slug === selected)?.visibility, "list");
  assert.deepEqual(JSON.parse(fs.readFileSync(targets.aliases, "utf8")), {
    version: 1, mode: "native", aliases: {},
    bindings: mode === "fresh" ? {} : { old: "old-route" },
  });
  const announcement = JSON.parse(fs.readFileSync(targets.announcements, "utf8"));
  assert.equal(announcement.version, 1);
  assert.ok(Object.hasOwn(announcement.models, selected));
  if (mode === "capture-failure") {
    assert.equal(injected, true);
    assert.deepEqual(fs.readFileSync(targets.capture), previous.get(targets.capture));
  } else if (process.platform === "win32") assert.equal(helperCalls, mode === "repeat" ? 7 : 4, "one ACL helper per catalog publication");
  for (const file of watched) {
    assert.equal(security.privateFileIsProtected(file), true);
    const bytes = fs.readFileSync(file, "utf8");
    if (file !== targets.capture || mode !== "capture-failure") assert.equal(bytes, json(JSON.parse(bytes)), "JSON formatting and final LF stay unchanged");
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
}
for (const temporary of temporaries) assert.equal(fs.existsSync(temporary), temporary === retained || temporary === unowned, "cleanup removes only owned unpublished temporaries");
if (retained) assert.equal(security.privateFileIsProtected(retained), true);
assert.equal(descriptors.size, 0);
process.stdout.write(JSON.stringify({ helperCalls, failure, publications: publications.length }) + "\n");
`;

function exercise(mode, focus = "merged") {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "router-catalog-private-"));
  assert.equal(path.dirname(path.resolve(scratch)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(scratch).startsWith("router-catalog-private-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
    !/^(MODEL_ROUTER_|CODEX_ROUTER_|CODEX_HOME$|CODEX_BIN$|NODE_OPTIONS$|KIMI_|GROK_|GCLOUD_)/i.test(name)
    && !/(?:KEY|TOKEN|SECRET|PROXY)/i.test(name)
  )));
  Object.assign(env, {
    CODEX_HOME: path.join(scratch, "codex"),
    MODEL_ROUTER_STATE_DIR: path.join(scratch, "state space's 目录"),
    CODEX_ROUTER_STATE_DIR: path.join(scratch, "state space's 目录"),
    MODEL_ROUTER_USER_MODELS: path.join(scratch, "models.json"),
    MODEL_ROUTER_TARGET: "codex",
    MODEL_ROUTER_LOGIN_FREE: "0",
    CODEX_ROUTER_NO_DISCOVERY: "0",
    KIMI_CODE_HOME: path.join(scratch, "kimi"),
    GROK_AUTH_PATH: path.join(scratch, "grok", "auth.json"),
    DEVIN_CREDENTIALS_PATH: path.join(scratch, "devin", "credentials.toml"),
    GCLOUD_BIN: path.join(scratch, "missing-gcloud"),
  });
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", runner, root, mode, focus], {
      cwd: root, env, encoding: "utf8", timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal((result.stdout + result.stderr).includes("SYNTHETIC_CATALOG_KEY"), false);
    return JSON.parse(result.stdout);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

for (const mode of ["fresh", "repeat"]) test(`catalog ${mode} keeps all published JSON private and stable`, () => exercise(mode));
for (const focus of ["capture", "aliases", "announcements", "merged"]) {
  test(`catalog ${focus} legacy-collision preserves another writer's temporary`, () => exercise("legacy-collision", focus));
}
for (const mode of ["write-failure", "close-failure", "rename-failure", "exclusive-collision", "cleanup-failure", "leaf-race", "rollback-absent", "rollback-failure"]) {
  test(`catalog ${mode} retains its snapshot and cleanup contracts`, () => exercise(mode));
}
test("catalog capture failure retains the previous native capture and fallback", () => exercise("capture-failure", "capture"));
test("catalog ACL failure restores exact prior publication bytes", {
  skip: process.platform !== "win32" ? "Windows ACL failure injection" : false,
}, () => exercise("harden-failure"));
