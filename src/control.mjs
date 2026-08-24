import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pickerCommandArgs } from "./control-args.mjs";
import { nativeSubagentCertification, promoteNativeMultiAgent } from "./catalog.mjs";
import {
  applyModelOverlayPublication,
  transactModelOverlayMutation,
} from "./model-overlay-publication.mjs";
import { withModelOverlayLock } from "./model-overlay-lock.mjs";
import { withNativeContextVariants } from "./native-context-variants.mjs";
// The publish marker lives under the shared state directory, which does not
// vary by target, so reading it here does not disturb the per-target probes
// below that re-import paths with their own MODEL_ROUTER_TARGET.
import {
  CALLER_SECRET_PATH,
  DSH_CATALOG_PATH,
  GEMINI_CATALOG_PATH,
  PORTS,
  PROVIDER_SELECTION_PATH,
} from "./paths.mjs";
// Same reasoning: presence is a property of the shared plane, not of a target,
// so the overview can resolve it statically without perturbing those probes.
import { presenceSnapshot } from "./presence-state.mjs";
import { harnessSnapshotWithWeb } from "./dsh-install.mjs";
import { USER_MODELS_PATH } from "./user-models.mjs";
import { refreshTargetPickerIfInstalled } from "./target-integration.mjs";
import {
  chatGptSessionStatus,
  setChatGptSessionSharingFromControl,
} from "./chatgpt-session-control.mjs";

// Cross-target control plane for a tray/UI (e.g. the planned pane fork). It
// reads which registry models are enabled per target and toggles them. Toggling
// only rewrites each target's provider selection; making it live is a separate
// explicit `apply`, so a toggle never silently restarts a running target.

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), "..");
// The harness integration appears here only once it is installed. The tray
// renders one section per target, so listing `dsh` unconditionally would put an
// empty section in front of every Codex-only install for a client they do not
// run. `dsh-models.json` is written by the publish and removed by the
// uninstall, so its presence is exactly the question being asked.
const DSH_PUBLISHED = DSH_CATALOG_PATH;
const GEMINI_PUBLISHED = GEMINI_CATALOG_PATH;
const TARGETS = [
  "codex",
  ...(existsSync(DSH_PUBLISHED) ? ["dsh"] : []),
  ...(existsSync(GEMINI_PUBLISHED) ? ["gemini"] : []),
];
const args = process.argv.slice(2);

function targetIsActive(target) {
  // One service serves every client, so "is this target active" cannot be the
  // service's own status for more than one of them. For the harness it is
  // whether the route has been published into its settings document.
  if (target === "dsh") return existsSync(DSH_PUBLISHED);
  // Same question for Gemini CLI: whether this router published its `.env`
  // block. The CLI itself is not a resident process there is anything to poll.
  if (target === "gemini") return existsSync(GEMINI_PUBLISHED);
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, "src", "service.mjs"), "status"], {
    env: { ...process.env, MODEL_ROUTER_TARGET: target },
    encoding: "utf8",
  });
  try {
    const status = JSON.parse(result.stdout);
    return Boolean(status.installed || status.loaded);
  } catch {
    return false;
  }
}

function optionValue(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function configuredDefaultModel(configPath) {
  if (!existsSync(configPath)) return undefined;
  const config = readFileSync(configPath, "utf8");
  const firstTable = config.search(/^\s*\[/m);
  const root = firstTable === -1 ? config : config.slice(0, firstTable);
  return root.match(/^\s*model\s*=\s*["']([^"']+)["']/m)?.[1];
}

function codexConfigSnapshot() {
  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "src", "config-manager.mjs"), "status"],
    { env: { ...process.env, MODEL_ROUTER_TARGET: "codex" }, encoding: "utf8" },
  );
  if (result.status !== 0) return undefined;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
}

// One list, three consumers: the probe the tray renders, the resolve that names
// the current engine, and the validation that accepts a pin. They disagreed
// once already -- the picker offered native models the setter then rejected --
// so the criteria now live in one place for every surface (see
// `src/vision-engines.mjs`).
async function shippedNativeVisionEngines(hidden) {
  const { installedNativeVisionEngines } = await import("./vision-engines.mjs");
  return installedNativeVisionEngines({ hidden });
}

function nativeCodexModels(
  catalogPath,
  hiddenModels = new Set(),
  subagentSettings = {},
  { contextVariants = true } = {},
) {
  if (!existsSync(catalogPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(catalogPath, "utf8"));
    const nativeBaseSlugs = new Set(
      (Array.isArray(parsed.models) ? parsed.models : [])
        .map((model) => String(model?.slug || ""))
        .filter(Boolean),
    );
    const nativeModels = withNativeContextVariants(
      // The capture holds what Codex published; the extended-window variants
      // are the router's own additions to the same group, and the tray is
      // where they are switched on, so they have to be drawn here too. The
      // catalog build derives them from this same list, so the rows the
      // operator sees and the entries Codex reads cannot drift apart.
      Array.isArray(parsed.models) ? parsed.models : [],
      { enabled: contextVariants },
    );
    const certificationBySlug = new Map(
      nativeModels.map((model) => [model.slug, nativeSubagentCertification(model) || "unknown"]),
    );
    return promoteNativeMultiAgent(
      nativeModels,
      subagentSettings,
      hiddenModels,
    )
      .filter((model) => model.visibility === "list" && typeof model.slug === "string")
      .map((model) => ({
        slug: model.slug,
        displayName: model.display_name || model.slug,
        provider: "openai",
        gatewayModel: model.slug,
        enabled: true,
        native: true,
        // Omit the field for base entries for compatibility with existing
        // probe consumers; a false marker identifies synthesized variants.
        ...(nativeBaseSlugs.has(model.slug) ? {} : { nativeClientManaged: false }),
        multiAgentVersion: model.multi_agent_version || "v1",
        subagentCertification: certificationBySlug.get(model.slug) || "unknown",
        // Base native entries belong to Codex's own catalog.  A router picker
        // overlay must not make them disappear; synthesized context variants
        // remain router-managed and can still be switched off explicitly.
        visible: nativeBaseSlugs.has(model.slug) || !hiddenModels.has(model.slug),
        ...reasoningLevelField(model.supported_reasoning_levels),
      }));
  } catch {
    return [];
  }
}

// Registry entries carry objects ({ effort, description }); the merged catalog
// carries the same list in Codex's wire shape. Both reduce to the effort names
// a surface can offer.
function reasoningLevelField(levels) {
  const names = (Array.isArray(levels) ? levels : [])
    .map((level) => (typeof level === "string" ? level : level?.effort))
    .filter((level) => typeof level === "string" && level);
  return names.length ? { reasoningLevels: names } : {};
}

function subagentCertification(model) {
  const version = model?.multiAgentVersion ?? model?.multi_agent_version;
  if (version === "v2" || version === "v1") return version;
  return "unknown";
}

// --- per-target probes (run with MODEL_ROUTER_TARGET set) -------------------

async function emitProbe() {
  const { CONFIG_PATH, NATIVE_CATALOG_PATH, TARGET, PROVIDER_SELECTION_PATH } =
    await import("./paths.mjs");
  const { canonicalProviderId, readProviderSelection } = await import("./provider-selection.mjs");
  const { LISTED_MODELS, PROVIDERS } = await import("./model-registry.mjs");
  const { readNativeAliases } = await import("./native-alias.mjs");
  const { subagentSettingsSnapshot } = await import("./multi-agent-state.mjs");
  const { modelPickerSnapshot } = await import("./model-picker-state.mjs");
  const { toolResultAgingSnapshot } = await import("./tool-result-aging-state.mjs");
  const { readVisionBridgeSettings, visionBridgeSnapshot } = await import(
    "./vision-bridge-state.mjs"
  );
  const { rankVisionEngines, resolveVisionEngine, visionEngineEfforts } = await import(
    "./vision-bridge.mjs"
  );
  const { installedNativeVisionEngines } = await import("./vision-engines.mjs");
  const { annotateLocalModels, hostVisionProfile, refreshVisionModelSizesIfStale } =
    await import("./vision-host.mjs");
  const { readVisionDownload } = await import("./vision-download.mjs");
  const { readBenchmarkResults } = await import("./vision-benchmark.mjs");
  const { readLocalBenchmarks } = await import("./local-benchmark.mjs");
  const visionBenchmarks = readBenchmarkResults();
  const localBenchmarks = readLocalBenchmarks();
  const localAndVisionBenchmarks = Object.fromEntries(
    [...new Set([...Object.keys(visionBenchmarks), ...Object.keys(localBenchmarks)])]
      .map((tag) => [tag, { ...visionBenchmarks[tag], ...localBenchmarks[tag] }]),
  );
  const { localModelInventory, localModelsSnapshot, runningLocalModels } = await import(
    "./local-models.mjs",
  );
  const { localOllamaRuntimeSnapshot } = await import("./ollama-runtime.mjs");
  const { selectedConfiguredListedModels } = await import("./provider-selection.mjs");
  // Bounded and weekly: the tray reads this snapshot constantly, so a fresh
  // cache costs nothing and a stale one costs one short, failure-tolerant pass.
  if (TARGET === "codex") await refreshVisionModelSizesIfStale();
  // One probe serves several tray sections. Reuse the local reads so the same
  // snapshot does not run `ollama list` and the hardware checks once per view.
  const localInventory = TARGET === "codex" ? localModelInventory() : [];
  const localRunning = TARGET === "codex" ? runningLocalModels() : [];
  const localProfile = TARGET === "codex" ? hostVisionProfile() : undefined;
  const localRuntime = TARGET === "codex" ? localOllamaRuntimeSnapshot() : undefined;
  const localInstalled = localInventory.map((model) => model.tag);

  const enabledProviders = readProviderSelection();
  const picker = modelPickerSnapshot();
  const hiddenModels = new Set(picker.hidden);
  const visibleModels = new Set(picker.visible);
  const subagentSettings = subagentSettingsSnapshot();
  const usageEvents = TARGET === "codex"
    ? (await import("./usage-events.mjs")).recentUsageEvents()
    : [];
  // Local proof records are surfaced for status only. They never alter the
  // registry capability sent to Codex.
  const { applySubagentProofs } = await import("./subagent-proofs.mjs");
  const effectiveListedModels = applySubagentProofs(
    LISTED_MODELS,
    subagentSettings.proofs,
    { hidden: hiddenModels },
  );
  // The tray groups models by provider to build its rows, so protocol
  // variants report their canonical family id: one opencode Go row, not three.
  const routedModels = effectiveListedModels.map((model) => ({
    slug: model.slug,
    displayName: model.displayName,
    provider: canonicalProviderId(model.provider),
    gatewayModel: model.gatewayModel,
    enabled: enabledProviders.includes(model.provider),
    multiAgentVersion: model.multiAgentVersion || "v1",
    subagentCertification: subagentCertification(model),
    visible: picker.hasExplicitVisibility
      ? visibleModels.has(model.slug)
      : !hiddenModels.has(model.slug),
    isFree: model.isFree === true,
    // The ladders differ per model, so a surface offering a subagent effort
    // has to be told which levels this one accepts rather than guessing from a
    // global list. Omitted when the model advertises none, so an entry without
    // a ladder keeps the exact shape it always had.
    ...reasoningLevelField(model.reasoningLevels),
  }));
  const selectedModel = TARGET === "codex" ? configuredDefaultModel(CONFIG_PATH) : undefined;
  const codexConfig = TARGET === "codex" ? codexConfigSnapshot() : undefined;
  const models = TARGET === "codex"
    ? [
        ...nativeCodexModels(NATIVE_CATALOG_PATH, hiddenModels, subagentSettings, {
          // A login-free install republishes external models under the native
          // slugs Codex allowlists, and a synthesized slug is not one of them.
          // The catalog build drops the variants there for the same reason, so
          // the tray must not offer a row the picker will never show.
          contextVariants: !codexConfig?.login_free,
        }),
        ...routedModels,
      ]
    : routedModels;

  process.stdout.write(
    JSON.stringify({
      target: TARGET,
      configured: existsSync(PROVIDER_SELECTION_PATH),
      active: targetIsActive(TARGET),
      enabledProviders,
      providers: [...PROVIDERS.values()]
        .filter((provider) => !provider.variantOf)
        .map((provider) => ({
          id: provider.id,
          displayName: provider.displayName,
          kind: provider.kind,
          // The vendor, so a UI can group the rows a `variantOf` cannot merge.
          // Z.ai, Kimi, and xAI each publish several providers that are one
          // brand but genuinely separate accounts -- different endpoints, and
          // keys that are not interchangeable -- so they must stay separately
          // connectable while still reading as one vendor.
          ownedBy: provider.ownedBy,
          // An anonymous gateway is not an account, so the tray needs this to
          // keep one out of a vendor's "N accounts" group (opencode-free would
          // otherwise be drawn as a second opencode account).
          authMode: provider.authMode,
        })),
      models,
      ...(selectedModel ? { selectedModel } : {}),
      ...(codexConfig
        ? {
            loginFree: Boolean(codexConfig.login_free),
            loginFreeManaged: Boolean(codexConfig.login_free_managed),
            signedRouting: Boolean(codexConfig.signed_routing),
            signedRoutingManaged: Boolean(codexConfig.signed_routing_managed),
            routerDefaultModel: codexConfig.router_default_model || undefined,
            routerDefaultManaged: Boolean(codexConfig.router_default_managed),
          }
        : {}),
      ...(TARGET === "codex"
        ? {
            usageEvents,
            nativeAliases: readNativeAliases(),
            modelSettings: {
              subagents: subagentSettings,
              picker: modelPickerSnapshot(),
              toolResultAging: toolResultAgingSnapshot(),
              localModels: {
                ...localModelsSnapshot({
                  inventory: localInventory,
                  running: localRunning,
                  runtime: localRuntime,
                  benchmarks: localAndVisionBenchmarks,
                }),
                // The panel's periodic refresh reads this snapshot, not
                // `local-models list`, so the LM Studio section must ride
                // here too or it paints once and vanishes on the next poll.
                lmstudio: await (await import("./lmstudio-models.mjs")).lmstudioSnapshot(),
              },
              visionBridge: (() => {
                const candidates = selectedConfiguredListedModels();
                // Only the native models that actually shipped into the picker.
                // A signed-out or login-free install has none, and offering one
                // there would pin an engine the router cannot reach. Same rule
                // the catalog build and the request path apply, from the same
                // helper, so the tray can never advertise an engine the setter
                // or the router would then refuse.
                const natives = installedNativeVisionEngines({ hidden: hiddenModels });
                const resolved = resolveVisionEngine(
                  () => [...candidates, ...natives],
                  readVisionBridgeSettings(),
                );
                return {
                  ...visionBridgeSnapshot(),
                  resolvedEngine: resolved?.slug || null,
                  resolvedEngineName: resolved?.displayName || null,
                  hostMemGib: localProfile.memGib,
                  // Cloud vision models the operator already pays for -- the
                  // default engines. Auto picks the cheapest of these.
                  paidEngines: rankVisionEngines(candidates).map((model) => ({
                    slug: model.slug,
                    displayName: model.displayName,
                    efforts: visionEngineEfforts(model),
                  })),
                  // Vision models from the signed-in ChatGPT session. No extra
                  // key, nothing to download: the plan is already being paid
                  // for. Kept apart from the paid list so the operator can see
                  // which bill a choice lands on.
                  nativeEngines: rankVisionEngines(natives).map((model) => ({
                    slug: model.slug,
                    displayName: model.displayName,
                    efforts: visionEngineEfforts(model),
                  })),
                  // The downloadable local picker, each with size + fit + state.
                  localModels: annotateLocalModels({
                    profile: localProfile,
                    installed: localInstalled,
                    benchmarks: localAndVisionBenchmarks,
                  }),
                  download: readVisionDownload(),
                };
              })(),
            },
          }
        : {}),
    }),
  );
}

async function emitProbeSet(provider, desired) {
  const { TARGET } = await import("./paths.mjs");
  const { disableProvider, enableProvider } = await import("./provider-selection.mjs");
  const { PROVIDERS } = await import("./model-registry.mjs");
  if (!PROVIDERS.has(provider)) throw new Error(`Unknown provider: ${provider}`);
  if (desired !== "on" && desired !== "off") throw new Error("state must be on or off");

  // The selection helpers own variant-family semantics: toggling a provider
  // that has protocol variants (or is one) toggles the whole family.
  const next = desired === "on" ? enableProvider(provider) : disableProvider(provider);
  process.stdout.write(JSON.stringify({ target: TARGET, enabledProviders: next }));
}

// The client probes below intentionally include client-specific details (for
// example Codex's native catalog and login-free aliases).  Model visibility and
// routed model identity do not belong to any of those clients, so expose one
// adapter-independent snapshot for the Control Center and other local tools.
// This is the router's source of truth: every client publisher consumes the
// same selected registry, picker state, and subagent policy.
async function routerCatalogSnapshot() {
  const { canonicalProviderId, readProviderSelection, selectedConfiguredListedModels } =
    await import("./provider-selection.mjs");
  const { CHECKED_IN_MODELS } = await import("./model-registry.mjs");
  const { modelPickerSnapshot } = await import("./model-picker-state.mjs");
  const { subagentSettingsSnapshot } = await import("./multi-agent-state.mjs");
  const { applySubagentProofs } = await import("./subagent-proofs.mjs");
  const settings = subagentSettingsSnapshot();
  const picker = modelPickerSnapshot();
  const hidden = new Set(picker.hidden);
  const visible = new Set(picker.visible);
  const selectedModels = selectedConfiguredListedModels();
  const models = applySubagentProofs(
    selectedModels,
    settings.proofs,
    { hidden, disabled: settings.disabled },
  ).map((model) => ({
    slug: model.slug,
    displayName: model.displayName,
    provider: canonicalProviderId(model.provider),
    gatewayModel: model.gatewayModel,
    enabled: true,
    multiAgentVersion: model.multiAgentVersion || "v1",
    subagentCertification: subagentCertification(model),
    visible: picker.hasExplicitVisibility ? visible.has(model.slug) : !hidden.has(model.slug),
    isFree: model.isFree === true,
    ...(Number.isFinite(model.contextWindow) ? { contextWindow: model.contextWindow } : {}),
    ...(Array.isArray(model.inputModalities) ? { inputModalities: model.inputModalities } : {}),
    ...reasoningLevelField(model.reasoningLevels),
  }));
  const availableSlugs = new Set(models.map((model) => model.slug));
  // Research inventory is intentionally separate from the routable catalog.
  // A desktop surface may explain that a checked-in route exists before the
  // provider is connected, but only `models` may reach a client publisher or
  // picker mutation. Keep this projection metadata-only: endpoints and
  // credential descriptors do not belong in the overview snapshot.
  const knownModels = CHECKED_IN_MODELS.filter((model) => model.listed).map((model) => ({
    slug: model.slug,
    displayName: model.displayName,
    provider: canonicalProviderId(model.provider),
    available: availableSlugs.has(model.slug),
    isFree: model.isFree === true,
    ...(Number.isFinite(model.contextWindow) ? { contextWindow: model.contextWindow } : {}),
    ...(Array.isArray(model.inputModalities) ? { inputModalities: model.inputModalities } : {}),
  }));
  const { routerDashboardState } = await import("./router-dashboard.mjs");
  return {
    source: "codex-router",
    configured: existsSync(PROVIDER_SELECTION_PATH),
    enabledProviders: readProviderSelection(),
    models,
    knownModels,
    picker,
    subagents: settings,
    ...routerDashboardState({ models: selectedModels }),
  };
}

// --- aggregate over all targets --------------------------------------------

function probeTargets() {
  const targets = {};
  for (const target of TARGETS) {
    const result = spawnSync(process.execPath, [SELF, "--probe"], {
      env: { ...process.env, MODEL_ROUTER_TARGET: target },
      encoding: "utf8",
    });
    try {
      targets[target] = result.status === 0 ? JSON.parse(result.stdout) : { target, error: (result.stderr || "").trim() || "probe failed" };
    } catch {
      targets[target] = { target, error: "probe returned invalid JSON" };
    }
  }
  return targets;
}

async function printOverview(asJson) {
  if (asJson) {
    const { ensureChatGPTProfileAccounts } = await import("./chatgpt-profile-switch.mjs");
    await ensureChatGPTProfileAccounts();
  }
  const targets = probeTargets();
  if (asJson) {
    // The tray polls this. Presence rides along so the rule that decides
    // whether the router may be stopped is computed once, here, rather than
    // re-derived from target flags on the Swift side where it would drift.
    // The harness snapshot joins it for the same reason -- and it has to be
    // the variant that probes the web port, or the tray reads every running
    // harness as stopped and offers to start one that is already up.
    process.stdout.write(
      `${JSON.stringify(
        {
          targets,
          // Keep this separate from `targets.codex`: native Codex entries and
          // login-free aliases are client concerns, while this catalog is the
          // durable router policy shared by Codex, DSH, and Gemini.
          catalog: await routerCatalogSnapshot(),
          // Explicit sharing consent and login usability are separate facts.
          // This projection contains no token, account id, credential path, or
          // filesystem age even though the underlying doctor status does.
          chatgptSession: await chatGptSessionStatus(),
          presence: presenceSnapshot(),
          harness: await harnessSnapshotWithWeb(),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  for (const target of TARGETS) {
    const slice = targets[target];
    if (slice.error) {
      process.stdout.write(`\n${target}: ${slice.error}\n`);
      continue;
    }
    process.stdout.write(`\n${target}${slice.configured ? "" : " (not set up)"}:\n`);
    for (const model of slice.models) {
      const mark = model.enabled ? "x" : " ";
      process.stdout.write(`  [${mark}] ${model.displayName}\n`);
    }
  }
}

function requestedControlTargets() {
  const requested = optionValue("--targets");
  const selected = requested ? requested.split(",").map((value) => value.trim()) : TARGETS;
  for (const target of selected) {
    if (!TARGETS.includes(target)) throw new Error(`Unknown target: ${target}`);
  }
  return selected;
}

function setProviderSelectionForTargets(provider, desired, selected) {
  for (const target of selected) {
    const result = spawnSync(process.execPath, [SELF, "--probe-set", provider, desired], {
      env: { ...process.env, MODEL_ROUTER_TARGET: target },
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(`${target}: ${(result.stderr || "").trim() || "toggle failed"}`);
    }
  }
}

async function runSet(provider, desired) {
  // The probe child performs the read/modify/write, so the parent must hold
  // the shared model-overlay lock around the whole fan-out. Otherwise two
  // target-aware CLI invocations can each publish a stale provider selection
  // even though the target files themselves are private and atomic.
  const selected = requestedControlTargets();
  await withModelOverlayLock(() => setProviderSelectionForTargets(provider, desired, selected));
  process.stderr.write(
    `Set ${provider} ${desired} for: ${selected.join(", ")}. Run \`bin/control apply\` to make it live.\n`,
  );
  await printOverview(args.includes("--json"));
}

function refreshActiveTarget(target) {
  const command =
    target === "codex"
      ? [process.execPath, [path.join(REPO_ROOT, "src", "catalog.mjs")]]
      : target === "dsh"
        ? [process.execPath, [path.join(REPO_ROOT, "src", "dsh-config-manager.mjs"), "install"]]
        : target === "gemini"
          ? [process.execPath, [path.join(REPO_ROOT, "src", "gemini-config-manager.mjs"), "install"]]
          : undefined;
  if (!command) return;
  const result = spawnSync(command[0], command[1], {
    env: { ...process.env, MODEL_ROUTER_TARGET: target },
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error(`${target}: refresh failed`);
}

// Active routers read provider selection on each request, so only their picker
// catalog needs refreshing. The full enable path is reserved for inactive targets.
async function applyProviderSelectionForTargets(selected, { activate = false } = {}) {
  const applied = [];
  const skipped = [];
  for (const target of selected) {
    if (!targetIsActive(target) && !activate) {
      skipped.push(target);
      continue;
    }
    if (targetIsActive(target)) {
      refreshActiveTarget(target);
    } else {
      // `bin/enable` is a POSIX shell script; spawning it on Windows failed
      // with ENOEXEC and reported it as a plain "apply failed". The shared
      // helper already knows each platform's checkout entry point and is unit
      // tested, so this branch is no longer a second untested copy.
      const { currentCheckoutInstaller } = await import("./update.mjs");
      const enable = currentCheckoutInstaller(process.platform, target, {
        posixScript: "enable",
      });
      const result = spawnSync(enable.command, enable.args, {
        cwd: REPO_ROOT,
        env: { ...process.env, MODEL_ROUTER_TARGET: target },
        stdio: "inherit",
      });
      if (result.status !== 0) throw new Error(`${target}: apply failed`);
    }
    applied.push(target);
  }
  return { applied, skipped };
}

async function runApply() {
  // Publication is the second half of the same transaction as the provider
  // selection write. Hold the model lock while the catalog child takes its
  // own inner catalog lock (model -> catalog is the sole lock ordering).
  const selected = requestedControlTargets();
  const result = await withModelOverlayLock(() => applyProviderSelectionForTargets(
    selected,
    { activate: args.includes("--activate") },
  ));
  process.stderr.write(
    `Applied: ${result.applied.join(", ") || "none"}. ` +
      `Skipped (not active): ${result.skipped.join(", ") || "none"}.\n`,
  );
}

// The Control Center needs a single failure boundary for a provider toggle.
// Holding one model-overlay transaction across both operations prevents a
// failed publication from restoring a snapshot taken before another process's
// successful selection change. Rollback restores the selection and republishes
// it before the lock is released.
async function runSetApply(provider, desired) {
  const selected = requestedControlTargets();
  const activate = args.includes("--activate");
  let publication;
  await transactModelOverlayMutation({
    files: [PROVIDER_SELECTION_PATH],
    mutate: () => setProviderSelectionForTargets(provider, desired, selected),
    // Selection belongs to the shared router plane. Republish every installed
    // client even when the initiating UI named only its own target.
    applyPublication: async () => {
      publication = await applyProviderSelectionForTargets(TARGETS, { activate });
      return publication;
    },
  });
  process.stderr.write(
    `Set ${provider} ${desired} for: ${selected.join(", ")}. ` +
      `Applied: ${publication.applied.join(", ") || "none"}. ` +
      `Skipped (not active): ${publication.skipped.join(", ") || "none"}.\n`,
  );
}

async function printAccountUsage() {
  const { readCodexAccountUsage } = await import("./codex-account-usage.mjs");
  const { ensureChatGPTProfileAccounts, selectedChatGPTUsageProfile } = await import("./chatgpt-profile-switch.mjs");
  await ensureChatGPTProfileAccounts();
  const profile = selectedChatGPTUsageProfile();
  const usage = profile.home
    ? await readCodexAccountUsage({ codexHome: profile.home })
    : await readCodexAccountUsage();
  process.stdout.write(`${JSON.stringify({
    ...usage,
    accountSelection: profile.selection,
    accountEmail: profile.email || null,
    profilePending: profile.pending === true,
  }, null, 2)}\n`);
}

async function printProviderUsage() {
  const { providerUsageSnapshot } = await import("./provider-usage.mjs");
  process.stdout.write(`${JSON.stringify(await providerUsageSnapshot(), null, 2)}\n`);
}

async function printProviderOnboarding() {
  const { providerOnboardingSnapshot } = await import("./provider-onboarding.mjs");
  process.stdout.write(`${JSON.stringify(providerOnboardingSnapshot(), null, 2)}\n`);
}

async function handleGenericProviders(...commandArgs) {
  const { runGenericProviderCli } = await import("./generic-providers.mjs");
  await runGenericProviderCli(commandArgs, { output: process.stdout });
}

async function installProviderCli(providerId) {
  const { installOauthCli, providerOnboardingSnapshot } = await import("./provider-onboarding.mjs");
  installOauthCli(providerId);
  process.stdout.write(`${JSON.stringify(providerOnboardingSnapshot())}\n`);
}

async function loginProvider(providerId) {
  const { loginOauthProvider, providerOnboardingSnapshot } = await import("./provider-onboarding.mjs");
  await loginOauthProvider(providerId);
  process.stdout.write(`${JSON.stringify(providerOnboardingSnapshot())}\n`);
}

async function invalidateProviderCatalog(providerId) {
  const { providerOnboardingSnapshot } = await import("./provider-onboarding.mjs");
  const provider = providerOnboardingSnapshot().providers.find((entry) => entry.id === providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);
  const { forgetProviderCatalogFamilyCache } = await import("./provider-catalogs.mjs");
  const cleared = await forgetProviderCatalogFamilyCache(providerId);
  process.stdout.write(`${JSON.stringify({ provider: providerId, cleared })}\n`);
}

async function readSecretFromStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 16 * 1024) throw new Error("The provider credential is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function saveProviderCredential(providerId) {
  const { providerOnboardingSnapshot, saveApiCredential } = await import("./provider-onboarding.mjs");
  const value = await readSecretFromStdin();
  // The control-center sends this command before it refreshes its provider
  // snapshot. Keep credential persistence, selection, and target publication
  // together so a concurrent remove cannot create an enabled credentialless
  // provider between the child processes.
  await withModelOverlayLock(async () => {
    const { withProviderCatalogCacheTransaction } = await import("./model-catalog-cache.mjs");
    const { providerCatalogFamilyCacheIds } = await import("./provider-catalogs.mjs");
    await withProviderCatalogCacheTransaction((catalog) => {
      saveApiCredential(providerId, value);
      // One credential can expose several account catalogs. The same lock
      // discovery uses for snapshot+commit makes write+invalidation one
      // generation boundary rather than a race with an old in-flight fetch.
      catalog.forget(providerCatalogFamilyCacheIds(providerId));
    });
    const { enableProvider } = await import("./provider-selection.mjs");
    enableProvider(providerId);
    const { refreshTargetPickerIfInstalled } = await import("./target-integration.mjs");
    refreshTargetPickerIfInstalled();
  });
  process.stdout.write(`${JSON.stringify(providerOnboardingSnapshot())}\n`);
}

async function deleteProviderCredential(providerId) {
  const { providerOnboardingSnapshot, removeApiCredential } = await import("./provider-onboarding.mjs");
  // Removing a managed credential also withdraws its provider selection. Keep
  // that low-level write under the same cross-process lock as the picker and
  // local-model mutations; status reads remain outside the lock.
  let removal;
  await withModelOverlayLock(async () => {
    const { withProviderCatalogCacheTransaction } = await import("./model-catalog-cache.mjs");
    const { providerCatalogFamilyCacheIds } = await import("./provider-catalogs.mjs");
    removal = await withProviderCatalogCacheTransaction(async (catalog) => {
      const result = await removeApiCredential(providerId);
      if (result.removedFiles) catalog.forget(providerCatalogFamilyCacheIds(providerId));
      return result;
    });
    if (removal.removedFiles) {
      const { refreshTargetPickerIfInstalled } = await import("./target-integration.mjs");
      refreshTargetPickerIfInstalled();
    }
  });
  process.stdout.write(
    `${JSON.stringify({ ...providerOnboardingSnapshot(), removal })}\n`,
  );
}

async function setLoginFreeMode(desired) {
  if (desired !== "on" && desired !== "off") {
    throw new Error("Usage: control auth-mode <on|off>");
  }
  let loginFreeModel;
  if (desired === "on") {
    const { providerOnboardingSnapshot } = await import("./provider-onboarding.mjs");
    const { readProviderSelection, selectedListedModels } = await import("./provider-selection.mjs");
    const { MODEL_BY_SLUG } = await import("./model-registry.mjs");
    const { readNativeAliases } = await import("./native-alias.mjs");
    const selected = new Set(readProviderSelection());
    const readyProviders = new Set(
      providerOnboardingSnapshot().providers
        .filter((provider) => selected.has(provider.id) && provider.configured)
        .map((provider) => provider.id),
    );
    if (readyProviders.size === 0) {
      throw new Error(
        "Connect and enable at least one external provider before turning on login-free mode.",
      );
    }
    const currentModel = codexConfigSnapshot()?.model;
    const currentRoute =
      MODEL_BY_SLUG.get(currentModel) ??
      MODEL_BY_SLUG.get(readNativeAliases()[currentModel]);
    loginFreeModel =
      currentRoute && readyProviders.has(currentRoute.provider)
        ? currentRoute.slug
        : selectedListedModels().find((model) => readyProviders.has(model.provider))?.slug;
    if (!loginFreeModel) {
      throw new Error("No enabled model is available for the connected external providers.");
    }
  }
  const catalog = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "src", "catalog.mjs")],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        MODEL_ROUTER_TARGET: "codex",
        MODEL_ROUTER_LOGIN_FREE: desired === "on" ? "1" : "0",
      },
      encoding: "utf8",
    },
  );
  if (catalog.status !== 0) {
    throw new Error((catalog.stderr || "Codex model catalog could not be refreshed.").trim());
  }
  if (loginFreeModel) {
    const { nativeAliasFor } = await import("./native-alias.mjs");
    loginFreeModel = nativeAliasFor(loginFreeModel) || loginFreeModel;
  }
  const command = desired === "on" ? "login-free-enable" : "login-free-disable";
  const commandArgs = [path.join(REPO_ROOT, "src", "config-manager.mjs"), command];
  if (loginFreeModel) commandArgs.push(loginFreeModel);
  const result = spawnSync(
    process.execPath,
    commandArgs,
    {
      cwd: REPO_ROOT,
      env: { ...process.env, MODEL_ROUTER_TARGET: "codex" },
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    throw new Error((result.stderr || "Codex provider mode could not be changed.").trim());
  }
  process.stdout.write(result.stdout);
}

async function setSignedRouting(desired) {
  if (desired !== "on" && desired !== "off") {
    throw new Error("Usage: control signed-routing <on|off>");
  }
  if (desired === "on") {
    const { selectedConfiguredListedModels } = await import("./provider-selection.mjs");
    if (selectedConfiguredListedModels().length === 0) {
      throw new Error(
        "Connect and enable at least one external provider before turning on signed routing.",
      );
    }
  }
  const command = desired === "on" ? "signed-enable" : "signed-disable";
  const runConfig = (configCommand = command) => spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "src", "config-manager.mjs"), configCommand],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, MODEL_ROUTER_TARGET: "codex" },
      encoding: "utf8",
    },
  );
  const runCatalog = (routing = desired, { allowTestFault = true } = {}) => {
    const environment = {
      ...process.env,
      MODEL_ROUTER_TARGET: "codex",
      MODEL_ROUTER_SIGNED_ROUTING: routing === "on" ? "1" : "0",
    };
    if (!allowTestFault) delete environment.MODEL_ROUTER_TEST_FAIL_AFTER_CATALOG_WRITE;
    return spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, "src", "catalog.mjs")],
      {
      cwd: REPO_ROOT,
      env: environment,
      encoding: "utf8",
      },
    );
  };
  // Enabling routes the transport first, so a partially completed operation
  // can only hide external models. Disabling hides them first, so they can
  // never escape through the restored direct provider endpoint.
  let result;
  let catalog;
  if (desired === "on") {
    result = runConfig();
    if (result.status === 0) catalog = runCatalog();
  } else {
    catalog = runCatalog();
    if (catalog.status === 0) result = runConfig();
  }
  if (result && result.status !== 0) {
    throw new Error((result.stderr || "Signed router mode could not be changed.").trim());
  }
  if (catalog.status !== 0) {
    if (desired === "on") {
      // A catalog process can fail after replacing one of its files. Before
      // restoring the user's direct provider, prove that a clean native-only
      // rebuild succeeds. If it does not, keep the signed router transport in
      // place: external entries against the router are safer than sending one
      // through a provider endpoint we no longer own.
      const safeCatalog = runCatalog("off", { allowTestFault: false });
      if (safeCatalog.status !== 0) {
        throw new AggregateError(
          [
            new Error((catalog.stderr || "Codex model catalog could not be refreshed.").trim()),
            new Error((safeCatalog.stderr || "The native-only rollback catalog failed.").trim()),
          ],
          "Signed routing remains active because the catalog could not be rolled back safely.",
        );
      }
      const rollback = runConfig("signed-disable");
      if (rollback.status !== 0) {
        throw new AggregateError(
          [
            new Error((catalog.stderr || "Codex model catalog could not be refreshed.").trim()),
            new Error((rollback.stderr || "Signed router configuration rollback failed.").trim()),
          ],
          "The catalog was made native-only, but signed router configuration could not be restored.",
        );
      }
    }
    throw new Error((catalog.stderr || "Codex model catalog could not be refreshed.").trim());
  }
  if (!result) {
    throw new Error("Signed router mode could not be changed.");
  }
  process.stdout.write(result.stdout);
}

async function setLoginFreeModel(slug) {
  const value = String(slug || "").trim();
  if (!value) throw new Error("Usage: control model-set <model-slug>");
  const config = codexConfigSnapshot();
  if (!config?.login_free) {
    throw new Error("Switching the tray model requires login-free mode.");
  }
  const { selectedConfiguredListedModels } = await import("./provider-selection.mjs");
  if (!selectedConfiguredListedModels().some((model) => model.slug === value)) {
    throw new Error(`${value} is not an enabled, authenticated external model.`);
  }
  const { nativeAliasFor } = await import("./native-alias.mjs");
  const configModel = nativeAliasFor(value) || value;
  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "src", "config-manager.mjs"), "login-free-enable", configModel],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, MODEL_ROUTER_TARGET: "codex" },
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    throw new Error((result.stderr || "The Codex model could not be changed.").trim());
  }
  process.stdout.write(result.stdout);
}

async function setRouterDefault(action, slug) {
  if (!["set", "clear"].includes(action)) {
    throw new Error("Usage: control router-default <set MODEL|clear>");
  }
  let value;
  if (action === "set") {
    value = String(slug || "").trim();
    if (!value) throw new Error("Usage: control router-default set MODEL");
    const { selectedConfiguredListedModels } = await import("./provider-selection.mjs");
    if (!selectedConfiguredListedModels().some((model) => model.slug === value)) {
      throw new Error(`${value} is not an enabled, authenticated external model.`);
    }
    const { modelPickerSnapshot } = await import("./model-picker-state.mjs");
    const picker = modelPickerSnapshot();
    const visible = picker.hasExplicitVisibility
      ? picker.visible.includes(value)
      : !picker.hidden.includes(value);
    if (!visible) {
      throw new Error(`${value} is not selected for the model picker. Show it before making it default.`);
    }
  }
  const command = action === "set" ? "router-default-set" : "router-default-clear";
  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "src", "config-manager.mjs"), command, ...(value ? [value] : [])],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, MODEL_ROUTER_TARGET: "codex" },
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    throw new Error((result.stderr || "The Codex router default could not be changed.").trim());
  }
  process.stdout.write(result.stdout);
}

async function updateAndVerifyCodex() {
  const { runCodexMaintenance } = await import("./codex-maintenance.mjs");
  process.stdout.write(`${JSON.stringify(runCodexMaintenance())}\n`);
}

function runDoctor(args) {
  const json = args.includes("--json");
  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "src", "doctor.mjs"), ...args],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, MODEL_ROUTER_TARGET: "codex" },
      stdio: json ? ["inherit", "pipe", "pipe"] : "inherit",
      ...(json ? { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 } : {}),
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (json) {
      try {
        const report = JSON.parse(String(result.stdout || ""));
        const failed = Array.isArray(report?.checks)
          ? report.checks.filter((check) => check.status === "fail").map((check) => check.name)
          : [];
        if (failed.length) throw new Error(`Doctor found problems: ${failed.join(", ")}.`);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Doctor found problems:")) throw error;
      }
    }
    throw new Error(
      (result.stderr || "The Codex doctor could not finish.").trim(),
    );
  }
  if (json) {
    try {
      const report = JSON.parse(String(result.stdout || ""));
      process.stdout.write(`${JSON.stringify(report)}\n`);
    } catch {
      throw new Error("The Codex doctor returned an unreadable report.");
    }
    return;
  }
  process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
}

function refreshModelSettingsCatalog() {
  // The router owns the model policy.  Rebuilding only merged-models.json
  // leaves a published DSH route with the previous picker state (and makes
  // Gemini look different again at its next process start).  The target
  // integration helper refreshes every installed client from this same state,
  // while preserving the Codex-only native catalog capture where applicable.
  try {
    return refreshTargetPickerIfInstalled();
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? error.message
        : "The router model catalogs could not be refreshed.",
    );
  }
}

async function restartRouterForLocalRoutes() {
  // User-model routes live in files the running router only reads at startup,
  // so a local model toggle needs the same service reload curated-model apply
  // performs. Foreground/dev routers have no service and are skipped.
  const { restartRouterServiceIfInstalled } = await import("./router-restart.mjs");
  const restarted = restartRouterServiceIfInstalled();
  if (restarted) {
    process.stderr.write("Router service restarted so local routes are live.\n");
  }
  return restarted;
}

async function finalizeLocalModelPublication() {
  // Finalization runs in a separate process after a detached uninstall worker
  // has removed the weights. It still needs the same lock as a full mutation,
  // or it could publish a snapshot between another operation's state write and
  // its catalog publication.
  return withModelOverlayLock(() => applyModelOverlayPublication({
    warningOnly: true,
    restart: true,
    restartService: restartRouterForLocalRoutes,
  }));
}

// What this model says it supports, read from the merged catalog Codex reads
// so the answer matches what would actually be sent. An empty list means the
// catalog could not be read, and the caller treats that as "do not block".
async function modelReasoningLevels(slug) {
  try {
    const { MERGED_CATALOG_PATH } = await import("./paths.mjs");
    const parsed = JSON.parse(readFileSync(MERGED_CATALOG_PATH, "utf8"));
    const entry = (parsed.models || []).find((model) => String(model.slug) === slug);
    const levels = entry?.supported_reasoning_levels;
    if (!Array.isArray(levels)) return [];
    return levels
      .map((level) => (typeof level === "string" ? level : level?.effort))
      .filter((level) => typeof level === "string" && level);
  } catch {
    return [];
  }
}

async function knownModelSlug(slug) {
  try {
    const { MERGED_CATALOG_PATH } = await import("./paths.mjs");
    const parsed = JSON.parse(readFileSync(MERGED_CATALOG_PATH, "utf8"));
    if (
      Array.isArray(parsed.models) &&
      parsed.models.some((model) => String(model.slug) === slug)
    ) {
      return true;
    }
  } catch {
    // Fall back to the checked-in registry for fresh installs.
  }
  const { MODEL_BY_SLUG } = await import("./model-registry.mjs");
  return MODEL_BY_SLUG.has(slug);
}

async function knownModelSubagentVersion(slug) {
  // Routed-model certification belongs to the registry. The merged Codex
  // catalog deliberately serializes an unknown route as conservative v1, so
  // consulting it first would mislabel every still-uncertified route as a
  // reviewed v1 verdict and make the compatibility-test workflow unreachable.
  const { MODEL_BY_SLUG } = await import("./model-registry.mjs");
  const registryModel = MODEL_BY_SLUG.get(slug);
  if (registryModel) return registryModel.multiAgentVersion;

  // Native models do not live in the routed registry. Read their undemoted
  // capture before the merged catalog: a disabled certified route is
  // deliberately serialized there as v1, but the operator must still be able
  // to turn it back on. This helper also carries the repository-pinned Luna
  // certificate and the parent-only verdict for context variants.
  try {
    const { NATIVE_CATALOG_PATH } = await import("./paths.mjs");
    const parsed = JSON.parse(readFileSync(NATIVE_CATALOG_PATH, "utf8"));
    const model = Array.isArray(parsed.models)
      ? parsed.models.find((candidate) => String(candidate?.slug) === slug)
      : undefined;
    // Finding the route is itself decisive: an omitted version is genuinely
    // unknown and must stay eligible for the compatibility workflow. Falling
    // through to the effective merged catalog would turn that unknown into
    // its conservative serialized v1 and make the UI's Test action fail.
    if (model) return nativeSubagentCertification(model);
  } catch {
    // Fall back to the merged catalog when the original capture is absent.
  }

  // Retain compatibility with installations that have a merged catalog but
  // no native capture. This is conservative: an effective v1 remains v1.
  try {
    const { MERGED_CATALOG_PATH } = await import("./paths.mjs");
    const parsed = JSON.parse(readFileSync(MERGED_CATALOG_PATH, "utf8"));
    const model = Array.isArray(parsed.models)
      ? parsed.models.find((candidate) => String(candidate?.slug) === slug)
      : undefined;
    if (model?.multi_agent_version === "v1" || model?.multi_agent_version === "v2") {
      return model.multi_agent_version;
    }
  } catch {
    // A missing or damaged merged catalog proves no native v1/v2 verdict.
  }
  return undefined;
}

async function nativeCodexBaseSlugs() {
  const { NATIVE_CATALOG_PATH } = await import("./paths.mjs");
  if (!existsSync(NATIVE_CATALOG_PATH)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(NATIVE_CATALOG_PATH, "utf8"));
    return new Set(
      (Array.isArray(parsed.models) ? parsed.models : [])
        .map((model) => String(model?.slug || ""))
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

async function handleSubagents(action, value, flag, rest = []) {
  const {
    replaceMultiAgentState,
    setMultiAgentMode,
    setMultiAgentModel,
    setSubagentEffort,
    setMultiAgentModels,
    subagentSettingsSnapshot,
  } = await import("./multi-agent-state.mjs");
  if (action === "status") {
    const { selectedConfiguredListedModels } = await import("./provider-selection.mjs");
    const { subagentAutoPolicySnapshot } = await import("./subagent-auto-policy.mjs");
    process.stdout.write(`${JSON.stringify({
      ...subagentSettingsSnapshot(),
      autoPolicies: subagentAutoPolicySnapshot(selectedConfiguredListedModels()),
    })}\n`);
    return;
  }
  if (action === "policy") {
    const [kind, selector, desired] = [value, flag, rest[2]];
    if (kind === "status" || !kind) {
      const { selectedConfiguredListedModels } = await import("./provider-selection.mjs");
      const { subagentAutoPolicySnapshot } = await import("./subagent-auto-policy.mjs");
      process.stdout.write(`${JSON.stringify(subagentAutoPolicySnapshot(selectedConfiguredListedModels()))}\n`);
      return;
    }
    if (!selector || !["on", "off"].includes(desired)) {
      throw new Error(
        "Usage: control subagents policy status|provider <provider-id> <on|off>|model <model-slug> <on|off>|family <name> <on|off>",
      );
    }
    const { setSubagentAutoPolicy, matchingSubagentAutoPolicyModels } = await import(
      "./subagent-auto-policy.mjs"
    );
    const policyState = setSubagentAutoPolicy(kind, selector, desired === "on");
    // Enabling a policy is explicit standing consent for its matching live
    // probes. Only models currently configured for this machine can spend it.
    if (desired === "on") {
      const { selectedConfiguredListedModels } = await import("./provider-selection.mjs");
      const matches = matchingSubagentAutoPolicyModels(
        selectedConfiguredListedModels().filter((model) => model.multiAgentVersion !== "v1"),
        policyState.policies,
      );
      const slugs = matches.map((model) => model.slug);
      if (slugs.length) {
        setMultiAgentModels(slugs, true);
        const { spawnDetachedVerification } = await import("./subagent-verify.mjs");
        spawnDetachedVerification(slugs);
      }
    }
    refreshModelSettingsCatalog();
    process.stdout.write(`${JSON.stringify(policyState)}\n`);
    return;
  }
  if (action === "select-all") {
    replaceMultiAgentState({ mode: "all", enabled: [], disabled: [] });
  } else if (action === "unselect-all") {
    const { selectedConfiguredListedModels } = await import("./provider-selection.mjs");
    const { modelPickerSnapshot } = await import("./model-picker-state.mjs");
    const { NATIVE_CATALOG_PATH } = await import("./paths.mjs");
    const picker = modelPickerSnapshot();
    const hidden = new Set(picker.hidden);
    const visible = new Set(picker.visible);
    const visibleModels = [
      ...nativeCodexModels(NATIVE_CATALOG_PATH, hidden).map((model) => model.slug),
      ...selectedConfiguredListedModels()
        .filter((model) => !hidden.has(model.slug) && (
          !picker.hasExplicitVisibility || visible.has(model.slug)
        ))
        .map((model) => model.slug),
    ];
    replaceMultiAgentState({
      mode: "selected",
      enabled: [],
      disabled: visibleModels,
    });
  } else if (action === "mode") {
    setMultiAgentMode(value);
  } else if (action === "verify") {
    // Explicit re-research: probe the named slugs (or every enabled one) in
    // the foreground and print the verdicts. Spends ~2 live requests per
    // candidate on that model's own provider.
    const { verifySubagentCandidates } = await import("./subagent-verify.mjs");
    const targets = rest.filter(Boolean);
    const sweep = targets.length
      ? targets
      : subagentSettingsSnapshot().enabled;
    const verified = await verifySubagentCandidates(sweep, { force: targets.length > 0 });
    refreshModelSettingsCatalog();
    process.stdout.write(`${JSON.stringify({ verified })}\n`);
    return;
  } else if (action === "set") {
    if (!["on", "off"].includes(flag)) {
      throw new Error("Usage: control subagents set <model-slug> <on|off>");
    }
    if (!(await knownModelSlug(value))) {
      throw new Error(`Unknown model slug: ${value}`);
    }
    if (flag === "on" && (await knownModelSubagentVersion(value)) === "v1") {
      throw new Error(
        `${value} is repository-certified v1 and cannot be enabled as a native v2 subagent.`,
      );
    }
    setMultiAgentModel(value, flag === "on");
    // Selection is the assignment: switching a model on hands it to the
    // compatibility probe. Detached, because this command answers a tray toggle
    // and cannot sit on a live network round-trip; the proofs snapshot shows
    // "checking" until the worker records a verdict and republishes.
    if (flag === "on") {
      const { spawnDetachedVerification } = await import("./subagent-verify.mjs");
      spawnDetachedVerification([value]);
    }
  } else if (action === "effort") {
    if (!(await knownModelSlug(value))) {
      throw new Error(`Unknown model slug: ${value}`);
    }
    const requested = String(flag || "").trim();
    // Validated against what this model advertises rather than a global list:
    // the ladders differ per model, and an effort the provider will reject is
    // better refused here, where the operator is watching, than mid-spawn.
    const levels = await modelReasoningLevels(value);
    if (requested && requested !== "default" && levels.length && !levels.includes(requested)) {
      throw new Error(
        `${value} does not support reasoning effort "${requested}". Supported: ${levels.join(", ")}`,
      );
    }
    setSubagentEffort(value, requested === "default" ? undefined : requested);
  } else if (action === "provider") {
    if (!["on", "off"].includes(flag)) {
      throw new Error("Usage: control subagents provider <provider-id> <on|off>");
    }
    const { canonicalProviderId, selectedConfiguredListedModels } = await import(
      "./provider-selection.mjs"
    );
    const provider = canonicalProviderId(String(value || "").trim());
    let slugs;
    if (provider === "openai") {
      const { NATIVE_CATALOG_PATH } = await import("./paths.mjs");
      slugs = nativeCodexModels(NATIVE_CATALOG_PATH)
        .filter((model) => model.subagentCertification !== "v1")
        .map((model) => model.slug);
    } else {
      slugs = selectedConfiguredListedModels()
        .filter(
          (model) =>
            canonicalProviderId(model.provider) === provider && model.multiAgentVersion !== "v1",
        )
        .map((model) => model.slug);
    }
    if (slugs.length === 0) {
      throw new Error(`No enabled models found for provider: ${value}`);
    }
    setMultiAgentModels(slugs, flag === "on");
    if (flag === "on") {
      const { spawnDetachedVerification } = await import("./subagent-verify.mjs");
      spawnDetachedVerification(slugs);
    }
  } else {
    throw new Error(
      "Usage: control subagents status|select-all|unselect-all|mode <all|selected|proven>|" +
        "set <model-slug> <on|off>|effort <model-slug> <level|default>|" +
        "provider <provider-id> <on|off>|verify [model-slug ...]|" +
        "policy status|provider <provider-id> <on|off>|model <model-slug> <on|off>|family <name> <on|off>",
    );
  }
  refreshModelSettingsCatalog();
  process.stdout.write(`${JSON.stringify(subagentSettingsSnapshot())}\n`);
}

const TOOL_RESULT_AGING_USAGE =
  "Usage: control tool-result-aging status|on|off|native <on|off>|ttl <days|off|default>|" +
  "purge [--yes] [--dry-run] [--expired]";

// Emptying the store deletes the only copy of bytes the model already saw, so
// the default is the report and not the deletion: an invocation without --yes
// says exactly what it would remove and removes nothing. --dry-run says the
// same thing on purpose rather than by omission, and outranks --yes so a
// wrapper that always passes consent can still preview.
//
// --expired removes only what the TTL has outlived. The store expires on the
// next write to it, so this is the same sweep run by hand: it is what an
// operator uses to reclaim a store that filled before the TTL existed, or one
// on an install where compaction is off and nothing is going to write again.
async function handleToolResultAgingPurge(flags) {
  const {
    describeRetentionAge,
    describeRetentionTtl,
    expireRetainedToolResults,
    formatRetentionBytes,
    purgeRetainedToolResults,
  } = await import("./tool-result-retention.mjs");
  const { retentionTtlMs } = await import("./tool-result-aging-state.mjs");
  const requested = new Set(flags);
  const previewOnly = requested.has("--dry-run") || !(requested.has("--yes") || requested.has("-y"));
  const expiredOnly = requested.has("--expired");
  const ttlMs = retentionTtlMs();
  if (expiredOnly && ttlMs === 0) {
    throw new Error(
      "Retained tool results have no TTL: this install was told to keep them. " +
        "Set one with ./bin/control tool-result-aging ttl <days>, or purge without --expired.",
    );
  }
  const result = expiredOnly
    ? expireRetainedToolResults({ dryRun: previewOnly, ttlMs })
    : purgeRetainedToolResults({ dryRun: previewOnly });
  const age =
    result.oldestAgeMs === undefined ? "" : `, oldest ${describeRetentionAge(result.oldestAgeMs)} old`;
  const scope = expiredOnly ? ` older than ${describeRetentionTtl(ttlMs)}` : "";
  if (!result.exists || result.files === 0) {
    process.stderr.write(`No retained tool results in ${result.path}; nothing to purge.\n`);
  } else if (expiredOnly && result.expired === 0) {
    process.stderr.write(
      `Nothing in ${result.path} is older than ${describeRetentionTtl(ttlMs)}` +
        ` (${result.results} retained result(s)${age}); nothing to purge.\n`,
    );
  } else if (previewOnly) {
    process.stderr.write(
      `Would remove ${result.removed} file(s)${scope} ` +
        `(${result.results} retained result(s)${age}) ` +
        `and reclaim ${formatRetentionBytes(result.reclaimedBytes)} from ${result.path}.\n` +
        `Nothing was deleted. Re-run with --yes to empty it: ` +
        `./bin/control tool-result-aging purge${expiredOnly ? " --expired" : ""} --yes\n`,
    );
  } else {
    process.stderr.write(
      `Removed ${result.removed} file(s)${scope} and reclaimed ` +
        `${formatRetentionBytes(result.reclaimedBytes)} from ${result.path}.\n`,
    );
  }
  if (result.foreign.length) {
    process.stderr.write(
      `Left ${result.foreign.length} entry/entries this store did not write in place: ` +
        `${result.foreign.slice(0, 5).join(", ")}\n`,
    );
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.failed.length) process.exitCode = 1;
}

async function handleToolResultAging(action, nativeAction, flags = []) {
  const {
    setNativeToolResultAgingEnabled,
    setRetentionTtlDays,
    setToolResultAgingEnabled,
    toolResultAgingSnapshot,
  } = await import("./tool-result-aging-state.mjs");
  const desired = action || "status";
  if (desired === "status") {
    process.stdout.write(`${JSON.stringify(toolResultAgingSnapshot())}\n`);
    return;
  }
  if (desired === "purge") {
    await handleToolResultAgingPurge(flags);
    return;
  }
  // How long a retained original lives. `off` is a real answer and is kept
  // verbatim -- an operator who wants the archive keeps it -- while `default`
  // clears the answer so a later release's number applies again.
  if (desired === "ttl") {
    const requested = String(nativeAction ?? "").trim();
    if (!requested) throw new Error(TOOL_RESULT_AGING_USAGE);
    if (requested === "default") {
      setRetentionTtlDays(undefined);
    } else if (requested === "off" || requested === "never") {
      setRetentionTtlDays(0);
    } else {
      setRetentionTtlDays(requested.replace(/d$/u, ""));
    }
    process.stdout.write(`${JSON.stringify(toolResultAgingSnapshot())}\n`);
    return;
  }
  if (desired === "native") {
    if (nativeAction !== "on" && nativeAction !== "off") {
      throw new Error(TOOL_RESULT_AGING_USAGE);
    }
    setNativeToolResultAgingEnabled(nativeAction === "on");
    process.stdout.write(`${JSON.stringify(toolResultAgingSnapshot())}\n`);
    return;
  }
  if (desired !== "on" && desired !== "off") {
    throw new Error(TOOL_RESULT_AGING_USAGE);
  }
  setToolResultAgingEnabled(desired === "on");
  process.stdout.write(`${JSON.stringify(toolResultAgingSnapshot())}\n`);
}

// Failover has one switch, one optional order, and one escape hatch. The
// escape hatch matters most: a cooldown is the router refusing to send to a
// provider, and an operator who believes it is wrong needs a way to say so
// without waiting out a window somebody else's clock chose.
async function handleFailover(action, ...rest) {
  const {
    clearAllProviderCooldowns,
    readFailoverSettings,
    readProviderCooldowns,
    setFailoverChain,
    setFailoverEnabled,
  } = await import("./model-failover.mjs");
  const snapshot = () => ({
    ...readFailoverSettings(),
    cooldowns: readProviderCooldowns(),
  });
  const desired = action || "status";
  if (desired === "status") {
    process.stdout.write(`${JSON.stringify(snapshot(), null, 2)}\n`);
    return;
  }
  if (desired === "on" || desired === "off") {
    setFailoverEnabled(desired === "on");
  } else if (desired === "chain") {
    setFailoverChain(rest);
  } else if (desired === "auto") {
    setFailoverChain([]);
  } else if (desired === "reset") {
    // Every recorded window at once. A provider is asked again on the very
    // next turn, and answers for itself.
    clearAllProviderCooldowns();
  } else {
    throw new Error(
      "Usage: control failover status|on|off|chain <model-slug,...>|auto|reset",
    );
  }
  process.stdout.write(`${JSON.stringify(snapshot(), null, 2)}\n`);
}

// The bridge changes what the picker advertises (image input on text-only
// models), so every mutation rebuilds the catalog the way the subagent and
// picker toggles do.
// The fewest-steps local path. Downloads nothing without consent: a vision
// model already served by a running runtime is pinned outright; a needed pull
// happens only with --yes; a missing runtime prints one install line and stops.
async function runVisionBridgeSetup({ consent }) {
  const { readVisionBridgeSettings, setVisionBridgeLocal, setVisionBridgeEnabled } =
    await import("./vision-bridge-state.mjs");
  const { suggestLocalVisionSetup, ollamaAvailable, pullOllamaModel, ollamaInstallMessage } =
    await import("./vision-host.mjs");

  const suggestion = await suggestLocalVisionSetup(readVisionBridgeSettings());
  const { chosen, baseUrl, needsPull, profile } = suggestion;

  // A runtime is already serving a vision model: pin it, no download.
  if (!needsPull) {
    setVisionBridgeLocal({ model: chosen, baseUrl });
    setVisionBridgeEnabled(true);
    process.stderr.write(
      `Vision bridge on: ${chosen} on ${suggestion.runningRuntimes.join(", ")} (already running, no download).\n`,
    );
    return;
  }

  // Nothing is serving one. Pulling is a multi-gigabyte download, so it needs
  // both a runtime and explicit consent.
  if (!ollamaAvailable() && !consent) {
    process.stderr.write(
      `No local vision runtime is running.\n` +
        `Recommended for this machine (${profile.memGib} GB ${profile.arch}): ${chosen}.\n` +
        `${ollamaInstallMessage()}\n` +
        `Prefer llama.cpp? Start it, then: ./bin/control vision-bridge local ${chosen} http://127.0.0.1:8080/v1\n`,
    );
    return;
  }
  if (!consent) {
    process.stderr.write(
      `Ready to download ${chosen} with Ollama (a few GB) for this ${profile.memGib} GB machine.\n` +
        `Re-run with --yes to download and enable it: ./bin/control vision-bridge setup --yes\n`,
    );
    return;
  }
  // Explicit consent also covers installing the missing runtime. The runtime
  // manager uses `ollama serve` detached, so this setup path never opens the
  // Ollama chat window.
  const { ensureOllamaHeadless } = await import("./ollama-runtime.mjs");
  await ensureOllamaHeadless({ install: true });
  process.stderr.write(`Downloading ${chosen} with Ollama…\n`);
  pullOllamaModel(chosen);
  setVisionBridgeLocal({ model: chosen, baseUrl });
  setVisionBridgeEnabled(true);
  process.stderr.write(`Vision bridge on: ${chosen} (local, via Ollama).\n`);
}

// "default" and an empty argument both mean "stop pinning a level", which is
// how every install behaved before the level was selectable.
function effortArgument(value, levels) {
  const effort = String(value ?? "").trim().toLowerCase();
  if (!effort || effort === "default" || effort === "auto") return null;
  if (!levels.includes(effort)) {
    throw new Error(`${effort} is not a reasoning effort. Choose one of: ${levels.join(", ")}, or "default".`);
  }
  return effort;
}

async function handleVisionBridge(action, value, extra) {
  const {
    readVisionBridgeSettings,
    setVisionBridgeEnabled,
    setVisionBridgeEffort,
    setVisionBridgeEngine,
    setVisionBridgeLocal,
    visionBridgeSnapshot,
    VISION_BRIDGE_STATE_PATH,
    VISION_EFFORT_LEVELS,
  } = await import("./vision-bridge-state.mjs");
  const {
    LOCAL_ENGINE_SLUG,
    rankVisionEngines,
    resolveVisionEngine,
    visionEngineEfforts,
  } = await import("./vision-bridge.mjs");
  const { selectedConfiguredListedModels } = await import("./provider-selection.mjs");
  const nativeEngines = await shippedNativeVisionEngines();
  const snapshot = () => {
    const candidates = [...selectedConfiguredListedModels(), ...nativeEngines];
    const settings = readVisionBridgeSettings();
    const resolved = resolveVisionEngine(() => candidates, settings);
    return {
      ...visionBridgeSnapshot(),
      // The local engine is a real answer even when no paid vision model is
      // enabled, so it is offered alongside the registry engines.
      resolvedEngine: resolved?.slug || null,
      resolvedEngineName: resolved?.displayName || null,
      availableEngines: [
        ...rankVisionEngines(candidates).map((model) => model.slug),
        LOCAL_ENGINE_SLUG,
      ],
      // What the engine now in force will actually accept. Empty means it
      // declares no levels, so the only honest answer is its own default.
      availableEfforts: resolved ? visionEngineEfforts(resolved) : [],
    };
  };
  if (action === "status") {
    process.stdout.write(`${JSON.stringify(snapshot())}\n`);
    return;
  }
  if (action === "probe") {
    // Read-only: reports what the machine can run and what the local server
    // already has, without pulling, pinning, or spending anything.
    const { suggestLocalVisionSetup } = await import("./vision-host.mjs");
    const suggestion = await suggestLocalVisionSetup(readVisionBridgeSettings());
    process.stdout.write(`${JSON.stringify(suggestion)}\n`);
    return;
  }
  if (action === "models") {
    // The downloadable local-model picker: each curated model with its size,
    // whether it fits this machine, and whether it is already pulled.
    const { annotateLocalModels, hostVisionProfile, refreshVisionModelSizesIfStale } =
      await import("./vision-host.mjs");
    const { readBenchmarkResults } = await import("./vision-benchmark.mjs");
    await refreshVisionModelSizesIfStale();
    process.stdout.write(
      `${JSON.stringify({
        host: hostVisionProfile(),
        models: annotateLocalModels({ benchmarks: readBenchmarkResults() }),
      })}\n`,
    );
    return;
  }
  if (action === "pull") {
    // Downloads a local vision model (gigabytes) with Ollama. The caller — a
    // tray row that shows the size, or a deliberate CLI command — is the
    // consent. Gigabytes take minutes, so the worker runs detached and this
    // returns at once; progress is polled with `pull-status`. The model is
    // pinned by the worker only after it lands.
    const tag = String(value || "").trim();
    if (!tag) throw new Error("Usage: control vision-bridge pull <model-tag>");
    const { ollamaAvailable, ollamaInstallMessage } = await import("./vision-host.mjs");
    if (!ollamaAvailable()) {
      throw new Error(`Ollama is not installed. ${ollamaInstallMessage()}`);
    }
    const {
      activeVisionDownloadResult,
      claimVisionDownloadStart,
      readVisionDownload,
      writeVisionDownload,
    } = await import("./vision-download.mjs");
    const claim = claimVisionDownloadStart();
    if (!claim.acquired) {
      const existing = activeVisionDownloadResult(readVisionDownload(), tag);
      if (existing) {
        process.stdout.write(`${JSON.stringify(existing)}\n`);
        return;
      }
      throw new Error("Another vision model download is starting. Try again shortly.");
    }
    try {
      const existing = activeVisionDownloadResult(readVisionDownload(), tag);
      if (existing) {
        process.stdout.write(`${JSON.stringify(existing)}\n`);
        return;
      }
      // Seeded here rather than in the worker so a poll that lands before the
      // child has started still sees the download, not a stale previous run.
      writeVisionDownload({
        version: 1,
        tag,
        status: "downloading",
        detail: "starting",
        percent: 0,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        controllerPid: process.pid,
        workerPid: null,
      });
      const child = spawn(
        process.execPath,
        [path.join(REPO_ROOT, "src", "vision-download.mjs"), tag],
        // windowsHide matters more here than anywhere else: a detached child
        // gets its own console on Windows, and this one lives for the length of
        // a multi-gigabyte pull. The local-model worker below already hides.
        { detached: true, stdio: "ignore", windowsHide: true },
      );
      child.unref();
      const workerState = readVisionDownload({ persist: false });
      if (workerState?.status === "downloading" && workerState.tag === tag) {
        writeVisionDownload({
          ...workerState,
          controllerPid: null,
          workerPid: child.pid,
          updatedAt: Date.now(),
        });
      }
      process.stdout.write(`${JSON.stringify({ started: true, tag })}\n`);
      return;
    } finally {
      claim.release();
    }
  }
  if (action === "benchmark") {
    // Measures an installed model against the checked-in ground-truth image and
    // stores the result, so a model the operator downloaded themselves can earn
    // a label without touching the CLI or trusting a reputation.
    const tag = String(value || "").trim();
    if (!tag) throw new Error("Usage: control vision-bridge benchmark <model-tag>");
    const { benchmarkModel, saveBenchmarkResult } = await import("./vision-benchmark.mjs");
    const { probeLocalServer } = await import("./vision-host.mjs");
    const server = await probeLocalServer();
    if (!server.reachable) {
      throw new Error(`No local runtime at ${server.baseUrl} (${server.error}).`);
    }
    const result = await benchmarkModel(tag, { baseUrl: server.baseUrl });
    if (!result.ok) throw new Error(result.error);
    // The transcript is only useful while debugging and would bloat the state
    // file with a page of text per model.
    const { transcript, ...stored } = result;
    saveBenchmarkResult(tag, stored);
    // No catalog rebuild: a score changes a label in this tray, not which
    // models Codex is offered, so this stays runnable from any checkout.
    process.stdout.write(`${JSON.stringify(stored)}\n`);
    return;
  }
  if (action === "pull-status") {
    const { readVisionDownload } = await import("./vision-download.mjs");
    process.stdout.write(`${JSON.stringify(readVisionDownload() || { status: "idle" })}\n`);
    return;
  }
  if (action === "setup") {
    // One command that gets a local vision model working with the fewest
    // steps. It downloads nothing without consent: a model already served by a
    // running runtime is pinned outright; a needed pull requires --yes; and a
    // missing runtime prints one install line rather than installing it.
    const consent = value === "--yes" || value === "-y" || extra === "--yes";
    await transactModelOverlayMutation({
      files: [VISION_BRIDGE_STATE_PATH],
      mutate: () => runVisionBridgeSetup({ consent }),
    });
    process.stdout.write(`${JSON.stringify(snapshot())}\n`);
    return;
  }
  let mutate;
  if (action === "on" || action === "off") {
    mutate = () => setVisionBridgeEnabled(action === "on");
  } else if (action === "local") {
    // control vision-bridge local [model] [baseUrl] -- pins a local model and
    // turns the bridge on in the same step. With no model, the machine picks
    // one: an already-pulled vision model, else the hardware recommendation.
    let model = String(value || "").trim();
    let baseUrl = String(extra || "").trim() || undefined;
    if (!model) {
      const { suggestLocalVisionSetup } = await import("./vision-host.mjs");
      const suggestion = await suggestLocalVisionSetup(readVisionBridgeSettings());
      model = suggestion.chosen;
      baseUrl = baseUrl || (suggestion.needsPull ? undefined : suggestion.baseUrl);
      const where = suggestion.runningRuntimes.length
        ? `on ${suggestion.runningRuntimes.join(", ")}`
        : "no local runtime detected";
      process.stderr.write(
        `Selected ${model} for ${suggestion.profile.memGib} GB ${suggestion.profile.arch} (${where})` +
          `${suggestion.needsPull ? ` — run: ${suggestion.pullCommand}` : " — already pulled"}\n`,
      );
    }
    mutate = () => {
      setVisionBridgeLocal({ model, baseUrl });
      setVisionBridgeEnabled(true);
    };
  } else if (action === "engine") {
    const slug = String(value || "").trim();
    if (slug && slug !== "auto" && slug !== LOCAL_ENGINE_SLUG) {
      // Must accept everything the picker offers. Validating against the routed
      // models alone rejected every native slug, so choosing one from the tray
      // silently left the previous engine in place.
      const available = rankVisionEngines([
        ...selectedConfiguredListedModels(),
        ...nativeEngines,
      ]);
      if (!available.some((model) => model.slug === slug)) {
        throw new Error(
          `${slug} is not an enabled model that reads images. Choose one of: ${
            available.map((model) => model.slug).join(", ") || "(none enabled)"
          }, or "local" for a local vision model, or "auto".`,
        );
      }
    }
    const engine = slug && slug !== "auto" ? slug : null;
    const effort = extra === undefined
      ? undefined
      : effortArgument(extra, VISION_EFFORT_LEVELS);
    // The tray picks an engine and a level in one click, so the level rides
    // along here. Left out, whatever was pinned before stays pinned.
    mutate = () => {
      setVisionBridgeEngine(engine);
      if (effort !== undefined) setVisionBridgeEffort(effort);
    };
  } else if (action === "effort") {
    const effort = effortArgument(value, VISION_EFFORT_LEVELS);
    mutate = () => setVisionBridgeEffort(effort);
  } else {
    throw new Error(
      "Usage: control vision-bridge status|probe|models|setup [--yes]|on|off|" +
        "engine <model-slug|local|auto> [effort]|effort <level|default>|" +
      "local [model] [baseUrl]|pull <model-tag>",
    );
  }
  await transactModelOverlayMutation({
    files: [VISION_BRIDGE_STATE_PATH],
    mutate,
  });
  process.stdout.write(`${JSON.stringify(snapshot())}\n`);
}

// Local models are managed as their own thing, not as a vision detail: the
// operator installs, checks, and removes them here, and the vision bridge is
// only one of the consumers.
async function handleLocalModels(action, value, ...rest) {
  // Variadic because `--yes` and `--force` answer different questions and an
  // install can need both: `--yes` consents to installing Ollama itself,
  // `--force` consents to a model this machine may not fit. A single flag slot
  // made that combination unexpressible.
  const options = rest.filter((item) => typeof item === "string");
  const flags = new Set(options.filter((item) => item.startsWith("--")));
  const positional = options.find((item) => !item.startsWith("--"));
  const {
    isLocalModelEnabled,
    LOCAL_MODELS_STATE_PATH,
    localModelsSnapshot,
    setLocalModelEnabled,
  } = await import("./local-models.mjs");
  const { readBenchmarkResults } = await import("./vision-benchmark.mjs");
  const { readLocalBenchmarks } = await import("./local-benchmark.mjs");
  const visionBenchmarks = readBenchmarkResults();
  const localBenchmarks = readLocalBenchmarks();
  const localAndVisionBenchmarks = Object.fromEntries(
    [...new Set([...Object.keys(visionBenchmarks), ...Object.keys(localBenchmarks)])]
      .map((tag) => [tag, { ...visionBenchmarks[tag], ...localBenchmarks[tag] }]),
  );
  // The LM Studio section rides along with every snapshot so the panel's one
  // `local_models` read covers both local runtimes. Its probe is a loopback
  // HTTP call with a short timeout, so an LM Studio that is simply off costs
  // the snapshot a bounded wait, not an error.
  const { lmstudioSnapshot } = await import("./lmstudio-models.mjs");
  const { localMlxUiSnapshot } = await import("./local-mlx-operation.mjs");
  const snapshot = async () => {
    const [lmstudio, mlx] = await Promise.all([lmstudioSnapshot(), localMlxUiSnapshot()]);
    return {
      ...localModelsSnapshot({ benchmarks: localAndVisionBenchmarks }),
      lmstudio,
      mlx,
    };
  };
  if (action === "list" || action === "status" || !action) {
    const current = await snapshot();
    // The tray and any script read JSON; a person at a terminal was handed a
    // single unbroken line, which only got worse once the snapshot grew a
    // download list. Explicit `--json` keeps the machine contract, and a bare
    // invocation is readable.
    if (value === "--json" || flags.has("--json") || !process.stdout.isTTY) {
      process.stdout.write(`${JSON.stringify(current)}\n`);
      return;
    }
    const { renderLocalModels } = await import("./local-models.mjs");
    process.stdout.write(`${renderLocalModels(current)}\n`);
    return;
  }
  if (action === "agent-check") {
    // Runs the real Codex client against the model. Slow by design: every
    // cheaper approximation tried here disagreed with reality.
    const { checkAgentCapability } = await import("./agent-check.mjs");
    const { readLocalModelSelection, saveAgentCheck } = await import("./local-models.mjs");
    const tags = value ? [String(value).trim()] : readLocalModelSelection().enabled;
    if (!tags.length) throw new Error("No local models are checked.");
    const results = [];
    for (const tag of tags) {
      const result = checkAgentCapability(`local/${tag}`);
      saveAgentCheck(tag, result);
      results.push({ tag, ...result });
    }
    process.stdout.write(`${JSON.stringify({ results })}\n`);
    return;
  }
  if (action === "inspect") {
    // Answers "can Codex drive this?" for a few kilobytes instead of a
    // multi-gigabyte download.
    // normalizeLocalModelTag throws on an empty or malformed reference, so
    // there is no separate emptiness check to make here.
    const { normalizeLocalModelTag } = await import("./local-model-ref.mjs");
    const tag = normalizeLocalModelTag(value);
    const {
      fetchRegistryCapabilities,
      fetchRegistryContext,
      describeMachine,
      detectMachine,
      rateDiskFit,
      rateModelFit,
    } = await import("./local-models.mjs");
    // Both are read from the model's own files rather than assumed: the chat
    // template says whether it can call tools, the GGUF header says how much
    // context it holds. One megabyte of ranged reads, no download.
    const [info, context] = await Promise.all([
      fetchRegistryCapabilities(tag),
      fetchRegistryContext(tag),
    ]);
    // Whether the machine can run it is as decisive as whether Codex can
    // drive it, and the manifest already carries the size.
    const capacity = detectMachine();
    process.stdout.write(
      `${JSON.stringify(
        info
          ? {
              ...info,
              context: context ?? null,
              fit: rateModelFit(info.sizeGb, capacity) ?? null,
              diskFit: rateDiskFit(info.sizeGb, capacity) ?? null,
              machine: describeMachine(capacity),
            }
          : { tag, unknown: true, context: context ?? null, machine: describeMachine(capacity) },
      )}\n`,
    );
    return;
  }
  if (action === "runtime") {
    const { localOllamaRuntimeSnapshot, ensureOllamaHeadless, updateOllamaRuntime } = await import(
      "./ollama-runtime.mjs"
    );
    const subcommand = String(value || "status").trim();
    if (subcommand === "status") {
      process.stdout.write(`${JSON.stringify(localOllamaRuntimeSnapshot())}\n`);
      return;
    }
    if (subcommand === "update") {
      if (!flags.has("--yes")) {
        throw new Error("Updating Ollama changes system software. Pass --yes to confirm.");
      }
      const result = updateOllamaRuntime();
      const running = await ensureOllamaHeadless({ install: false });
      process.stdout.write(`${JSON.stringify({ ...result, running: running.running })}\n`);
      return;
    }
    if (subcommand === "start") {
      const result = await ensureOllamaHeadless({ install: flags.has("--yes") });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    throw new Error("Usage: control local-models runtime status|start [--yes]|update --yes");
  }
  if (action === "benchmark") {
    const { benchmarkLocalModel } = await import("./local-benchmark.mjs");
    const tag = String(value || "").trim();
    if (!tag) throw new Error("Usage: control local-models benchmark <model-tag>");
    const result = await benchmarkLocalModel(tag);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (action === "mlx-status") {
    process.stdout.write(`${JSON.stringify(await localMlxUiSnapshot())}\n`);
    return;
  }
  if (action === "mlx-install") {
    const { startLocalMlxOperation } = await import("./local-mlx-operation.mjs");
    const result = startLocalMlxOperation({ yes: value === "--yes" || flags.has("--yes") });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (action === "mlx-cancel") {
    const { cancelLocalMlxOperation } = await import("./local-mlx-operation.mjs");
    process.stdout.write(`${JSON.stringify(cancelLocalMlxOperation())}\n`);
    return;
  }
  if (action === "cancel") {
    const { cancelLocalDownload } = await import("./local-download.mjs");
    const result = cancelLocalDownload(value);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (action === "install" || action === "install-and-use") {
    // Same detached-worker principle as the vision picker, but this worker is
    // for Codex chat models: successful completion checks the model on and
    // publishes the route automatically.
    const { normalizeLocalModelTag, splitLocalModelTag } = await import("./local-model-ref.mjs");
    const tag = normalizeLocalModelTag(value);
    const identity = splitLocalModelTag(tag);
    const {
      claimLocalOperation,
      isLocalOperationActive,
      readLocalDownload,
      writeLocalDownload,
    } = await import("./local-download.mjs");
    const startedAt = Date.now();
    const writePhase = (detail, extra = {}) => writeLocalDownload({
      version: 1,
      tag,
      status: "downloading",
      detail,
      percent: 0,
      startedAt,
      updatedAt: Date.now(),
      kind: "download",
      controllerPid: process.pid,
      workerPid: null,
      ...extra,
    });
    const claim = claimLocalOperation(tag, "download");
    if (!claim.acquired) {
      const active = readLocalDownload();
      if (isLocalOperationActive(active) && active.tag !== tag) {
        throw new Error(
          active.status === "uninstalling"
            ? `${active.tag} is already being removed.`
            : `${active.tag} is already downloading (${active.percent || 0}%).`,
        );
      }
      if (isLocalOperationActive(active) && active.tag === tag) {
        process.stdout.write(`${JSON.stringify({
          started: false,
          existing: true,
          tag,
          percent: active.percent || 0,
          detail: active.detail || "downloading",
          kind: active.kind || (active.status === "uninstalling" ? "uninstall" : "download"),
        })}\n`);
        return;
      }
      throw new Error("Another local model operation is starting. Try again shortly.");
    }
    // Persist the optimistic state before any network lookup or runtime
    // installation. The tray may refresh while either one is in progress, and
    // the operator should still see that the click was accepted.
    try {
      const { isLocalMlxOperationActive, readLocalMlxOperation } = await import(
        "./local-mlx-operation.mjs"
      );
      const mlxOperation = readLocalMlxOperation();
      if (isLocalMlxOperationActive(mlxOperation)) {
        throw new Error(`The curated MLX model is already ${mlxOperation.status}.`);
      }
      const active = readLocalDownload();
      if (isLocalOperationActive(active) && active.tag !== tag) {
        throw new Error(
          active.status === "uninstalling"
            ? `${active.tag} is already being removed.`
            : `${active.tag} is already downloading (${active.percent || 0}%).`,
        );
      }
      if (isLocalOperationActive(active) && active.tag === tag) {
        process.stdout.write(`${JSON.stringify({
          started: false,
          existing: true,
          tag,
          percent: active.percent || 0,
          detail: active.detail || "downloading",
          kind: active.kind || (active.status === "uninstalling" ? "uninstall" : "download"),
        })}\n`);
        return;
      }
      writePhase("Checking model and machine fit");
    } finally {
      claim.release();
    }
    const cancelled = () => readLocalDownload()?.status === "cancelled";
    try {
      const { fetchRegistryCapabilities, detectMachine, fitAdvisory, rateDiskFit, rateModelFit } =
        await import("./local-models.mjs");
      const advertised = await fetchRegistryCapabilities(tag);
      if (cancelled()) return;
      // A missing tool template costs nothing to discover afterwards; gigabytes
      // that cannot run cost the download and the disk. So the tool note stays
      // advisory while a model too large for this machine is refused unless the
      // operator overrides it deliberately.
      const capacity = detectMachine();
      const fit = advertised ? rateModelFit(advertised.sizeGb, capacity) : undefined;
      const diskFit = advertised ? rateDiskFit(advertised.sizeGb, capacity) : undefined;
      if ((fit === "too-large" || diskFit === "too-large") && !flags.has("--force")) {
        throw new Error(
          `${fitAdvisory(tag, advertised.sizeGb, capacity) || `${tag} may not fit on this machine's free disk.`} Pass --force to download it anyway.`,
        );
      }
      if (cancelled()) return;
      writePhase("Preparing headless Ollama");
      const { ensureOllamaHeadless, ollamaCommand } = await import("./ollama-runtime.mjs");
      // One action installs both. `--yes` is the operator's consent to touch
      // system software: with it a missing Ollama is installed headlessly (the
      // Homebrew formula when available, otherwise the official installer with
      // OLLAMA_NO_START=1) and then started as a detached `ollama serve`. The
      // Ollama desktop app is never launched. Without `--yes`, say so plainly
      // rather than surfacing the runtime layer's generic "not installed".
      const installRuntime = flags.has("--yes");
      if (!installRuntime && !ollamaCommand()) {
        throw new Error(
          `Ollama is not installed. Re-run with --yes to install it headlessly and then download ${tag}.`,
        );
      }
      await ensureOllamaHeadless({ install: installRuntime });
      if (cancelled()) return;
      writePhase("Starting model download");
      const child = spawn(process.execPath, [path.join(REPO_ROOT, "src", "local-download.mjs"), tag], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
      writeLocalDownload({
        ...readLocalDownload(),
        version: 1,
        kind: "download",
        tag,
        status: "downloading",
        detail: "Starting model download",
        percent: 0,
        startedAt,
        updatedAt: Date.now(),
        controllerPid: null,
        workerPid: child.pid,
      });
      // Advisory, never blocking: the operator may well want a vision-only
      // model, but they should know before the gigabytes land.
      process.stdout.write(
        `${JSON.stringify({
          started: true,
          tag,
          family: advertised?.family || identity.family,
          variant: advertised?.variant || identity.variant,
          tools: advertised?.tools ?? null,
          fit: fit ?? null,
          diskFit: diskFit ?? null,
          runtime: "headless",
        })}\n`,
      );
      const fitNote = advertised ? fitAdvisory(tag, advertised.sizeGb, capacity) : undefined;
      if (fitNote) process.stderr.write(`Note: ${fitNote}\n`);
      if (advertised && !advertised.tools) {
        process.stderr.write(
          `Note: ${tag} does not advertise tool calling, so Codex cannot use it as a chat model. ` +
            `It can still serve as a vision reader.\n`,
        );
      }
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (cancelled()) return;
      writeLocalDownload({
        ...readLocalDownload(),
        version: 1,
        kind: "download",
        tag,
        status: "error",
        detail: "failed",
        percent: readLocalDownload()?.percent || 0,
        startedAt,
        updatedAt: Date.now(),
        error: message,
      });
      throw error;
    }
  }
  if (action === "finalize-uninstall") {
    // Ollama removal has already completed by the time this cleanup step is
    // reached.  Catalog/gateway refresh and a service restart are follow-up
    // publication work: if either one is unavailable, report the warning but
    // do not turn a successfully removed model into a false removal failure.
    const warnings = await finalizeLocalModelPublication();
    process.stdout.write(`${JSON.stringify({
      finalized: true,
      tag: value || null,
      ...warnings,
    })}\n`);
    return;
  }
  if (action === "uninstall") {
    const rawTag = String(value || "").trim();
    if (!rawTag) throw new Error("Usage: control local-models uninstall <model-tag> --yes");
    if (!flags.has("--yes")) {
      throw new Error(`Removing ${rawTag} deletes it from disk. Pass --yes to confirm.`);
    }
    const { normalizeLocalModelTag } = await import("./local-model-ref.mjs");
    const tag = normalizeLocalModelTag(rawTag);
    const {
      claimLocalOperation,
      isLocalOperationActive,
      readLocalDownload,
      writeLocalDownload,
    } = await import("./local-download.mjs");
    const claim = claimLocalOperation(tag, "uninstall");
    if (!claim.acquired) {
      const active = readLocalDownload();
      if (isLocalOperationActive(active) && active.tag === tag) {
        process.stdout.write(`${JSON.stringify({
          started: false,
          existing: true,
          tag,
          kind: active.kind || (active.status === "uninstalling" ? "uninstall" : "download"),
          status: active.status,
        })}\n`);
        return;
      }
      throw new Error("Another local model operation is starting. Try again shortly.");
    }
    try {
    const { isLocalMlxOperationActive, readLocalMlxOperation } = await import(
      "./local-mlx-operation.mjs"
    );
    const mlxOperation = readLocalMlxOperation();
    if (isLocalMlxOperationActive(mlxOperation)) {
      throw new Error(`The curated MLX model is already ${mlxOperation.status}.`);
    }
    const active = readLocalDownload();
    if (isLocalOperationActive(active) && active.tag !== tag) {
      throw new Error(
        active.status === "uninstalling"
          ? `${active.tag} is already being removed.`
          : `${active.tag} is already downloading (${active.percent || 0}%).`,
      );
    }
    if (isLocalOperationActive(active) && active.tag === tag) {
      process.stdout.write(`${JSON.stringify({
        started: false,
        existing: true,
        tag,
        kind: active.kind || (active.status === "uninstalling" ? "uninstall" : "download"),
        status: active.status,
      })}\n`);
      return;
    }
    if (flags.has("--async")) {
      const startedAt = Date.now();
      writeLocalDownload({
        version: 1,
        kind: "uninstall",
        tag,
        status: "uninstalling",
        detail: "Starting model removal",
        percent: 0,
        startedAt,
        updatedAt: startedAt,
        controllerPid: process.pid,
        workerPid: null,
      });
      try {
        const child = spawn(
          process.execPath,
          [path.join(REPO_ROOT, "src", "local-uninstall.mjs"), tag],
          { detached: true, stdio: "ignore", windowsHide: true },
        );
        child.unref();
        writeLocalDownload({
          ...readLocalDownload(),
          controllerPid: null,
          workerPid: child.pid,
          updatedAt: Date.now(),
        });
      } catch (error) {
        writeLocalDownload({
          ...readLocalDownload(),
          status: "error",
          detail: "Removal failed to start",
          updatedAt: Date.now(),
          controllerPid: null,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      process.stdout.write(`${JSON.stringify({ started: true, tag, kind: "uninstall" })}\n`);
      return;
    }
    const { uninstallLocalModelTransaction } = await import("./local-uninstall.mjs");
    await uninstallLocalModelTransaction(tag, {
      restartService: restartRouterForLocalRoutes,
    });
    const warnings = await finalizeLocalModelPublication();
    const finishedAt = Date.now();
    writeLocalDownload({
      version: 1,
      kind: "uninstall",
      tag,
      status: "done",
      detail: warnings.catalogError
        ? "Model removed · catalog refresh needed"
        : warnings.restartError
          ? "Model removed · router restart needed"
          : "Model removed",
      percent: 100,
      startedAt: finishedAt,
      updatedAt: finishedAt,
      workerPid: null,
      controllerPid: null,
      ...(warnings.catalogError ? { catalogError: warnings.catalogError } : {}),
      ...(warnings.restartError ? { restartError: warnings.restartError } : {}),
      error: undefined,
    });
    } finally {
      claim.release();
    }
  } else if (action === "set") {
    if (!["on", "off"].includes(positional)) {
      throw new Error("Usage: control local-models set <model-tag> <on|off>");
    }
    const enabled = positional === "on";
    // Compared across spellings: the downloader stores `gemma3:latest` and a
    // hand-typed `gemma3` is the same model, so a raw string match here would
    // skip the router restart that publishes the route change.
    await transactModelOverlayMutation({
      files: [
        LOCAL_MODELS_STATE_PATH,
        USER_MODELS_PATH,
        PROVIDER_SELECTION_PATH,
      ],
      mutate: () => setLocalModelEnabled(value, enabled),
      // Evaluated after the transaction lock is held, so a queued toggle does
      // not make its restart decision from a stale pre-lock read.
      restart: () => isLocalModelEnabled(value) !== enabled,
      restartService: restartRouterForLocalRoutes,
    });
  } else if (action === "lmstudio-set") {
    if (!["on", "off"].includes(positional)) {
      throw new Error("Usage: control local-models lmstudio-set <model-id> <on|off>");
    }
    // The panel's checkbox for a model LM Studio serves. Publishing goes
    // through the same user-model overlay `curate-models lmstudio` writes,
    // and the same restart that makes an Ollama toggle live makes this one.
    const { isLmstudioModelEnabled, setLmstudioModelEnabled } = await import(
      "./lmstudio-models.mjs"
    );
    const enabled = positional === "on";
    await transactModelOverlayMutation({
      files: [USER_MODELS_PATH, PROVIDER_SELECTION_PATH],
      mutate: () => setLmstudioModelEnabled(value, enabled),
      restart: () => isLmstudioModelEnabled(value) !== enabled,
      restartService: restartRouterForLocalRoutes,
    });
  } else {
    throw new Error(
      "Usage: control local-models list [--json]|inspect <tag-or-url>|" +
        "install <tag-or-url> [--yes] [--force]|benchmark <tag>|" +
        "runtime status|runtime start [--yes]|runtime update --yes|" +
        "mlx-install --yes|mlx-status|mlx-cancel|" +
        "uninstall <tag> --yes|cancel [<tag>]|set <tag> <on|off>|" +
        "lmstudio-set <id> <on|off>\n" +
        "  --yes    consent to installing/starting Ollama itself (headless)\n" +
        "  --force  download a model rated too large for this machine anyway",
    );
  }
  process.stdout.write(`${JSON.stringify(await snapshot())}\n`);
}

async function handlePicker(action, value, flag) {
  const {
    modelPickerSnapshot,
    setAllModelsVisible,
    setModelVisible,
    setModelsVisible,
  } = await import("./model-picker-state.mjs");
  if (action === "status") {
    process.stdout.write(`${JSON.stringify(modelPickerSnapshot())}\n`);
    return;
  }
  await withModelOverlayLock(async () => {
    const nativeBaseSlugs = await nativeCodexBaseSlugs();
    if (action === "all") {
      if (!["show", "hide"].includes(flag)) {
        throw new Error("Usage: control picker all <show|hide>");
      }
      // Do not use only merged-models.json here. That file belongs to the
      // Codex adapter and may not exist on a DSH/Gemini-only installation;
      // the router's selected registry plus the captured native catalog is
      // the complete local policy surface for every installed client.
      const { MERGED_CATALOG_PATH } = await import("./paths.mjs");
      const { selectedConfiguredListedModels } = await import("./provider-selection.mjs");
      const slugs = new Set(selectedConfiguredListedModels().map((model) => String(model.slug)));
      // The router owns routed models; Codex owns its native picker entries.
      // Keep routed aliases/context variants from the last publication so a
      // refresh cannot lose a model merely because its native capture is
      // temporarily unavailable.
      if (existsSync(MERGED_CATALOG_PATH)) {
        try {
          const parsed = JSON.parse(readFileSync(MERGED_CATALOG_PATH, "utf8"));
          for (const model of Array.isArray(parsed?.models) ? parsed.models : []) {
            if (model?.slug && !nativeBaseSlugs.has(String(model.slug))) {
              slugs.add(String(model.slug));
            }
          }
        } catch {
          // The next publication will repair the merged catalog. The shared
          // router model set above is still enough to persist this mutation.
        }
      }
      setAllModelsVisible([...slugs], flag === "show");
    } else if (action === "set") {
      if (!["show", "hide"].includes(flag)) {
        throw new Error("Usage: control picker set <model-slug> <show|hide>");
      }
      if (!(await knownModelSlug(value))) {
        throw new Error(`Unknown model slug: ${value}`);
      }
      if (nativeBaseSlugs.has(String(value))) {
        throw new Error(
          "Native Codex model visibility is managed by Codex and is not part of the router picker overlay.",
        );
      }
      setModelVisible(value, flag === "show");
    } else if (action === "provider") {
      if (!["show", "hide"].includes(flag)) {
        throw new Error("Usage: control picker provider <provider-id> <show|hide>");
      }
      const provider = String(value || "").trim();
      let slugs;
      if (provider === "openai") {
        throw new Error(
          "Native Codex model visibility is managed by Codex and is not part of the router picker overlay.",
        );
      } else {
        const { canonicalProviderId, selectedConfiguredListedModels } = await import(
          "./provider-selection.mjs",
        );
        const canonical = canonicalProviderId(provider);
        slugs = selectedConfiguredListedModels()
          .filter((model) => canonicalProviderId(model.provider) === canonical)
          .map((model) => model.slug);
      }
      if (slugs.length === 0) {
        throw new Error(`No enabled models found for provider: ${value}`);
      }
      setModelsVisible(slugs, flag === "show");
    } else {
      throw new Error(
        "Usage: control picker status|all <show|hide>|set <model-slug> <show|hide>|" +
          "provider <provider-id> <show|hide>",
      );
    }
    // The write above is the router's durable source of truth. Publish it to
    // Codex, DSH, and Gemini while the same model-overlay lock is held so a
    // second command cannot race a client snapshot between the two steps.
    refreshModelSettingsCatalog();
  });
  process.stdout.write(`${JSON.stringify(modelPickerSnapshot())}\n`);
}

// The tray drives these two when it follows the Codex/ChatGPT desktop apps:
// `presence` records the mode so doctor can tell a deliberate shutdown from a
// crash, and `service` starts or stops the background service. Installing and
// uninstalling stay out of reach; the tray must not be able to unregister the
// LaunchAgent that owns the router.
const SERVICE_COMMANDS = ["status", "start", "stop", "restart"];

function handleService(action) {
  const value = action || "status";
  if (!SERVICE_COMMANDS.includes(value)) {
    throw new Error(`Usage: control service ${SERVICE_COMMANDS.join("|")}`);
  }
  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "src", "service.mjs"), value],
    { stdio: ["inherit", "pipe", "pipe"], env: process.env, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      String(result.stderr || `Background service ${value} failed with exit code ${result.status}.`).trim(),
    );
  }
  const output = String(result.stdout || "").trim();
  if (output) process.stdout.write(`${output}\n`);
  else process.stdout.write(`${JSON.stringify({ state: value === "stop" ? "stopped" : "running" })}\n`);
}

// Supervision for the tray companion. `disable` boots the agent out and stops
// the running tray too, so the Settings surface exposes it only behind its
// explicit confirmation dialog.
const TRAY_COMMANDS = { enable: "install", disable: "uninstall", status: "status", restart: "restart" };

function handleTray(action) {
  const value = action || "status";
  if (value === "refresh") {
    const plan = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, "src", "install-plan.mjs"), "tray-plan"],
      { cwd: REPO_ROOT, env: process.env, encoding: "utf8" },
    );
    if (plan.error) throw plan.error;
    if (plan.status !== 0) {
      throw new Error(String(plan.stderr || "The desktop companion refresh plan failed.").trim());
    }
    const decision = String(plan.stdout || "").trim();
    if (decision === "rebuild") return handleTray("rebuild");
    process.stdout.write(`${JSON.stringify({ tray: decision || "absent", rebuilt: false })}\n`);
    return;
  }
  if (value === "rebuild") {
    // The tray's footer Restart control wants the bundle rebuilt from this
    // checkout even when its source fingerprint says the installed copy is
    // current, so this bypasses the update flow's staleness check and runs
    // the launcher directly. The launcher quits the running tray only after
    // the staged replacement passes verification. `bin/model-router-tray` is
    // a POSIX shell script; Windows reaches the same sequence through
    // `codex-router.ps1 tray rebuild`, which owns the same unified Electron
    // replacement transaction so it exists once instead of drifting.
    const result = process.platform === "win32"
      ? spawnSync(
          "powershell.exe",
          [
            "-NoLogo",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            path.join(REPO_ROOT, "codex-router.ps1"),
            "tray",
            "rebuild",
            "--preserve-window",
          ],
          { stdio: "inherit", env: process.env, windowsHide: true },
        )
      : spawnSync(path.join(REPO_ROOT, "bin", "model-router-tray"), ["--preserve-window"], {
          stdio: "inherit",
          env: process.env,
        });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`Tray rebuild failed with exit code ${result.status}.`);
    }
    return;
  }
  const subcommand = TRAY_COMMANDS[value];
  if (!subcommand) {
    throw new Error(`Usage: control tray ${[...Object.keys(TRAY_COMMANDS), "refresh", "rebuild"].join("|")}`);
  }
  // Enabling can replace both a package and a pre-existing recognized task.
  // On Windows that must go through the durable PowerShell transaction, which
  // snapshots the exact task XML/SDDL and rollback package before touching
  // either. Calling tray-service.mjs install directly would strand a partial
  // registration when Task Scheduler or the ready handshake fails midway.
  const result = value === "enable" && process.platform === "win32"
    ? spawnSync(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path.join(REPO_ROOT, "codex-router.ps1"),
          "tray",
          "install",
          "--preserve-window",
        ],
        { stdio: "inherit", env: process.env, windowsHide: true },
      )
    : spawnSync(
        process.execPath,
        [path.join(REPO_ROOT, "src", "tray-service.mjs"), subcommand],
        { stdio: "inherit", env: process.env, windowsHide: true },
      );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Tray ${value} failed with exit code ${result.status}.`);
  }
}

// Where Codex's native-model background turns go when OpenAI quota is not an
// option. Set to a routed model slug to keep memories, review passes, and
// other native utility sessions running on a paid provider; clear to restore
// pure native forwarding.
async function handleNativeRedirect(action, value) {
  const { clearNativeRedirect, nativeRedirectSnapshot, setNativeRedirect } = await import(
    "./native-redirect.mjs"
  );
  if (!action || action === "status") {
    process.stdout.write(`${JSON.stringify(nativeRedirectSnapshot())}\n`);
    return;
  }
  if (action === "clear") {
    process.stdout.write(`${JSON.stringify(clearNativeRedirect())}\n`);
    return;
  }
  if (action !== "set") {
    throw new Error("Usage: control native-redirect status|set <routed-model-slug>|clear");
  }
  if (!(await knownModelSlug(value))) {
    throw new Error(`Unknown routed model slug: ${value}`);
  }
  process.stdout.write(`${JSON.stringify(setNativeRedirect(value))}\n`);
}

// One action for "give me a working harness": install the CLI if it is absent,
// then publish the routed models into its own documents. Kept behind an
// explicit subcommand rather than folded into `apply`, because it installs a
// third-party package and that must never be a side effect of something else.
async function handleHarness(action) {
  const { harnessSnapshotWithWeb, setupHarness } = await import("./dsh-install.mjs");
  if (!action || action === "status") {
    process.stdout.write(`${JSON.stringify(await harnessSnapshotWithWeb())}\n`);
    return;
  }
  if (action === "web") {
    const { dshWebState } = await import("./dsh-web.mjs");
    process.stdout.write(`${JSON.stringify(await dshWebState())}\n`);
    return;
  }
  if (action === "start") {
    const { startDshWeb } = await import("./dsh-web.mjs");
    process.stdout.write(`${JSON.stringify(await startDshWeb())}\n`);
    return;
  }
  if (action === "stop") {
    const { stopDshWeb } = await import("./dsh-web.mjs");
    process.stdout.write(`${JSON.stringify(await stopDshWeb())}\n`);
    return;
  }
  if (action === "disconnect" || action === "off") {
    const { disconnectHarness } = await import("./dsh-install.mjs");
    process.stdout.write(`${JSON.stringify(await disconnectHarness())}\n`);
    return;
  }
  if (action !== "setup" && action !== "install") {
    throw new Error("Usage: control harness status|setup|start|stop|web|disconnect");
  }
  const result = await setupHarness();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function handlePresence(action, value) {
  const { PRESENCE_MODES, presenceSnapshot, setPresenceMode } = await import(
    "./presence-state.mjs"
  );
  if (!action || action === "status") {
    process.stdout.write(`${JSON.stringify(presenceSnapshot())}\n`);
    return;
  }
  if (action !== "set") {
    throw new Error(`Usage: control presence status|set <${PRESENCE_MODES.join("|")}>`);
  }
  process.stdout.write(`${JSON.stringify(setPresenceMode(value))}\n`);
}

async function handleChatGptSession(action) {
  const desired = action || "status";
  if (desired === "status") {
    process.stdout.write(`${JSON.stringify(await chatGptSessionStatus())}\n`);
    return;
  }
  if (desired !== "enable" && desired !== "disable") {
    throw new Error("Usage: control chatgpt-session status|enable|disable");
  }
  process.stdout.write(
    `${JSON.stringify(await setChatGptSessionSharingFromControl(desired === "enable"))}\n`,
  );
}

async function handleProviderPools(action, provider, value) {
  const {
    getProviderApiKeyPool,
    readProviderApiKeyPoolState,
    sanitizeApiKeyPool,
    setProviderApiKeyPaused,
    setProviderApiKeyPoolPolicy,
  } = await import("./provider-api-key-pool.mjs");
  if (!action || action === "status") {
    const state = readProviderApiKeyPoolState();
    const pools = Object.entries(state.providers || {}).map(([id, pool]) => sanitizeApiKeyPool(id, pool));
    process.stdout.write(`${JSON.stringify(provider ? pools.find((pool) => pool.providerId === provider) || getProviderApiKeyPool(provider) : { pools })}\n`);
    return;
  }
  if (!provider) throw new Error("Usage: provider-pools status|policy <provider> <quota|round-robin|fill-first>|pause|resume <provider> <cred_id>");
  if (action === "policy") {
    if (!["quota", "round-robin", "fill-first"].includes(value)) throw new Error("Pool strategy is invalid.");
    process.stdout.write(`${JSON.stringify(setProviderApiKeyPoolPolicy(provider, { strategy: value }))}\n`);
    return;
  }
  if (action === "pause" || action === "resume") {
    if (!value) throw new Error("A credential id is required.");
    process.stdout.write(`${JSON.stringify(setProviderApiKeyPaused(provider, value, action === "pause"))}\n`);
    return;
  }
  throw new Error("Usage: provider-pools status|policy <provider> <quota|round-robin|fill-first>|pause|resume <provider> <cred_id>");
}

async function handleChatGptAccountPool(action, value, extra) {
  const {
    chatGPTSubscriptionAccountHome,
    chatGPTSubscriptionAccountPoolSnapshot,
    createChatGPTSubscriptionAccount,
    readChatGPTAccountPoolState,
    removeChatGPTSubscriptionAccount,
    sanitizeChatGPTAccountPool,
    withChatGPTAccountPoolLock,
    writeChatGPTAccountPoolState,
  } = await import("./chatgpt-account-pool.mjs");
  const { chatGPTProfileSwitchSnapshot, ensureChatGPTProfileAccounts, reconcileChatGPTProfileSwitch, requestChatGPTProfileSwitch } = await import("./chatgpt-profile-switch.mjs");
  if (!action || action === "status") {
    await ensureChatGPTProfileAccounts();
    const safe = chatGPTSubscriptionAccountPoolSnapshot();
    process.stdout.write(`${JSON.stringify({
      ...safe,
      profile: chatGPTProfileSwitchSnapshot(),
      sessions: { count: Object.keys(safe.sessions || {}).length },
    })}\n`);
    return;
  }
  if (action === "add") {
    const account = await withChatGPTAccountPoolLock(
      () => createChatGPTSubscriptionAccount({ label: value }),
    );
    process.stdout.write(`${JSON.stringify({ account, loginRequired: true })}\n`);
    return;
  }
  if (action === "home") {
    const state = readChatGPTAccountPoolState();
    if (!value || !/^acct_[A-Za-z0-9_-]{8,80}$/.test(value)) throw new Error("Account id is invalid.");
    if (!state.accounts[value]) throw new Error("Account id is not registered.");
    process.stdout.write(`${JSON.stringify({ accountId: value, home: chatGPTSubscriptionAccountHome(value) })}\n`);
    return;
  }
  if (action === "remove") {
    const state = readChatGPTAccountPoolState();
    const profile = chatGPTProfileSwitchSnapshot();
    if (profile.active === value) {
      if (profile.running) throw new Error("Close Codex before removing the active subscription account.");
      const replacement = Object.values(state.accounts).find((account) => account.id !== value && account.state === "active" && !account.paused);
      if (!replacement) throw new Error("Cannot remove the only logged-in ChatGPT account.");
      await requestChatGPTProfileSwitch(replacement.id);
    }
    const removed = await withChatGPTAccountPoolLock(() => removeChatGPTSubscriptionAccount(value));
    process.stdout.write(`${JSON.stringify(removed)}\n`);
    return;
  }
  if (action === "enable" || action === "disable") {
    const result = await withChatGPTAccountPoolLock(() => {
      const current = readChatGPTAccountPoolState();
      current.policy.enabled = action === "enable";
      return writeChatGPTAccountPoolState(current);
    });
    process.stdout.write(`${JSON.stringify({ ...sanitizeChatGPTAccountPool(result), profile: chatGPTProfileSwitchSnapshot() })}\n`);
    return;
  }
  if (action === "strategy") {
    if (!["quota", "round-robin", "fill-first"].includes(value)) throw new Error("Account-pool strategy is invalid.");
    const result = await withChatGPTAccountPoolLock(() => {
      const current = readChatGPTAccountPoolState();
      current.policy.strategy = value;
      return writeChatGPTAccountPoolState(current);
    });
    process.stdout.write(`${JSON.stringify({ ...sanitizeChatGPTAccountPool(result), profile: chatGPTProfileSwitchSnapshot() })}\n`);
    return;
  }
  if (action === "mode") {
    if (!["switch", "pool"].includes(value)) throw new Error("Account mode must be switch or pool.");
    const result = await withChatGPTAccountPoolLock(() => {
      const current = readChatGPTAccountPoolState();
      current.policy.mode = value;
      current.policy.enabled = true;
      return writeChatGPTAccountPoolState(current);
    });
    process.stdout.write(`${JSON.stringify({ ...sanitizeChatGPTAccountPool(result), profile: chatGPTProfileSwitchSnapshot() })}\n`);
    return;
  }
  if (action === "select") {
    const selection = String(value || "").trim();
    if (!selection || (!["primary", "auto"].includes(selection) && !/^acct_[A-Za-z0-9_-]{8,80}$/.test(selection))) {
      throw new Error("Account selection must be automatic or a registered account id.");
    }
    const migration = await ensureChatGPTProfileAccounts();
    const resolved = selection === "primary" ? migration.currentAccountId : selection;
    if (!resolved) throw new Error("No logged-in ChatGPT account is available.");
    const result = await withChatGPTAccountPoolLock(() => {
      const current = readChatGPTAccountPoolState();
      if (resolved === "auto") {
        current.policy.enabled = true;
        delete current.policy.selectedAccountId;
      } else {
        const account = current.accounts[resolved];
        if (!account || account.state !== "active" || account.paused) {
          throw new Error("The selected subscription account is not active.");
        }
        current.policy.enabled = true;
        current.policy.selectedAccountId = resolved;
      }
      return writeChatGPTAccountPoolState(current);
    });
    const profile = await requestChatGPTProfileSwitch(resolved);
    process.stdout.write(`${JSON.stringify({ ...sanitizeChatGPTAccountPool(result), profile })}\n`);
    return;
  }
  if (action === "profile") {
    if (value === "reconcile") {
      process.stdout.write(`${JSON.stringify(await reconcileChatGPTProfileSwitch())}\n`);
      return;
    }
    if (!value || value === "status") {
      process.stdout.write(`${JSON.stringify(chatGPTProfileSwitchSnapshot())}\n`);
      return;
    }
    throw new Error("Usage: chatgpt-account-pool profile status|reconcile");
  }
  if (action === "pause" || action === "resume") {
    if (!value || !/^acct_[A-Za-z0-9_-]{8,80}$/.test(value)) throw new Error("Account id is invalid.");
    const result = await withChatGPTAccountPoolLock(() => {
      const current = readChatGPTAccountPoolState();
      const account = current.accounts[value];
      if (!account) throw new Error("Account id is not registered.");
      account.paused = action === "pause";
      current.policy.pausedAccountIds = action === "pause"
        ? [...new Set([...current.policy.pausedAccountIds, value])]
        : current.policy.pausedAccountIds.filter((id) => id !== value);
      if (action === "pause" && current.policy.selectedAccountId === value) delete current.policy.selectedAccountId;
      return writeChatGPTAccountPoolState(current);
    });
    process.stdout.write(`${JSON.stringify(sanitizeChatGPTAccountPool(result))}\n`);
    return;
  }
  throw new Error("Usage: chatgpt-account-pool status|add [label]|home <acct_id>|remove <acct_id>|profile status|profile reconcile|enable|disable|mode <switch|pool>|strategy <quota|round-robin|fill-first>|select <auto|acct_id>|pause|resume <acct_id>");
}

async function handleRoutingPolicies(action, value, extra) {
  const {
    removeRoutingCombo,
    routingPolicySnapshot,
    setSearchSidecarConfig,
    setSubagentRoutingPolicy,
    setRoutingComboEnabled,
  } = await import("./routing-policy-state.mjs");
  if (!action || action === "status") {
    process.stdout.write(`${JSON.stringify(routingPolicySnapshot())}\n`);
    return;
  }
  if (action === "sidecar") {
    if (!["on", "off"].includes(value)) throw new Error("Usage: routing-policy sidecar <on|off>");
    if (value === "on") {
      const current = routingPolicySnapshot().searchSidecar;
      if (!current.providerId || !current.credentialRef) {
        throw new Error("Configure a sidecar provider and opaque credential reference before enabling search sidecar.");
      }
    }
    process.stdout.write(`${JSON.stringify(setSearchSidecarConfig({ enabled: value === "on" }))}\n`);
    return;
  }
  if (action === "subagents") {
    if (value === "allow-unverified" && ["on", "off"].includes(extra)) {
      process.stdout.write(`${JSON.stringify(setSubagentRoutingPolicy({ allowUnverifiedModels: extra === "on" }))}\n`);
      return;
    }
    throw new Error("Usage: routing-policy subagents allow-unverified <on|off>");
  }
  if (action === "combo" && (value === "remove" || value === "enable" || value === "disable")) {
    if (!extra) throw new Error("A combo id is required.");
    if (value === "remove") removeRoutingCombo(extra);
    else setRoutingComboEnabled(extra, value === "enable");
    process.stdout.write(`${JSON.stringify(routingPolicySnapshot())}\n`);
    return;
  }
  throw new Error("Usage: routing-policy status|sidecar <on|off>|subagents allow-unverified <on|off>|combo <enable|disable|remove> <id>");
}

// The public `/health` leaf intentionally contains only the router summary and
// a closed set of degraded dependency names. Desktop surfaces need the richer
// local service view, but should not be handed the forwarders' credential
// metadata. Read the protected health leaf here, then project it to the small
// contract the tray and Control Center render.
async function printHealth() {
  const { assertCallerSecret, callerBaseUrl } = await import("./caller-auth.mjs");
  let callerSecret;
  try {
    callerSecret = assertCallerSecret(readFileSync(CALLER_SECRET_PATH, "utf8").trim());
  } catch {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      status: 0,
      error: "The local router caller key is unavailable.",
      activity: { state: "offline", active: [], activeCount: 0 },
    })}\n`);
    return;
  }

  const safeService = (service) => {
    if (!service || typeof service !== "object") return undefined;
    return {
      reachable: service.reachable === true,
      ...(typeof service.enabled === "boolean" ? { enabled: service.enabled } : {}),
    };
  };
  try {
    const response = await fetch(`${callerBaseUrl(PORTS.router, callerSecret)}/health`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(3_000),
    });
    const raw = await response.json().catch(() => ({}));
    const body = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    process.stdout.write(`${JSON.stringify({
      ok: response.ok,
      status: response.status,
      ...(typeof body.service === "string" ? { service: body.service } : {}),
      ...(typeof body.version === "string" ? { version: body.version } : {}),
      ...(typeof body.router === "string" ? { router: body.router } : {}),
      ...(Array.isArray(body.degraded) ? { degraded: body.degraded } : {}),
      ...(body.activity && typeof body.activity === "object" ? { activity: body.activity } : {}),
      ...(safeService(body.gateway) ? { gateway: safeService(body.gateway) } : {}),
      ...(safeService(body.oauth) ? { oauth: safeService(body.oauth) } : {}),
      ...(safeService(body.api) ? { api: safeService(body.api) } : {}),
      ...(safeService(body.grokOauth) ? { grokOauth: safeService(body.grokOauth) } : {}),
    })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      status: 0,
      error: error?.name === "AbortError" ? "Health check timed out." : "Router is unreachable.",
      activity: { state: "offline", active: [], activeCount: 0 },
    })}\n`);
  }
}

// --- dispatch ---------------------------------------------------------------

if (args.includes("--probe")) {
  await emitProbe();
} else if (args[0] === "--probe-set") {
  await emitProbeSet(args[1], args[2]);
} else if (args[0] === "set") {
  if (!args[1] || !args[2]) throw new Error("Usage: control set <provider> <on|off> [--targets ...]");
  await runSet(args[1], args[2]);
} else if (args[0] === "set-apply") {
  if (!args[1] || !args[2]) {
    throw new Error("Usage: control set-apply <provider> <on|off> [--targets ...] [--activate]");
  }
  await runSetApply(args[1], args[2]);
} else if (args[0] === "apply") {
  await runApply();
} else if (args[0] === "account") {
  await printAccountUsage();
} else if (args[0] === "provider-usage") {
  await printProviderUsage();
} else if (args[0] === "providers") {
  await printProviderOnboarding();
} else if (args[0] === "generic-providers") {
  await handleGenericProviders(...args.slice(1));
} else if (args[0] === "install-cli") {
  if (!args[1]) throw new Error("Usage: control install-cli <oauth-provider>");
  await installProviderCli(args[1]);
} else if (args[0] === "login") {
  if (!args[1]) throw new Error("Usage: control login <oauth-provider>");
  await loginProvider(args[1]);
} else if (args[0] === "catalog-cache") {
  if (args[1] !== "invalidate" || !args[2]) {
    throw new Error("Usage: control catalog-cache invalidate <provider>");
  }
  await invalidateProviderCatalog(args[2]);
} else if (args[0] === "credential") {
  if (!args[1]) throw new Error("Usage: control credential <provider> [--remove]");
  if (args.includes("--remove")) {
    await deleteProviderCredential(args[1]);
  } else {
    await saveProviderCredential(args[1]);
  }
} else if (args[0] === "auth-mode") {
  await setLoginFreeMode(args[1]);
} else if (args[0] === "signed-routing") {
  await setSignedRouting(args[1]);
} else if (args[0] === "model-set") {
  await setLoginFreeModel(args[1]);
} else if (args[0] === "router-default") {
  await setRouterDefault(args[1], args[2]);
} else if (args[0] === "subagents") {
  await handleSubagents(args[1], args[2], args[3], args.slice(2));
} else if (args[0] === "tool-result-aging") {
  await handleToolResultAging(args[1], args[2], args.slice(2));
} else if (args[0] === "local-models") {
  await handleLocalModels(args[1], args[2], ...args.slice(3));
} else if (args[0] === "vision-bridge") {
  await handleVisionBridge(args[1] || "status", args[2], args[3]);
} else if (args[0] === "failover") {
  await handleFailover(args[1], ...args.slice(2));
} else if (args[0] === "picker") {
  await handlePicker(...pickerCommandArgs(args));
} else if (args[0] === "service") {
  handleService(args[1]);
} else if (args[0] === "native-redirect") {
  await handleNativeRedirect(args[1], args[2]);
} else if (args[0] === "tray") {
  handleTray(args[1]);
} else if (args[0] === "harness") {
  await handleHarness(args[1]);
} else if (args[0] === "presence") {
  await handlePresence(args[1], args[2]);
} else if (args[0] === "chatgpt-session") {
  if (args.length > 2) throw new Error("Usage: control chatgpt-session status|enable|disable");
  await handleChatGptSession(args[1]);
} else if (args[0] === "provider-pools") {
  await handleProviderPools(args[1], args[2], args[3]);
} else if (args[0] === "chatgpt-account-pool") {
  await handleChatGptAccountPool(args[1], args[2], args[3]);
} else if (args[0] === "routing-policy") {
  await handleRoutingPolicies(args[1], args[2], args[3]);
} else if (args[0] === "health") {
  await printHealth();
} else if (args[0] === "maintenance") {
  await updateAndVerifyCodex();
} else if (args[0] === "doctor") {
  runDoctor(args.slice(1));
} else {
  await printOverview(args.includes("--json"));
}
