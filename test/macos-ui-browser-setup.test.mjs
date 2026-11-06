import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { posixShell } from "./helpers/posix-shell.mjs";

// Exercise the builder's actual UI subshell without invoking Swift, npm ci,
// browser downloads, or packaging. Its parent owns `set -eu` and these paths.
const source = readFileSync(new URL("../scripts/build-macos-tray-app.sh", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const start = source.indexOf('(\n  cd "$control_center_dir"\n');
const end = source.indexOf("\nelectron_output=", start);
assert.ok(start >= 0 && end > start, "locate the native builder's UI subshell");
const uiBuild = source.slice(start, end);
const shell = posixShell();

function fixture(t, { explicitCache = false, installStatus = 0 } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "native-ui-browser-"));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("native-ui-browser-"));
    rmSync(directory, { recursive: true, force: true });
  });
  const project = path.join(directory, "UI project", "apps", "control-center");
  const repository = path.dirname(path.dirname(project));
  const log = path.join(directory, "calls");
  mkdirSync(project, { recursive: true });
  const environment = {
    ...process.env,
    repo_dir: repository.replaceAll("\\", "/"),
    control_center_dir: project.replaceAll("\\", "/"),
    UI_FIXTURE_LOG: log,
  };
  delete environment.PLAYWRIGHT_BROWSERS_PATH;
  const chosenCache = path.join(directory, "caller browser assets");
  if (explicitCache) environment.PLAYWRIGHT_BROWSERS_PATH = chosenCache;
  const pwd = process.platform === "win32" ? "pwd -W" : "pwd";
  const script = `
    set -eu
    record() {
      printf '%s\\000%s\\000%s\\000' "$*" "$(${pwd})" "\${PLAYWRIGHT_BROWSERS_PATH-unset}" >> "$UI_FIXTURE_LOG"
    }
    npm() { record "npm $*"; }
    npx() { record "npx $*"; return ${installStatus}; }
    ${uiBuild}
    printf '%s' "\${PLAYWRIGHT_BROWSERS_PATH-unset}"
  `;
  const result = spawnSync(shell, ["-c", script], { env: environment, encoding: "utf8", timeout: 10_000 });
  assert.equal(result.error, undefined, result.error?.message);
  const fields = readFileSync(log, "utf8").split("\0");
  assert.equal(fields.pop(), "");
  const calls = [];
  for (let index = 0; index < fields.length; index += 3) {
    const [command, cwd, cache] = fields.slice(index, index + 3);
    calls.push({ command, cwd, cache: cache === "unset" ? null : cache });
  }
  return { result, calls, project, chosenCache, expectedCache: explicitCache ? chosenCache : path.join(repository, "generated", "playwright-browsers") };
}

for (const explicitCache of [false, true]) {
  test(`native UI setup installs the locked shell before testing (${explicitCache ? "explicit" : "generated"} cache)`, { skip: !shell && "A POSIX shell is unavailable." }, (t) => {
    const { result, calls, project, chosenCache, expectedCache } = fixture(t, { explicitCache });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls.map(({ command }) => command), [
      "npm ci", "npx --no-install playwright install --only-shell chromium",
      "npm run check", "npm test", "npm run build",
    ]);
    for (const call of calls) {
      // Resolve logical links such as macOS /var before comparing directories.
      assert.equal(realpathSync.native(call.cwd), realpathSync.native(project));
    }
    assert.equal(calls[0].cache, explicitCache ? chosenCache : null);
    for (const call of calls.slice(1)) assert.equal(path.resolve(call.cache), expectedCache);
    assert.equal(result.stdout, explicitCache ? chosenCache : "unset", "the default export stays inside the UI subshell");
  });
}

test("native UI setup stops before tests and packaging when shell installation fails", { skip: !shell && "A POSIX shell is unavailable." }, (t) => {
  const { result, calls } = fixture(t, { installStatus: 23 });
  assert.equal(result.status, 23, result.stderr);
  assert.deepEqual(calls.map(({ command }) => command), [
    "npm ci", "npx --no-install playwright install --only-shell chromium",
  ]);
});
