import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { discoverProviderModels } from "./model-discovery.mjs";
import { MODELS, PROVIDERS, USER_MODEL_WARNINGS } from "./model-registry.mjs";
import { SOURCE_ROOT } from "./paths.mjs";
import { confirm, promptLine } from "./setup-shared.mjs";
import { toggleSelection } from "./setup-ui.mjs";
import {
  DEFAULT_CONTEXT_WINDOW,
  readUserModels,
  userModelEntry,
  writeUserModels,
} from "./user-models.mjs";

// Interactive curation: list the provider's live models that are not part of
// the checked-in registry, let the user toggle the ones they want, and persist
// them as user models. Discovery never edits the checked-in config/ registry tree.

const providerId = process.argv[2];
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
      "[--remove id1,id2] [--apply|--no-apply] [--efforts minimal,low,medium,high,xhigh] " +
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

if (!providerId) usage();
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

function applyInstall() {
  const result =
    process.platform === "win32"
      ? spawnSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            path.join(SOURCE_ROOT, "install.ps1"),
            "-CheckoutInstall",
          ],
          { stdio: "inherit" },
        )
      : spawnSync(path.join(SOURCE_ROOT, "bin", "install"), [], { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error("Applying the curated models did not finish; run the install command manually.");
  }
}

async function main() {
  for (const warning of USER_MODEL_WARNINGS) console.error(warning);
  const existing = readUserModels();
  const mine = existing.filter((model) => model.provider === providerId);
  const others = existing.filter((model) => model.provider !== providerId);
  const curated = new Set(mine.map((model) => model.upstreamModel));
  if (modelsOption !== undefined && removeOption !== undefined) {
    throw new Error("Use --models to add models or --remove to prune them, not both.");
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
  const discovery = removeOption === undefined
    ? await discoverProviderModels(providerId)
    : { unregistered: [] };
  const candidates = [...new Set([...discovery.unregistered, ...curated])].sort();

  if (candidates.length === 0 && removeOption === undefined) {
    process.stdout.write(
      `Every model ${provider.displayName} advertises is already in the registry.\n`,
    );
    return;
  }

  const interactiveSelection = modelsOption === undefined && removeOption === undefined;
  const chosen = modelsOption
    ? modelsOption.split(",").map((value) => value.trim()).filter(Boolean)
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
    (model) => model.provider === providerId && model.requestProfile,
  )?.requestProfile;

  // Metadata comes from the user, not from any online catalog: which models
  // exist is decided by the provider's own /v1/models endpoint above, and the
  // sizing/effort details are asked interactively (or default conservatively
  // in --models mode). Existing curated entries are never touched.
  const interactive = interactiveSelection && Boolean(process.stdin.isTTY);

  const metadataFor = (id) => {
    const metadata = { ...(flagEfforts || {}) };
    // The provider already published this model's size; asking the user to
    // retype it, or defaulting past it, is how a million-token model ends up
    // stored as a 131K one. A catalog that said nothing still falls back.
    const advertised = curatedSizing(discovery.contextLengths?.[id]);
    if (advertised) Object.assign(metadata, advertised);
    if (!interactive) return Object.keys(metadata).length > 0 ? metadata : undefined;
    process.stdout.write(`\nMetadata for ${id} (Enter keeps the default):\n`);
    const suggested = advertised?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    const rawContext = promptLine(
      `  Context window in tokens [${suggested}${advertised ? ", advertised" : ""}]`,
    ).trim();
    if (rawContext) {
      const context = Number.parseInt(rawContext, 10);
      const sizing = curatedSizing(context);
      if (!sizing) throw new Error(`Invalid context window: ${rawContext}`);
      Object.assign(metadata, sizing);
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

  const { surviving, additions } = planCuration({
    mine,
    chosen,
    removals,
    interactive: interactiveSelection,
  });
  const nextMine = [
    ...surviving,
    ...additions.map((id, index) => {
      // Ask for metadata before the profile so interactive prompts stay under
      // one model heading and in the order they are printed.
      const metadata = metadataFor(id);
      return userModelEntry({
        providerId,
        upstreamId: id,
        requestProfile: requestProfileFor(id),
        priority: 100 + mine.length + index,
        metadata,
      });
    }),
  ];
  const target = writeUserModels([...others, ...nextMine]);
  const added = nextMine.filter((model) => !curated.has(model.upstreamModel)).length;
  const removed = mine.length - (nextMine.length - added);
  process.stdout.write(
    `Saved ${nextMine.length} curated ${provider.displayName} model${
      nextMine.length === 1 ? "" : "s"
    } (${added} added, ${removed} removed) to ${target}.\n`,
  );

  if (noApply) {
    process.stdout.write("Run ./bin/install to regenerate routes and the picker catalog.\n");
    return;
  }
  const wantsApply =
    apply ||
    confirm("Apply now? This rebuilds gateway routes and restarts the background service.");
  if (wantsApply) {
    applyInstall();
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
