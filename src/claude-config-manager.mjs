import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { assertCallerSecret, secretEqual } from "./caller-auth.mjs";
import { protectPrivateFile } from "./file-security.mjs";
import {
  CALLER_SECRET_PATH,
  CLAUDE_CONFIG_BACKUP_PATH,
  CLAUDE_CONFIG_LIBRARY_DIR,
  CLAUDE_CONFIG_META_PATH,
  CLAUDE_CONFIG_STATE_PATH,
  PORTS,
  STATE_DIR,
  TARGET,
  loopback,
} from "./paths.mjs";
import { claudeRoleAssignments } from "./claude-role-map.mjs";

const command = process.argv[2] || "status";
const allowedCommands = new Set(["enable", "disable", "refresh", "status"]);
const entryName = "Model Router (Claude)";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

if (TARGET !== "claude") {
  throw new Error("claude-config-manager.mjs requires MODEL_ROUTER_TARGET=claude.");
}
if (!allowedCommands.has(command)) {
  console.error("Usage: claude-config-manager.mjs enable|disable|refresh|status");
  process.exit(2);
}

function readJson(target, fallback) {
  if (!existsSync(target)) return fallback;
  try {
    return JSON.parse(readFileSync(target, "utf8"));
  } catch (error) {
    throw new Error(
      `Refusing to replace malformed Claude configuration at ${target}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function validMeta(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.appliedId === "string" &&
    Array.isArray(value.entries) &&
    value.entries.every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        uuidPattern.test(entry.id || "") &&
        typeof entry.name === "string" &&
        entry.name,
    )
  );
}

function readMeta() {
  const meta = readJson(CLAUDE_CONFIG_META_PATH, { appliedId: "", entries: [] });
  if (!validMeta(meta)) {
    throw new Error(
      `Refusing to replace an unrecognized Claude configuration library at ${CLAUDE_CONFIG_META_PATH}.`,
    );
  }
  return meta;
}

function readState() {
  const state = readJson(CLAUDE_CONFIG_STATE_PATH, undefined);
  if (!state) return undefined;
  if (
    state.version !== 1 ||
    !uuidPattern.test(state.entryId || "") ||
    typeof state.enabled !== "boolean"
  ) {
    throw new Error(`Invalid Claude router state at ${CLAUDE_CONFIG_STATE_PATH}.`);
  }
  return state;
}

function atomicJson(target, value, mode = 0o600) {
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(target), 0o700);
  const temporary = `${target}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode,
  });
  try {
    protectPrivateFile(temporary);
    renameSync(temporary, target);
    protectPrivateFile(target);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

function configuredCallerKey() {
  if (!existsSync(CALLER_SECRET_PATH)) {
    throw new Error("The Claude caller key is missing; run the Claude installer first.");
  }
  return assertCallerSecret(readFileSync(CALLER_SECRET_PATH, "utf8").trim());
}

function entryPath(entryId) {
  return path.join(CLAUDE_CONFIG_LIBRARY_DIR, `${entryId}.json`);
}

function routerConfiguration(callerKey) {
  return {
    inferenceProvider: "gateway",
    inferenceCredentialKind: "static",
    inferenceGatewayBaseUrl: loopback(PORTS.router),
    inferenceGatewayApiKey: callerKey,
    inferenceGatewayAuthScheme: "bearer",
    modelDiscoveryEnabled: false,
    inferenceModels: claudeRoleAssignments().map(({ roleId, model }) => ({
      name: roleId,
      labelOverride: model.displayName,
      ...(model.contextWindow >= 1_000_000 ? { supports1m: true } : {}),
    })),
    chatTabEnabled: true,
    toolSearchEnabled: false,
  };
}

function configurationMatches(configuration, callerKey) {
  const models = Array.isArray(configuration?.inferenceModels)
    ? configuration.inferenceModels
    : (() => {
        try {
          const parsed = JSON.parse(configuration?.inferenceModels || "null");
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      })();
  const requiredModels = new Set(claudeRoleAssignments().map(({ roleId }) => roleId));
  const configuredModels = new Set(
    models.map((model) => (typeof model === "string" ? model : model?.name)).filter(Boolean),
  );
  return (
    configuration?.inferenceProvider === "gateway" &&
    configuration?.inferenceGatewayBaseUrl === loopback(PORTS.router) &&
    configuration?.inferenceGatewayAuthScheme === "bearer" &&
    secretEqual(configuration?.inferenceGatewayApiKey, callerKey) &&
    requiredModels.size > 0 &&
    [...requiredModels].every((model) => configuredModels.has(model))
  );
}

function status() {
  let state;
  let meta;
  try {
    state = readState();
    meta = readMeta();
  } catch (error) {
    return {
      mode: "invalid",
      configured: false,
      applied: false,
      error: error instanceof Error ? error.message : String(error),
      library: CLAUDE_CONFIG_LIBRARY_DIR,
    };
  }
  if (!state) {
    return {
      mode: "native",
      configured: false,
      applied: false,
      library: CLAUDE_CONFIG_LIBRARY_DIR,
    };
  }
  const target = entryPath(state.entryId);
  if (!state.enabled && !existsSync(target) && meta.appliedId !== state.entryId) {
    return {
      mode: "native",
      configured: false,
      applied: false,
      entryId: state.entryId,
      gateway: loopback(PORTS.router),
      library: CLAUDE_CONFIG_LIBRARY_DIR,
    };
  }
  let configuration;
  try {
    configuration = readJson(target, undefined);
  } catch {
    configuration = undefined;
  }
  let callerKey;
  try {
    callerKey = configuredCallerKey();
  } catch {
    callerKey = undefined;
  }
  const configured = Boolean(callerKey && configurationMatches(configuration, callerKey));
  const applied = meta.appliedId === state.entryId;
  return {
    mode: configured && applied ? "router" : configured ? "configured" : "invalid",
    configured,
    applied,
    entryId: state.entryId,
    modelCount: Array.isArray(configuration?.inferenceModels)
      ? configuration.inferenceModels.length
      : undefined,
    gateway: loopback(PORTS.router),
    library: CLAUDE_CONFIG_LIBRARY_DIR,
  };
}

function enable() {
  const callerKey = configuredCallerKey();
  const metaExisted = existsSync(CLAUDE_CONFIG_META_PATH);
  const meta = readMeta();
  let state = readState();
  if (!state) {
    state = {
      version: 1,
      entryId: randomUUID(),
      enabled: false,
      previousAppliedId: null,
      previousMetaExisted: metaExisted,
      installedAt: new Date().toISOString(),
    };
  }
  if (!state.enabled || meta.appliedId !== state.entryId) {
    state.previousAppliedId = meta.appliedId || null;
    state.previousMetaExisted = metaExisted;
  }

  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  chmodSync(STATE_DIR, 0o700);
  if (metaExisted && !existsSync(CLAUDE_CONFIG_BACKUP_PATH)) {
    copyFileSync(CLAUDE_CONFIG_META_PATH, CLAUDE_CONFIG_BACKUP_PATH);
    protectPrivateFile(CLAUDE_CONFIG_BACKUP_PATH);
  }

  atomicJson(CLAUDE_CONFIG_STATE_PATH, {
    ...state,
    enabled: false,
    updatingAt: new Date().toISOString(),
  });
  try {
    atomicJson(entryPath(state.entryId), routerConfiguration(callerKey));
    const entries = meta.entries.filter((entry) => entry.id !== state.entryId);
    entries.push({ id: state.entryId, name: entryName });
    atomicJson(CLAUDE_CONFIG_META_PATH, {
      ...meta,
      appliedId: state.entryId,
      entries,
    });
    state.enabled = true;
    state.updatedAt = new Date().toISOString();
    delete state.updatingAt;
    atomicJson(CLAUDE_CONFIG_STATE_PATH, state);
  } catch (error) {
    try {
      disable();
    } catch {
      // Preserve the original failure; the protected metadata backup remains.
    }
    throw error;
  }
  return status();
}

function disable() {
  const state = readState();
  if (!state) return status();
  const meta = readMeta();
  const entries = meta.entries.filter((entry) => entry.id !== state.entryId);
  let appliedId = meta.appliedId;
  if (appliedId === state.entryId) {
    appliedId = entries.some((entry) => entry.id === state.previousAppliedId)
      ? state.previousAppliedId
      : entries[0]?.id || "";
  }
  const hasAdditionalMeta = Object.keys(meta).some(
    (key) => key !== "appliedId" && key !== "entries",
  );
  if (!state.previousMetaExisted && entries.length === 0 && !hasAdditionalMeta) {
    if (existsSync(CLAUDE_CONFIG_META_PATH)) unlinkSync(CLAUDE_CONFIG_META_PATH);
  } else {
    atomicJson(CLAUDE_CONFIG_META_PATH, { ...meta, appliedId, entries });
  }
  const target = entryPath(state.entryId);
  if (existsSync(target)) unlinkSync(target);
  const disabledState = {
    ...state,
    enabled: false,
    disabledAt: new Date().toISOString(),
  };
  delete disabledState.updatingAt;
  atomicJson(CLAUDE_CONFIG_STATE_PATH, disabledState);
  return status();
}

function refresh() {
  const state = readState();
  if (!state?.enabled) return status();
  readMeta();
  atomicJson(entryPath(state.entryId), routerConfiguration(configuredCallerKey()));
  return status();
}

const result =
  command === "enable"
    ? enable()
    : command === "disable"
      ? disable()
      : command === "refresh"
        ? refresh()
        : status();
process.stdout.write(`${JSON.stringify(result)}\n`);
