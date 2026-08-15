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
    // Codex 0.146+ performs standalone web search on the client and sends
    // the resulting items back through the selected custom provider. Keep
    // this opt-in on the managed provider table; older Codex versions ignore
    // the unknown field and retain their existing behavior.
    "supports_standalone_web_search = true",
    "supports_websockets = false",
    signedProviderEndMarker,
  ].join("\n");
}

// Keep accepting the pre-standalone-search managed block while upgrading it
// in place. Existing signed state must not become "user-owned" merely because
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

function managedSignedProviderBlockMatches(actual, providerId, baseUrl) {
  return [
    managedSignedProviderBlock(providerId, baseUrl),
    managedSignedProviderBlockLegacy(providerId, baseUrl),
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
  const replacements = new Map(
    ranges.map((range, index) => [
      range.start,
      {
        end: range.end,
        text: [
          signedProviderSlot(state, index),
          ...(state.mode === "provider-table" && index === 0
            ? [managedSignedProviderBlock(state.managedProvider, state.managedBaseUrl)]
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
    next = `${next.trimEnd()}\n\n${signedProviderSlot(state, 0)}\n${managedSignedProviderBlock(
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
  return (
    managedSignedProviderBlockMatches(actual, state.managedProvider, state.managedBaseUrl) &&
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

function managedSignedProviderContents(contents, managedProvider, managedBaseUrl) {
  const state = {
    version: 3,
    mode: managedProvider === "openai" ? "root-openai" : "provider-table",
    managedProvider,
    managedBaseUrl,
    ownershipId: randomBytes(16).toString("hex"),
    previousProviderSections: [],
  };
  return {
    state,
    contents: replaceProviderTreeWithManaged(contents, state),
  };
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

function snapshot(contents) {
  const { rootLines } = splitRoot(contents);
  const baseUrl = rootValue(rootLines, "openai_base_url");
  const catalog = rootValue(rootLines, "model_catalog_json");
  const activeProvider = rootValue(rootLines, "model_provider") || "openai";
  const signedState = readSignedProviderModeState();
  const signedActive = signedState
    ? signedProviderStateIsOwned(contents, signedState)
    : false;
  return {
    mode:
      isManagedRouterBaseUrl(baseUrl) && catalog === MERGED_CATALOG_PATH
        ? "router"
        : "native",
    model: rootValue(rootLines, "model") || null,
    model_provider: activeProvider,
    login_free: rootValue(rootLines, "model_provider") === routerProviderId,
    login_free_managed:
      rootValue(rootLines, "model_provider") === routerProviderId &&
      existsSync(CODEX_PROVIDER_MODE_PATH),
    provider_mode_state_present: existsSync(CODEX_PROVIDER_MODE_PATH),
    signed_routing: Boolean(signedActive),
    signed_routing_managed: Boolean(
      signedActive && privateFileIsProtected(SIGNED_PROVIDER_MODE_PATH),
    ),
    signed_provider_state_present: existsSync(SIGNED_PROVIDER_MODE_PATH),
    openai_base_url: baseUrl ? redactCallerUrl(baseUrl) : null,
    model_catalog_json: catalog || null,
    config_protected: privateFileIsProtected(CONFIG_PATH),
  };
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
]).has(command)) {
  console.error(
    "Usage: config-manager.mjs enable|disable|status|login-free-enable|login-free-disable|signed-enable|signed-disable [--adopt-native-catalog]",
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
if (command === "enable") {
  const signedState = readSignedProviderModeState();
  if (signedState?.version === 1) {
    throw new Error(
      "A recognized older signed-routing mode is still active; turn it off before updating the router.",
    );
  }
  if (signedState) {
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
    );
    next = refreshed.contents;
    pendingSignedProviderModeState = refreshed.state;
  } else {
    next = enabledContents(current);
  }
  activateNativeCatalogSourceAfterWrite = nativeCatalogNeedsActivation;
} else if (command === "login-free-enable") {
  if (existsSync(SIGNED_PROVIDER_MODE_PATH)) {
    throw new Error("Turn off signed routing before enabling login-free mode.");
  }
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
  if (command === "login-free-disable" || command === "signed-disable") {
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
}
if (existsSync(CONFIG_PATH) && !existsSync(BACKUP_PATH)) {
  copyFileSync(CONFIG_PATH, BACKUP_PATH);
}
if (existsSync(BACKUP_PATH)) protectPrivateFile(BACKUP_PATH);
const previousSignedProviderModeState = pendingSignedProviderModeState
  ? readSignedProviderModeState()
  : undefined;
if (pendingProviderModeState) writeProviderModeState(pendingProviderModeState);
if (pendingSignedProviderModeState) writeSignedProviderModeState(pendingSignedProviderModeState);
try {
  atomicWrite(next);
  if (activateNativeCatalogSourceAfterWrite) activateNativeCatalogSource();
} catch (error) {
  if (pendingProviderModeState) clearProviderModeState();
  if (pendingSignedProviderModeState) {
    if (previousSignedProviderModeState) {
      writeSignedProviderModeState(previousSignedProviderModeState);
    } else {
      clearSignedProviderModeState();
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
if (command === "disable" || command === "login-free-disable") clearProviderModeState();
if (clearNativeCatalogSourceAfterWrite) clearNativeCatalogSource();
if (command === "disable" || command === "signed-disable") clearSignedProviderModeState();
process.stdout.write(`${JSON.stringify(snapshot(next))}\n`);
