import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scanTomlDocument } from "./toml-structure.mjs";
import { protectPrivateFile } from "./file-security.mjs";
import { MODEL_BY_SLUG } from "./model-registry.mjs";
import {
  CONFIG_PATH,
  MERGED_CATALOG_PATH,
  NATIVE_CATALOG_SOURCE_PATH,
} from "./paths.mjs";

export function catalogPathsEqual(left, right) {
  const normalizedLeft = path.normalize(String(left));
  const normalizedRight = path.normalize(String(right));
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

const BASIC_STRING_ESCAPES = new Map([
  ["b", "\b"],
  ["t", "\t"],
  ["n", "\n"],
  ["f", "\f"],
  ["r", "\r"],
  ['"', '"'],
  ["\\", "\\"],
]);

// TOML basic strings are not JSON strings: TOML adds `\UXXXXXXXX`, and Windows
// users routinely write an unescaped native path (`"C:\Users\me\models.json"`).
// JSON.parse rejects both and the caller reads a rejected value as "no catalog
// configured" — the one answer that clears migration to run over an
// installation the router does not own. So decode the escapes TOML defines and
// leave any other backslash standing as itself.
function decodeBasicString(body) {
  let decoded = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== "\\") {
      decoded += char;
      continue;
    }
    const escape = body[index + 1];
    const simple = escape === undefined ? undefined : BASIC_STRING_ESCAPES.get(escape);
    if (simple !== undefined) {
      decoded += simple;
      index += 1;
      continue;
    }
    if (escape === "u" || escape === "U") {
      const width = escape === "u" ? 4 : 8;
      const digits = body.slice(index + 2, index + 2 + width);
      const code = /^[0-9a-fA-F]+$/.test(digits) && digits.length === width
        ? Number.parseInt(digits, 16)
        : Number.NaN;
      if (code <= 0x10ffff) {
        decoded += String.fromCodePoint(code);
        index += 1 + width;
        continue;
      }
    }
    decoded += char;
  }
  return decoded;
}

function scannedRootAssignments(contents, key) {
  try {
    return scanTomlDocument(contents, { rootOnly: true }).assignments.filter(
      (entry) => entry.tablePath.length === 0 && entry.key.length === 1 && entry.key[0] === key,
    );
  } catch {
    // Legacy Windows prototype paths may contain invalid TOML escapes.
    return undefined;
  }
}

export function readRootStringValues(contents, key) {
  const assignments = scannedRootAssignments(contents, key);
  if (assignments) return assignments.filter(({ kind }) => kind === "string").map(({ value }) => value);
  const firstTable = contents.search(/^\s*\[/m);
  const root = firstTable === -1 ? contents : contents.slice(0, firstTable);
  return [...root.matchAll(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, "gm"))]
    .map((match) => match[1])
    .map((raw) => {
      if (raw.startsWith('"')) {
        let closing = -1;
        let escaped = false;
        for (let index = 1; index < raw.length; index += 1) {
          if (!escaped && raw[index] === '"') {
            closing = index;
            break;
          }
          escaped = !escaped && raw[index] === "\\";
          if (raw[index] !== "\\") escaped = false;
        }
        if (closing === -1 || !/^(?:\s*#.*)?$/.test(raw.slice(closing + 1))) {
          return undefined;
        }
        return decodeBasicString(raw.slice(1, closing));
      }
      if (!raw.startsWith("'")) return undefined;
      const closing = raw.indexOf("'", 1);
      return closing !== -1 && /^(?:\s*#.*)?$/.test(raw.slice(closing + 1))
        ? raw.slice(1, closing)
        : undefined;
    })
    .filter((value) => value !== undefined);
}

export function rootAssignmentCount(contents, key) {
  const assignments = scannedRootAssignments(contents, key);
  if (assignments) return assignments.length;
  const firstTable = contents.search(/^\s*\[/m);
  const root = firstTable === -1 ? contents : contents.slice(0, firstTable);
  return [...root.matchAll(new RegExp(`^\\s*${key}\\s*=`, "gm"))].length;
}

function validCatalog(catalog) {
  return (
    catalog &&
    Array.isArray(catalog.models) &&
    catalog.models.length > 0 &&
    catalog.models.every((model) => {
      const slug = typeof model?.slug === "string" ? model.slug.trim() : "";
      return slug && !MODEL_BY_SLUG.has(slug);
    })
  );
}

export function readNativeCatalogFile(catalogPath) {
  if (!path.isAbsolute(catalogPath) || !existsSync(catalogPath)) return undefined;
  try {
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
    return validCatalog(catalog) ? catalog : undefined;
  } catch {
    return undefined;
  }
}

export function readNativeCatalogSource() {
  if (!existsSync(NATIVE_CATALOG_SOURCE_PATH)) return undefined;
  try {
    const state = JSON.parse(readFileSync(NATIVE_CATALOG_SOURCE_PATH, "utf8"));
    if (
      state?.version !== 1 ||
      typeof state.path !== "string" ||
      !path.isAbsolute(state.path) ||
      !new Set(["pending", "active"]).has(state.status)
    ) {
      throw new Error("invalid state");
    }
    return state;
  } catch {
    throw new Error(
      `Invalid native catalog source state at ${NATIVE_CATALOG_SOURCE_PATH}.`,
    );
  }
}

function writeNativeCatalogSource(value) {
  mkdirSync(path.dirname(NATIVE_CATALOG_SOURCE_PATH), {
    recursive: true,
    mode: 0o700,
  });
  const temporary = `${NATIVE_CATALOG_SOURCE_PATH}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    protectPrivateFile(temporary);
    renameSync(temporary, NATIVE_CATALOG_SOURCE_PATH);
    protectPrivateFile(NATIVE_CATALOG_SOURCE_PATH);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

export function prepareNativeCatalogSourceFromConfig() {
  const contents = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : "";
  const catalogs = readRootStringValues(contents, "model_catalog_json");
  const existing = readNativeCatalogSource();

  if (
    existing &&
    catalogs.length === 1 &&
    catalogPathsEqual(catalogs[0], MERGED_CATALOG_PATH)
  ) {
    return { created: false, source: existing };
  }
  if (
    catalogs.length !== 1 ||
    rootAssignmentCount(contents, "model_catalog_json") !== 1 ||
    rootAssignmentCount(contents, "openai_base_url") !== 0
  ) {
    throw new Error(
      "Adoption requires exactly one model_catalog_json and no openai_base_url.",
    );
  }
  const catalogPath = catalogs[0];
  if (!readNativeCatalogFile(catalogPath)) {
    throw new Error(`Refusing to adopt an invalid native model catalog: ${catalogPath}`);
  }
  if (existing && !catalogPathsEqual(existing.path, catalogPath)) {
    throw new Error(
      `Native catalog source state already refers to a different path: ${existing.path}`,
    );
  }
  if (existing) return { created: false, source: existing };
  const source = { version: 1, path: catalogPath, status: "pending" };
  writeNativeCatalogSource(source);
  return { created: true, source };
}

export function activateNativeCatalogSource() {
  const source = readNativeCatalogSource();
  if (!source) throw new Error("Native catalog source state is missing.");
  if (!readNativeCatalogFile(source.path)) {
    throw new Error(`Configured native model catalog is unavailable or invalid: ${source.path}`);
  }
  if (source.status !== "active") {
    writeNativeCatalogSource({ ...source, status: "active" });
  }
}

export function clearNativeCatalogSource(options = {}) {
  const source = readNativeCatalogSource();
  if (!source || (options.pendingOnly && source.status !== "pending")) return false;
  unlinkSync(NATIVE_CATALOG_SOURCE_PATH);
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const command = process.argv[2];
    if (command === "prepare-from-config") {
      process.stdout.write(
        `${JSON.stringify(prepareNativeCatalogSourceFromConfig())}\n`,
      );
    } else if (command === "clear-pending") {
      process.stdout.write(`${JSON.stringify({ cleared: clearNativeCatalogSource({ pendingOnly: true }) })}\n`);
    } else {
      console.error(
        "Usage: native-catalog-source.mjs prepare-from-config|clear-pending",
      );
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
