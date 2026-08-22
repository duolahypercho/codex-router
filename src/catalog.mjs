import { createHash } from "node:crypto";
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

import { protectPrivateFile } from "./file-security.mjs";
import { isManagedCallerBaseUrl } from "./caller-auth.mjs";
import { applyInstructionOverlay } from "./instruction-overlays.mjs";
import {
  ANNOUNCED_MODELS_PATH,
  CONFIG_PATH,
  MERGED_CATALOG_PATH,
  MODELS_CACHE_PATH,
  NATIVE_ALIAS_PATH,
  NATIVE_CATALOG_PATH,
} from "./paths.mjs";
import { codexAuthStatus, codexVersion, runCodex } from "./codex-binary.mjs";
import { readUserModels } from "./user-models.mjs";
import { syncRoutedCodexAgents } from "./codex-agent-catalog.mjs";
import { MODEL_BY_SLUG } from "./model-registry.mjs";
import {
  applyMultiAgentCapabilities,
  readMultiAgentSettings,
  subagentEligibleModels,
} from "./multi-agent-state.mjs";
import {
  migrateLegacyVisibleModels,
  modelPickerSnapshot,
  readHiddenModels,
  seedModelsHidden,
} from "./model-picker-state.mjs";
import { buildNativeAliasAssignments } from "./native-alias.mjs";
import {
  NATIVE_CONTEXT_VARIANT_SLUGS,
  withNativeContextVariants,
} from "./native-context-variants.mjs";
import { selectedConfiguredListedModels, configuredProviderIds } from "./provider-selection.mjs";
import { assertStateOwnership } from "./state-owner.mjs";
import { scanTomlDocument, tomlStringValue } from "./toml-structure.mjs";
import { applyVisionBridge, resolveVisionEngine } from "./vision-bridge.mjs";
import { readVisionBridgeSettings } from "./vision-bridge-state.mjs";
import { nativeVisionEngines } from "./vision-engines.mjs";
import {
  readNativeCatalogFile,
  readNativeCatalogSource,
} from "./native-catalog-source.mjs";
import { discoveryDisabled } from "./discovery-mode.mjs";
import { withCatalogPublicationLock } from "./catalog-publication-lock.mjs";

const refresh = process.argv.includes("--refresh-native");

function validNativeCatalog(parsed) {
  return parsed && Array.isArray(parsed.models) && parsed.models.length > 0;
}

// The account cache stores the raw instruction template while the bundled
// catalog ships `base_instructions` with the template variables already
// substituted: for every shared slug that carries variables, the bundled
// `base_instructions` equals the account template with `{{ personality }}`
// replaced by `instructions_variables.personality_default`. Mirror that
// substitution — and strip any placeholder without a default — so a literal
// `{{ ... }}` token can never reach a model's system prompt.
const INSTRUCTION_PLACEHOLDER = /\{\{\s*([\w.-]+)\s*\}\}/g;

export function deriveBaseInstructions(modelMessages) {
  const template = modelMessages?.instructions_template;
  if (typeof template !== "string") return undefined;
  const variables = modelMessages?.instructions_variables;
  const substituted = template.replace(INSTRUCTION_PLACEHOLDER, (_token, name) => {
    const fallback = variables?.[`${name}_default`];
    return typeof fallback === "string" ? fallback : "";
  });
  // A default could itself contain a placeholder; the guarantee is that none
  // survive, not that substitution is recursive.
  return substituted.replace(INSTRUCTION_PLACEHOLDER, "");
}

// Codex has two native catalogs: the account-aware catalog (`debug models`)
// and the static catalog shipped in the binary (`--bundled`). Neither is a
// safe source by itself. The account catalog can add models or change their
// visibility without a client update, while the bundled catalog can contain a
// newer schema or models absent from a stale account cache. Preserve the
// account entry for every slug it lists (first occurrence wins on a
// duplicate), then append bundled-only entries.
export function mergeNativeCatalogs(accountCatalog, bundledCatalog) {
  const account = validNativeCatalog(accountCatalog) ? accountCatalog.models : [];
  const fallback = validNativeCatalog(bundledCatalog) ? bundledCatalog.models : [];
  const fallbackBySlug = new Map(
    fallback.map((model) => [String(model?.slug || ""), model]),
  );
  const normalizedAccount = [];
  const seen = new Set();
  for (const model of account) {
    const slug = String(model?.slug || "");
    if (seen.has(slug)) continue;
    seen.add(slug);
    const base = fallbackBySlug.get(slug);
    const merged = mergeNativeModel(model, base);
    // The remote cache may omit `base_instructions` because Codex can derive
    // it internally. A custom model_catalog_json is parsed more strictly and
    // requires the field, so derive it the same way for account-only models
    // such as Codex Spark.
    if (typeof merged.base_instructions !== "string") {
      const derived = deriveBaseInstructions(merged.model_messages);
      if (typeof derived === "string") merged.base_instructions = derived;
    }
    normalizedAccount.push(merged);
  }
  return {
    models: [
      ...normalizedAccount,
      ...fallback.filter((model) => !seen.has(String(model?.slug || ""))),
    ],
  };
}

function isEmptyNativeMetadata(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

// Only fields where an empty account value can never be a deliberate account
// narrowing may be backfilled from the bundled catalog. Each entry earns its
// place: the speed/service tiers are the observed bug (a stale account schema
// wiped the Fast tier), `input_modalities: []` would describe a model nothing
// can call, and the tool/instruction fields are binary-schema data the account
// cache merely mirrors. Deliberately absent: `visibility` (the account's own
// signal, always non-empty in practice but not worth betting on) and
// `supported_reasoning_levels` (an account that lost an effort ladder is
// expressing exactly that — resurrecting bundled's ladder would offer efforts
// the account cannot spend).
const BUNDLED_BACKFILL_FIELDS = Object.freeze([
  "additional_speed_tiers",
  "service_tiers",
  "input_modalities",
  "experimental_supported_tools",
  "include_apps_usage_instructions",
  "model_messages",
]);

// The account catalog may use an older schema and publish empty fields for
// capabilities already present in the current binary. Preserve the non-empty
// bundled value for the allowlisted schema fields in that case; a non-empty
// account value always remains authoritative.
export function mergeNativeModel(accountModel, bundledModel) {
  if (!bundledModel) return { ...accountModel };

  const merged = { ...bundledModel, ...accountModel };
  for (const field of BUNDLED_BACKFILL_FIELDS) {
    const value = bundledModel[field];
    if (
      !isEmptyNativeMetadata(value) &&
      isEmptyNativeMetadata(accountModel[field])
    ) {
      merged[field] = value;
    }
  }
  return merged;
}

// One read serves both the catalog contents and the fingerprint; reading the
// file twice would hash a possibly different snapshot than the one merged.
function readModelsCache() {
  const missing = { catalog: undefined, fingerprint: undefined };
  if (!existsSync(MODELS_CACHE_PATH)) return missing;
  try {
    const parsed = JSON.parse(readFileSync(MODELS_CACHE_PATH, "utf8"));
    if (!validNativeCatalog(parsed)) return missing;
    return {
      catalog: parsed,
      fingerprint: createHash("sha256")
        .update(JSON.stringify(parsed.models))
        .digest("hex"),
    };
  } catch {
    return missing;
  }
}

function atomicContents(target, contents) {
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp.${process.pid}`;
  writeFileSync(temporary, contents, {
    encoding: "utf8",
    mode: 0o600,
  });
  protectPrivateFile(temporary);
  renameSync(temporary, target);
  protectPrivateFile(target);
}

function atomicJson(target, value) {
  atomicContents(target, `${JSON.stringify(value, null, 2)}\n`);
}

function fileSnapshot(target) {
  return existsSync(target)
    ? { present: true, contents: readFileSync(target, "utf8") }
    : { present: false };
}

function restoreFileSnapshot(target, snapshot) {
  if (snapshot.present) {
    atomicContents(target, snapshot.contents);
  } else if (existsSync(target)) {
    unlinkSync(target);
  }
}

function captureNative(cache) {
  // A discovery-disabled install promised that nothing account-derived is
  // read: `debug models` without --bundled reflects the signed-in account's
  // catalog, and `models_cache.json` is that same catalog written to disk, so
  // both stay untouched and the bundled static list is the whole capture.
  // This is the gate SECURITY.md's "the one Codex spawn that remains is
  // `codex debug models --bundled`" claim rests on.
  const idle = discoveryDisabled();
  const resolved = cache ?? (idle ? {} : readModelsCache());
  // This is the account-aware catalog Codex itself cached after signing in.
  // Reading it directly also avoids asking `codex debug models` while the
  // router catalog is active, which would merely return our own merged output.
  let account = resolved.catalog;
  let fallback;
  let accountError;
  let fallbackError;
  if (!account && !idle) {
    try {
      account = JSON.parse(runCodex(["debug", "models"], {
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 32 * 1024 * 1024,
      }));
    } catch (error) {
      accountError = error;
    }
  }
  // The bundled source supplies schema fields that the remote cache is allowed
  // to omit, so use both when available. If it fails, account-only entries are
  // still normalized above and remain preferable to an empty picker.
  try {
    fallback = JSON.parse(runCodex(["debug", "models", "--bundled"], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 32 * 1024 * 1024,
    }));
  } catch (error) {
    fallbackError = error;
  }
  const parsed = mergeNativeCatalogs(account, fallback);
  if (!validNativeCatalog(parsed)) {
    const detail = accountError?.message || fallbackError?.message;
    throw new Error(
      `Codex returned no valid native model catalog${detail ? ` (${detail})` : ""}.`,
    );
  }
  if (parsed.models.some((model) => MODEL_BY_SLUG.has(String(model.slug)))) {
    throw new Error(
      "Refusing to capture an already-merged catalog. Disable the router before refreshing native models.",
    );
  }
  const capturedWith = codexVersion();
  const sourceFingerprint = cache.fingerprint;
  atomicJson(NATIVE_CATALOG_PATH, {
    ...(capturedWith ? { captured_with: capturedWith } : {}),
    ...(sourceFingerprint ? { native_source_fingerprint: sourceFingerprint } : {}),
    models: parsed.models,
  });
  return parsed;
}

// A native capture is only trustworthy for the Codex build that produced it:
// newer builds can require catalog fields the older build never emitted, or
// carry different capability values for the same slug. An unknown current
// version keeps the cache — with no binary to re-ask, stale is the best we
// have.
export function nativeCatalogIsReusable(
  parsed,
  currentVersion,
  currentSourceFingerprint = undefined,
) {
  if (!parsed || !Array.isArray(parsed.models) || parsed.models.length === 0) {
    return false;
  }
  if (currentVersion && parsed.captured_with !== currentVersion) return false;
  if (
    currentSourceFingerprint &&
    parsed.native_source_fingerprint !== currentSourceFingerprint
  ) {
    return false;
  }
  return true;
}

function nativeCatalog() {
  const source = readNativeCatalogSource();
  if (source) {
    const catalog = readNativeCatalogFile(source.path);
    if (!catalog) {
      throw new Error(
        `Configured native model catalog is unavailable or invalid: ${source.path}`,
      );
    }
    return catalog;
  }
  // `models_cache.json` is the signed-in account's catalog written to disk,
  // so a discovery-disabled install leaves it unread like every other
  // account-derived artifact.
  const cache = discoveryDisabled() ? {} : readModelsCache();
  if (!existsSync(NATIVE_CATALOG_PATH) || refresh) return captureNative(cache);
  const parsed = JSON.parse(readFileSync(NATIVE_CATALOG_PATH, "utf8"));
  if (nativeCatalogIsReusable(parsed, codexVersion(), cache.fingerprint)) {
    return parsed;
  }
  try {
    return captureNative(cache);
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
  try {
    const document = scanTomlDocument(readFileSync(CONFIG_PATH, "utf8"));
    return tomlStringValue(document, [], "model_provider") === "codex-router";
  } catch {
    return false;
  }
}

// A merged catalog is useful only when the selected Codex transport reaches
// this router. The built-in OpenAI provider uses the managed root base URL;
// the dedicated signed provider carries the same URL explicitly. Any other
// custom provider (for example a configuration switcher) owns the endpoint and
// would make external picker entries misleading.
export function routedCatalogConfigured(contents, override = process.env.MODEL_ROUTER_SIGNED_ROUTING) {
  if (override === "1") return true;
  if (override === "0") return false;
  try {
    const document = scanTomlDocument(contents);
    const provider = tomlStringValue(document, [], "model_provider");
    if (!provider || provider === "openai") {
      const baseUrl = tomlStringValue(document, [], "openai_base_url");
      // Before first install there is no managed URL yet, but the catalog
      // still has to be buildable. Once an URL is present, only the caller-
      // capability endpoint proves that OpenAI traffic reaches this router.
      return baseUrl === undefined || isManagedCallerBaseUrl(baseUrl);
    }

    const providerPath = ["model_providers", provider];
    const directTables = document.headers.filter(
      ({ path: tablePath }) =>
        tablePath.length === providerPath.length &&
        tablePath.every((part, index) => part === providerPath[index]),
    );
    if (directTables.length !== 1) return false;
    const baseUrl = tomlStringValue(document, providerPath, "base_url");
    return Boolean(baseUrl && isManagedCallerBaseUrl(baseUrl));
  } catch {
    return false;
  }
}

function routedCatalogActive() {
  const contents = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : "";
  return routedCatalogConfigured(contents);
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
      /\b(?:a coding agent|an agent) based on GPT-5(?:\.\d+)?(?:[-\s](?:Sol|Terra|Luna))?\b/gi,
      `a coding agent based on ${name}`,
    )
    .replace(/\bbased on GPT-5(?:\.\d+)?(?:[-\s](?:Sol|Terra|Luna))?\b/gi, `based on ${name}`);
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

const NATIVE_PARALLEL_TOOL_CALL_COMPAT = new Map([["gpt-5.2", true]]);

function normalizeNativeModel(model) {
  const supportsParallelToolCalls =
    typeof model.supports_parallel_tool_calls === "boolean"
      ? model.supports_parallel_tool_calls
      : NATIVE_PARALLEL_TOOL_CALL_COMPAT.get(String(model.slug)) ?? false;
  return {
    ...model,
    // Recent Codex clients require this field on every catalog entry. An
    // absent native declaration is not evidence that parallel calls work, so
    // make the conservative answer explicit instead of leaving the catalog
    // unparsable.
    supports_parallel_tool_calls: supportsParallelToolCalls,
    supports_reasoning_summaries:
      typeof model.supports_reasoning_summaries === "boolean"
        ? model.supports_reasoning_summaries
        : false,
  };
}

export function routedModel(template, model, behaviorTemplate = template) {
  const behaviorModelMessages =
    behaviorTemplate?.model_messages &&
    typeof behaviorTemplate.model_messages === "object" &&
    !Array.isArray(behaviorTemplate.model_messages)
      ? behaviorTemplate.model_messages
      : template.model_messages;
  const derivedBehaviorInstructions = deriveBaseInstructions(behaviorModelMessages);
  const behaviorInstructions =
    typeof behaviorTemplate?.base_instructions === "string" &&
    behaviorTemplate.base_instructions.trim()
      ? behaviorTemplate.base_instructions
      : typeof derivedBehaviorInstructions === "string" &&
          derivedBehaviorInstructions.trim()
        ? derivedBehaviorInstructions
        : template.base_instructions;
  const next = {
    ...template,
    base_instructions: behaviorInstructions,
    model_messages: behaviorModelMessages,
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
    service_tiers: Array.isArray(model.serviceTiers)
      ? model.serviceTiers.map((tier) => ({
          id: tier.id.trim(),
          name: tier.name.trim(),
          ...(typeof tier.description === "string" && tier.description.trim()
            ? { description: tier.description.trim() }
            : {}),
        }))
      : [],
    // Never inherit a native template's paid tier as the routed default.
    // Declared tiers are opt-in choices; standard provider service stays the
    // default until a separate, validated default is intentionally supported.
    default_service_tier: null,
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
    // Both search paths are explicit registry capabilities. Hosted search is
    // executed by the provider backend; standalone search is executed by
    // Codex and its result is replayed through the routed conversation. An
    // absent declaration remains the conservative default.
    supports_search_tool: ["hosted", "standalone"].includes(model.searchTool?.mode),
    supports_image_detail_original: model.supportsImageDetailOriginal === true,
    // A routed model must never inherit a native template's capability. Codex
    // now requires the key, and `false` is both schema-valid and conservative
    // until this exact provider/model route declares support.
    supports_parallel_tool_calls: model.supportsParallelToolCalls === true,
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
  // Native GPT-5.6 templates may carry this transport/tool-mode switch. It is
  // not a routed capability and must stay out even when that native entry is
  // also the conservative fallback template.
  delete next.tool_mode;
  // ClinePass strips these unsupported request controls, so Codex must not offer them.
  if (model.requestProfile === "clinepass") {
    delete next.default_reasoning_level;
    delete next.supported_reasoning_levels;
  }
  // A few OpenAI-compatible upstreams reject tool scheduling the native
  // template advertises. Registry entries opt out explicitly so the picker
  // never offers a custom or parallel tool the provider backend will 400.
  if (Array.isArray(model.experimentalSupportedTools)) {
    next.experimental_supported_tools = [...model.experimentalSupportedTools];
  }
  if (typeof next.base_instructions === "string") {
    next.base_instructions = applyInstructionOverlay(
      rewriteIdentity(next.base_instructions, model),
      model.instructionOverlay,
    );
  }
  if (next.model_messages) {
    next.model_messages = rewriteModelMessages(next.model_messages, model);
    if (typeof next.model_messages?.instructions_template === "string") {
      next.model_messages.instructions_template = applyInstructionOverlay(
        next.model_messages.instructions_template,
        model.instructionOverlay,
      );
    }
  }
  return next;
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

// Native entries carry upstream's static multi_agent_version. One pinned
// backend exception is maintained in the repository after upstream evidence;
// local selection or a stream/tool probe must never promote any other v1
// model. That avoids turning a UI toggle into an unreviewed v2 assertion.
const NATIVE_V2_BACKEND_SLUGS = new Set(["gpt-5.6-luna"]);

// Keep the repository/upstream verdict separate from the effective catalog
// value. Hiding or disabling a certified native route correctly publishes it
// as v1, but that opt-out must not erase the certificate the control surfaces
// need in order to let the operator turn it back on.
export function nativeSubagentCertification(model) {
  const slug = String(model?.slug || "");
  if (NATIVE_CONTEXT_VARIANT_SLUGS.includes(slug)) return "v1";
  if (NATIVE_V2_BACKEND_SLUGS.has(slug)) return "v2";
  return model?.multi_agent_version === "v2" || model?.multi_agent_version === "v1"
    ? model.multi_agent_version
    : undefined;
}

export function promoteNativeMultiAgent(models, settings, hidden = new Set()) {
  const enabled = new Set(settings.enabled || []);
  const disabled = new Set(settings.disabled || []);
  return models.map((model) => {
    const slug = String(model.slug);
    // Extended-context aliases are manual parent-model choices, not distinct
    // child-agent backends. Keep them out of spawn_agent model overrides so
    // delegated work uses the base model's default context window.
    if (NATIVE_CONTEXT_VARIANT_SLUGS.includes(slug)) {
      return { ...model, multi_agent_version: "v1" };
    }
    if (model.visibility !== "list") return model;
    if (hidden.has(slug) || disabled.has(slug)) {
      return { ...model, multi_agent_version: "v1" };
    }
    if (nativeSubagentCertification(model) === "v2") {
      return { ...model, multi_agent_version: "v2" };
    }
    // Deliberately do not use `mode` / `enabled` to promote a native model.
    // Settings may opt an existing certificate out, not create one.
    void enabled;
    void settings;
    return model;
  });
}

function behaviorTemplateFor(nativeModels, model, fallback) {
  if (!model.behaviorTemplate) return fallback;
  return nativeModels.find((candidate) => candidate.slug === model.behaviorTemplate) || fallback;
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
    const behaviorTemplate = behaviorTemplateFor(native.models, model, template);
    models.set(model.slug, routedModel(template, model, behaviorTemplate));
  }
  return sortCatalogModels(models.values());
}

// Login-free Codex surfaces only list allowlisted native slugs, so external
// models are republished under those slugs with their own names and reasoning
// levels. Each aliased model keeps a hidden entry under its canonical slug so
// routing, doctor checks, and existing configs keep resolving it.
//
// Only providers with a live credential may take a whitelist slot: the slot is
// what a signed-out desktop picker offers, and a model whose provider cannot
// authenticate would occupy it with requests that fail on the first turn. The
// merged-catalog path filters through `selectedConfiguredListedModels()`; this
// function keeps the same rule for the login-free path instead of trusting its
// caller to pre-filter, so no future call site can publish dead slots again.
export function buildLoginFreeCatalog(native, routedModelsList) {
  const configured = new Set(configuredProviderIds());
  const usableModels = routedModelsList.filter(
    (model) => !model.provider || configured.has(model.provider),
  );
  const assignments = buildNativeAliasAssignments(native.models, usableModels);
  const aliasedSlugs = new Set(assignments.map(({ model }) => model.slug));
  const aliases = Object.fromEntries(
    assignments.map(({ nativeModel, model }) => [nativeModel.slug, model.slug]),
  );
  const models = [
    ...assignments.map(({ nativeModel, model }) => ({
      ...routedModel(
        nativeModel,
        model,
        behaviorTemplateFor(native.models, model, nativeModel),
      ),
      slug: nativeModel.slug,
      priority: nativeModel.priority,
    })),
    ...buildMergedCatalog(native, usableModels, { includeNative: false }).map(
      (model) =>
        aliasedSlugs.has(model.slug) ? { ...model, visibility: "hide" } : model,
    ),
  ];
  return { models: sortCatalogModels(models), aliases };
}

// A signed-in Codex catalog contains two policy domains: the account's native
// entries and the router's routed entries. Keep the router overlay off native
// base slugs so stale external picker state cannot erase Codex's original
// picker. Login-free mode deliberately aliases external models onto those
// slugs, so it is the one mode where the overlay applies to all entries.
export function effectivePickerHiddenModels(hiddenModels, nativeBaseSlugs, { loginFree = false } = {}) {
  const hidden = new Set([...hiddenModels || []].map((slug) => String(slug)));
  if (loginFree) return hidden;
  const native = new Set([...nativeBaseSlugs || []].map((slug) => String(slug)));
  return new Set([...hidden].filter((slug) => !native.has(slug)));
}

function main() {
  // The catalog is what Codex offers in its picker. Writing it from a checkout
  // that does not own this state directory is how the picker ends up
  // advertising models the running gateway has no route for.
  assertStateOwnership("write the Codex model catalog");
  const userSlugs = new Set(readUserModels().map((model) => String(model.slug)));
  const selectedModels = selectedConfiguredListedModels();
  const loginFree = loginFreeConfigured();
  // Before the picker state is read, not after: new router models are opt-in
  // in a normal signed-in Codex install.  Curation or a picker "show" action
  // records the positive selection; simply enabling a provider or updating a
  // catalog must not make every one of its models appear.  The same one-time
  // seeding also keeps extended-window variants off because they cost more per
  // turn than the base model they shadow.  Login-free mode is different: its
  // native-looking slots are router aliases and retain the existing behavior.
  // Only slugs with no recorded decision are touched, so no later rebuild can
  // undo an operator's choice.
  const routedSeedSlugs = loginFree ? [] : selectedModels.map((model) => String(model.slug));
  // First, though: an install that predates the allowlist recorded only what
  // was switched off, so its routed models are absent from `seeded` and the
  // opt-in default below would read "visible, never written down" as "never
  // decided" and empty the picker on the first rebuild after an update
  // (issue #338). This writes the old answer down once, for those slugs only,
  // and is a no-op on a fresh install and on every later rebuild.  Native
  // context variants are deliberately not offered to it: they have never been
  // visible by default under either set of semantics.
  migrateLegacyVisibleModels(routedSeedSlugs);
  seedModelsHidden([...NATIVE_CONTEXT_VARIANT_SLUGS, ...routedSeedSlugs]);
  const hiddenModels = readHiddenModels();
  const pickerState = modelPickerSnapshot();
  const visibleModels = new Set(pickerState.visible);
  const multiAgentSettings = readMultiAgentSettings();
  // Settings can disable a certified route, but machine-local proof records
  // are diagnostic only: neither a compatibility probe nor an observed child
  // turn may manufacture a v2 claim. That capability belongs to the exact
  // checked-in registry route and its reviewed v2_agent application.
  const allMultiAgentModels = applyMultiAgentCapabilities(
    selectedModels,
    multiAgentSettings,
    { hidden: hiddenModels },
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
  // The router picker overlay is for routed models.  In a normal signed-in
  // Codex install the account's native entries remain Codex-owned; applying a
  // stale router `hidden` decision to them can erase the original Codex picker
  // (for example after a previous "hide all" action).  Login-free mode is the
  // exception: its native slugs are deliberately aliases for routed models,
  // so the overlay remains authoritative there.
  const nativeBaseSlugs = new Set(captured.models.map((model) => String(model.slug || "")));
  const effectiveHiddenModels = effectivePickerHiddenModels(
    hiddenModels,
    nativeBaseSlugs,
    { loginFree },
  );
  const native = {
    ...captured,
    // Variants join before the multi-agent pass so the extended-context alias
    // can remain manually selectable while being forced parent-only; delegated
    // work must use the base model's default context window.
    models: promoteNativeMultiAgent(
      withNativeContextVariants(captured.models, { enabled: !loginFree }),
      multiAgentSettings,
      effectiveHiddenModels,
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
  const routedCatalog = routedCatalogActive();
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
    hidden: effectiveHiddenModels,
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
        models: buildMergedCatalog(native, routedCatalog ? catalogModels : [], {
          includeNative: openaiAuthenticated,
        }),
        aliases: {},
      };
  const snapshots = new Map(
    [MERGED_CATALOG_PATH, NATIVE_ALIAS_PATH, ANNOUNCED_MODELS_PATH]
      .map((target) => [target, fileSnapshot(target)]),
  );
  let routedAgents;
  try {
    atomicJson(NATIVE_ALIAS_PATH, { version: 1, aliases });
    writeAnnouncedAt(announcedAt);
    atomicJson(MERGED_CATALOG_PATH, {
      models: merged.map((model) => {
        const slug = String(model.slug);
        // In login-free mode a native-looking slot is an alias for a routed
        // model, so visibility follows the canonical routed slug that the
        // operator selected. Normal signed-in native base entries remain
        // client-owned and are never removed by router picker state.
        const policySlug = aliases[slug] || slug;
        const routerManaged = loginFree || !nativeBaseSlugs.has(slug);
        const hidden = effectiveHiddenModels.has(policySlug);
        // A state file written by the new picker carries positive selections.
        // Older installs had only `hidden`; preserve their behavior until an
        // operator makes a picker change, at which point the write records the
        // explicit allowlist permanently.
        const selected = pickerState.hasExplicitVisibility
          ? visibleModels.has(policySlug)
          : !hidden;
        return routerManaged && (hidden || !selected)
          ? { ...model, visibility: "hide" }
          : model;
      }),
    });
    if (process.env.MODEL_ROUTER_TEST_FAIL_AFTER_CATALOG_WRITE === "1") {
      throw new Error("Forced failure after model catalog publication.");
    }
    // Codex offers every file in the agents directory by name, so a model
    // switched off as a subagent needs its definition gone as well. Without
    // this, switching it off changes multi_agent_version and nothing else, and
    // the model still answers when it is spawned by name.
    routedAgents = syncRoutedCodexAgents(
      routedCatalog || loginFree
        ? subagentEligibleModels(routedModels, multiAgentSettings)
        : [],
    );
  } catch (error) {
    const restoreErrors = [];
    for (const [target, snapshot] of [...snapshots].reverse()) {
      try {
        restoreFileSnapshot(target, snapshot);
      } catch (restoreError) {
        restoreErrors.push(restoreError);
      }
    }
    if (restoreErrors.length) {
      throw new AggregateError(
        [error, ...restoreErrors],
        "Model catalog update failed and its previous files could not be restored.",
      );
    }
    if (error && typeof error === "object") error.catalogRollbackSafe = true;
    throw error;
  }
  process.stdout.write(
    `${JSON.stringify({
      path: MERGED_CATALOG_PATH,
      models: merged.length,
      routed_models: routedModels.length,
      routed_agents: routedAgents.written.length,
      removed_agents: routedAgents.removed.length,
      vision_bridge_engine: visionEngine?.slug || null,
      vision_bridged_models: catalogModels.filter(
        (model) => model.visionBridgeEngine !== undefined,
      ).length,
      native_models: !loginFree && openaiAuthenticated
        ? merged.filter((model) => !MODEL_BY_SLUG.has(String(model.slug))).length
        : 0,
      aliased_models: Object.keys(aliases).length,
      login_free: loginFree,
      routed_catalog_active: routedCatalog || loginFree,
      openai_authenticated: openaiAuthenticated,
      openai_auth_reason: auth.reason,
      selected_model: selectedModel() || null,
    })}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    // The lock begins before the first ownership or mutable-state read and is
    // released only after probes and the coupled catalog-file transaction are
    // complete. Every app/CLI/autonomous caller executes this same entrypoint.
    await withCatalogPublicationLock(main);
  } catch (error) {
    // Ownership conflicts are an operator mistake with a specific remedy, so
    // print the guidance rather than a stack trace.
    if (error?.code === "foreign_state_owner") {
      console.error(error.message);
      process.exit(1);
    }
    // Exit 75 tells an orchestrating mode switch that the requested catalog
    // was not published and every prior catalog file was restored. A generic
    // failure cannot make that guarantee and must leave the router transport
    // active until a native-only catalog can be proven.
    if (error?.catalogRollbackSafe) {
      console.error(error.message);
      process.exit(75);
    }
    throw error;
  }
}
