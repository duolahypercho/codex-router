import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createExecutionPlan, routeExecution } from "../src/route-execution-plan.mjs";

const custom = { id: "custom", kind: "openai-compatible", authMode: "per-model", perModelEndpoint: true };
const providers = new Map([
  ["custom", custom],
  ["chat", { id: "chat", kind: "openai-compatible", baseUrl: "https://chat.example.test/v1" }],
  ["messages", { id: "messages", kind: "openai-compatible", protocol: "anthropic",
    baseUrl: "https://messages.example.test/v1" }],
  ["vertex", { id: "vertex", kind: "openai-compatible", protocol: "vertex",
    baseUrl: "https://aiplatform.example.test" }],
  ["local", { id: "local", kind: "openai-compatible", transport: "ollama", keyless: true,
    baseUrl: "http://127.0.0.1:11434/v1" }],
  ["lmstudio", { id: "lmstudio", kind: "openai-compatible", keyless: true,
    baseUrl: "http://127.0.0.1:1234/v1" }],
  ...["kimi-oauth", "grok-oauth", "antigravity-oauth", "devin-cli"].map((id) =>
    [id, { id, kind: "oauth" }]),
]);

// This fixture adapter follows the registry's per-model endpoint contract.
// The integration test below also uses the actual registry resolver, including
// its canonical DeepSeek override, rather than restating that condition here.
function providerForModel(model) {
  const provider = providers.get(model.provider);
  return provider?.perModelEndpoint
    ? { ...provider, protocol: model.endpoint?.protocol ?? "openai" }
    : provider;
}

function model(provider, id = "fixture", extra = {}) {
  return { slug: `${provider}/${id}`, gatewayModel: `${provider}-${id}`,
    upstreamModel: id, provider, listed: true, ...extra };
}

// These match the operator's public model/provider shape, with separate
// synthetic endpoints and credential references. No installed config is read.
function customModels() {
  return [
    model("custom", "grok-4.6", {
      endpoint: { protocol: "openai-responses", baseUrl: "https://lele.example.test/v1",
        credential: { file: "fixture-lele.secret", environment: ["FIXTURE_LELE_KEY"] } },
      inputModalities: ["text", "image"],
    }),
    model("custom", "z-ai/glm-5.3", {
      endpoint: { protocol: "openai-responses", baseUrl: "https://boyue.example.test/v1",
        credential: { file: "fixture-boyue.secret", environment: ["FIXTURE_BOYUE_KEY"] } },
      goalContinuationGuard: true, repetitionGuard: true,
    }),
  ];
}

function plan(models, extra = {}) {
  return createExecutionPlan({ models, providerForModel, ...extra });
}

test("native GPT execution has no provider lookup or downstream dependency", () => {
  const forbidden = () => { throw new Error("native looked up a routed provider"); };
  assert.deepEqual(routeExecution(undefined, { providerForModel: forbidden }),
    { transport: "native", services: [] });
  assert.deepEqual(routeExecution(null), { transport: "native", services: [] });
  const native = createExecutionPlan({ models: [], providerForModel: forbidden });
  assert.equal(native.needsGateway, false);
  assert.deepEqual(native.services, []);
  assert.match(native.fingerprint, /^[a-f0-9]{64}$/);
});

test("both custom Responses routes require only the API listener", () => {
  const routes = customModels();
  for (const route of routes) {
    assert.deepEqual(routeExecution(route, { providerForModel }),
      { transport: "direct-responses", services: ["api"] });
  }
  const result = plan(routes);
  assert.equal(result.needsGateway, false);
  assert.deepEqual(result.services, ["api"]);
});

test("one custom container can mix native Responses, Chat, and Messages endpoints", () => {
  const [responses] = customModels();
  const chat = model("custom", "chat", { endpoint: { baseUrl: "https://chat.example.test/v1", keyless: false } });
  const messages = model("custom", "messages", { endpoint: {
    protocol: "anthropic", baseUrl: "https://messages.example.test/v1" } });
  assert.equal(routeExecution(responses, { providerForModel }).transport, "direct-responses");
  assert.equal(routeExecution(chat, { providerForModel }).transport, "litellm");
  assert.equal(routeExecution(messages, { providerForModel }).transport, "litellm");
  assert.deepEqual(plan([responses, chat, messages]).services, ["api", "gateway"]);
});

test("the actual registry resolver supplies custom endpoint precedence and DeepSeek's override", (t) => {
  // An isolated child also makes this test safe for normal CI runners without
  // the local protected wrapper. Discovery stays off before any path import.
  const directory = mkdtempSync(path.join(os.tmpdir(), "route-plan-registry-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const home = path.join(directory, "codex");
  const state = path.join(directory, "state");
  const routes = [...customModels(), model("deepseek", "deepseek-flash"), model("deepseek", "deepseek-chat"),
    model("custom", "reseller-deepseek-flash", { endpoint: {
      baseUrl: "https://reseller.example.test/v1", protocol: "openai" } })];
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const paths = await import('./src/paths.mjs');
    if (paths.CODEX_HOME !== process.env.CODEX_HOME || paths.STATE_DIR !== process.env.MODEL_ROUTER_STATE_DIR) {
      throw new Error('Registry fixture escaped its isolated home/state');
    }
    const { providerForModel } = await import('./src/model-registry.mjs');
    const { routeExecution } = await import('./src/route-execution-plan.mjs');
    process.stdout.write(JSON.stringify(${JSON.stringify(routes)}.map(model => routeExecution(model, { providerForModel }))));
  `], { cwd: root, encoding: "utf8", env: {
    ...process.env, HOME: directory, USERPROFILE: directory,
    CODEX_HOME: home, MODEL_ROUTER_STATE_DIR: state, CODEX_ROUTER_STATE_DIR: state,
    CODEX_ROUTER_SOURCE_ROOT: root, MODEL_ROUTER_REGISTRY: path.join(root, "config"),
    MODEL_ROUTER_USER_MODELS: path.join(directory, "user-models.json"),
    MODEL_ROUTER_GENERIC_PROVIDERS: path.join(directory, "generic-providers.json"),
    CODEX_ROUTER_NO_DISCOVERY: "1",
  } });
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  assert.deepEqual(actual.slice(0, 2), [
    { transport: "direct-responses", services: ["api"] },
    { transport: "direct-responses", services: ["api"] },
  ]);
  assert.deepEqual(actual.slice(2).map((execution) => execution.transport), ["direct-responses", "litellm", "litellm"]);
});

test("selected hidden callable models still contribute their actual dependencies", () => {
  const routes = [customModels()[0], model("grok-oauth", "hidden", { listed: false, pickerHidden: true })];
  const result = plan(routes, { routeEnabled: (route) => ["custom", "grok-oauth"].includes(route.provider) });
  assert.deepEqual(result.services, ["api", "gateway", "grok"]);
  assert.equal(result.needsGateway, true);
  assert.notEqual(result.fingerprint, plan([routes[0]]).fingerprint);
});

test("selection injection includes protocol variants and excludes unselected containers", () => {
  const family = new Map([
    ["console", { id: "console", kind: "openai-compatible", baseUrl: "https://console.example.test/v1" }],
    ["console-responses", { id: "console-responses", variantOf: "console", kind: "openai-compatible",
      protocol: "openai-responses", baseUrl: "https://console.example.test/v1" }],
  ]);
  const routes = [model("console"), model("console-responses"), model("grok-oauth")];
  const familyResolver = (route) => family.get(route.provider);
  const result = createExecutionPlan({ models: routes, providerForModel: familyResolver,
    routeEnabled: (route) => {
      const provider = familyResolver(route);
      return provider && (provider.variantOf || provider.id) === "console";
    } });
  assert.deepEqual(result.services, ["api", "gateway"]);
  const variantOnly = createExecutionPlan({ models: routes, providerForModel: familyResolver,
    routeEnabled: (route) => route.provider === "console-responses" });
  assert.deepEqual(variantOnly.services, ["api"]);
  assert.equal(variantOnly.needsGateway, false);
  assert.notEqual(result.fingerprint, variantOnly.fingerprint);
});

test("generic enabled HTTP and WebSocket Responses descriptors use the same API boundary", () => {
  const generic = new Map([
    ["runtime-http", { id: "runtime-http", kind: "openai-compatible", generic: true,
      enabled: true, adapter: "openai-responses", protocol: "openai-responses",
      baseUrl: "https://http.example.test/v1", credentialRef: "cred_fixture_http" }],
    ["runtime-ws", { id: "runtime-ws", kind: "openai-compatible", generic: true,
      enabled: true, adapter: "openai-responses", protocol: "openai-responses", transport: "websocket",
      baseUrl: "https://ws.example.test/v1", credentialRef: "cred_fixture_ws" }],
    ["runtime-disabled", { id: "runtime-disabled", kind: "openai-compatible", generic: true,
      enabled: false, adapter: "openai-chat", protocol: "openai", baseUrl: "https://disabled.example.test/v1" }],
  ]);
  const routes = [...generic.keys()].map((id) => model(id));
  const result = createExecutionPlan({ models: routes, providerForModel: (route) => generic.get(route.provider),
    routeEnabled: (route) => generic.get(route.provider).enabled });
  assert.deepEqual(result.services, ["api"]);
  assert.equal(result.needsGateway, false);
  for (const route of routes.slice(0, 2)) {
    assert.equal(routeExecution(route, { providerForModel: (entry) => generic.get(entry.provider) }).transport,
      "direct-responses");
  }
  // Positive control: enabling the Chat descriptor adds a Python dependency.
  assert.deepEqual(createExecutionPlan({ models: routes, providerForModel: (route) => generic.get(route.provider) })
    .services, ["api", "gateway"]);
});

test("missing credentials do not remove selected API and OAuth error listeners", () => {
  const route = customModels()[0];
  Object.defineProperty(route.endpoint.credential, "value", {
    get() { throw new Error("must not read a literal credential"); },
  });
  const oauth = { id: "devin-cli", kind: "oauth" };
  Object.defineProperty(oauth, "configured", { get() { throw new Error("must not query credential readiness"); } });
  const resolver = (entry) => entry.provider === "devin-cli" ? oauth : providerForModel(entry);
  const result = createExecutionPlan({ models: [route, model("devin-cli", "selected")], providerForModel: resolver });
  assert.deepEqual(result.services, ["api", "devin", "gateway"]);
});

test("all supported OAuth routes retain exactly their listener plus the gateway", () => {
  for (const [id, listener] of [["kimi-oauth", "kimi"], ["grok-oauth", "grok"],
    ["antigravity-oauth", "antigravity"], ["devin-cli", "devin"]]) {
    assert.deepEqual(routeExecution(model(id), { providerForModel }),
      { transport: "litellm", services: [listener, "gateway"].sort() });
  }
});

test("local Ollama keeps its native adapter while LM Studio uses the API forwarder", () => {
  assert.deepEqual(routeExecution(model("local"), { providerForModel }),
    { transport: "litellm", services: ["gateway", "ollama"] });
  assert.deepEqual(routeExecution(model("lmstudio"), { providerForModel }),
    { transport: "litellm", services: ["api", "gateway"] });
  assert.deepEqual(plan([model("local"), model("lmstudio")]).services, ["api", "gateway", "ollama"]);
  // A future protocol flag must not silently bypass Ollama's num_ctx adapter.
  assert.equal(routeExecution(model("local"), { providerForModel: () => ({
    ...providers.get("local"), protocol: "openai-responses" }) }).transport, "litellm");
});

test("Chat, Anthropic, and Vertex translation all require API plus gateway", () => {
  for (const id of ["chat", "messages", "vertex"]) {
    assert.deepEqual(routeExecution(model(id), { providerForModel }),
      { transport: "litellm", services: ["api", "gateway"] });
  }
});

test("pending Antigravity proof gates readiness without changing the requestable route fingerprint", () => {
  const pending = plan([], { pendingAntigravity: true });
  assert.deepEqual(pending.services, ["antigravity"]);
  assert.equal(pending.needsGateway, false);
  assert.equal(pending.fingerprint, plan([]).fingerprint);
  const routed = customModels();
  const pendingWithRoutes = plan(routed, { pendingAntigravity: true });
  assert.deepEqual(pendingWithRoutes.services, ["antigravity", "api"]);
  assert.equal(pendingWithRoutes.fingerprint, plan(routed).fingerprint);
  const activated = plan([model("antigravity-oauth")], { pendingAntigravity: true });
  assert.deepEqual(activated.services, ["antigravity", "gateway"]);
  assert.equal(activated.fingerprint, plan([model("antigravity-oauth")]).fingerprint);
  assert.notEqual(activated.fingerprint, pending.fingerprint);
  assert.equal(activated.needsGateway, true);
});

test("fingerprints are stable under route and object-key order without mutating inputs", () => {
  const routes = customModels();
  const before = JSON.stringify(routes);
  const left = plan(routes);
  const reversed = routes.slice().reverse().map((route) => Object.fromEntries(Object.entries(route).reverse()));
  assert.equal(left.fingerprint, plan(reversed).fingerprint);
  assert.equal(JSON.stringify(routes), before);
  assert.ok(Object.isFrozen(left) && Object.isFrozen(left.services));
});

test("fingerprints detect additions, endpoint rebinding, protocol, profile, guards, and capabilities", () => {
  const [route] = customModels();
  const original = plan([route]);
  const changes = [
    { endpoint: { ...route.endpoint, baseUrl: "https://replacement.example.test/v1" } },
    { endpoint: { ...route.endpoint, protocol: "openai" } },
    { requestProfile: "omit-tool-choice" },
    { goalContinuationGuard: true },
    { repetitionGuard: true },
    { reasoningTagPolicy: "legacy-inline" },
    { toolSchemaRecursion: "flatten" },
    { defaultEffort: "high" },
    { reasoningLevels: [{ effort: "high", description: "Fixture high" }] },
    { contextWindow: 262144, autoCompact: 220000 },
    { inputModalities: ["text"] },
    { supportedEndpoints: ["/responses", "/embeddings"] },
    { supportsParallelToolCalls: true, experimentalSupportedTools: ["fixture-tool"] },
    { endpoint: { ...route.endpoint, credential: { ...route.endpoint.credential, file: "rebound.secret" } } },
  ];
  for (const changed of changes) {
    const candidate = plan([{ ...route, ...changed }]);
    assert.notEqual(candidate.fingerprint, original.fingerprint, `missed semantic change ${Object.keys(changed)}`);
  }
  assert.notEqual(plan(customModels()).fingerprint, original.fingerprint);
  assert.equal(plan([{ ...route, requestProfile: "omit-tool-choice" }]).needsGateway, false,
    "metadata changes must be detected even when service topology is unchanged");
});

test("fingerprints never depend on credential values, header values, or URL secrets", () => {
  const [route] = customModels();
  const make = (secret) => ({ ...route, endpoint: {
    ...route.endpoint,
    baseUrl: `https://fixture-user:${secret}@lele.example.test/v1?access_token=${secret}#${secret}`,
    credential: { ...route.endpoint.credential, value: secret, token: secret, apiKey: secret },
    apiKey: secret,
  }, accessToken: secret });
  assert.equal(plan([make("first-secret")]).fingerprint, plan([make("second-secret")]).fingerprint);
  const generic = (secret) => ({ id: "fixture-generic", kind: "openai-compatible", generic: true,
    protocol: "openai-responses", baseUrl: "https://generic.example.test/v1", headers: {
      "X-Deployment": secret }, credentialRef: "cred_fixture_public_reference", apiKey: secret, token: secret });
  const first = createExecutionPlan({ models: [model("fixture-generic")], providerForModel: () => generic("first") });
  const second = createExecutionPlan({ models: [model("fixture-generic")], providerForModel: () => generic("second") });
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(JSON.stringify(first).includes("first"), false);
  assert.equal(JSON.stringify(first).includes("cred_fixture"), false);
});

test("unknown or ambiguous selected routes fail before publication; excluded ones are not resolved", () => {
  assert.throws(() => routeExecution(model("unknown"), { providerForModel }), /registered provider/);
  assert.throws(() => routeExecution(model("unknown")), /effective providerForModel/);
  assert.throws(() => routeExecution(model("unknown"), { providerForModel: () => ({ id: "unknown", kind: "oauth" }) }),
    /known listener/);
  assert.throws(() => routeExecution(model("unknown"), { providerForModel: () => ({ id: "unknown", kind: "other" }) }),
    /unsupported provider kind/);
  assert.throws(() => plan([customModels()[0], customModels()[0]]), /duplicate model slugs/);
  const excluded = createExecutionPlan({ models: [model("unknown")], routeEnabled: () => false,
    providerForModel: () => { throw new Error("disabled provider was resolved"); } });
  assert.deepEqual(excluded.services, []);
});
