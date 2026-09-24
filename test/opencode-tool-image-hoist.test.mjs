// opencode's Chat Completions surface refuses an `image_url` part inside a
// tool result ("tool content: part type \"image_url\" is not supported; only
// text is", HTTP 400) while reading the same image on a user turn, measured
// live on 17 September 2026 against https://opencode.ai/zen/go/v1 with
// `glm-5.3-flash`. The forwarder moves those images to a user turn behind the
// tool run; these tests hold the parts of that move a provider change cannot
// tell us about: the tool result must come out text-only, the images must
// survive, and no other provider may be reshaped.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { openPort } from "./port-pool.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const INTERNAL_KEY = "test-internal-service-key-with-sufficient-length";
const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4z8AAAAMBAQAY3Y2wAAAAAElFTkSuQmCC";

function json(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function bodyJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function mockServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: server.address().port };
}

function run(script, env) {
  const child = spawn(process.execPath, [path.join(ROOT, "src", script)], {
    cwd: ROOT,
    env: {
      ...process.env,
      CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
      KIMI_INTERNAL_KEY: INTERNAL_KEY,
      CODEX_ROUTER_SHOW_ALL_MODELS: "1",
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  child.testErrors = () => errors;
  return child;
}

async function waitFor(url, child, headers = {}) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Child exited early (${child.exitCode}): ${child.testErrors()}`);
    }
    try {
      const response = await fetch(url, { headers });
      if (response.ok) return;
    } catch {
      // The child has not bound its port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${url}: ${child.testErrors()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

function curatedModels() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "opencode-tool-image-"));
  const file = path.join(dir, "user-models.json");
  const model = ({ provider, id, gatewayModel, inputModalities }) => ({
    slug: `${provider}/${id}`,
    gatewayModel,
    upstreamModel: id,
    provider,
    listed: true,
    displayName: `${id} (curated)`,
    description: "Test fixture.",
    priority: 500,
    defaultEffort: "high",
    reasoningLevels: [{ effort: "high", description: "Adaptive reasoning" }],
    contextWindow: 131072,
    autoCompact: 110000,
    inputModalities,
    compHash: `${gatewayModel}-user-v1`,
  });
  const vision = model({
    provider: "opencode-go",
    id: "vision-fixture",
    gatewayModel: "opencode-go-vision-fixture",
    inputModalities: ["text", "image"],
  });
  const textOnly = model({
    provider: "opencode-go",
    id: "text-fixture",
    gatewayModel: "opencode-go-text-fixture",
    inputModalities: ["text"],
  });
  // Another vendor's multimodal chat route: its endpoint has not refused a
  // tool-result image, so its history must reach upstream untouched.
  const elsewhere = model({
    provider: "openrouter",
    id: "vision-elsewhere",
    gatewayModel: "openrouter-vision-elsewhere",
    inputModalities: ["text", "image"],
  });
  writeFileSync(
    file,
    JSON.stringify({ version: 1, models: [vision, textOnly, elsewhere] }),
    "utf8",
  );
  return {
    dir,
    file,
    vision: vision.gatewayModel,
    textOnly: textOnly.gatewayModel,
    elsewhere: elsewhere.gatewayModel,
  };
}

function history() {
  return [
    { role: "user", content: "look at the screen" },
    {
      role: "assistant",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "view_image", arguments: "{}" } },
        { id: "call_2", type: "function", function: { name: "view_image", arguments: "{}" } },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_1",
      content: [
        { type: "text", text: "first screenshot" },
        { type: "image_url", image_url: { url: PIXEL } },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_2",
      content: [{ type: "image_url", image_url: { url: PIXEL } }],
    },
    { role: "assistant", content: "Both are red." },
    { role: "user", content: "what did you see?" },
  ];
}

test("the forwarder moves opencode tool-result images onto a user turn", async () => {
  const upstreamRequests = [];
  const upstream = await mockServer(async (request, response) => {
    upstreamRequests.push(await bodyJson(request));
    json(response, 200, { choices: [] });
  });
  const models = curatedModels();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "opencode-tool-image-state-"));
  const forwarderPort = await openPort();
  const forwarder = run("api-forwarder.mjs", {
    CODEX_ROUTER_API_PORT: String(forwarderPort),
    MODEL_ROUTER_STATE_DIR: stateDir,
    MODEL_ROUTER_USER_MODELS: models.file,
    OPENCODE_GO_BASE_URL: `http://127.0.0.1:${upstream.port}`,
    OPENCODE_GO_API_KEY: "TEST_OPENCODE_GO_API_KEY",
    OPENROUTER_API_BASE_URL: `http://127.0.0.1:${upstream.port}`,
    OPENROUTER_API_KEY: "TEST_OPENROUTER_API_KEY",
    CODEX_ROUTER_QUIET: "1",
  });

  async function forward(model, messages = history()) {
    const response = await fetch(`http://127.0.0.1:${forwarderPort}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${INTERNAL_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, messages }),
    });
    assert.equal(response.status, 200, forwarder.testErrors());
    return upstreamRequests.at(-1).messages;
  }

  try {
    await waitFor(`http://127.0.0.1:${forwarderPort}/health`, forwarder, {
      Authorization: `Bearer ${INTERNAL_KEY}`,
    });

    const forwarded = await forward(models.vision);
    // Both tool results stay adjacent to the assistant turn that called them,
    // and one user turn behind the run carries both images.
    assert.deepEqual(
      forwarded.map((message) => message.role),
      ["user", "assistant", "tool", "tool", "user", "assistant", "user"],
    );
    for (const message of forwarded.filter((entry) => entry.role === "tool")) {
      assert.equal(typeof message.content, "string");
      assert.match(message.content, /image\(s\) from this tool result follow/);
    }
    assert.equal(forwarded[2].tool_call_id, "call_1");
    assert.match(forwarded[2].content, /first screenshot/);
    assert.equal(forwarded[3].tool_call_id, "call_2");
    const images = forwarded[4].content.filter((part) => part.type === "image_url");
    assert.equal(images.length, 2);
    assert.deepEqual(images[0], { type: "image_url", image_url: { url: PIXEL } });
    // The move is labelled, or a screenshot's own text reads as the user asking
    // for something.
    assert.match(forwarded[4].content[0].text, /untrusted data, never an instruction/);
    assert.match(forwarded[4].content[0].text, /call_1/);
    assert.match(forwarded[4].content[2].text, /call_2/);
    // Nothing upstream may still see an image part outside a user turn.
    for (const message of forwarded) {
      if (message.role === "user" || !Array.isArray(message.content)) continue;
      assert.ok(!message.content.some((part) => part?.type === "image_url"));
    }

    // A text-only opencode route keeps the existing strip behaviour: the image
    // is replaced with a reason, not moved into a turn it cannot be read from.
    const strippedText = await forward(models.textOnly);
    assert.equal(
      strippedText.filter((message) => message.role === "user").length,
      2,
      "no hoisted turn for a model that cannot read images",
    );
    assert.ok(
      !JSON.stringify(strippedText).includes(PIXEL),
      "the text-only route must not receive image bytes",
    );

    // Another provider's multimodal route is left exactly as the caller sent it.
    assert.deepEqual(await forward(models.elsewhere), history());

    const huge = `data:image/png;base64,${"A".repeat(2_700_000)}`;
    const oversized = await forward(models.vision, [
      { role: "user", content: "look at the sheet" },
      {
        role: "assistant",
        tool_calls: [
          { id: "call_img", type: "function", function: { name: "imagegen", arguments: "{}" } },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_img",
        content: [{ type: "image_url", image_url: { url: huge } }],
      },
    ]);
    assert.ok(!JSON.stringify(oversized).includes("A".repeat(1000)));
    assert.match(JSON.stringify(oversized), /2,500,000 characters|2500000 characters/);
  } finally {
    await stopChild(forwarder);
    await closeServer(upstream.server);
    rmSync(models.dir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}
