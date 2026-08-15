import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pickerCommandArgs } from "./control-args.mjs";
// The publish marker lives under the shared state directory, which does not
// vary by target, so reading it here does not disturb the per-target probes
// below that re-import paths with their own MODEL_ROUTER_TARGET.
import { DSH_CATALOG_PATH } from "./paths.mjs";
// Same reasoning: presence is a property of the shared plane, not of a target,
// so the overview can resolve it statically without perturbing those probes.
import { presenceSnapshot } from "./presence-state.mjs";
import { harnessSnapshotWithWeb } from "./dsh-install.mjs";

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
const TARGETS = existsSync(DSH_PUBLISHED) ? ["codex", "dsh"] : ["codex"];
const args = process.argv.slice(2);

function targetIsActive(target) {
  // One service serves every client, so "is this target active" cannot be the
  // service's own status for more than one of them. For the harness it is
  // whether the route has been published into its settings document.
  if (target === "dsh") return existsSync(DSH_PUBLISHED);
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

function nativeCodexModels(catalogPath, hiddenModels = new Set()) {
  if (!existsSync(catalogPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(catalogPath, "utf8"));
    return (Array.isArray(parsed.models) ? parsed.models : [])
      .filter((model) => model.visibility === "list" && typeof model.slug === "string")
      .map((model) => ({
        slug: model.slug,
        displayName: model.display_name || model.slug,
        provider: "openai",
        gatewayModel: model.slug,
        enabled: true,
        native: true,
        multiAgentVersion: model.multi_agent_version || "v1",
        visible: !hiddenModels.has(model.slug),
      }));
  } catch {
    return [];
  }
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
  const hiddenModels = new Set(modelPickerSnapshot().hidden);
  const usageEvents = TARGET === "codex"
    ? (await import("./usage-events.mjs")).recentUsageEvents()
    : [];
  // The same machine-local capability proofs the catalog honors: the tray's
  // "Subagent models" section filters on v2, so a probe built from the raw
  // registry hid every model this machine had just verified — the third
  // consumer to need this overlay, after the catalog and the DSH preset.
  //
  // Deliberately unlike the catalog, `disabled` is not passed: the catalog
  // demotes a switched-off model so Codex stops offering it, but this probe
  // is what draws the rows the operator switches. A proven model whose
  // toggle is off must keep its row — with the toggle shown off — or the
  // section it was switched off in loses the way to switch it back on.
  const { applySubagentProofs } = await import("./subagent-proofs.mjs");
  const provenListedModels = applySubagentProofs(
    LISTED_MODELS,
    subagentSettingsSnapshot().proofs,
    { hidden: hiddenModels },
  );
  // The tray groups models by provider to build its rows, so protocol
  // variants report their canonical family id: one opencode Go row, not three.
  const routedModels = provenListedModels.map((model) => ({
    slug: model.slug,
    displayName: model.displayName,
    provider: canonicalProviderId(model.provider),
    gatewayModel: model.gatewayModel,
    enabled: enabledProviders.includes(model.provider),
    multiAgentVersion: model.multiAgentVersion || "v1",
    visible: !hiddenModels.has(model.slug),
  }));
  const models = TARGET === "codex"
    ? [...nativeCodexModels(NATIVE_CATALOG_PATH, hiddenModels), ...routedModels]
    : routedModels;
  const selectedModel = TARGET === "codex" ? configuredDefaultModel(CONFIG_PATH) : undefined;
  const codexConfig = TARGET === "codex" ? codexConfigSnapshot() : undefined;

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
          }
        : {}),
      ...(TARGET === "codex"
        ? {
            usageEvents,
            nativeAliases: readNativeAliases(),
            modelSettings: {
              subagents: subagentSettingsSnapshot(),
              picker: modelPickerSnapshot(),
              toolResultAging: toolResultAgingSnapshot(),
              localModels: localModelsSnapshot({
                inventory: localInventory,
                running: localRunning,
                runtime: localRuntime,
                benchmarks: localAndVisionBenchmarks,
              }),
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
        { targets, presence: presenceSnapshot(), harness: await harnessSnapshotWithWeb() },
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

async function runSet(provider, desired) {
  const requested = optionValue("--targets");
  const selected = requested ? requested.split(",").map((value) => value.trim()) : TARGETS;
  for (const target of selected) {
    if (!TARGETS.includes(target)) throw new Error(`Unknown target: ${target}`);
    const result = spawnSync(process.execPath, [SELF, "--probe-set", provider, desired], {
      env: { ...process.env, MODEL_ROUTER_TARGET: target },
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(`${target}: ${(result.stderr || "").trim() || "toggle failed"}`);
    }
  }
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
function runApply() {
  const requested = optionValue("--targets");
  const selected = requested ? requested.split(",").map((value) => value.trim()) : TARGETS;
  const activate = args.includes("--activate");
  const applied = [];
  const skipped = [];
  for (const target of selected) {
    if (!TARGETS.includes(target)) throw new Error(`Unknown target: ${target}`);
    if (!targetIsActive(target) && !activate) {
      skipped.push(target);
      continue;
    }
    if (targetIsActive(target)) {
      refreshActiveTarget(target);
    } else {
      // `bin/enable` is a POSIX shell script. Windows reaches the same enable
      // path through the PowerShell installer, the way doctor --fix and
      // curate-models already do; spawning the shell script there failed with
      // ENOEXEC and reported it as a plain "apply failed".
      const result = process.platform === "win32"
        ? spawnSync(
            "powershell.exe",
            [
              "-NoLogo",
              "-NoProfile",
              "-ExecutionPolicy",
              "Bypass",
              "-File",
              path.join(REPO_ROOT, "install.ps1"),
              "-CheckoutInstall",
            ],
            {
              cwd: REPO_ROOT,
              env: { ...process.env, MODEL_ROUTER_TARGET: target },
              stdio: "inherit",
            },
          )
        : spawnSync(path.join(REPO_ROOT, "bin", "enable"), [], {
            env: { ...process.env, MODEL_ROUTER_TARGET: target },
            stdio: "inherit",
          });
      if (result.status !== 0) throw new Error(`${target}: apply failed`);
    }
    applied.push(target);
  }
  process.stderr.write(
    `Applied: ${applied.join(", ") || "none"}. Skipped (not active): ${skipped.join(", ") || "none"}.\n`,
  );
}

async function printAccountUsage() {
  const { readCodexAccountUsage } = await import("./codex-account-usage.mjs");
  process.stdout.write(`${JSON.stringify(await readCodexAccountUsage(), null, 2)}\n`);
}

async function printProviderUsage() {
  const { providerUsageSnapshot } = await import("./provider-usage.mjs");
  process.stdout.write(`${JSON.stringify(await providerUsageSnapshot(), null, 2)}\n`);
}

async function printProviderOnboarding() {
  const { providerOnboardingSnapshot } = await import("./provider-onboarding.mjs");
  process.stdout.write(`${JSON.stringify(providerOnboardingSnapshot(), null, 2)}\n`);
}

async function installProviderCli(providerId) {
  const { installOauthCli, providerOnboardingSnapshot } = await import("./provider-onboarding.mjs");
  installOauthCli(providerId);
  process.stdout.write(`${JSON.stringify(providerOnboardingSnapshot())}\n`);
}

async function loginProvider(providerId) {
  const { loginOauthProvider, providerOnboardingSnapshot } = await import("./provider-onboarding.mjs");
  loginOauthProvider(providerId);
  process.stdout.write(`${JSON.stringify(providerOnboardingSnapshot())}\n`);
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
  saveApiCredential(providerId, await readSecretFromStdin());
  process.stdout.write(`${JSON.stringify(providerOnboardingSnapshot())}\n`);
}

async function deleteProviderCredential(providerId) {
  const { providerOnboardingSnapshot, removeApiCredential } = await import("./provider-onboarding.mjs");
  const removal = removeApiCredential(providerId);
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

async function updateAndVerifyCodex() {
  const { runCodexMaintenance } = await import("./codex-maintenance.mjs");
  process.stdout.write(`${JSON.stringify(runCodexMaintenance())}\n`);
}

function runDoctor(args) {
  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "src", "doctor.mjs"), ...args],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, MODEL_ROUTER_TARGET: "codex" },
      stdio: "inherit",
    },
  );
  if (result.status !== 0) {
    throw new Error(
      (result.stderr || "The Codex doctor could not finish.").trim(),
    );
  }
  process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
}

function refreshModelSettingsCatalog({ routes = false } = {}) {
  // The catalog decides what Codex offers; the gateway config decides what it
  // can route. A change that adds or removes models has to write both, or the
  // picker advertises a model whose request has nowhere to go -- the exact
  // drift doctor's "Catalog matches gateway routes" check exists to catch.
  if (routes) {
    const rendered = spawnSync(
      process.execPath,
      ["-e", "import('./src/litellm-config.mjs').then((m) => m.writeLiteLlmConfig())"],
      { cwd: REPO_ROOT, env: { ...process.env, MODEL_ROUTER_TARGET: "codex" }, stdio: "ignore" },
    );
    if (rendered.status !== 0) {
      throw new Error("The gateway routing config could not be refreshed.");
    }
  }
  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "src", "catalog.mjs")],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, MODEL_ROUTER_TARGET: "codex" },
      stdio: "ignore",
    },
  );
  if (result.status !== 0) {
    throw new Error(
      (result.stderr || "The model settings catalog could not be refreshed.").trim(),
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

async function handleSubagents(action, value, flag, rest = []) {
  const {
    replaceMultiAgentState,
    setMultiAgentMode,
    setMultiAgentModel,
    setMultiAgentModels,
    subagentSettingsSnapshot,
  } = await import("./multi-agent-state.mjs");
  if (action === "status") {
    process.stdout.write(`${JSON.stringify(subagentSettingsSnapshot())}\n`);
    return;
  }
  if (action === "select-all") {
    replaceMultiAgentState({ mode: "all", enabled: [], disabled: [] });
  } else if (action === "unselect-all") {
    const { selectedConfiguredListedModels } = await import("./provider-selection.mjs");
    const { readHiddenModels } = await import("./model-picker-state.mjs");
    const hidden = readHiddenModels();
    const visibleExternal = selectedConfiguredListedModels()
      .filter((model) => !hidden.has(model.slug))
      .map((model) => model.slug);
    replaceMultiAgentState({
      mode: "selected",
      enabled: [],
      disabled: visibleExternal,
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
    setMultiAgentModel(value, flag === "on");
    // Selection is the assignment: switching a model on hands it to the
    // capability probe. Detached, because this command answers a tray toggle
    // and cannot sit on a live network round-trip; the proofs snapshot shows
    // "checking" until the worker records a verdict and republishes.
    if (flag === "on") {
      const { spawnDetachedVerification } = await import("./subagent-verify.mjs");
      spawnDetachedVerification([value]);
    }
  } else if (action === "provider") {
    if (!["on", "off"].includes(flag)) {
      throw new Error("Usage: control subagents provider <provider-id> <on|off>");
    }
    const { canonicalProviderId, selectedConfiguredListedModels } = await import(
      "./provider-selection.mjs"
    );
    const provider = canonicalProviderId(String(value || "").trim());
    const slugs = selectedConfiguredListedModels()
      .filter((model) => canonicalProviderId(model.provider) === provider)
      .map((model) => model.slug);
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
        "set <model-slug> <on|off>|provider <provider-id> <on|off>|verify [model-slug ...]",
    );
  }
  refreshModelSettingsCatalog();
  process.stdout.write(`${JSON.stringify(subagentSettingsSnapshot())}\n`);
}

async function handleToolResultAging(action, nativeAction) {
  const {
    setNativeToolResultAgingEnabled,
    setToolResultAgingEnabled,
    toolResultAgingSnapshot,
  } = await import("./tool-result-aging-state.mjs");
  const desired = action || "status";
  if (desired === "status") {
    process.stdout.write(`${JSON.stringify(toolResultAgingSnapshot())}\n`);
    return;
  }
  if (desired === "native") {
    if (nativeAction !== "on" && nativeAction !== "off") {
      throw new Error("Usage: control tool-result-aging status|on|off|native <on|off>");
    }
    setNativeToolResultAgingEnabled(nativeAction === "on");
    process.stdout.write(`${JSON.stringify(toolResultAgingSnapshot())}\n`);
    return;
  }
  if (desired !== "on" && desired !== "off") {
    throw new Error("Usage: control tool-result-aging status|on|off|native <on|off>");
  }
  setToolResultAgingEnabled(desired === "on");
  process.stdout.write(`${JSON.stringify(toolResultAgingSnapshot())}\n`);
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
    const { readVisionDownload, writeVisionDownload } = await import(
      "./vision-download.mjs"
    );
    const active = readVisionDownload();
    if (active?.status === "downloading" && active.tag !== tag) {
      throw new Error(`${active.tag} is already downloading (${active.percent || 0}%).`);
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
    process.stdout.write(`${JSON.stringify({ started: true, tag })}\n`);
    return;
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
    await runVisionBridgeSetup({ consent });
    refreshModelSettingsCatalog();
    process.stdout.write(`${JSON.stringify(snapshot())}\n`);
    return;
  }
  if (action === "on" || action === "off") {
    setVisionBridgeEnabled(action === "on");
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
    setVisionBridgeLocal({ model, baseUrl });
    setVisionBridgeEnabled(true);
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
    setVisionBridgeEngine(slug && slug !== "auto" ? slug : null);
    // The tray picks an engine and a level in one click, so the level rides
    // along here. Left out, whatever was pinned before stays pinned.
    if (extra !== undefined) setVisionBridgeEffort(effortArgument(extra, VISION_EFFORT_LEVELS));
  } else if (action === "effort") {
    setVisionBridgeEffort(effortArgument(value, VISION_EFFORT_LEVELS));
  } else {
    throw new Error(
      "Usage: control vision-bridge status|probe|models|setup [--yes]|on|off|" +
        "engine <model-slug|local|auto> [effort]|effort <level|default>|" +
        "local [model] [baseUrl]|pull <model-tag>",
    );
  }
  refreshModelSettingsCatalog();
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
    localModelsSnapshot,
    removeLocalModel,
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
  const snapshot = () => localModelsSnapshot({
    benchmarks: localAndVisionBenchmarks,
  });
  if (action === "list" || action === "status" || !action) {
    const current = snapshot();
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
  if (action === "install" || action === "install-and-use") {
    // Same detached-worker principle as the vision picker, but this worker is
    // for Codex chat models: successful completion checks the model on and
    // publishes the route automatically.
    const { normalizeLocalModelTag, splitLocalModelTag } = await import("./local-model-ref.mjs");
    const tag = normalizeLocalModelTag(value);
    const identity = splitLocalModelTag(tag);
    const { readLocalDownload, writeLocalDownload } = await import("./local-download.mjs");
    const active = readLocalDownload();
    if (active?.status === "downloading" && active.tag !== tag) {
      throw new Error(`${active.tag} is already downloading (${active.percent || 0}%).`);
    }
    if (active?.status === "downloading" && active.tag === tag) {
      process.stdout.write(`${JSON.stringify({
        started: false,
        existing: true,
        tag,
        percent: active.percent || 0,
        detail: active.detail || "downloading",
      })}\n`);
      return;
    }
    const startedAt = Date.now();
    const writePhase = (detail, extra = {}) => writeLocalDownload({
      version: 1,
      tag,
      status: "downloading",
      detail,
      percent: 0,
      startedAt,
      updatedAt: Date.now(),
      workerPid: process.pid,
      ...extra,
    });
    // Persist the optimistic state before any network lookup or runtime
    // installation. The tray may refresh while either one is in progress, and
    // the operator should still see that the click was accepted.
    writePhase("Checking model and machine fit");
    try {
      const { fetchRegistryCapabilities, detectMachine, fitAdvisory, rateDiskFit, rateModelFit } =
        await import("./local-models.mjs");
      const advertised = await fetchRegistryCapabilities(tag);
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
        tag,
        status: "downloading",
        detail: "Starting model download",
        percent: 0,
        startedAt,
        updatedAt: Date.now(),
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
      writeLocalDownload({
        ...readLocalDownload(),
        version: 1,
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
  if (action === "uninstall") {
    const tag = String(value || "").trim();
    if (!tag) throw new Error("Usage: control local-models uninstall <model-tag> --yes");
    removeLocalModel(tag, { confirmed: flags.has("--yes") || value === "--yes" });
    refreshModelSettingsCatalog({ routes: true });
    await restartRouterForLocalRoutes();
  } else if (action === "set") {
    if (!["on", "off"].includes(positional)) {
      throw new Error("Usage: control local-models set <model-tag> <on|off>");
    }
    const enabled = positional === "on";
    // Compared across spellings: the downloader stores `gemma3:latest` and a
    // hand-typed `gemma3` is the same model, so a raw string match here would
    // skip the router restart that publishes the route change.
    const wasEnabled = isLocalModelEnabled(value);
    setLocalModelEnabled(value, enabled);
    refreshModelSettingsCatalog({ routes: true });
    if (wasEnabled !== enabled) await restartRouterForLocalRoutes();
  } else {
    throw new Error(
      "Usage: control local-models list [--json]|inspect <tag-or-url>|" +
        "install <tag-or-url> [--yes] [--force]|benchmark <tag>|" +
        "runtime status|runtime start [--yes]|runtime update --yes|" +
        "uninstall <tag> --yes|set <tag> <on|off>\n" +
        "  --yes    consent to installing/starting Ollama itself (headless)\n" +
        "  --force  download a model rated too large for this machine anyway",
    );
  }
  process.stdout.write(`${JSON.stringify(snapshot())}\n`);
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
  if (action === "all") {
    if (!["show", "hide"].includes(flag)) {
      throw new Error("Usage: control picker all <show|hide>");
    }
    const { MERGED_CATALOG_PATH } = await import("./paths.mjs");
    const parsed = JSON.parse(readFileSync(MERGED_CATALOG_PATH, "utf8"));
    const slugs = Array.isArray(parsed.models)
      ? parsed.models.map((model) => String(model.slug))
      : [];
    setAllModelsVisible(slugs, flag === "show");
  } else if (action === "set") {
    if (!["show", "hide"].includes(flag)) {
      throw new Error("Usage: control picker set <model-slug> <show|hide>");
    }
    if (!(await knownModelSlug(value))) {
      throw new Error(`Unknown model slug: ${value}`);
    }
    setModelVisible(value, flag === "show");
  } else if (action === "provider") {
    if (!["show", "hide"].includes(flag)) {
      throw new Error("Usage: control picker provider <provider-id> <show|hide>");
    }
    const provider = String(value || "").trim();
    let slugs;
    if (provider === "openai") {
      const { NATIVE_CATALOG_PATH } = await import("./paths.mjs");
      const parsed = JSON.parse(readFileSync(NATIVE_CATALOG_PATH, "utf8"));
      slugs = Array.isArray(parsed.models)
        ? parsed.models
            .filter((model) => model.visibility === "list")
            .map((model) => String(model.slug))
        : [];
    } else {
      const { canonicalProviderId, readProviderSelection } = await import(
        "./provider-selection.mjs"
      );
      const { LISTED_MODELS } = await import("./model-registry.mjs");
      const canonical = canonicalProviderId(provider);
      const selected = new Set(readProviderSelection());
      slugs = LISTED_MODELS
        .filter(
          (model) =>
            selected.has(model.provider) && canonicalProviderId(model.provider) === canonical,
        )
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
  refreshModelSettingsCatalog();
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
    { stdio: "inherit", env: process.env },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Background service ${value} failed with exit code ${result.status}.`);
  }
}

// Supervision for the tray companion. `disable` boots the agent out, which
// stops the running tray too -- that is why the Settings toggle does not call
// it and this stays an explicit command.
const TRAY_COMMANDS = { enable: "install", disable: "uninstall", status: "status", restart: "restart" };

function handleTray(action) {
  const value = action || "status";
  if (value === "rebuild") {
    // The tray's footer Restart control wants the bundle rebuilt from this
    // checkout even when its source fingerprint says the installed copy is
    // current, so this bypasses the update flow's staleness check and runs
    // the launcher directly. The launcher quits the running tray only after
    // the staged replacement passes verification.
    const result = spawnSync(path.join(REPO_ROOT, "bin", "model-router-tray"), [], {
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
    throw new Error(`Usage: control tray ${[...Object.keys(TRAY_COMMANDS), "rebuild"].join("|")}`);
  }
  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "src", "tray-service.mjs"), subcommand],
    { stdio: "inherit", env: process.env },
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

// --- dispatch ---------------------------------------------------------------

if (args.includes("--probe")) {
  await emitProbe();
} else if (args[0] === "--probe-set") {
  await emitProbeSet(args[1], args[2]);
} else if (args[0] === "set") {
  if (!args[1] || !args[2]) throw new Error("Usage: control set <provider> <on|off> [--targets ...]");
  await runSet(args[1], args[2]);
} else if (args[0] === "apply") {
  runApply();
} else if (args[0] === "account") {
  await printAccountUsage();
} else if (args[0] === "provider-usage") {
  await printProviderUsage();
} else if (args[0] === "providers") {
  await printProviderOnboarding();
} else if (args[0] === "install-cli") {
  if (!args[1]) throw new Error("Usage: control install-cli <oauth-provider>");
  await installProviderCli(args[1]);
} else if (args[0] === "login") {
  if (!args[1]) throw new Error("Usage: control login <oauth-provider>");
  await loginProvider(args[1]);
} else if (args[0] === "credential") {
  if (!args[1]) throw new Error("Usage: control credential <api-provider> [--remove]");
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
} else if (args[0] === "subagents") {
  await handleSubagents(args[1], args[2], args[3], args.slice(2));
} else if (args[0] === "tool-result-aging") {
  await handleToolResultAging(args[1], args[2]);
} else if (args[0] === "local-models") {
  await handleLocalModels(args[1], args[2], ...args.slice(3));
} else if (args[0] === "vision-bridge") {
  await handleVisionBridge(args[1] || "status", args[2], args[3]);
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
} else if (args[0] === "maintenance") {
  await updateAndVerifyCodex();
} else if (args[0] === "doctor") {
  runDoctor(args.slice(1));
} else {
  await printOverview(args.includes("--json"));
}
