import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const SOURCE = fileURLToPath(new URL("..", import.meta.url));
const MODULE = path.join(SOURCE, "src", "cursor-cloudflare-tunnel.mjs");
const TUNNEL_ID = "11111111-2222-4333-8444-555555555555";

function originCertificate(value) {
  return `-----BEGIN ARGO TUNNEL TOKEN-----\n${Buffer.from(JSON.stringify(value)).toString("base64")}\n-----END ARGO TUNNEL TOKEN-----\n`;
}

test("Cursor hostname discovery uses only the authorized Cloudflare zone and never returns its token", async () => {
  const { discoverCursorTunnelHostname } = await import(pathToFileURL(MODULE));
  let request;
  const hostname = await discoverCursorTunnelHostname({
    environment: { TUNNEL_ORIGIN_CERT: "/fixed/cert.pem" },
    hostname: "test-machine",
    read: (target, encoding) => {
      assert.equal(target, "/fixed/cert.pem");
      assert.equal(encoding, "utf8");
      return originCertificate({
        zoneID: "7b0a4d77dfb881c1a3b7d61ea9443e19",
        accountID: "abcdabcdabcdabcd1234567890abcdef",
        apiToken: "private-cloudflare-token",
      });
    },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        json: async () => ({ success: true, result: { name: "Example.COM" } }),
      };
    },
  });
  assert.equal(request.url, "https://api.cloudflare.com/client/v4/zones/7b0a4d77dfb881c1a3b7d61ea9443e19");
  assert.equal(request.options.headers.Authorization, "Bearer private-cloudflare-token");
  assert.match(hostname, /^codex-router-[0-9a-f]{8}\.example\.com$/);
  assert.doesNotMatch(hostname, /private-cloudflare-token/);
});

test("Cursor hostname discovery fails closed on an invalid Cloudflare authorization", async () => {
  const { discoverCursorTunnelHostname } = await import(pathToFileURL(MODULE));
  let fetched = false;
  await assert.rejects(
    discoverCursorTunnelHostname({
      environment: { TUNNEL_ORIGIN_CERT: "/fixed/cert.pem" },
      read: () => originCertificate({ zoneID: "not-a-zone", apiToken: "secret" }),
      fetchImpl: async () => { fetched = true; },
    }),
    /does not identify a usable domain/,
  );
  assert.equal(fetched, false);
});

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "cursor-tunnel-"));
  const state = path.join(root, "state");
  const cloudflare = path.join(root, "cloudflare");
  const log = path.join(root, "cloudflared.log");
  const binary = path.join(root, "cloudflared");
  mkdirSync(state, { recursive: true });
  mkdirSync(cloudflare, { recursive: true });
  writeFileSync(path.join(cloudflare, "cert.pem"), "test-certificate\n", { mode: 0o600 });
  writeFileSync(binary, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_CLOUDFLARED_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "tunnel" && args[1] === "create") {
  fs.writeFileSync(path.join(process.env.MODEL_ROUTER_CLOUDFLARED_HOME, "${TUNNEL_ID}.json"), "{}", { mode: 0o600 });
  process.stdout.write(JSON.stringify({ id: "${TUNNEL_ID}" }));
} else if (args[0] === "tunnel" && args[1] === "route" && process.env.TEST_FAIL_ROUTE === "1") {
  process.stderr.write("route refused");
  process.exitCode = 1;
}
`, { mode: 0o700 });
  chmodSync(binary, 0o700);
  return {
    root,
    state,
    cloudflare,
    log,
    env: {
      ...process.env,
      MODEL_ROUTER_TARGET: "cursor",
      MODEL_ROUTER_STATE_DIR: state,
      MODEL_ROUTER_CLOUDFLARED_HOME: cloudflare,
      MODEL_ROUTER_CLOUDFLARED_BIN: binary,
      TEST_CLOUDFLARED_LOG: log,
    },
  };
}

function run(env, ...args) {
  return spawnSync(process.execPath, [MODULE, ...args], { cwd: SOURCE, env, encoding: "utf8" });
}

// The cloudflared stand-in is an extensionless `#!/usr/bin/env node` script,
// which only a shebang-honouring platform can spawn: Windows answers ENOENT.
// A .cmd shim is not an alternative, because Node refuses to spawn one without
// `shell: true`. Skip the two tests that actually execute the fake binary; the
// pure-logic tests above still run everywhere.
const SPAWNS_SHEBANG = process.platform !== "win32";

test("managed Cursor tunnel is private, edge-only, and idempotent", { skip: !SPAWNS_SHEBANG }, () => {
  const item = fixture();
  try {
    const first = run(item.env, "setup", "cursor-router.example.com");
    assert.equal(first.status, 0, first.stderr);
    const created = JSON.parse(first.stdout);
    assert.equal(created.origin, "https://cursor-router.example.com");
    assert.equal(created.created, true);

    const configPath = path.join(item.state, "cursor-cloudflared.yml");
    const config = readFileSync(configPath, "utf8");
    assert.match(config, /hostname: "cursor-router\.example\.com"/);
    assert.match(config, /http:\/\/127\.0\.0\.1:4214/);
    assert.match(config, /http_status:404/);
    assert.doesNotMatch(config, /4202|caller-secret|internal-secret/);
    if (process.platform !== "win32") assert.equal(statSync(configPath).mode & 0o777, 0o600);

    const second = run(item.env, "setup", "cursor-router.example.com");
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).created, false);
    const calls = readFileSync(item.log, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(calls.filter((args) => args[1] === "create").length, 1);
    assert.equal(calls.filter((args) => args[1] === "route").length, 1);

    const spec = run(item.env, "run-spec");
    assert.equal(spec.status, 0, spec.stderr);
    const parsedSpec = JSON.parse(spec.stdout);
    assert.deepEqual(parsedSpec.args.slice(-2), ["run", TUNNEL_ID]);
    assert.ok(parsedSpec.args.includes(configPath));
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("managed Cursor tunnel rolls back the exact new tunnel when DNS routing fails", { skip: !SPAWNS_SHEBANG }, () => {
  const item = fixture();
  try {
    const result = run({ ...item.env, TEST_FAIL_ROUTE: "1" }, "setup", "cursor-router.example.com");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /route refused/);
    const calls = readFileSync(item.log, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(calls.some((args) => args[1] === "delete" && args.includes(TUNNEL_ID)), true);
    assert.equal(run(item.env, "status").stdout.includes('"configured": false'), true);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});
