import "./helpers/isolated-runtime-environment.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const fixture = new URL("./helpers/isolated-runtime-environment.mjs", import.meta.url).href;
const pathsModule = new URL("../src/paths.mjs", import.meta.url).href;

test("all ordinary Node test entrypoints preload the same credential boundary", () => {
  const rootPackage = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const appPackage = JSON.parse(readFileSync(new URL("../apps/control-center/package.json", import.meta.url), "utf8"));
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(rootPackage.scripts.test, /node --import \.\/test\/helpers\/isolated-runtime-environment\.mjs --test/);
  assert.match(appPackage.scripts.test, /node --import \.\.\/\.\.\/test\/helpers\/isolated-runtime-environment\.mjs --test/);
  assert.match(ci, /run: node --import \.\/test\/helpers\/isolated-runtime-environment\.mjs --test --test-timeout=600000 --test-concurrency=2/);
});

test("preloading isolation rejects inherited credential paths and never invokes host security", () => {
  const browsers = path.join(process.env.CODEX_HOME, "installed-playwright-browsers");
  const script = `
    import assert from 'node:assert/strict';
    import { execFileSync } from 'node:child_process';
    import { isolatedRuntimeRoot, keychainFixture } from ${JSON.stringify(fixture)};
    const { STATE_DIR } = await import(${JSON.stringify(pathsModule)});
    assert.equal(STATE_DIR.startsWith(isolatedRuntimeRoot), true);
    assert.equal(process.env.MODEL_ROUTER_STATE_DIR, undefined);
    assert.equal(process.env.MODEL_ROUTER_PROVIDER_CREDENTIAL_STORE, undefined);
    assert.equal(process.env.PLAYWRIGHT_BROWSERS_PATH, ${JSON.stringify(browsers)});
    for (const verb of ['find-generic-password', 'add-generic-password', 'delete-generic-password']) {
      for (const file of ['security', '/usr/bin/security']) {
        assert.throws(() => execFileSync(file, [verb, '-s', 'synthetic-service']));
      }
    }
    assert.equal(keychainFixture.calls.length, 6);
    console.log('isolated');
  `;
  const child = spawnSync(process.execPath, ["--import", fixture, "--input-type=module", "-e", script], {
    encoding: "utf8",
    env: {
      SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP, TMP: process.env.TMP,
      CODEX_HOME: path.join(process.env.CODEX_HOME, "inherited-unreachable"),
      MODEL_ROUTER_STATE_DIR: path.join(process.env.CODEX_HOME, "inherited-state"),
      MODEL_ROUTER_PROVIDER_CREDENTIAL_STORE: path.join(process.env.CODEX_HOME, "inherited-store"),
      PLAYWRIGHT_BROWSERS_PATH: browsers,
    },
    timeout: 15_000,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), "isolated");
});

test("inherited Keychain guard leaves child-selected homes and state aliases intact", () => {
  const codex = path.join(process.env.CODEX_HOME, "child-selected-home");
  const state = path.join(process.env.CODEX_HOME, "child-selected-state");
  const script = `
    import assert from 'node:assert/strict';
    import { execFileSync } from 'node:child_process';
    const { CODEX_HOME, STATE_DIR } = await import(${JSON.stringify(pathsModule)});
    assert.equal(CODEX_HOME, ${JSON.stringify(codex)});
    assert.equal(STATE_DIR, ${JSON.stringify(state)});
    assert.throws(() => execFileSync('/usr/bin/security', ['find-generic-password']));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8", timeout: 15_000,
    env: { ...process.env, CODEX_HOME: codex, MODEL_ROUTER_STATE_DIR: state, CODEX_ROUTER_STATE_DIR: state },
  });
  assert.equal(child.status, 0, child.stderr);
});
