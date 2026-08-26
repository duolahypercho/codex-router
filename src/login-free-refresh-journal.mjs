import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { privateFileIsProtected, writePrivateJson } from "./file-security.mjs";
import {
  CODEX_PROVIDER_MODE_PATH,
  LOGIN_FREE_REFRESH_JOURNAL_PATH,
} from "./paths.mjs";

function stateIdentity() {
  if (lstatSync(CODEX_PROVIDER_MODE_PATH).isSymbolicLink()) {
    throw new Error("Cannot journal a symlinked login-free provider state.");
  }
  if (!privateFileIsProtected(CODEX_PROVIDER_MODE_PATH)) {
    throw new Error("Cannot journal login-free provider state that is not private.");
  }
  const source = readFileSync(CODEX_PROVIDER_MODE_PATH, "utf8");
  const state = JSON.parse(source);
  if (state?.version !== 1 && state?.version !== 3) {
    throw new Error("Cannot journal an unrecognized login-free provider state.");
  }
  const ownershipId = state.version === 3 ? state.ownershipId : null;
  if (state.version === 3 && !/^[0-9a-f]{32}$/.test(String(ownershipId || ""))) {
    throw new Error("Cannot journal login-free provider state without valid ownership.");
  }
  return {
    providerStateVersion: state.version,
    ownershipId,
    providerStateSha256: createHash("sha256").update(source).digest("hex"),
  };
}

function validJournal(value) {
  return (
    value?.version === 1 &&
    value.phase === "refreshing" &&
    /^[0-9a-f]{32}$/.test(String(value.operationId || "")) &&
    (value.providerStateVersion === 1 || value.providerStateVersion === 3) &&
    ((value.providerStateVersion === 1 && value.ownershipId === null) ||
      (value.providerStateVersion === 3 &&
        /^[0-9a-f]{32}$/.test(String(value.ownershipId || "")))) &&
    /^[0-9a-f]{64}$/.test(String(value.providerStateSha256 || "")) &&
    typeof value.canonicalModel === "string" &&
    value.canonicalModel.length > 0 &&
    typeof value.displayModel === "string" &&
    value.displayModel.length > 0
  );
}

export function readLoginFreeRefreshJournal() {
  if (!existsSync(LOGIN_FREE_REFRESH_JOURNAL_PATH)) return undefined;
  if (lstatSync(LOGIN_FREE_REFRESH_JOURNAL_PATH).isSymbolicLink()) {
    throw new Error("The login-free refresh journal is a symlink; refusing recovery.");
  }
  if (!privateFileIsProtected(LOGIN_FREE_REFRESH_JOURNAL_PATH)) {
    throw new Error("The login-free refresh journal is not private; refusing recovery.");
  }
  try {
    const value = JSON.parse(readFileSync(LOGIN_FREE_REFRESH_JOURNAL_PATH, "utf8"));
    if (!validJournal(value)) throw new Error("invalid journal");
    return value;
  } catch (error) {
    if (error instanceof Error && /not private/.test(error.message)) throw error;
    throw new Error(`Invalid login-free refresh journal at ${LOGIN_FREE_REFRESH_JOURNAL_PATH}.`);
  }
}

export function loginFreeRefreshJournalMatchesState(journal) {
  if (!journal) return false;
  try {
    const identity = stateIdentity();
    return (
      identity.providerStateVersion === journal.providerStateVersion &&
      identity.ownershipId === journal.ownershipId &&
      identity.providerStateSha256 === journal.providerStateSha256
    );
  } catch {
    return false;
  }
}

export function beginLoginFreeRefresh({ canonicalModel, displayModel }) {
  const identity = stateIdentity();
  const existing = readLoginFreeRefreshJournal();
  if (existing) {
    if (
      !loginFreeRefreshJournalMatchesState(existing) ||
      existing.canonicalModel !== canonicalModel ||
      existing.displayModel !== displayModel
    ) {
      throw new Error("A different login-free refresh is already pending; refusing to replace it.");
    }
    return existing;
  }
  const journal = {
    version: 1,
    phase: "refreshing",
    operationId: randomBytes(16).toString("hex"),
    ...identity,
    canonicalModel,
    displayModel,
  };
  writePrivateJson(LOGIN_FREE_REFRESH_JOURNAL_PATH, journal, { directoryMode: 0o700 });
  return journal;
}

export function clearLoginFreeRefreshJournal() {
  if (existsSync(LOGIN_FREE_REFRESH_JOURNAL_PATH)) {
    unlinkSync(LOGIN_FREE_REFRESH_JOURNAL_PATH);
  }
}

function main() {
  if (process.argv[2] !== "assert-clear") {
    throw new Error("Usage: login-free-refresh-journal.mjs assert-clear");
  }
  if (readLoginFreeRefreshJournal()) {
    throw new Error(
      "A login-free catalog refresh is pending; rerun bin/refresh-catalog before installing or repairing Codex Router.",
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
