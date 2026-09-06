import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { protectPrivateFile } from "./file-security.mjs";
import { LITELLM_CONFIG_PATH } from "./paths.mjs";
import { MODELS, providerForModel } from "./model-registry.mjs";
import { assertStateOwnership } from "./state-owner.mjs";
import { vertexAdapterForModel } from "./vertex-adapters.mjs";

// Big enough for real Codex turns, small enough that a small model stays
// entirely on the GPU of a 16 GB machine.
const LOCAL_NUM_CTX = 16384;

function yamlString(value) {
  return JSON.stringify(String(value));
}

export function renderLiteLlmConfig() {
  const lines = ["model_list:"];
  for (const model of MODELS) {
    const provider = providerForModel(model);
    const vertexAdapter = vertexAdapterForModel(model, provider);
    // A local model is routed with Ollama's own protocol rather than its
    // OpenAI-compatible surface, purely so `num_ctx` can be set. That surface
    // ignores it, and Ollama then reserves the model's maximum context: on a
    // 3B model that is a ~15 GB KV cache for ~2 GB of weights, which overflows
    // a 16 GB machine and pushes inference onto the CPU. Measured here, the
    // same model went from 17 GB and 43% CPU to 3.1 GB entirely on the GPU,
    // and from ~35 s to under 10 s for the same reply.
    if (provider.keyless && provider.transport === "ollama") {
      lines.push(
        `  - model_name: ${yamlString(model.gatewayModel)}`,
        "    litellm_params:",
        `      model: ${yamlString(`ollama_chat/${model.upstreamModel}`)}`,
        `      api_base: ${yamlString(`os.environ/${provider.baseUrlEnv}_ROOT`)}`,
        `      num_ctx: ${LOCAL_NUM_CTX}`,
        // LiteLLM defaults to two router retries and currently maps Ollama's
        // deterministic context-window rejection to APIConnectionError. That
        // makes one prompt hit the local runtime three times before Codex sees
        // a generic 500. Local inference is already reached over loopback and
        // Codex owns its own retry policy, so keep the deployment single-shot.
        // The router translates the specific context rejection into a
        // non-retryable context_length_exceeded response.
        "      num_retries: 0",
        "",
      );
      continue;
    }
    const apiBaseEnv = vertexAdapter?.liteLlmBaseEnv || (provider.kind === "oauth"
      ? provider.proxyBaseEnv
      : provider.protocol === "anthropic"
        ? "CODEX_ROUTER_ANTHROPIC_FORWARD_BASE_URL"
        : "CODEX_ROUTER_API_FORWARD_BASE_URL");
    const translatedModel =
      provider.kind === "oauth" ? model.upstreamModel : model.gatewayModel;
    const protocol = vertexAdapter?.liteLlmProtocol ||
      (provider.protocol === "anthropic" ? "anthropic" : "openai");
    const responsesSurface = provider.protocol === "openai-responses";
    lines.push(
      `  - model_name: ${yamlString(model.gatewayModel)}`,
      "    litellm_params:",
      `      model: ${yamlString(
        `${protocol}/${responsesSurface ? "responses/" : ""}${translatedModel}`,
      )}`,
      `      api_base: ${yamlString(`os.environ/${apiBaseEnv}`)}`,
      '      api_key: "os.environ/CODEX_ROUTER_INTERNAL_KEY"',
      ...(responsesSurface ? [] : ["      use_chat_completions_api: true"]),
      "",
    );
  }
  lines.push(
    "litellm_settings:",
    "  drop_params: true",
    "  request_timeout: 600",
    "",
    // Every model_name above has exactly one deployment, so a cooldown can
    // never route around a failure -- it can only hide it. LiteLLM cools a
    // deployment down on a 401 and then answers with its own 429 "No
    // deployments available", which the router translates into "provider is
    // rate-limiting, wait a bit and retry": the one piece of advice that cannot
    // fix a rejected credential. Relay the provider's real status instead.
    "router_settings:",
    "  disable_cooldowns: true",
    // Z.ai Coding Plan reports a five-hour account quota as HTTP 429. LiteLLM
    // otherwise retries that same exhausted plan twice before the outer router
    // can inspect the provider body and classify it as out_of_usage. Scope the
    // override to Coding Plan model groups only: pay-per-token Z.ai and every
    // other provider retain LiteLLM's normal transient rate-limit behavior.
    "  model_group_retry_policy:",
    ...MODELS.filter(({ provider }) => provider === "zai-coding").flatMap((model) => [
      `    ${model.gatewayModel}:`,
      "      RateLimitErrorRetries: 0",
    ]),
    "",
    "general_settings:",
    "  disable_spend_logs: true",
    "",
  );
  return lines.join("\n");
}

export function writeLiteLlmConfig(target = LITELLM_CONFIG_PATH) {
  // Only guard the managed path. Tests and tooling that render to an explicit
  // temporary file are not touching the live gateway config.
  if (target === LITELLM_CONFIG_PATH) {
    assertStateOwnership("write the gateway routing config");
  }
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp.${process.pid}`;
  writeFileSync(temporary, renderLiteLlmConfig(), { encoding: "utf8", mode: 0o600 });
  protectPrivateFile(temporary);
  renameSync(temporary, target);
  protectPrivateFile(target);
  return target;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = writeLiteLlmConfig();
  process.stdout.write(`${JSON.stringify({ path: target, models: MODELS.length })}\n`);
}
