import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { protectPrivateFile } from "./file-security.mjs";
import {
  ANNOUNCED_MODELS_PATH,
  CONFIG_PATH,
  MERGED_CATALOG_PATH,
  NATIVE_ALIAS_PATH,
  NATIVE_CATALOG_PATH,
} from "./paths.mjs";
import { codexAuthStatus, codexVersion, runCodex } from "./codex-binary.mjs";
import { readUserModels } from "./user-models.mjs";
import { syncRoutedCodexAgents } from "./codex-agent-catalog.mjs";
import { MODEL_BY_SLUG } from "./model-registry.mjs";
import {
  applyMultiAgentSettings,
  readMultiAgentSettings,
} from "./multi-agent-state.mjs";
import { readHiddenModels } from "./model-picker-state.mjs";
import { buildNativeAliasAssignments } from "./native-alias.mjs";
import { selectedConfiguredListedModels } from "./provider-selection.mjs";
import { assertStateOwnership } from "./state-owner.mjs";
import { applyVisionBridge, resolveVisionEngine } from "./vision-bridge.mjs";
import { readVisionBridgeSettings } from "./vision-bridge-state.mjs";
import { nativeVisionEngines } from "./vision-engines.mjs";

const refresh = process.argv.includes("--refresh-native");
const bundled = process.argv.includes("--bundled-native");

function atomicJson(target, value) {
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  protectPrivateFile(temporary);
  renameSync(temporary, target);
  protectPrivateFile(target);
}

function captureNative() {
  const args = ["debug", "models"];
  if (bundled) args.push("--bundled");
  let output;
  try {
    output = runCodex(args, {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    if (bundled) throw error;
    output = runCodex(["debug", "models", "--bundled"], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 32 * 1024 * 1024,
    });
  }
  const parsed = JSON.parse(output);
  if (!parsed || !Array.isArray(parsed.models) || parsed.models.length === 0) {
    throw new Error("Codex returned an empty or invalid model catalog.");
  }
  if (parsed.models.some((model) => MODEL_BY_SLUG.has(String(model.slug)))) {
    throw new Error(
      "Refusing to capture an already-merged catalog. Disable the router before refreshing native models.",
    );
  }
  const capturedWith = codexVersion();
  atomicJson(NATIVE_CATALOG_PATH, {
    ...(capturedWith ? { captured_with: capturedWith } : {}),
    models: parsed.models,
  });
  return parsed;
}

// A native capture is only trustworthy for the Codex build that produced it:
// newer builds can require catalog fields the older build never emitted, or
// carry different capability values for the same slug. An unknown current
// version keeps the cache — with no binary to re-ask, stale is the best we
// have.
export function nativeCatalogIsReusable(parsed, currentVersion) {
  if (!parsed || !Array.isArray(parsed.models) || parsed.models.length === 0) {
    return false;
  }
  return !currentVersion || parsed.captured_with === currentVersion;
}

function nativeCatalog() {
  if (!existsSync(NATIVE_CATALOG_PATH) || refresh) return captureNative();
  const parsed = JSON.parse(readFileSync(NATIVE_CATALOG_PATH, "utf8"));
  if (nativeCatalogIsReusable(parsed, codexVersion())) return parsed;
  try {
    return captureNative();
  } catch (error) {
    // Version-mismatched is still better than empty: serve the stale capture
    // when the re-capture fails, but say so instead of hiding it.
    if (parsed && Array.isArray(parsed.models) && parsed.models.length > 0) {
      console.error(
        `Could not refresh the native model catalog (${error.message}); reusing the cached capture.`,
      );
      return parsed;
    }
    throw error;
  }
}

// Codex's picker deserializes reasoning efforts into a fixed enum and
// silently drops any level it does not recognize, so a curated "max" level
// simply vanishes from the effort menu on builds whose enum ends at xhigh
// (issue #57). No runtime probe can see this: config parsing accepts unknown
// effort strings, and `debug models` passes catalog levels through as plain
// strings even on builds whose picker cannot offer them. The enum history is
// the only reliable signal — max and ultra joined in 0.143.0 (verified
// against the published binaries: 0.142.5 lacks the serde variants, 0.143.0
// carries them), and the baseline predates this router. An unknown version
// clamps: a wrongly clamped Max still routes at full effort under the xhigh
// label, while a wrongly emitted max is exactly the missing-picker-entry bug.
const BASELINE_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];
const EFFORT_LADDER = [...BASELINE_EFFORTS, "max", "ultra"];
const MAX_EFFORT_SINCE = [0, 143, 0];

export function codexEffortVocabulary(version) {
  const match = /(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.]+)?/.exec(String(version || ""));
  if (!match) return new Set(BASELINE_EFFORTS);
  const installed = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let index = 0; index < 3; index += 1) {
    if (installed[index] > MAX_EFFORT_SINCE[index]) return new Set(EFFORT_LADDER);
    if (installed[index] < MAX_EFFORT_SINCE[index]) return new Set(BASELINE_EFFORTS);
  }
  // Exactly the boundary release: prereleases of it may predate the variants.
  return match[4] ? new Set(BASELINE_EFFORTS) : new Set(EFFORT_LADDER);
}

function clampEffort(effort, vocabulary) {
  if (vocabulary.has(effort)) return effort;
  const start = EFFORT_LADDER.indexOf(effort);
  // Off-ladder values cannot be ranked, so pass them through unchanged.
  if (start === -1) return effort;
  for (let index = start - 1; index >= 0; index -= 1) {
    if (vocabulary.has(EFFORT_LADDER[index])) return EFFORT_LADDER[index];
  }
  return effort;
}

// Registry levels are ordered lightest-first, so when a clamped level lands on
// an effort the model already offers (xhigh + max both become xhigh), the
// genuine entry keeps its slot and the clamped duplicate is dropped.
export function clampModelEfforts(models, vocabulary) {
  return models.map((model) => {
    if (!Array.isArray(model.reasoningLevels)) return model;
    const levels = [];
    const seen = new Set();
    for (const level of model.reasoningLevels) {
      const effort = clampEffort(level.effort, vocabulary);
      if (seen.has(effort)) continue;
      seen.add(effort);
      levels.push(effort === level.effort ? level : { ...level, effort });
    }
    const defaultEffort = clampEffort(model.defaultEffort, vocabulary);
    if (
      defaultEffort === model.defaultEffort &&
      levels.length === model.reasoningLevels.length &&
      levels.every((level, index) => level === model.reasoningLevels[index])
    ) {
      return model;
    }
    return { ...model, reasoningLevels: levels, defaultEffort };
  });
}

function selectedModel() {
  if (!existsSync(CONFIG_PATH)) return undefined;
  const config = readFileSync(CONFIG_PATH, "utf8");
  const firstTable = config.search(/^\s*\[/m);
  const root = firstTable === -1 ? config : config.slice(0, firstTable);
  return root.match(/^\s*model\s*=\s*["\']([^"\']+)["\']/m)?.[1];
}

// Login-free mode routes everything through the external providers, so native
// GPT slugs are unusable there even when a ChatGPT credential file exists.
// Mode toggles pass the desired state via MODEL_ROUTER_LOGIN_FREE because they
// rebuild the catalog before rewriting the Codex config.
function loginFreeConfigured() {
  const override = process.env.MODEL_ROUTER_LOGIN_FREE;
  if (override === "1") return true;
  if (override === "0") return false;
  if (!existsSync(CONFIG_PATH)) return false;
  const config = readFileSync(CONFIG_PATH, "utf8");
  const firstTable = config.search(/^\s*\[/m);
  const root = firstTable === -1 ? config : config.slice(0, firstTable);
  return root.match(/^\s*model_provider\s*=\s*["\']([^"\']+)["\']/m)?.[1] === "codex-router";
}

function identityName(model) {
  const displayName = String(model.displayName || "").trim();
  if (displayName) {
    return displayName.replace(/\s*\((?:OAuth|API)\)\s*$/i, "").trim() || displayName;
  }
  const slug = String(model.slug || "").trim();
  const bare = slug.includes("/") ? slug.slice(slug.indexOf("/") + 1) : slug;
  return bare || "an external model";
}

function rewriteIdentity(text, model) {
  if (typeof text !== "string" || !text) return text;
  const name = identityName(model);
  return text
    .replace(
      /\b(?:a coding agent|an agent) based on GPT-5\b/g,
      `a coding agent based on ${name}`,
    )
    .replace(/\bbased on GPT-5\b/g, `based on ${name}`);
}

function rewriteModelMessages(messages, model) {
  if (!messages || typeof messages !== "object" || Array.isArray(messages)) {
    return messages;
  }
  const next = { ...messages };
  if (typeof next.instructions_template === "string") {
    next.instructions_template = rewriteIdentity(next.instructions_template, model);
  }
  return next;
}

function normalizeNativeModel(model) {
  return {
    ...model,
    supports_reasoning_summaries:
      typeof model.supports_reasoning_summaries === "boolean"
        ? model.supports_reasoning_summaries
        : false,
  };
}

export function routedModel(template, model) {
  const next = {
    ...template,
    slug: model.slug,
    display_name: model.displayName,
    description: model.description,
    priority: model.priority,
    visibility: "list",
    supported_in_api: true,
    default_reasoning_level: model.defaultEffort,
    supported_reasoning_levels: model.reasoningLevels,
    context_window: model.contextWindow,
    max_context_window: model.contextWindow,
    effective_context_window_percent: 95,
    auto_compact_token_limit: model.autoCompact,
    input_modalities: model.inputModalities,
    comp_hash: model.compHash,
    additional_speed_tiers: [],
    service_tiers: [],
    // Codex surfaces this once per slug (up to its own show cap) as the
    // "Introducing {model}" announcement; absent copy must stay null so the
    // client never renders an empty card.
    availability_nux:
      typeof model.availabilityNux === "string" && model.availabilityNux.trim()
        ? { message: model.availabilityNux.trim() }
        : null,
    // Codex renders the markdown as the whole "Codex just got an upgrade"
    // modal when this entry is the operator's current model and the target
    // slug is listed; {model_from}/{model_to} are substituted by the client.
    upgrade: model.upgradeTo
      ? {
          model: model.upgradeTo.model,
          migration_markdown: model.upgradeTo.markdown.trim(),
        }
      : null,
    supports_reasoning_summaries: model.supportsReasoningSummaries === true,
    default_reasoning_summary:
      model.supportsReasoningSummaries === true
        ? model.defaultReasoningSummary || "auto"
        : "none",
    support_verbosity: false,
    default_verbosity: null,
    // Capability toggles come from the registry entry, never from the native
    // template: an absent flag keeps the conservative default so a routed
    // model only advertises what its slug's gateway path actually verified.
    // "hosted" is the only search mode the request path can serve today (the
    // provider backend runs the search server-side, as the Grok OAuth
    // forwarder does); the registry loader rejects anything else.
    supports_search_tool: model.searchTool?.mode === "hosted",
    supports_image_detail_original: model.supportsImageDetailOriginal === true,
    use_responses_lite: false,
    // Codex only knows one ApplyPatchToolType variant. The native template
    // carries "freeform", but upstreams that reject OpenAI custom tools (Meta
    // Responses, for example) must opt out explicitly; null is the only value
    // that suppresses the tool without making the catalog unparseable.
    apply_patch_tool_type: model.supportsApplyPatchTool === false ? null : "freeform",
    // Codex v2 collaboration only exposes spawn_agent model overrides whose
    // catalog entry advertises the same backend version as the parent. Models
    // opt in after their tool and encrypted-payload relay paths are verified.
    multi_agent_version: model.multiAgentVersion || "v1",
  };
  if (typeof next.base_instructions === "string") {
    next.base_instructions = rewriteIdentity(next.base_instructions, model);
  }
  if (next.model_messages) {
    next.model_messages = rewriteModelMessages(next.model_messages, model);
  }
  return next;
}

export function applyAllMultiAgent(models, enabled) {
  if (!enabled) return models;
  return models.map((model) => ({ ...model, multiAgentVersion: "v2" }));
}

export const AUTO_ANNOUNCE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function formatTokenCount(tokens) {
  if (tokens >= 995_000) {
    const millions = Math.round((tokens / 1_000_000) * 10) / 10;
    return `${millions % 1 === 0 ? Math.round(millions) : millions}M`;
  }
  return `${Math.round(tokens / 1000)}K`;
}

function joinNaturally(parts) {
  if (parts.length <= 1) return parts.join("");
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

// Announcement copy is assembled from verified registry capabilities only, so
// it can never claim more than the picker metadata already does.
function autoAnnouncementCopy(model) {
  const details = [];
  if (Number.isInteger(model.contextWindow)) {
    details.push(`a ${formatTokenCount(model.contextWindow)}-token context window`);
  }
  const efforts = Array.isArray(model.reasoningLevels)
    ? model.reasoningLevels.map((level) => level.effort)
    : [];
  if (efforts.length > 1) {
    details.push(`reasoning efforts from ${efforts[0]} to ${efforts[efforts.length - 1]}`);
  }
  if ((model.inputModalities || []).includes("image")) {
    details.push("image input");
  }
  const capabilities = details.length ? ` It comes with ${joinNaturally(details)}.` : "";
  return `${model.displayName} just landed in your model picker.${capabilities}`;
}

// A new checked-in model announces itself for a window of rebuilds rather
// than a single one, because catalogs rebuild on updates and provider toggles
// and the operator may not launch Codex in between; Codex itself stops the
// card after four showings per slug. The first capture seeds silently so an
// install never announces the entire catalog, and locally curated models are
// excluded because the operator added those deliberately. Only models whose
// provider is selected and credentialed ever reach this list, so a model the
// operator cannot use never announces.
export function annotateNewModelAnnouncements(routedModelsList, announcedAt, userSlugs, now) {
  const firstRun = announcedAt === null;
  const nextAnnouncedAt = new Map(firstRun ? [] : announcedAt);
  const models = routedModelsList.map((model) => {
    if (!nextAnnouncedAt.has(model.slug)) {
      nextAnnouncedAt.set(model.slug, firstRun ? 0 : now);
    }
    if (model.availabilityNux || userSlugs.has(model.slug)) return model;
    const since = nextAnnouncedAt.get(model.slug);
    if (since === 0 || now - since >= AUTO_ANNOUNCE_WINDOW_MS) return model;
    return { ...model, availabilityNux: autoAnnouncementCopy(model) };
  });
  return { models, announcedAt: nextAnnouncedAt };
}

function readAnnouncedAt() {
  if (!existsSync(ANNOUNCED_MODELS_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(ANNOUNCED_MODELS_PATH, "utf8"));
    if (!parsed || typeof parsed.models !== "object" || Array.isArray(parsed.models)) {
      return null;
    }
    return new Map(
      Object.entries(parsed.models).filter(([, value]) => Number.isFinite(value)),
    );
  } catch {
    // Corrupt state must reseed silently, not announce the whole catalog.
    return null;
  }
}

function writeAnnouncedAt(announcedAt) {
  atomicJson(ANNOUNCED_MODELS_PATH, {
    version: 1,
    models: Object.fromEntries([...announcedAt.entries()].sort()),
  });
}

function sortCatalogModels(models) {
  return [...models].sort((left, right) => {
    const priority = Number(left.priority ?? 999) - Number(right.priority ?? 999);
    return priority || String(left.slug).localeCompare(String(right.slug));
  });
}

// Native entries carry upstream's static multi_agent_version, and upstream
// still ships gpt-5.6-luna as "v1" even though it runs correctly on the v2
// backend (openai/codex#35097, #36294). spawn_agent filters candidate child
// models on that static value, so a v1 entry can never be delegated to by a v2
// parent. applyMultiAgentSettings only reaches routed models, which is why
// "all" mode never promoted the native slugs; apply the same opt-in here so the
// subagent modes mean what the Settings tab says they mean.
export function promoteNativeMultiAgent(models, settings, hidden = new Set()) {
  const enabled = new Set(settings.enabled || []);
  const disabled = new Set(settings.disabled || []);
  return models.map((model) => {
    const slug = String(model.slug);
    if (model.visibility !== "list") return model;
    if (hidden.has(slug) || disabled.has(slug)) return model;
    if (settings.mode === "all" || (settings.mode === "selected" && enabled.has(slug))) {
      return { ...model, multi_agent_version: "v2" };
    }
    return model;
  });
}

export function buildMergedCatalog(native, routedModelsList, { includeNative = true } = {}) {
  const template =
    native.models.find((model) => model.slug === "gpt-5.5") ||
    native.models.find((model) => model.visibility === "list") ||
    native.models[0];
  if (!template) {
    throw new Error("Native model catalog is empty.");
  }
  const models = new Map(
    includeNative
      ? native.models.map((model) => [model.slug, normalizeNativeModel(model)])
      : [],
  );
  for (const model of routedModelsList) {
    models.set(model.slug, routedModel(template, model));
  }
  return sortCatalogModels(models.values());
}

// Login-free Codex surfaces only list allowlisted native slugs, so external
// models are republished under those slugs with their own names and reasoning
// levels. Each aliased model keeps a hidden entry under its canonical slug so
// routing, doctor checks, and existing configs keep resolving it.
export function buildLoginFreeCatalog(native, routedModelsList) {
  const assignments = buildNativeAliasAssignments(native.models, routedModelsList);
  const aliasedSlugs = new Set(assignments.map(({ model }) => model.slug));
  const aliases = Object.fromEntries(
    assignments.map(({ nativeModel, model }) => [nativeModel.slug, model.slug]),
  );
  const models = [
    ...assignments.map(({ nativeModel, model }) => ({
      ...routedModel(nativeModel, model),
      slug: nativeModel.slug,
      priority: nativeModel.priority,
    })),
    ...buildMergedCatalog(native, routedModelsList, { includeNative: false }).map(
      (model) =>
        aliasedSlugs.has(model.slug) ? { ...model, visibility: "hide" } : model,
    ),
  ];
  return { models: sortCatalogModels(models), aliases };
}

function main() {
  // The catalog is what Codex offers in its picker. Writing it from a checkout
  // that does not own this state directory is how the picker ends up
  // advertising models the running gateway has no route for.
  assertStateOwnership("write the Codex model catalog");
  const userSlugs = new Set(readUserModels().map((model) => String(model.slug)));
  const hiddenModels = readHiddenModels();
  const selectedModels = selectedConfiguredListedModels();
  const allMultiAgentModels = applyMultiAgentSettings(
    selectedModels,
    readMultiAgentSettings(),
    hiddenModels,
  );
  // Clamp before announcements and agent sync so every surface Codex reads —
  // picker levels, defaults, and announcement copy — stays inside the effort
  // vocabulary the installed build can actually deserialize.
  const { models: routedModels, announcedAt } = annotateNewModelAnnouncements(
    clampModelEfforts(allMultiAgentModels, codexEffortVocabulary(codexVersion())),
    readAnnouncedAt(),
    userSlugs,
    Date.now(),
  );
  const captured = nativeCatalog();
  const native = {
    ...captured,
    models: promoteNativeMultiAgent(
      captured.models,
      readMultiAgentSettings(),
      hiddenModels,
    ),
  };
  // Dropping every native model is destructive, so only do it when Codex
  // actually answered that the session is signed out. If the probe could not
  // run at all we do not know, and guessing "signed out" is what silently
  // emptied the picker for Windows npm installs.
  const auth = codexAuthStatus();
  if (auth.reason === "probe-failed") {
    throw new Error(
      `Could not ask Codex whether it is signed in (${auth.code || "spawn failed"} running ${auth.binary}). ` +
        "Refusing to rebuild the catalog, because assuming a signed-out session would remove every native model. " +
        "Set CODEX_BIN to a runnable Codex CLI and try again.",
    );
  }
  const openaiAuthenticated = auth.authenticated;
  const loginFree = loginFreeConfigured();
  // Advertised last, and only while an engine actually resolves: Codex gates
  // the paste on `input_modalities`, so a bridge that has gone away must take
  // the advertisement with it rather than leaving a paste that 400s. This runs
  // after the announcement pass so a bridged model never announces "image
  // input" as though it grew the capability itself.
  //
  // Native models join the candidate list only once the auth probe says the
  // session can actually spend them. A login-free install routes every turn
  // away from the native backend, so nominating a native engine there would
  // promise image input the router cannot deliver.
  // The one shared rule (`src/vision-engines.mjs`). This is the only caller
  // that can name the gate from the probe itself: it is the process that runs
  // the probe, and it is building the merged catalog every other caller reads
  // the verdict back out of.
  const nativeEngines = nativeVisionEngines({
    models: captured.models,
    hidden: hiddenModels,
    authorized: openaiAuthenticated && !loginFree,
  });
  const visionEngine = resolveVisionEngine(
    () => [...selectedModels, ...nativeEngines],
    readVisionBridgeSettings(),
  );
  const catalogModels = applyVisionBridge(routedModels, visionEngine);
  const { models: merged, aliases } = loginFree
    ? buildLoginFreeCatalog(native, catalogModels)
    : {
        models: buildMergedCatalog(native, catalogModels, {
          includeNative: openaiAuthenticated,
        }),
        aliases: {},
      };
  atomicJson(MERGED_CATALOG_PATH, {
    models: merged.map((model) =>
      hiddenModels.has(String(model.slug))
        ? { ...model, visibility: "hide" }
        : model,
    ),
  });
  atomicJson(NATIVE_ALIAS_PATH, { version: 1, aliases });
  writeAnnouncedAt(announcedAt);
  const routedAgents = syncRoutedCodexAgents(routedModels);
  process.stdout.write(
    `${JSON.stringify({
      path: MERGED_CATALOG_PATH,
      models: merged.length,
      routed_models: routedModels.length,
      routed_agents: routedAgents.length,
      vision_bridge_engine: visionEngine?.slug || null,
      vision_bridged_models: catalogModels.filter(
        (model) => model.visionBridgeEngine !== undefined,
      ).length,
      native_models: !loginFree && openaiAuthenticated
        ? merged.filter((model) => !MODEL_BY_SLUG.has(String(model.slug))).length
        : 0,
      aliased_models: Object.keys(aliases).length,
      login_free: loginFree,
      openai_authenticated: openaiAuthenticated,
      openai_auth_reason: auth.reason,
      selected_model: selectedModel() || null,
    })}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    // Ownership conflicts are an operator mistake with a specific remedy, so
    // print the guidance rather than a stack trace.
    if (error?.code === "foreign_state_owner") {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}
