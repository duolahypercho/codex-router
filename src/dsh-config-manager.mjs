// Writes the router's provider route into DeepSeek Harness's own documents.
//
// Two files, both owned by the harness and both hot-reloaded by it:
//
//   $DSH_HOME/settings.yaml      the `llm-pi-ai.providers.codex-router` route
//   $DSH_HOME/.credentials.yaml  the value the route's `apiKeyEnv` references
//
// Neither is ours. The harness writes leaf-level diffs into `settings.yaml` and
// preserves the user's comments, and its own Models page writes provider routes
// beside ours, so this manager owns exactly one key in each document and treats
// every other byte as somebody else's work. Anything it cannot read plainly is
// refused with the file untouched.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertCallerSecret, callerBaseUrl, redactCallerUrl } from "./caller-auth.mjs";
import {
  DSH_CATALOG_PATH,
  DSH_CREDENTIALS_PATH,
  DSH_HOME,
  DSH_SETTINGS_PATH,
  CALLER_SECRET_PATH,
  NATIVE_CATALOG_PATH,
  PORTS,
} from "./paths.mjs";
import { protectPrivateFile } from "./file-security.mjs";
import {
  DSH_CREDENTIAL_REF,
  DSH_ROUTE_ID,
  buildDshRoute,
  dshCatalogModels,
  dshDefaultModel,
  dshNativeModels,
  renderDshRouteLines,
  unmappableEfforts,
} from "./dsh-catalog.mjs";
import { readHiddenModels } from "./model-picker-state.mjs";
import { readMultiAgentSettings, subagentEligibleModels } from "./multi-agent-state.mjs";
import { selectedConfiguredListedModels } from "./provider-selection.mjs";
import { assertStateOwnership } from "./state-owner.mjs";
import { nativeSessionAvailable } from "./codex-native-session.mjs";
import { resolveVisionEngine } from "./vision-bridge.mjs";
import { readVisionBridgeSettings } from "./vision-bridge-state.mjs";
import { scanYamlDocument, spliceYamlBlock, yamlNode, yamlScalar } from "./yaml-structure.mjs";

const ROUTE_PATH = ["llm-pi-ai", "providers", DSH_ROUTE_ID];
const DEFAULT_MODEL_PATH = ["agent-default-model"];
const DEFAULT_MODEL_SNAPSHOT = "dsh-default-model.json";

function callerBase() {
  if (!existsSync(CALLER_SECRET_PATH)) {
    throw new Error("The local router caller key is missing; run ./bin/doctor --fix.");
  }
  return callerBaseUrl(PORTS.router, assertCallerSecret(readFileSync(CALLER_SECRET_PATH, "utf8").trim()));
}

function readDocument(target) {
  return existsSync(target) ? readFileSync(target, "utf8") : "";
}

// The harness creates its home 0700 and both documents 0600. Match that: the
// settings document carries the caller base URL, which is a local
// authentication capability, and the credentials document carries the key it
// references.
function writeDocument(target, contents) {
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp.${process.pid}`;
  writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
  try {
    protectPrivateFile(temporary);
    renameSync(temporary, target);
    protectPrivateFile(target);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
  return target;
}

function joinLines(lines) {
  const text = lines.join("\n");
  return text.endsWith("\n") || text === "" ? text : `${text}\n`;
}

// Splitting a document on newlines yields a trailing empty element for the
// final newline, and splicing beside it is how a file grows one blank line per
// write. Leading blanks are the same story for a document that started empty.
function normalizeTrailing(lines) {
  const copy = [...lines];
  while (copy.length > 1 && copy.at(-1) === "" && copy.at(-2) === "") copy.pop();
  while (copy.length > 1 && copy[0] === "") copy.shift();
  return copy;
}

/**
 * Splices the router's route into the settings document text.
 *
 * Exported for tests, and pure: it takes and returns text, so a failure cannot
 * leave a half-written document behind.
 */
export function applyRouteToSettings(contents, route) {
  const document = scanYamlDocument(contents);
  const providers = yamlNode(document, ["llm-pi-ai", "providers"]);
  if (providers && providers.inline) {
    throw new Error(
      "Refusing to edit llm-pi-ai.providers: it is written as an inline value rather than a block.",
    );
  }
  // Follow whatever indentation the document already uses for a sibling route
  // rather than assuming two spaces: a route indented differently from the
  // ones beside it parses, but reads as though something went wrong.
  const sibling = providers && [...providers.children.values()][0];
  const indent = sibling
    ? " ".repeat(sibling.indent)
    : providers
      ? " ".repeat(providers.indent + 2)
      : "    ";
  const rendered = renderDshRouteLines(route, { indent });
  return joinLines(normalizeTrailing(spliceYamlBlock(document, ROUTE_PATH, rendered)));
}

/**
 * Removes the router's route, leaving every sibling route in place.
 *
 * A `providers:` (or `llm-pi-ai:`) key left holding nothing is removed with
 * it. An empty mapping there is not the same as an absent one — the adapter's
 * section schema reads a valueless key as null, not as "no routes" — and the
 * only way one can be left behind is that publishing created it.
 */
export function removeRouteFromSettings(contents) {
  const document = scanYamlDocument(contents);
  const route = yamlNode(document, ROUTE_PATH);
  if (!route) return joinLines(normalizeTrailing(document.lines));
  let removal = route;
  for (let depth = ROUTE_PATH.length - 1; depth > 0; depth -= 1) {
    const parent = yamlNode(document, ROUTE_PATH.slice(0, depth));
    if (!parent || parent.children.size !== 1) break;
    removal = parent;
  }
  const lines = [...document.lines];
  lines.splice(removal.index, removal.endIndex - removal.index + 1);
  return joinLines(normalizeTrailing(lines));
}

/**
 * Sets one credential reference in the harness's credentials document.
 *
 * The document is a flat mapping of reference to value and nothing else, so a
 * nested or sequence root is somebody else's file under the harness's name and
 * is refused rather than replaced.
 */
export function applyCredential(contents, reference, value) {
  const document = scanYamlDocument(contents);
  for (const node of document.root.children.values()) {
    // A multi-line value is legal here (the harness round-trips those), a
    // nested mapping is not: that is a different document wearing this file's
    // name, and rewriting it would be a guess.
    if (node.children.size) {
      throw new Error(
        `Refusing to edit the harness credentials document: "${node.key}" holds a nested mapping, ` +
          "so this file is not a flat credential reference document.",
      );
    }
  }
  const rendered = [`${reference}: ${yamlScalar(value)}`];
  return joinLines(normalizeTrailing(spliceYamlBlock(document, [reference], rendered)));
}

/** Removes one credential reference, leaving every other entry in place. */
export function removeCredential(contents, reference) {
  const document = scanYamlDocument(contents);
  const node = yamlNode(document, [reference]);
  if (!node) return joinLines(normalizeTrailing(document.lines));
  const lines = [...document.lines];
  lines.splice(node.index, node.endIndex - node.index + 1);
  return joinLines(normalizeTrailing(lines));
}

/** Replaces the `agent-default-model` section with one naming a routed model. */
export function applyDefaultModel(contents, { model, reasoningEffort }) {
  const document = scanYamlDocument(contents);
  const rendered = [
    "agent-default-model:",
    `  provider: ${yamlScalar(DSH_ROUTE_ID)}`,
    `  model: ${yamlScalar(model)}`,
    ...(reasoningEffort ? [`  reasoningEffort: ${yamlScalar(reasoningEffort)}`] : []),
  ];
  return joinLines(normalizeTrailing(spliceYamlBlock(document, DEFAULT_MODEL_PATH, rendered)));
}

function defaultModelSnapshotPath() {
  return path.join(path.dirname(DSH_CATALOG_PATH), DEFAULT_MODEL_SNAPSHOT);
}

// The default model is the user's own choice, so taking it over is opt-in and
// reversible: the previous section is snapshotted verbatim and put back on
// uninstall. This mirrors how the Codex login-free mode treats `model` and
// `model_provider` rather than inventing a second discipline.
function snapshotDefaultModel(contents) {
  const document = scanYamlDocument(contents);
  const node = yamlNode(document, DEFAULT_MODEL_PATH);
  const previous = node
    ? document.lines.slice(node.index, node.endIndex + 1)
    : null;
  writeDocument(
    defaultModelSnapshotPath(),
    `${JSON.stringify({ version: 1, previous }, null, 2)}\n`,
  );
}

function restoreDefaultModel(contents) {
  const target = defaultModelSnapshotPath();
  const document = scanYamlDocument(contents);
  const node = yamlNode(document, DEFAULT_MODEL_PATH);
  // Whether the default currently in the document is one this router wrote.
  // Between a snapshot and now the user may have chosen their own -- the
  // harness's own Models page writes the same key -- and putting a snapshot
  // back over that is not a restore, it is discarding a later choice.
  const routerOwnsCurrent = Boolean(
    node &&
      document.lines
        .slice(node.index, node.endIndex + 1)
        .some((line) => new RegExp(`^\\s*provider:\\s*['"]?${DSH_ROUTE_ID}['"]?\\s*$`).test(line)),
  );

  let previous;
  if (existsSync(target)) {
    try {
      previous = JSON.parse(readFileSync(target, "utf8")).previous;
    } catch {
      previous = undefined;
    }
    unlinkSync(target);
  }

  // Somebody else's choice, or no default at all: nothing here belongs to this
  // router, so nothing is touched.
  if (node && !routerOwnsCurrent) return { contents, restored: false };
  if (!node && !previous) return { contents, restored: false };

  const lines = [...document.lines];
  if (node) {
    // Ours. Put back what was there before, or -- with no snapshot to put back
    // -- take it out rather than leave the harness pointed at a provider this
    // uninstall just removed.
    lines.splice(node.index, node.endIndex - node.index + 1, ...(previous || []));
  } else if (previous) {
    lines.push(...previous);
  }
  return { contents: joinLines(normalizeTrailing(lines)), restored: true };
}

// The native catalog Codex itself published, captured by `catalog.mjs`. Read
// rather than re-derived: it is the same document the Codex picker is built
// from, so the harness cannot end up advertising a native model Codex does not
// have. Absent simply means no native models are offered.
function readNativeCatalogModels() {
  if (!existsSync(NATIVE_CATALOG_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(NATIVE_CATALOG_PATH, "utf8"));
    return Array.isArray(parsed?.models) ? parsed.models : [];
  } catch {
    return [];
  }
}

/** The routed models the harness should be offered, vision bridge included. */
export function dshRoutedModels() {
  const hidden = readHiddenModels();
  const selected = selectedConfiguredListedModels().filter(
    (model) => !hidden.has(String(model.slug)),
  );
  // Native GPT models are authorized by a ChatGPT session rather than an API
  // key. The harness carries none of its own -- but this machine is signed in
  // to Codex, and the router relays that session for a caller that brought
  // nothing (see `codex-native-session.mjs`). So they are publishable exactly
  // while that fallback can supply one, and withheld the moment it cannot.
  const native = nativeSessionAvailable() ? dshNativeModels(readNativeCatalogModels()) : [];
  // The vision engine still resolves over routed candidates only. A native
  // engine is spent per-caller, and `vision-engines` wants each call site to
  // name its evidence; this one's is that a bridge read is issued by the router
  // on the caller's behalf, which is not the same as relaying their turn.
  const engine = resolveVisionEngine(() => selected, readVisionBridgeSettings());
  return { models: [...dshCatalogModels(selected, engine), ...native], engine };
}

function buildRoute() {
  const { models, engine } = dshRoutedModels();
  return { route: buildDshRoute({ models, baseUrl: callerBase() }), models, engine };
}

export function install({ setDefaultModel = false } = {}) {
  assertStateOwnership("write the DeepSeek Harness model catalog");
  const { route, models, engine } = buildRoute();
  if (!models.length) {
    throw new Error(
      "No routed models are selected, credentialed, and listed. Enable a provider first " +
        "(`./bin/providers enable PROVIDER`), then publish again.",
    );
  }

  const settingsBefore = readDocument(DSH_SETTINGS_PATH);
  let settingsAfter = applyRouteToSettings(settingsBefore, route);
  let defaultModel;
  if (setDefaultModel) {
    defaultModel = dshDefaultModel(models);
    snapshotDefaultModel(settingsBefore);
    settingsAfter = applyDefaultModel(settingsAfter, { model: defaultModel });
  }
  const credentialsAfter = applyCredential(
    readDocument(DSH_CREDENTIALS_PATH),
    DSH_CREDENTIAL_REF,
    routerCallerKey(),
  );

  writeDocument(DSH_CREDENTIALS_PATH, credentialsAfter);
  writeDocument(DSH_SETTINGS_PATH, settingsAfter);
  writeDocument(
    DSH_CATALOG_PATH,
    `${JSON.stringify(
      {
        version: 1,
        route: DSH_ROUTE_ID,
        models: models.map((model) => String(model.slug)),
        visionBridgeEngine: engine?.slug || null,
        defaultModel: defaultModel || null,
      },
      null,
      2,
    )}\n`,
  );

  const dropped = unmappableEfforts(models);
  return {
    settings: DSH_SETTINGS_PATH,
    credentials: DSH_CREDENTIALS_PATH,
    route: DSH_ROUTE_ID,
    models: models.length,
    visionBridgeEngine: engine?.slug || null,
    defaultModel: defaultModel || null,
    droppedEfforts: Object.fromEntries(dropped),
  };
}

export function uninstall() {
  const settingsBefore = readDocument(DSH_SETTINGS_PATH);
  const restored = restoreDefaultModel(removeRouteFromSettings(settingsBefore));
  if (existsSync(DSH_SETTINGS_PATH)) writeDocument(DSH_SETTINGS_PATH, restored.contents);
  if (existsSync(DSH_CREDENTIALS_PATH)) {
    writeDocument(
      DSH_CREDENTIALS_PATH,
      removeCredential(readDocument(DSH_CREDENTIALS_PATH), DSH_CREDENTIAL_REF),
    );
  }
  if (existsSync(DSH_CATALOG_PATH)) unlinkSync(DSH_CATALOG_PATH);
  return {
    settings: DSH_SETTINGS_PATH,
    credentials: DSH_CREDENTIALS_PATH,
    defaultModelRestored: restored.restored,
  };
}

// The caller key is the router's local capability, not a provider secret: it
// authorizes talking to 127.0.0.1 and nothing else. It still never appears in
// output — only in the 0600 credentials document the harness reads.
function routerCallerKey() {
  if (!existsSync(CALLER_SECRET_PATH)) {
    throw new Error("The local router caller key is missing; run ./bin/doctor --fix.");
  }
  return assertCallerSecret(readFileSync(CALLER_SECRET_PATH, "utf8").trim());
}

/**
 * Prints the `tool-subagent` composition block for a routed child model.
 *
 * The harness configures delegation in a preset's `agent.cordis.yml`, and
 * `dsh-tool-subagent` installs no settings section — so unlike the provider
 * route, there is no document the router may write this into. A preset is the
 * user's own composition; the router hands over exactly the lines to paste
 * rather than editing something it does not own.
 *
 * Without a block like this, a child simply inherits the default model
 * selection, which is already a routed model once this route is the default.
 * The block matters when a deployment wants children on a *different* routed
 * model from their parent.
 */
export function subagentPreset() {
  const { models } = dshRoutedModels();
  // The same proven set Codex's native spawn overrides draw from: a model
  // marked `multiAgentVersion: "v2"` has been through the collaboration probe,
  // and the user has not switched it off.
  const eligible = subagentEligibleModels(models, readMultiAgentSettings());
  const chosen = dshDefaultModel(eligible.length ? eligible : models);
  return {
    model: chosen || null,
    provenModels: eligible.map((model) => String(model.slug)),
    yaml: chosen
      ? [
          "- id: tool-subagent",
          "  name: '@deepseek-ai/dsh-tool-subagent'",
          "  config:",
          "    provider: spawn",
          "    toolName: subagent",
          "    backgroundMode: continuable",
          "    agentOptions:",
          `      provider: ${DSH_ROUTE_ID}`,
          `      model: ${chosen}`,
        ].join("\n")
      : null,
  };
}

export function status() {
  const settings = readDocument(DSH_SETTINGS_PATH);
  let route;
  let structureError;
  try {
    route = yamlNode(scanYamlDocument(settings), ROUTE_PATH);
  } catch (error) {
    structureError = error instanceof Error ? error.message : String(error);
  }
  const credentials = readDocument(DSH_CREDENTIALS_PATH);
  let credentialPresent = false;
  try {
    credentialPresent = Boolean(yamlNode(scanYamlDocument(credentials), [DSH_CREDENTIAL_REF]));
  } catch {
    credentialPresent = false;
  }
  let published;
  try {
    published = existsSync(DSH_CATALOG_PATH)
      ? JSON.parse(readFileSync(DSH_CATALOG_PATH, "utf8"))
      : undefined;
  } catch {
    published = undefined;
  }
  const { models } = dshRoutedModels();
  return {
    home: DSH_HOME,
    settings: DSH_SETTINGS_PATH,
    settingsExists: existsSync(DSH_SETTINGS_PATH),
    credentials: DSH_CREDENTIALS_PATH,
    credentialsExists: existsSync(DSH_CREDENTIALS_PATH),
    route: DSH_ROUTE_ID,
    routeInstalled: Boolean(route),
    credentialInstalled: credentialPresent,
    ...(structureError ? { structureError } : {}),
    publishedModels: published?.models?.length ?? 0,
    routableModels: models.length,
    // The base URL is a local authentication capability, so status reports the
    // redacted form exactly as the Codex manager does.
    baseUrl: existsSync(CALLER_SECRET_PATH) ? redactCallerUrl(callerBase()) : null,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] || "status";
  const handlers = {
    status: () => status(),
    install: () => install({ setDefaultModel: process.argv.includes("--set-default-model") }),
    uninstall: () => uninstall(),
    "subagent-preset": () => subagentPreset(),
  };
  const handler = handlers[command];
  if (!handler) {
    console.error(`Usage: dsh-config-manager ${Object.keys(handlers).join("|")}`);
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
