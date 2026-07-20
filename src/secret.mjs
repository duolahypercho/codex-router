import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

import { protectPrivateFile } from "./file-security.mjs";
import {
  CALLER_SECRET_PATH,
  INTERNAL_SECRET_PATH,
  STATE_DIR,
} from "./paths.mjs";

const command = process.argv[2] || "status";
const generatedSecretPattern = /^[A-Za-z0-9_-]{32,}$/;
if (!new Set(["ensure", "status"]).has(command)) {
  console.error("Usage: secret.mjs ensure|status");
  process.exit(2);
}

function validSecret(target) {
  if (!existsSync(target)) return false;
  try {
    return generatedSecretPattern.test(readFileSync(target, "utf8").trim());
  } catch {
    return false;
  }
}

function ensureSecret(target) {
  if (!validSecret(target)) {
    const temporary = `${target}.tmp.${process.pid}`;
    writeFileSync(temporary, `${randomBytes(48).toString("base64url")}\n`, {
      encoding: "utf8",
      mode: 0o600,
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
}

function status(target) {
  const present = validSecret(target);
  if (present) protectPrivateFile(target);
  return {
    present,
    mode: present ? statSync(target).mode & 0o777 : null,
  };
}

if (command === "ensure") {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  chmodSync(STATE_DIR, 0o700);
  ensureSecret(INTERNAL_SECRET_PATH);
  ensureSecret(CALLER_SECRET_PATH);
}

const internal = status(INTERNAL_SECRET_PATH);
const caller = status(CALLER_SECRET_PATH);
process.stdout.write(
  `${JSON.stringify({
    present: internal.present && caller.present,
    mode: internal.mode,
    internal,
    caller,
  })}\n`,
);
if (!internal.present || !caller.present) process.exitCode = 1;
