import { readFileSync } from "node:fs";
import path from "node:path";

import {
  IMPLEMENTED_VERTEX_ADAPTERS,
  VERTEX_ADAPTERS,
} from "./vertex-adapters.mjs";
import { SOURCE_ROOT } from "./paths.mjs";

export const VERTEX_SUPPORT_CATALOG_PATH =
  process.env.MODEL_ROUTER_VERTEX_SUPPORT_CATALOG ||
  path.join(SOURCE_ROOT, "config", "vertex", "support-catalog.json");

const EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const TOP_LEVEL_FIELDS = new Set(["version", "models"]);
const MODEL_FIELDS = new Set([
  "id",
  "adapter",
  "publisher",
  "displayName",
  "description",
  "priority",
  "capabilities",
]);
const CAPABILITY_FIELDS = new Set([
  "contextWindow",
  "autoCompact",
  "inputModalities",
  "reasoningLevels",
  "defaultEffort",
]);
const MODALITIES = new Set(["text", "image"]);

function fail(source, message) {
  throw new Error(`Invalid Vertex support catalog ${source}: ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknownFields(value, fields, label, source) {
  for (const field of Object.keys(value)) {
    if (!fields.has(field)) fail(source, `${label} has unsupported field ${field}`);
  }
}

function parseReasoningLevels(value, label, source) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(source, `${label} requires reasoningLevels`);
  }
  const seen = new Set();
  return value.map((level, index) => {
    if (!isRecord(level)) fail(source, `${label} reasoningLevels[${index}] must be an object`);
    rejectUnknownFields(
      level,
      new Set(["effort", "description"]),
      `${label} reasoningLevels[${index}]`,
      source,
    );
    if (typeof level.effort !== "string" || !EFFORTS.has(level.effort)) {
      fail(source, `${label} reasoningLevels[${index}] has an unsupported effort`);
    }
    if (seen.has(level.effort)) {
      fail(source, `${label} reasoningLevels repeats ${level.effort}`);
    }
    if (typeof level.description !== "string" || !level.description.trim()) {
      fail(source, `${label} reasoningLevels[${index}] requires a description`);
    }
    seen.add(level.effort);
    return Object.freeze({ effort: level.effort, description: level.description });
  });
}

function parseCapabilities(value, label, source) {
  if (!isRecord(value)) fail(source, `${label} capabilities must be an object`);
  rejectUnknownFields(value, CAPABILITY_FIELDS, `${label} capabilities`, source);
  for (const field of CAPABILITY_FIELDS) {
    if (!(field in value)) fail(source, `${label} capabilities requires ${field}`);
  }
  if (!Number.isInteger(value.contextWindow) || value.contextWindow < 1) {
    fail(source, `${label} requires a positive contextWindow`);
  }
  if (
    !Number.isInteger(value.autoCompact) ||
    value.autoCompact < 1 ||
    value.autoCompact > value.contextWindow
  ) {
    fail(source, `${label} requires a valid autoCompact limit`);
  }
  if (
    !Array.isArray(value.inputModalities) ||
    value.inputModalities.length === 0 ||
    value.inputModalities.some((modality) => !MODALITIES.has(modality)) ||
    new Set(value.inputModalities).size !== value.inputModalities.length
  ) {
    fail(source, `${label} requires supported inputModalities`);
  }
  const reasoningLevels = parseReasoningLevels(value.reasoningLevels, label, source);
  if (
    typeof value.defaultEffort !== "string" ||
    !reasoningLevels.some((level) => level.effort === value.defaultEffort)
  ) {
    fail(source, `${label} defaultEffort must be one of its reasoningLevels`);
  }
  return Object.freeze({
    contextWindow: value.contextWindow,
    autoCompact: value.autoCompact,
    inputModalities: Object.freeze([...value.inputModalities]),
    reasoningLevels: Object.freeze(reasoningLevels),
    defaultEffort: value.defaultEffort,
  });
}

export function parseVertexSupportCatalog(value, source = VERTEX_SUPPORT_CATALOG_PATH) {
  if (!isRecord(value)) fail(source, "root must be an object");
  rejectUnknownFields(value, TOP_LEVEL_FIELDS, "root", source);
  if (value.version !== 1) fail(source, "version must be 1");
  if (!Array.isArray(value.models) || value.models.length === 0) {
    fail(source, "models must be a non-empty array");
  }

  const ids = new Set();
  const models = value.models.map((model, index) => {
    const label = `models[${index}]`;
    if (!isRecord(model)) fail(source, `${label} must be an object`);
    rejectUnknownFields(model, MODEL_FIELDS, label, source);
    for (const field of ["id", "adapter", "displayName", "description"]) {
      if (typeof model[field] !== "string" || !model[field].trim()) {
        fail(source, `${label} requires ${field}`);
      }
    }
    if (model.id.includes("/")) {
      fail(source, `${label} id must not contain /`);
    }
    if (model.publisher !== undefined && (
      typeof model.publisher !== "string" ||
      !model.publisher.trim() ||
      /[\u0000-\u001f\u007f/?#\\]/.test(model.publisher)
    )) {
      fail(source, `${label} has an invalid publisher`);
    }
    if (ids.has(model.id)) fail(source, `duplicate model id ${model.id}`);
    if (!Number.isInteger(model.priority)) {
      fail(source, `${label} requires an integer priority`);
    }
    ids.add(model.id);
    return Object.freeze({
      id: model.id,
      adapter: model.adapter,
      ...(model.publisher !== undefined ? { publisher: model.publisher } : {}),
      displayName: model.displayName,
      description: model.description,
      priority: model.priority,
      capabilities: parseCapabilities(model.capabilities, label, source),
    });
  });
  return Object.freeze({ version: 1, models: Object.freeze(models) });
}

export function readVertexSupportCatalog(file = VERTEX_SUPPORT_CATALOG_PATH) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(file, error instanceof Error ? error.message : String(error));
  }
  return parseVertexSupportCatalog(parsed, file);
}

export function vertexAdapterFor(model) {
  return VERTEX_ADAPTERS[model?.adapter];
}

export function vertexAdapterIsImplemented(adapter) {
  return Object.hasOwn(VERTEX_ADAPTERS, adapter);
}

export { IMPLEMENTED_VERTEX_ADAPTERS };
