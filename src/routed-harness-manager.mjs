// Publishing the routed catalog into one of the five document-configured
// harnesses, and taking it back out again.
//
// One publisher, five clients. The rules it enforces are the ones every other
// client integration in this repository already follows, and they are worth
// restating because each of them was a bug first:
//
// - **The marker is the installed-ness, not the client's file.** A snapshot in
//   the router's own state directory records what this router last wrote. Drift
//   is measured against it rather than by re-deriving what "should" be there
//   and trusting the answer, and it survives a user who edits or moves the
//   client's document by hand.
// - **A provider we did not write is never replaced or removed.** A
//   `codex-router` entry whose base URL is not one this router issued belongs
//   to somebody else — a second checkout, an older build, a hand-written proxy
//   — and both install and uninstall refuse rather than guess.
// - **The default model is the user's.** Only opencode has a default key this
//   integration touches at all, and only while it is one this router wrote or
//   the user has not chosen anything.
// - **A failed publish leaves the client where it was.** The document is
//   captured before the write and restored if the marker cannot be recorded, so
//   a client is never left pointed at a route the router has no record of.

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  assertCallerSecret,
  callerBaseUrl,
  claudeBaseUrl,
  isManagedCallerBaseUrl,
  isManagedClaudeBaseUrl,
  redactCallerUrl,
} from "./caller-auth.mjs";
import { privateFileIsProtected, writePrivateJson } from "./file-security.mjs";
import * as PATHS from "./paths.mjs";
import { CALLER_SECRET_PATH, LEGACY_PORTS, PORTS, ROUTED_HARNESS_CATALOG_PATHS } from "./paths.mjs";
import {
  ROUTED_HARNESS_PROVIDER_ID,
  assertRoutedHarness,
  routedHarnessDefaultModel,
  routedHarnesses,
} from "./routed-harness-catalog.mjs";
import {
  applyJsonValue,
  applyYamlValue,
  jsonDocumentValue,
  readHarnessDocument as readDocumentFile,
  removeJsonValue,
  removeYamlValue,
  writeHarnessDocument,
  yamlLeafScalar,
  yamlValuePresent,
} from "./routed-harness-document.mjs";
import { routedHarnessCliPath, installRoutedHarness } from "./routed-harness-install.mjs";
import { routedClientModels } from "./routed-client-models.mjs";
import { assertStateOwnership } from "./state-owner.mjs";

/** The user-owned document this harness's providers live in. */
export function harnessDocumentPath(harness) {
  const target = PATHS[harness.documentKey];
  if (!target) throw new Error(`No configured document path for ${harness.displayName}.`);
  return target;
}

function currentSecret(secretPath = CALLER_SECRET_PATH) {
  if (!existsSync(secretPath)) {
    throw new Error("The local router caller key is missing; run ./bin/doctor --fix.");
  }
  return assertCallerSecret(readFileSync(secretPath, "utf8").trim());
}

function redactFailure(value, secret) {
  const redacted = redactCallerUrl(String(value ?? ""));
  return secret ? redacted.replaceAll(String(secret), "[REDACTED]") : redacted;
}

/** The router endpoint this harness's wire reaches. */
export function harnessBaseUrl(harness, secret, port = PORTS.router) {
  return harness.wire === "anthropic" ? claudeBaseUrl(port, secret) : callerBaseUrl(port, secret);
}

function baseUrlManaged(harness, value, port = PORTS.router, legacyPort = LEGACY_PORTS.router) {
  const check = harness.wire === "anthropic" ? isManagedClaudeBaseUrl : isManagedCallerBaseUrl;
  if (!value) return false;
  return check(value, port) || (legacyPort !== undefined && check(value, legacyPort));
}

/** A sibling document this router cannot round-trip, if the client keeps one. */
function conflictingSibling(harness, documentPath) {
  for (const sibling of harness.conflictSiblings || []) {
    const target = path.join(path.dirname(documentPath), sibling);
    if (existsSync(target)) return target;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Reading what is currently published
// ---------------------------------------------------------------------------

/**
 * The base URL of the provider currently sitting under our key, or undefined.
 *
 * JSON documents are parsed; YAML documents are read one scalar line at a time
 * (`yamlLeafScalar`) rather than parsed, because "is this URL one we issued" is
 * the whole of the question and a real parser would be a second, divergent
 * understanding of a file this router only ever splices.
 */
export function publishedBaseUrl(harness, contents) {
  const label = harness.displayName;
  if (harness.format === "json") {
    const provider = jsonDocumentValue(contents, harness.providerPath, label);
    if (!provider || typeof provider !== "object") return undefined;
    let node = provider;
    for (const key of harness.baseUrlPath) {
      if (!node || typeof node !== "object") return undefined;
      node = node[key];
    }
    return typeof node === "string" ? node : undefined;
  }
  return yamlLeafScalar(contents, [...harness.providerPath, ...harness.baseUrlPath]);
}

/** Whether our key is present at all, in either format. */
export function providerPresent(harness, contents) {
  return harness.format === "json"
    ? jsonDocumentValue(contents, harness.providerPath, harness.displayName) !== undefined
    : yamlValuePresent(contents, harness.providerPath);
}

// ---------------------------------------------------------------------------
// The publication marker
// ---------------------------------------------------------------------------

function markerPath(harness) {
  const target = ROUTED_HARNESS_CATALOG_PATHS[harness.id];
  if (!target) throw new Error(`No publication marker configured for ${harness.displayName}.`);
  return target;
}

function readMarker(harness, port = PORTS.router, legacyPort = LEGACY_PORTS.router) {
  const target = markerPath(harness);
  if (!existsSync(target)) return undefined;
  let state;
  try {
    state = JSON.parse(readFileSync(target, "utf8"));
  } catch {
    throw new Error(
      `The ${harness.displayName} router publication marker is not valid JSON; refusing to change client state.`,
    );
  }
  const objectState = Boolean(state && typeof state === "object" && !Array.isArray(state));
  const defaultValid = objectState && state.defaultOwned === true
    ? typeof state.defaultModel === "string" && state.defaultModel.length > 0
    : objectState && state.defaultOwned === false && state.defaultModel === null;
  const valid = objectState &&
    state.version === 1 &&
    state.harness === harness.id &&
    state.provider === ROUTED_HARNESS_PROVIDER_ID &&
    typeof state.baseUrl === "string" && baseUrlManaged(harness, state.baseUrl, port, legacyPort) &&
    Array.isArray(state.models) && state.models.length > 0 &&
    state.models.every((model) => typeof model === "string" && model.length > 0) &&
    new Set(state.models).size === state.models.length &&
    (state.visionBridgeEngine === null || typeof state.visionBridgeEngine === "string") &&
    defaultValid &&
    typeof state.updatedAt === "string" && Number.isFinite(Date.parse(state.updatedAt));
  if (!valid) {
    throw new Error(
      `The ${harness.displayName} router publication marker has an unsupported or malformed shape; ` +
        "refusing to change client state.",
    );
  }
  return state;
}

// ---------------------------------------------------------------------------
// Editing the client's document
// ---------------------------------------------------------------------------

function withProvider(harness, contents, provider) {
  return harness.format === "json"
    ? applyJsonValue(contents, harness.providerPath, provider, harness.displayName)
    : applyYamlValue(contents, harness.providerPath, provider);
}

function withoutProvider(harness, contents) {
  return harness.format === "json"
    ? removeJsonValue(contents, harness.providerPath, harness.displayName)
    : removeYamlValue(contents, harness.providerPath);
}

function readDefaultModel(harness, contents) {
  if (!harness.defaultModelPath) return undefined;
  const value = harness.format === "json"
    ? jsonDocumentValue(contents, harness.defaultModelPath, harness.displayName)
    : yamlLeafScalar(contents, harness.defaultModelPath);
  return typeof value === "string" && value ? value : undefined;
}

function withDefaultModel(harness, contents, value) {
  return harness.format === "json"
    ? applyJsonValue(contents, harness.defaultModelPath, value, harness.displayName)
    : applyYamlValue(contents, harness.defaultModelPath, value);
}

function withoutDefaultModel(harness, contents) {
  return harness.format === "json"
    ? removeJsonValue(contents, harness.defaultModelPath, harness.displayName)
    : removeYamlValue(contents, harness.defaultModelPath);
}

// ---------------------------------------------------------------------------
// The manager
// ---------------------------------------------------------------------------

export function createRoutedHarnessManager(id, {
  documentPath,
  markerFile,
  secretPath = CALLER_SECRET_PATH,
  port = PORTS.router,
  legacyPort = LEGACY_PORTS.router,
  modelSource = routedClientModels,
  assertOwnership = assertStateOwnership,
  findCli = routedHarnessCliPath,
  installCli = installRoutedHarness,
  readDocument = readDocumentFile,
  writeDocument = writeHarnessDocument,
  writeMarker = writePrivateJson,
} = {}) {
  const harness = assertRoutedHarness(id);
  const document = () => documentPath || harnessDocumentPath(harness);
  const marker = () => markerFile || markerPath(harness);

  function assertPublishable(contents, state) {
    const conflict = conflictingSibling(harness, document());
    if (conflict) {
      throw new Error(
        `${harness.displayName} also has ${conflict}, which this router cannot rewrite without ` +
          "discarding its comments. Consolidate the two documents, then publish again.",
      );
    }
    if (!providerPresent(harness, contents)) return;
    const existing = publishedBaseUrl(harness, contents);
    if (!state && !baseUrlManaged(harness, existing, port, legacyPort)) {
      throw new Error(
        `${harness.displayName} already has an unmanaged ${ROUTED_HARNESS_PROVIDER_ID} provider; ` +
          "rename or remove it before setup.",
      );
    }
    if (!baseUrlManaged(harness, existing, port, legacyPort)) {
      throw new Error(
        `Refusing to replace a ${harness.displayName} provider whose base URL is not managed by this router.`,
      );
    }
  }

  function install({ installMissingCli = false } = {}) {
    assertOwnership(`write the ${harness.displayName} model catalog`);
    const { models, engine } = modelSource();
    if (!models.length) {
      throw new Error(
        "No routed models are selected, credentialed, and listed. Enable a provider first " +
          "(`./bin/providers enable PROVIDER`), then publish again.",
      );
    }
    if (installMissingCli && !findCli(harness.id)) installCli(harness.id);

    const target = document();
    const state = readMarker(harness, port, legacyPort);
    const before = readDocument(target);
    assertPublishable(before, state);

    const secret = currentSecret(secretPath);
    const baseUrl = harnessBaseUrl(harness, secret, port);
    const provider = harness.buildProvider({ models, baseUrl, secret });

    // The default model is the user's own choice. Take it over only when this
    // router already owned the value that is there, or when there is no value
    // at all — a snapshot taken before somebody picked their own model is not a
    // licence to undo that pick.
    const currentDefault = readDefaultModel(harness, before);
    const desiredDefault = harness.defaultModelPath
      ? harness.defaultModelValue(routedHarnessDefaultModel(models))
      : undefined;
    const previouslyOwned = Boolean(
      state?.defaultOwned && state.defaultModel && currentDefault === state.defaultModel,
    );
    const defaultOwned = Boolean(desiredDefault) && (previouslyOwned || (!state && !currentDefault));

    let after = withProvider(harness, before, provider);
    if (defaultOwned) after = withDefaultModel(harness, after, desiredDefault);

    writeDocument(target, after);
    try {
      writeMarker(marker(), {
        version: 1,
        harness: harness.id,
        provider: ROUTED_HARNESS_PROVIDER_ID,
        baseUrl,
        document: target,
        models: models.map((model) => String(model.slug)),
        visionBridgeEngine: engine?.slug || null,
        defaultOwned,
        defaultModel: defaultOwned ? desiredDefault : null,
        updatedAt: new Date().toISOString(),
      }, { directoryMode: 0o700 });
    } catch (error) {
      // The client is now pointed at a route the router has no record of, which
      // is the one state neither uninstall nor drift detection can reason
      // about. Put the document back exactly as it was found.
      try {
        writeDocument(target, before);
      } catch (rollbackError) {
        throw new Error(
          `${redactFailure(error instanceof Error ? error.message : error, secret)} ` +
            `${harness.displayName} rollback also failed: ` +
            `${redactFailure(rollbackError instanceof Error ? rollbackError.message : rollbackError, secret)}`,
        );
      }
      throw new Error(redactFailure(error instanceof Error ? error.message : error, secret));
    }

    return {
      harness: harness.id,
      provider: ROUTED_HARNESS_PROVIDER_ID,
      document: target,
      models: models.length,
      visionBridgeEngine: engine?.slug || null,
      defaultOwned,
      defaultModel: defaultOwned ? desiredDefault : null,
      restartHint: harness.restartHint,
    };
  }

  function uninstall() {
    assertOwnership(`remove the ${harness.displayName} integration`);
    const target = document();
    const state = readMarker(harness, port, legacyPort);
    const before = readDocument(target);
    const present = before ? providerPresent(harness, before) : false;

    if (!state) {
      if (present) {
        throw new Error(
          `Refusing to remove an unmanaged ${harness.displayName} ${ROUTED_HARNESS_PROVIDER_ID} provider.`,
        );
      }
      return { removed: false, harness: harness.id, provider: ROUTED_HARNESS_PROVIDER_ID };
    }
    if (present && !baseUrlManaged(harness, publishedBaseUrl(harness, before), port, legacyPort)) {
      throw new Error(
        `Refusing to remove a ${harness.displayName} provider whose base URL is not managed by this router.`,
      );
    }

    let after = before;
    // Leaving the client pointed at a provider this uninstall just deleted is
    // worse than leaving it with no default, so a default we own is removed
    // rather than left dangling. One the user has since changed is theirs.
    const defaultRemoved = Boolean(
      state.defaultOwned && state.defaultModel &&
        readDefaultModel(harness, before) === state.defaultModel,
    );
    if (defaultRemoved) after = withoutDefaultModel(harness, after);
    if (present) after = withoutProvider(harness, after);
    if (after !== before) writeDocument(target, after);
    if (existsSync(marker())) unlinkSync(marker());
    return { removed: present, harness: harness.id, provider: ROUTED_HARNESS_PROVIDER_ID, defaultRemoved };
  }

  function status() {
    const { models } = modelSource();
    const target = document();
    const cli = findCli(harness.id);
    const base = {
      harness: harness.id,
      displayName: harness.displayName,
      document: target,
      documentExists: existsSync(target),
      cliInstalled: Boolean(cli),
      ...(cli ? { cli } : {}),
      routableModels: models.length,
    };
    let state;
    try {
      state = readMarker(harness, port, legacyPort);
    } catch (error) {
      return {
        ...base,
        installed: existsSync(marker()),
        stateValid: false,
        providerInstalled: false,
        configValid: false,
        configError: redactFailure(error instanceof Error ? error.message : error),
        publishedModels: 0,
        catalogFresh: false,
      };
    }
    try {
      const contents = readDocument(target);
      const present = contents ? providerPresent(harness, contents) : false;
      const liveBaseUrl = present ? publishedBaseUrl(harness, contents) : undefined;
      const secret = currentSecret(secretPath);
      const expectedBaseUrl = harnessBaseUrl(harness, secret, port);
      const expectedProvider = harness.buildProvider({ models, baseUrl: expectedBaseUrl, secret });
      // JSON documents round-trip, so the published provider can be compared
      // whole. YAML ones are spliced as text and never parsed back, so the
      // comparable evidence there is the marker plus the live base URL.
      const providerValid = harness.format === "json"
        ? isDeepStrictEqual(jsonDocumentValue(contents, harness.providerPath, harness.displayName), expectedProvider)
        : present && liveBaseUrl === expectedBaseUrl;
      const markerFresh = Boolean(state) && state.baseUrl === expectedBaseUrl &&
        isDeepStrictEqual(state.models, models.map((model) => String(model.slug)));
      return {
        ...base,
        installed: Boolean(state),
        stateValid: true,
        provider: ROUTED_HARNESS_PROVIDER_ID,
        providerInstalled: present,
        baseUrlManaged: baseUrlManaged(harness, liveBaseUrl, port, legacyPort),
        callerCapabilityCurrent: liveBaseUrl === expectedBaseUrl,
        baseUrl: liveBaseUrl ? redactCallerUrl(liveBaseUrl) : null,
        documentProtected: Boolean(base.documentExists && privateFileIsProtected(target)),
        configValid: providerValid,
        ...(present && !providerValid
          ? {
            configError:
                `the live ${harness.displayName} provider differs from the router-owned protocol, ` +
                "models, or caller capability",
          }
          : {}),
        publishedModels: state?.models?.length ?? 0,
        catalogFresh: markerFresh && providerValid,
        defaultOwned: Boolean(state?.defaultOwned),
        defaultModel: harness.defaultModelPath ? (readDefaultModel(harness, contents) || null) : null,
      };
    } catch (error) {
      return {
        ...base,
        installed: Boolean(state),
        providerInstalled: false,
        configValid: false,
        configError: redactFailure(error instanceof Error ? error.message : error),
        publishedModels: state?.models?.length ?? 0,
        catalogFresh: false,
      };
    }
  }

  // Rotating the caller key changes the base URL, which is the capability
  // itself. Republishing is the whole of the fix, so it is the same call.
  return { harness, install, uninstall, status, refreshCallerCapability: () => install() };
}

/** Every routed harness with a publication marker on disk. */
export function installedRoutedHarnesses() {
  return routedHarnesses()
    .filter((harness) => existsSync(ROUTED_HARNESS_CATALOG_PATHS[harness.id]))
    .map((harness) => harness.id);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , id, command = "status", ...rest] = process.argv;
  try {
    const manager = createRoutedHarnessManager(id);
    const handlers = {
      install: () => manager.install({ installMissingCli: rest.includes("--install-cli") }),
      uninstall: manager.uninstall,
      status: manager.status,
      "caller-capability-refresh": manager.refreshCallerCapability,
    };
    const handler = handlers[command];
    if (!handler) {
      console.error(
        `Usage: routed-harness-manager HARNESS ${Object.keys(handlers).join("|")} [--install-cli]`,
      );
      process.exit(2);
    }
    process.stdout.write(`${JSON.stringify(handler(), null, 2)}\n`);
  } catch (error) {
    console.error(redactFailure(error instanceof Error ? error.message : error));
    process.exit(1);
  }
}
