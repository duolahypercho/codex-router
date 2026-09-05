import path from "node:path";
import { fileURLToPath } from "node:url";

import { discoverProviderModels } from "./model-discovery.mjs";
import { RUNTIME_PROVIDERS } from "./model-registry.mjs";
import { readNativeCatalogFile } from "./native-catalog-source.mjs";
import {
  applyModelOverlayPublication,
  transactModelOverlayMutation,
} from "./model-overlay-publication.mjs";
import { MODEL_PICKER_STATE_PATH, setModelsVisible } from "./model-picker-state.mjs";
import { NATIVE_CATALOG_PATH } from "./paths.mjs";
import {
  USER_MODELS_PATH,
  readUserModels,
  userModelEntry,
  writeUserModels,
} from "./user-models.mjs";

export const NATIVE_MODEL_MIRROR_MARKER = "codex-router/native-model-mirror/v1";

function mirroredDisplayName(provider, nativeModel) {
  const nativeName = String(nativeModel?.display_name || nativeModel?.slug || "").trim();
  return `${provider.displayName} · ${nativeName}`;
}

function mirroredMetadata(provider, nativeModel) {
  const contextWindow = Number.isInteger(nativeModel?.context_window) && nativeModel.context_window > 0
    ? nativeModel.context_window
    : undefined;
  const reasoningLevels = Array.isArray(nativeModel?.supported_reasoning_levels) &&
      nativeModel.supported_reasoning_levels.length
    ? nativeModel.supported_reasoning_levels
      // The account catalog may expose client-only quota modes such as ultra.
      // `/models` certifies the id, not those private-upstream capabilities;
      // keep automatic routes on the portable Responses effort vocabulary.
      .filter((level) => level.effort !== "ultra")
      .map((level) => ({
          effort: level.effort,
          description: level.description || `${level.effort} reasoning`,
        }))
    : undefined;
  const defaultEffort = reasoningLevels?.some(
    (level) => level.effort === nativeModel.default_reasoning_level,
  )
    ? nativeModel.default_reasoning_level
    : reasoningLevels?.at(-1)?.effort;
  return {
    displayName: mirroredDisplayName(provider, nativeModel),
    description:
      `Automatically mirrored from native ${nativeModel.slug} metadata after ` +
      `${provider.displayName} advertised the same model id.`,
    ...(contextWindow
      ? { contextWindow, autoCompact: Math.floor(contextWindow * 0.85) }
      : {}),
    ...(Array.isArray(nativeModel?.input_modalities) && nativeModel.input_modalities.length
      ? { inputModalities: [...nativeModel.input_modalities] }
      : {}),
    ...(reasoningLevels ? { reasoningLevels, defaultEffort } : {}),
    ...(Array.isArray(nativeModel?.service_tiers) && nativeModel.service_tiers.length
      ? {
          serviceTiers: nativeModel.service_tiers.map((tier) => ({
            id: tier.id,
            name: tier.name,
            ...(tier.description ? { description: tier.description } : {}),
          })),
        }
      : {}),
  };
}

export function mirroredNativeModelEntry({ provider, nativeModel, priority }) {
  return {
    ...userModelEntry({
      providerId: provider.id,
      upstreamId: nativeModel.slug,
      priority,
      metadata: mirroredMetadata(provider, nativeModel),
    }),
    managedBy: NATIVE_MODEL_MIRROR_MARKER,
    nativeModelSlug: nativeModel.slug,
  };
}

export function planNativeModelMirror({
  provider,
  nativeModels,
  discovered,
  existing,
}) {
  const advertised = new Set(discovered || []);
  const candidates = (nativeModels || []).filter((model) => (
    model?.visibility === "list" &&
    model?.supported_in_api !== false &&
    typeof model?.slug === "string" &&
    advertised.has(model.slug)
  ));
  const models = [...(existing || [])];
  const owned = new Map();
  let nextPriority = 100;
  for (let index = 0; index < models.length; index += 1) {
    const model = models[index];
    if (model?.provider === provider.id && typeof model?.upstreamModel === "string") {
      owned.set(model.upstreamModel, index);
      if (Number.isInteger(model.priority)) nextPriority = Math.max(nextPriority, model.priority + 1);
    }
  }

  const added = [];
  const updated = [];
  const preserved = [];
  for (const nativeModel of candidates) {
    const index = owned.get(nativeModel.slug);
    const current = index === undefined ? undefined : models[index];
    if (current && current.managedBy !== NATIVE_MODEL_MIRROR_MARKER) {
      preserved.push(current.slug);
      continue;
    }
    const generated = mirroredNativeModelEntry({
      provider,
      nativeModel,
      priority: current?.priority ?? nextPriority,
    });
    // Discovery can refresh presentation metadata, but it cannot certify
    // whether this exact provider/model route accepts completed search items.
    // Preserve an operator's route-specific proof without inferring it for a
    // newly mirrored model or copying it from another route.
    if (typeof current?.supportsSearchHistory === "boolean") {
      generated.supportsSearchHistory = current.supportsSearchHistory;
    }
    // `/models` only certifies the model id, so new mirrors stay conservative.
    // Once an operator verifies ultra on this exact route, preserve that rung
    // while the signed-in native catalog continues to advertise it.
    const currentUltra = Array.isArray(current?.reasoningLevels)
      ? current.reasoningLevels.find((level) => (
          level?.effort === "ultra" &&
          typeof level.description === "string" &&
          level.description.trim()
        ))
      : undefined;
    const nativeHasUltra = Array.isArray(nativeModel.supported_reasoning_levels) &&
      nativeModel.supported_reasoning_levels.some((level) => level?.effort === "ultra");
    if (currentUltra && nativeHasUltra && Array.isArray(generated.reasoningLevels)) {
      generated.reasoningLevels = [...generated.reasoningLevels, { ...currentUltra }];
    }
    if (current) {
      if (JSON.stringify(current) !== JSON.stringify(generated)) {
        models[index] = generated;
        updated.push(generated.slug);
      }
      continue;
    }
    nextPriority += 1;
    owned.set(nativeModel.slug, models.length);
    models.push(generated);
    added.push(generated.slug);
  }
  return { models, added, updated, preserved };
}

export async function syncNativeModelMirrors({
  providers = RUNTIME_PROVIDERS,
  discover = discoverProviderModels,
  readNative = () => readNativeCatalogFile(NATIVE_CATALOG_PATH),
  readModels = readUserModels,
  writeModels = writeUserModels,
  showModels = (slugs) => setModelsVisible(slugs, true),
  transact = transactModelOverlayMutation,
  applyPublication = applyModelOverlayPublication,
  restartService,
} = {}) {
  const mirroredProviders = [...providers.values()].filter(
    (provider) => provider.mirrorNativeModels === true,
  );
  if (!mirroredProviders.length) {
    return { providers: 0, added: [], updated: [], preserved: [], changed: false };
  }
  const native = readNative();
  if (!native?.models?.length) {
    throw new Error("Native model mirroring requires a valid refreshed native catalog.");
  }

  // Network IO stays outside the model-overlay lock. The commit below re-reads
  // user state under that lock, so concurrent manual curation is preserved.
  const discoveries = new Map();
  for (const provider of mirroredProviders) {
    const discovery = await discover(provider.id, { refresh: true });
    discoveries.set(provider.id, discovery.discovered);
  }

  const planAll = (existing) => {
    let models = existing;
    const summary = {
      providers: mirroredProviders.length,
      added: [],
      updated: [],
      preserved: [],
    };
    for (const provider of mirroredProviders) {
      const plan = planNativeModelMirror({
        provider,
        nativeModels: native.models,
        discovered: discoveries.get(provider.id),
        existing: models,
      });
      models = plan.models;
      summary.added.push(...plan.added);
      summary.updated.push(...plan.updated);
      summary.preserved.push(...plan.preserved);
    }
    return {
      ...summary,
      models,
      changed: summary.added.length > 0 || summary.updated.length > 0,
    };
  };

  // Avoid publishing or restarting when discovery did not change the managed
  // overlay. The transaction re-plans under its lock before committing so a
  // concurrent manual edit is never overwritten by this preview.
  const preview = planAll(readModels());
  if (!preview.changed) {
    const { models: _models, ...summary } = preview;
    return summary;
  }

  let result;
  await transact({
    files: [USER_MODELS_PATH, MODEL_PICKER_STATE_PATH],
    restart: true,
    applyPublication,
    restartService,
    mutate: () => {
      const plan = planAll(readModels());
      if (plan.changed) writeModels(plan.models);
      if (plan.added.length) showModels(plan.added);
      const { models: _models, ...summary } = plan;
      result = summary;
    },
  });
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(await syncNativeModelMirrors())}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
