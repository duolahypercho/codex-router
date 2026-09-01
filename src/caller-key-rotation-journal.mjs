import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { privateFileIsProtected, writePrivateJson } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";

export const CALLER_KEY_ROTATION_JOURNAL_PATH = path.join(STATE_DIR, "caller-key-rotation.json");
const PHASES = new Set(["prepared", "service-stopped", "secret-swapped", "clients-refreshed", "service-started", "verified"]);
const TARGETS = new Set(["codex", "dsh", "gemini", "openclaw"]);
const TRANSITIONS = Object.freeze({
  prepared: new Set(["service-stopped", "secret-swapped"]),
  "service-stopped": new Set(["secret-swapped"]),
  "secret-swapped": new Set(["clients-refreshed"]),
  "clients-refreshed": new Set(["service-started", "verified"]),
  "service-started": new Set(["verified"]),
  verified: new Set(),
});
const POST_SWAP_PHASES = new Set(["secret-swapped", "clients-refreshed", "service-started", "verified"]);

function validJournal(value) {
  return value?.version === 1 && PHASES.has(value.phase) &&
    /^[0-9a-f]{32}$/.test(String(value.operationId || "")) &&
    typeof value.serviceWasRunning === "boolean" && Array.isArray(value.targets) &&
    /^[0-9a-f]{64}$/.test(String(value.previousSecretSha256 || "")) &&
    (POST_SWAP_PHASES.has(value.phase)
      ? /^[0-9a-f]{64}$/.test(String(value.currentSecretSha256 || ""))
      : value.currentSecretSha256 === undefined) &&
    new Set(value.targets).size === value.targets.length && value.targets.every((target) => TARGETS.has(target));
}

export function readCallerKeyRotationJournal({ journalPath = CALLER_KEY_ROTATION_JOURNAL_PATH } = {}) {
  if (!existsSync(journalPath)) return undefined;
  if (lstatSync(journalPath).isSymbolicLink()) throw new Error("The caller capability rotation journal is a symlink; refusing recovery.");
  if (!privateFileIsProtected(journalPath)) throw new Error("The caller capability rotation journal is not private; refusing recovery.");
  try {
    const value = JSON.parse(readFileSync(journalPath, "utf8"));
    if (!validJournal(value)) throw new Error("invalid journal");
    return value;
  } catch (error) {
    if (error instanceof Error && /not private|symlink/.test(error.message)) throw error;
    throw new Error(`Invalid caller capability rotation journal at ${journalPath}.`);
  }
}

export function beginCallerKeyRotationJournal({ targets, serviceWasRunning, previousSecretSha256, operationId = randomBytes(16).toString("hex"), journalPath = CALLER_KEY_ROTATION_JOURNAL_PATH }) {
  if (readCallerKeyRotationJournal({ journalPath })) throw new Error("A caller capability rotation is already pending; recover it before starting another.");
  const value = { version: 1, phase: "prepared", operationId, targets: [...targets], serviceWasRunning: Boolean(serviceWasRunning), previousSecretSha256 };
  if (!validJournal(value)) throw new Error("Refusing to write an invalid caller capability rotation journal.");
  return writePrivateJson(journalPath, value, { directoryMode: 0o700 });
}

export function updateCallerKeyRotationJournal(current, phase, { journalPath = CALLER_KEY_ROTATION_JOURNAL_PATH, patch = {} } = {}) {
  if (!PHASES.has(phase)) throw new Error(`Unknown caller capability rotation phase: ${phase}`);
  const stored = readCallerKeyRotationJournal({ journalPath });
  if (!stored || stored.operationId !== current.operationId) throw new Error("Caller capability rotation journal ownership changed; refusing update.");
  if (!TRANSITIONS[stored.phase]?.has(phase)) {
    throw new Error(`Invalid caller capability rotation phase transition: ${stored.phase} -> ${phase}.`);
  }
  const next = { ...stored, ...patch, phase };
  if (!validJournal(next)) throw new Error("Refusing to write an invalid caller capability rotation journal update.");
  writePrivateJson(journalPath, next, { directoryMode: 0o700 });
  return next;
}

export function clearCallerKeyRotationJournal({ operationId, journalPath = CALLER_KEY_ROTATION_JOURNAL_PATH } = {}) {
  const stored = readCallerKeyRotationJournal({ journalPath });
  if (!stored) return false;
  if (operationId && stored.operationId !== operationId) throw new Error("Caller capability rotation journal ownership changed; refusing cleanup.");
  unlinkSync(journalPath);
  return true;
}
