import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  anonymousModelAllowed,
  MODELS,
  PROVIDERS,
  resolveProviderBaseUrl,
} from "./model-registry.mjs";
import { credentialStatus, resolveProviderCredential } from "./provider-credentials.mjs";
import {
  ensureFreshGitHubCopilotSession,
  githubCopilotCatalogHeaders,
} from "./github-copilot-session.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

export function modelIds(payload, provider) {
  const data = Array.isArray(payload) ? payload : payload?.data;
  if (!Array.isArray(data)) throw new Error("The provider returned an invalid model list.");
  const candidates = provider?.authMode === "anonymous"
    ? data.filter((item) => anonymousModelAllowed(provider, item?.id))
    : provider?.authProfile === "github-copilot"
    ? data.filter((item) =>
        typeof item?.id === "string" &&
        !item.id.startsWith("accounts/") &&
        (item.object === undefined || item.object === "model") &&
        (item.capabilities?.type === undefined || item.capabilities.type === "chat") &&
        item?.policy?.state === "enabled" &&
        item?.capabilities?.supports?.tool_calls === true &&
        item?.capabilities?.supports?.streaming !== false &&
        Array.isArray(item?.supported_endpoints) &&
        item.supported_endpoints.includes("/responses")
      )
    : data;
  return [...new Set(candidates.map((item) => String(item?.id || "").trim()).filter(Boolean))].sort();
}

// What a provider says one model's context window is, or undefined when it says
// nothing usable. OpenAI-compatible catalogs disagree about the key: OpenRouter
// and most resellers publish `context_length` and repeat the figure the chosen
// endpoint actually serves under `top_provider`, Copilot puts it in
// `capabilities.limits`, and a few spell it `context_window`.
//
// When more than one is present they are not alternatives, they are limits at
// different scopes, and the smallest one is the only one the request path can
// rely on: a model that can do 200K reached through an endpoint that serves
// 131K is a 131K model here. Anything that is not a positive integer is treated
// as silence -- a string, a float, or a zero is a catalog quirk, not a size.
function advertisedContextLength(item) {
  let smallest;
  for (const value of [
    item?.context_length,
    item?.top_provider?.context_length,
    item?.context_window,
    item?.capabilities?.limits?.max_context_window_tokens,
  ]) {
    if (!Number.isInteger(value) || value < 1) continue;
    if (smallest === undefined || value < smallest) smallest = value;
  }
  return smallest;
}

// Model id -> advertised context window, for the models `modelIds` kept. A
// model the provider filtered out has no answer worth carrying, and a model
// the provider sized in silence is absent rather than guessed: curation falls
// back to its conservative default only when nothing was advertised.
export function modelContextLengths(payload, provider) {
  const data = Array.isArray(payload) ? payload : payload?.data;
  if (!Array.isArray(data)) return {};
  const kept = new Set(modelIds(payload, provider));
  const lengths = {};
  for (const item of data) {
    const id = String(item?.id || "").trim();
    if (!id || !kept.has(id) || id in lengths) continue;
    const length = advertisedContextLength(item);
    if (length !== undefined) lengths[id] = length;
  }
  return lengths;
}

async function providerPayload(provider) {
  const fixture = option("--fixture");
  if (fixture) return JSON.parse(readFileSync(path.resolve(fixture), "utf8"));
  const credential = resolveProviderCredential(provider);
  if (!credential) throw new Error(credentialStatus(provider).setup);
  // The same loopback guard the api-forwarder applies: a keyless provider's
  // placeholder credential passes the check above, so an unguarded override
  // would send `Bearer local` to whatever host the environment names.
  let baseUrl = resolveProviderBaseUrl(provider).baseUrl;
  let headers = provider.authMode === "anonymous"
    ? {}
    : provider.protocol === "anthropic"
    ? { "x-api-key": credential.value, "anthropic-version": "2023-06-01" }
    : { Authorization: `Bearer ${credential.value}` };
  if (provider.authProfile === "github-copilot") {
    const session = await ensureFreshGitHubCopilotSession(credential.value);
    if (!process.env[provider.baseUrlEnv]) baseUrl = session.baseUrl;
    headers = {
      ...githubCopilotCatalogHeaders(session.token),
    };
  }
  const response = await fetch(`${baseUrl}/models`, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error?.message || `Provider model discovery returned HTTP ${response.status}.`);
  }
  return payload;
}

export async function discoverProviderModels(providerId) {
  const provider = PROVIDERS.get(providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);
  // Discovery asks one endpoint what it serves. A per-model-endpoint provider
  // is not an endpoint, so there is no single host to ask and no answer that
  // would mean anything for the models under it. Refusing beats picking one of
  // its models' addresses and reporting that as the provider's catalog.
  if (provider.perModelEndpoint) {
    throw new Error(
      `${provider.displayName} has no endpoint of its own; each of its models names one. ` +
        "Discovery runs against a single endpoint, so there is nothing to list here.",
    );
  }
  if (provider.kind !== "openai-compatible") {
    throw new Error(`${provider.displayName} does not expose a supported model-list endpoint.`);
  }
  const payload = await providerPayload(provider);
  const discovered = modelIds(payload, provider);
  const registered = MODELS
    .filter((model) => model.provider === providerId)
    .map((model) => model.upstreamModel)
    .sort();
  const discoveredSet = new Set(discovered);
  const registeredSet = new Set(registered);
  return {
    provider: providerId,
    discovered,
    registered,
    unregistered: discovered.filter((id) => !registeredSet.has(id)),
    unavailable: registered.filter((id) => !discoveredSet.has(id)),
    // Sizing the provider published for itself. Curation stores it rather than
    // guessing a window for a model whose catalog entry already names one.
    contextLengths: modelContextLengths(payload, provider),
    note: "Discovery never edits the registry. New models must pass the live compatibility test before they are listed in Codex.",
  };
}

async function main() {
  if (process.argv.includes("--help")) {
    process.stdout.write(`Usage: discover-models PROVIDER [--fixture FILE] [--json]

Queries a provider's official /models endpoint and compares it with
the checked-in config/ registry tree. Credential values are never printed or written.
`);
    return;
  }
  const providerId = process.argv.slice(2).find((value) => !value.startsWith("--") && value !== option("--fixture"));
  if (!providerId) throw new Error("Pass a provider id, such as anthropic-api, deepseek, grok-api, or kimi-api.");
  const result = await discoverProviderModels(providerId);
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${result.provider}: ${result.discovered.length} models discovered\n`);
    process.stdout.write(`Registered: ${result.registered.join(", ") || "none"}\n`);
    process.stdout.write(`New candidates: ${result.unregistered.join(", ") || "none"}\n`);
    process.stdout.write(`Unavailable registered ids: ${result.unavailable.join(", ") || "none"}\n`);
    process.stdout.write(`${result.note}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
