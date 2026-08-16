import { PROVIDERS, resolveProviderBaseUrl } from "./model-registry.mjs";
import {
  disableProvider,
  enableProvider,
  readProviderSelection,
} from "./provider-selection.mjs";
import { readUserModels, userModelEntry, writeUserModels } from "./user-models.mjs";

// The panel's view of Cursor, built the way lmstudio-models.mjs builds LM
// Studio's: everything the account can spend, everything the picker publishes,
// and the difference between them.
//
// The list is read from the *bridge*, not from `cursor-agent` -- the panel
// refreshes on a timer, and shelling out to the CLI on each pass would put a
// network round trip to Cursor behind every poll. The bridge already caches
// that answer, so this stays a loopback GET exactly like LM Studio's.

export const CURSOR_PROVIDER_ID = "cursor-cli";

// After the LM Studio block (950). Cursor models are curated with no
// verification of their own, and they cannot drive a Codex turn, so they sort
// last of all.
const CURSOR_MODEL_PRIORITY = 980;

// The bridge either answers immediately or is not running; the panel must not
// block on it.
const PROBE_TIMEOUT_MS = 4000;

// Cursor sizes context per model and per parameter override, and the router
// has no way to ask which. Codex sizes its prompts to whatever is advertised,
// so under-promise: a turn that fits is better than one the upstream truncates.
const CURSOR_CONTEXT_WINDOW = 128000;
const CURSOR_AUTO_COMPACT = 110000;

function cursorProvider() {
  return PROVIDERS.get(CURSOR_PROVIDER_ID);
}

export function curatedCursorModels(models = readUserModels()) {
  return models.filter((model) => model.provider === CURSOR_PROVIDER_ID);
}

export function isCursorModelEnabled(id, models = readUserModels()) {
  const value = String(id || "").trim();
  return curatedCursorModels(models).some((model) => model.upstreamModel === value);
}

/**
 * What the account can spend right now, straight from the bridge.
 *
 * Three outcomes, and the panel needs to tell them apart because the fixes are
 * different: the bridge is not running (start the service), the bridge is up
 * but cursor-agent is signed out (press Sign in), or here is the list. A 503
 * carries the CLI's own reason, so it is passed through rather than replaced
 * with a guess.
 */
export async function cursorServedModels({
  fetchImpl = fetch,
  timeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  const provider = cursorProvider();
  if (!provider) return { reachable: false, signedIn: false, models: [] };
  const { baseUrl } = resolveProviderBaseUrl(provider);
  try {
    const response = await fetchImpl(`${baseUrl}/models`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        reachable: true,
        signedIn: false,
        baseUrl,
        models: [],
        detail: payload?.error?.message || `the bridge answered HTTP ${response.status}`,
      };
    }
    const data = Array.isArray(payload) ? payload : payload?.data;
    const ids = Array.isArray(data)
      ? [...new Set(data.map((item) => String(item?.id || "").trim()).filter(Boolean))].sort()
      : [];
    return { reachable: true, signedIn: true, baseUrl, models: ids };
  } catch {
    return {
      reachable: false,
      signedIn: false,
      baseUrl,
      models: [],
      detail: "the Cursor bridge is not running",
    };
  }
}

export async function cursorSnapshot({
  fetchImpl,
  timeoutMs,
  userModels = readUserModels(),
} = {}) {
  const provider = cursorProvider();
  const served = await cursorServedModels({
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  const curated = curatedCursorModels(userModels);
  const curatedIds = new Set(curated.map((model) => model.upstreamModel));
  const servedSet = new Set(served.models);
  // A curated model the account no longer offers stays visible as
  // `served: false`. Hiding it would leave a route in the picker with no way
  // to see or clear it from here -- the same rule the LM Studio panel follows.
  const models = [
    ...served.models.map((id) => ({ id, enabled: curatedIds.has(id), served: true })),
    ...curated
      .filter((model) => !servedSet.has(model.upstreamModel))
      .map((model) => ({ id: model.upstreamModel, enabled: true, served: false })),
  ].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  let providerEnabled;
  try {
    providerEnabled = readProviderSelection().includes(CURSOR_PROVIDER_ID);
  } catch {
    providerEnabled = undefined;
  }
  return {
    provider: CURSOR_PROVIDER_ID,
    displayName: provider?.displayName || "Cursor CLI",
    reachable: served.reachable,
    signedIn: served.signedIn,
    ...(served.detail ? { detail: served.detail } : {}),
    baseUrl: served.baseUrl,
    enabled: models.filter((model) => model.enabled).length,
    providerEnabled,
    models,
  };
}

// Failure-tolerant for the same reason as the LM Studio twin: the selection
// file is shared state, and a checkbox that publishes the model but cannot
// flip the provider beats one that fails outright.
export function syncCursorProviderSelection(shouldEnable) {
  try {
    const enabled = readProviderSelection().includes(CURSOR_PROVIDER_ID);
    if (shouldEnable && !enabled) enableProvider(CURSOR_PROVIDER_ID);
    if (!shouldEnable && enabled) disableProvider(CURSOR_PROVIDER_ID);
    return shouldEnable;
  } catch {
    return undefined;
  }
}

// Checking a model publishes it through the same user-model overlay
// `curate-models cursor-cli` writes, so the panel and the interactive CLI are
// two doors to one state and neither can strand the other's entries.
export function setCursorModelEnabled(id, enabled) {
  const value = String(id || "").trim();
  if (!value) throw new Error("A model id is required.");
  const existing = readUserModels();
  const others = existing.filter((model) => model.provider !== CURSOR_PROVIDER_ID);
  const mine = existing.filter(
    (model) => model.provider === CURSOR_PROVIDER_ID && model.upstreamModel !== value,
  );
  const next = enabled
    ? [
        ...mine,
        {
          ...userModelEntry({
            providerId: CURSOR_PROVIDER_ID,
            upstreamId: value,
            priority: CURSOR_MODEL_PRIORITY,
            metadata: {
              contextWindow: CURSOR_CONTEXT_WINDOW,
              autoCompact: CURSOR_AUTO_COMPACT,
              description: `${value} answered by cursor-agent on this machine, spending your Cursor plan.`,
            },
          }),
          // Not a hedge and not boilerplate: cursor-agent returns prose and its
          // own tool events, never OpenAI tool_calls, so this model cannot
          // dispatch a Codex turn. Saying so in the picker is the only place
          // someone finds out before selecting it.
          displayName: `${value} (Cursor, answers only)`,
          // apply_patch is a freeform custom tool with no representation here,
          // and a model that cannot emit a tool call certainly cannot drive a
          // subagent.
          supportsApplyPatchTool: false,
          multiAgentVersion: "v1",
        },
      ]
    : mine;
  // Renumbered on every write rather than assigned once: a priority derived
  // from list length at toggle time collides after a disable/re-enable cycle.
  const entries = next.map((entry, index) => ({
    ...entry,
    priority: CURSOR_MODEL_PRIORITY + index,
  }));
  writeUserModels([...others, ...entries]);
  syncCursorProviderSelection(entries.length > 0);
  return entries;
}
