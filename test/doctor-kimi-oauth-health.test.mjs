import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let healthServer;
let routerPort;

before(async () => {
  healthServer = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import http from "node:http";
        const server = http.createServer((_request, response) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ service: "codex-router", version: "test" }));
        });
        server.listen(0, "127.0.0.1", () => process.stdout.write(String(server.address().port)));
      `,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const [chunk] = await once(healthServer.stdout, "data");
  routerPort = Number(chunk);
});

after(() => {
  healthServer?.kill();
});

function removeDirectoryIfPresent(directory) {
  if (existsSync(directory)) rmdirSync(directory);
}

function doctorKimiCheck({ selected, credential }) {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "doctor-kimi-health-"));
  const stateDir = path.join(testRoot, "state");
  const kimiHome = path.join(testRoot, "kimi");
  const credentialsDir = path.join(kimiHome, "credentials");
  const credentialsPath = path.join(credentialsDir, "kimi-code.json");
  const selectionPath = path.join(stateDir, "enabled-providers.json");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    selectionPath,
    JSON.stringify({ version: 1, providers: selected ? ["kimi-oauth"] : [] }),
    { mode: 0o600 },
  );
  if (credential !== undefined) {
    mkdirSync(credentialsDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      credentialsPath,
      typeof credential === "string" ? credential : JSON.stringify(credential),
      { mode: 0o600 },
    );
  }

  try {
    const result = spawnSync(
      process.execPath,
      [path.join(root, "src", "doctor.mjs"), "--json"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: testRoot,
          USERPROFILE: testRoot,
          CODEX_HOME: path.join(testRoot, "codex"),
          CODEX_BIN: process.execPath,
          KIMI_CODE_HOME: kimiHome,
          MODEL_ROUTER_TARGET: "codex",
          MODEL_ROUTER_STATE_DIR: stateDir,
          MODEL_ROUTER_LAUNCH_AGENTS_DIR: path.join(testRoot, "launch-agents"),
          MODEL_ROUTER_PORT: String(routerPort),
          MODEL_ROUTER_SHOW_ALL_MODELS: "0",
          CODEX_ROUTER_SHOW_ALL_MODELS: "0",
        },
        timeout: 120_000,
      },
    );
    assert.ok(result.stdout, result.stderr);
    const check = JSON.parse(result.stdout).checks.find(({ name }) => name === "Kimi OAuth");
    assert.ok(check, "doctor must include the Kimi OAuth check");
    return check;
  } finally {
    rmSync(credentialsPath, { force: true });
    removeDirectoryIfPresent(credentialsDir);
    removeDirectoryIfPresent(kimiHome);
    rmSync(selectionPath, { force: true });
    removeDirectoryIfPresent(stateDir);
    // Node's Windows profile resolver may create these empty profile
    // directories while doctor probes the Codex account. They are fixture
    // scaffolding, not router state, but must be removed before the temp root
    // can be deleted with the non-recursive cleanup above.
    removeDirectoryIfPresent(path.join(testRoot, "AppData", "Roaming"));
    removeDirectoryIfPresent(path.join(testRoot, "AppData"));
    removeDirectoryIfPresent(testRoot);
  }
}

function fixtures() {
  const now = Math.floor(Date.now() / 1_000);
  return [
    {
      name: "live",
      credential: {
        access_token: "access-value",
        refresh_token: "refresh-value",
        expires_at: now + 3_600,
        expires_in: 3_600,
      },
      status: "ok",
      detail: /credential present/,
    },
    {
      name: "stale",
      credential: {
        access_token: "access-value",
        refresh_token: "refresh-value",
        expires_at: now - 3_600,
        expires_in: 3_600,
      },
      status: "ok",
      detail: /refreshes automatically/,
    },
    {
      name: "missing",
      credential: undefined,
      status: "fail",
      detail: /no credential file/,
      fix: /kimi login/,
    },
    {
      name: "invalid",
      credential: "{ not json",
      status: "fail",
      detail: /not valid JSON/,
      fix: /credential file is invalid/,
    },
    {
      name: "missing token",
      credential: {
        access_token: "access-value",
        expires_at: now + 3_600,
        expires_in: 3_600,
      },
      status: "fail",
      detail: /missing the access or refresh token/,
      fix: /credential file is incomplete/,
    },
    {
      name: "incomplete expiry metadata",
      credential: {
        access_token: "access-value",
        refresh_token: "refresh-value",
        expires_at: now + 3_600,
      },
      status: "fail",
      detail: /missing finite second-based expiry metadata/,
      fix: /credential file is incomplete/,
    },
    {
      name: "revoked tombstone",
      credential: {
        access_token: "",
        refresh_token: "",
        expires_at: 0,
        expires_in: 0,
      },
      status: "fail",
      detail: /session was rejected by Kimi/,
      fix: /session must be re-authorized/,
    },
  ];
}

test("doctor maps every selected Kimi OAuth health state", () => {
  for (const fixture of fixtures()) {
    const check = doctorKimiCheck({ selected: true, credential: fixture.credential });
    assert.equal(check.status, fixture.status, fixture.name);
    assert.match(check.detail, fixture.detail, fixture.name);
    if (fixture.fix) assert.match(check.fix, fixture.fix, fixture.name);
  }
});

test("doctor warns for every unselected Kimi OAuth health state", () => {
  for (const fixture of fixtures()) {
    const check = doctorKimiCheck({ selected: false, credential: fixture.credential });
    assert.equal(check.status, "warn", fixture.name);
    assert.match(check.detail, fixture.detail, fixture.name);
  }
});
