import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { buildLoginFreeCatalog, buildMergedCatalog } from "../src/catalog.mjs";
import {
  NATIVE_CONTEXT_VARIANTS,
  NATIVE_CONTEXT_VARIANT_SLUGS,
  nativeContextVariantBase,
  withNativeContextVariants,
} from "../src/native-context-variants.mjs";
import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL_KEY = "test-internal-service-key-with-sufficient-length";
const CALLER_KEY = "test-router-caller-capability-with-sufficient-length";

const pickerStateDir = mkdtempSync(path.join(os.tmpdir(), "context-variant-picker-"));
process.env.MODEL_ROUTER_MODEL_PICKER_STATE = path.join(pickerStateDir, "model-picker.json");
const {
  MODEL_PICKER_STATE_PATH,
  readHiddenModels,
  seedModelsHidden,
  setAllModelsVisible,
  setModelVisible,
} = await import("../src/model-picker-state.mjs");

// The shape the capture actually has, trimmed to the fields the derivation
// reads or must carry through untouched.
const sol = {
  slug: "gpt-5.6-sol",
  display_name: "GPT-5.6-Sol",
  description: "Latest frontier agentic coding model.",
  visibility: "list",
  priority: 1,
  context_window: 272_000,
  max_context_window: 272_000,
  effective_context_window_percent: 95,
  comp_hash: "3000",
  multi_agent_version: "v2",
  input_modalities: ["text", "image"],
  base_instructions: "You are Codex, a coding agent based on GPT-5.",
  supported_reasoning_levels: [{ effort: "low", description: "Fast" }],
  availability_nux: { message: "Introducing GPT-5.6-Sol" },
};

const spark = { ...sol, slug: "gpt-5.3-codex-spark", context_window: 128_000 };

function variantOf(models, slug = "gpt-5.6-sol-1m") {
  return models.find((model) => model.slug === slug);
}

test("the variant is its base model, published at the window OpenAI documents", () => {
  const [variant] = NATIVE_CONTEXT_VARIANTS;
  const models = withNativeContextVariants([sol, spark]);

  assert.equal(models.length, 3, "the capture keeps every model it arrived with");
  const derived = variantOf(models);
  assert.equal(derived.context_window, 1_000_000);
  assert.equal(derived.max_context_window, 1_000_000);
  // Compaction has to start below the window, or the first turn that reaches
  // the limit has nowhere to land.
  assert.ok(derived.auto_compact_token_limit < derived.context_window);
  assert.equal(derived.auto_compact_token_limit, variant.autoCompact);
  assert.equal(derived.display_name, variant.displayName);
  assert.notEqual(derived.display_name, sol.display_name);

  // Everything else is the base model, unchanged: same instructions, same
  // capabilities, same compaction prompt. A variant that drifted here would be
  // a second model pretending to be the first.
  assert.equal(derived.base_instructions, sol.base_instructions);
  assert.equal(derived.comp_hash, sol.comp_hash);
  assert.equal(derived.multi_agent_version, sol.multi_agent_version);
  assert.deepEqual(derived.input_modalities, sol.input_modalities);
  assert.deepEqual(derived.supported_reasoning_levels, sol.supported_reasoning_levels);

  // The base model owns its announcement. Both cards firing would announce one
  // model twice.
  assert.equal(derived.availability_nux, null);
  assert.equal(derived.upgrade, null);

  // And the base is left exactly as captured.
  assert.equal(variantOf(models, "gpt-5.6-sol").context_window, 272_000);
});

test("no base, no variant: a row whose upstream this account cannot pick never appears", () => {
  assert.deepEqual(withNativeContextVariants([spark]), [spark]);
  assert.deepEqual(withNativeContextVariants([]), []);
  assert.deepEqual(withNativeContextVariants(undefined), []);
  // A capture that withdrew the model to "hide" is the signed-out and
  // deprecated case both: the base is present but unpickable.
  assert.deepEqual(withNativeContextVariants([{ ...sol, visibility: "hide" }]), [
    { ...sol, visibility: "hide" },
  ]);
});

test("deriving twice adds one variant, not two", () => {
  const once = withNativeContextVariants([sol]);
  assert.deepEqual(withNativeContextVariants(once), once);
});

test("a login-free install gets no variants, because its native slugs are allowlisted", () => {
  // Signed-out Codex surfaces only display native slugs from a server-supplied
  // allowlist, and republish external models under them. A synthesized slug
  // would take one of those slots and then never be displayed, costing a real
  // model its own slot.
  const models = withNativeContextVariants([sol], { enabled: false });
  assert.deepEqual(models, [sol]);

  const external = [
    {
      slug: "kimi-oauth/k3",
      displayName: "Kimi K3",
      priority: 1,
      contextWindow: 256_000,
      reasoningLevels: [{ effort: "high", description: "Deep" }],
      inputModalities: ["text"],
      provider: undefined,
    },
  ];
  const { aliases } = buildLoginFreeCatalog({ models }, external);
  assert.deepEqual(Object.keys(aliases), ["gpt-5.6-sol"]);
});

test("the router knows which upstream model a variant slug stands for", () => {
  assert.equal(nativeContextVariantBase("gpt-5.6-sol-1m"), "gpt-5.6-sol");
  // Every real model must answer undefined, or the rewrite would redirect a
  // turn the operator did pick.
  assert.equal(nativeContextVariantBase("gpt-5.6-sol"), undefined);
  assert.equal(nativeContextVariantBase("kimi-oauth/k3"), undefined);
  assert.equal(nativeContextVariantBase(undefined), undefined);
  assert.equal(nativeContextVariantBase(""), undefined);
  for (const variant of NATIVE_CONTEXT_VARIANTS) {
    assert.equal(nativeContextVariantBase(variant.slug), variant.baseSlug);
    assert.notEqual(variant.slug, variant.baseSlug);
  }
});

test("the variant reaches the catalog Codex reads, alongside its base", () => {
  const merged = buildMergedCatalog({ models: withNativeContextVariants([sol, spark]) }, []);
  const slugs = merged.map((model) => model.slug);
  assert.ok(slugs.includes("gpt-5.6-sol"));
  assert.ok(slugs.includes("gpt-5.6-sol-1m"));
  assert.equal(variantOf(merged).context_window, 1_000_000);
});

test("a variant arrives switched off, and stays off until the operator says otherwise", () => {
  rmSync(MODEL_PICKER_STATE_PATH, { force: true });
  seedModelsHidden(NATIVE_CONTEXT_VARIANT_SLUGS);
  assert.deepEqual([...readHiddenModels()].sort(), [...NATIVE_CONTEXT_VARIANT_SLUGS].sort());

  // Switched on in the tray, then a catalog rebuild reapplies the default:
  // the choice has to survive, or an update quietly switches it back off.
  setModelVisible("gpt-5.6-sol-1m", true);
  seedModelsHidden(NATIVE_CONTEXT_VARIANT_SLUGS);
  assert.equal(readHiddenModels().has("gpt-5.6-sol-1m"), false);

  // Switched off again by hand: the same rule, in the other direction.
  setModelVisible("gpt-5.6-sol-1m", false);
  seedModelsHidden(NATIVE_CONTEXT_VARIANT_SLUGS);
  assert.equal(readHiddenModels().has("gpt-5.6-sol-1m"), true);
});

test("seeding leaves every other picker choice alone", () => {
  rmSync(MODEL_PICKER_STATE_PATH, { force: true });
  setModelVisible("kimi-oauth/k3", false);
  seedModelsHidden(NATIVE_CONTEXT_VARIANT_SLUGS);
  assert.equal(readHiddenModels().has("kimi-oauth/k3"), true);

  // "Show all" is an explicit decision about every listed model, this one
  // included, so a later rebuild must not undo it.
  setAllModelsVisible(["kimi-oauth/k3", "gpt-5.6-sol", "gpt-5.6-sol-1m"], true);
  seedModelsHidden(NATIVE_CONTEXT_VARIANT_SLUGS);
  assert.deepEqual([...readHiddenModels()], []);
});

test("state written by an older install keeps its hidden models when the default lands", () => {
  rmSync(MODEL_PICKER_STATE_PATH, { force: true });
  // Exactly what a pre-upgrade `model-picker.json` looks like: no record of
  // which models have ever been decided.
  setModelVisible("kimi-oauth/k3", false);
  const legacy = JSON.parse(readFileSync(MODEL_PICKER_STATE_PATH, "utf8"));
  delete legacy.seeded;
  writeFileSync(MODEL_PICKER_STATE_PATH, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

  seedModelsHidden(NATIVE_CONTEXT_VARIANT_SLUGS);
  const hidden = readHiddenModels();
  assert.equal(hidden.has("kimi-oauth/k3"), true);
  assert.equal(hidden.has("gpt-5.6-sol-1m"), true);
});

// --- the request path -------------------------------------------------------

function routerBase(port) {
  return callerBaseUrl(port, CALLER_KEY);
}

async function mockServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: server.address().port };
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  const decoded =
    request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(raw) : raw;
  return JSON.parse(decoded.toString("utf8"));
}

function runRouter(env) {
  const child = spawn(process.execPath, [path.join(root, "src", "router.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
      CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
      KIMI_INTERNAL_KEY: INTERNAL_KEY,
      CODEX_ROUTER_QUIET: "1",
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

async function waitFor(url, child) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Child exited early (${child.exitCode}): ${child.testErrors()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not bound yet.
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

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function waitUntil(predicate, message, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

// The whole point of the variant: chatgpt.com has never heard of the slug the
// picker offered, so a turn that reached it unchanged would 400 on every
// message. The operator still has to see the model they picked.
test("a turn on the variant reaches chatgpt.com as the base model", async () => {
  const seen = [];
  const native = await mockServer(async (request, response) => {
    seen.push({ path: request.url, body: await readBody(request) });
    const payload = Buffer.from(JSON.stringify({ id: "resp-1m", output: [] }), "utf8");
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": String(payload.length),
    });
    response.end(payload);
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "context-variant-state-"));
  const routerPort = await openPort();
  const router = runRouter({
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${native.port}/v1`,
    MODEL_ROUTER_STATE_DIR: stateDir,
  });

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const result = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: { Authorization: "Bearer caller", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-sol-1m",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      }),
    });

    const relayed = await result.text();
    assert.equal(result.status, 200, relayed);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].body.model, "gpt-5.6-sol");

    // Reported under the slug the operator picked, or the tray would credit
    // the turn to a model that is not the one in their picker.
    await waitUntil(
      () => usageEvents(stateDir).some((event) => event.model === "gpt-5.6-sol-1m"),
      `No usage event named the variant: ${JSON.stringify(usageEvents(stateDir))}`,
    );
    assert.equal(
      usageEvents(stateDir).some((event) => event.model === "gpt-5.6-sol"),
      false,
    );
  } finally {
    await stopChild(router);
    await closeServer(native.server);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a turn on a real native model is forwarded untouched", async () => {
  const seen = [];
  const native = await mockServer(async (request, response) => {
    seen.push(await readBody(request));
    const payload = Buffer.from(JSON.stringify({ id: "resp-base", output: [] }), "utf8");
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": String(payload.length),
    });
    response.end(payload);
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "context-variant-state-"));
  const routerPort = await openPort();
  const router = runRouter({
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${native.port}/v1`,
    MODEL_ROUTER_STATE_DIR: stateDir,
  });

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const result = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: { Authorization: "Bearer caller", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      }),
    });
    assert.equal(result.status, 200, await result.text());
    assert.equal(seen[0].model, "gpt-5.6-sol");
  } finally {
    await stopChild(router);
    await closeServer(native.server);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

function usageEvents(stateDir) {
  const file = path.join(stateDir, "usage-events.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test.after(() => {
  rmSync(pickerStateDir, { recursive: true, force: true });
});
