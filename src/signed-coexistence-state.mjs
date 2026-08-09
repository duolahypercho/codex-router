import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { protectPrivateFile } from "./file-security.mjs";
import { SIGNED_COEXISTENCE_PATH } from "./paths.mjs";

function defaultState() {
  return { version: 1, model: null };
}

export function readSignedCoexistence() {
  try {
    const parsed = JSON.parse(readFileSync(SIGNED_COEXISTENCE_PATH, "utf8"));
    if (
      parsed?.version === 1 &&
      (parsed.model === null ||
        (typeof parsed.model === "string" && parsed.model.trim().length > 0))
    ) {
      return { version: 1, model: parsed.model };
    }
  } catch {
    // Missing or corrupt state stays off rather than changing the active model.
  }
  return defaultState();
}

function writeState(state) {
  const stateDir = path.dirname(SIGNED_COEXISTENCE_PATH);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const temporary = `${SIGNED_COEXISTENCE_PATH}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  protectPrivateFile(temporary);
  renameSync(temporary, SIGNED_COEXISTENCE_PATH);
  protectPrivateFile(SIGNED_COEXISTENCE_PATH);
}

export function setSignedCoexistenceModel(model) {
  const value = model === null ? null : String(model || "").trim();
  if (model !== null && !value) throw new Error("A coexistence model slug is required.");
  writeState({ version: 1, model: value });
  return signedCoexistenceSnapshot();
}

export function signedCoexistenceSnapshot() {
  return { ...readSignedCoexistence(), path: SIGNED_COEXISTENCE_PATH };
}
