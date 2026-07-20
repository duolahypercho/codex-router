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
import { INTERNAL_SECRET_PATH, STATE_DIR } from "./paths.mjs";

const command = process.argv[2] || "status";
if (!new Set(["ensure", "status"]).has(command)) {
  console.error("Usage: secret.mjs ensure|status");
  process.exit(2);
}

if (command === "ensure") {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  chmodSync(STATE_DIR, 0o700);
  if (!existsSync(INTERNAL_SECRET_PATH)) {
    const temporary = `${INTERNAL_SECRET_PATH}.tmp.${process.pid}`;
    writeFileSync(temporary, `${randomBytes(48).toString("base64url")}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      protectPrivateFile(temporary);
      renameSync(temporary, INTERNAL_SECRET_PATH);
      protectPrivateFile(INTERNAL_SECRET_PATH);
    } catch (error) {
      if (existsSync(temporary)) unlinkSync(temporary);
      throw error;
    }
  }
}

const valid =
  existsSync(INTERNAL_SECRET_PATH) &&
  readFileSync(INTERNAL_SECRET_PATH, "utf8").trim().length >= 32;
if (valid) protectPrivateFile(INTERNAL_SECRET_PATH);
process.stdout.write(
  `${JSON.stringify({ present: valid, mode: valid ? statSync(INTERNAL_SECRET_PATH).mode & 0o777 : null })}\n`,
);
if (!valid) process.exitCode = 1;
