import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

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
const routerProviderId = "codex-router";
const markerPairs = [
  [startMarker, endMarker],
  [providerStartMarker, providerEndMarker],
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

function removeMarkedBlock(input) {
  return markerPairs.reduce((contents, [start, end]) => {
    const escapedStart = start.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedEnd = end.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return contents.replace(
      new RegExp(`(?:^|\\n)${escapedStart}\\n[\\s\\S]*?\\n${escapedEnd}(?:\\n|$)`, "g"),
      "\n",
    );
  }, input);
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

function clean(contents) {
  const knownCatalogPaths = [
    MERGED_CATALOG_PATH,
    ...LEGACY_STATE_DIRS.map((directory) => path.join(directory, "merged-models.json")),
  ];
  const knownManaged =
    markerPairs.some(([start]) => contents.includes(start)) ||
    knownCatalogPaths.some((catalogPath) => contents.includes(catalogPath));
  const withoutBlock = removeMarkedBlock(contents);
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
  if (
    hasUnmanagedRouterProvider(contents) ||
    (currentProvider === routerProviderId && !existsSync(CODEX_PROVIDER_MODE_PATH))
  ) {
    throw new Error(
      `Refusing to replace user-owned model provider ${routerProviderId}.`,
    );
  }
  const routerBaseUrl = configuredRouterBaseUrl();
  const cleaned = clean(contents);
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
  rootLines.push(
    "",
    startMarker,
    `openai_base_url = ${JSON.stringify(routerBaseUrl)}`,
    `model_catalog_json = ${JSON.stringify(MERGED_CATALOG_PATH)}`,
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
  return `${next.join("\n").trimEnd()}\n`;
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
