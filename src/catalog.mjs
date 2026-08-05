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
  CONFIG_PATH,
  MERGED_CATALOG_PATH,
  NATIVE_ALIAS_PATH,
  NATIVE_CATALOG_PATH,
} from "./paths.mjs";
import { codexAuthStatus, runCodex } from "./codex-binary.mjs";
import { syncRoutedCodexAgents } from "./codex-agent-catalog.mjs";
import { MODEL_BY_SLUG } from "./model-registry.mjs";
import { buildNativeAliasAssignments } from "./native-alias.mjs";
import { selectedConfiguredListedModels } from "./provider-selection.mjs";
import { assertStateOwnership } from "./state-owner.mjs";

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
  atomicJson(NATIVE_CATALOG_PATH, { models: parsed.models });
  return parsed;
}

function nativeCatalog() {
  if (!existsSync(NATIVE_CATALOG_PATH) || refresh) return captureNative();
  const parsed = JSON.parse(readFileSync(NATIVE_CATALOG_PATH, "utf8"));
  if (!parsed || !Array.isArray(parsed.models) || parsed.models.length === 0) {
    return captureNative();
  }
  return parsed;
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
  return Object.hasOwn(model, "supports_reasoning_summaries")
    ? model
    : { ...model, supports_reasoning_summaries: false };
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
    availability_nux: null,
    upgrade: null,
    supports_reasoning_summaries: false,
    default_reasoning_summary: "none",
    support_verbosity: false,
    default_verbosity: null,
    supports_search_tool: false,
    supports_image_detail_original: false,
    use_responses_lite: false,
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

function sortCatalogModels(models) {
  return [...models].sort((left, right) => {
    const priority = Number(left.priority ?? 999) - Number(right.priority ?? 999);
    return priority || String(left.slug).localeCompare(String(right.slug));
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
  const routedModels = selectedConfiguredListedModels();
  const native = nativeCatalog();
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
  const { models: merged, aliases } = loginFree
    ? buildLoginFreeCatalog(native, routedModels)
    : {
        models: buildMergedCatalog(native, routedModels, {
          includeNative: openaiAuthenticated,
        }),
        aliases: {},
      };
  atomicJson(MERGED_CATALOG_PATH, { models: merged });
  atomicJson(NATIVE_ALIAS_PATH, { version: 1, aliases });
  const routedAgents = syncRoutedCodexAgents(routedModels);
  process.stdout.write(
    `${JSON.stringify({
      path: MERGED_CATALOG_PATH,
      models: merged.length,
      routed_models: routedModels.length,
      routed_agents: routedAgents.length,
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
