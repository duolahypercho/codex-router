import path from "node:path";
import { spawnSync } from "node:child_process";

import { discoverProviderModels } from "./model-discovery.mjs";
import { MODELS, PROVIDERS, USER_MODEL_WARNINGS } from "./model-registry.mjs";
import { SOURCE_ROOT } from "./paths.mjs";
import { confirm, promptLine } from "./setup-shared.mjs";
import { toggleSelection } from "./setup-ui.mjs";
import { readUserModels, userModelEntry, writeUserModels } from "./user-models.mjs";

// Interactive curation: list the provider's live models that are not part of
// the checked-in registry, let the user toggle the ones they want, and persist
// them as user models. Discovery never edits config/providers.json.

const providerId = process.argv[2];
const modelsOption = (() => {
  const index = process.argv.indexOf("--models");
  return index === -1 ? undefined : process.argv[index + 1];
})();
const apply = process.argv.includes("--apply");
const noApply = process.argv.includes("--no-apply");

function usage() {
  console.error(
    "Usage: curate-models.mjs PROVIDER [--models id1,id2 | interactive] [--apply|--no-apply]",
  );
  process.exit(2);
}

if (!providerId) usage();
const provider = PROVIDERS.get(providerId);
if (!provider) {
  console.error(`Unknown provider: ${providerId}`);
  process.exit(2);
}

function renderRows(candidates, curated, selected) {
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
      "Curated models keep conservative default metadata you can edit later.\n",
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
  const discovery = await discoverProviderModels(providerId);
  const existing = readUserModels();
  const mine = existing.filter((model) => model.provider === providerId);
  const others = existing.filter((model) => model.provider !== providerId);
  const curated = new Set(mine.map((model) => model.upstreamModel));
  const candidates = [...new Set([...discovery.unregistered, ...curated])].sort();

  if (candidates.length === 0) {
    process.stdout.write(
      `Every model ${provider.displayName} advertises is already in the registry.\n`,
    );
    return;
  }

  const chosen = modelsOption
    ? modelsOption.split(",").map((value) => value.trim()).filter(Boolean)
    : chooseInteractively(candidates, curated);
  for (const id of chosen) {
    if (!candidates.includes(id)) {
      throw new Error(
        `${id} is not an available candidate for ${providerId}. Candidates: ${candidates.join(", ")}`,
      );
    }
  }

  const inheritedProfile = MODELS.find(
    (model) => model.provider === providerId && model.requestProfile,
  )?.requestProfile;
  const byUpstream = new Map(mine.map((model) => [model.upstreamModel, model]));
  const nextMine = chosen.map(
    (id, index) =>
      byUpstream.get(id) ||
      userModelEntry({
        providerId,
        upstreamId: id,
        requestProfile: inheritedProfile,
        priority: 100 + index,
      }),
  );
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

main().catch((error) => {
  console.error(`codex-router curate-models: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
