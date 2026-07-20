import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  BACKUP_PATH,
  CONFIG_PATH,
  LEGACY_STATE_DIRS,
  MERGED_CATALOG_PATH,
  PORTS,
  loopback,
} from "./paths.mjs";

const routerBaseUrl = loopback(PORTS.router, "/v1");
const startMarker = "# BEGIN codex-router-managed";
const endMarker = "# END codex-router-managed";
const markerPairs = [
  [startMarker, endMarker],
  ["# BEGIN kimi-codex-router-managed", "# END kimi-codex-router-managed"],
  ["# BEGIN kimi-codex-proxy-managed", "# END kimi-codex-proxy-managed"],
];
const command = process.argv[2] || "status";

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
      return !(knownManaged && assignmentValue(line) === routerBaseUrl);
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
    mode: baseUrl === routerBaseUrl && catalog === MERGED_CATALOG_PATH ? "router" : "native",
    model: rootValue(rootLines, "model") || null,
    model_provider: rootValue(rootLines, "model_provider") || "openai",
    openai_base_url: baseUrl || null,
    model_catalog_json: catalog || null,
  };
}

function atomicWrite(contents) {
  mkdirSync(path.dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  const permissions = existsSync(CONFIG_PATH) ? statSync(CONFIG_PATH).mode & 0o777 : 0o600;
  const temporary = `${CONFIG_PATH}.tmp.${process.pid}`;
  writeFileSync(temporary, contents, { encoding: "utf8", mode: permissions });
  chmodSync(temporary, permissions);
  renameSync(temporary, CONFIG_PATH);
}

if (!new Set(["enable", "disable", "status"]).has(command)) {
  console.error("Usage: config-manager.mjs enable|disable|status");
  process.exit(2);
}

const current = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : "";
if (command === "status") {
  process.stdout.write(`${JSON.stringify(snapshot(current))}\n`);
  process.exit(0);
}

if (existsSync(CONFIG_PATH) && !existsSync(BACKUP_PATH)) {
  copyFileSync(CONFIG_PATH, BACKUP_PATH);
  chmodSync(BACKUP_PATH, statSync(CONFIG_PATH).mode & 0o777);
}

const cleaned = clean(current);
const rootLines = trimBlankEdges(cleaned.rootLines);
if (command === "enable") {
  const existingBase = rootValue(rootLines, "openai_base_url");
  const existingCatalog = rootValue(rootLines, "model_catalog_json");
  if (existingBase && existingBase !== routerBaseUrl) {
    throw new Error(`Refusing to replace user-owned openai_base_url: ${existingBase}`);
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
}

const next = [...trimBlankEdges(rootLines), "", ...trimBlankEdges(cleaned.tableLines)]
  .join("\n")
  .trimEnd();
atomicWrite(`${next}\n`);
process.stdout.write(`${JSON.stringify(snapshot(`${next}\n`))}\n`);
