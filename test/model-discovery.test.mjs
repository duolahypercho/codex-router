import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Discovery compares fixtures with the checked-in registry. Keep a developer's
// locally curated models out of both this process and the child processes below
// before model-registry.mjs resolves the overlay path at import time.
const stateRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-model-discovery-test-"));
const originalUserModels = process.env.MODEL_ROUTER_USER_MODELS;
process.env.MODEL_ROUTER_USER_MODELS = path.join(stateRoot, "user-models.json");
after(() => {
  rmSync(stateRoot, { recursive: true, force: true });
  if (originalUserModels === undefined) delete process.env.MODEL_ROUTER_USER_MODELS;
  else process.env.MODEL_ROUTER_USER_MODELS = originalUserModels;
});

const { MODELS, PROVIDERS } = await import("../src/model-registry.mjs");
const { modelCatalogMetadata } = await import("../src/model-catalog-metadata.mjs");
const {
  discoverProviderModels,
  modelContextLengths,
  modelIds,
  providerAllowsPrivateDiscovery,
} = await import("../src/model-discovery.mjs");

test("private model discovery requires an explicit provider opt-in", () => {
  assert.equal(providerAllowsPrivateDiscovery({}), false);
  assert.equal(providerAllowsPrivateDiscovery({ allowPrivate: true }), true);
  assert.equal(providerAllowsPrivateDiscovery({ keyless: true }), true);
});

test("model discovery compares fixtures without needing or exposing a key", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-discovery-"));
  const fixture = path.join(testRoot, "models.json");
  writeFileSync(
    fixture,
    JSON.stringify({ data: [{ id: "deepseek-v4-pro" }, { id: "deepseek-v5-preview" }] }),
  );
  try {
    const output = execFileSync(
      process.execPath,
      ["src/model-discovery.mjs", "deepseek", "--fixture", fixture, "--json"],
      { cwd: root, encoding: "utf8", env: { ...process.env, DEEPSEEK_API_KEY: "" } },
    );
    const result = JSON.parse(output);
    assert.deepEqual(result.unregistered, ["deepseek-v5-preview"]);
    assert.deepEqual(result.addable, ["deepseek-v5-preview"]);
    assert.deepEqual(result.blocked, {});
    assert.ok(result.unavailable.includes("deepseek-v4-flash"));
    assert.doesNotMatch(output, /Bearer|api[_-]?key/i);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("OpenCode Go discovery blocks live ids whose protocol route is not certified", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-opencode-route-discovery-"));
  const fixture = path.join(testRoot, "models.json");
  writeFileSync(
    fixture,
    JSON.stringify({ data: [
      { id: "grok-4.5" },
      { id: "future-responses-only-model" },
      { id: "glm-5" },
      { id: "hy3-preview" },
    ] }),
  );
  try {
    const output = execFileSync(
      process.execPath,
      ["src/model-discovery.mjs", "opencode-go", "--fixture", fixture, "--json"],
      { cwd: root, encoding: "utf8", env: { ...process.env, OPENCODE_API_KEY: "" } },
    );
    const result = JSON.parse(output);
    assert.deepEqual(result.unregistered, ["future-responses-only-model", "hy3-preview"]);
    assert.deepEqual(result.addable, []);
    assert.deepEqual(Object.keys(result.blocked).sort(), result.unregistered);
    assert.ok(result.registered.includes("glm-5"));
    assert.match(
      result.blocked["future-responses-only-model"],
      /provider catalog lists future-responses-only-model.*has not verified whether the model uses Chat, Messages, or Responses.*router compatibility limitation.*future update/s,
    );
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("Command Code discovery parses the Provider API model list", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-commandcode-discovery-"));
  const fixture = path.join(testRoot, "models.json");
  writeFileSync(
    fixture,
    JSON.stringify({
      object: "list",
      data: [{ id: "deepseek/deepseek-v4-flash" }, { id: "claude-sonnet-4-6" }],
    }),
  );
  try {
    const output = execFileSync(
      process.execPath,
      ["src/model-discovery.mjs", "commandcode", "--fixture", fixture, "--json"],
      { cwd: root, encoding: "utf8", env: { ...process.env, COMMAND_CODE_API_KEY: "" } },
    );
    const result = JSON.parse(output);
    assert.deepEqual(result.unregistered, ["claude-sonnet-4-6"]);
    assert.deepEqual(result.addable, []);
    assert.deepEqual(Object.keys(result.blocked), ["claude-sonnet-4-6"]);
    assert.match(
      result.blocked["claude-sonnet-4-6"],
      /provider catalog lists claude-sonnet-4-6.*has not verified whether the model uses Chat or Messages.*router compatibility limitation.*future update/s,
    );
    assert.ok(result.unavailable.includes("deepseek/deepseek-v4-pro"));
    assert.doesNotMatch(output, /Bearer|api[_-]?key/i);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("Devin discovery accepts the account model-list adapter", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-devin-discovery-"));
  const fixture = path.join(testRoot, "models.json");
  writeFileSync(fixture, JSON.stringify({ data: [{ id: "swe-1" }, { id: "swe-2" }] }));
  try {
    const output = execFileSync(
      process.execPath,
      ["src/model-discovery.mjs", "devin-cli", "--fixture", fixture, "--json"],
      { cwd: root, encoding: "utf8", env: { ...process.env, DEVIN_CREDENTIALS_PATH: path.join(testRoot, "missing.toml") } },
    );
    const result = JSON.parse(output);
    assert.deepEqual(result.unregistered, ["swe-1", "swe-2"]);
    assert.deepEqual(result.registered, []);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("Copilot discovery exposes only account-enabled Responses models with tools", () => {
  const payload = {
    data: [
      {
        id: "gpt-responses",
        // Copilot CLI integrations currently receive picker=false even for
        // account-enabled models; policy is the account entitlement signal.
        model_picker_enabled: false,
        policy: { state: "enabled" },
        supported_endpoints: ["/responses", "/chat/completions"],
        capabilities: { supports: { tool_calls: true, streaming: true } },
      },
      {
        id: "chat-only",
        model_picker_enabled: true,
        policy: { state: "enabled" },
        supported_endpoints: ["/chat/completions"],
        capabilities: { supports: { tool_calls: true, streaming: true } },
      },
      {
        id: "no-tools",
        model_picker_enabled: true,
        policy: { state: "enabled" },
        supported_endpoints: ["/responses"],
        capabilities: { supports: { tool_calls: false, streaming: true } },
      },
      {
        id: "policy-disabled",
        model_picker_enabled: true,
        policy: { state: "disabled" },
        supported_endpoints: ["/responses"],
        capabilities: { supports: { tool_calls: true, streaming: true } },
      },
      {
        id: "utility",
        policy: { state: "unconfigured" },
        supported_endpoints: ["/responses"],
        capabilities: { supports: { tool_calls: true, streaming: true } },
      },
      {
        id: "accounts/router/internal",
        object: "model",
        model_picker_enabled: true,
        policy: { state: "enabled" },
        supported_endpoints: ["/responses"],
        capabilities: { type: "chat", supports: { tool_calls: true, streaming: true } },
      },
      {
        id: "embedding-record",
        object: "embedding",
        model_picker_enabled: true,
        policy: { state: "enabled" },
        supported_endpoints: ["/responses"],
        capabilities: { supports: { tool_calls: true, streaming: true } },
      },
      {
        id: "non-chat",
        object: "model",
        model_picker_enabled: true,
        policy: { state: "enabled" },
        supported_endpoints: ["/responses"],
        capabilities: { type: "embedding", supports: { tool_calls: true, streaming: true } },
      },
    ],
  };
  assert.deepEqual(modelIds(payload, PROVIDERS.get("github-copilot")), ["gpt-responses"]);
});

test("anonymous discovery keeps only each provider's documented free models", () => {
  const opencode = PROVIDERS.get("opencode-free");
  assert.deepEqual(
    modelIds({ data: [
      { id: "glm-5.1" },
      { id: "big-pickle" },
      { id: "mimo-v2.5-free" },
      { id: "accounts/internal" },
    ] }, opencode),
    ["big-pickle", "mimo-v2.5-free"],
  );
  const kilo = PROVIDERS.get("kilo-free");
  assert.deepEqual(
    modelIds({ data: [
      { id: "z-ai/glm-5:free" },
      { id: "minimax/minimax-m2.1:free" },
      { id: "tencent/hy4-preview" },
      { id: "z-ai/glm-5" },
    ] }, kilo),
    ["minimax/minimax-m2.1:free", "z-ai/glm-5:free"],
  );
});

test("the current OpenCode catalogs remain fully fetchable without preselecting Zen", () => {
  // Captured from the two official endpoints on 2026-08-26. Free/Zen stay
  // catalog-only, so this proves the live response is filtered at discovery
  // time instead of turning a changing remote list into checked-in defaults.
  const zenIds = [
    "big-pickle",
    "claude-fable-5",
    "deepseek-v4-flash-free",
    "gpt-5.6-sol",
    "hy3-free",
    "laguna-s-2.1-free",
    "mimo-v2.5-free",
    "muse-spark-1.2-contributor-free",
    "muse-spark-1.3-contributor-free",
    "nemotron-3-ultra-free",
    "nemotron-3.5-lightning-free",
    "x-preview-f-free",
  ];
  assert.deepEqual(
    modelIds({ data: zenIds.map((id) => ({ id })) }, PROVIDERS.get("opencode-free")),
    [
      "big-pickle",
      "deepseek-v4-flash-free",
      "hy3-free",
      "laguna-s-2.1-free",
      "mimo-v2.5-free",
      "muse-spark-1.2-contributor-free",
      "muse-spark-1.3-contributor-free",
      "nemotron-3-ultra-free",
      "nemotron-3.5-lightning-free",
      "x-preview-f-free",
    ],
  );

  const goLive = [
    "deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "deepseek-v4-pro", "glm-5", "glm-5.1", "glm-5.2", "glm-5.3", "glm-5.3-flash",
    "gpt-5.6-luna", "grok-4.5", "grok-4.6", "hy3", "hy3-preview", "kimi-k2.5", "kimi-k2.6",
    "kimi-k2.7-code", "kimi-k3", "longcat-2.0", "mimo-v2-omni", "mimo-v2-pro", "mimo-v2.5",
    "mimo-v2.5-pro", "minimax-m2.5", "minimax-m2.7", "minimax-m3",
    "muse-spark-1.2-contributor", "muse-spark-1.3-contributor", "qwen3.5-plus", "qwen3.6-plus",
    "qwen3.7-max", "qwen3.7-plus", "qwen3.8-flash", "qwen3.8-max",
  ];
  assert.deepEqual(
    modelIds({ data: goLive.map((id) => ({ id })) }, PROVIDERS.get("opencode-go")),
    [...goLive].sort(),
  );
});

test("the checked-in OpenCode Go set matches the official current-model table", () => {
  const documented = [
    "deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "deepseek-v4-pro", "glm-5", "glm-5.1", "glm-5.2", "glm-5.3", "glm-5.3-flash",
    "gpt-5.6-luna", "grok-4.5", "grok-4.6", "hy3", "hy4-preview", "kimi-k2.5", "kimi-k2.6", "kimi-k2.7-code", "kimi-k3", "longcat-2.0",
    "mimo-v2.5", "mimo-v2.5-pro", "minimax-m2.5", "minimax-m2.7", "minimax-m3",
    "muse-spark-1.2-contributor", "muse-spark-1.3-contributor", "qwen3.5-plus", "qwen3.6-plus", "qwen3.7-max",
    "qwen3.7-plus", "qwen3.8-flash", "qwen3.8-max",
  ].sort();
  const registered = MODELS
    .filter(({ provider }) => ["opencode-go", "opencode-go-messages", "opencode-go-responses"].includes(provider))
    .map(({ upstreamModel }) => upstreamModel)
    .sort();
  assert.deepEqual(registered, documented);
  for (const model of MODELS.filter(({ upstreamModel }) => documented.includes(upstreamModel))) {
    if (!model.provider.startsWith("opencode-go")) continue;
    assert.notEqual(model.multiAgentVersion, "v2", `${model.slug} lacks native Codex collaboration proof`);
  }
});

test("discovery reports the context length the provider advertises", () => {
  // Curation used to store 131072 for every model it added, including the
  // million-token ones, and Codex reads the auto-compact figure derived from
  // that number to decide when to summarize (#266). The catalog already says
  // how big each model is; the only reason it was guessed is that discovery
  // threw the answer away.
  const openrouter = PROVIDERS.get("openrouter");
  assert.deepEqual(
    modelContextLengths(
      {
        data: [
          { id: "openai/gpt-5.6-luna", context_length: 1_050_000 },
          { id: "deepseek/deepseek-v4-flash", context_length: 1_048_576 },
          // Silence is a legitimate answer and must not become a guess.
          { id: "vendor/unsized" },
          { id: "vendor/nonsense", context_length: "lots" },
          { id: "vendor/negative", context_length: -1 },
          { id: "vendor/fractional", context_length: 1024.5 },
        ],
      },
      openrouter,
    ),
    {
      "openai/gpt-5.6-luna": 1_050_000,
      "deepseek/deepseek-v4-flash": 1_048_576,
    },
  );
});

test("the served context length wins over the model's nominal one", () => {
  // OpenRouter records carry both: `context_length` is what the model can do
  // and `top_provider.context_length` is what the endpoint behind this id will
  // actually accept. Storing the larger one would advertise capacity the
  // request path cannot use.
  assert.deepEqual(
    modelContextLengths(
      { data: [{ id: "z-ai/glm-5", context_length: 200_000, top_provider: { context_length: 131_072 } }] },
      PROVIDERS.get("openrouter"),
    ),
    { "z-ai/glm-5": 131_072 },
  );
});

test("context lengths are reported only for models discovery kept", () => {
  // A filtered-out record's size is not this provider's answer about anything,
  // and storing it would size a model the picker never offers.
  assert.deepEqual(
    modelContextLengths(
      {
        data: [
          { id: "z-ai/glm-5:free", context_length: 200_000 },
          { id: "z-ai/glm-5", context_length: 200_000 },
        ],
      },
      PROVIDERS.get("kilo-free"),
    ),
    { "z-ai/glm-5:free": 200_000 },
  );
});

test("Copilot advertises its window under the capability limits", () => {
  assert.deepEqual(
    modelContextLengths(
      {
        data: [
          {
            id: "gpt-responses",
            policy: { state: "enabled" },
            supported_endpoints: ["/responses"],
            capabilities: {
              supports: { tool_calls: true, streaming: true },
              limits: { max_context_window_tokens: 128_000 },
            },
          },
        ],
      },
      PROVIDERS.get("github-copilot"),
    ),
    { "gpt-responses": 128_000 },
  );
});

test("OpenRouter metadata preserves exact context, modalities, tools, and effort controls", () => {
  const metadata = modelCatalogMetadata({ data: [{
    id: "vendor/reasoner",
    context_length: 1_000_000,
    top_provider: { context_length: 900_000, max_completion_tokens: 128_000 },
    architecture: {
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
    },
    supported_parameters: ["tools", "tool_choice", "reasoning_effort"],
    reasoning: {
      mandatory: true,
      default_enabled: true,
      supported_efforts: ["max", "high", "low"],
      default_effort: "high",
    },
  }] }, PROVIDERS.get("openrouter"));
  assert.deepEqual(metadata["vendor/reasoner"], {
    contextWindow: 900_000,
    maxOutputTokens: 128_000,
    inputModalities: ["image", "text"],
    outputModalities: ["text"],
    supportsTools: true,
    supportsToolChoice: true,
    reasoning: {
      supported: true,
      configurable: true,
      supportedEfforts: ["low", "high", "max"],
      defaultEffort: "high",
      mandatory: true,
      defaultEnabled: true,
    },
    metadataSource: "provider-catalog",
  });
});

test("Venice preserves its Ox Alpha advertisement for operator curation", () => {
  const metadata = modelCatalogMetadata({ data: [{
    id: "stealth-ox-alpha",
    context_length: 1_048_576,
    type: "text",
    model_spec: {
      availableContextTokens: 1_048_576,
      maxCompletionTokens: 131_072,
      capabilities: {
        supportsFunctionCalling: true,
        supportsReasoning: true,
        supportsReasoningEffort: true,
        reasoningEffortOptions: ["none", "low", "medium", "high"],
        defaultReasoningEffort: "high",
        supportsVision: true,
        supportsAudioInput: false,
        supportsVideoInput: true,
      },
    },
  }] }, PROVIDERS.get("venice"))["stealth-ox-alpha"];
  assert.equal(metadata.contextWindow, 1_048_576);
  assert.equal(metadata.maxOutputTokens, 131_072);
  assert.deepEqual(metadata.reasoning.supportedEfforts, ["none", "low", "medium", "high"]);
  assert.equal(metadata.reasoning.defaultEffort, "high");
  assert.equal(metadata.reasoning.advertisedSupportedEfforts, undefined);
  assert.equal(metadata.reasoning.effectiveMetadataSource, undefined);
});

test("documented supplements do not invent MiniMax or OpenCode effort controls", () => {
  const minimax = modelCatalogMetadata(
    { data: [{ id: "MiniMax-M3" }, { id: "MiniMax-M2.7-highspeed" }] },
    PROVIDERS.get("minimax-token-plan"),
  );
  assert.equal(minimax["MiniMax-M3"].contextWindow, 1_000_000);
  assert.equal(minimax["MiniMax-M2.7-highspeed"].contextWindow, 204_800);
  assert.deepEqual(minimax["MiniMax-M3"].reasoning, { supported: true, configurable: false });

  const opencode = modelCatalogMetadata(
    { data: [{ id: "muse-spark-1.2-contributor-free" }, { id: "big-pickle" }] },
    PROVIDERS.get("opencode-free"),
  );
  // muse-spark-1.2-contributor-free is a Responses model, so it's not directly
  // in opencode-free; this tests that discovery doesn't invent effort controls.
  assert.equal(opencode["big-pickle"], undefined);
});

test("live discovery never rewrites native GPT catalog metadata", async () => {
  const nativeModel = MODELS.find((model) => model.slug === "commandcode/gpt-5.6-sol");
  assert.ok(nativeModel, "the checked-in GPT model is present");
  const before = structuredClone(nativeModel);
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-native-preservation-"));
  const fixture = path.join(testRoot, "models.json");
  writeFileSync(fixture, JSON.stringify({ data: [{ id: "gpt-5.6-sol", context_length: 8 }] }));
  const previousArgv = process.argv.slice();
  process.argv.push("--fixture", fixture);
  try {
    const result = await discoverProviderModels("commandcode", { cache: false });
    assert.deepEqual(result.discovered, ["gpt-5.6-sol"]);
    assert.deepEqual(MODELS.find((model) => model.slug === nativeModel.slug), before);
  } finally {
    process.argv.splice(0, process.argv.length, ...previousArgv);
    rmSync(testRoot, { recursive: true, force: true });
  }
});
