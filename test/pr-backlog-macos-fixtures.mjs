import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MACOS_RELEASE_TEAM_ID, assertContainedBundle, checksumForAsset, expectedTrayFingerprint, macosReleaseAsset, releaseSignatureRequirement } from "../src/macos-tray-release.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts/download-macos-tray-release.mjs");

export async function runMacosScenarios(t) {
  await t.test("macOS download is dormant without a repository signer pin", () => {
    assert.equal(MACOS_RELEASE_TEAM_ID, "");
    assert.throws(() => releaseSignatureRequirement(), /No trusted/);
    assert.match(releaseSignatureRequirement("ABCDE12345"), /subject\.OU.*ABCDE12345/);
    assert.throws(() => releaseSignatureRequirement('ABCDE12345" or true'), /No trusted/);
    const directory = mkdtempSync(path.join(os.tmpdir(), "backlog-no-signer-"));
    try {
      const target = path.join(directory, "Codex Router.app");
      const result = spawnSync(process.execPath, [script, target], {
        encoding: "utf8", timeout: 15_000,
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TMPDIR: directory, MACOS_TEAM_ID: "ATTACK1234" },
      });
      assert.ifError(result.error);
      assert.equal(result.status, process.platform === "darwin" ? 75 : 2, result.stderr);
      assert.equal(existsSync(target), false);
      assert.deepEqual(readdirSync(directory), []);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  await t.test("release manifest ambiguity and bundle escapes fail closed", { skip: process.platform === "win32" }, () => {
    const hash = "a".repeat(64);
    assert.equal(checksumForAsset(`${hash} *asset.zip\n`, "asset.zip"), hash);
    assert.throws(() => checksumForAsset(`${hash} asset.zip\n${hash} asset.zip`, "asset.zip"), /exactly one/);
    assert.throws(() => checksumForAsset(`${hash} other.zip`, "asset.zip"), /exactly one/);
    const directory = mkdtempSync(path.join(os.tmpdir(), "backlog-bundle-"));
    try {
      const app = path.join(directory, "app");
      mkdirSync(app);
      writeFileSync(path.join(app, "binary"), "fixture");
      symlinkSync("binary", path.join(app, "inside"));
      assertContainedBundle(app);
      writeFileSync(path.join(directory, "outside"), "preserve");
      symlinkSync("../outside", path.join(app, "escape"));
      assert.throws(() => assertContainedBundle(app), /escaping symbolic link/);
      assert.equal(readFileSync(path.join(directory, "outside"), "utf8"), "preserve");
      symlinkSync(app, path.join(directory, "root-link"));
      assert.throws(() => assertContainedBundle(path.join(directory, "root-link")), /root is a symbolic link/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  await t.test("download subprocess enforces integrity, trust ordering, cleanup, and source fallback", { skip: process.platform !== "darwin" }, () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "backlog-release-process-"));
    try {
      const bundle = path.join(directory, "fixture", "Codex Router.app", "Contents");
      mkdirSync(bundle, { recursive: true });
      writeFileSync(path.join(bundle, "fixture"), "synthetic signed-app contents");
      const archive = path.join(directory, "fixture.tar");
      const packed = spawnSync("/usr/bin/tar", ["-cf", archive, "-C", path.dirname(path.dirname(bundle)), "Codex Router.app"], { encoding: "utf8", timeout: 10_000 });
      assert.equal(packed.status, 0, packed.stderr);
      const version = JSON.parse(readFileSync(path.join(root, "package.json"))).version;
      const controlVersion = JSON.parse(readFileSync(path.join(root, "apps/control-center/package.json"))).version;
      const asset = macosReleaseAsset(version);
      const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
      const config = { archive, asset, digest, version, controlVersion, fingerprint: expectedTrayFingerprint(root), script };
      const wrapper = path.join(directory, "harness.mjs");
      // The real downloader and real archive extractor run in a child process.
      // Only network and Apple signature services are mocked. This verifies the
      // trust gates and installer flow, not an actual Developer ID signature.
      writeFileSync(wrapper, `
import child from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
const c = JSON.parse(process.env.RELEASE_FIXTURE);
const audit = [];
const realExec = child.execFileSync;
const log = value => { audit.push(value); fs.writeFileSync(c.audit, JSON.stringify(audit)); };
registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (url.endsWith('/src/macos-tray-release.mjs')) return { ...result, source: String(result.source).replace('export const MACOS_RELEASE_TEAM_ID = "";', 'export const MACOS_RELEASE_TEAM_ID = "ABCDE12345";') };
  return result;
} });
child.spawnSync = (command, args) => {
  if (command !== '/usr/bin/curl') throw new Error('Unexpected spawn: ' + command);
  log(['curl', args]);
  const output = args[args.indexOf('--output') + 1];
  if (c.mode === 'unavailable') return { status: 0, stdout: '404' };
  if (output.endsWith('SHA256SUMS')) {
    const row = (c.mode === 'checksum' ? '0'.repeat(64) : c.digest) + '  ' + c.asset + '\\n';
    fs.writeFileSync(output, c.mode === 'duplicate' ? row + row : row);
  } else fs.copyFileSync(c.archive, output);
  return { status: 0, stdout: '200' };
};
child.execFileSync = (command, args, options) => {
  log([command, args]);
  if (command === '/usr/bin/tar') return realExec(command, args, options);
  if (command === '/usr/bin/codesign') {
    if (c.mode === 'signature') throw new Error('Synthetic signature rejection');
    if (args.includes('--requirements') && !args[args.indexOf('--requirements') + 1].includes('ABCDE12345')) throw new Error('Missing signer pin');
    return '';
  }
  if (command === '/usr/sbin/spctl') {
    if (c.mode === 'gatekeeper') throw new Error('Synthetic Gatekeeper rejection');
    return '';
  }
  if (command === '/usr/libexec/PlistBuddy') {
    const values = { CFBundleShortVersionString: c.version.split('-')[0], ModelRouterControlVersion: c.controlVersion, ModelRouterTraySourceFingerprint: c.mode === 'fingerprint' ? 'stale' : c.fingerprint, CFBundleIdentifier: 'io.github.codex-router.tray' };
    return values[args[1].split(':')[1]];
  }
  if (command === '/usr/bin/ditto') { fs.cpSync(args[0], args[1], { recursive: true }); return ''; }
  throw new Error('Unexpected exec: ' + command);
};
syncBuiltinESMExports();
process.argv = [process.execPath, c.script, c.target];
await import(c.script);
`);
      for (const mode of ["success", "unavailable", "checksum", "duplicate", "signature", "gatekeeper", "fingerprint", "existing"]) {
        const scratch = path.join(directory, mode);
        mkdirSync(scratch);
        const target = path.join(scratch, "Codex Router.app");
        const audit = path.join(scratch, "audit.json");
        if (mode === "existing") { mkdirSync(target); writeFileSync(path.join(target, "preserve"), "operator data"); }
        const result = spawnSync(process.execPath, [wrapper], {
          encoding: "utf8", timeout: 20_000,
          env: { PATH: process.env.PATH, TMPDIR: scratch, RELEASE_FIXTURE: JSON.stringify({ ...config, mode, target, audit }) },
        });
        assert.ifError(result.error);
        assert.equal(result.status, mode === "success" ? 0 : ["unavailable", "fingerprint"].includes(mode) ? 75 : 1, `${mode}: ${result.stderr}`);
        const calls = JSON.parse(readFileSync(audit));
        assert.equal(calls.some(([command]) => command === "/usr/bin/ditto"), mode === "success", mode);
        assert.equal(readdirSync(scratch).some(name => name.startsWith("codex-router-macos-release-")), false, `temporary files leaked: ${mode}`);
        if (mode === "existing") assert.equal(readFileSync(path.join(target, "preserve"), "utf8"), "operator data");
        else assert.equal(existsSync(target), mode === "success", mode);
        if (mode === "success") {
          const commands = calls.map(([command]) => command);
          assert.ok(commands.indexOf("/usr/bin/codesign") < commands.indexOf("/usr/libexec/PlistBuddy"));
          assert.ok(commands.indexOf("/usr/sbin/spctl") < commands.indexOf("/usr/libexec/PlistBuddy"));
          assert.ok(calls.some(([command, args]) => command === "/usr/bin/codesign" && args.includes("--requirements") && args[args.indexOf("--requirements") + 1].includes('subject.OU] = "ABCDE12345"')), "the pinned signer requirement must actually be checked");
          assert.equal(readFileSync(path.join(target, "Contents/fixture"), "utf8"), "synthetic signed-app contents");
          for (const [, args] of calls.filter(([command]) => command === "curl")) {
            assert.ok(args.includes("=https"));
            assert.ok(args.includes("--proto-redir"));
            assert.ok(args.includes("--max-time"));
            assert.ok(args.includes("--max-filesize"));
          }
        }
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}
