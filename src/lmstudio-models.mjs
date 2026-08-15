import { PROVIDERS, resolveProviderBaseUrl } from "./model-registry.mjs";
import {
  disableProvider,
  enableProvider,
  readProviderSelection,
} from "./provider-selection.mjs";
import { readUserModels, userModelEntry, writeUserModels } from "./user-models.mjs";

// LM Studio is the operator's own software serving models it already manages,
// so the router only ever reads and reports what the server offers -- the same
// stance local-models.mjs takes toward Ollama. Loading and unloading weights
// stays in LM Studio; checking a model here only publishes it to the picker.

export const LMSTUDIO_PROVIDER_ID = "lmstudio";

// After the Ollama local block (900): both are local, and LM Studio models are
// curated with less verification, so they sort last.
const LMSTUDIO_MODEL_PRIORITY = 950;

// A loopback server either answers immediately or is not running; waiting the
// full discovery timeout would hold the whole panel snapshot hostage to a
// server that is simply off.
const PROBE_TIMEOUT_MS = 3000;

// Same reasoning as the Ollama constants in local-models.mjs: Codex sizes its
// prompts to the advertised window, and a local model asked for a 128K prompt
// spills its KV cache out of GPU memory. LM Studio sizes the real allocation
// in its own settings; this only caps what Codex sends.
const LMSTUDIO_CONTEXT_WINDOW = 32768;
const LMSTUDIO_AUTO_COMPACT = 28000;

function lmstudioProvider() {
  return PROVIDERS.get(LMSTUDIO_PROVIDER_ID);
}

export function curatedLmstudioModels(models = readUserModels()) {
  return models.filter((model) => model.provider === LMSTUDIO_PROVIDER_ID);
}

export function isLmstudioModelEnabled(id, models = readUserModels()) {
  const value = String(id || "").trim();
  return curatedLmstudioModels(models).some((model) => model.upstreamModel === value);
}

// What the server is serving right now, straight from its OpenAI-compatible
// /models endpoint. Unreachable is a state, not an error: the panel shows
// "not running" instead of losing the section.
export async function lmstudioServedModels({
  fetchImpl = fetch,
  timeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  const provider = lmstudioProvider();
  if (!provider) return { reachable: false, baseUrl: undefined, models: [] };
  const { baseUrl } = resolveProviderBaseUrl(provider);
  try {
    const response = await fetchImpl(`${baseUrl}/models`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { reachable: false, baseUrl, models: [] };
    const payload = await response.json().catch(() => ({}));
    const data = Array.isArray(payload) ? payload : payload?.data;
    const ids = Array.isArray(data)
      ? [...new Set(data.map((item) => String(item?.id || "").trim()).filter(Boolean))].sort()
      : [];
    return { reachable: true, baseUrl, models: ids };
  } catch {
    return { reachable: false, baseUrl, models: [] };
  }
}

// The panel's view of LM Studio: everything the server serves, everything the
// picker publishes, and the difference between them. A curated model the
// server no longer serves stays visible as `served: false` -- hiding it would
// leave a route in the picker with no way to see or clear it here.
export async function lmstudioSnapshot({
  fetchImpl,
  timeoutMs,
  userModels = readUserModels(),
} = {}) {
  const provider = lmstudioProvider();
  const served = await lmstudioServedModels({
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  const curated = curatedLmstudioModels(userModels);
  const curatedIds = new Set(curated.map((model) => model.upstreamModel));
  const servedSet = new Set(served.models);
  const models = [
    ...served.models.map((id) => ({ id, enabled: curatedIds.has(id), served: true })),
    ...curated
      .filter((model) => !servedSet.has(model.upstreamModel))
      .map((model) => ({ id: model.upstreamModel, enabled: true, served: false })),
  ].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  let providerEnabled;
  try {
    providerEnabled = readProviderSelection().includes(LMSTUDIO_PROVIDER_ID);
  } catch {
    providerEnabled = undefined;
  }
  return {
    provider: LMSTUDIO_PROVIDER_ID,
    displayName: provider?.displayName || "LM Studio",
    reachable: served.reachable,
    baseUrl: served.baseUrl,
    enabled: models.filter((model) => model.enabled).length,
    providerEnabled,
    models,
  };
}

// Deliberately failure-tolerant for the same reason as the Ollama twin: the
// selection file is shared state, and a checkbox that publishes the model but
// cannot flip the provider beats one that fails outright.
export function syncLmstudioProviderSelection(shouldEnable) {
  try {
    const enabled = readProviderSelection().includes(LMSTUDIO_PROVIDER_ID);
    if (shouldEnable && !enabled) enableProvider(LMSTUDIO_PROVIDER_ID);
    if (!shouldEnable && enabled) disableProvider(LMSTUDIO_PROVIDER_ID);
    return shouldEnable;
  } catch {
    return undefined;
  }
}

// Checking a model publishes it through the same user-model overlay that
// `curate-models lmstudio` writes, so the panel and the interactive CLI are
// two doors to one state -- neither can strand the other's entries.
export function setLmstudioModelEnabled(id, enabled) {
  const value = String(id || "").trim();
  if (!value) throw new Error("A model id is required.");
  const existing = readUserModels();
  const others = existing.filter((model) => model.provider !== LMSTUDIO_PROVIDER_ID);
  const mine = existing.filter(
    (model) => model.provider === LMSTUDIO_PROVIDER_ID && model.upstreamModel !== value,
  );
  const next = enabled
    ? [
        ...mine,
        {
          ...userModelEntry({
            providerId: LMSTUDIO_PROVIDER_ID,
            upstreamId: value,
            priority: LMSTUDIO_MODEL_PRIORITY,
            metadata: {
              contextWindow: LMSTUDIO_CONTEXT_WINDOW,
              autoCompact: LMSTUDIO_AUTO_COMPACT,
              description: `${value} served by LM Studio on this machine.`,
            },
          }),
          // "experimental" is a promise AGENTS.md forbids dropping: driving a
          // Codex turn locally is unproven per-model, and nothing here has
          // verified this one can dispatch tool calls at all.
          displayName: `${value} (LM Studio, experimental)`,
          // The same conservative choices the Ollama publish path makes, for
          // the same reasons: apply_patch is a freeform custom tool with no
          // clean representation in an OpenAI-compatible tool schema, and no
          // local model has been shown here to drive subagents.
          supportsApplyPatchTool: false,
          multiAgentVersion: "v1",
        },
      ]
    : mine;
  // Renumbered on every write rather than assigned once: a priority derived
  // from the list length at toggle time collides after a disable/re-enable
  // cycle (enable A,B,C; disable B; re-enable B lands on C's number). Kept as
  // a renumber, not a rebuild, so metadata curate-models asked for survives.
  const entries = next.map((entry, index) => ({
    ...entry,
    priority: LMSTUDIO_MODEL_PRIORITY + index,
  }));
  writeUserModels([...others, ...entries]);
  syncLmstudioProviderSelection(entries.length > 0);
  return entries;
}
