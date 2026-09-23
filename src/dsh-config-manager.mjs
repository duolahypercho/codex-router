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
  PORTS,
  LEGACY_PORTS,
} from "./paths.mjs";
import { protectPrivateFile } from "./file-security.mjs";
import { refreshDshCallerCapabilityDocuments } from "./caller-key-client-refresh.mjs";
import {
  DSH_CREDENTIAL_REF,
  DSH_ROUTE_ID,
  buildDshRoute,
  dshDefaultModel,
  renderDshRouteLines,
  unmappableEfforts,
} from "./dsh-catalog.mjs";
import { readMultiAgentSettings, subagentEligibleModels } from "./multi-agent-state.mjs";
import { assertStateOwnership } from "./state-owner.mjs";
import { routedClientModels } from "./routed-client-models.mjs";
import {
  scanYamlDocument,
  spliceYamlBlock,
  unaccountedLines,
  yamlNode,
  yamlScalar,
} from "./yaml-structure.mjs";

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

// The mapping we are about to add a key beside must be one the lexer read
// whole. `children` holds only the mapping keys it could register, so a block
// sequence, a merge key, or a key the key grammar declines lives inside the
// node while being invisible there -- and the indent this manager copies off
// "the first sibling" is then that invisible key's *child*. Publishing into
// `providers:` holding `openrouter/free:` wrote `codex-router:` two columns
// too deep, nested inside the user's provider, while every status read agreed
// it went in cleanly. Refuse with the file untouched, as the rest of this
// module does.
function assertReadableMapping(document, node, label) {
  if (!node) return;
  const unreadable = unaccountedLines(document, node).filter(
    (line) => !/^\s*#/.test(line.text),
  );
  if (!unreadable.length) return;
  throw new Error(
    `Refusing to edit ${label}: line ${unreadable[0].index + 1} `
      + `(${unreadable[0].text.trim()}) is not a mapping entry this reader can account for.`,
  );
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
  assertReadableMapping(document, providers, "llm-pi-ai.providers");
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
    // One *registered* key is not the same as one key. Stop if anything else
    // lives here -- a sequence item, a merge key, a key the grammar declined,
    // or the user's own comment. Leaving an empty `providers:` behind is a
    // cosmetic cost; splicing the user's routes away is not recoverable.
    if (unaccountedLines(document, parent).length) break;
    removal = parent;
  }
  const lines = [...document.lines];
  lines.splice(removal.index, removal.endIndex - removal.index + 1);
  return joinLines(normalizeTrailing(lines));
}

// The harness's credentials document comes in two shapes. Current builds wrap
// the reference map in a small envelope; the builds this integration was first
// written against kept the map at the document root:
//
//   version: 1          DEEPSEEK_API_KEY: sk-…
//   refs:               OPENAI_API_KEY: sk-…
//     DEEPSEEK_API_KEY: sk-…
//
const CREDENTIAL_REFS_KEY = "refs";
const CREDENTIAL_VERSION_KEY = "version";

/**
 * Decides which of the two shapes a credentials document is written in.
 *
 * `refs` present settles it. Absent, `version` settles it the other way: that
 * is a current harness whose reference map has not been written yet, which is
 * exactly the state a first install meets and the one where guessing wrong is
 * silent — the harness resolves `apiKeyEnv` under `refs`, finds nothing, and
 * the route 401s with the key sitting one level too high. An empty document is
 * the same state with the envelope not yet written, so it adopts the current
 * shape too. Only a document already holding references at its root is read as
 * the legacy one, because there the evidence is in the file.
 */
function credentialEnvelope(document) {
  const refs = document.root.children.get(CREDENTIAL_REFS_KEY);
  if (refs) {
    if (refs.inline) {
      throw new Error(
        `Refusing to edit the harness credentials document: "${CREDENTIAL_REFS_KEY}" is written ` +
          "as an inline value rather than a block.",
      );
    }
    return { refs, wrapped: true };
  }
  return {
    refs: undefined,
    wrapped:
      document.root.children.has(CREDENTIAL_VERSION_KEY) || document.root.children.size === 0,
  };
}

/** The key path this document keeps `reference` at, in whichever shape it is. */
function credentialPath(document, reference) {
  return credentialEnvelope(document).wrapped ? [CREDENTIAL_REFS_KEY, reference] : [reference];
}

// A multi-line value is legal in both shapes (the harness round-trips those), a
// nested mapping is not: that is a different document wearing this file's name,
// and rewriting it would be a guess. The envelope adds one legal level of
// nesting and not one byte more, so its own entries are held to the same rule —
// a `refs:` holding `server:\n  host: …` is somebody's configuration file, not
// a reference map, however much the top of it matches.
function assertCredentialDocument(document, refs) {
  const nested = (owner) => {
    throw new Error(
      `Refusing to edit the harness credentials document: "${owner}" holds a nested mapping, ` +
        "so this file is not a credential reference document.",
    );
  };
  for (const node of document.root.children.values()) {
    if (node === refs) {
      for (const entry of refs.children.values()) {
        if (entry.children.size) nested(`${CREDENTIAL_REFS_KEY}.${entry.key}`);
      }
      continue;
    }
    if (node.children.size) nested(node.key);
  }
}

function withoutNode(document, node) {
  const lines = [...document.lines];
  lines.splice(node.index, node.endIndex - node.index + 1);
  return lines;
}

/**
 * Sets one credential reference in the harness's credentials document.
 *
 * Both shapes are written in place; neither is converted into the other, since
 * the shape belongs to the harness build that reads the file. Anything that is
 * not a reference map in either shape — a nested mapping at the root, a nested
 * mapping inside `refs`, an inline `refs` — is refused with the file untouched.
 */
export function applyCredential(contents, reference, value) {
  const initial = scanYamlDocument(contents);
  const { wrapped } = credentialEnvelope(initial);
  assertCredentialDocument(initial, initial.root.children.get(CREDENTIAL_REFS_KEY));

  // A build of this router from before the envelope was understood wrote our
  // own reference at the root of a document the harness reads through `refs`.
  // That copy is ours, it sits where the harness never looks, and leaving it
  // would put a second copy of the caller key on disk — one no uninstall of
  // that era would find again. Take it out; nothing else is touched.
  const misplaced = wrapped ? yamlNode(initial, [reference]) : undefined;
  const document = misplaced
    ? scanYamlDocument(withoutNode(initial, misplaced).join("\n"))
    : initial;

  const refs = wrapped ? document.root.children.get(CREDENTIAL_REFS_KEY) : undefined;
  // Follow whatever indentation the envelope already uses for a sibling
  // reference rather than assuming two spaces, for the same reason
  // `applyRouteToSettings` does — except that here it is not merely untidy:
  // `refs.indent + 2` is the column of the `refs:` key itself, so a document
  // whose entries are indented four spaces would be handed a two-space sibling,
  // and that mixed-indent block is not YAML any parser will read back. The
  // whole file is the harness's credential store, so the loss would be every
  // adapter's key, not ours.
  assertReadableMapping(document, refs, `the harness credentials document's "${CREDENTIAL_REFS_KEY}"`);
  const sibling = refs && [...refs.children.values()][0];
  const indent = wrapped
    ? " ".repeat(sibling ? sibling.indent : (refs ? refs.indent : 0) + 2)
    : "";
  const rendered = [`${indent}${reference}: ${yamlScalar(value)}`];
  const path = wrapped ? [CREDENTIAL_REFS_KEY, reference] : [reference];
  return joinLines(normalizeTrailing(spliceYamlBlock(document, path, rendered)));
}

/**
 * Removes one credential reference, leaving every other entry in place.
 *
 * Every place this router may have written its own reference goes: the
 * envelope entry, and — on a document a pre-envelope build wrote into — the
 * stray root-level one beside it. A `refs:` key left holding nothing goes with
 * it, exactly as `removeRouteFromSettings` prunes an emptied `providers:`. An
 * empty mapping there is not the same as an absent one, since the harness reads
 * a valueless key as null rather than as "no references".
 */
export function removeCredential(contents, reference) {
  let text = String(contents ?? "");
  for (;;) {
    const document = scanYamlDocument(text);
    const node =
      yamlNode(document, [CREDENTIAL_REFS_KEY, reference]) || yamlNode(document, [reference]);
    if (!node) return joinLines(normalizeTrailing(document.lines));
    let removal = node;
    if (node.path.length > 1) {
      const parent = yamlNode(document, [CREDENTIAL_REFS_KEY]);
      if (
        parent &&
        parent.children.size === 1 &&
        !unaccountedLines(document, parent).length
      ) {
        removal = parent;
      }
    }
    // Each pass removes at least one line, so this terminates.
    text = withoutNode(document, removal).join("\n");
  }
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

/**
 * The routed models the harness should be offered, vision bridge included.
 *
 * The rule is not the harness's own -- what may be published to a client that
 * carries no ChatGPT session of its own, after the user's one-time router-plane
 * authorization, is the same question for every such client -- so it lives in
 * `routed-client-models.mjs` and both integrations read it. Two copies would
 * drift, and the way that shows is one picker offering a model the other just
 * lost.
 */
export function dshRoutedModels() {
  return routedClientModels();
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
  // The same repository-certified set Codex's native spawn overrides draw
  // from: a v2 route has an accepted native-collaboration application (or an
  // exact pre-workflow grandfathered identity), and the user has not switched
  // it off. Machine-local compatibility probes never enter this set.
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

export function refreshCallerCapability() {
  assertStateOwnership("refresh the DeepSeek Harness caller capability");
  const refreshed = refreshDshCallerCapabilityDocuments({ settings: readDocument(DSH_SETTINGS_PATH), credentials: readDocument(DSH_CREDENTIALS_PATH), baseUrl: callerBase(), secret: routerCallerKey(), port: PORTS.router, legacyPort: LEGACY_PORTS.router });
  writeDocument(DSH_CREDENTIALS_PATH, refreshed.credentials);
  writeDocument(DSH_SETTINGS_PATH, refreshed.settings);
  return { refreshed: true, settings: DSH_SETTINGS_PATH, credentials: DSH_CREDENTIALS_PATH };
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
    // Resolved through the same shape decision the writer makes, so this can
    // never report a credential the harness cannot read: a key at the root of
    // an enveloped document is present on disk and absent to the harness, and
    // reporting that as installed turns a missing credential into a 401 with
    // no diagnostic anywhere.
    const document = scanYamlDocument(credentials);
    credentialPresent = Boolean(yamlNode(document, credentialPath(document, DSH_CREDENTIAL_REF)));
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
    "caller-capability-refresh": () => refreshCallerCapability(),
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
