import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(root, "test", "fixtures", "vertex-model-garden-pages.json");

function jsonResponse(payload, status = 200) {
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  };
}

const { VERTEX_ADAPTERS, vertexAdapterForModel } =
  await import("../src/vertex-adapters.mjs");
const {
  IMPLEMENTED_VERTEX_ADAPTERS,
  readVertexSupportCatalog,
} = await import("../src/vertex-support-catalog.mjs");
const { discoverProviderModels } = await import("../src/model-discovery.mjs");
const {
  vertexModelGardenUrl,
  vertexPublisherModelId,
} = await import("../src/vertex-model-discovery.mjs");
const { PROVIDERS } = await import("../src/model-registry.mjs");

test("Vertex adapters cover Anthropic Messages and OpenAI-compatible chat", () => {
  assert.deepEqual(IMPLEMENTED_VERTEX_ADAPTERS, [
    "vertex-anthropic-messages",
    "vertex-openai-chat",
  ]);

  const anthropic = vertexAdapterForModel(
    { adapter: "vertex-anthropic-messages" },
    { protocol: "vertex" },
  );
  const anthropicPayload = anthropic.normalizeBody({
    model: "gateway-model",
    max_tokens: 128,
    stream: true,
    messages: [{ role: "user", content: "hello" }],
  });
  assert.equal(anthropicPayload.model, undefined);
  assert.equal(anthropicPayload.anthropic_version, "vertex-2023-10-16");
  assert.equal(
    anthropic.targetPath({
      model: { upstreamModel: "claude-sonnet-5@20250514" },
      body: anthropicPayload,
    }),
    "/publishers/anthropic/models/claude-sonnet-5@20250514:streamRawPredict",
  );

  const openai = vertexAdapterForModel(
    { adapter: "vertex-openai-chat" },
    { protocol: "vertex" },
  );
  const openaiPayload = {
    model: "gateway-model",
    stream: false,
    messages: [{ role: "user", content: "hello" }],
  };
  assert.deepEqual(openai.normalizeBody(openaiPayload), {
    ...openaiPayload,
    model: "google/gateway-model",
  });
  assert.equal(
    openai.targetPath({ model: { upstreamModel: "gemini-2.5-flash" }, body: openaiPayload }),
    "/endpoints/openapi/chat/completions",
  );
  assert.equal(VERTEX_ADAPTERS["vertex-anthropic-messages"].route, "/messages");
  assert.equal(VERTEX_ADAPTERS["vertex-openai-chat"].route, "/chat/completions");
});

test("Vertex support catalog contains only models backed by explicit adapters", () => {
  const catalog = readVertexSupportCatalog();
  assert.ok(catalog.models.some((model) => model.adapter === "vertex-anthropic-messages"));
  assert.ok(catalog.models.some((model) => model.adapter === "vertex-openai-chat"));
  for (const model of catalog.models) {
    assert.ok(Object.hasOwn(VERTEX_ADAPTERS, model.adapter), model.id);
  }
});

test("Vertex static curation uses the checked-in catalog without credentials or Model Garden", async () => {
  let fetchCalls = 0;
  const result = await discoverProviderModels("vertex", {
    staticCatalog: true,
    cache: false,
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("static Vertex curation must not contact Model Garden");
    },
  });

  assert.equal(fetchCalls, 0);
  assert.equal(result.staticCatalog, true);
  assert.deepEqual(
    result.supported,
    readVertexSupportCatalog().models.map((model) => model.id).sort(),
  );
  assert.deepEqual(result.addable, result.supported);
  assert.equal(
    result.supportedModels.find((model) => model.adapter === "vertex-anthropic-messages")
      .requestProfile,
    "anthropic-reasoning",
  );
});

test("Vertex publisher matching treats configured publisher names literally", () => {
  assert.equal(
    vertexPublisherModelId(
      { name: "publishers/googleXmodels/models/gemini-2.5-flash" },
      "google.models",
    ),
    undefined,
  );
  assert.equal(
    vertexPublisherModelId(
      { name: "publishers/google.models/models/gemini-2.5-flash" },
      "google.models",
    ),
    "gemini-2.5-flash",
  );
});

test("Vertex discovery follows all configured Model Garden publishers and filters unsupported ids", async () => {
  const result = await discoverProviderModels("vertex", {
    fixturePath,
    cache: false,
  });

  assert.deepEqual(result.discovered, [
    "claude-not-supported@20260101",
    "claude-opus-5@20250201",
    "claude-sonnet-5@20250514",
    "gemini-2.5-flash",
    "gemini-not-supported",
  ]);
  assert.deepEqual(result.supported, [
    "claude-opus-5@20250201",
    "claude-sonnet-5@20250514",
    "gemini-2.5-flash",
  ]);
  assert.deepEqual(result.addable, result.supported);
  assert.deepEqual(
    result.unsupported.map(({ id }) => id),
    ["claude-not-supported@20260101", "gemini-not-supported"],
  );
  assert.match(result.unsupported[0].reason, /support catalog/i);
});

test("Vertex discovery accepts the legacy flat fixture shape with multiple publishers configured", async () => {
  const result = await discoverProviderModels("vertex", {
    cache: false,
    fixturePayload: {
      publisherModels: [
        { name: "publishers/anthropic/models/claude-sonnet-5@20250514" },
      ],
    },
  });
  assert.deepEqual(result.supported, ["claude-sonnet-5@20250514"]);
});

test("Vertex URL generation resolves the old publisher placeholder from the support catalog", () => {
  const provider = PROVIDERS.get("vertex");
  const legacy = {
    ...provider,
    modelGarden: {
      ...provider.modelGarden,
      publishers: undefined,
      parent: "publishers",
    },
  };
  assert.match(vertexModelGardenUrl(legacy), /\/v1beta1\/publishers\/anthropic\/models\?/);
});

test("Vertex URL generation does not duplicate an already versioned base", () => {
  const provider = PROVIDERS.get("vertex");
  const versioned = {
    ...provider,
    modelGarden: {
      ...provider.modelGarden,
      baseUrl: "https://aiplatform.googleapis.com/v1beta1",
    },
  };
  assert.equal(
    new URL(vertexModelGardenUrl(versioned, { publisher: "google" })).pathname,
    "/v1beta1/publishers/google/models",
  );
});

test("Vertex catalog cache identity includes the configured publisher set", () => {
  const state = mkdtempSync(path.join(os.tmpdir(), "vertex-catalog-cache-test-"));
  const discoveryUrl = new URL("../src/vertex-model-discovery.mjs", import.meta.url).href;
  const script = `
    import { discoverVertexProviderModels } from ${JSON.stringify(discoveryUrl)};

    const baseProvider = {
      id: "vertex",
      displayName: "Vertex fixture",
      baseUrl: "https://aiplatform.googleapis.com",
      modelGarden: {
        apiVersion: "v1beta1",
        baseUrl: "https://aiplatform.googleapis.com",
        listAllVersions: true,
      },
    };
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      const name = calls === 1
        ? "publishers/anthropic/models/claude-sonnet-5@20250514"
        : "publishers/google/models/gemini-2.5-flash";
      return new Response(JSON.stringify({ publisherModels: [{ name }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const credential = {
      value: "test-only-access-token",
      projectId: "test-project",
      location: "us-central1",
    };
    const first = await discoverVertexProviderModels({
      ...baseProvider,
      modelGarden: { ...baseProvider.modelGarden, publishers: ["anthropic"] },
    }, { credential, fetchImpl, allowPrivate: true });
    const second = await discoverVertexProviderModels({
      ...baseProvider,
      modelGarden: { ...baseProvider.modelGarden, publishers: ["google"] },
    }, { credential, fetchImpl, allowPrivate: true });
    process.stdout.write(JSON.stringify({
      calls,
      first: first.supported,
      second: second.supported,
      secondCached: second.cached,
    }));
  `;
  try {
    const result = JSON.parse(execFileSync(
      process.execPath,
      ["--input-type=module", "--eval", script],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: state,
          MODEL_ROUTER_STATE_DIR: state,
          CODEX_ROUTER_STATE_DIR: state,
        },
      },
    ));
    assert.equal(result.calls, 2);
    assert.deepEqual(result.first, ["claude-sonnet-5@20250514"]);
    assert.deepEqual(result.second, ["gemini-2.5-flash"]);
    assert.equal(result.secondCached, false);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test("Vertex discovery paginates publisher lists and never uses the generic /models endpoint", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const page = calls.length === 1
      ? {
          publisherModels: [
            { name: "publishers/anthropic/models/claude-sonnet-5@20250514" },
          ],
          nextPageToken: "next-page",
        }
      : calls.length === 2
        ? {
            publisherModels: [
              { name: "publishers/anthropic/models/claude-opus-5@20250201" },
            ],
          }
        : { publisherModels: [] };
    return jsonResponse(page);
  };

  const result = await discoverProviderModels("vertex", {
    cache: false,
    fetchImpl,
    credential: {
      value: "test-only-access-token",
      projectId: "test-project",
      location: "us-central1",
    },
    allowPrivate: true,
  });

  assert.deepEqual(result.supported, [
    "claude-opus-5@20250201",
    "claude-sonnet-5@20250514",
  ]);
  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /\/v1beta1\/publishers\/anthropic\/models\?/);
  assert.match(calls[1].url, /pageToken=next-page/);
  assert.match(calls[2].url, /\/v1beta1\/publishers\/google\/models\?/);
  assert.ok(calls.every(({ url }) => !/\/v1(?:beta1)?\/models(?:\?|$)/.test(url)));
  assert.equal(calls[0].init.headers.Authorization, "Bearer test-only-access-token");
});

test("Vertex discovery redacts provider failure details", async () => {
  await assert.rejects(
    () => discoverProviderModels("vertex", {
      cache: false,
      fetchImpl: async () => jsonResponse(
        { error: { message: "secret-provider-token" } },
        403,
      ),
      credential: {
        value: "test-only-access-token",
        projectId: "test-project",
        location: "us-central1",
      },
      allowPrivate: true,
    }),
    (error) => {
      assert.doesNotMatch(String(error), /secret-provider-token|test-only-access-token/);
      assert.match(String(error), /HTTP 403/);
      return true;
    },
  );
});

test("Vertex curation writes verified adapter and catalog metadata without prompts", () => {
  const state = mkdtempSync(path.join(os.tmpdir(), "vertex-curation-test-"));
  const userModels = path.join(state, "user-models.json");
  try {
    execFileSync(
      process.execPath,
      [
        "src/curate-models.mjs",
        "vertex",
        "--fixture",
        fixturePath,
        "--models",
        "gemini-2.5-flash",
        "--no-apply",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          MODEL_ROUTER_STATE_DIR: state,
          MODEL_ROUTER_USER_MODELS: userModels,
        },
      },
    );
    const stored = JSON.parse(readFileSync(userModels, "utf8"));
    assert.equal(stored.models.length, 1);
    assert.equal(stored.models[0].adapter, "vertex-openai-chat");
    assert.equal(stored.models[0].vertexPublisher, "google");
    assert.equal(stored.models[0].displayName, "Gemini 2.5 Flash (Vertex AI)");
    assert.deepEqual(stored.models[0].inputModalities, ["text", "image"]);
    assert.equal(stored.models[0].contextWindow, 1048576);
    assert.equal(stored.models[0].autoCompact, 900000);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test("Vertex static curation adds a reviewed model without ADC or Model Garden", () => {
  const state = mkdtempSync(path.join(os.tmpdir(), "vertex-static-curation-test-"));
  const userModels = path.join(state, "user-models.json");
  try {
    execFileSync(
      process.execPath,
      [
        "src/curate-models.mjs",
        "vertex",
        "--static",
        "--models",
        "gemini-2.5-pro",
        "--no-apply",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          MODEL_ROUTER_STATE_DIR: state,
          MODEL_ROUTER_USER_MODELS: userModels,
          MODEL_ROUTER_MODEL_PICKER_STATE: path.join(state, "model-picker.json"),
          GOOGLE_APPLICATION_CREDENTIALS: path.join(state, "missing-adc.json"),
        },
      },
    );
    const stored = JSON.parse(readFileSync(userModels, "utf8"));
    assert.equal(stored.models[0].upstreamModel, "gemini-2.5-pro");
    assert.equal(stored.models[0].adapter, "vertex-openai-chat");
    assert.equal(stored.models[0].vertexPublisher, "google");
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test("Vertex provider is catalog-only and does not appear as an API-key prompt", () => {
  assert.equal(PROVIDERS.get("vertex").credential.resolver, "google-application-default");
  assert.equal(PROVIDERS.get("vertex").kind, "openai-compatible");
});

test("main Responses routing does not apply Gemini trailing-turn rewriting to Vertex", () => {
  const source = readFileSync(path.join(root, "src", "router.mjs"), "utf8");
  const start = source.indexOf("function requiresTrailingUserTurn(route)");
  const end = source.indexOf("\n}\n", start);
  assert.ok(start >= 0);
  assert.ok(end > start);
  assert.match(source.slice(start, end), /provider\?\.protocol !== "vertex"/);
});

test("Vertex onboarding points to local ADC configuration instead of a key field", () => {
  const state = mkdtempSync(path.join(os.tmpdir(), "vertex-onboarding-test-"));
  const environment = { ...process.env };
  for (const name of [
    "VERTEX_PROJECT_ID",
    "VERTEX_LOCATION",
    "GOOGLE_CLOUD_PROJECT",
    "GCLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
  ]) delete environment[name];
  Object.assign(environment, {
    HOME: state,
    CODEX_HOME: path.join(state, "codex"),
    MODEL_ROUTER_STATE_DIR: path.join(state, "router-state"),
    MODEL_ROUTER_VERTEX_STATE: path.join(state, "vertex-settings.json"),
    GCLOUD_BIN: path.join(state, "missing-gcloud"),
  });
  try {
    const snapshot = JSON.parse(execFileSync(
      process.execPath,
      ["src/control.mjs", "providers", "--json"],
      { cwd: root, encoding: "utf8", env: environment },
    ));
    const vertex = snapshot.providers.find((provider) => provider.id === "vertex");
    assert.equal(vertex.kind, "configuration");
    assert.equal(vertex.action, "configure");
    assert.equal(vertex.credentialLabel, "Google Cloud ADC");
    assert.match(vertex.configurationNote, /control vertex set/i);
    assert.doesNotMatch(JSON.stringify(vertex), /add-key|API key/i);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test("setup reports resolver-backed Vertex configuration instead of an API-key command", () => {
  const source = readFileSync(path.join(root, "src", "setup.mjs"), "utf8");
  const start = source.indexOf("if (pendingCredentials.length)");
  assert.ok(start >= 0);
  const end = source.indexOf(".join(\"\")", start);
  assert.ok(end > start);
  assert.match(
    source.slice(start, end),
    /provider\.credential\?\.resolver\s*\?\s*credentialSetupHint\(provider\)/,
  );
});

function requestJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function forwarderResponse(response, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  response.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Length": String(body.length),
  });
  response.end(body);
}

test("Vertex forwarder selects protocol adapters, bearer auth, and streaming paths", async () => {
  const requests = [];
  const upstream = http.createServer(async (request, response) => {
    requests.push({
      url: request.url,
      headers: request.headers,
      body: await requestJson(request),
    });
    forwarderResponse(response, { id: "vertex-test-response", choices: [] });
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const upstreamPort = upstream.address().port;
  const forwarderPort = await openPort();
  const state = mkdtempSync(path.join(os.tmpdir(), "vertex-forwarder-test-"));
  const registry = path.join(state, "registry.json");
  const internalKey = "vertex-forwarder-internal-key-with-length";
  let child;
  try {
    writeFileSync(
      registry,
      JSON.stringify({
        version: 1,
        providers: [{
          id: "vertex",
          displayName: "Vertex fixture",
          kind: "openai-compatible",
          protocol: "vertex",
          ownedBy: "google",
          baseUrl: "https://vertex.example",
          baseUrlEnv: "VERTEX_BASE_URL",
          credential: {
            environment: ["VERTEX_API_KEY"],
            file: "vertex-api-key.secret",
            legacyFiles: [],
            keychainServices: [],
          },
          modelGarden: {
            apiVersion: "v1beta1",
            baseUrl: "https://vertex.example",
            publishers: ["anthropic", "google"],
            listAllVersions: true,
          },
        }],
        models: [
          {
            slug: "vertex/anthropic-fixture",
            gatewayModel: "vertex-anthropic-fixture",
            upstreamModel: "claude-sonnet-5@20250514",
            provider: "vertex",
            adapter: "vertex-anthropic-messages",
            vertexPublisher: "anthropic",
            listed: false,
          },
          {
            slug: "vertex/openai-fixture",
            gatewayModel: "vertex-openai-fixture",
            upstreamModel: "gemini-2.5-flash",
            provider: "vertex",
            adapter: "vertex-openai-chat",
            vertexPublisher: "google",
            listed: false,
          },
        ],
      }),
    );
    child = spawn(process.execPath, [path.join(root, "src", "api-forwarder.mjs")], {
      cwd: root,
      env: {
        ...process.env,
        MODEL_ROUTER_TARGET: "codex",
        MODEL_ROUTER_REGISTRY: registry,
        MODEL_ROUTER_STATE_DIR: path.join(state, "router-state"),
        MODEL_ROUTER_API_PORT: String(forwarderPort),
        MODEL_ROUTER_INTERNAL_KEY: internalKey,
        VERTEX_BASE_URL:
          "http://127.0.0.1:" + upstreamPort + "/v1/projects/project/locations/location",
        VERTEX_API_KEY: "test-vertex-access-token",
        MODEL_ROUTER_QUIET: "1",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.setEncoding("utf8");
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const base = "http://127.0.0.1:" + forwarderPort;
    const headers = {
      Authorization: "Bearer " + internalKey,
      "Content-Type": "application/json",
    };
    const waitForHealth = async () => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error("forwarder exited: " + stderr);
        try {
          const response = await fetch(base + "/health", { headers });
          if (response.ok) return;
        } catch {
          // The child has not bound its port yet.
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      throw new Error("forwarder did not become healthy: " + stderr);
    };
    await waitForHealth();

    for (const stream of [false, true]) {
      const response = await fetch(base + "/v1/messages", {
        method: "POST",
        headers: { ...headers, "anthropic-version": "caller-version" },
        body: JSON.stringify({
          model: "vertex-anthropic-fixture",
          max_tokens: 128,
          stream,
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      assert.equal(response.status, 200, await response.text());
    }
    const openaiResponse = await fetch(base + "/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "vertex-openai-fixture",
        stream: false,
        reasoning_effort: "medium",
        web_search_options: { search_context_size: "low" },
        store: false,
        logit_bias: { "42": 1 },
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    assert.equal(openaiResponse.status, 200, await openaiResponse.text());

    assert.deepEqual(requests.map(({ url }) => url), [
      "/v1/projects/project/locations/location/publishers/anthropic/models/claude-sonnet-5@20250514:rawPredict",
      "/v1/projects/project/locations/location/publishers/anthropic/models/claude-sonnet-5@20250514:streamRawPredict",
      "/v1/projects/project/locations/location/endpoints/openapi/chat/completions",
    ]);
    for (const request of requests) {
      assert.equal(request.headers.authorization, "Bearer test-vertex-access-token");
      assert.equal(request.headers["x-api-key"], undefined);
      assert.equal(request.headers["anthropic-version"], undefined);
    }
    assert.equal(requests[0].body.model, undefined);
    assert.equal(requests[0].body.anthropic_version, "vertex-2023-10-16");
    assert.equal(requests[1].body.model, undefined);
    assert.equal(requests[1].body.anthropic_version, "vertex-2023-10-16");
    assert.deepEqual(requests[2].body, {
      model: "google/gemini-2.5-flash",
      stream: false,
      reasoning_effort: "medium",
      messages: [{ role: "user", content: "hello" }],
    });
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    await new Promise((resolve) => upstream.close(resolve));
    rmSync(state, { recursive: true, force: true });
  }
});
