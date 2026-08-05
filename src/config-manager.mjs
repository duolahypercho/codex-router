import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { codexSpawnTarget, findCodexBinary } from "./codex-binary.mjs";

import {
  assertCallerSecret,
  callerBaseUrl,
  isManagedCallerBaseUrl,
  redactCallerUrl,
} from "./caller-auth.mjs";
import {
  privateFileIsProtected,
  protectPrivateFile,
} from "./file-security.mjs";
import {
  BACKUP_PATH,
  CALLER_SECRET_PATH,
  CODEX_PROVIDER_MODE_PATH,
  CONFIG_PATH,
  LEGACY_STATE_DIRS,
  MERGED_CATALOG_PATH,
  PORTS,
  loopback,
} from "./paths.mjs";

const legacyRouterBaseUrl = loopback(PORTS.router, "/v1");
const startMarker = "# BEGIN codex-router-managed";
const endMarker = "# END codex-router-managed";
const providerStartMarker = "# BEGIN codex-router-provider-managed";
const providerEndMarker = "# END codex-router-provider-managed";
const agentConcurrencyStartMarker = "# BEGIN codex-router-agent-concurrency-managed";
const agentConcurrencyEndMarker = "# END codex-router-agent-concurrency-managed";
const createdAgentsTableMarker = "# codex-router-created-agents-table";
const managedAgentMaxConcurrency = 6;
const routerProviderId = "codex-router";
const defaultChatgptBaseUrl = "https://chatgpt.com/backend-api";
const defaultRealtimeWebsocketBaseUrl = "https://api.openai.com/v1";
const realtimeCallBaseUrlKey = "experimental_realtime_webrtc_call_base_url";
const realtimeWebsocketBaseUrlKey = "experimental_realtime_ws_base_url";
const markerPairs = [
  [startMarker, endMarker],
  [providerStartMarker, providerEndMarker],
  [agentConcurrencyStartMarker, agentConcurrencyEndMarker],
  ["# BEGIN kimi-codex-router-managed", "# END kimi-codex-router-managed"],
  ["# BEGIN kimi-codex-proxy-managed", "# END kimi-codex-proxy-managed"],
];
const command = process.argv[2] || "status";

function configuredRouterBaseUrl() {
  if (!existsSync(CALLER_SECRET_PATH)) {
    throw new Error("The local router caller key is missing; run ./bin/doctor --fix.");
  }
  const secret = assertCallerSecret(readFileSync(CALLER_SECRET_PATH, "utf8").trim());
  return callerBaseUrl(PORTS.router, secret);
}

function isManagedRouterBaseUrl(value) {
  return (
    value === legacyRouterBaseUrl ||
    isManagedCallerBaseUrl(value, PORTS.router)
  );
}

function isRecognizedRouterBaseUrl(value) {
  if (isManagedRouterBaseUrl(value) || isManagedCallerBaseUrl(value)) return true;
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/v1\/?$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function removeMarkerPair(input, start, end) {
  const escapedStart = start.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedEnd = end.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return input.replace(
    new RegExp(`(?:^|\\n)${escapedStart}\\n[\\s\\S]*?\\n${escapedEnd}(?:\\n|$)`, "g"),
    "\n",
  );
}

function removeMarkedBlock(input) {
  return markerPairs.reduce(
    (contents, [start, end]) => removeMarkerPair(contents, start, end),
    input,
  );
}

function removeCreatedAgentsTableIfEmpty(input) {
  const lines = input.split("\n");
  const markerIndex = lines.findIndex(
    (line) => line.trim() === createdAgentsTableMarker,
  );
  if (markerIndex === -1) return input;

  let headerIndex = markerIndex + 1;
  while (headerIndex < lines.length && !lines[headerIndex].trim()) headerIndex += 1;
  if (!/^\s*\[\s*agents\s*\]\s*(?:#.*)?$/.test(lines[headerIndex] || "")) {
    lines.splice(markerIndex, 1);
    return lines.join("\n");
  }

  let tableEnd = headerIndex + 1;
  while (tableEnd < lines.length && !/^\s*\[/.test(lines[tableEnd])) tableEnd += 1;
  const hasUserValues = lines
    .slice(headerIndex + 1, tableEnd)
    .some((line) => line.trim() && !line.trim().startsWith("#"));
  if (hasUserValues) {
    lines.splice(markerIndex, 1);
  } else {
    lines.splice(headerIndex, 1);
    lines.splice(markerIndex, 1);
  }
  return lines.join("\n");
}

function withoutManagedAgentConcurrency(input) {
  return removeCreatedAgentsTableIfEmpty(
    removeMarkerPair(input, agentConcurrencyStartMarker, agentConcurrencyEndMarker),
  );
}

function hasModernMultiAgentConfig(input) {
  const lines = input.split("\n");
  if (lines.some((line) => /^\s*features\.multi_agent_v2\s*=/.test(line))) return true;
  if (lines.some((line) => /^\s*\[agents\.[^\]]+\]\s*(?:#.*)?$/.test(line))) return true;
  const featuresHeader = lines.findIndex((line) =>
    /^\s*\[features\]\s*(?:#.*)?$/.test(line),
  );
  if (featuresHeader === -1) return false;
  let tableEnd = featuresHeader + 1;
  while (tableEnd < lines.length && !/^\s*\[/.test(lines[tableEnd])) tableEnd += 1;
  return lines
    .slice(featuresHeader + 1, tableEnd)
    .some((line) => /^\s*multi_agent_v2\s*=/.test(line));
}

// Some Codex builds parse `[agents]` as a pure role map and reject the
// concurrency scalar outright, which blocks the whole config from loading
// (observed on 0.141-0.145; earlier and later builds accept it). A version
// table would need constant maintenance, so ask the installed binary instead:
// have it load a config containing only the scalar and see whether it parses.
// The probe config is minimal on purpose — the answer must not depend on
// anything else in the user's config.
let codexAcceptsAgentConcurrencyScalar;
function installedCodexAcceptsAgentConcurrencyScalar() {
  if (codexAcceptsAgentConcurrencyScalar !== undefined) {
    return codexAcceptsAgentConcurrencyScalar;
  }
  codexAcceptsAgentConcurrencyScalar = probeAgentConcurrencyScalar();
  return codexAcceptsAgentConcurrencyScalar;
}

function probeAgentConcurrencyScalar() {
  const binary = findCodexBinary();
  // With no binary to ask, keep the historical behavior of writing the scalar.
  if (!binary) return true;
  const probeHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-schema-probe-"));
  try {
    writeFileSync(
      path.join(probeHome, "config.toml"),
      `[agents]\nmax_concurrent_threads_per_session = ${managedAgentMaxConcurrency}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    const { command: probeCommand, options } = codexSpawnTarget(binary);
    // `login status` exits non-zero when signed out, so the exit code says
    // nothing about the config; only the load-error message does.
    const result = spawnSync(probeCommand, ["login", "status"], {
      ...options,
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, CODEX_HOME: probeHome },
    });
    if (result.error) return true;
    return !/Error loading configuration/i.test(
      `${result.stdout || ""}\n${result.stderr || ""}`,
    );
  } catch {
    return true;
  } finally {
    rmSync(probeHome, { recursive: true, force: true });
  }
}

function withManagedAgentConcurrency(input) {
  const cleaned = withoutManagedAgentConcurrency(input);
  if (hasModernMultiAgentConfig(cleaned)) return cleaned;
  const { rootLines } = splitRoot(cleaned);
  if (
    rootLines.some((line) =>
      /^\s*agents(?:\.(?:max_concurrent_threads_per_session|max_threads))?\s*=/.test(
        line,
      ),
    )
  ) {
    return cleaned;
  }

  const lines = cleaned.split("\n");
  const agentsHeader = lines.findIndex((line) =>
    /^\s*\[\s*agents\s*\]\s*(?:#.*)?$/.test(line),
  );
  if (agentsHeader !== -1) {
    let tableEnd = agentsHeader + 1;
    while (tableEnd < lines.length && !/^\s*\[/.test(lines[tableEnd])) tableEnd += 1;
    const userConfigured = lines
      .slice(agentsHeader + 1, tableEnd)
      .some((line) =>
        /^\s*(?:max_concurrent_threads_per_session|max_threads)\s*=/.test(line),
      );
    if (userConfigured) return cleaned;
  }
  if (!installedCodexAcceptsAgentConcurrencyScalar()) return cleaned;
  const managedLines = [
    agentConcurrencyStartMarker,
    `max_concurrent_threads_per_session = ${managedAgentMaxConcurrency}`,
    agentConcurrencyEndMarker,
  ];
  if (agentsHeader !== -1) {
    lines.splice(agentsHeader + 1, 0, ...managedLines);
  } else {
    while (lines.length && !lines.at(-1).trim()) lines.pop();
    lines.push("", createdAgentsTableMarker, "[agents]", ...managedLines);
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function splitRoot(input) {
  const lines = input.split("\n");
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  return firstTable === -1
    ? { rootLines: lines, tableLines: [] }
    : { rootLines: lines.slice(0, firstTable), tableLines: lines.slice(firstTable) };
}

function trimBlankEdges(lines) {
  const copy = [...lines];
  while (copy.length && !copy[0].trim()) copy.shift();
  while (copy.length && !copy.at(-1).trim()) copy.pop();
  return copy;
}

function assignmentValue(line) {
  const raw = line.split("=").slice(1).join("=").trim();
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "string") return parsed;
    } catch {
      // Preserve the previous best-effort behavior for malformed user config.
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  return raw.replace(/^(["'])|(["'])$/g, "");
}

function rootValue(lines, key) {
  const match = lines.find((line) => new RegExp(`^\\s*${key}\\s*=`).test(line));
  return match ? assignmentValue(match) : undefined;
}

function rootHasValue(lines, key) {
  return lines.some((line) => new RegExp(`^\\s*${key}\\s*=`).test(line));
}

function nativeRealtimeCallBaseUrl(lines) {
  const chatgptBaseUrl = (
    rootValue(lines, "chatgpt_base_url") || defaultChatgptBaseUrl
  ).replace(/\/+$/, "");
  return chatgptBaseUrl.endsWith("/codex")
    ? chatgptBaseUrl
    : `${chatgptBaseUrl}/codex`;
}

function replaceRootValue(contents, key, value) {
  const { rootLines, tableLines } = splitRoot(contents);
  const filtered = rootLines.filter(
    (line) => !new RegExp(`^\\s*${key}\\s*=`).test(line),
  );
  if (value !== undefined) {
    const managedBlock = filtered.findIndex((line) => line.trim() === startMarker);
    filtered.splice(
      managedBlock === -1 ? filtered.length : managedBlock,
      0,
      `${key} = ${JSON.stringify(value)}`,
    );
  }
  return [...trimBlankEdges(filtered), "", ...trimBlankEdges(tableLines)]
    .join("\n")
    .trimEnd();
}

function readProviderModeState() {
  if (!existsSync(CODEX_PROVIDER_MODE_PATH)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(CODEX_PROVIDER_MODE_PATH, "utf8"));
    if (
      parsed?.version !== 1 ||
      typeof parsed.previousPresent !== "boolean" ||
      (parsed.previousPresent && typeof parsed.previousModelProvider !== "string") ||
      typeof parsed.previousModelPresent !== "boolean" ||
      (parsed.previousModelPresent && typeof parsed.previousModel !== "string")
    ) {
      throw new Error("invalid state");
    }
    return parsed;
  } catch {
    throw new Error(`Invalid Codex provider-mode state at ${CODEX_PROVIDER_MODE_PATH}.`);
  }
}

function writeProviderModeState(value) {
  mkdirSync(path.dirname(CODEX_PROVIDER_MODE_PATH), { recursive: true, mode: 0o700 });
  const temporary = `${CODEX_PROVIDER_MODE_PATH}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    protectPrivateFile(temporary);
    renameSync(temporary, CODEX_PROVIDER_MODE_PATH);
    protectPrivateFile(CODEX_PROVIDER_MODE_PATH);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

function clearProviderModeState() {
  if (existsSync(CODEX_PROVIDER_MODE_PATH)) unlinkSync(CODEX_PROVIDER_MODE_PATH);
}

function hasUnmanagedRouterProvider(contents) {
  const withoutManagedBlock = removeMarkedBlock(contents);
  return new RegExp(
    `^\\s*\\[model_providers\\.(?:${routerProviderId}|["']${routerProviderId}["'])\\]\\s*$`,
    "m",
  ).test(withoutManagedBlock);
}

function legacyManagedRouterProvider(contents) {
  if (!contents.includes(startMarker) || !contents.includes(endMarker)) {
    return undefined;
  }
  const lines = contents.split("\n");
  const headers = lines
    .map((line, index) =>
      /^\s*\[model_providers\.codex-router\]\s*$/.test(line) ? index : -1,
    )
    .filter((index) => index !== -1);
  if (headers.length !== 1) return undefined;

  const start = headers[0];
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end += 1;

  const fields = new Map();
  for (const line of lines.slice(start + 1, end)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === createdAgentsTableMarker) continue;
    const match = trimmed.match(/^([A-Za-z0-9_-]+)\s*=/);
    if (!match || fields.has(match[1])) return undefined;
    fields.set(match[1], assignmentValue(trimmed));
  }

  const { rootLines } = splitRoot(contents);
  const rootBaseUrl = rootValue(rootLines, "openai_base_url");
  const commonFieldsMatch =
    fields.get("base_url") === rootBaseUrl &&
    isManagedRouterBaseUrl(rootBaseUrl) &&
    fields.get("wire_api") === "responses";
  const currentShape =
    fields.size === 3 &&
    fields.get("name") === "Codex Router (external models)";
  const prototypeShape =
    fields.size === 4 &&
    fields.get("name") === "Codex Router (extra providers)" &&
    fields.get("requires_openai_auth") === "true";
  return commonFieldsMatch && (currentShape || prototypeShape)
    ? { lines, start, end }
    : undefined;
}

function removeLegacyManagedRouterProvider(contents, provider) {
  return [
    ...provider.lines.slice(0, provider.start),
    ...provider.lines.slice(provider.end),
  ].join("\n");
}

function clean(contents) {
  const knownCatalogPaths = [
    MERGED_CATALOG_PATH,
    ...LEGACY_STATE_DIRS.map((directory) => path.join(directory, "merged-models.json")),
  ];
  const knownManaged =
    markerPairs.some(([start]) => contents.includes(start)) ||
    knownCatalogPaths.some((catalogPath) => contents.includes(catalogPath));
  const withoutBlock = removeCreatedAgentsTableIfEmpty(removeMarkedBlock(contents));
  const { rootLines, tableLines } = splitRoot(withoutBlock);
  const filtered = rootLines.filter((line) => {
    if (/^\s*openai_base_url\s*=/.test(line)) {
      return !(knownManaged && isRecognizedRouterBaseUrl(assignmentValue(line)));
    }
    if (/^\s*model_catalog_json\s*=/.test(line)) {
      return !knownCatalogPaths.includes(assignmentValue(line));
    }
    return !markerPairs.flat().includes(line.trim());
  });
  return { rootLines: filtered, tableLines };
}

function snapshot(contents) {
  const { rootLines } = splitRoot(contents);
  const baseUrl = rootValue(rootLines, "openai_base_url");
  const catalog = rootValue(rootLines, "model_catalog_json");
  return {
    mode:
      isManagedRouterBaseUrl(baseUrl) && catalog === MERGED_CATALOG_PATH
        ? "router"
        : "native",
    model: rootValue(rootLines, "model") || null,
    model_provider: rootValue(rootLines, "model_provider") || "openai",
    login_free: rootValue(rootLines, "model_provider") === routerProviderId,
    login_free_managed:
      rootValue(rootLines, "model_provider") === routerProviderId &&
      existsSync(CODEX_PROVIDER_MODE_PATH),
    provider_mode_state_present: existsSync(CODEX_PROVIDER_MODE_PATH),
    openai_base_url: baseUrl ? redactCallerUrl(baseUrl) : null,
    model_catalog_json: catalog || null,
    config_protected: privateFileIsProtected(CONFIG_PATH),
  };
}

function enabledContents(contents) {
  const { rootLines: currentRoot } = splitRoot(contents);
  const currentProvider = rootValue(currentRoot, "model_provider");
  const legacyProvider = legacyManagedRouterProvider(contents);
  const contentsWithoutLegacyProvider = legacyProvider
    ? removeLegacyManagedRouterProvider(contents, legacyProvider)
    : contents;
  if (
    hasUnmanagedRouterProvider(contentsWithoutLegacyProvider) ||
    (currentProvider === routerProviderId && !existsSync(CODEX_PROVIDER_MODE_PATH))
  ) {
    throw new Error(
      `Refusing to replace user-owned model provider ${routerProviderId}.`,
    );
  }
  const routerBaseUrl = configuredRouterBaseUrl();
  const cleaned = clean(contentsWithoutLegacyProvider);
  const rootLines = trimBlankEdges(cleaned.rootLines);
  const existingBase = rootValue(rootLines, "openai_base_url");
  const existingCatalog = rootValue(rootLines, "model_catalog_json");
  if (existingBase && existingBase !== routerBaseUrl) {
    throw new Error(
      `Refusing to replace user-owned openai_base_url: ${redactCallerUrl(existingBase)}`,
    );
  }
  if (existingCatalog && existingCatalog !== MERGED_CATALOG_PATH) {
    throw new Error(`Refusing to replace user-owned model_catalog_json: ${existingCatalog}`);
  }
  const managedRealtimeOverrides = [];
  // Codex Voice uses a WebRTC call plus a sideband WebSocket. Keep both on
  // Codex's native endpoints instead of inheriting the Responses-only router URL.
  if (!rootHasValue(rootLines, realtimeCallBaseUrlKey)) {
    managedRealtimeOverrides.push(
      `${realtimeCallBaseUrlKey} = ${JSON.stringify(nativeRealtimeCallBaseUrl(rootLines))}`,
    );
  }
  if (!rootHasValue(rootLines, realtimeWebsocketBaseUrlKey)) {
    managedRealtimeOverrides.push(
      `${realtimeWebsocketBaseUrlKey} = ${JSON.stringify(defaultRealtimeWebsocketBaseUrl)}`,
    );
  }
  rootLines.push(
    "",
    startMarker,
    `openai_base_url = ${JSON.stringify(routerBaseUrl)}`,
    `model_catalog_json = ${JSON.stringify(MERGED_CATALOG_PATH)}`,
    ...managedRealtimeOverrides,
    endMarker,
  );
  const tableLines = trimBlankEdges(cleaned.tableLines);
  const next = [
    ...trimBlankEdges(rootLines),
    "",
    ...tableLines,
    ...(tableLines.length ? [""] : []),
    providerStartMarker,
    `[model_providers.${routerProviderId}]`,
    'name = "Codex Router (external models)"',
    `base_url = ${JSON.stringify(routerBaseUrl)}`,
    'wire_api = "responses"',
    providerEndMarker,
  ];
  return withManagedAgentConcurrency(`${next.join("\n").trimEnd()}\n`);
}

function atomicWrite(contents) {
  mkdirSync(path.dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  const temporary = `${CONFIG_PATH}.tmp.${process.pid}`;
  writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
  try {
    protectPrivateFile(temporary);
    renameSync(temporary, CONFIG_PATH);
    protectPrivateFile(CONFIG_PATH);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

if (!new Set(["enable", "disable", "status", "login-free-enable", "login-free-disable"]).has(command)) {
  console.error(
    "Usage: config-manager.mjs enable|disable|status|login-free-enable|login-free-disable",
  );
  process.exit(2);
}

const current = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : "";
if (command === "status") {
  process.stdout.write(`${JSON.stringify(snapshot(current))}\n`);
  process.exit(0);
}

let next;
let pendingProviderModeState;
if (command === "enable") {
  next = enabledContents(current);
} else if (command === "login-free-enable") {
  const enabled = enabledContents(current);
  const { rootLines } = splitRoot(current);
  const loginFreeModel = String(process.argv[3] || "").trim();
  const alreadyManaged =
    rootValue(rootLines, "model_provider") === routerProviderId &&
    existsSync(CODEX_PROVIDER_MODE_PATH);
  if (!alreadyManaged) {
    pendingProviderModeState = {
      version: 1,
      previousPresent: rootHasValue(rootLines, "model_provider"),
      ...(rootHasValue(rootLines, "model_provider")
        ? { previousModelProvider: rootValue(rootLines, "model_provider") }
        : {}),
      previousModelPresent: rootHasValue(rootLines, "model"),
      ...(rootHasValue(rootLines, "model")
        ? { previousModel: rootValue(rootLines, "model") }
        : {}),
    };
  }
  next = `${replaceRootValue(enabled, "model_provider", routerProviderId)}\n`;
  if (loginFreeModel) next = `${replaceRootValue(next, "model", loginFreeModel)}\n`;
} else {
  const state = readProviderModeState();
  const { rootLines } = splitRoot(current);
  const currentProvider = rootValue(rootLines, "model_provider");
  let restored = current;
  if (state) {
    if (currentProvider !== routerProviderId) {
      throw new Error(
        `Refusing to replace user-owned model_provider: ${currentProvider || "unset"}.`,
      );
    }
    restored = `${replaceRootValue(
      current,
      "model_provider",
      state.previousPresent ? state.previousModelProvider : undefined,
    )}\n`;
    restored = `${replaceRootValue(
      restored,
      "model",
      state.previousModelPresent ? state.previousModel : undefined,
    )}\n`;
  } else if (command === "login-free-disable" && currentProvider === routerProviderId) {
    throw new Error("Codex login-free mode is not managed by this router.");
  }
  if (command === "login-free-disable") {
    next = restored;
  } else {
    const cleaned = clean(restored);
    next = `${[
      ...trimBlankEdges(cleaned.rootLines),
      "",
      ...trimBlankEdges(cleaned.tableLines),
    ].join("\n").trimEnd()}\n`;
  }
}
if (existsSync(CONFIG_PATH) && !existsSync(BACKUP_PATH)) {
  copyFileSync(CONFIG_PATH, BACKUP_PATH);
}
if (existsSync(BACKUP_PATH)) protectPrivateFile(BACKUP_PATH);
if (pendingProviderModeState) writeProviderModeState(pendingProviderModeState);
try {
  atomicWrite(next);
} catch (error) {
  if (pendingProviderModeState) clearProviderModeState();
  throw error;
}
if (command === "disable" || command === "login-free-disable") clearProviderModeState();
process.stdout.write(`${JSON.stringify(snapshot(next))}\n`);
