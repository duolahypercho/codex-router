import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { freePort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Issue #261: LiteLLM's exception mapping raised out of the request handler on
// an upstream 429 and the proxy exited 1. start.mjs raced every child's exit,
// so that single bad response took the router and all three forwarders down and
// every client saw a bare "Connection error" from then on.
//
// The gateway here is a stand-in that answers the liveliness probe and exits 1
// when asked, which is the only part of LiteLLM's behaviour this has to
// reproduce -- the defect was never in what killed the gateway, it was in what
// the service did afterwards.
//
// It is reached through a launcher rather than directly because the real
// `MODEL_ROUTER_LITELLM_BIN` is a launcher: `.venv/bin/litellm` on POSIX and
// `.venv\Scripts\litellm.exe` on Windows. A `.cmd` is the closest a test can
// get to the second without shipping a PE binary, and Node refuses to spawn one
// without a shell (CVE-2024-27980) -- which is exactly the gap
// `spawnableCommand` closes in `start.mjs`, so exercising it here is the point
// rather than an accident.
function writeFakeGateway(directory, script) {
  const windows = process.platform === "win32";
  const target = path.join(directory, windows ? "fake-gateway.cmd" : "fake-gateway");
  writeFileSync(
    target,
    windows
      ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
      : `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    script,
    `import { createServer } from "node:http";
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
createServer((request, response) => {
  const url = request.url || "";
  if (url.startsWith("/crash") || url.startsWith("/quit")) {
    response.writeHead(200).end("stopping");
    // Exactly what LiteLLM did: the process ends, mid-request, with code 1.
    // /quit is the teardown door -- on Windows the launcher is a batch shim, so
    // the service holds the cmd.exe hop rather than this process, and a signal
    // to the hop would leave this one alive holding the port.
    setTimeout(() => process.exit(url.startsWith("/quit") ? 0 : 1), 10);
    return;
  }
  response.writeHead(200, { "content-type": "application/json" }).end('{"status":"healthy"}');
}).listen(port, "127.0.0.1");
`,
    { mode: 0o600 },
  );
  return target;
}

async function get(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    return { status: response.status, body: await response.text() };
  } catch (error) {
    return { status: 0, body: error instanceof Error ? error.message : String(error) };
  }
}

// Fails as soon as the service exits rather than waiting out the budget: a
// startup that died in the first second used to be reported sixty seconds later
// as "never saw ..." with no exit status, which is a mystery rather than a
// diagnosis. The exit status is what names the failure -- a Windows `spawn
// EINVAL` on the batch launcher reads nothing like a health-probe timeout.
function waitFor(readErrors, readExit, pattern, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = setInterval(() => {
      const errors = readErrors();
      if (pattern.test(errors)) {
        clearInterval(poll);
        resolve();
        return;
      }
      const exit = readExit();
      if (exit) {
        clearInterval(poll);
        reject(
          new Error(
            `the service exited (code=${String(exit.code)}, signal=${String(exit.signal)}) ` +
              `before ${pattern}; stderr:\n${errors || "(the service produced no output at all)"}`,
          ),
        );
        return;
      }
      if (Date.now() >= deadline) {
        clearInterval(poll);
        reject(
          new Error(
            `never saw ${pattern} in ${timeoutMs} ms; the service is still running; ` +
              `stderr:\n${errors || "(the service produced no output at all)"}`,
          ),
        );
      }
    }, 100);
  });
}

test("a gateway that dies mid-request is restarted and the router keeps serving", { timeout: 180_000 }, async () => {
  const ports = await Promise.all(Array.from({ length: 5 }, () => freePort()));
  assert.equal(new Set(ports).size, ports.length);
  const [routerPort, gatewayPort, oauthPort, apiPort, grokOauthPort] = ports;
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "model-router-gateway-restart-"));
  const stateDir = path.join(rootDir, "state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const callerKey = "gateway-restart-caller-key-with-sufficient-length";
  writeFileSync(path.join(stateDir, "internal-secret"), "gateway-restart-internal-key-with-sufficient-length\n", { mode: 0o600 });
  writeFileSync(path.join(stateDir, "caller-secret"), `${callerKey}\n`, { mode: 0o600 });
  const gatewayBin = writeFakeGateway(rootDir, path.join(rootDir, "fake-gateway.mjs"));

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
      MODEL_ROUTER_LITELLM_BIN: gatewayBin,
      // Keep the backoff out of the run time; the sequencing is what matters.
      CODEX_ROUTER_GATEWAY_RESTART_BACKOFF_MS: "50",
      CODEX_ROUTER_HOME: rootDir,
      CODEX_HOME: rootDir,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  let exited;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  child.once("exit", (code, signal) => {
    exited = { code, signal };
  });

  const readExit = () => exited;
  try {
    await waitFor(() => errors, readExit, /\[codex-router\] ready \(authenticated loopback endpoint\)/);
    assert.equal((await get(`http://127.0.0.1:${routerPort}/health`)).status, 200, errors);

    // Kill the gateway the way a bad upstream response did.
    await get(`http://127.0.0.1:${gatewayPort}/crash`);

    await waitFor(
      () => errors,
      readExit,
      /\[codex-router\] LiteLLM gateway exited \(code=1, signal=null\); restarting in 50 ms \(restart 1 of 5\)/,
    );
    assert.match(errors, /The router stays up/);
    await waitFor(
      () => errors,
      readExit,
      /\[codex-router\] LiteLLM gateway is healthy again after 1 restart\(s\)\./,
    );

    assert.equal(exited, undefined, `the service exited when the gateway crashed:\n${errors}`);
    const health = await get(`http://127.0.0.1:${routerPort}/health`);
    assert.equal(health.status, 200, `the router stopped serving:\n${errors}`);
    assert.doesNotMatch(errors, /gateway-restart-internal-key-with-sufficient-length/);
    assert.doesNotMatch(errors, /gateway-restart-caller-key-with-sufficient-length/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    // On Windows the service holds the cmd.exe hop, not the gateway behind it,
    // and killing the hop orphans the stand-in -- which would keep the port and
    // a lock on the temp directory. Ask it to leave through its own door; by now
    // nothing is left to restart it. Harmless and already-dead on POSIX.
    await get(`http://127.0.0.1:${gatewayPort}/quit`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// The Windows half of the launch cannot be exercised on POSIX -- the batch shim
// is pass-through here -- so the wiring is asserted directly. Without it, a
// refactor that spawned the gateway straight from `spawn()` again would go green
// on ubuntu and macos and fail only on the Windows job, which is how this was
// found. `spawnableCommand`'s own conversion is covered by
// test/spawnable-command.test.mjs.
test("start.mjs launches every child through the Windows-safe spawn helper", () => {
  const source = readFileSync(path.join(root, "src", "start.mjs"), "utf8");
  assert.match(source, /import \{ spawnableCommand \} from "\.\/spawnable-command\.mjs";/);
  const runBody = /function run\([\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.match(runBody, /spawnableCommand\(command, args\)/);
  assert.match(runBody, /spawn\(spawnable\.command, spawnable\.args,/);
  assert.match(runBody, /\.\.\.spawnable\.options,/);
  // A bare `spawn(command, args` in the launcher is the exact shape that
  // answers a `.cmd` launcher with EINVAL and takes the service down.
  assert.doesNotMatch(runBody, /spawn\(command, args/);
});
