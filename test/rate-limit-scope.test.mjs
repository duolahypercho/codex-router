import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { userModelEntry } from "../src/user-models.mjs";
import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL_KEY = "rate-limit-scope-internal-key-with-sufficient-length";

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: server.address().port };
}

async function waitForHealth(base, headers, child, errors) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`forwarder exited: ${errors()}`);
    try {
      if ((await fetch(`${base}/health`, { headers })).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`forwarder never became healthy: ${errors()}`);
}

// opencode Zen shares Go's credential and selection toggle but bills at its own
// endpoint, so it is the one provider whose cooldown scope is not its canonical
// parent. Keying the harvested headers by the parent filed each plan's window
// under the other and left Zen's own id empty for every reader.
test("a separately billed variant's quota headers do not overwrite its parent's", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "rate-limit-scope-"));
  const stateDir = path.join(directory, "state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const userModelsFile = path.join(directory, "user-models.json");
  const limitsPath = path.join(stateDir, "rate-limits.json");

  // The Go plan's own window, harvested from an earlier Go response.
  writeFileSync(
    limitsPath,
    `${JSON.stringify({
      "opencode-go": {
        requests: { limit: 1000, remaining: 900 },
        observedAt: "2026-09-01T00:00:00.000Z",
      },
    }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  const upstream = await listen((request, response) => {
    const body = Buffer.from(JSON.stringify({
      id: "chatcmpl-zen-1",
      object: "chat.completion",
      model: "zen-test-model",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    }), "utf8");
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": String(body.length),
      "x-ratelimit-limit-requests": "50",
      "x-ratelimit-remaining-requests": "7",
      "x-ratelimit-reset-requests": "60s",
    });
    response.end(body);
  });

  const model = userModelEntry({
    providerId: "opencode-zen",
    upstreamId: "zen-test-model",
    priority: 100,
  });
  writeFileSync(userModelsFile, `${JSON.stringify({ version: 1, models: [model] }, null, 2)}\n`);

  const forwarderPort = await openPort();
  const child = spawn(process.execPath, [path.join(root, "src", "api-forwarder.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_TARGET: "codex",
      MODEL_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
      MODEL_ROUTER_API_PORT: String(forwarderPort),
      MODEL_ROUTER_STATE_DIR: stateDir,
      MODEL_ROUTER_USER_MODELS: userModelsFile,
      MODEL_ROUTER_QUIET: "1",
      OPENCODE_ZEN_BASE_URL: `http://127.0.0.1:${upstream.port}`,
      OPENCODE_API_KEY: "zen-test-key",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const base = `http://127.0.0.1:${forwarderPort}`;
  const headers = { Authorization: `Bearer ${INTERNAL_KEY}`, "Content-Type": "application/json" };
  try {
    await waitForHealth(base, headers, child, () => stderr);
    const answer = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: model.gatewayModel,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const answerBody = await answer.text();
    assert.equal(answer.status, 200, `zen turn failed: ${answerBody} ${stderr}`);

    // Limits are persisted after the body is piped, so give that write a moment.
    const deadline = Date.now() + 2_000;
    let limits;
    do {
      limits = JSON.parse(readFileSync(limitsPath, "utf8"));
      if (limits["opencode-zen"] || limits["opencode-go"]?.requests?.remaining !== 900) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (Date.now() < deadline);

    // Zen's window is filed under the id that produced it, so every reader --
    // all of which key by cooldown scope -- can find it.
    assert.equal(limits["opencode-zen"]?.requests?.remaining, 7);
    assert.equal(limits["opencode-zen"]?.requests?.limit, 50);
    // And the Go plan's separately billed window is still the Go plan's.
    assert.equal(limits["opencode-go"]?.requests?.remaining, 900);
    assert.equal(limits["opencode-go"]?.requests?.limit, 1000);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await new Promise((resolve) => upstream.server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
