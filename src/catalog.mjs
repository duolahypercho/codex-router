import { execFileSync } from "node:child_process";
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
  NATIVE_CATALOG_PATH,
} from "./paths.mjs";
import { requireCodexBinary } from "./codex-binary.mjs";
import { MODEL_BY_SLUG } from "./model-registry.mjs";
import { selectedListedModels } from "./provider-selection.mjs";

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
    output = execFileSync(requireCodexBinary(), args, {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    if (bundled) throw error;
    output = execFileSync(requireCodexBinary(), ["debug", "models", "--bundled"], {
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
    multi_agent_version: "v1",
  };
  if (typeof next.base_instructions === "string") {
    next.base_instructions = rewriteIdentity(next.base_instructions, model);
  }
  if (next.model_messages) {
    next.model_messages = rewriteModelMessages(next.model_messages, model);
  }
  return next;
}

export function buildMergedCatalog(native, routedModelsList) {
  const template =
    native.models.find((model) => model.slug === "gpt-5.5") ||
    native.models.find((model) => model.visibility === "list") ||
    native.models[0];
  if (!template) {
    throw new Error("Native model catalog is empty.");
  }
  const models = new Map(native.models.map((model) => [model.slug, model]));
  for (const model of routedModelsList) {
    models.set(model.slug, routedModel(template, model));
  }
  return [...models.values()].sort((left, right) => {
    const priority = Number(left.priority ?? 999) - Number(right.priority ?? 999);
    return priority || String(left.slug).localeCompare(String(right.slug));
  });
}

function main() {
  const routedModels = selectedListedModels();
  const native = nativeCatalog();
  const merged = buildMergedCatalog(native, routedModels);
  atomicJson(MERGED_CATALOG_PATH, { models: merged });
  process.stdout.write(
    `${JSON.stringify({
      path: MERGED_CATALOG_PATH,
      models: merged.length,
      routed_models: routedModels.length,
      selected_model: selectedModel() || null,
    })}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
