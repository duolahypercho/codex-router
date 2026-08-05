import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { protectPrivateFile } from "./file-security.mjs";
import { LITELLM_CONFIG_PATH } from "./paths.mjs";
import { MODELS, providerForModel } from "./model-registry.mjs";
import { assertStateOwnership } from "./state-owner.mjs";

function yamlString(value) {
  return JSON.stringify(String(value));
}

export function renderLiteLlmConfig() {
  const lines = ["model_list:"];
  for (const model of MODELS) {
    const provider = providerForModel(model);
    const protocolSurface = model.protocol || provider.protocol;
    const apiBaseEnv = provider.kind === "oauth"
      ? provider.proxyBaseEnv
      : provider.protocol === "anthropic"
        ? "CODEX_ROUTER_ANTHROPIC_FORWARD_BASE_URL"
        : "CODEX_ROUTER_API_FORWARD_BASE_URL";
    const translatedModel =
      provider.kind === "oauth" ? model.upstreamModel : model.gatewayModel;
    const protocol = protocolSurface === "anthropic" ? "anthropic" : "openai";
    const responsesSurface = protocolSurface === "openai-responses";
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
