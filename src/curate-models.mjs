import path from "node:path";
import { fileURLToPath } from "node:url";

import { discoverProviderModels } from "./model-discovery.mjs";
import { MODELS, PROVIDERS, USER_MODEL_WARNINGS } from "./model-registry.mjs";
import { confirm, promptLine } from "./setup-shared.mjs";
import { toggleSelection } from "./setup-ui.mjs";
import {
  DEFAULT_AUTO_COMPACT,
  DEFAULT_CONTEXT_WINDOW,
  USER_MODELS_PATH,
  defaultUserModelDescription,
  readUserModels,
  userModelEntry,
  userModelIdentity,
  writeUserModels,
} from "./user-models.mjs";
import {
  curationPrimaryProviderId,
  curationProviderIds,
  curatedModelContextLength,
  curatedModelDescription,
  curatedModelProviderId,
} from "./opencode-curation.mjs";
import {
  applyModelOverlayPublication,
  transactModelOverlayMutation,
} from "./model-overlay-publication.mjs";
import {
  migrateModelVisibility,
  MODEL_PICKER_STATE_PATH,
  setModelsVisible,
} from "./model-picker-state.mjs";

// Interactive curation: list the provider's live models that are not part of
// the checked-in registry, let the user toggle the ones they want, and persist
// them as user models. Discovery never edits the checked-in config/ registry tree.

const requestedProviderId = process.argv[2];
const providerId = curationPrimaryProviderId(requestedProviderId);
const modelsOption = (() => {
  const index = process.argv.indexOf("--models");
  return index === -1 ? undefined : process.argv[index + 1];
})();
const removeOption = (() => {
  const index = process.argv.indexOf("--remove");
  return index === -1 ? undefined : process.argv[index + 1];
})();
const apply = process.argv.includes("--apply");
const noApply = process.argv.includes("--no-apply");
const freeOnly = process.argv.includes("--free-only");
const refreshCatalog = process.argv.includes("--refresh");
const effortsOption = (() => {
  const index = process.argv.indexOf("--efforts");
  return index === -1 ? undefined : process.argv[index + 1];
})();
const requestProfileOption = (() => {
  const index = process.argv.indexOf("--request-profile");
  return index === -1 ? undefined : process.argv[index + 1];
})();

// The Codex effort ladder. Registry models describe each level explicitly;
// curated models reuse these standard descriptions. Only advertise levels the
// upstream actually documents — an unsupported value can be rejected with a
// 400 or silently remapped by the provider.
const EFFORT_DESCRIPTIONS = {
  minimal: "Fastest responses",
  low: "Quick reasoning",
  medium: "Balanced reasoning",
  high: "Deep reasoning",
  xhigh: "Extended reasoning",
  max: "Maximum reasoning",
};

// Request profiles a curated model may opt into. The vendor profiles in
// `src/api-forwarder.mjs` translate one upstream's parameter surface and are
// inherited from that provider's registry models, never chosen here; these
// describe a restriction the user observed on a model the repository does not
// ship, so they are the only ones worth offering by hand.
const AUTO_TOOL_CHOICE = "auto-tool-choice";
const REQUEST_PROFILE_DESCRIPTIONS = {
  [AUTO_TOOL_CHOICE]:
    'reject a forced tool_choice ("required") while still calling tools under "auto"',
};

// Codex compacts at this fraction of the declared window.
const AUTO_COMPACT_RATIO = 0.85;

// The sizing to store for a context window, from the provider's catalog or from
// the interactive prompt. Both have to derive `autoCompact` the same way: it is
// the number Codex actually reads to decide when to summarize, and a window
// stored without it keeps whatever the conservative default said.
//
// Guessing 131072 for a model the provider advertises at 1,050,000 does not
// fail safe. The estimate the router substitutes when an upstream reports zero
// prompt tokens errs high on purpose, so against an eight-times-too-small
// threshold it lands above the compaction limit on turn after turn and the
// session compacts forever without finishing anything (#266).
export function curatedSizing(contextLength) {
  if (!Number.isInteger(contextLength) || contextLength < 1) return undefined;
  return {
    contextWindow: contextLength,
    autoCompact: Math.floor(contextLength * AUTO_COMPACT_RATIO),
  };
}

function usage() {
  console.error(
    "Usage: curate-models.mjs PROVIDER [--models id1,id2 | interactive] " +
      "[--free-only] [--remove id1,id2] [--refresh] [--apply|--no-apply] " +
      "[--efforts minimal,low,medium,high,xhigh] " +
      `[--request-profile ${Object.keys(REQUEST_PROFILE_DESCRIPTIONS).join("|")}]`,
  );
  process.exit(2);
}

// Nothing downstream validates the stored value: the forwarder simply matches
// no branch, so a typo would store a model that keeps failing exactly the way
// it did before curation. Fail here instead, the way an unknown effort does.
export function parseRequestProfile(raw) {
  const profile = String(raw ?? "").trim().toLowerCase();
  if (!profile) return undefined;
  if (!REQUEST_PROFILE_DESCRIPTIONS[profile]) {
    throw new Error(
      `Unknown request profile "${profile}". Choose from: ${Object.keys(REQUEST_PROFILE_DESCRIPTIONS).join(", ")}.`,
    );
  }
  return profile;
}

export function planCuration({ mine, chosen, removals, interactive }) {
  const removalSet = new Set(removals);
  const kept = mine.filter((model) => !removalSet.has(model.upstreamModel));
  const chosenIds = [...new Set(chosen)];
  const chosenSet = new Set(chosenIds);
  // The interactive picker remains authoritative: deselection is an explicit
  // removal. The deterministic --models form is additive and keeps everything
  // it did not name, including hand-tuned metadata.
  const surviving = interactive
    ? kept.filter((model) => chosenSet.has(model.upstreamModel))
    : kept;
  const existingIds = new Set(surviving.map((model) => model.upstreamModel));
  return {
    surviving,
    additions: chosenIds.filter((id) => !existingIds.has(id)),
  };
}

// Apply a prompt/discovery result to the document observed at commit time.
// Unrelated providers are merged from that current document; replacing the
// whole array from the pre-prompt read would lose a concurrent curation. The
// same provider is intentionally compare-and-swap: its current entries may
// contain a newer user's edit that this run cannot safely reconcile.
export function mergeCurationIntoCurrent(
  current,
  { providerId, providerIds = [providerId], expectedMine, nextMine },
) {
  const models = Array.isArray(current) ? current : [];
  const owned = new Set(providerIds);
  const currentMine = models.filter((model) => owned.has(model.provider));
  if (JSON.stringify(currentMine) !== JSON.stringify(expectedMine)) {
    throw new Error(
      `Curated ${providerId} models changed while this command was running; review them and retry.`,
    );
  }
  return [
    ...models.filter((model) => !owned.has(model.provider)),
    ...nextMine,
  ];
}

// Normalize every entry in one local curation set onto the protocol OpenCode
// documents for that upstream id. Existing metadata stays byte-for-byte alone
// except for the untouched generic sizing pair on an exact documented model;
// that pair is evidence curation had no model-specific answer, not a user tune.
// Prefer an already correct entry if an older run left both protocol copies.
export function normalizeCurationModels(models, providerId) {
  const normalized = new Map();
  for (const model of models) {
    const targetProvider = curatedModelProviderId(providerId, model.upstreamModel);
    const routed = model.provider === targetProvider
      ? model
      : {
          ...model,
          ...userModelIdentity({
            providerId: targetProvider,
            upstreamId: model.upstreamModel,
            metadata: model,
          }),
          provider: targetProvider,
        };
    const documented = curatedSizing(
      curatedModelContextLength(providerId, model.upstreamModel),
    );
    const upgradeSizing =
      documented &&
      routed.contextWindow === DEFAULT_CONTEXT_WINDOW &&
      routed.autoCompact === DEFAULT_AUTO_COMPACT;
    // The stock description says the entry carries conservative defaults, so
    // it stops being true the moment the sizing is upgraded. Replace it with
    // the sourcing note only while it is still the untouched stock string;
    // anything the user wrote there is theirs.
    const documentedDescription = curatedModelDescription(providerId, model.upstreamModel);
    const upgradeDescription =
      upgradeSizing &&
      documentedDescription &&
      // An entry rerouted onto the Responses variant still carries the stock
      // string naming the provider it was curated under, so accept either.
      (routed.description === defaultUserModelDescription(routed.provider) ||
        routed.description === defaultUserModelDescription(model.provider));
    const sized = upgradeSizing
      ? {
          ...routed,
          ...documented,
          ...(upgradeDescription ? { description: documentedDescription } : {}),
        }
      : routed;
    const existing = normalized.get(model.upstreamModel);
    if (!existing || model.provider === targetProvider) {
      normalized.set(model.upstreamModel, sized);
    }
  }
  return [...normalized.values()];
}

export function parseEfforts(raw) {
  const efforts = raw.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  for (const effort of efforts) {
    if (!EFFORT_DESCRIPTIONS[effort]) {
      throw new Error(
        `Unknown reasoning effort "${effort}". Choose from: ${Object.keys(EFFORT_DESCRIPTIONS).join(", ")}.`,
      );
    }
  }
  if (efforts.length === 0) return undefined;
  const ordered = Object.keys(EFFORT_DESCRIPTIONS).filter((effort) => efforts.includes(effort));
  return {
    reasoningLevels: ordered.map((effort) => ({
      effort,
      description: EFFORT_DESCRIPTIONS[effort],
    })),
    defaultEffort: ordered.includes("high") ? "high" : ordered[ordered.length - 1],
  };
}

if (!requestedProviderId) usage();
const provider = PROVIDERS.get(providerId);
if (!provider) {
  console.error(`Unknown provider: ${providerId}`);
  process.exit(2);
}
const flagEfforts = (() => {
  try {
    return effortsOption ? parseEfforts(effortsOption) : undefined;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
})();
const flagRequestProfile = (() => {
  try {
    return requestProfileOption ? parseRequestProfile(requestProfileOption) : undefined;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
})();

export function renderRows(candidates, curated, selected) {
  return candidates
    .map((id, index) => {
      const mark = selected.has(index + 1) ? "[x]" : "[ ]";
      const note = curated.has(id) ? "currently curated" : "new";
      return `  ${mark} ${index + 1}. ${id} (${note})`;
    })
    .join("\n");
}

function chooseInteractively(candidates, curated) {
  let selected = new Set(
    candidates.map((id, index) => (curated.has(id) ? index + 1 : undefined)).filter(Boolean),
  );
  process.stdout.write(
    `\nChoose ${provider.displayName} models to add to the picker.\n` +
      "You will be asked for each new model's context window, image support,\n" +
      "and reasoning efforts; every value stays editable later.\n",
  );
  for (;;) {
    process.stdout.write(`${renderRows(candidates, curated, selected)}\n`);
    const raw = promptLine("Toggle numbers (comma-separated), a=all, n=none; Enter to continue");
    const result = toggleSelection(selected, raw, candidates.length, { allowEmpty: true });
    selected = result.selected;
    if (result.error) {
      process.stdout.write(`${result.error}\n`);
    } else if (result.done) {
      break;
    }
  }
  return [...selected].sort((a, b) => a - b).map((position) => candidates[position - 1]);
}


async function main() {
  for (const warning of USER_MODEL_WARNINGS) console.error(warning);
  const existing = readUserModels();
  const familyProviderIds = curationProviderIds(providerId);
  const familyProviders = new Set(familyProviderIds);
  const storedMine = existing.filter((model) => familyProviders.has(model.provider));
  const mine = normalizeCurationModels(storedMine, providerId);
  const curated = new Set(mine.map((model) => model.upstreamModel));
  if (modelsOption !== undefined && removeOption !== undefined) {
    throw new Error("Use --models to add models or --remove to prune them, not both.");
  }
  if (freeOnly && (modelsOption !== undefined || removeOption !== undefined)) {
    throw new Error("Use --free-only, --models, or --remove by itself.");
  }
  if (modelsOption !== undefined && (!modelsOption.trim() || modelsOption.startsWith("--"))) {
    throw new Error("--models requires at least one model id.");
  }
  if (removeOption !== undefined && (!removeOption.trim() || removeOption.startsWith("--"))) {
    throw new Error("--remove requires at least one model id.");
  }
  const removals = (removeOption || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  for (const id of removals) {
    if (!curated.has(id)) {
      throw new Error(
        `${id} is not a curated ${providerId} model. Curated: ${[...curated].join(", ") || "none"}`,
      );
    }
  }

  // Removing local curation must not depend on provider credentials or network
  // availability. Discovery is needed only for additions and the picker.
  //
  // Additions read the provider's cached list by default: it is the same list
  // the caller chose from, and re-asking the provider makes every add pay for
  // a network round trip it does not need. `--refresh` re-asks.
  const discovery = removeOption === undefined
    ? await discoverProviderModels(providerId, { refresh: refreshCatalog })
    : { unregistered: [] };
  const candidates = [...new Set([...discovery.unregistered, ...curated])].sort();

  if (freeOnly && !Array.isArray(discovery.free)) {
    throw new Error(`${provider.displayName} does not publish a supported free-model catalog.`);
  }
  const freeCandidates = freeOnly
    ? discovery.free.filter((id) => candidates.includes(id))
    : [];
  if (freeOnly && freeCandidates.length === 0) {
    throw new Error(`${provider.displayName} currently advertises no unregistered free OpenAI-compatible models.`);
  }

  if (candidates.length === 0 && removeOption === undefined) {
    process.stdout.write(
      `Every model ${provider.displayName} advertises is already in the registry.\n`,
    );
    return;
  }

  const interactiveSelection = modelsOption === undefined && removeOption === undefined && !freeOnly;
  const chosen = modelsOption
    ? modelsOption.split(",").map((value) => value.trim()).filter(Boolean)
    : freeOnly
      ? freeCandidates
    : interactiveSelection
      ? chooseInteractively(candidates, curated)
      : [];
  if (removeOption === undefined) {
    for (const id of chosen) {
      if (candidates.includes(id)) continue;
      throw new Error(
        `${id} is not an available candidate for ${providerId}. Candidates: ${candidates.join(", ")}`,
      );
    }
  }

  const inheritedProfile = MODELS.find(
    (model) => familyProviders.has(model.provider) && model.requestProfile,
  )?.requestProfile;

  // Which models exist is decided by the provider's own /v1/models endpoint.
  // Metadata comes from that catalog, the interactive user, or the narrow
  // documented OpenCode exceptions whose catalog records omit their size.
  // Existing curated entries are never touched.
  const interactive = interactiveSelection && Boolean(process.stdin.isTTY);

  const metadataFor = (id) => {
    const metadata = {
      ...(flagEfforts || {}),
      ...(discovery.free?.includes(id) ? { isFree: true } : {}),
    };
    // The served catalog value wins when present. OpenCode's exact documented
    // free-model size is the fallback for its id-only Zen catalog; every other
    // silent catalog still gets the conservative generic default.
    const advertised = curatedSizing(discovery.contextLengths?.[id]);
    const documented = curatedSizing(curatedModelContextLength(providerId, id));
    const sizing = advertised || documented;
    if (sizing) Object.assign(metadata, sizing);
    // A documented window is not a conservative default, and this repository
    // records where such a number came from in the entry's own description
    // rather than only in a source comment. The live catalog's own figure
    // needs no note; it is first-hand and already labeled "advertised".
    if (!advertised && documented) {
      const description = curatedModelDescription(providerId, id);
      if (description) metadata.description = description;
    }
    if (!interactive) return Object.keys(metadata).length > 0 ? metadata : undefined;
    process.stdout.write(`\nMetadata for ${id} (Enter keeps the default):\n`);
    const suggested = sizing?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    const rawContext = promptLine(
      `  Context window in tokens [${suggested}${
        advertised ? ", advertised" : documented ? ", documented" : ""
      }]`,
    ).trim();
    if (rawContext) {
      const context = Number.parseInt(rawContext, 10);
      const sizing = curatedSizing(context);
      if (!sizing) throw new Error(`Invalid context window: ${rawContext}`);
      Object.assign(metadata, sizing);
      // The sourcing note describes the documented figure. The user just
      // replaced it, so the note no longer matches what is stored.
      if (context !== documented?.contextWindow) delete metadata.description;
    }
    if (confirm(`  Does ${id} accept image input?`)) {
      metadata.inputModalities = ["text", "image"];
    }
    if (!flagEfforts) {
      const rawEfforts = promptLine(
        "  Reasoning efforts, comma-separated from " +
          `${Object.keys(EFFORT_DESCRIPTIONS).join(",")} [high]`,
      ).trim();
      if (rawEfforts) Object.assign(metadata, parseEfforts(rawEfforts) || {});
    }
    return Object.keys(metadata).length > 0 ? metadata : undefined;
  };

  // A provider that ships registry models lends its vendor profile to anything
  // curated beside them. The catalog-only providers ship none, so their first
  // curated model would get nothing at all -- which is correct for almost
  // every model and wrong for the ones whose upstream refuses a forced tool
  // choice. That is a per-model fact (a reseller fronts many upstreams, and
  // the restriction belongs to the model behind it), so it is asked per model
  // rather than defaulted per provider.
  const requestProfileFor = (id) => {
    if (flagRequestProfile) return flagRequestProfile;
    if (inheritedProfile) return inheritedProfile;
    if (!interactive) return undefined;
    // Defaults to no: this weakens a forced tool choice into a request the
    // model may decline, so it must be answered rather than fallen into by
    // pressing Enter through the prompts.
    return confirm(`  Does ${id} ${REQUEST_PROFILE_DESCRIPTIONS[AUTO_TOOL_CHOICE]}?`, false)
      ? AUTO_TOOL_CHOICE
      : undefined;
  };

  // Older builds included OrcaRouter's moving free meta-router. A free-only
  // refresh replaces it with the concrete free models the live catalog names,
  // while preserving every paid model the operator curated separately.
  const effectiveRemovals = freeOnly && curated.has("orcarouter/free")
    ? [...removals, "orcarouter/free"]
    : removals;
  const { surviving, additions } = planCuration({
    mine,
    chosen,
    removals: effectiveRemovals,
    interactive: interactiveSelection,
  });
  const nextMine = [
    ...surviving,
    ...additions.map((id, index) => {
      // Ask for metadata before the profile so interactive prompts stay under
      // one model heading and in the order they are printed.
      const metadata = metadataFor(id);
      const routedProviderId = curatedModelProviderId(providerId, id);
      return userModelEntry({
        providerId: routedProviderId,
        upstreamId: id,
        requestProfile: requestProfileFor(id),
        priority: 100 + mine.length + index,
        metadata,
      });
    }),
  ].map((model) => {
    if (providerId !== "orca" || !discovery.free?.includes(model.upstreamModel)) return model;
    return {
      ...model,
      ...userModelIdentity({
        providerId,
        upstreamId: model.upstreamModel,
        metadata: { ...model, isFree: true },
      }),
      isFree: true,
    };
  });
  let target;
  const added = nextMine.filter((model) => !curated.has(model.upstreamModel)).length;
  const removed = mine.length - (nextMine.length - added);
  // Selecting a model in curation means selecting it for the picker as well.
  // Provider enablement alone remains deliberately non-expansive: it must not
  // flood every installed client's picker with that provider's whole catalog.
  const pickerSelections = nextMine
    .filter((model) => chosen.includes(model.upstreamModel))
    .map((model) => model.slug);
  const normalizedByUpstream = new Map(
    nextMine.map((model) => [model.upstreamModel, model]),
  );
  const pickerMigrations = storedMine
    .map((model) => ({
      from: model.slug,
      to: normalizedByUpstream.get(model.upstreamModel)?.slug,
    }))
    .filter(({ from, to }) => to && from !== to);

  const wantsApply =
    !noApply && (
      apply ||
      confirm("Apply now? This rebuilds gateway routes and restarts the background service.")
    );
  await transactModelOverlayMutation({
    files: [USER_MODELS_PATH, MODEL_PICKER_STATE_PATH],
    mutate: () => {
      // Discovery and prompts intentionally happen before the lock, but the
      // document merge cannot: another provider's curation may have landed
      // while this command was waiting. Re-read both sides under the lock and
      // merge current unrelated entries. A same-provider edit is ambiguous
      // (the user's choices were based on an older list), so fail closed rather
      // than overwrite it with a stale interactive result.
      const current = readUserModels();
      target = writeUserModels(mergeCurationIntoCurrent(current, {
        providerId,
        providerIds: familyProviderIds,
        expectedMine: storedMine,
        nextMine,
      }));
      if (pickerMigrations.length) migrateModelVisibility(pickerMigrations);
      if (pickerSelections.length) setModelsVisible(pickerSelections, true);
    },
    restart: wantsApply,
    // Publishing curated models is a catalog operation, not an installation.
    // This used to shell out to bin/install, which reinstalls the background
    // service and waits on its health -- and whose own EXIT trap disables the
    // client config when that wait fails. Adding one model could therefore
    // leave the router unrouted. rebuildModelOverlayPublication already writes
    // the gateway routes and republishes every installed client's picker --
    // the same catalog steps the installer ran -- and the restart requested
    // above is the only reload the new gateway routes actually need.
    //
    // --no-apply still publishes nothing: it persists the overlay and leaves
    // the routing plane untouched until the operator asks for it.
    applyPublication: async (options) => (
      wantsApply ? applyModelOverlayPublication(options) : {}
    ),
  });
  process.stdout.write(
    `Saved ${nextMine.length} curated ${provider.displayName} model${
      nextMine.length === 1 ? "" : "s"
    } (${added} added, ${removed} removed) to ${target}.\n`,
  );
  if (noApply) {
    process.stdout.write("Run ./bin/install to regenerate routes and the picker catalog.\n");
    return;
  }
  if (wantsApply) {
    // An auto-policy is standing, provider/family-scoped consent to verify a
    // newly curated model. This runs only after the overlay is published: the
    // worker imports a fresh registry and can route the new slug immediately.
    const addedModels = nextMine.filter((model) => !curated.has(model.upstreamModel));
    if (addedModels.length) {
      const { matchingSubagentAutoPolicyModels } = await import("./subagent-auto-policy.mjs");
      const matching = matchingSubagentAutoPolicyModels(addedModels);
      if (matching.length) {
        const { spawnDetachedVerification } = await import("./subagent-verify.mjs");
        spawnDetachedVerification(
          matching.map((model) => model.slug),
          { deferCandidateResolution: true },
        );
      }
    }
    process.stdout.write("Curated models are live. Fully quit and reopen the app to refresh its picker.\n");
  } else {
    process.stdout.write("Run ./bin/install to regenerate routes and the picker catalog.\n");
  }
}

// Run only when invoked directly. Importing this module used to execute the
// whole curation flow -- including the credential check -- which is why the
// only path a catalog-only provider has to a usable model had no tests.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`codex-router curate-models: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
