import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pickerCommandArgs } from "./control-args.mjs";

// Cross-target control plane for a tray/UI (e.g. the planned pane fork). It
// reads which registry models are enabled per target and toggles them. Toggling
// only rewrites each target's provider selection; making it live is a separate
// explicit `apply`, so a toggle never silently restarts a running target.

const TARGETS = ["codex"];
const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), "..");
const args = process.argv.slice(2);

function targetIsActive(target) {
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
  const {
    CONFIG_PATH,
    NATIVE_CATALOG_PATH,
    TARGET,
    PROVIDER_SELECTION_PATH,
  } = await import("./paths.mjs");
  const { canonicalProviderId, readProviderSelection } = await import("./provider-selection.mjs");
  const { LISTED_MODELS, PROVIDERS } = await import("./model-registry.mjs");
  const { readNativeAliases } = await import("./native-alias.mjs");
  const { subagentSettingsSnapshot } = await import("./multi-agent-state.mjs");
  const { modelPickerSnapshot } = await import("./model-picker-state.mjs");
  const { readVisionBridgeSettings, visionBridgeSnapshot } = await import(
    "./vision-bridge-state.mjs"
  );
  const { rankVisionEngines, resolveVisionEngine } = await import("./vision-bridge.mjs");
  const { annotateLocalModels, hostVisionProfile, refreshVisionModelSizesIfStale } =
    await import("./vision-host.mjs");
  const { readVisionDownload } = await import("./vision-download.mjs");
  const { readBenchmarkResults } = await import("./vision-benchmark.mjs");
  const { localModelsSnapshot } = await import("./local-models.mjs");
  const { selectedConfiguredListedModels } = await import("./provider-selection.mjs");
  // Bounded and weekly: the tray reads this snapshot constantly, so a fresh
  // cache costs nothing and a stale one costs one short, failure-tolerant pass.
  if (TARGET === "codex") await refreshVisionModelSizesIfStale();

  const enabledProviders = readProviderSelection();
  const hiddenModels = new Set(modelPickerSnapshot().hidden);
  const usageEvents = TARGET === "codex"
    ? (await import("./usage-events.mjs")).recentUsageEvents()
    : [];
  // The tray groups models by provider to build its rows, so protocol
  // variants report their canonical family id: one opencode Go row, not three.
  const routedModels = LISTED_MODELS.map((model) => ({
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
        })),
      models,
      ...(selectedModel ? { selectedModel } : {}),
      ...(codexConfig
        ? {
            loginFree: Boolean(codexConfig.login_free),
            loginFreeManaged: Boolean(codexConfig.login_free_managed),
          }
        : {}),
      ...(TARGET === "codex"
        ? {
            usageEvents,
            nativeAliases: readNativeAliases(),
            modelSettings: {
              subagents: subagentSettingsSnapshot(),
              picker: modelPickerSnapshot(),
              localModels: localModelsSnapshot({ benchmarks: readBenchmarkResults() }),
              visionBridge: (() => {
                const candidates = selectedConfiguredListedModels();
                const resolved = resolveVisionEngine(
                  candidates,
                  readVisionBridgeSettings(),
                );
                return {
                  ...visionBridgeSnapshot(),
                  resolvedEngine: resolved?.slug || null,
                  resolvedEngineName: resolved?.displayName || null,
                  hostMemGib: hostVisionProfile().memGib,
                  // Cloud vision models the operator already pays for -- the
                  // default engines. Auto picks the cheapest of these.
                  paidEngines: rankVisionEngines(candidates).map((model) => ({
                    slug: model.slug,
                    displayName: model.displayName,
                  })),
                  // The downloadable local picker, each with size + fit + state.
                  localModels: annotateLocalModels({ benchmarks: readBenchmarkResults() }),
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

function printOverview(asJson) {
  const targets = probeTargets();
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ targets }, null, 2)}\n`);
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

function runSet(provider, desired) {
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
  printOverview(args.includes("--json"));
}

function refreshActiveTarget(target) {
  const command =
    target === "codex"
      ? [process.execPath, [path.join(REPO_ROOT, "src", "catalog.mjs")]]
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
      const result = spawnSync(path.join(REPO_ROOT, "bin", "enable"), [], {
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

async function handleSubagents(action, value, flag) {
  const {
    replaceMultiAgentState,
    setMultiAgentMode,
    setMultiAgentModel,
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
  } else if (action === "set") {
    if (!["on", "off"].includes(flag)) {
      throw new Error("Usage: control subagents set <model-slug> <on|off>");
    }
    if (!(await knownModelSlug(value))) {
      throw new Error(`Unknown model slug: ${value}`);
    }
    setMultiAgentModel(value, flag === "on");
  } else {
    throw new Error(
      "Usage: control subagents status|select-all|unselect-all|mode <all|selected|proven>|set <model-slug> <on|off>",
    );
  }
  refreshModelSettingsCatalog();
  process.stdout.write(`${JSON.stringify(subagentSettingsSnapshot())}\n`);
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
  const { suggestLocalVisionSetup, ollamaAvailable, pullOllamaModel, OLLAMA_INSTALL_HINT } =
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
  if (!ollamaAvailable()) {
    process.stderr.write(
      `No local vision runtime is running.\n` +
        `Recommended for this machine (${profile.memGib} GB ${profile.arch}): ${chosen}.\n` +
        `${OLLAMA_INSTALL_HINT}\n` +
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
  process.stderr.write(`Downloading ${chosen} with Ollama…\n`);
  pullOllamaModel(chosen);
  setVisionBridgeLocal({ model: chosen, baseUrl });
  setVisionBridgeEnabled(true);
  process.stderr.write(`Vision bridge on: ${chosen} (local, via Ollama).\n`);
}

async function handleVisionBridge(action, value, extra) {
  const {
    readVisionBridgeSettings,
    setVisionBridgeEnabled,
    setVisionBridgeEngine,
    setVisionBridgeLocal,
    visionBridgeSnapshot,
  } = await import("./vision-bridge-state.mjs");
  const { LOCAL_ENGINE_SLUG, rankVisionEngines, resolveVisionEngine } = await import(
    "./vision-bridge.mjs"
  );
  const { selectedConfiguredListedModels } = await import("./provider-selection.mjs");
  const snapshot = () => {
    const candidates = selectedConfiguredListedModels();
    const settings = readVisionBridgeSettings();
    const resolved = resolveVisionEngine(candidates, settings);
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
    const { ollamaAvailable, OLLAMA_INSTALL_HINT } = await import("./vision-host.mjs");
    if (!ollamaAvailable()) {
      throw new Error(`Ollama is not installed. ${OLLAMA_INSTALL_HINT}`);
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
      { detached: true, stdio: "ignore" },
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
      const available = rankVisionEngines(selectedConfiguredListedModels());
      if (!available.some((model) => model.slug === slug)) {
        throw new Error(
          `${slug} is not an enabled model that reads images. Choose one of: ${
            available.map((model) => model.slug).join(", ") || "(none enabled)"
          }, or "local" for a local vision model, or "auto".`,
        );
      }
    }
    setVisionBridgeEngine(slug && slug !== "auto" ? slug : null);
  } else {
    throw new Error(
      "Usage: control vision-bridge status|probe|models|setup [--yes]|on|off|" +
        "engine <model-slug|local|auto>|local [model] [baseUrl]|pull <model-tag>",
    );
  }
  refreshModelSettingsCatalog();
  process.stdout.write(`${JSON.stringify(snapshot())}\n`);
}

// Local models are managed as their own thing, not as a vision detail: the
// operator installs, checks, and removes them here, and the vision bridge is
// only one of the consumers.
async function handleLocalModels(action, value, flag) {
  const {
    localModelsSnapshot,
    removeLocalModel,
    setLocalModelEnabled,
  } = await import("./local-models.mjs");
  const { readBenchmarkResults } = await import("./vision-benchmark.mjs");
  const snapshot = () => localModelsSnapshot({ benchmarks: readBenchmarkResults() });
  if (action === "list" || action === "status" || !action) {
    process.stdout.write(`${JSON.stringify(snapshot())}\n`);
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
    const tag = String(value || "").trim();
    if (!tag) throw new Error("Usage: control local-models inspect <model-tag>");
    const { fetchRegistryCapabilities } = await import("./local-models.mjs");
    const info = await fetchRegistryCapabilities(tag);
    process.stdout.write(`${JSON.stringify(info || { tag, unknown: true })}\n`);
    return;
  }
  if (action === "install") {
    // Same detached worker the vision picker uses: gigabytes must not block.
    const tag = String(value || "").trim();
    if (!tag) throw new Error("Usage: control local-models install <model-tag>");
    const { ollamaAvailable, OLLAMA_INSTALL_HINT } = await import("./vision-host.mjs");
    if (!ollamaAvailable()) throw new Error(`Ollama is not installed. ${OLLAMA_INSTALL_HINT}`);
    const { readVisionDownload, writeVisionDownload } = await import("./vision-download.mjs");
    const active = readVisionDownload();
    if (active?.status === "downloading" && active.tag !== tag) {
      throw new Error(`${active.tag} is already downloading (${active.percent || 0}%).`);
    }
    const { fetchRegistryCapabilities } = await import("./local-models.mjs");
    const advertised = await fetchRegistryCapabilities(tag);
    writeVisionDownload({
      version: 1,
      tag,
      status: "downloading",
      detail: "starting",
      percent: 0,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    });
    spawn(process.execPath, [path.join(REPO_ROOT, "src", "vision-download.mjs"), tag], {
      detached: true,
      stdio: "ignore",
    }).unref();
    // Advisory, never blocking: the operator may well want a vision-only
    // model, but they should know before the gigabytes land.
    process.stdout.write(
      `${JSON.stringify({ started: true, tag, tools: advertised?.tools ?? null })}\n`,
    );
    if (advertised && !advertised.tools) {
      process.stderr.write(
        `Note: ${tag} does not advertise tool calling, so Codex cannot use it as a chat model. ` +
          `It can still serve as a vision reader.\n`,
      );
    }
    return;
  }
  if (action === "uninstall") {
    const tag = String(value || "").trim();
    if (!tag) throw new Error("Usage: control local-models uninstall <model-tag> --yes");
    removeLocalModel(tag, { confirmed: flag === "--yes" || value === "--yes" });
    refreshModelSettingsCatalog({ routes: true });
  } else if (action === "set") {
    if (!["on", "off"].includes(flag)) {
      throw new Error("Usage: control local-models set <model-tag> <on|off>");
    }
    setLocalModelEnabled(value, flag === "on");
    refreshModelSettingsCatalog({ routes: true });
  } else {
    throw new Error(
      "Usage: control local-models list|install <tag>|uninstall <tag> --yes|set <tag> <on|off>",
    );
  }
  process.stdout.write(`${JSON.stringify(snapshot())}\n`);
}

async function handlePicker(action, value, flag) {
  const {
    modelPickerSnapshot,
    setAllModelsVisible,
    setModelVisible,
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
  } else {
    throw new Error("Usage: control picker status|all <show|hide>|set <model-slug> <show|hide>");
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
  const subcommand = TRAY_COMMANDS[value];
  if (!subcommand) {
    throw new Error(`Usage: control tray ${Object.keys(TRAY_COMMANDS).join("|")}`);
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
  runSet(args[1], args[2]);
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
} else if (args[0] === "model-set") {
  await setLoginFreeModel(args[1]);
} else if (args[0] === "subagents") {
  await handleSubagents(args[1], args[2], args[3]);
} else if (args[0] === "local-models") {
  await handleLocalModels(args[1], args[2], args[3]);
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
} else if (args[0] === "presence") {
  await handlePresence(args[1], args[2]);
} else if (args[0] === "maintenance") {
  await updateAndVerifyCodex();
} else if (args[0] === "doctor") {
  runDoctor(args.slice(1));
} else {
  printOverview(args.includes("--json"));
}
