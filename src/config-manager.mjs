import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
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

import { findCodexBinary, spawnableCommand } from "./codex-binary.mjs";

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
  clearCodexRouterDefault,
  readCodexRouterDefault,
  writeCodexRouterDefault,
} from "./codex-default-model.mjs";
import {
  activateNativeCatalogSource,
  catalogPathsEqual,
  clearNativeCatalogSource,
  readNativeCatalogSource,
} from "./native-catalog-source.mjs";
import {
  BACKUP_PATH,
  CALLER_SECRET_PATH,
  CODEX_PROVIDER_MODE_PATH,
  CONFIG_PATH,
  LEGACY_STATE_DIRS,
  LEGACY_PORTS,
  MERGED_CATALOG_PATH,
  PORTS,
  SIGNED_PROVIDER_MODE_PATH,
  loopback,
} from "./paths.mjs";
import { scanTomlDocument } from "./toml-structure.mjs";

const managedRouterBaseUrls = new Set([
  loopback(PORTS.router, "/v1"),
  loopback(LEGACY_PORTS.router, "/v1"),
]);
const startMarker = "# BEGIN codex-router-managed";
const endMarker = "# END codex-router-managed";
const providerStartMarker = "# BEGIN codex-router-provider-managed";
const providerEndMarker = "# END codex-router-provider-managed";
const signedProviderStartMarker = "# BEGIN codex-router-signed-provider-managed";
const signedProviderEndMarker = "# END codex-router-signed-provider-managed";
const signedProviderSlotPrefix = "# codex-router-signed-provider-tree-slot";
const agentConcurrencyStartMarker = "# BEGIN codex-router-agent-concurrency-managed";
const agentConcurrencyEndMarker = "# END codex-router-agent-concurrency-managed";
const multiAgentV2StartMarker = "# BEGIN codex-router-multi-agent-v2-managed";
const multiAgentV2EndMarker = "# END codex-router-multi-agent-v2-managed";
const standaloneWebSearchStartMarker =
  "# BEGIN codex-router-standalone-web-search-managed";
const standaloneWebSearchEndMarker =
  "# END codex-router-standalone-web-search-managed";
const createdAgentsTableMarker = "# codex-router-created-agents-table";
const managedAgentMaxConcurrency = 6;
// Codex 0.147 records a child's FINAL_ANSWER as subAgentActivity
// `interacted` and keeps that child visually working for the whole live
// parent turn. close_agent is not in the v2 toolset; interrupt_agent is the
// only model-callable way to flip the badge to done without the user
// clicking into the child. The usage hint is injected into the root
// developer's collaboration preamble.
const managedSubagentCompletionHint =
  "When a child agent finishes (FINAL_ANSWER, task_complete, or an idle/errored wait snapshot), call interrupt_agent on that child so Codex can mark it done. Do not leave finished children in the working state.";

export function managedMultiAgentV2FeatureLine() {
  return (
    `multi_agent_v2 = { enabled = true, max_concurrent_threads_per_session = ${managedAgentMaxConcurrency}, ` +
    `expose_spawn_agent_model_overrides = true, usage_hint_enabled = true, ` +
    `root_agent_usage_hint_text = ${tomlValue(managedSubagentCompletionHint)} }`
  );
}
const routerProviderId = "codex-router";
const signedProviderId = "codex-router-signed";
const defaultChatgptBaseUrl = "https://chatgpt.com/backend-api";
const defaultRealtimeWebsocketBaseUrl = "https://api.openai.com/v1";

// Renders a string as a TOML basic string. JSON escaping is valid TOML
// escaping, and unlike TOML literal strings it supports apostrophes anywhere
// in a Windows path. The legacy-migration detector unescapes basic strings
// before comparing catalog paths.
function tomlValue(value) {
  return JSON.stringify(value);
}
const realtimeCallBaseUrlKey = "experimental_realtime_webrtc_call_base_url";
const realtimeWebsocketBaseUrlKey = "experimental_realtime_ws_base_url";
const markerPairs = [
  // The legacy layout parked the managed provider table inside the root
  // block, so the root pair recognizes that header as managed too.
  [startMarker, endMarker, "[model_providers.codex-router]"],
  [providerStartMarker, providerEndMarker, "[model_providers.codex-router]"],
  [
    signedProviderStartMarker,
    signedProviderEndMarker,
    "[model_providers.codex-router-signed]",
  ],
  [agentConcurrencyStartMarker, agentConcurrencyEndMarker],
  [multiAgentV2StartMarker, multiAgentV2EndMarker],
  [standaloneWebSearchStartMarker, standaloneWebSearchEndMarker],
  ["# BEGIN kimi-codex-router-managed", "# END kimi-codex-router-managed"],
  ["# BEGIN kimi-codex-proxy-managed", "# END kimi-codex-proxy-managed"],
];
const command = process.argv[2] || "status";
const adoptNativeCatalog = process.argv.includes("--adopt-native-catalog");
let nativeCatalogNeedsActivation = false;

function configuredRouterBaseUrl() {
  if (!existsSync(CALLER_SECRET_PATH)) {
    throw new Error("The local router caller key is missing; run ./bin/doctor --fix.");
  }
  const secret = assertCallerSecret(readFileSync(CALLER_SECRET_PATH, "utf8").trim());
  return callerBaseUrl(PORTS.router, secret);
}

function isManagedRouterBaseUrl(value) {
  return (
    managedRouterBaseUrls.has(value) ||
    isManagedCallerBaseUrl(value, PORTS.router) ||
    isManagedCallerBaseUrl(value, LEGACY_PORTS.router)
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

// A managed block is regenerated from scratch on every enable/disable, but
// foreign content can land inside one: the desktop app rewrites config.toml
// wholesale and may park user tables (for example [desktop]) between the
// managed provider table and the end marker. Dropping the whole block would
// silently delete those user settings, so foreign table segments are hoisted
// out of the block before it is removed. The managed table itself is
// identified by its header and dropped, since the caller regenerates it.
function foreignTableSegments(innerLines, managedHeader) {
  // The real TOML scanner, not a `[`-prefix regex: a multiline string value
  // inside a parked table can hold a line that merely looks like a header, and
  // splitting there would corrupt the hoisted table. Ambiguous structure makes
  // the scanner throw, which aborts the rewrite before anything is written —
  // the same fail-closed posture the signed-routing path takes.
  const { headers } = scanTomlDocument(innerLines.join("\n"));
  const hoisted = [];
  for (let position = 0; position < headers.length; position += 1) {
    const start = headers[position].index;
    if (managedHeader && innerLines[start].trim() === managedHeader) continue;
    const end =
      position + 1 < headers.length ? headers[position + 1].index : innerLines.length;
    hoisted.push(...innerLines.slice(start, end));
    // Lines before the first table header are the block's own root keys or
    // blank/comment noise; both are regenerated by the caller, never hoisted.
  }
  return hoisted;
}

function removeMarkerPair(input, start, end, managedHeader) {
  const lines = input.split("\n");
  const output = [];
  let index = 0;
  while (index < lines.length) {
    if (lines[index].trim() !== start) {
      output.push(lines[index]);
      index += 1;
      continue;
    }
    let endIndex = index + 1;
    while (endIndex < lines.length && lines[endIndex].trim() !== end) {
      endIndex += 1;
    }
    if (endIndex >= lines.length) {
      // An unterminated block is not recognized as managed; leave it alone.
      output.push(lines[index]);
      index += 1;
      continue;
    }
    output.push(...foreignTableSegments(lines.slice(index + 1, endIndex), managedHeader));
    index = endIndex + 1;
  }
  return output.join("\n");
}

function removeMarkedBlock(input) {
  return markerPairs.reduce(
    (contents, [start, end, managedHeader]) =>
      removeMarkerPair(contents, start, end, managedHeader),
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

function removeEmptyFeaturesTable(input) {
  const lines = input.split("\n");
  const headers = lines
    .map((line, index) =>
      /^\s*\[features\]\s*(?:#.*)?$/.test(line) ? index : -1,
    )
    .filter((index) => index !== -1);
  if (!headers.length) return input;
  const remove = new Set();
  for (const header of headers) {
    let tableEnd = header + 1;
    while (tableEnd < lines.length && !/^\s*\[/.test(lines[tableEnd])) tableEnd += 1;
    const hasValue = lines
      .slice(header + 1, tableEnd)
      .some((line) => line.trim() && !line.trim().startsWith("#"));
    if (hasValue) continue;
    remove.add(header);
    for (let index = header + 1; index < tableEnd; index += 1) remove.add(index);
  }
  if (!remove.size) return input;
  return lines
    .map((line, index) => (remove.has(index) ? null : line))
    .filter((line) => line !== null)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

function withoutManagedAgentConcurrency(input) {
  return removeCreatedAgentsTableIfEmpty(
    removeMarkerPair(input, agentConcurrencyStartMarker, agentConcurrencyEndMarker),
  );
}

function withoutManagedMultiAgentV2(input) {
  return removeMarkerPair(input, multiAgentV2StartMarker, multiAgentV2EndMarker);
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

// Some Codex builds do not know the `multi_agent_v2` feature and would reject
// the whole config if we wrote it. Probe the installed binary before adding
// the managed block; older builds keep the legacy agents scalar instead.
let codexSupportsMultiAgentV2;
function installedCodexSupportsMultiAgentV2() {
  if (codexSupportsMultiAgentV2 !== undefined) {
    return codexSupportsMultiAgentV2;
  }
  codexSupportsMultiAgentV2 = probeMultiAgentV2Support();
  return codexSupportsMultiAgentV2;
}

function probeMultiAgentV2Support() {
  const binary = findCodexBinary();
  if (!binary) return false;
  const probeHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-v2-probe-"));
  try {
    writeFileSync(
      path.join(probeHome, "config.toml"),
      `[features]
${managedMultiAgentV2FeatureLine()}
`,
      { encoding: "utf8", mode: 0o600 },
    );
    const probe = spawnableCommand(binary, ["login", "status"]);
    // `login status` exits non-zero when signed out, so the exit code says
    // nothing about the config; only the load-error message does.
    const result = spawnSync(probe.command, probe.args, {
      ...probe.options,
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
      env: { ...process.env, CODEX_HOME: probeHome },
    });
    if (result.error) return false;
    return !/Error loading configuration/i.test(
      `${result.stdout || ""}\n${result.stderr || ""}`,
    );
  } catch {
    return false;
  } finally {
    rmSync(probeHome, { recursive: true, force: true });
  }
}

// The v2 feature is what makes Codex expose the spawn-agent toolset. Without
// it, `multi_agent_version: "v2"` in the catalog is never surfaced to the
// model. The block is idempotent and leaves an existing user-owned
// multi_agent_v2 setting alone. The line must live inside the existing
// `[features]` table: this Codex build rejects a reopened `[features]` table.
function withManagedMultiAgentV2(input) {
  const cleaned = withoutManagedMultiAgentV2(input);
  if (hasModernMultiAgentConfig(cleaned)) return cleaned;
  if (!installedCodexSupportsMultiAgentV2()) return cleaned;
  const featureLine = managedMultiAgentV2FeatureLine();
  const managedLines = [
    multiAgentV2StartMarker,
    featureLine,
    multiAgentV2EndMarker,
  ];
  const lines = cleaned.split("\n");
  const featuresHeader = lines.findIndex((line) =>
    /^\s*\[features\]\s*(?:#.*)?$/.test(line),
  );
  if (featuresHeader === -1) {
    const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
    const insertionIndex = firstTable === -1 ? lines.length : firstTable;
    lines.splice(insertionIndex, 0, "", "[features]", ...managedLines);
    return `${lines.join("\n").trimEnd()}\n`;
  }
  let tableEnd = featuresHeader + 1;
  while (tableEnd < lines.length && !/^\s*\[/.test(lines[tableEnd])) tableEnd += 1;
  lines.splice(tableEnd, 0, ...managedLines, "");
  return `${lines.join("\n").trimEnd()}\n`;
}

// Some Codex builds reject a managed concurrency scalar and block the whole
// config from loading. Ask the installed binary instead of maintaining a
// version table: have it load a config containing only the root-level scalar
// and see whether it parses. The probe config is minimal on purpose, so the
// answer must not depend on anything else in the user's config.
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
      `max_concurrent_threads_per_session = ${managedAgentMaxConcurrency}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    const probe = spawnableCommand(binary, ["login", "status"]);
    // `login status` exits non-zero when signed out, so the exit code says
    // nothing about the config; only the load-error message does.
    const result = spawnSync(probe.command, probe.args, {
      ...probe.options,
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
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
      /^\s*(?:max_concurrent_threads_per_session|max_threads)\s*=/.test(line),
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
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const insertionIndex = firstTable === -1 ? lines.length : firstTable;
  lines.splice(insertionIndex, 0, ...managedLines, "");
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

function providerTableRanges(contents, providerId) {
  const { lines, headers } = scanTomlDocument(contents);
  const starts = headers.filter(({ path: header }) =>
    header[0] === "model_providers" && header[1] === providerId
  );
  const direct = starts.filter(({ path: header }) => header.length === 2);
  if (direct.length > 1) {
    throw new Error(`Refusing duplicate model provider tables for ${providerId}.`);
  }
  return starts.map(({ index: start }) => {
    const next = headers.find(({ index }) => index > start)?.index;
    return { lines, start, end: next ?? lines.length };
  });
}

function replaceLineRange(contents, range, replacement) {
  const replacementLines = replacement ? replacement.split("\n") : [];
  return [
    ...range.lines.slice(0, range.start),
    ...replacementLines,
    ...range.lines.slice(range.end),
  ].join("\n");
}

function managedSignedProviderBlock(providerId, baseUrl) {
  const headerId = /^[A-Za-z0-9_-]+$/.test(providerId)
    ? providerId
    : JSON.stringify(providerId);
  return [
    signedProviderStartMarker,
    `[model_providers.${headerId}]`,
    'name = "Codex Router (with ChatGPT)"',
    `base_url = ${JSON.stringify(baseUrl)}`,
    'wire_api = "responses"',
    "requires_openai_auth = true",
    // Current Codex builds expose the standalone web-search client tool only
    // when both the provider and the selected model advertise support. Keep
    // the provider half enabled; the catalog's supports_search_tool field is
    // the per-model gate.
    "supports_standalone_web_search = true",
    "supports_websockets = false",
    signedProviderEndMarker,
  ].join("\n");
}

function managedLoginFreeProviderBlock(providerId, baseUrl) {
  const headerId = /^[A-Za-z0-9_-]+$/.test(providerId)
    ? providerId
    : JSON.stringify(providerId);
  return [
    signedProviderStartMarker,
    `[model_providers.${headerId}]`,
    'name = "Codex Router (external models)"',
    `base_url = ${JSON.stringify(baseUrl)}`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "supports_standalone_web_search = true",
    "supports_websockets = false",
    signedProviderEndMarker,
  ].join("\n");
}

// Keep accepting the pre-standalone-search managed block while upgrading it
// in place. Existing signed state must not become user-owned merely because
// this optional Codex capability was added.
function managedSignedProviderBlockLegacy(providerId, baseUrl) {
  const headerId = /^[A-Za-z0-9_-]+$/.test(providerId)
    ? providerId
    : JSON.stringify(providerId);
  return [
    signedProviderStartMarker,
    `[model_providers.${headerId}]`,
    'name = "Codex Router (with ChatGPT)"',
    `base_url = ${JSON.stringify(baseUrl)}`,
    'wire_api = "responses"',
    "requires_openai_auth = true",
    "supports_websockets = false",
    signedProviderEndMarker,
  ].join("\n");
}

function managedLoginFreeProviderBlockLegacy(providerId, baseUrl) {
  const headerId = /^[A-Za-z0-9_-]+$/.test(providerId)
    ? providerId
    : JSON.stringify(providerId);
  return [
    signedProviderStartMarker,
    `[model_providers.${headerId}]`,
    'name = "Codex Router (external models)"',
    `base_url = ${JSON.stringify(baseUrl)}`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "supports_websockets = false",
    signedProviderEndMarker,
  ].join("\n");
}

function managedSignedProviderBlockMatches(actual, providerId, baseUrl) {
  return [
    managedSignedProviderBlock(providerId, baseUrl),
    managedSignedProviderBlockLegacy(providerId, baseUrl),
  ].includes(actual);
}

function managedLoginFreeProviderBlockMatches(actual, providerId, baseUrl) {
  return [
    managedLoginFreeProviderBlock(providerId, baseUrl),
    managedLoginFreeProviderBlockLegacy(providerId, baseUrl),
  ].includes(actual);
}

function signedProviderSlot(state, index) {
  return `${signedProviderSlotPrefix} ${state.ownershipId} ${index}`;
}

function replaceProviderTreeWithManaged(contents, state) {
  const lines = contents.split("\n");
  const ranges = providerTableRanges(contents, state.managedProvider);
  state.previousProviderSections = ranges.map((range) =>
    range.lines.slice(range.start, range.end).join("\n"));
  const blockGenerator = state.loginFree
    ? managedLoginFreeProviderBlock
    : managedSignedProviderBlock;
  const replacements = new Map(
    ranges.map((range, index) => [
      range.start,
      {
        end: range.end,
        text: [
          signedProviderSlot(state, index),
          ...(state.mode === "provider-table" && index === 0
            ? [blockGenerator(state.managedProvider, state.managedBaseUrl)]
            : []),
        ].join("\n"),
      },
    ]),
  );
  const output = [];
  for (let index = 0; index < lines.length;) {
    const replacement = replacements.get(index);
    if (replacement) {
      output.push(replacement.text);
      index = replacement.end;
    } else {
      output.push(lines[index]);
      index += 1;
    }
  }
  let next = output.join("\n");
  if (state.mode === "provider-table" && ranges.length === 0) {
    next = `${next.trimEnd()}\n\n${signedProviderSlot(state, 0)}\n${blockGenerator(
      state.managedProvider,
      state.managedBaseUrl,
    )}\n`;
  }
  return next;
}

function signedManagedRange(contents) {
  const lines = contents.split("\n");
  const starts = lines
    .map((line, index) =>
      line.trim() === signedProviderStartMarker ? index : -1,
    )
    .filter((index) => index !== -1);
  const ends = lines
    .map((line, index) =>
      line.trim() === signedProviderEndMarker ? index : -1,
    )
    .filter((index) => index !== -1);
  if (starts.length !== 1 || ends.length !== 1 || ends[0] < starts[0]) {
    return undefined;
  }
  return { lines, start: starts[0], end: ends[0] + 1 };
}

function signedProviderBlockIsOwned(contents, state) {
  if (state.version === 2) {
    const range = signedManagedRange(contents);
    if (!range) return false;
    const actual = range.lines.slice(range.start, range.end).join("\n");
    return managedSignedProviderBlockMatches(actual, state.managedProvider, state.managedBaseUrl);
  }
  if (state.version !== 3) return false;
  const sections = state.previousProviderSections;
  const expectedSlots = state.mode === "provider-table" ? Math.max(1, sections.length) : sections.length;
  const lines = contents.split("\n");
  const slots = lines.filter((line) => line.startsWith(`${signedProviderSlotPrefix} `));
  if (
    slots.length !== expectedSlots ||
    !Array.from({ length: expectedSlots }, (_, index) => signedProviderSlot(state, index))
      .every((slot) => slots.filter((line) => line === slot).length === 1)
  ) {
    return false;
  }
  const providerRanges = providerTableRanges(contents, state.managedProvider);
  if (state.mode === "root-openai") return providerRanges.length === 0;
  const range = signedManagedRange(contents);
  if (!range) return false;
  const actual = range.lines.slice(range.start, range.end).join("\n");
  const slotIndex = lines.indexOf(signedProviderSlot(state, 0));
  const blockMatches = state.loginFree
    ? managedLoginFreeProviderBlockMatches(actual, state.managedProvider, state.managedBaseUrl)
    : managedSignedProviderBlockMatches(actual, state.managedProvider, state.managedBaseUrl);
  return (
    blockMatches &&
    slotIndex + 1 === range.start &&
    providerRanges.length === 1 &&
    providerRanges[0].start === range.start + 1
  );
}

function restoreSignedProviderTable(contents, state) {
  if (state.version === 2 && state.mode !== "provider-table") return contents;
  if (!signedProviderBlockIsOwned(contents, state)) {
    throw new Error(
      `Signed routing lost ownership of model_providers.${state.managedProvider}; refusing to replace it.`,
    );
  }
  if (state.version === 3) {
    let restored = contents;
    for (let index = state.previousProviderSections.length - 1; index >= 1; index -= 1) {
      restored = restored.replace(
        signedProviderSlot(state, index),
        state.previousProviderSections[index],
      );
    }
    const lines = restored.split("\n");
    const slotIndex = lines.indexOf(signedProviderSlot(state, 0));
    if (state.mode === "root-openai") {
      if (slotIndex !== -1) {
        lines.splice(slotIndex, 1, state.previousProviderSections[0]);
      }
      return lines.join("\n");
    }
    const range = signedManagedRange(restored);
    return replaceLineRange(
      restored,
      { lines: range.lines, start: slotIndex, end: range.end },
      state.previousProviderSections[0] || "",
    );
  }
  const range = signedManagedRange(contents);
  return replaceLineRange(
    contents,
    range,
    state.previousProviderTablePresent ? state.previousProviderTable : "",
  );
}

function managedSignedProviderContents(
  contents,
  managedProvider,
  managedBaseUrl,
  { loginFree = false, ownershipId } = {},
) {
  // Login-free mode routes through the provider identity that is already
  // selected, so the separate codex-router provider generated by
  // enabledContents() is redundant. Use the established marker remover: it
  // hoists foreign tables that the desktop app may have parked inside the
  // managed block instead of deleting them with the provider table.
  const prepared = loginFree
    ? removeMarkerPair(
        contents,
        providerStartMarker,
        providerEndMarker,
        "[model_providers.codex-router]",
      )
    : contents;
  const state = {
    version: 3,
    mode: managedProvider === "openai" ? "root-openai" : "provider-table",
    managedProvider,
    managedBaseUrl,
    ownershipId: ownershipId || randomBytes(16).toString("hex"),
    previousProviderSections: [],
    ...(loginFree ? { loginFree: true } : {}),
  };
  return {
    state,
    contents: replaceProviderTreeWithManaged(prepared, state),
  };
}

function providerModeStateFromManaged(managedState, restoreState) {
  return {
    ...managedState,
    loginFree: true,
    previousModelPresent: restoreState.previousModelPresent,
    ...(restoreState.previousModelPresent
      ? { previousModel: restoreState.previousModel }
      : {}),
  };
}

function switchedProviderModeState(rootLines, restoreState) {
  const previousPresent = rootHasValue(rootLines, "model_provider");
  const previousModelPresent =
    restoreState?.previousModelPresent ?? rootHasValue(rootLines, "model");
  return {
    version: 1,
    previousPresent,
    ...(previousPresent
      ? { previousModelProvider: rootValue(rootLines, "model_provider") }
      : {}),
    previousModelPresent,
    ...(previousModelPresent
      ? { previousModel: restoreState?.previousModel ?? rootValue(rootLines, "model") }
      : {}),
  };
}

function restoreProviderModeModel(contents, state) {
  const { rootLines } = splitRoot(contents);
  const present = rootHasValue(rootLines, "model");
  if (
    present === state.previousModelPresent &&
    (!present || rootValue(rootLines, "model") === state.previousModel)
  ) {
    return contents;
  }
  return `${replaceRootValue(
    contents,
    "model",
    state.previousModelPresent ? state.previousModel : undefined,
  )}\n`;
}

function signedProviderStateIsOwned(contents, state) {
  const { rootLines } = splitRoot(contents);
  const activeProvider = rootValue(rootLines, "model_provider") || "openai";
  if (activeProvider !== state.managedProvider) return false;
  if (state.version === 1) return activeProvider === signedProviderId;
  if (state.mode === "root-openai") {
    return (
      isManagedRouterBaseUrl(rootValue(rootLines, "openai_base_url")) &&
      (state.version !== 3 || signedProviderBlockIsOwned(contents, state))
    );
  }
  return signedProviderBlockIsOwned(contents, state);
}

function readProviderModeState() {
  if (!existsSync(CODEX_PROVIDER_MODE_PATH)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(CODEX_PROVIDER_MODE_PATH, "utf8"));
    const recognizedV1 =
      parsed?.version === 1 &&
      typeof parsed.previousPresent === "boolean" &&
      (!parsed.previousPresent || typeof parsed.previousModelProvider === "string") &&
      typeof parsed.previousModelPresent === "boolean" &&
      (!parsed.previousModelPresent || typeof parsed.previousModel === "string");
    const recognizedV3 =
      parsed?.version === 3 &&
      (parsed.mode === "root-openai" || parsed.mode === "provider-table") &&
      typeof parsed.managedProvider === "string" &&
      parsed.managedProvider.length > 0 &&
      parsed.mode === (parsed.managedProvider === "openai" ? "root-openai" : "provider-table") &&
      typeof parsed.managedBaseUrl === "string" &&
      isManagedRouterBaseUrl(parsed.managedBaseUrl) &&
      typeof parsed.ownershipId === "string" &&
      /^[0-9a-f]{32}$/.test(parsed.ownershipId) &&
      Array.isArray(parsed.previousProviderSections) &&
      parsed.previousProviderSections.every((section) => typeof section === "string") &&
      parsed.loginFree === true &&
      typeof parsed.previousModelPresent === "boolean" &&
      (!parsed.previousModelPresent || typeof parsed.previousModel === "string");
    if (!recognizedV1 && !recognizedV3) {
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

function readSignedProviderModeState() {
  if (!existsSync(SIGNED_PROVIDER_MODE_PATH)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(SIGNED_PROVIDER_MODE_PATH, "utf8"));
    const recognizedV1 =
      parsed?.version === 1 &&
      parsed.managedProvider === signedProviderId &&
      typeof parsed.previousPresent === "boolean" &&
      (!parsed.previousPresent || typeof parsed.previousModelProvider === "string");
    const recognizedV2 =
      parsed?.version === 2 &&
      (parsed.mode === "root-openai" || parsed.mode === "provider-table") &&
      typeof parsed.managedProvider === "string" &&
      parsed.managedProvider.length > 0 &&
      typeof parsed.managedBaseUrl === "string" &&
      isManagedRouterBaseUrl(parsed.managedBaseUrl) &&
      typeof parsed.previousProviderTablePresent === "boolean" &&
      (!parsed.previousProviderTablePresent ||
        typeof parsed.previousProviderTable === "string");
    const recognizedV3 =
      parsed?.version === 3 &&
      (parsed.mode === "root-openai" || parsed.mode === "provider-table") &&
      typeof parsed.managedProvider === "string" &&
      parsed.managedProvider.length > 0 &&
      typeof parsed.managedBaseUrl === "string" &&
      isManagedRouterBaseUrl(parsed.managedBaseUrl) &&
      typeof parsed.ownershipId === "string" &&
      /^[0-9a-f]{32}$/.test(parsed.ownershipId) &&
      Array.isArray(parsed.previousProviderSections) &&
      parsed.previousProviderSections.every((section) => typeof section === "string");
    if (!recognizedV1 && !recognizedV2 && !recognizedV3) throw new Error("invalid state");
    return parsed;
  } catch {
    throw new Error(`Invalid signed router provider state at ${SIGNED_PROVIDER_MODE_PATH}.`);
  }
}

function writeSignedProviderModeState(value) {
  mkdirSync(path.dirname(SIGNED_PROVIDER_MODE_PATH), { recursive: true, mode: 0o700 });
  const temporary = `${SIGNED_PROVIDER_MODE_PATH}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    protectPrivateFile(temporary);
    renameSync(temporary, SIGNED_PROVIDER_MODE_PATH);
    protectPrivateFile(SIGNED_PROVIDER_MODE_PATH);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

function clearSignedProviderModeState() {
  if (existsSync(SIGNED_PROVIDER_MODE_PATH)) unlinkSync(SIGNED_PROVIDER_MODE_PATH);
}

function hasUnmanagedRouterProvider(contents) {
  const withoutManagedBlock = removeMarkedBlock(contents);
  return new RegExp(
    `^\\s*\\[model_providers\\.(?:${routerProviderId}|${signedProviderId}|["'](?:${routerProviderId}|${signedProviderId})["'])\\]\\s*$`,
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
  const managedStart = lines.findIndex((line) => line.trim() === providerStartMarker);
  const managedEnd = lines.findIndex((line) => line.trim() === providerEndMarker);
  if (managedStart !== -1 && managedStart < start && managedEnd > start) {
    return undefined;
  }
  let end = start + 1;
  while (
    end < lines.length &&
    !/^\s*\[/.test(lines[end]) &&
    !markerPairs.some(([marker]) => lines[end].trim() === marker)
  ) {
    end += 1;
  }
  const fields = new Map();
  for (const line of lines.slice(start + 1, end)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
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
    (fields.size === 3 ||
      (fields.size === 4 && fields.get("supports_standalone_web_search") === "true")) &&
    fields.get("name") === "Codex Router (external models)";
  const prototypeShape =
    (fields.size === 4 ||
      (fields.size === 5 && fields.get("supports_standalone_web_search") === "true")) &&
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
  const withoutBlock = removeEmptyFeaturesTable(
    removeCreatedAgentsTableIfEmpty(removeMarkedBlock(contents)),
  );
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

function providerModeStateIsOwned(contents, state) {
  if (!state) return false;
  if (state.version === 1) {
    const { rootLines } = splitRoot(contents);
    return rootValue(rootLines, "model_provider") === routerProviderId;
  }
  if (state.version === 3) {
    return signedProviderStateIsOwned(contents, state);
  }
  return false;
}

function providerModeRestoreSourceIsOwned(contents, state) {
  if (!state) return false;
  const { rootLines } = splitRoot(contents);
  const providerPresent = rootHasValue(rootLines, "model_provider");
  const modelPresent = rootHasValue(rootLines, "model");
  if (state.version === 1) {
    return (
      providerPresent === state.previousPresent &&
      (!providerPresent || rootValue(rootLines, "model_provider") === state.previousModelProvider) &&
      modelPresent === state.previousModelPresent &&
      (!modelPresent || rootValue(rootLines, "model") === state.previousModel)
    );
  }
  if (state.version !== 3) return false;
  const activeProvider = rootValue(rootLines, "model_provider") || "openai";
  if (
    activeProvider !== state.managedProvider ||
    modelPresent !== state.previousModelPresent ||
    (modelPresent && rootValue(rootLines, "model") !== state.previousModel)
  ) {
    return false;
  }
  const actualSections = providerTableRanges(contents, state.managedProvider).map((range) =>
    range.lines.slice(range.start, range.end).join("\n").trimEnd()
  );
  return (
    actualSections.length === state.previousProviderSections.length &&
    actualSections.every(
      (section, index) => section === state.previousProviderSections[index].trimEnd(),
    )
  );
}

function snapshot(contents) {
  const { rootLines } = splitRoot(contents);
  const baseUrl = rootValue(rootLines, "openai_base_url");
  const catalog = rootValue(rootLines, "model_catalog_json");
  const activeProvider = rootValue(rootLines, "model_provider") || "openai";
  const signedState = readSignedProviderModeState();
  const signedActive = signedState
    ? signedProviderStateIsOwned(contents, signedState)
    : false;
  const providerModeState = readProviderModeState();
  if (signedState && providerModeState) {
    throw new Error(
      "Invalid Codex routing state: signed routing and login-free mode are both recorded.",
    );
  }
  const loginFreeActive = providerModeState
    ? providerModeStateIsOwned(contents, providerModeState)
    : false;
  const routerDefault = readCodexRouterDefault();
  return {
    mode:
      isManagedRouterBaseUrl(baseUrl) && catalog === MERGED_CATALOG_PATH
        ? "router"
        : "native",
    model: rootValue(rootLines, "model") || null,
    model_provider: activeProvider,
    login_free: Boolean(loginFreeActive),
    login_free_managed: Boolean(
      loginFreeActive && privateFileIsProtected(CODEX_PROVIDER_MODE_PATH),
    ),
    provider_mode_state_present: existsSync(CODEX_PROVIDER_MODE_PATH),
    signed_routing: Boolean(signedActive),
    signed_routing_managed: Boolean(
      signedActive && privateFileIsProtected(SIGNED_PROVIDER_MODE_PATH),
    ),
    signed_provider_state_present: existsSync(SIGNED_PROVIDER_MODE_PATH),
    router_default_model: routerDefault?.model || null,
    router_default_managed: Boolean(routerDefault),
    openai_base_url: baseUrl ? redactCallerUrl(baseUrl) : null,
    model_catalog_json: catalog || null,
    config_protected: privateFileIsProtected(CONFIG_PATH),
  };
}

function applyRouterDefault(contents, state = readCodexRouterDefault()) {
  return state ? `${replaceRootValue(contents, "model", state.model)}\n` : contents;
}

// Restore only when the router still owns the exact value it installed. A
// manual Codex edit wins over a later clear/disable rather than being erased.
function restoreRouterDefault(contents, state = readCodexRouterDefault()) {
  if (!state) return contents;
  const { rootLines } = splitRoot(contents);
  if (rootValue(rootLines, "model") !== state.model) return contents;
  return `${replaceRootValue(
    contents,
    "model",
    state.previousPresent ? state.previousModel : undefined,
  )}\n`;
}

function enabledContents(contents) {
  const { rootLines: currentRoot } = splitRoot(contents);
  const currentProvider = rootValue(currentRoot, "model_provider");
  const preparedSource = adoptNativeCatalog
    ? readNativeCatalogSource()
    : undefined;
  if (
    preparedSource?.status === "pending" &&
    catalogPathsEqual(
      rootValue(currentRoot, "model_catalog_json"),
      MERGED_CATALOG_PATH,
    )
  ) {
    nativeCatalogNeedsActivation = true;
  }
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
  let rootLines = trimBlankEdges(cleaned.rootLines);
  const existingBase = rootValue(rootLines, "openai_base_url");
  const existingCatalog = rootValue(rootLines, "model_catalog_json");
  if (existingBase && existingBase !== routerBaseUrl) {
    throw new Error(
      `Refusing to replace user-owned openai_base_url: ${redactCallerUrl(existingBase)}`,
    );
  }
  if (existingCatalog && existingCatalog !== MERGED_CATALOG_PATH) {
    if (
      !adoptNativeCatalog ||
      !preparedSource ||
      !catalogPathsEqual(preparedSource.path, existingCatalog)
    ) {
      throw new Error(`Refusing to replace user-owned model_catalog_json: ${existingCatalog}`);
    }
    rootLines = rootLines.filter(
      (line) => !/^\s*model_catalog_json\s*=/.test(line),
    );
    nativeCatalogNeedsActivation = preparedSource.status === "pending";
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
    `model_catalog_json = ${tomlValue(MERGED_CATALOG_PATH)}`,
    ...managedRealtimeOverrides,
    endMarker,
  );
  const tableLines = trimBlankEdges(cleaned.tableLines);
  const next = [
    ...trimBlankEdges(rootLines),
    "",
    ...tableLines,
    ...(tableLines.length ? [""] : []),
  ];
  const providerBlock = [
    providerStartMarker,
    `[model_providers.${routerProviderId}]`,
    'name = "Codex Router (external models)"',
    `base_url = ${JSON.stringify(routerBaseUrl)}`,
    'wire_api = "responses"',
    // Provider support is necessary but not sufficient: Codex also reads the
    // selected catalog model's supports_search_tool value before exposing the
    // standalone web-search client tool.
    "supports_standalone_web_search = true",
    providerEndMarker,
  ];
  return withManagedAgentConcurrency(
    `${withManagedMultiAgentV2(`${next.join("\n").trimEnd()}\n`).trimEnd()}\n\n${providerBlock.join("\n")}\n`,
  );
}

function restoreNativeCatalog(contents) {
  const source = readNativeCatalogSource();
  if (!source) return undefined;
  const cleaned = clean(contents);
  const existing = rootValue(cleaned.rootLines, "model_catalog_json");
  if (
    existing &&
    existing !== MERGED_CATALOG_PATH &&
    !catalogPathsEqual(existing, source.path)
  ) {
    throw new Error(`Refusing to replace user-owned model_catalog_json: ${existing}`);
  }
  const rootLines = cleaned.rootLines.filter(
    (line) => !/^\s*model_catalog_json\s*=/.test(line),
  );
  rootLines.push(`model_catalog_json = ${tomlValue(source.path)}`);
  return `${[
    ...trimBlankEdges(rootLines),
    "",
    ...trimBlankEdges(cleaned.tableLines),
  ].join("\n").trimEnd()}\n`;
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

if (!new Set([
  "enable",
  "disable",
  "status",
  "login-free-enable",
  "login-free-disable",
  "signed-enable",
  "signed-disable",
  "router-default-set",
  "router-default-clear",
]).has(command)) {
  console.error(
    "Usage: config-manager.mjs enable|disable|status|login-free-enable|login-free-disable|signed-enable|signed-disable|router-default-set MODEL|router-default-clear [--adopt-native-catalog]",
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
let clearNativeCatalogSourceAfterWrite = false;
let activateNativeCatalogSourceAfterWrite = false;
let pendingSignedProviderModeState;
let pendingRouterDefaultState;
let clearRouterDefaultState = false;
if (command === "enable") {
  const signedState = readSignedProviderModeState();
  const providerState = readProviderModeState();
  if (signedState && providerState) {
    throw new Error(
      "Signed routing and login-free provider state cannot both be active; turn one off before updating the router.",
    );
  }
  if (signedState?.version === 1) {
    throw new Error(
      "A recognized older signed-routing mode is still active; turn it off before updating the router.",
    );
  } else if (signedState) {
    if (!signedProviderStateIsOwned(current, signedState)) {
      throw new Error(
        `Signed routing lost ownership while model_provider is ${
          rootValue(splitRoot(current).rootLines, "model_provider") || "openai"
        }; refusing to update it.`,
      );
    }
    const restored = restoreSignedProviderTable(current, signedState);
    const enabled = enabledContents(restored);
    const refreshed = managedSignedProviderContents(
      enabled,
      signedState.managedProvider,
      configuredRouterBaseUrl(),
      { ownershipId: signedState.ownershipId },
    );
    next = refreshed.contents;
    pendingSignedProviderModeState = refreshed.state;
  } else if (providerState?.version === 1) {
    if (!providerModeStateIsOwned(current, providerState)) {
      throw new Error(
        "Login-free mode lost ownership of model_provider codex-router; refusing to update it.",
      );
    }
    // Keep the v1 state intact so login-free-disable can still restore the
    // provider and model captured by the older router.
    next = enabledContents(current);
  } else if (providerState) {
    if (!providerModeStateIsOwned(current, providerState)) {
      throw new Error(
        `Login-free mode lost ownership while model_provider is ${
          rootValue(splitRoot(current).rootLines, "model_provider") || "openai"
        }; refusing to update it.`,
      );
    }
    const restored = restoreSignedProviderTable(current, providerState);
    const enabled = enabledContents(restored);
    if (providerState.mode === "root-openai") {
      // Current Codex Desktop builds reserve the built-in `openai` provider id,
      // so an explicit auth-free [model_providers.openai] table makes the whole
      // config invalid. Migrate the draft root-openai state back to the proven
      // codex-router provider switch while retaining its original model restore.
      pendingProviderModeState = switchedProviderModeState(
        splitRoot(current).rootLines,
        providerState,
      );
      next = `${replaceRootValue(enabled, "model_provider", routerProviderId)}\n`;
    } else {
      const refreshed = managedSignedProviderContents(
        enabled,
        providerState.managedProvider,
        configuredRouterBaseUrl(),
        { loginFree: true, ownershipId: providerState.ownershipId },
      );
      next = refreshed.contents;
      pendingProviderModeState = providerModeStateFromManaged(
        refreshed.state,
        providerState,
      );
    }
  } else {
    next = enabledContents(current);
  }
  next = applyRouterDefault(next);
  activateNativeCatalogSourceAfterWrite = nativeCatalogNeedsActivation;
} else if (command === "router-default-set") {
  const model = String(process.argv[3] || "").trim();
  if (!model) throw new Error("Usage: config-manager.mjs router-default-set MODEL");
  const currentSnapshot = snapshot(current);
  if (currentSnapshot.login_free) {
    throw new Error("The router default is for signed-in Codex; login-free mode already owns its default.");
  }
  if (currentSnapshot.mode !== "router") {
    throw new Error("Enable Codex Router before setting a router default model.");
  }
  const existing = readCodexRouterDefault();
  const { rootLines } = splitRoot(current);
  const previousPresent = existing?.previousPresent ?? rootHasValue(rootLines, "model");
  pendingRouterDefaultState = {
    version: 1,
    model,
    previousPresent,
    ...(previousPresent
      ? { previousModel: existing?.previousModel ?? rootValue(rootLines, "model") }
      : {}),
  };
  next = applyRouterDefault(current, pendingRouterDefaultState);
} else if (command === "router-default-clear") {
  next = restoreRouterDefault(current);
  clearRouterDefaultState = Boolean(readCodexRouterDefault());
} else if (command === "login-free-enable") {
  if (existsSync(SIGNED_PROVIDER_MODE_PATH)) {
    throw new Error("Turn off signed routing before enabling login-free mode.");
  }
  const defaultRestored = restoreRouterDefault(current);
  clearRouterDefaultState = Boolean(readCodexRouterDefault());
  const { rootLines } = splitRoot(defaultRestored);
  const currentProvider = rootValue(rootLines, "model_provider") || "openai";
  const loginFreeModel = String(process.argv[3] || "").trim();
  const withLoginFreeModel = (contents) => {
    if (!loginFreeModel) return contents;
    if (rootValue(splitRoot(contents).rootLines, "model") === loginFreeModel) {
      return contents;
    }
    return `${replaceRootValue(contents, "model", loginFreeModel)}\n`;
  };
  const restoreDisabledLoginFree = process.argv.includes("--restore-disabled-login-free");
  const state = readProviderModeState();
  if (state?.version === 1) {
    const active = providerModeStateIsOwned(current, state);
    if (
      !active &&
      !(restoreDisabledLoginFree && providerModeRestoreSourceIsOwned(defaultRestored, state))
    ) {
      throw new Error(
        "Login-free mode lost ownership of model_provider codex-router; refusing to update it.",
      );
    }
    // A v1 install already selected codex-router. Refresh it without changing
    // the old restore record; disabling remains able to put both original
    // root assignments back exactly.
    next = enabledContents(withLoginFreeModel(defaultRestored));
    if (!active) next = `${replaceRootValue(next, "model_provider", routerProviderId)}\n`;
  } else if (state) {
    const active = providerModeStateIsOwned(current, state);
    if (
      !active &&
      !(restoreDisabledLoginFree && providerModeRestoreSourceIsOwned(defaultRestored, state))
    ) {
      throw new Error(
        `Login-free mode lost ownership while model_provider is ${currentProvider}; refusing to update it.`,
      );
    }
    const restored = active
      ? restoreSignedProviderTable(defaultRestored, state)
      : defaultRestored;
    const enabled = enabledContents(withLoginFreeModel(restored));
    if (state.mode === "root-openai") {
      pendingProviderModeState = switchedProviderModeState(rootLines, state);
      next = `${replaceRootValue(enabled, "model_provider", routerProviderId)}\n`;
    } else {
      const refreshed = managedSignedProviderContents(
        enabled,
        state.managedProvider,
        configuredRouterBaseUrl(),
        { loginFree: true, ownershipId: state.ownershipId },
      );
      next = refreshed.contents;
      pendingProviderModeState = providerModeStateFromManaged(refreshed.state, state);
    }
  } else {
    const enabled = enabledContents(withLoginFreeModel(defaultRestored));
    if (currentProvider === "openai") {
      pendingProviderModeState = switchedProviderModeState(rootLines);
      next = `${replaceRootValue(enabled, "model_provider", routerProviderId)}\n`;
    } else {
      const managed = managedSignedProviderContents(
        enabled,
        currentProvider,
        configuredRouterBaseUrl(),
        { loginFree: true },
      );
      pendingProviderModeState = providerModeStateFromManaged(managed.state, {
        previousModelPresent: rootHasValue(rootLines, "model"),
        ...(rootHasValue(rootLines, "model")
          ? { previousModel: rootValue(rootLines, "model") }
          : {}),
      });
      next = managed.contents;
    }
  }
} else if (command === "signed-enable") {
  if (existsSync(CODEX_PROVIDER_MODE_PATH)) {
    throw new Error("Turn off login-free mode before enabling signed routing.");
  }
  const { rootLines } = splitRoot(current);
  const currentProvider = rootValue(rootLines, "model_provider") || "openai";
  const state = readSignedProviderModeState();
  if (state?.version === 1) {
    throw new Error(
      "A recognized older signed-routing mode is still active; turn it off before enabling the task-preserving mode.",
    );
  } else if (state) {
    if (!signedProviderStateIsOwned(current, state)) {
      throw new Error(
        `Signed routing lost ownership while model_provider is ${currentProvider}; turn it off before enabling it again.`,
      );
    }
    if (state.version === 2) {
      const restored = restoreSignedProviderTable(current, state);
      const enabled = enabledContents(restored);
      const upgraded = managedSignedProviderContents(
        enabled,
        state.managedProvider,
        configuredRouterBaseUrl(),
        { ownershipId: state.ownershipId },
      );
      next = upgraded.contents;
      pendingSignedProviderModeState = upgraded.state;
    } else {
      next = current;
    }
  } else {
    const enabled = enabledContents(current);
    const routerBaseUrl = configuredRouterBaseUrl();
    const managed = managedSignedProviderContents(enabled, currentProvider, routerBaseUrl);
    pendingSignedProviderModeState = managed.state;
    next = managed.contents;
  }
  next = applyRouterDefault(next);
} else {
  const state = readProviderModeState();
  const signedState = readSignedProviderModeState();
  const { rootLines } = splitRoot(current);
  const currentProvider = rootValue(rootLines, "model_provider");
  let restored = current;
  if (command === "signed-disable") {
    if (!signedState) {
      if (currentProvider === signedProviderId) {
        throw new Error("Signed routing is not managed by this router.");
      }
    } else if (signedState.version === 1 && currentProvider !== signedProviderId) {
      const previous = signedState.previousPresent
        ? signedState.previousModelProvider
        : undefined;
      if (currentProvider !== previous) {
        throw new Error(
          `Refusing to replace user-owned model_provider: ${currentProvider || "unset"}.`,
        );
      }
    } else if (signedState.version === 1) {
      restored = `${replaceRootValue(
        current,
        "model_provider",
        signedState.previousPresent ? signedState.previousModelProvider : undefined,
      )}\n`;
    } else {
      const effectiveProvider = currentProvider || "openai";
      if (effectiveProvider !== signedState.managedProvider) {
        throw new Error(
          `Signed routing lost ownership to model_provider ${effectiveProvider}; refusing to replace it.`,
        );
      }
      restored = restoreSignedProviderTable(current, signedState);
    }
  } else if (state) {
    if (state.version === 1) {
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
      restored = restoreProviderModeModel(restored, state);
    } else if (state.version === 3) {
      const effectiveProvider = currentProvider || "openai";
      if (!providerModeStateIsOwned(current, state)) {
        throw new Error(
          `Login-free mode lost ownership to model_provider ${effectiveProvider}; refusing to replace it.`,
        );
      }
      restored = restoreSignedProviderTable(current, state);
      restored = restoreProviderModeModel(restored, state);
    }
  } else if (command === "login-free-disable" && currentProvider === routerProviderId) {
    throw new Error("Codex login-free mode is not managed by this router.");
  }
  if (command === "login-free-disable") {
    // Login-free mode removes the ordinary inert codex-router provider block
    // while it temporarily owns the selected provider table. Rebuild the
    // enabled router document after restoring that table so turning the mode
    // off returns to the exact pre-toggle routing surface instead of leaving
    // the standard provider definition missing.
    next = enabledContents(restored);
  } else if (command === "signed-disable") {
    next = restored;
  } else {
    if (signedState?.version === 1) {
      const restoredRoot = splitRoot(restored).rootLines;
      const restoredProvider = rootValue(restoredRoot, "model_provider");
      if (restoredProvider !== signedProviderId) {
        throw new Error(
          `Refusing to replace user-owned model_provider: ${restoredProvider || "unset"}.`,
        );
      }
      restored = `${replaceRootValue(
        restored,
        "model_provider",
        signedState.previousPresent ? signedState.previousModelProvider : undefined,
      )}\n`;
    } else if (signedState?.version === 2 || signedState?.version === 3) {
      const restoredRoot = splitRoot(restored).rootLines;
      const restoredProvider = rootValue(restoredRoot, "model_provider") || "openai";
      if (restoredProvider !== signedState.managedProvider) {
        throw new Error(
          `Signed routing lost ownership to model_provider ${restoredProvider}; refusing to replace it.`,
        );
      }
      restored = restoreSignedProviderTable(restored, signedState);
    }
    const nativeCatalogContents = restoreNativeCatalog(restored);
    if (nativeCatalogContents) {
      next = nativeCatalogContents;
      clearNativeCatalogSourceAfterWrite = true;
    } else {
      const cleaned = clean(restored);
      next = `${[
        ...trimBlankEdges(cleaned.rootLines),
        "",
        ...trimBlankEdges(cleaned.tableLines),
      ].join("\n").trimEnd()}\n`;
    }
  }
  if (["disable", "login-free-disable", "signed-disable"].includes(command)) {
    next = restoreRouterDefault(next);
    clearRouterDefaultState = Boolean(readCodexRouterDefault());
  }
}
if (existsSync(CONFIG_PATH) && !existsSync(BACKUP_PATH)) {
  copyFileSync(CONFIG_PATH, BACKUP_PATH);
}
if (existsSync(BACKUP_PATH)) protectPrivateFile(BACKUP_PATH);
const previousProviderModeState = pendingProviderModeState
  ? readProviderModeState()
  : undefined;
const previousSignedProviderModeState = pendingSignedProviderModeState
  ? readSignedProviderModeState()
  : undefined;
const previousRouterDefaultState = pendingRouterDefaultState
  ? readCodexRouterDefault()
  : undefined;
if (pendingProviderModeState) writeProviderModeState(pendingProviderModeState);
if (pendingSignedProviderModeState) writeSignedProviderModeState(pendingSignedProviderModeState);
if (pendingRouterDefaultState) writeCodexRouterDefault(pendingRouterDefaultState);
try {
  atomicWrite(next);
  if (activateNativeCatalogSourceAfterWrite) activateNativeCatalogSource();
} catch (error) {
  if (pendingProviderModeState) {
    if (previousProviderModeState) {
      writeProviderModeState(previousProviderModeState);
    } else {
      clearProviderModeState();
    }
  }
  if (pendingSignedProviderModeState) {
    if (previousSignedProviderModeState) {
      writeSignedProviderModeState(previousSignedProviderModeState);
    } else {
      clearSignedProviderModeState();
    }
  }
  if (pendingRouterDefaultState) {
    if (previousRouterDefaultState) {
      writeCodexRouterDefault(previousRouterDefaultState);
    } else {
      clearCodexRouterDefault();
    }
  }
  if (activateNativeCatalogSourceAfterWrite) {
    try {
      atomicWrite(current);
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        "Codex config update failed and its original contents could not be restored.",
      );
    }
  }
  throw error;
}
if (
  command === "login-free-disable" ||
  (command === "disable" && !process.argv.includes("--preserve-login-free-state"))
) {
  clearProviderModeState();
}
if (clearNativeCatalogSourceAfterWrite) clearNativeCatalogSource();
if (command === "disable" || command === "signed-disable") clearSignedProviderModeState();
if (clearRouterDefaultState) clearCodexRouterDefault();
process.stdout.write(`${JSON.stringify(snapshot(next))}\n`);
