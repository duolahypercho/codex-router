import {
  assertCallerSecret,
  isManagedCallerBaseUrl,
  isManagedCodexBaseUrl,
  isManagedGeminiBaseUrl,
} from "./caller-auth.mjs";
import { DSH_CREDENTIAL_REF, DSH_ROUTE_ID } from "./dsh-catalog.mjs";
import { geminiManagedBlockPresent, spliceGeminiEnvBlock } from "./gemini-env.mjs";
import { scanYamlDocument, yamlNode } from "./yaml-structure.mjs";

const CODEX_PROVIDER_BEGIN = "# BEGIN codex-router-provider-managed";
const CODEX_PROVIDER_END = "# END codex-router-provider-managed";
const CODEX_SIGNED_BEGIN = "# BEGIN codex-router-signed-provider-managed";
const CODEX_SIGNED_END = "# END codex-router-signed-provider-managed";

function decodeScalar(raw) {
  const token = String(raw ?? "").trim();
  if (token.startsWith('"') && token.endsWith('"')) {
    try { return JSON.parse(token); } catch { return undefined; }
  }
  if (token.startsWith("'") && token.endsWith("'")) return token.slice(1, -1).replaceAll("''", "'");
  return token.split(/\s+#/, 1)[0].trim();
}

function escapedPattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceAssignmentLine(line, key, value, separator = "=") {
  const escaped = escapedPattern(key);
  const operator = separator === ":" ? ":" : "=";
  const pattern = new RegExp(`^(\\s*${escaped}\\s*${operator}\\s*)("(?:\\\\.|[^"\\\\])*"|'[^']*'|[^#\\s]+)(\\s*(?:#.*)?)$`);
  const match = line.match(pattern);
  if (!match) throw new Error(`Managed ${key} assignment is not a supported scalar.`);
  return `${match[1]}${JSON.stringify(value)}${match[3]}`;
}

function assignmentValue(line, key, separator = "=") {
  const escaped = escapedPattern(key);
  const operator = separator === ":" ? ":" : "=";
  const match = line.match(new RegExp(`^\\s*${escaped}\\s*${operator}\\s*(.+?)\\s*$`));
  return match ? decodeScalar(match[1]) : undefined;
}

function managedCodexBase(value, port, legacyPort) {
  return isManagedCodexBaseUrl(value, port) ||
    (legacyPort !== undefined && isManagedCodexBaseUrl(value, legacyPort));
}

function managedCallerBase(value, port, legacyPort) {
  return isManagedCallerBaseUrl(value, port) ||
    (legacyPort !== undefined && isManagedCallerBaseUrl(value, legacyPort));
}

function replaceRootCallerBase(contents, nextBase, port, legacyPort) {
  const lines = contents.split("\n");
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const end = firstTable === -1 ? lines.length : firstTable;
  const matches = [];
  for (let index = 0; index < end; index += 1) {
    if (/^\s*openai_base_url\s*=/.test(lines[index])) matches.push(index);
  }
  if (matches.length !== 1) {
    throw new Error("Codex caller capability refresh requires exactly one managed openai_base_url.");
  }
  const oldBase = assignmentValue(lines[matches[0]], "openai_base_url");
  if (!managedCodexBase(oldBase, port, legacyPort)) {
    throw new Error("Codex openai_base_url is not a managed router URL.");
  }
  lines[matches[0]] = replaceAssignmentLine(lines[matches[0]], "openai_base_url", nextBase);
  return lines.join("\n");
}

function replaceMarkedBase(contents, begin, end, nextBase, port, legacyPort) {
  const lines = contents.split("\n");
  const starts = lines.flatMap((line, index) => line.trim() === begin ? [index] : []);
  const ends = lines.flatMap((line, index) => line.trim() === end ? [index] : []);
  if (!starts.length && !ends.length) return contents;
  if (starts.length !== 1 || ends.length !== 1 || ends[0] <= starts[0]) {
    throw new Error(`Managed caller capability block ${begin} is ambiguous.`);
  }
  const matches = [];
  for (let index = starts[0] + 1; index < ends[0]; index += 1) {
    if (/^\s*base_url\s*=/.test(lines[index])) matches.push(index);
  }
  if (matches.length !== 1) {
    throw new Error(`Managed caller capability block ${begin} has no unique base_url.`);
  }
  const oldBase = assignmentValue(lines[matches[0]], "base_url");
  if (!managedCodexBase(oldBase, port, legacyPort)) {
    throw new Error(`Managed Codex block ${begin} has an unmanaged base_url.`);
  }
  lines[matches[0]] = replaceAssignmentLine(lines[matches[0]], "base_url", nextBase);
  return lines.join("\n");
}

export function refreshCodexCallerCapabilityContents(contents, nextBase, { port, legacyPort } = {}) {
  if (!isManagedCodexBaseUrl(nextBase, port)) {
    throw new Error("Refusing an invalid Codex router URL.");
  }
  let next = replaceRootCallerBase(String(contents ?? ""), nextBase, port, legacyPort);
  next = replaceMarkedBase(next, CODEX_PROVIDER_BEGIN, CODEX_PROVIDER_END, nextBase, port, legacyPort);
  next = replaceMarkedBase(next, CODEX_SIGNED_BEGIN, CODEX_SIGNED_END, nextBase, port, legacyPort);
  return next;
}

export function refreshCodexCallerCapabilityState(state, nextBase, { port, legacyPort } = {}) {
  if (!state || typeof state !== "object") return state;
  if (!("managedBaseUrl" in state)) return { ...state };
  if (!managedCodexBase(state.managedBaseUrl, port, legacyPort) || !isManagedCodexBaseUrl(nextBase, port)) {
    throw new Error("Codex managed provider state contains an invalid router URL.");
  }
  return { ...state, managedBaseUrl: nextBase };
}

function refreshDshSettings(settings, nextBase, port, legacyPort) {
  const document = scanYamlDocument(settings);
  const node = yamlNode(document, ["llm-pi-ai", "providers", DSH_ROUTE_ID, "baseURL"]);
  if (!node) throw new Error("DeepSeek Harness managed route has no baseURL.");
  const oldBase = assignmentValue(document.lines[node.index], "baseURL", ":");
  if (!managedCallerBase(oldBase, port, legacyPort)) {
    throw new Error("DeepSeek Harness route baseURL is not a managed caller capability.");
  }
  const lines = [...document.lines];
  lines[node.index] = replaceAssignmentLine(lines[node.index], "baseURL", nextBase, ":");
  return lines.join("\n");
}

function refreshDshCredentials(credentials, secret) {
  // Match publication's scan so tagged records retain syntax and duplicate-key
  // checks during rotation as well. Only the caller reference is replaced.
  const document = scanYamlDocument(credentials, { extendedPlainKeyRoots: ["records"] });
  const wrapped = yamlNode(document, ["refs", DSH_CREDENTIAL_REF]);
  const root = yamlNode(document, [DSH_CREDENTIAL_REF]);
  if (Boolean(wrapped) === Boolean(root)) {
    throw new Error("DeepSeek Harness caller credential is missing or ambiguous.");
  }
  const node = wrapped || root;
  const oldSecret = assignmentValue(document.lines[node.index], DSH_CREDENTIAL_REF, ":");
  assertCallerSecret(oldSecret);
  assertCallerSecret(secret);
  const lines = [...document.lines];
  lines[node.index] = replaceAssignmentLine(lines[node.index], DSH_CREDENTIAL_REF, secret, ":");
  return lines.join("\n");
}

export function refreshDshCallerCapabilityDocuments({ settings, credentials, baseUrl, secret, port, legacyPort } = {}) {
  if (!isManagedCallerBaseUrl(baseUrl, port)) {
    throw new Error("Refusing an invalid DeepSeek Harness caller capability URL.");
  }
  return {
    settings: refreshDshSettings(String(settings ?? ""), baseUrl, port, legacyPort),
    credentials: refreshDshCredentials(String(credentials ?? ""), secret),
  };
}

export function refreshGeminiCallerCapabilityDocuments({ document, published, baseUrl, secret, port, legacyPort } = {}) {
  if (!geminiManagedBlockPresent(document)) {
    throw new Error("Gemini managed caller capability block is missing or ambiguous.");
  }
  const publishedManaged = published && (
    isManagedGeminiBaseUrl(published.baseUrl, port) ||
    (legacyPort !== undefined && isManagedGeminiBaseUrl(published.baseUrl, legacyPort))
  );
  if (!publishedManaged || !isManagedGeminiBaseUrl(baseUrl, port)) {
    throw new Error("Gemini caller capability catalog is missing or unmanaged.");
  }
  assertCallerSecret(secret);
  const defaultModel = typeof published.defaultModel === "string" && published.defaultModel
    ? published.defaultModel
    : undefined;
  return {
    document: spliceGeminiEnvBlock(String(document), {
      GOOGLE_GEMINI_BASE_URL: baseUrl,
      GEMINI_API_KEY: secret,
      GEMINI_MODEL: defaultModel,
    }),
    published: { ...published, baseUrl },
  };
}
