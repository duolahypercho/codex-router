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
const [root, scratch, mode] = process.argv.slice(1);
const load = name => import(pathToFileURL(path.join(root, "src", name)).href);
const paths = await load("paths.mjs");
const security = await load("file-security.mjs");
const store = await load("provider-credential-store.mjs");
const target = path.join(paths.STATE_DIR, "metadata", "references.json");
const entry = store.createCredentialReference({ providerId: "deepseek", kind: "api_key",
  secretRef: { type: "provider-file", providerId: "deepseek", target: "codex" }, label: "Fixture κ 目录" });
const value = { schemaVersion: 2, credentials: [entry] };
const expected = Buffer.from(JSON.stringify(value, null, 2) + "\n");
const previous = Buffer.from('{\r\n "schemaVersion": 2, "credentials": []\r\n}\r\n');
fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
fs.chmodSync(path.dirname(target), 0o755);
if (mode !== "fresh") fs.writeFileSync(target, previous, { mode: 0o600 });
const original = { exec: cp.execFileSync, open: fs.openSync, write: fs.writeFileSync,
  close: fs.closeSync, rename: fs.renameSync, unlink: fs.unlinkSync, read: fs.readFileSync, lstat: fs.lstatSync };
const within = (file, parent) => {
  const relative = path.relative(parent, path.resolve(file instanceof URL ? fileURLToPath(file) : file));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};
const focused = file => typeof file === "string" && path.dirname(file) === path.dirname(target)
  && (path.basename(file).startsWith(path.basename(target) + ".tmp.") || path.basename(file).startsWith("." + path.basename(target) + ".tmp-"));
const descriptors = new Set();
const temporaries = new Set();
const stranger = Buffer.from("FOREIGN_METADATA_TEMPORARY\n");
const primary = Object.assign(new Error("injected metadata publication failure"), { code: "EACCES" });
let foreign;
let displaced;
let injected = false;
let rejectedPath;
let helpers = 0;
let publications = 0;
let forbiddenReads = 0;
let forbiddenCommands = 0;
function collide(file) {
  foreign = file; injected = true;
  const fd = original.open(file, "wx", 0o600);
  try { original.write(fd, stranger); } finally { original.close(fd); }
}
cp.execFileSync = (command, args, options = {}) => {
  if (options.env?.CODEX_ROUTER_PRIVATE_FILES || options.env?.CODEX_ROUTER_PRIVATE_FILE) {
    const files = options.env.CODEX_ROUTER_PRIVATE_FILES ? JSON.parse(options.env.CODEX_ROUTER_PRIVATE_FILES) : [options.env.CODEX_ROUTER_PRIVATE_FILE];
    assert.ok(files.every(file => within(file, scratch)), "ACL operations stay in owned fixtures");
    if (options.env.CODEX_ROUTER_PRIVATE_FILES) {
      helpers += files.length;
      if (mode === "harden-failure" && files.some(focused)) { injected = true; throw primary; }
    }
    return original.exec(command, args, options);
  }
  forbiddenCommands += 1; throw new Error("no external credential or service command allowed");
};
fs.openSync = (file, flags, permissions) => {
  if (focused(file) && flags === "wx") {
    assert.equal(permissions, 0o600);
    if (mode === "collision") collide(file);
  }
  const fd = original.open(file, flags, permissions);
  if (focused(file) && flags === "wx") { temporaries.add(file); descriptors.add(fd); }
  return fd;
};
fs.writeFileSync = (file, bytes, options) => {
  // The baseline opens a random name non-exclusively. Put a foreign file at
  // that exact name before it writes; the shared writer instead collides at wx.
  if (focused(file) && mode === "collision") collide(file);
  if (descriptors.has(file) && mode === "write-failure") {
    original.write(file, "partial"); injected = true; throw primary;
  }
  return original.write(file, bytes, options);
};
fs.closeSync = fd => {
  const owned = descriptors.delete(fd);
  const result = original.close(fd);
  if (owned && mode === "close-failure") { injected = true; throw primary; }
  return result;
};
fs.renameSync = (temporary, destination) => {
  assert.ok(within(destination, scratch));
  assert.equal(path.dirname(temporary), path.dirname(destination));
  assert.equal(descriptors.size, 0);
  assert.equal(security.privateFileIsProtected(temporary), true, "protect metadata before publication");
  if (destination === target && ["rename-failure", "cleanup-failure", "leaf-race"].includes(mode)) {
    injected = true;
    if (mode === "leaf-race") {
      displaced = temporary + ".displaced"; original.rename(temporary, displaced);
      foreign = temporary; original.write(foreign, stranger);
    }
    throw primary;
  }
  publications += 1;
  return original.rename(temporary, destination);
};
fs.unlinkSync = file => {
  if (temporaries.has(file) && mode === "cleanup-failure") throw new Error("injected metadata cleanup failure");
  return original.unlink(file);
};
fs.lstatSync = (file, options) => path.resolve(file) === rejectedPath
  ? { isSymbolicLink: () => true } : original.lstat(file, options);
fs.readFileSync = (file, options) => {
  if (typeof file !== "number" && !within(file, root) && !within(file, scratch)) {
    forbiddenReads += 1; throw new Error("outside fixture read blocked");
  }
  return original.read(file, options);
};
syncBuiltinESMExports();
globalThis.fetch = () => { throw new Error("no network in metadata test"); };
assert.throws(() => fs.readFileSync(path.join(scratch, "..", "outside-fixture")), /outside fixture read blocked/);
assert.equal(forbiddenReads, 1); forbiddenReads = 0;
let result;
let error;
try {
  if (mode === "validation") {
    assert.throws(() => store.writeProviderCredentialStore(value, path.join(scratch, "outside-state.json")), /inside the router state/);
    assert.throws(() => store.writeProviderCredentialStore({ credentials: [], accessToken: "SYNTHETIC_NOT_ACCEPTED" }, target), /secret field accessToken/);
    for (const file of [target, path.dirname(target)]) {
      rejectedPath = file;
      assert.throws(() => store.writeProviderCredentialStore(value, target), /symbolic link/);
    }
    rejectedPath = undefined;
  } else {
    result = store.writeProviderCredentialStore(value, target);
    if (mode === "repeat") result = store.writeProviderCredentialStore(value, target);
  }
} catch (cause) { error = cause; }
if (foreign) {
  assert.equal(fs.existsSync(foreign), true, "foreign metadata temporary must survive");
  assert.deepEqual(fs.readFileSync(foreign), stranger);
}
if (["collision", "write-failure", "close-failure", "harden-failure", "rename-failure", "cleanup-failure", "leaf-race"].includes(mode)) {
  assert.equal(injected, true); assert.ok(error); assert.equal(publications, 0);
  assert.deepEqual(fs.readFileSync(target), previous);
  if (mode === "collision") assert.equal(error.code, "EEXIST");
  else if (mode === "harden-failure") assert.match(error.message, /^Failed to protect private file ACL: injected metadata/);
  else assert.equal(error, primary);
  if (mode === "cleanup-failure") assert.match(primary.cleanupError?.message || "", /injected metadata cleanup/);
  if (mode === "leaf-race") {
    assert.equal(primary.cleanupError?.code, "ESTALE");
    assert.deepEqual(fs.readFileSync(displaced), expected);
  }
} else if (mode === "validation") {
  assert.equal(error, undefined); assert.equal(helpers, 0); assert.equal(publications, 0);
  assert.deepEqual(fs.readFileSync(target), previous);
} else {
  assert.equal(error, undefined); assert.deepEqual(result, value);
  assert.deepEqual(fs.readFileSync(target), expected);
  assert.deepEqual(store.readProviderCredentialStore(target), value);
  assert.equal(security.privateFileIsProtected(target), true);
}
if (!error && mode !== "validation") {
  if (process.platform === "win32") assert.equal(helpers, publications, "one Windows ACL helper per metadata publication");
  else assert.equal(fs.statSync(path.dirname(target)).mode & 0o777, 0o700, "retain explicit managed directory mode");
}
for (const file of temporaries) assert.equal(fs.existsSync(file), mode === "cleanup-failure" || mode === "leaf-race", "clean only owned unpublished metadata temporary");
assert.equal(descriptors.size, 0); assert.equal(forbiddenReads, 0); assert.equal(forbiddenCommands, 0);
process.stdout.write(JSON.stringify({ publications, helpers }) + "\n");
`;

function exercise(mode) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "router-metadata-private-"));
  assert.equal(path.dirname(path.resolve(scratch)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(scratch).startsWith("router-metadata-private-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
    !/^(MODEL_ROUTER_|CODEX_ROUTER_|CODEX_HOME$|NODE_OPTIONS$|KIMI_|GROK_|GCLOUD_)/i.test(name)
    && !/(?:KEY|TOKEN|SECRET|PROXY)/i.test(name)
  )));
  Object.assign(env, { CODEX_HOME: path.join(scratch, "codex"),
    CODEX_ROUTER_STATE_DIR: path.join(scratch, "state space's 目录"),
    MODEL_ROUTER_TARGET: "codex", KIMI_CODE_HOME: path.join(scratch, "kimi") });
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", runner, root, scratch, mode], {
      cwd: root, env, encoding: "utf8", timeout: 120_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal((result.stdout + result.stderr).includes("Fixture κ"), false, "do not log credential metadata");
    return JSON.parse(result.stdout);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

for (const mode of ["fresh", "repeat", "collision", "write-failure", "close-failure", "rename-failure", "cleanup-failure", "leaf-race", "validation"]) {
  test(`credential metadata ${mode} preserves private bytes, validation and ownership`, () => exercise(mode));
}
test("credential metadata ACL failure preserves the old store", {
  skip: process.platform !== "win32" ? "Windows ACL failure injection" : false,
}, () => exercise("harden-failure"));
