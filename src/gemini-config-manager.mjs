// Publishes the router's routed models into Gemini CLI.
//
// One document, three keys, and nothing else. Gemini CLI reads its endpoint,
// its credential, and its default model from the environment and loads
// `~/.gemini/.env` for them at startup, so that file is the entire
// integration surface -- its `settings.json` is JSONC carrying the user's own
// comments and is never opened for writing.
//
// The models themselves are not copied anywhere. `/gemini/v1beta/models` is
// served live off the same catalog the router already publishes, which is why
// this manager has no model list to keep in step and no drift to repair beyond
// the base URL and the default model.

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertCallerSecret,
  geminiBaseUrl,
  isManagedGeminiBaseUrl,
  redactCallerUrl,
} from "./caller-auth.mjs";
import {
  CALLER_SECRET_PATH,
  GEMINI_ENV_PATH,
  GEMINI_CATALOG_PATH,
  PORTS,
} from "./paths.mjs";
import { writePrivateFile, writePrivateJson } from "./file-security.mjs";
import {
  GEMINI_MANAGED_KEYS,
  conflictingAssignments,
  removeGeminiEnvBlock,
  spliceGeminiEnvBlock,
} from "./gemini-env.mjs";
import { routedClientModels } from "./routed-client-models.mjs";
import { assertStateOwnership } from "./state-owner.mjs";

function callerSecret() {
  if (!existsSync(CALLER_SECRET_PATH)) {
    throw new Error("The local router caller key is missing; run ./bin/doctor --fix.");
  }
  return assertCallerSecret(readFileSync(CALLER_SECRET_PATH, "utf8").trim());
}

function callerBase() {
  return geminiBaseUrl(PORTS.router, callerSecret());
}

function readDocument(target) {
  return existsSync(target) ? readFileSync(target, "utf8") : "";
}

/** The model a fresh Gemini CLI session should start on: the highest priority one. */
export function geminiDefaultModel(models) {
  const ranked = [...models].sort(
    (left, right) =>
      (right.priority ?? 0) - (left.priority ?? 0) ||
      String(left.slug).localeCompare(String(right.slug)),
  );
  return ranked[0]?.slug;
}

/** The routed models Gemini CLI should be offered. */
export function geminiRoutedModels() {
  return routedClientModels();
}

// A managed key assigned outside our block would out-rank or be out-ranked by
// ours depending on which came last, and dotenv resolves that silently. Name
// the line and stop rather than write a file whose behaviour nobody can predict
// from reading it.
function assertNoConflicts(document) {
  const conflicts = conflictingAssignments(document);
  if (!conflicts.length) return;
  const named = conflicts.map(({ key, line }) => `${key} (line ${line})`).join(", ");
  throw new Error(
    `${GEMINI_ENV_PATH} already assigns ${named} outside the router's managed block. ` +
      "Remove or comment those out, then publish again -- the router will not " +
      "overwrite an assignment it did not write.",
  );
}

/**
 * Writes the managed block and records what it published.
 *
 * `setDefaultModel` is on by default, unlike the harness integration's
 * equivalent, because it is not a convenience here: Gemini CLI's own default is
 * `gemini-2.5-pro`, which is not a routed slug, so an integration that left it
 * alone would 404 on the user's first turn. It out-ranks `settings.json`'s
 * `model.name` and is out-ranked by `--model`, which is stated in the docs and
 * is why it can be turned off.
 */
export function publishGeminiIntegration({
  setDefaultModel = true,
  routedModels = geminiRoutedModels,
} = {}) {
  assertStateOwnership("publish the Gemini CLI integration");
  const { models, engine } = routedModels();
  const baseUrl = callerBase();
  const document = readDocument(GEMINI_ENV_PATH);
  assertNoConflicts(document);
  const defaultModel = setDefaultModel ? geminiDefaultModel(models) : undefined;
  const written = spliceGeminiEnvBlock(document, {
    GOOGLE_GEMINI_BASE_URL: baseUrl,
    GEMINI_API_KEY: callerSecret(),
    GEMINI_MODEL: defaultModel,
  });
  // The document carries the caller key and the managed base URL, which is a
  // local caller capability, so the file is 0600 -- the same bound Gemini CLI
  // holds its own credential store to. `writePrivateFile` creates a missing
  // `~/.gemini` at 0700 and deliberately does not re-mode an existing one:
  // that directory is Gemini CLI's, not the router's, and the 0600 on the file
  // is what protects the key either way.
  writePrivateFile(GEMINI_ENV_PATH, written);
  writePrivateJson(GEMINI_CATALOG_PATH, {
    updatedAt: new Date().toISOString(),
    baseUrl,
    defaultModel: defaultModel ?? null,
    models: models.map((model) => String(model.slug)),
  });
  return { models, engine, defaultModel, baseUrl };
}

/** Removes the managed block, leaving the rest of the document exactly as found. */
export function removeGeminiIntegration() {
  assertStateOwnership("remove the Gemini CLI integration");
  const document = readDocument(GEMINI_ENV_PATH);
  const written = removeGeminiEnvBlock(document);
  // A document that is now empty is one the router created; anything else is
  // the user's and keeps its file.
  if (existsSync(GEMINI_ENV_PATH)) {
    if (written.trim() === "") unlinkSync(GEMINI_ENV_PATH);
    else writePrivateFile(GEMINI_ENV_PATH, written);
  }
  if (existsSync(GEMINI_CATALOG_PATH)) unlinkSync(GEMINI_CATALOG_PATH);
  return { removed: document !== written };
}

/** What is published, for `status`, `doctor`, and the tray. */
export function geminiIntegrationStatus() {
  const document = readDocument(GEMINI_ENV_PATH);
  let published;
  try {
    published = existsSync(GEMINI_CATALOG_PATH)
      ? JSON.parse(readFileSync(GEMINI_CATALOG_PATH, "utf8"))
      : undefined;
  } catch {
    published = undefined;
  }
  // A document the lexer refuses has no trustworthy conflict list, so the two
  // are reported together: `documentReadable: false` is the finding, and an
  // empty `conflicts` beside it does not mean there are none.
  let documentReadable = true;
  let conflicts = [];
  try {
    conflicts = conflictingAssignments(document);
  } catch {
    documentReadable = false;
  }
  return {
    envPath: GEMINI_ENV_PATH,
    envExists: existsSync(GEMINI_ENV_PATH),
    installed: existsSync(GEMINI_CATALOG_PATH),
    documentReadable,
    conflicts,
    managedKeys: [...GEMINI_MANAGED_KEYS],
    // Never the complete URL: it carries the caller capability, and status
    // output reaches doctor, the tray, and support bundles.
    baseUrl: published?.baseUrl ? redactCallerUrl(published.baseUrl) : null,
    baseUrlManaged: published?.baseUrl
      ? isManagedGeminiBaseUrl(published.baseUrl, PORTS.router)
      : false,
    defaultModel: published?.defaultModel ?? null,
    publishedModels: Array.isArray(published?.models) ? published.models : [],
    updatedAt: published?.updatedAt ?? null,
  };
}

/**
 * Models the last publish advertised that the router no longer routes.
 *
 * The catalog is served live, so the model list itself cannot drift -- but the
 * published default model can, and a default naming a model that is gone puts
 * every fresh session on a 404.
 */
export function geminiCatalogDrift({ routedModels = geminiRoutedModels } = {}) {
  if (!existsSync(GEMINI_CATALOG_PATH)) return undefined;
  const status = geminiIntegrationStatus();
  const routable = new Set(routedModels().models.map((model) => String(model.slug)));
  const missing = status.publishedModels.filter((slug) => !routable.has(slug));
  const added = [...routable].filter((slug) => !status.publishedModels.includes(slug));
  const defaultMissing = Boolean(status.defaultModel && !routable.has(status.defaultModel));
  return { missing, added, defaultMissing };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] || "status";
  const handlers = {
    status: () => geminiIntegrationStatus(),
    // `--no-default-model` rather than `--set-default-model`: Gemini CLI's own
    // default is a Gemini model this router does not route, so an install that
    // left it alone would 404 on the user's first turn.
    install: () =>
      publishGeminiIntegration({
        setDefaultModel: !process.argv.includes("--no-default-model"),
      }),
    uninstall: () => removeGeminiIntegration(),
    drift: () => geminiCatalogDrift() ?? { installed: false },
  };
  const handler = handlers[command];
  if (!handler) {
    console.error(`Usage: gemini-config-manager ${Object.keys(handlers).join("|")}`);
    process.exit(2);
  }
  try {
    process.stdout.write(`${JSON.stringify(handler(), null, 2)}\n`);
  } catch (error) {
    if (error?.code === "foreign_state_owner") {
      console.error(error.message);
      process.exit(1);
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
