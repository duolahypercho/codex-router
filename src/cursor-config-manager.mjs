import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { assertCallerSecret, cursorCliBaseUrl, redactCallerUrl } from "./caller-auth.mjs";
import { runningClientProcesses } from "./client-restart-notice.mjs";
import { cursorCatalogSelections } from "./cursor-model-id.mjs";
import {
  CALLER_SECRET_PATH,
  CURSOR_CATALOG_PATH,
  CURSOR_LAUNCHER_PATH,
  CURSOR_PUBLIC_SECRET_PATH,
  CURSOR_STATE_DB_PATH,
  PORTS,
  SOURCE_ROOT,
} from "./paths.mjs";
import {
  cursorPublicBaseUrl,
  redactCursorPublicUrl,
} from "./cursor-public-edge.mjs";
import { writePrivateFile, writePrivateJson } from "./file-security.mjs";
import { routedClientModels } from "./routed-client-models.mjs";
import { spawnableCommand } from "./spawnable-command.mjs";
import { assertStateOwnership } from "./state-owner.mjs";
import { provisionCursorTunnel } from "./cursor-cloudflare-tunnel.mjs";

const APPLICATION_STATE_KEY =
  "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser";
const LEGACY_OPENAI_KEY = "cursorAuth/openAIKey";
const SECURE_OPENAI_KEY = "secret://cursorAuth/openAIKey";
const LAUNCHER_MARKER = "codex-router-cursor-launcher";

function secret(target, label) {
  if (!existsSync(target)) throw new Error(`${label} is missing; run ./bin/doctor --fix.`);
  return assertCallerSecret(readFileSync(target, "utf8").trim());
}

function publicOrigin(value) {
  if (!value) return undefined;
  let url;
  try { url = new URL(value); } catch { throw new Error("Cursor's public URL must be a valid HTTPS origin."); }
  if (
    url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
    !["", "/"].includes(url.pathname)
  ) {
    throw new Error("Cursor's public URL must be an HTTPS origin with no path, credentials, query, or fragment.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const privateIp = isIP(host) === 4
    ? /^(?:0\.|10\.|127\.|169\.254\.|192\.168\.)/.test(host) ||
      /^172\.(?:1[6-9]|2\d|3[01])\./.test(host)
    : isIP(host) === 6
      ? host === "::1" || /^(?:fc|fd|fe[89ab])/i.test(host)
      : false;
  if (host === "localhost" || host.endsWith(".localhost") || privateIp) {
    throw new Error("Cursor's public URL must not use a loopback, link-local, or private-network host.");
  }
  return url.origin;
}

function readJson(target) {
  if (!existsSync(target)) return undefined;
  try { return JSON.parse(readFileSync(target, "utf8")); } catch { return undefined; }
}

function cursorAliases(routedModels = routedClientModels) {
  const { models, engine } = routedModels();
  const selections = cursorCatalogSelections(models);
  return {
    engine,
    models,
    selections,
    aliases: selections.map((selection) => selection.alias),
  };
}

function assertCursorStopped() {
  const running = runningClientProcesses("cursor");
  if (running.length) {
    throw new Error(
      "Cursor is running. Fully quit it before publishing or removing the router integration; " +
      "otherwise Cursor can overwrite its settings database as it exits.",
    );
  }
}

function openDatabase({ readOnly = false } = {}) {
  if (!existsSync(CURSOR_STATE_DB_PATH)) {
    throw new Error(`Cursor's settings database is missing at ${CURSOR_STATE_DB_PATH}; start Cursor once first.`);
  }
  return new DatabaseSync(CURSOR_STATE_DB_PATH, { readOnly });
}

function applicationState(db) {
  const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(APPLICATION_STATE_KEY);
  if (!row?.value) throw new Error("Cursor's application settings record is missing; start Cursor once first.");
  try { return JSON.parse(row.value); } catch { throw new Error("Cursor's application settings record is not valid JSON."); }
}

function saveApplicationState(db, state) {
  db.prepare("UPDATE ItemTable SET value = ? WHERE key = ?").run(JSON.stringify(state), APPLICATION_STATE_KEY);
}

function addAll(values, additions) {
  return [...new Set([...(Array.isArray(values) ? values : []), ...additions])];
}

function without(values, removals) {
  const removed = new Set(removals);
  return (Array.isArray(values) ? values : []).filter((value) => !removed.has(value));
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function selectedComposerAlias(state) {
  const config = state?.aiSettings?.modelConfig?.composer;
  return String(config?.selectedModels?.[0]?.modelId || config?.modelName || "");
}

function selectionForPreviousAlias(alias, previous) {
  const recorded = previous?.selections?.find((selection) => selection?.alias === alias);
  if (recorded?.slug) return recorded;
  if (!String(alias).startsWith("codex_router/")) return undefined;
  const slug = String(alias).slice("codex_router/".length);
  return previous?.models?.includes(slug) ? { slug, effort: undefined } : undefined;
}

function preferredSelection(selections, previousSelection) {
  if (!previousSelection?.slug) return undefined;
  return selections.find((selection) =>
    selection.slug === previousSelection.slug && selection.effort === previousSelection.effort
  ) || selections.find((selection) =>
    selection.slug === previousSelection.slug &&
    selection.effort === selection.model?.defaultEffort
  ) || selections.find((selection) => selection.slug === previousSelection.slug);
}

function setComposerAlias(state, alias) {
  const config = state?.aiSettings?.modelConfig?.composer;
  if (!config || !alias) return;
  config.modelName = alias;
  config.selectedModels = [{ modelId: alias, parameters: [] }];
}

function launcherContents() {
  const nodeBinary = nodeRuntimePath();
  const launcher = path.join(SOURCE_ROOT, "src", "cursor-agent-launcher.mjs");
  if (process.platform === "win32") {
    return `@echo off\r\nREM ${LAUNCHER_MARKER}\r\n"${nodeBinary}" "${launcher}" %*\r\n`;
  }
  const node = nodeBinary.replaceAll("'", "'\\''");
  const quoted = launcher.replaceAll("'", "'\\''");
  return `#!/bin/sh\n# ${LAUNCHER_MARKER}\nexec '${node}' '${quoted}' "$@"\n`;
}

export function nodeRuntimePath({
  execPath = process.execPath,
  electron = Boolean(process.versions.electron),
  environment = process.env,
  exists = existsSync,
} = {}) {
  const configured = environment.CODEX_ROUTER_NODE_BIN;
  if (configured && path.isAbsolute(configured) && exists(configured)) return configured;
  if (!electron && path.isAbsolute(execPath) && exists(execPath)) return execPath;

  const executable = process.platform === "win32" ? "node.exe" : "node";
  const directories = new Set(
    String(environment.PATH || "").split(path.delimiter).filter(path.isAbsolute),
  );
  for (const directory of [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    process.platform === "win32" && environment.ProgramFiles
      ? path.join(environment.ProgramFiles, "nodejs")
      : undefined,
  ]) {
    if (directory) directories.add(directory);
  }
  for (const directory of directories) {
    const candidate = path.join(directory, executable);
    if (exists(candidate)) return candidate;
  }
  throw new Error("Node.js is unavailable; install Node.js 22 or newer before setting up Cursor Agent.");
}

function assertLauncherOwnership() {
  if (existsSync(CURSOR_LAUNCHER_PATH) && !readFileSync(CURSOR_LAUNCHER_PATH, "utf8").includes(LAUNCHER_MARKER)) {
    throw new Error(`${CURSOR_LAUNCHER_PATH} already exists and is not owned by codex-router; refusing to replace it.`);
  }
}

function installLauncher() {
  assertLauncherOwnership();
  mkdirSync(path.dirname(CURSOR_LAUNCHER_PATH), { recursive: true, mode: 0o700 });
  writePrivateFile(CURSOR_LAUNCHER_PATH, launcherContents());
  if (process.platform !== "win32") chmodSync(CURSOR_LAUNCHER_PATH, 0o700);
}

function cursorAgentAvailable() {
  const command = process.env.CURSOR_AGENT_BIN || (process.platform === "win32" ? "cursor-agent.cmd" : "cursor-agent");
  const spawnable = spawnableCommand(command, ["--version"]);
  const probe = spawnSync(spawnable.command, spawnable.args, {
    encoding: "utf8",
    timeout: 5_000,
    ...spawnable.options,
  });
  return { available: probe.status === 0, command, version: probe.status === 0 ? String(probe.stdout || probe.stderr).trim() : null };
}

export function installCursorAgentIntegration({ probe = cursorAgentAvailable } = {}) {
  assertStateOwnership("install the Cursor Agent launcher");
  const agent = probe();
  if (!agent.available) {
    throw new Error(
      `${agent.command} is unavailable. Install Cursor Agent before connecting it to Codex Router.`,
    );
  }
  const caller = secret(CALLER_SECRET_PATH, "Router caller key");
  installLauncher();
  return {
    launcher: CURSOR_LAUNCHER_PATH,
    cursorAgent: agent,
    cliBaseUrl: redactCallerUrl(cursorCliBaseUrl(PORTS.router, caller)),
  };
}

export function publishCursorIntegration({
  origin,
  hostname,
  routedModels = routedClientModels,
  assertStopped = assertCursorStopped,
  provisionTunnel = provisionCursorTunnel,
} = {}) {
  assertStateOwnership("publish the Cursor integration");
  assertStopped();
  const previous = readJson(CURSOR_CATALOG_PATH);
  if (existsSync(CURSOR_CATALOG_PATH) && (!previous?.restore || !previous?.aliases)) {
    throw new Error("Cursor router state is incomplete or unreadable; refusing to guess at the prior Cursor settings.");
  }
  const previousCatalogContents = existsSync(CURSOR_CATALOG_PATH)
    ? readFileSync(CURSOR_CATALOG_PATH)
    : undefined;
  const previousLauncherContents = existsSync(CURSOR_LAUNCHER_PATH)
    ? readFileSync(CURSOR_LAUNCHER_PATH)
    : undefined;
  // Validate every local prerequisite before the tunnel provisioning step can
  // create a cloud resource. A later SQLite failure leaves the exact named
  // tunnel reusable on the next idempotent setup instead of deleting a DNS
  // route we cannot transactionally restore.
  const publicEdgeSecret = secret(CURSOR_PUBLIC_SECRET_PATH, "Cursor public edge key");
  const callerSecret = secret(CALLER_SECRET_PATH, "Router caller key");
  const selectedHostname = hostname || process.env.MODEL_ROUTER_CURSOR_TUNNEL_HOSTNAME;
  const tunnel = selectedHostname ? provisionTunnel({ hostname: selectedHostname }) : undefined;
  const selectedOrigin = publicOrigin(
    tunnel?.origin || origin || process.env.MODEL_ROUTER_CURSOR_PUBLIC_BASE_URL || previous?.publicOrigin,
  );
  if (!selectedOrigin) {
    throw new Error(
      "Cursor App needs a stable public HTTPS origin because retail Cursor sends BYOK requests through Cursor's servers. " +
      "Point that origin's tunnel at 127.0.0.1:" + PORTS.cursorPublic +
      " and re-run with --hostname cursor-router.example.com (managed Cloudflare tunnel) " +
      "or --public-url https://cursor-router.example.com (an existing tunnel).",
    );
  }
  const publicBaseUrl = cursorPublicBaseUrl(selectedOrigin, publicEdgeSecret);
  const { models, engine, selections, aliases } = cursorAliases(routedModels);
  assertLauncherOwnership();
  const db = openDatabase();
  let wroteCatalog = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    const state = applicationState(db);
    const hasKey = db.prepare("SELECT 1 AS present FROM ItemTable WHERE key IN (?, ?) LIMIT 1")
      .get(LEGACY_OPENAI_KEY, SECURE_OPENAI_KEY)?.present;
    const restore = previous?.restore || {
      useOpenAIKey: state.useOpenAIKey,
      openAIBaseUrl: state.openAIBaseUrl,
      userAddedModels: state.aiSettings?.userAddedModels,
      modelOverrideEnabled: state.aiSettings?.modelOverrideEnabled,
      modelOverrideDisabled: state.aiSettings?.modelOverrideDisabled,
      composerModelConfig: cloneJson(state.aiSettings?.modelConfig?.composer),
      insertedOpenAIKeyPlaceholder: !hasKey,
    };
    state.aiSettings ||= {};
    const oldOwned = Array.isArray(previous?.aliases) ? previous.aliases : [];
    const originallyAdded = new Set(restore.userAddedModels || []);
    const originallyEnabled = new Set(restore.modelOverrideEnabled || []);
    state.aiSettings.userAddedModels = addAll(
      without(state.aiSettings.userAddedModels, oldOwned.filter((alias) => !originallyAdded.has(alias))),
      aliases,
    );
    state.aiSettings.modelOverrideEnabled = addAll(
      without(state.aiSettings.modelOverrideEnabled, oldOwned.filter((alias) => !originallyEnabled.has(alias))),
      aliases,
    );
    state.aiSettings.modelOverrideDisabled = without(state.aiSettings.modelOverrideDisabled, aliases);
    const selectedAlias = selectedComposerAlias(state);
    if (oldOwned.includes(selectedAlias)) {
      setComposerAlias(
        state,
        preferredSelection(selections, selectionForPreviousAlias(selectedAlias, previous))?.alias,
      );
    }
    state.useOpenAIKey = true;
    state.openAIBaseUrl = publicBaseUrl;
    saveApplicationState(db, state);
    if (!hasKey) {
      // This is deliberately not a provider credential. Cursor requires a
      // non-empty OpenAI-key field before enabling BYOK; the unguessable path
      // in publicBaseUrl is the edge capability, and Cursor migrates this
      // harmless marker into its encrypted secret store on next launch.
      db.prepare("INSERT INTO ItemTable(key, value) VALUES(?, ?)").run(LEGACY_OPENAI_KEY, "codex-router");
    }
    installLauncher();
    writePrivateJson(CURSOR_CATALOG_PATH, {
      updatedAt: new Date().toISOString(),
      publicOrigin: selectedOrigin,
      ...(tunnel ? { tunnelProvider: "cloudflare", tunnelHostname: tunnel.hostname } : {}),
      publicBaseUrl,
      cliBaseUrl: cursorCliBaseUrl(PORTS.router, callerSecret),
      aliases,
      selections: selections.map(({ alias, slug, effort }) => ({ alias, slug, effort })),
      models: models.map((model) => model.slug),
      restore,
    });
    wroteCatalog = true;
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    if (wroteCatalog) {
      if (previousCatalogContents) writePrivateFile(CURSOR_CATALOG_PATH, previousCatalogContents);
      else if (existsSync(CURSOR_CATALOG_PATH)) unlinkSync(CURSOR_CATALOG_PATH);
    }
    if (previousLauncherContents) {
      writePrivateFile(CURSOR_LAUNCHER_PATH, previousLauncherContents);
      if (process.platform !== "win32") chmodSync(CURSOR_LAUNCHER_PATH, 0o700);
    } else if (
      existsSync(CURSOR_LAUNCHER_PATH) &&
      readFileSync(CURSOR_LAUNCHER_PATH, "utf8").includes(LAUNCHER_MARKER)
    ) {
      unlinkSync(CURSOR_LAUNCHER_PATH);
    }
    throw error;
  } finally {
    db.close();
  }
  return { models, engine, aliases, publicBaseUrl: redactCursorPublicUrl(publicBaseUrl), launcher: CURSOR_LAUNCHER_PATH };
}

export function removeCursorIntegration({ assertStopped = assertCursorStopped } = {}) {
  assertStateOwnership("remove the Cursor integration");
  assertStopped();
  const publishedState = readJson(CURSOR_CATALOG_PATH);
  if (existsSync(CURSOR_CATALOG_PATH) && (!publishedState?.aliases || !publishedState?.restore)) {
    throw new Error("Cursor router state is incomplete or unreadable; refusing to remove settings without a valid restore snapshot.");
  }
  if (!publishedState) {
    if (
      existsSync(CURSOR_LAUNCHER_PATH) &&
      readFileSync(CURSOR_LAUNCHER_PATH, "utf8").includes(LAUNCHER_MARKER)
    ) {
      unlinkSync(CURSOR_LAUNCHER_PATH);
    }
    return { removed: false };
  }
  const published = publishedState || {};
  const snapshot = published.restore || {};
  const db = openDatabase();
  try {
    db.exec("BEGIN IMMEDIATE");
    const state = applicationState(db);
    state.aiSettings ||= {};
    const aliases = published.aliases || [];
    const originalAdded = new Set(snapshot.userAddedModels || []);
    const originalEnabled = new Set(snapshot.modelOverrideEnabled || []);
    const originalDisabled = new Set(snapshot.modelOverrideDisabled || []);
    state.aiSettings.userAddedModels = addAll(
      without(state.aiSettings.userAddedModels, aliases.filter((alias) => !originalAdded.has(alias))),
      aliases.filter((alias) => originalAdded.has(alias)),
    );
    state.aiSettings.modelOverrideEnabled = addAll(
      without(state.aiSettings.modelOverrideEnabled, aliases.filter((alias) => !originalEnabled.has(alias))),
      aliases.filter((alias) => originalEnabled.has(alias)),
    );
    state.aiSettings.modelOverrideDisabled = addAll(
      without(state.aiSettings.modelOverrideDisabled, aliases.filter((alias) => !originalDisabled.has(alias))),
      aliases.filter((alias) => originalDisabled.has(alias)),
    );
    if (aliases.includes(selectedComposerAlias(state)) && snapshot.composerModelConfig !== undefined) {
      state.aiSettings.modelConfig ||= {};
      state.aiSettings.modelConfig.composer = cloneJson(snapshot.composerModelConfig);
    }
    const ownsEndpoint = state.openAIBaseUrl === published.publicBaseUrl;
    if (ownsEndpoint) {
      state.openAIBaseUrl = snapshot.openAIBaseUrl;
      if (state.useOpenAIKey === true) state.useOpenAIKey = snapshot.useOpenAIKey;
    }
    saveApplicationState(db, state);
    if (snapshot.insertedOpenAIKeyPlaceholder === true) {
      db.prepare("DELETE FROM ItemTable WHERE key IN (?, ?) AND value = ?")
        .run(LEGACY_OPENAI_KEY, SECURE_OPENAI_KEY, "codex-router");
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  } finally {
    db.close();
  }
  if (existsSync(CURSOR_CATALOG_PATH)) unlinkSync(CURSOR_CATALOG_PATH);
  if (
    existsSync(CURSOR_LAUNCHER_PATH) &&
    readFileSync(CURSOR_LAUNCHER_PATH, "utf8").includes(LAUNCHER_MARKER)
  ) {
    unlinkSync(CURSOR_LAUNCHER_PATH);
  }
  return { removed: true };
}

export function cursorIntegrationStatus() {
  const published = readJson(CURSOR_CATALOG_PATH);
  let state;
  try {
    const db = openDatabase({ readOnly: true });
    try { state = applicationState(db); } finally { db.close(); }
  } catch {}
  const aliases = published?.aliases || [];
  const expectedAliases = cursorAliases().aliases;
  const currentAliases = state?.aiSettings?.userAddedModels || [];
  const currentEnabled = state?.aiSettings?.modelOverrideEnabled || [];
  const currentDisabled = state?.aiSettings?.modelOverrideDisabled || [];
  const agent = cursorAgentAvailable();
  const launcherInstalled = existsSync(CURSOR_LAUNCHER_PATH);
  return {
    installed: Boolean(published),
    stateDb: CURSOR_STATE_DB_PATH,
    stateReadable: Boolean(state),
    appConfigured: Boolean(
      published && state?.useOpenAIKey === true && state?.openAIBaseUrl === published.publicBaseUrl &&
      aliases.length === expectedAliases.length && aliases.every((alias, index) => alias === expectedAliases[index]) &&
      aliases.every((alias) => currentAliases.includes(alias) && currentEnabled.includes(alias)) &&
      aliases.every((alias) => !currentDisabled.includes(alias))
    ),
    running: runningClientProcesses("cursor").length > 0,
    publicBaseUrl: published?.publicBaseUrl ? redactCursorPublicUrl(published.publicBaseUrl) : null,
    publicOrigin: published?.publicOrigin || null,
    tunnelProvider: published?.tunnelProvider || null,
    tunnelHostname: published?.tunnelHostname || null,
    cliBaseUrl: published?.cliBaseUrl ? redactCallerUrl(published.cliBaseUrl) : null,
    launcher: CURSOR_LAUNCHER_PATH,
    launcherInstalled,
    agentConfigured: launcherInstalled && agent.available,
    cursorAgent: agent,
    publishedModels: published?.models || [],
    routableModels: cursorAliases().models.map((model) => model.slug),
    publishedAliases: aliases,
    routableAliases: expectedAliases,
  };
}

export function cursorCatalogDrift() {
  const status = cursorIntegrationStatus();
  if (!status.installed) return { installed: false };
  const published = new Set(status.publishedModels);
  const routable = new Set(status.routableModels);
  return {
    missing: [...published].filter((slug) => !routable.has(slug)),
    added: [...routable].filter((slug) => !published.has(slug)),
    aliasesStale: status.publishedAliases.length !== status.routableAliases.length ||
      status.publishedAliases.some((alias, index) => alias !== status.routableAliases[index]),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] || "status";
  const publicUrlIndex = process.argv.indexOf("--public-url");
  const origin = publicUrlIndex >= 0 ? process.argv[publicUrlIndex + 1] : undefined;
  const hostnameIndex = process.argv.indexOf("--hostname");
  const hostname = hostnameIndex >= 0 ? process.argv[hostnameIndex + 1] : undefined;
  const handlers = {
    "agent-install": () => installCursorAgentIntegration(),
    install: () => publishCursorIntegration({ origin, hostname }),
    uninstall: () => removeCursorIntegration(),
    status: () => cursorIntegrationStatus(),
    drift: () => cursorCatalogDrift(),
  };
  try {
    if (!handlers[command] || (publicUrlIndex >= 0 && !origin) || (hostnameIndex >= 0 && !hostname) || (origin && hostname)) {
      throw Object.assign(new Error("Usage: cursor-config-manager agent-install|install [--hostname PUBLIC_HOSTNAME|--public-url HTTPS_ORIGIN]|uninstall|status|drift"), { usage: true });
    }
    process.stdout.write(`${JSON.stringify(handlers[command](), null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error?.usage ? 2 : 1;
  }
}
