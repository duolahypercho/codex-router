import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  assertCallerSecret,
  callerBaseUrl,
  isManagedCallerBaseUrl,
  redactCallerUrl,
} from "./caller-auth.mjs";
import { privateFileIsProtected, protectPrivateFile, writePrivateJson } from "./file-security.mjs";
import { openclawCliPath } from "./openclaw-install.mjs";
import {
  CALLER_SECRET_PATH,
  LEGACY_PORTS,
  OPENCLAW_CATALOG_PATH,
  PORTS,
} from "./paths.mjs";
import { routedClientModels } from "./routed-client-models.mjs";
import { spawnEnvironment } from "./npm-global-install.mjs";
import { spawnableCommand } from "./spawnable-command.mjs";
import { assertStateOwnership } from "./state-owner.mjs";

export const OPENCLAW_PROVIDER_ID = "codex-router";
const PROVIDER_PATH = `models.providers.${OPENCLAW_PROVIDER_ID}`;
const DEFAULT_MODEL_PATH = "agents.defaults.model.primary";
const CLI_TIMEOUT_MS = 30_000;
const OPENCLAW_EFFORTS = new Set([
  "off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max", "ultra",
]);

function readJsonFile(target) {
  if (!existsSync(target)) return undefined;
  try { return JSON.parse(readFileSync(target, "utf8")); } catch {
    throw new Error("The OpenClaw router publication marker is not valid JSON; refusing to change client state.");
  }
}

function currentSecret(secretPath = CALLER_SECRET_PATH) {
  if (!existsSync(secretPath)) {
    throw new Error("The local router caller key is missing; run ./bin/doctor --fix.");
  }
  return assertCallerSecret(readFileSync(secretPath, "utf8").trim());
}

function redactFailure(value, secret) {
  const redacted = redactCallerUrl(String(value || ""));
  return secret ? redacted.replaceAll(String(secret), "[REDACTED]") : redacted;
}

function parseJsonOutput(output, label) {
  try { return JSON.parse(String(output || "").trim()); } catch {
    throw new Error(`OpenClaw returned invalid JSON for ${label}.`);
  }
}

export function createOpenClawCli(binary = openclawCliPath(), { spawn = spawnSync } = {}) {
  if (!binary) throw new Error("OpenClaw is not installed. Run the OpenClaw setup action first.");

  function run(args, { input, missingOkay = false, secret } = {}) {
    const command = spawnableCommand(binary, args);
    const result = spawn(command.command, command.args, {
      ...command.options,
      encoding: "utf8",
      env: spawnEnvironment(),
      input,
      timeout: CLI_TIMEOUT_MS,
      windowsHide: true,
    });
    if (!result.error && result.status === 0) return String(result.stdout || "");
    const detail = redactFailure(result.error?.message || result.stderr || result.stdout, secret).trim();
    if (missingOkay && /(?:not found|does not exist|unknown (?:config )?path|no value|undefined|valid but unset)/i.test(detail)) {
      return undefined;
    }
    throw new Error(detail ? `OpenClaw config command failed: ${detail}` : "OpenClaw config command failed.");
  }

  return {
    binary,
    get(configPath) {
      const output = run(["config", "get", configPath, "--json"], { missingOkay: true });
      return output === undefined ? undefined : parseJsonOutput(output, configPath);
    },
    configFile() {
      const value = parseJsonOutput(run(["config", "file", "--json"]), "config file");
      return typeof value === "string" ? value : value?.path;
    },
    patch(value, replacePaths, secret) {
      const args = ["config", "patch", "--stdin"];
      for (const configPath of replacePaths) args.push("--replace-path", configPath);
      run(args, { input: `${JSON.stringify(value)}\n`, secret });
    },
    unset(configPath) {
      run(["config", "unset", configPath], { missingOkay: true });
    },
  };
}

export function openclawModelProfile(model) {
  const input = (model.inputModalities || ["text"])
    .map(String)
    .filter((modality) => modality === "text" || modality === "image");
  const efforts = [...new Set((model.reasoningLevels || [])
    .map((level) => String(level?.effort || ""))
    .filter((effort) => OPENCLAW_EFFORTS.has(effort)))];
  const profile = {
    id: String(model.slug),
    name: String(model.displayName || model.slug),
    reasoning: efforts.length > 0,
    input: input.length ? input : ["text"],
  };
  if (Number.isInteger(model.contextWindow) && model.contextWindow > 0) {
    profile.contextWindow = model.contextWindow;
  }
  if (efforts.length) profile.compat = { supportedReasoningEfforts: efforts };
  return profile;
}

export function openclawDefaultModel(models) {
  const model = [...models].sort(
    (left, right) =>
      (right.priority ?? 0) - (left.priority ?? 0) ||
      String(left.slug).localeCompare(String(right.slug)),
  )[0];
  return model ? `${OPENCLAW_PROVIDER_ID}/${model.slug}` : undefined;
}

function buildProvider(models, baseUrl, secret) {
  return {
    baseUrl,
    apiKey: secret,
    api: "openai-responses",
    authHeader: true,
    timeoutSeconds: 300,
    models: models.map(openclawModelProfile),
  };
}

function providerManaged(provider, port = PORTS.router, legacyPort = LEGACY_PORTS.router) {
  return Boolean(provider && (
    isManagedCallerBaseUrl(provider.baseUrl, port) ||
    (legacyPort !== undefined && isManagedCallerBaseUrl(provider.baseUrl, legacyPort))
  ));
}

function readCatalogState(target, port, legacyPort) {
  const state = readJsonFile(target);
  if (state === undefined) return undefined;
  const objectState = Boolean(state && typeof state === "object" && !Array.isArray(state));
  const defaultValid = objectState && state.defaultOwned === true
    ? typeof state.defaultModel === "string" && state.defaultModel.startsWith(`${OPENCLAW_PROVIDER_ID}/`)
    : objectState && state.defaultOwned === false && state.defaultModel === null;
  const valid = objectState &&
    state.version === 1 && state.provider === OPENCLAW_PROVIDER_ID &&
    typeof state.baseUrl === "string" && providerManaged({ baseUrl: state.baseUrl }, port, legacyPort) &&
    Array.isArray(state.models) && state.models.length > 0 &&
    state.models.every((model) => typeof model === "string" && model.length > 0) &&
    new Set(state.models).size === state.models.length &&
    (state.visionBridgeEngine === null || typeof state.visionBridgeEngine === "string") &&
    defaultValid && typeof state.updatedAt === "string" && Number.isFinite(Date.parse(state.updatedAt));
  if (!valid) {
    throw new Error("The OpenClaw router publication marker has an unsupported or malformed shape; refusing to change client state.");
  }
  return state;
}

function normalizedDefault(value) {
  return typeof value === "string" && value ? value : undefined;
}

export function createOpenClawManager({
  client,
  catalogPath = OPENCLAW_CATALOG_PATH,
  secretPath = CALLER_SECRET_PATH,
  port = PORTS.router,
  legacyPort = LEGACY_PORTS.router,
  modelSource = routedClientModels,
  assertOwnership = assertStateOwnership,
  protectConfig = protectPrivateFile,
  writeCatalog = writePrivateJson,
} = {}) {
  const cli = () => client || createOpenClawCli();

  function install() {
    assertOwnership("write the OpenClaw model catalog");
    const { models, engine } = modelSource();
    if (!models.length) {
      throw new Error(
        "No routed models are selected, credentialed, and listed. Enable a provider first, then publish again.",
      );
    }
    const state = readCatalogState(catalogPath, port, legacyPort);
    const openclaw = cli();
    const existingProvider = openclaw.get(PROVIDER_PATH);
    if (existingProvider && !state) {
      throw new Error(
        `OpenClaw already has an unmanaged ${OPENCLAW_PROVIDER_ID} provider; rename or remove it before setup.`,
      );
    }
    if (existingProvider && !providerManaged(existingProvider, port, legacyPort)) {
      throw new Error("Refusing to replace an OpenClaw provider whose base URL is not managed by this router.");
    }

    const secret = currentSecret(secretPath);
    const baseUrl = callerBaseUrl(port, secret);
    const currentDefault = normalizedDefault(openclaw.get(DEFAULT_MODEL_PATH));
    const desiredDefault = openclawDefaultModel(models);
    const previouslyOwned = Boolean(
      state?.defaultOwned && state.defaultModel && currentDefault === state.defaultModel,
    );
    const claimFreshDefault = !state && !currentDefault;
    const defaultOwned = previouslyOwned || claimFreshDefault;
    const defaultModel = defaultOwned ? desiredDefault : currentDefault;
    const patch = { models: { providers: { [OPENCLAW_PROVIDER_ID]: buildProvider(models, baseUrl, secret) } } };
    const replacePaths = [PROVIDER_PATH];
    if (defaultOwned && defaultModel) {
      patch.agents = { defaults: { model: { primary: defaultModel } } };
      replacePaths.push(DEFAULT_MODEL_PATH);
    }
    const configPath = openclaw.configFile();
    if (configPath && existsSync(configPath)) protectConfig(configPath);
    let patched = false;
    try {
      openclaw.patch(patch, replacePaths, secret);
      patched = true;
      if (configPath && existsSync(configPath)) protectConfig(configPath);
      writeCatalog(catalogPath, {
        version: 1,
        provider: OPENCLAW_PROVIDER_ID,
        baseUrl,
        models: models.map((model) => String(model.slug)),
        visionBridgeEngine: engine?.slug || null,
        defaultOwned,
        defaultModel: defaultOwned ? defaultModel : null,
        updatedAt: new Date().toISOString(),
      }, { directoryMode: 0o700 });
    } catch (error) {
      if (patched) {
        try {
          if (existingProvider) {
            openclaw.patch(
              { models: { providers: { [OPENCLAW_PROVIDER_ID]: existingProvider } } },
              [PROVIDER_PATH],
              secret,
            );
          } else {
            openclaw.unset(PROVIDER_PATH);
          }
          if (defaultOwned) {
            if (currentDefault) {
              openclaw.patch(
                { agents: { defaults: { model: { primary: currentDefault } } } },
                [DEFAULT_MODEL_PATH],
                secret,
              );
            } else {
              openclaw.unset(DEFAULT_MODEL_PATH);
            }
          }
        } catch (rollbackError) {
          throw new Error(
            `${redactFailure(error instanceof Error ? error.message : error, secret)} ` +
            `OpenClaw rollback also failed: ${redactFailure(rollbackError instanceof Error ? rollbackError.message : rollbackError, secret)}`,
          );
        }
      }
      throw new Error(redactFailure(error instanceof Error ? error.message : error, secret));
    }
    return {
      provider: OPENCLAW_PROVIDER_ID,
      models: models.length,
      visionBridgeEngine: engine?.slug || null,
      defaultOwned,
      defaultModel: defaultOwned ? defaultModel : null,
      config: configPath,
    };
  }

  function uninstall() {
    assertOwnership("remove the OpenClaw integration");
    const state = readCatalogState(catalogPath, port, legacyPort);
    if (!state && !client && !openclawCliPath()) {
      return { removed: false, provider: OPENCLAW_PROVIDER_ID };
    }
    const openclaw = cli();
    const provider = openclaw.get(PROVIDER_PATH);
    if (!state) {
      if (provider) {
        throw new Error(`Refusing to remove an unmanaged OpenClaw ${OPENCLAW_PROVIDER_ID} provider.`);
      }
      return { removed: false, provider: OPENCLAW_PROVIDER_ID };
    }
    if (provider && !providerManaged(provider, port, legacyPort)) {
      throw new Error("Refusing to remove an OpenClaw provider whose base URL is not managed by this router.");
    }
    const currentDefault = normalizedDefault(openclaw.get(DEFAULT_MODEL_PATH));
    const defaultRemoved = Boolean(
      state.defaultOwned && state.defaultModel && currentDefault === state.defaultModel,
    );
    if (defaultRemoved) openclaw.unset(DEFAULT_MODEL_PATH);
    if (provider) openclaw.unset(PROVIDER_PATH);
    if (existsSync(catalogPath)) unlinkSync(catalogPath);
    return { removed: Boolean(provider), provider: OPENCLAW_PROVIDER_ID, defaultRemoved };
  }

  function status() {
    const { models } = modelSource();
    let state;
    try {
      state = readCatalogState(catalogPath, port, legacyPort);
    } catch (error) {
      return {
        installed: existsSync(catalogPath),
        cliInstalled: Boolean(client || openclawCliPath()),
        providerInstalled: false,
        stateValid: false,
        configValid: false,
        configError: redactFailure(error instanceof Error ? error.message : error),
        publishedModels: 0,
        routableModels: models.length,
        catalogFresh: false,
      };
    }
    if (!openclawCliPath() && !client) {
      return {
        installed: Boolean(state), cliInstalled: false, providerInstalled: false,
        publishedModels: state?.models?.length ?? 0, routableModels: models.length,
      };
    }
    try {
      const openclaw = cli();
      const provider = openclaw.get(PROVIDER_PATH);
      const configPath = openclaw.configFile();
      const secret = currentSecret(secretPath);
      const expectedBaseUrl = callerBaseUrl(port, secret);
      const expectedProvider = buildProvider(models, expectedBaseUrl, secret);
      const providerValid = isDeepStrictEqual(provider, expectedProvider);
      const markerFresh = Boolean(state) && state.baseUrl === expectedBaseUrl &&
        isDeepStrictEqual(state.models, models.map((model) => String(model.slug)));
      return {
        installed: Boolean(state),
        stateValid: true,
        cliInstalled: true,
        cli: openclaw.binary,
        provider: OPENCLAW_PROVIDER_ID,
        providerInstalled: Boolean(provider),
        baseUrlManaged: providerManaged(provider, port, legacyPort),
        callerCapabilityCurrent: Boolean(
          provider?.baseUrl === expectedBaseUrl && provider?.apiKey === secret,
        ),
        baseUrl: provider?.baseUrl ? redactCallerUrl(provider.baseUrl) : null,
        config: configPath || null,
        configExists: Boolean(configPath && existsSync(configPath)),
        configProtected: Boolean(configPath && existsSync(configPath) && privateFileIsProtected(configPath)),
        configValid: providerValid,
        ...(provider && !providerValid
          ? { configError: "the live OpenClaw provider differs from the router-owned protocol, models, or caller capability" }
          : {}),
        publishedModels: state?.models?.length ?? 0,
        routableModels: models.length,
        catalogFresh: markerFresh && providerValid,
        defaultModel: normalizedDefault(openclaw.get(DEFAULT_MODEL_PATH)) || null,
        defaultOwned: Boolean(state?.defaultOwned),
      };
    } catch (error) {
      return {
        installed: Boolean(state), cliInstalled: true, providerInstalled: false,
        configValid: false, configError: redactFailure(error instanceof Error ? error.message : error),
        publishedModels: state?.models?.length ?? 0, routableModels: models.length,
      };
    }
  }

  return { install, uninstall, status, refreshCallerCapability: install };
}

const manager = createOpenClawManager();
export const install = manager.install;
export const uninstall = manager.uninstall;
export const status = manager.status;
export const refreshCallerCapability = manager.refreshCallerCapability;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] || "status";
  const handlers = {
    install,
    uninstall,
    status,
    "caller-capability-refresh": refreshCallerCapability,
  };
  const handler = handlers[command];
  if (!handler) {
    console.error(`Usage: openclaw-config-manager ${Object.keys(handlers).join("|")}`);
    process.exit(2);
  }
  try {
    process.stdout.write(`${JSON.stringify(handler(), null, 2)}\n`);
  } catch (error) {
    console.error(redactFailure(error instanceof Error ? error.message : error));
    process.exit(1);
  }
}
