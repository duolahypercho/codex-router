import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  if ((request.url || "").startsWith("/crash")) {
    response.writeHead(200).end("crashing");
    // Exactly what LiteLLM did: the process ends, mid-request, with code 1.
    setTimeout(() => process.exit(1), 10);
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

function waitFor(readErrors, pattern, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = setInterval(() => {
      if (pattern.test(readErrors())) {
        clearInterval(poll);
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        clearInterval(poll);
        reject(new Error(`never saw ${pattern}; stderr so far:\n${readErrors()}`));
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

  try {
    await waitFor(() => errors, /\[codex-router\] ready \(authenticated loopback endpoint\)/);
    assert.equal((await get(`http://127.0.0.1:${routerPort}/health`)).status, 200, errors);

    // Kill the gateway the way a bad upstream response did.
    await get(`http://127.0.0.1:${gatewayPort}/crash`);

    await waitFor(
      () => errors,
      /\[codex-router\] LiteLLM gateway exited \(code=1, signal=null\); restarting in 50 ms \(restart 1 of 5\)/,
    );
    assert.match(errors, /The router stays up/);
    await waitFor(() => errors, /\[codex-router\] LiteLLM gateway is healthy again after 1 restart\(s\)\./);

    assert.equal(exited, undefined, `the service exited when the gateway crashed:\n${errors}`);
    const health = await get(`http://127.0.0.1:${routerPort}/health`);
    assert.equal(health.status, 200, `the router stopped serving:\n${errors}`);
    assert.doesNotMatch(errors, /gateway-restart-internal-key-with-sufficient-length/);
    assert.doesNotMatch(errors, /gateway-restart-caller-key-with-sufficient-length/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(rootDir, { recursive: true, force: true });
  }
});
