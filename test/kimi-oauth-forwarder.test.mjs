import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const internalKey = "test-kimi-internal-service-key-with-sufficient-length";

async function openPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

test("Kimi OAuth forwarder returns an actionable 401 when login is required", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "kimi-oauth-forwarder-"));
  const devicePath = path.join(home, "device_id");
  writeFileSync(devicePath, "test-device-id\n", { mode: 0o600 });
  const port = await openPort();
  const child = spawn(process.execPath, [path.join(root, "src", "oauth-forwarder.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_TARGET: "cursor",
      MODEL_ROUTER_INTERNAL_KEY: internalKey,
      MODEL_ROUTER_OAUTH_PORT: String(port),
      KIMI_CODE_HOME: home,
      KIMI_CODE_BASE_URL: "http://127.0.0.1:1/v1",
      MODEL_ROUTER_QUIET: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  let errors = "";
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const base = `http://127.0.0.1:${port}`;
  const headers = {
    Authorization: `Bearer ${internalKey}`,
    "Content-Type": "application/json",
  };

  try {
    const deadline = Date.now() + 5_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`forwarder exited: ${errors}`);
      try {
        const health = await fetch(`${base}/health`, { headers });
        if (health.ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.equal(ready, true, errors);
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "k3", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error.type, "authentication_error");
    assert.match(body.error.message, /kimi login/);
  } finally {
    await stop(child);
    unlinkSync(devicePath);
    rmdirSync(home);
  }
});
