import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { freePort } from "./port-pool.mjs";
import { userModelEntry } from "../src/user-models.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Devin ships catalog-only, so an unconfigured install has no `devin-cli` model
// and start.mjs must not spend a process or a port on its forwarder. The gate
// is the curated model rather than the stored credential, because a curated
// model is exactly what puts a `DEVIN_CLI_FORWARD_BASE_URL` route in the
// gateway config -- gate and route are computed from the same MODELS array on
// the same boot, so a live route can never point at a port nobody bound.
//
// Every case here drives the real start.mjs. `MODEL_ROUTER_LITELLM_BIN` points
// at node, which exits immediately when handed LiteLLM's arguments, so startup
// always fails at the gateway -- the stage *after* the forwarders. That makes
// "reached the gateway" a positive assertion that the forwarder stage
// completed, and it is the same trick startup-cleanup.test.mjs uses.

// See startup-cleanup.test.mjs: progress, not elapsed time, separates a slow
// machine from a stuck one, so the watchdog fires only on silence.
const STARTUP_STALL_MS = 30_000;

function waitForStartupExit(child, readErrors) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let lastOutput = started;
    const onProgress = () => {
      lastOutput = Date.now();
    };
    child.stderr.on("data", onProgress);
    const finish = () => {
      clearInterval(watchdog);
      child.stderr.off("data", onProgress);
    };
    const watchdog = setInterval(() => {
      const idleMs = Date.now() - lastOutput;
      if (idleMs < STARTUP_STALL_MS) return;
      finish();
      reject(
        new Error(
          `startup stalled: no output for ${idleMs} ms after waiting ${Date.now() - started} ms in total; stderr so far:\n${readErrors()}`,
        ),
      );
    }, 250);
    child.once("exit", (code, signal) => {
      finish();
      resolve({ code, signal });
    });
  });
}

// Holds a port for the duration of a test so a forwarder that tries to bind it
// fails with EADDRINUSE. Occupying the port is how "nothing was spawned" is
// proved positively: an unspawned forwarder cannot collide with the squatter,
// so startup walks past it to the gateway.
async function squat(port) {
  const server = net.createServer();
  // Hang up on anything that connects. A squatter that accepted and held the
  // socket would leave the health probe waiting for a response that never came
  // and would keep `server.close()` from ever completing; destroying the socket
  // makes a probe of this port fail the way a dead listener does, which is what
  // the port being unavailable is meant to look like.
  server.on("connection", (socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    listening: () => server.listening,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.unref();
      }),
  };
}

async function runStartup({ curatedDevinModel = false, occupyDevinPort = false } = {}) {
  const ports = await Promise.all(Array.from({ length: 6 }, () => freePort()));
  assert.equal(new Set(ports).size, ports.length);
  const [routerPort, gatewayPort, oauthPort, apiPort, grokOauthPort, devinPort] = ports;

  const rootDir = mkdtempSync(path.join(os.tmpdir(), "model-router-devin-gate-"));
  const stateDir = path.join(rootDir, "state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(stateDir, "internal-secret"), "devin-gate-internal-key-with-sufficient-length\n", {
    mode: 0o600,
  });
  writeFileSync(path.join(stateDir, "caller-secret"), "devin-gate-caller-key-with-sufficient-length\n", {
    mode: 0o600,
  });
  if (curatedDevinModel) {
    // Built through the same helper `bin/curate-models` uses, so this stays a
    // real curated entry rather than a hand-written shape that could drift.
    writeFileSync(
      path.join(stateDir, "user-models.json"),
      JSON.stringify(
        {
          version: 1,
          models: [
            userModelEntry({ providerId: "devin-cli", upstreamId: "gate-test-model", priority: 900 }),
          ],
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }

  const squatter = occupyDevinPort ? await squat(devinPort) : undefined;

  const child = spawn(process.execPath, [path.join(root, "src", "start.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_TARGET: "codex",
      MODEL_ROUTER_STATE_DIR: stateDir,
      MODEL_ROUTER_PORT: String(routerPort),
      MODEL_ROUTER_GATEWAY_PORT: String(gatewayPort),
      MODEL_ROUTER_OAUTH_PORT: String(oauthPort),
      MODEL_ROUTER_API_PORT: String(apiPort),
      MODEL_ROUTER_GROK_OAUTH_PORT: String(grokOauthPort),
      MODEL_ROUTER_DEVIN_CLI_PORT: String(devinPort),
      MODEL_ROUTER_LITELLM_BIN: process.execPath,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });

  try {
    const exit = await waitForStartupExit(child, () => errors);
    // Read the squatter before the teardown below closes it: the caller runs
    // after this function returns, by which point it is gone either way.
    return { exit, errors, devinPort, squatterHeldPort: squatter ? squatter.listening() : undefined };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (squatter) await squatter.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
}

test(
  "an install with no curated Devin model spawns no forwarder and binds no port",
  { timeout: 120_000 },
  async () => {
    // The Devin port is held by this test. A forwarder that was spawned would
    // die on EADDRINUSE and abort startup by name, so reaching the gateway
    // failure instead is proof that nothing was spawned and nothing was bound.
    const { exit, errors, squatterHeldPort } = await runStartup({ occupyDevinPort: true });

    assert.doesNotMatch(errors, /\[devin-cli\]/, errors);
    assert.doesNotMatch(errors, /Devin CLI forwarder/, errors);
    assert.match(errors, /startup failed: LiteLLM gateway exited before becoming healthy\./, errors);
    assert.equal(exit.code, 1, errors);
    assert.equal(squatterHeldPort, true, "something took the Devin port from this test");
  },
);

test(
  "a curated Devin model spawns the forwarder and waits on its health",
  { timeout: 120_000 },
  async () => {
    const { exit, errors } = await runStartup({ curatedDevinModel: true });

    // The forwarder announces itself on stderr when its listener is up, and
    // startup only reaches the gateway once every forwarder health wait has
    // resolved -- so both halves of "spawned and waited on" are asserted.
    assert.match(errors, /\[devin-cli\] listening/, errors);
    assert.match(errors, /startup failed: LiteLLM gateway exited before becoming healthy\./, errors);
    assert.equal(exit.code, 1, errors);
  },
);

test(
  "a curated Devin model that cannot bind its port still fails startup by name",
  { timeout: 120_000 },
  async () => {
    // Gating must not turn a real failure into a silent skip: when the provider
    // is routed, an unbindable forwarder aborts startup naming itself, exactly
    // as it did when the spawn was unconditional.
    const { exit, errors } = await runStartup({ curatedDevinModel: true, occupyDevinPort: true });

    assert.match(errors, /startup failed: Devin CLI forwarder exited before becoming healthy\./, errors);
    assert.doesNotMatch(errors, /LiteLLM gateway exited before becoming healthy/, errors);
    assert.equal(exit.code, 1, errors);
  },
);

test("neither secret is echoed while the gate is being decided", { timeout: 120_000 }, async () => {
  const { errors } = await runStartup({ curatedDevinModel: true });
  assert.doesNotMatch(errors, /devin-gate-internal-key-with-sufficient-length/);
  assert.doesNotMatch(errors, /devin-gate-caller-key-with-sufficient-length/);
});
