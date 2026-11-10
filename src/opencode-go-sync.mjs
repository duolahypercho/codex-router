import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MODELS } from "./model-registry.mjs";
import { isOpenCodeGeminiModel } from "./opencode-gemini.mjs";
import { MODEL_PICKER_STATE_PATH, modelPickerSnapshot, setModelsVisible } from "./model-picker-state.mjs";
import { transactModelOverlayMutation } from "./model-overlay-publication.mjs";
import { fetchUntrustedModelCatalog } from "./untrusted-model-discovery.mjs";
import { USER_MODELS_PATH, readUserModels, userModelEntry, writeUserModels } from "./user-models.mjs";

const SELF = fileURLToPath(import.meta.url);
const GO_CATALOG_URL = "https://opencode.ai/zen/go/v1/models";
const GO_PROVIDERS = new Set(["opencode-go", "opencode-go-messages", "opencode-go-responses"]);
const API_PROVIDERS = Object.freeze({
  "chat-completions": "opencode-go",
  messages: "opencode-go-messages",
  responses: "opencode-go-responses",
  "generate-content": "opencode-go",
});
const API_BASE_URLS = Object.freeze({
  "chat-completions": "https://opencode.ai/inference/go/openai/v1",
  messages: "https://opencode.ai/inference/go/anthropic/v1",
  responses: "https://opencode.ai/inference/go/openai/v1",
  "generate-content": "https://opencode.ai/inference/go/google/v1beta",
});
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

// The provider's per-model api object is the route authority. An ambiguous or
// unknown wire is withheld rather than guessed from a model name.
export function goProtocol(record) {
  if (record?.type !== "chat") return undefined;
  const entries = Object.entries(record?.api || {});
  if (entries.length !== 1 || !Object.hasOwn(API_PROVIDERS, entries[0][0])) return undefined;
  const [protocol, details] = entries[0];
  if (details?.base_url !== API_BASE_URLS[protocol]) {
    return undefined;
  }
  return { protocol, providerId: API_PROVIDERS[protocol] };
}

function goMetadata(record, protocol) {
  const metadata = {
    openCodeGoProtocol: protocol,
    openCodeGoManaged: true,
    displayName: `${record.name || record.id} (OpenCode Go)`,
    description: `OpenCode Go model discovered from its live model catalog (${protocol}).`,
  };
  const context = record.limit?.context;
  const output = record.limit?.output;
  if (Number.isSafeInteger(context) && context > 0 &&
      Number.isSafeInteger(output) && output > 0 && context * 0.15 >= output) {
    metadata.contextWindow = context;
  }
  const input = record.modalities?.input;
  if (Array.isArray(input)) {
    metadata.inputModalities = ["text", ...(input.some((value) =>
      typeof value === "string" && value.startsWith("image/")) ? ["image"] : [])];
  }
  const efforts = record.capabilities?.reasoning?.effort;
  if (Array.isArray(efforts)) {
    const levels = [...new Set(efforts.filter((value) => EFFORTS.has(value)))];
    if (levels.length) {
      metadata.reasoningLevels = levels.map((effort) => ({ effort, description: "Adaptive reasoning" }));
      metadata.defaultEffort = levels.includes("high") ? "high" : levels[0];
    }
  }
  if (record.cost?.text?.input?.price === 0 && record.cost?.text?.output?.price === 0) {
    metadata.isFree = true;
  }
  return metadata;
}

export function planGoSync(records, models = MODELS) {
  if (!Array.isArray(records) || records.length === 0) throw new Error("OpenCode Go returned an empty catalog.");
  const live = new Map();
  for (const record of records) {
    if (typeof record?.id !== "string" || !/^[a-z0-9][a-z0-9.-]*$/.test(record.id) || live.has(record.id)) {
      throw new Error("OpenCode Go returned a duplicate or invalid model id.");
    }
    live.set(record.id, record);
  }
  const goModels = models.filter((model) => GO_PROVIDERS.has(model.provider));
  const existing = new Set(goModels.map((model) => model.upstreamModel));
  const additions = [];
  const blocked = new Set();
  for (const record of live.values()) {
    if (existing.has(record.id)) continue;
    const route = goProtocol(record);
    if (!route) {
      blocked.add(record.id);
      continue;
    }
    additions.push(userModelEntry({
      providerId: route.providerId,
      upstreamId: record.id,
      priority: 1000 + additions.length,
      metadata: goMetadata(record, route.protocol),
    }));
  }
  const stale = goModels.filter((model) => {
    const record = live.get(model.upstreamModel);
    if (!record) return true;
    const route = goProtocol(record);
    const mismatch = !route || route.providerId !== model.provider ||
      (route.protocol === "generate-content") !== isOpenCodeGeminiModel(model);
    if (mismatch) blocked.add(record.id);
    return mismatch;
  }).map((model) => model.slug);
  return { additions, blocked: [...blocked], stale, liveIds: [...live.keys()] };
}

export function probePendingGoModels(models, liveIds, hidden, probe) {
  const pending = models.filter((model) => model.openCodeGoManaged === true &&
    liveIds.includes(model.upstreamModel) && hidden.includes(model.slug));
  const passed = pending.filter((model) => probe(model.slug)).map((model) => model.slug);
  return { passed, failed: pending.map((model) => model.slug)
    .filter((slug) => !passed.includes(slug)) };
}

function quickProbe(slug) {
  try {
    execFileSync(process.execPath, [path.join(path.dirname(SELF), "compatibility-test.mjs"),
      slug, "--live", "--yes", "--quick"], { timeout: 90_000, stdio: "pipe", windowsHide: true });
    return true;
  } catch (error) {
    console.error(`OpenCode Go quick probe failed for ${slug}: ${error?.status || error?.message || error}`);
    return false;
  }
}

export async function syncGoCatalog({
  catalog = () => fetchUntrustedModelCatalog(GO_CATALOG_URL),
  probe = quickProbe,
  apply = false,
} = {}) {
  const payload = await catalog();
  const records = Array.isArray(payload?.data) ? payload.data : undefined;
  const plan = planGoSync(records);
  if (!apply) return { ...plan, applied: false };
  if (plan.additions.length) {
    await transactModelOverlayMutation({
      files: [USER_MODELS_PATH, MODEL_PICKER_STATE_PATH],
      mutate: () => {
        const current = readUserModels();
        const present = new Set(current.map((model) => `${model.provider}/${model.upstreamModel}`));
        const additions = plan.additions.filter((model) => !present.has(`${model.provider}/${model.upstreamModel}`));
        if (additions.length) {
          writeUserModels([...current, ...additions]);
          setModelsVisible(additions.map((model) => model.slug), false);
        }
      },
      restart: true,
    });
  }
  const { passed, failed } = probePendingGoModels(
    readUserModels(), plan.liveIds, modelPickerSnapshot().hidden, probe,
  );
  const toHide = plan.stale.filter((slug) => !modelPickerSnapshot().hidden.includes(slug));
  if (passed.length || toHide.length) {
    await transactModelOverlayMutation({
      files: [MODEL_PICKER_STATE_PATH],
      mutate: () => {
        if (passed.length) setModelsVisible(passed, true);
        if (toHide.length) setModelsVisible(toHide, false);
      },
    });
  }
  return { ...plan, applied: true, passed, failed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  syncGoCatalog({ apply: process.argv.includes("--apply") }).then((result) => {
    console.log(JSON.stringify({ added: result.additions.map((model) => model.slug),
      blocked: result.blocked, hidden: result.stale, passed: result.passed || [],
      failed: result.failed || [], applied: result.applied }));
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
