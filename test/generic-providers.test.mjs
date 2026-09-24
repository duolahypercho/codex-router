import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testRoot = mkdtempSync(path.join(os.tmpdir(), "generic-provider-test-"));
process.env.HOME = testRoot;
process.env.CODEX_HOME = path.join(testRoot, "codex");
process.env.CODEX_ROUTER_STATE_DIR = path.join(testRoot, "state");
process.env.MODEL_ROUTER_USER_MODELS = path.join(testRoot, "state", "user-models.json");
process.env.CODEX_ROUTER_SERVICE_PLATFORM = "linux";
process.env.CODEX_ROUTER_SKIP_LAUNCHCTL = "1";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const {
  GENERIC_PROVIDERS_PATH,
  addGenericProvider,
  getGenericProvider,
  genericProviderDescriptor,
  listGenericProviders,
  ollamaShowOrigin,
  ollamaShowRecord,
  requestGenericProvider,
  readGenericProviders,
  removeGenericProvider,
  runGenericProviderCli,
  setGenericProviderEnabled,
  testGenericProvider,
  updateGenericProvider,
} = await import("../src/generic-providers.mjs");
const {
  addCredentialReference,
  addGenericProviderCredentialReference,
  readProviderCredentialStore,
} = await import("../src/provider-credential-store.mjs");
const {
  genericProviderCredentialPath,
  writeGenericProviderCredential,
} = await import("../src/provider-credentials.mjs");
const { LOG_PATH } = await import("../src/paths.mjs");
const { createSupportBundle } = await import("../src/support-bundle.mjs");
const { discoverGenericProviderModels } = await import("../src/model-discovery.mjs");
const { readUserModels, userModelEntry } = await import("../src/user-models.mjs");
const { runGenericCommand } = await import("../src/providers.mjs");
test.after(() => rmSync(testRoot, { recursive: true, force: true }));

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function closeServer(server) {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

test("generic provider CRUD is versioned, atomic and redacted", () => {
  const added = addGenericProvider({
    id: "local-vllm",
    displayName: "Local vLLM",
    description: "A local OpenAI-compatible server",
    baseUrl: "https://inference.example.test/v1",
    adapter: "openai-chat",
    headers: { "X-Organization": "test-org" },
    credentialRef: "cred_local_vllm_01",
  });
  assert.equal(added.id, "local-vllm");
  assert.deepEqual(added.headers, { "X-Organization": "[redacted]" });
  assert.deepEqual(readGenericProviders()[0].headers, { "X-Organization": "test-org" });
  // Windows does not expose POSIX permission bits. The private writer still
  // uses the restrictive mode on POSIX, while the ACL is the Windows boundary.
  if (process.platform !== "win32") {
    assert.equal(statSync(GENERIC_PROVIDERS_PATH).mode & 0o777, 0o600);
  }
  assert.equal(JSON.parse(readFileSync(GENERIC_PROVIDERS_PATH, "utf8")).version, 1);

  const listed = listGenericProviders();
  assert.deepEqual(listed[0].headers, { "X-Organization": "[redacted]" });
  const descriptor = genericProviderDescriptor("local-vllm");
  assert.deepEqual(descriptor, {
    id: "local-vllm",
    displayName: "Local vLLM",
    kind: "openai-compatible",
    ownedBy: "local-vllm",
    baseUrl: "https://inference.example.test/v1",
    adapter: "openai-chat",
    protocol: "openai",
    headers: { "X-Organization": "[redacted]" },
    allowPrivate: false,
    credentialRef: "cred_local_vllm_01",
    generic: true,
    enabled: true,
  });
});

test("generic provider edits do not erase fields omitted by the CLI", () => {
  const updated = updateGenericProvider("local-vllm", { displayName: "Local vLLM (edited)" });
  assert.equal(updated.displayName, "Local vLLM (edited)");
  assert.equal(getGenericProvider("local-vllm").baseUrl, "https://inference.example.test/v1");
  assert.equal(getGenericProvider("local-vllm").credentialRef, "cred_local_vllm_01");
  assert.equal(setGenericProviderEnabled("local-vllm", false).enabled, false);
  assert.equal(getGenericProvider("local-vllm").enabled, false);
  assert.deepEqual(removeGenericProvider("local-vllm"), { removed: "local-vllm", remaining: 0 });
});

test("private endpoints and secret transport headers require explicit handling", () => {
  assert.throws(
    () => addGenericProvider({
      id: "loopback-default",
      displayName: "Loopback",
      baseUrl: "http://127.0.0.1:8000/v1",
    }),
    /allowPrivate=true/,
  );
  const local = addGenericProvider({
    id: "loopback-explicit",
    displayName: "Loopback",
    baseUrl: "http://127.0.0.1:8000/v1",
    allowPrivate: true,
  });
  assert.equal(local.allowPrivate, true);
  assert.throws(
    () => addGenericProvider({
      id: "secret-header",
      displayName: "Invalid",
      baseUrl: "https://inference.example.test/v1",
      headers: { Authorization: "secret" },
    }),
    /reserved for credential/,
  );
  assert.throws(
    () => addGenericProvider({
      id: "deepseek",
      displayName: "Invalid",
      baseUrl: "https://inference.example.test/v1",
    }),
    /already used by the built-in registry/,
  );
  assert.throws(
    () => addGenericProvider({
      id: "ipv6-link-local",
      displayName: "Invalid",
      baseUrl: "https://[fe90::1]/v1",
    }),
    /private or loopback|allowPrivate=true/,
  );
  assert.throws(
    () => addGenericProvider({
      id: "ipv4-mapped-loopback",
      displayName: "Invalid",
      baseUrl: "https://[::ffff:7f00:1]/v1",
    }),
    /private or loopback|allowPrivate=true/,
  );
});

test("generic provider test checks private resolution and never prints headers", async () => {
  const calls = [];
  const result = await testGenericProvider("loopback-explicit", {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200 };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(calls[0].url, "http://127.0.0.1:8000/v1/models");
  assert.equal(calls[0].options.headers.Accept, "application/json");
  assert.equal(calls[0].options.headers.Authorization, undefined);
});

test("generic requests revalidate DNS, reject redirects, and bound response reads", async () => {
  addGenericProvider({
    id: "remote-boundary",
    displayName: "Remote boundary",
    baseUrl: "https://provider.example.test/v1",
  });
  await assert.rejects(
    () => requestGenericProvider("remote-boundary", "/models", {
      lookup: async () => ["192.168.10.12"],
      fetchImpl: async () => ({ ok: true, status: 200 }),
    }),
    /private or link-local/,
  );
  await assert.rejects(
    () => requestGenericProvider("remote-boundary", "https://attacker.example/models", {
      lookup: async () => ["8.8.8.8"],
      fetchImpl: async () => ({ ok: true, status: 200 }),
    }),
    /request paths must be relative/,
  );
  await assert.rejects(
    () => requestGenericProvider("remote-boundary", "/../admin", {
      lookup: async () => ["8.8.8.8"],
      fetchImpl: async () => { throw new Error("escaped base path reached fetch"); },
    }),
    /cannot escape the configured baseUrl path/,
  );
  await assert.rejects(
    () => requestGenericProvider("remote-boundary", "/models", {
      lookup: async () => ["8.8.8.8"],
      fetchImpl: async () => ({ ok: false, status: 302, body: { cancel: async () => undefined } }),
    }),
    /redirects are disabled/,
  );
  await assert.rejects(
    () => testGenericProvider("remote-boundary", {
      lookup: async () => ["8.8.8.8"],
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": "65537" }),
      }),
    }),
    /65536-byte|read limit/,
  );
});

test("generic request transport keeps operator headers authoritative and can follow caller lifetime", async () => {
  addGenericProvider({
    id: "request-transport",
    displayName: "Request transport",
    baseUrl: "https://provider.example.test/v1",
    headers: { "X-Tenant": "operator-tenant" },
  });
  const controller = new AbortController();
  let observed;
  const { dispatcher } = await requestGenericProvider("request-transport", "/chat/completions", {
    lookup: async () => ["8.8.8.8"],
    fetchImpl: async (_url, options) => {
      observed = options;
      return { ok: true, status: 200 };
    },
    timeoutMs: 0,
    signal: controller.signal,
    method: "POST",
    headers: { "x-tenant": "caller-tenant", "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(dispatcher, undefined);
  assert.equal(observed.headers["X-Tenant"], "operator-tenant");
  assert.equal(observed.headers["x-tenant"], undefined);
  assert.equal(observed.headers["Content-Type"], "application/json");
  assert.equal(observed.signal, controller.signal);
});

test("generic credential references never enter descriptors or logs", async () => {
  addGenericProvider({
    id: "credential-boundary",
    displayName: "Credential boundary",
    baseUrl: "https://provider.example.test/v1",
    credentialRef: "cred_generic_provider_01",
    headers: { "X-Organization": "safe-metadata" },
  });
  assert.equal(JSON.stringify(listGenericProviders()).includes("TEST_GENERIC_PROVIDER_TOKEN"), false);
  await assert.rejects(
    () => requestGenericProvider("credential-boundary", "/models", {
      lookup: async () => ["8.8.8.8"],
      fetchImpl: async () => ({ ok: true, status: 200 }),
    }),
    /bound credential is unavailable/,
  );
});

test("generic provider add-model registers an unlisted model id and picks it", async () => {
  const providerId = "generic-named-model";
  addGenericProvider({
    id: providerId,
    displayName: "Generic Named Model",
    baseUrl: "https://provider.example.test/v1",
  });
  const transact = async ({ mutate, applyPublication }) => {
    await mutate();
    await applyPublication();
  };
  const added = await runGenericCommand(
    ["add-model", providerId, "private-preview-1", "--json"],
    { transact, applyPublication: async () => ({ published: false }) },
  );
  assert.equal(added.slug, `${providerId}/private-preview-1`);
  const stored = readUserModels().find((model) => model.slug === added.slug);
  assert.equal(stored.provider, providerId);
  assert.equal(stored.upstreamModel, "private-preview-1");
  assert.equal(stored.listed, true);
  await assert.rejects(
    runGenericCommand(
      ["add-model", providerId, "private-preview-1"],
      { transact, applyPublication: async () => ({ published: false }) },
    ),
    /already a curated/,
  );
  await assert.rejects(
    runGenericCommand(["add-model", providerId], { transact }),
    /Usage: providers generic add-model/,
  );
});

test("generic provider credential CLI reads a piped key with --stdin and never prompts", async () => {
  const providerId = "generic-key-stdin";
  const secret = "TEST_GENERIC_STDIN_TOKEN_41c8aa";
  addGenericProvider({
    id: providerId,
    displayName: "Generic Key Stdin",
    baseUrl: "https://provider.example.test/v1",
  });
  const transact = async ({ mutate, applyPublication }) => {
    await mutate();
    await applyPublication();
  };
  const configured = await runGenericCommand(
    ["credential", providerId, "set", "--stdin", "--json"],
    {
      prompt: () => { throw new Error("the hidden prompt must not run with --stdin"); },
      readStdin: async () => `${secret}\n`,
      transact,
      applyPublication: async () => ({ published: false }),
    },
  );
  assert.equal(configured.configured, true);
  assert.equal(JSON.stringify(configured).includes(secret), false);
  await assert.rejects(
    runGenericCommand(
      ["credential", providerId, "set", "--stdin"],
      { readStdin: async () => "  ", transact, applyPublication: async () => ({ published: false }) },
    ),
    /API key is empty/,
  );
  await assert.rejects(
    runGenericCommand(["credential", providerId, "remove", "--stdin"], { transact }),
    /--stdin applies only to credential set/,
  );
});

test("generic provider credential CLI binds a hidden-prompt key and removes it coherently", async () => {
  const providerId = "generic-key-cli";
  const secret = "TEST_GENERIC_HIDDEN_PROMPT_TOKEN_7d2f09";
  addGenericProvider({
    id: providerId,
    displayName: "Generic Key CLI",
    baseUrl: "https://provider.example.test/v1",
  });
  const transact = async ({ mutate, applyPublication }) => {
    await mutate();
    await applyPublication();
  };
  const configured = await runGenericCommand(
    ["credential", providerId, "set", "--json"],
    { prompt: () => secret, transact, applyPublication: async () => ({ published: false }) },
  );
  assert.equal(configured.configured, true);
  assert.match(configured.credentialRef, /^cred_/);
  assert.equal(JSON.stringify(configured).includes(secret), false);
  assert.equal(getGenericProvider(providerId).credentialRef, configured.credentialRef);
  assert.equal(existsSync(genericProviderCredentialPath(providerId)), true);
  assert.equal(readProviderCredentialStore().credentials.some(
    (credential) => credential.id === configured.credentialRef &&
      credential.providerType === "generic" && credential.providerId === providerId,
  ), true);

  const removed = await runGenericCommand(
    ["credential", providerId, "remove", "--json"],
    { transact, applyPublication: async () => ({ published: false }) },
  );
  assert.equal(removed.configured, false);
  assert.equal(removed.credentialRef, null);
  assert.equal(getGenericProvider(providerId).credentialRef, undefined);
  assert.equal(existsSync(genericProviderCredentialPath(providerId)), false);
  assert.equal(readProviderCredentialStore().credentials.some(
    (credential) => credential.id === configured.credentialRef,
  ), false);
});

test("generic requests fail closed when a credential is unavailable or not an API key", async () => {
  addGenericProvider({
    id: "missing-credential",
    displayName: "Missing credential",
    baseUrl: "https://provider.example.test/v1",
    credentialRef: "cred_generic_missing_01",
  });
  await assert.rejects(
    () => requestGenericProvider("missing-credential", "/models", {
      lookup: async () => ["8.8.8.8"],
      fetchImpl: async () => ({ ok: true, status: 200 }),
    }),
    /bound credential is unavailable/,
  );

  addGenericProvider({
    id: "account-credential",
    displayName: "Account credential",
    baseUrl: "https://provider.example.test/v1",
    credentialRef: "cred_generic_account_01",
  });
  await assert.rejects(
    () => requestGenericProvider("account-credential", "/models", {
      lookup: async () => ["8.8.8.8"],
      fetchImpl: async () => ({ ok: true, status: 200 }),
    }),
    /bound credential is unavailable/,
  );
});

test("public APIs confine a generic credential to its permitted endpoint", async () => {
  const providerId = "public-api-provider";
  const secret = "TEST_GENERIC_PUBLIC_API_TOKEN_82f6f31a";
  const permittedRequests = [];
  const trappedRequests = [];
  const trap = createServer((request, response) => {
    trappedRequests.push({ url: request.url, authorization: request.headers.authorization });
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  const trapPort = await listen(trap);
  const permitted = createServer((request, response) => {
    permittedRequests.push({ url: request.url, authorization: request.headers.authorization });
    if (request.url === "/v1/redirect") {
      response.writeHead(302, { location: `http://127.0.0.1:${trapPort}/stolen` });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"data":[]}');
  });
  const permittedPort = await listen(permitted);

  try {
    assert.throws(
      () => addCredentialReference({ providerId, kind: "api_key", secretRef: { type: "provider-file" } }),
      /Invalid providerId/,
      "the built-in credential API must remain registry-bound",
    );
    assert.throws(
      () => addGenericProviderCredentialReference({ providerId: "deepseek" }),
      /already used by the built-in registry/,
      "the generic credential API must not bypass built-in validation",
    );

    const credential = addGenericProviderCredentialReference({
      id: "cred_public_generic_credential_01",
      providerId,
      label: "Public API fixture",
    });
    const credentialPath = writeGenericProviderCredential(providerId, secret);
    assert.equal(credentialPath, genericProviderCredentialPath(providerId));
    if (process.platform !== "win32") assert.equal(statSync(credentialPath).mode & 0o777, 0o600);

    const provider = addGenericProvider({
      id: providerId,
      displayName: "Public API provider",
      baseUrl: `http://127.0.0.1:${permittedPort}/v1`,
      allowPrivate: true,
      credentialRef: credential.id,
    });
    const result = await testGenericProvider(providerId);
    assert.equal(result.ok, true);
    assert.deepEqual(permittedRequests, [{
      url: "/v1/models",
      authorization: `Bearer ${secret}`,
    }]);

    const discovery = await discoverGenericProviderModels(providerId, {
      cache: false,
      proxyResolvesDestination: false,
    });
    assert.deepEqual(discovery.discovered, []);
    assert.equal(permittedRequests.length, 2);
    assert.equal(permittedRequests[1].url, "/v1/models");
    assert.equal(permittedRequests[1].authorization, `Bearer ${secret}`);

    await assert.rejects(
      () => requestGenericProvider(providerId, "/redirect"),
      /redirects are disabled/,
    );
    assert.equal(trappedRequests.length, 0, "a redirect received the generic credential");
    assert.equal(permittedRequests.length, 3);
    assert.ok(permittedRequests.every((request) => request.authorization === `Bearer ${secret}`));

    let cliOutput = "";
    await runGenericProviderCli(["show", providerId, "--json"], {
      output: { write(chunk) { cliOutput += chunk; return true; } },
    });
    const publicSurfaces = JSON.stringify({
      credential,
      provider,
      descriptor: genericProviderDescriptor(providerId),
      listed: listGenericProviders(),
      result,
      discovery,
      cliOutput,
      credentialStore: readProviderCredentialStore(),
    });
    assert.equal(publicSurfaces.includes(secret), false, "a descriptor or public output exposed the credential");

    writeFileSync(LOG_PATH, `upstream diagnostic accidentally included ${secret}\n`, { mode: 0o600 });
    const bundlePath = path.join(testRoot, "generic-provider-support.json");
    createSupportBundle({ includeLogs: true, output: bundlePath });
    assert.equal(readFileSync(bundlePath, "utf8").includes(secret), false, "support output exposed the credential");
  } finally {
    await Promise.all([closeServer(permitted), closeServer(trap)]);
  }
});

test("providers CLI exposes generic CRUD with sanitized JSON", () => {
  const env = {
    ...process.env,
    HOME: testRoot,
    CODEX_HOME: path.join(testRoot, "codex-cli"),
    CODEX_ROUTER_STATE_DIR: path.join(testRoot, "state-cli"),
    MODEL_ROUTER_USER_MODELS: path.join(testRoot, "state-cli", "user-models.json"),
    MODEL_ROUTER_MODEL_PICKER_STATE: path.join(testRoot, "state-cli", "model-picker.json"),
  };
  mkdirSync(env.CODEX_ROUTER_STATE_DIR, { recursive: true });
  // The control-center entry point must use the same transactional
  // publication command as bin/providers rather than mutating descriptors
  // directly and leaving a running route stale.
  const add = spawnSync(process.execPath, ["src/control.mjs", "generic-providers", "add", "cli-test", "--name", "CLI Test", "--base-url", "https://cli.example.test/v1", "--header", "X-Org=demo", "--no-apply", "--json"], { cwd: root, env, encoding: "utf8" });
  assert.equal(add.status, 0, add.stderr);
  const added = JSON.parse(add.stdout);
  assert.equal(added.provider.id, "cli-test");
  assert.equal(added.provider.headers["X-Org"], "[redacted]");
  const list = spawnSync(process.execPath, ["src/providers.mjs", "generic", "list", "--json"], { cwd: root, env, encoding: "utf8" });
  assert.equal(list.status, 0, list.stderr);
  assert.equal(JSON.parse(list.stdout).providers[0].id, "cli-test");

  const model = userModelEntry({
    providerId: "cli-test",
    upstreamId: "curated-model",
    priority: 100,
  });
  writeFileSync(
    env.MODEL_ROUTER_USER_MODELS,
    `${JSON.stringify({ version: 1, models: [model] }, null, 2)}\n`,
  );
  writeFileSync(
    env.MODEL_ROUTER_MODEL_PICKER_STATE,
    `${JSON.stringify({
      version: 1,
      hidden: [],
      visible: [model.slug],
      seeded: [model.slug],
    }, null, 2)}\n`,
  );

  const unsafeDrift = spawnSync(
    process.execPath,
    ["src/providers.mjs", "generic", "disable", "cli-test", "--no-apply"],
    { cwd: root, env, encoding: "utf8" },
  );
  assert.equal(unsafeDrift.status, 1);
  assert.match(unsafeDrift.stderr, /--no-apply is unsafe/);
  assert.equal(JSON.parse(readFileSync(path.join(env.CODEX_ROUTER_STATE_DIR, "generic-providers.json"), "utf8")).providers[0].enabled, true);

  const remove = spawnSync(
    process.execPath,
    ["src/providers.mjs", "generic", "remove", "cli-test", "--json"],
    { cwd: root, env, encoding: "utf8" },
  );
  assert.equal(remove.status, 0, remove.stderr);
  assert.equal(JSON.parse(remove.stdout).removed, "cli-test");
  assert.deepEqual(JSON.parse(readFileSync(env.MODEL_ROUTER_USER_MODELS, "utf8")).models, []);
  const picker = JSON.parse(readFileSync(env.MODEL_ROUTER_MODEL_PICKER_STATE, "utf8"));
  assert.deepEqual(picker.visible, []);
  assert.deepEqual(picker.hidden, []);
  assert.deepEqual(picker.seeded, []);
});

test("Ollama show origin and record derive only from an OpenAI-chat /v1 endpoint and an Ollama-shaped answer", () => {
  assert.equal(ollamaShowOrigin({ adapter: "openai-chat", baseUrl: "http://127.0.0.1:11434/v1" }), "http://127.0.0.1:11434");
  assert.equal(ollamaShowOrigin({ adapter: "openai-chat", baseUrl: "http://127.0.0.1:11434/v1/" }), "http://127.0.0.1:11434");
  assert.equal(ollamaShowOrigin({ adapter: "openai-chat", baseUrl: "https://gateway.example.test/openai" }), undefined);
  assert.equal(ollamaShowOrigin({ adapter: "openai-completions", baseUrl: "http://127.0.0.1:11434/v1" }), undefined);
  assert.equal(ollamaShowOrigin({ adapter: "openai-chat", baseUrl: "not a url" }), undefined);

  assert.deepEqual(
    ollamaShowRecord("glm:cloud", {
      capabilities: ["completion", "thinking", "tools"],
      model_info: { "general.architecture": "glm", "glm.context_length": 1048576, "glm.block_count": 1 },
    }),
    { id: "glm:cloud", context_length: 1048576, input_modalities: ["text"], supports_tools: true, supports_reasoning: true },
  );
  assert.deepEqual(
    ollamaShowRecord("vision:cloud", {
      capabilities: ["completion", "vision"],
      model_info: { "a.context_length": 512000, "b.context_length": 262144 },
    }),
    { id: "vision:cloud", context_length: 262144, input_modalities: ["text", "image"], supports_tools: false, supports_reasoning: false },
  );
  assert.equal(ollamaShowRecord("x", { model_info: { "a.context_length": "1048576" } })?.context_length, undefined);
  assert.equal(ollamaShowRecord("x", { data: [] }), undefined, "a non-Ollama answer is not a record");
  assert.equal(ollamaShowRecord("x", "{}"), undefined);
});

test("generic discovery fills context and modalities from an Ollama server's /api/show", async () => {
  const requests = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url, body: raw });
      response.writeHead(200, { "content-type": "application/json" });
      if (request.url === "/v1/models") {
        response.end(JSON.stringify({ object: "list", data: [
          { id: "glm:cloud", object: "model", owned_by: "library" },
          { id: "vision:cloud", object: "model", owned_by: "library" },
          { id: "embed:latest", object: "model", owned_by: "library" },
        ] }));
        return;
      }
      const { model } = JSON.parse(raw || "{}");
      if (model === "glm:cloud") {
        response.end(JSON.stringify({ capabilities: ["completion", "tools", "thinking"], model_info: { "glm.context_length": 1048576 } }));
      } else if (model === "vision:cloud") {
        response.end(JSON.stringify({ capabilities: ["completion", "vision", "tools"], model_info: { "q.context_length": 262144 } }));
      } else {
        response.end(JSON.stringify({ capabilities: ["embedding"], model_info: {} }));
      }
    });
  });
  const port = await listen(server);
  const providerId = "ollama-shaped";
  try {
    addGenericProvider({
      id: providerId,
      displayName: "Ollama shaped",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      adapter: "openai-chat",
      allowPrivate: true,
    });
    const discovery = await discoverGenericProviderModels(providerId, {
      cache: false,
      proxyResolvesDestination: false,
    });
    assert.deepEqual(discovery.discovered, ["embed:latest", "glm:cloud", "vision:cloud"].sort());
    assert.deepEqual(discovery.contextLengths, { "glm:cloud": 1048576, "vision:cloud": 262144 });
    assert.deepEqual(discovery.inputModalities, {
      "embed:latest": ["text"],
      "glm:cloud": ["text"],
      "vision:cloud": ["text", "image"],
    });
    const described = (id) => discovery.modelMetadata.find((entry) => entry.upstreamId === id);
    assert.equal(described("vision:cloud").supportsVision, true);
    assert.equal(Object.hasOwn(discovery.contextLengths, "embed:latest"), false, "an undescribed size stays absent, never guessed");
    const shows = requests.filter((r) => r.url === "/api/show");
    assert.equal(shows.length, 3);
    assert.ok(shows.every((r) => r.method === "POST"));
    assert.deepEqual(shows.map((r) => JSON.parse(r.body).model).sort(), ["embed:latest", "glm:cloud", "vision:cloud"]);
  } finally {
    removeGenericProvider(providerId);
    await closeServer(server);
  }
});

test("generic discovery stops asking /api/show after a server that is not Ollama refuses once", async () => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "a" }, { id: "b" }, { id: "c" }] }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end('{"error":"not found"}');
  });
  const port = await listen(server);
  const providerId = "plain-openai-compatible";
  try {
    addGenericProvider({
      id: providerId,
      displayName: "Plain OpenAI-compatible",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      adapter: "openai-chat",
      allowPrivate: true,
    });
    const discovery = await discoverGenericProviderModels(providerId, {
      cache: false,
      proxyResolvesDestination: false,
    });
    assert.deepEqual(discovery.discovered, ["a", "b", "c"]);
    assert.deepEqual(discovery.contextLengths, {});
    assert.deepEqual(discovery.inputModalities, {});
    assert.equal(requests.filter((r) => r.url === "/api/show").length, 1);
  } finally {
    removeGenericProvider(providerId);
    await closeServer(server);
  }
});

test("generic discovery keeps asking /api/show when one model is refused but the route exists", async () => {
  const shows = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      if (request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "broken-local:latest" }, { id: "fine:cloud" }] }));
        return;
      }
      const { model } = JSON.parse(raw || "{}");
      shows.push(model);
      if (model === "broken-local:latest") {
        // Ollama answers 400 for a model whose store it cannot open.
        response.writeHead(400, { "content-type": "application/json" });
        response.end('{"error":"mkdir /Volumes/T9-Cold: permission denied"}');
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ capabilities: ["completion", "tools"], model_info: { "m.context_length": 1048576 } }));
    });
  });
  const port = await listen(server);
  const providerId = "ollama-partly-broken";
  try {
    addGenericProvider({
      id: providerId,
      displayName: "Ollama partly broken",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      adapter: "openai-chat",
      allowPrivate: true,
    });
    const discovery = await discoverGenericProviderModels(providerId, {
      cache: false,
      proxyResolvesDestination: false,
    });
    assert.deepEqual(shows, ["broken-local:latest", "fine:cloud"]);
    assert.deepEqual(discovery.contextLengths, { "fine:cloud": 1048576 });
    assert.deepEqual(discovery.inputModalities, { "fine:cloud": ["text"] });
  } finally {
    removeGenericProvider(providerId);
    await closeServer(server);
  }
});

test("generic discovery stops asking /api/show after three leading transport failures", async () => {
  const { OLLAMA_SHOW_MAX_LEADING_REFUSALS } = await import("../src/generic-providers.mjs");
  const ids = ["a", "b", "c", "d", "e"];
  let showCalls = 0;
  const fetchImpl = async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/models")) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ data: ids.map((id) => ({ id })) }),
        text: async () => JSON.stringify({ data: ids.map((id) => ({ id })) }),
      };
    }
    showCalls += 1;
    throw new TypeError("fetch failed");
  };
  const providerId = "ollama-show-timeouts";
  try {
    addGenericProvider({
      id: providerId,
      displayName: "Ollama show timeouts",
      baseUrl: "http://127.0.0.1:11434/v1",
      adapter: "openai-chat",
      allowPrivate: true,
    });
    const discovery = await discoverGenericProviderModels(providerId, {
      fetchImpl,
      cache: false,
      proxyResolvesDestination: false,
    });
    assert.equal(showCalls, OLLAMA_SHOW_MAX_LEADING_REFUSALS);
    assert.deepEqual(discovery.discovered, ids);
    assert.deepEqual(discovery.contextLengths, {});
  } finally {
    removeGenericProvider(providerId);
  }
});
