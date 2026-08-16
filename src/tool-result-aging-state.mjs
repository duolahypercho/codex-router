import {
  existsSync,
  readFileSync,
} from "node:fs";
import path from "node:path";

import { writePrivateJson } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";
import {
  RETENTION_DEFAULT_TTL_DAYS,
  RETENTION_MAX_TTL_DAYS,
  RETENTION_MIN_TTL_DAYS,
  retentionTtlMsFromDays,
} from "./tool-result-retention.mjs";
import { toolResultAgingTotals } from "./usage-events.mjs";

export const TOOL_RESULT_AGING_STATE_PATH =
  process.env.MODEL_ROUTER_TOOL_RESULT_AGING_STATE ||
  path.join(STATE_DIR, "tool-result-aging.json");

// Both paths default off. Compaction rewrites tool results the model already
// acted on: it saves real context, but it is a change to what the model sees
// mid-conversation, and its savings figures are still being validated against
// provider-billed tokens. That is an experiment to opt into, not a default to
// discover after it has already altered a session. The structural rule from
// the vision bridge applies here too -- an absent file means nobody has
// answered and the current default applies, while a stored value is the
// operator's own answer and is kept verbatim, so turning this on survives any
// later change of default.
function defaultSettings() {
  return {
    version: 1,
    enabled: false,
    nativeEnabled: false,
    retentionTtlDays: RETENTION_DEFAULT_TTL_DAYS,
    defaulted: true,
  };
}

function disabledSettings() {
  return {
    version: 1,
    enabled: false,
    nativeEnabled: false,
    retentionTtlDays: RETENTION_DEFAULT_TTL_DAYS,
  };
}

// How long a retained original lives. Absent means nobody has answered, so the
// default applies and a later release may change it; a stored number is the
// operator's own answer and is kept verbatim, including `0`, which is "keep
// them until I say otherwise" and is the one answer a default must never
// overwrite -- expiry deletes bytes the model already saw.
function readRetentionTtlDays(value) {
  if (value === undefined || value === null) return RETENTION_DEFAULT_TTL_DAYS;
  const days = Number(value);
  if (!Number.isFinite(days) || days < 0) return RETENTION_DEFAULT_TTL_DAYS;
  if (days === 0) return 0;
  return Math.min(RETENTION_MAX_TTL_DAYS, Math.max(RETENTION_MIN_TTL_DAYS, days));
}

export function readToolResultAgingSettings() {
  if (!existsSync(TOOL_RESULT_AGING_STATE_PATH)) return defaultSettings();
  try {
    const parsed = JSON.parse(readFileSync(TOOL_RESULT_AGING_STATE_PATH, "utf8"));
    if (parsed?.version === 1 && typeof parsed.enabled === "boolean") {
      return {
        version: 1,
        enabled: parsed.enabled,
        // Absent on files written before the native flag existed; absence is
        // the off default, never an error.
        nativeEnabled: parsed.nativeEnabled === true,
        // Absent on every file written before the TTL existed, which reads as
        // the default rather than as "keep forever" -- those installs never
        // had a choice to preserve.
        retentionTtlDays: readRetentionTtlDays(parsed.retentionTtlDays),
      };
    }
  } catch {
    // A malformed explicit choice must not silently change routed context.
  }
  return disabledSettings();
}

function writeSettings(settings) {
  writePrivateJson(TOOL_RESULT_AGING_STATE_PATH, settings, { directoryMode: 0o700 });
  return settings;
}

export function setToolResultAgingEnabled(enabled) {
  const current = readToolResultAgingSettings();
  return writeSettings({
    version: 1,
    enabled: enabled === true,
    nativeEnabled: current.nativeEnabled === true,
    retentionTtlDays: current.retentionTtlDays,
  });
}

export function setNativeToolResultAgingEnabled(enabled) {
  const current = readToolResultAgingSettings();
  return writeSettings({
    version: 1,
    enabled: current.enabled === true,
    nativeEnabled: enabled === true,
    retentionTtlDays: current.retentionTtlDays,
  });
}

/**
 * Choose how long retained originals live. `0` keeps them until an explicit
 * purge; `undefined` restores the default and lets a later release move it.
 */
export function setRetentionTtlDays(days) {
  const current = readToolResultAgingSettings();
  let requested;
  if (days === undefined || days === null || days === "") {
    requested = RETENTION_DEFAULT_TTL_DAYS;
  } else {
    const value = Number(days);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(
        `Retention TTL must be a number of days, or 0 to keep retained results: ${days}`,
      );
    }
    if (value > 0 && (value < RETENTION_MIN_TTL_DAYS || value > RETENTION_MAX_TTL_DAYS)) {
      throw new Error(
        `Retention TTL must be 0 (off) or between ${RETENTION_MIN_TTL_DAYS} and ` +
          `${RETENTION_MAX_TTL_DAYS} days: ${days}`,
      );
    }
    requested = value;
  }
  return writeSettings({
    version: 1,
    enabled: current.enabled === true,
    nativeEnabled: current.nativeEnabled === true,
    retentionTtlDays: requested,
  });
}

export function retentionTtlDays() {
  return readToolResultAgingSettings().retentionTtlDays;
}

// The lifetime every reader of the store resolves. The environment kill switch
// is deliberately not consulted: it stops the router rewriting request context,
// and expiry is disk hygiene for bytes that were already written -- silencing
// compaction is no reason to keep an aging archive alive forever.
export function retentionTtlMs() {
  return retentionTtlMsFromDays(retentionTtlDays());
}

export function toolResultAgingEnabled() {
  if (process.env.CODEX_ROUTER_TOOL_RESULT_AGING === "0") return false;
  return readToolResultAgingSettings().enabled;
}

// The environment kill switch silences both paths: it exists to stop the
// router rewriting request context at all, not one flavor of it.
export function nativeToolResultAgingEnabled() {
  if (process.env.CODEX_ROUTER_TOOL_RESULT_AGING === "0") return false;
  return readToolResultAgingSettings().nativeEnabled === true;
}

export function toolResultAgingSnapshot() {
  const settings = readToolResultAgingSettings();
  const environmentOverride = process.env.CODEX_ROUTER_TOOL_RESULT_AGING === "0";
  return {
    ...settings,
    enabled: environmentOverride ? false : settings.enabled,
    configured: existsSync(TOOL_RESULT_AGING_STATE_PATH),
    environmentOverride,
    path: TOOL_RESULT_AGING_STATE_PATH,
    // Cumulative savings derived from recorded usage events, so every status
    // surface (CLI, desktop, tray) can show what the feature actually bought.
    stats: toolResultAgingTotals(),
  };
}
