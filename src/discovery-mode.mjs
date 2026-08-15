import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writePrivateJson } from "./file-security.mjs";
import { DISCOVERY_MODE_PATH } from "./paths.mjs";

// Credential discovery is every read of a secret the operator did not hand to
// this process directly: provider credential files, the macOS Keychain, other
// CLIs' session files, OAuth credential files, the Codex session, and the
// `codex login status` probe. An install made with `--no-discovery` promises
// none of those happen, and the promise has to survive the installer process:
// the router, the doctor, and the tray all consult this switch, so the marker
// is persisted in the state directory rather than carried in an environment
// variable that dies with the setup run.
//
// `CODEX_ROUTER_NO_DISCOVERY` overrides the file in both directions ("1"
// disables, "0" forces enabled). The installer uses it to make every child
// process honor the choice before the state directory exists, and tests use
// it to pin either mode.

let cached;

export function discoveryDisabled() {
  const override = process.env.CODEX_ROUTER_NO_DISCOVERY;
  if (override === "1") return true;
  if (override === "0") return false;
  if (cached === undefined) cached = readDiscoveryModeFile();
  return cached;
}

function readDiscoveryModeFile() {
  if (!existsSync(DISCOVERY_MODE_PATH)) return false;
  try {
    const parsed = JSON.parse(readFileSync(DISCOVERY_MODE_PATH, "utf8"));
    // An unreadable or unrecognized file means the operator's intent cannot be
    // proven, and the conservative reading of "cannot prove --no-discovery"
    // is to keep discovery on: that is the state every install without the
    // flag has always had.
    return parsed?.version === 1 && parsed.discovery === "disabled";
  } catch {
    return false;
  }
}

export function writeDiscoveryMode(disabled) {
  writePrivateJson(
    DISCOVERY_MODE_PATH,
    { version: 1, discovery: disabled ? "disabled" : "enabled" },
    { directoryMode: 0o700 },
  );
  cached = undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] || "status";
  if (command === "status") {
    process.stdout.write(
      `${JSON.stringify({ discovery: discoveryDisabled() ? "disabled" : "enabled" })}\n`,
    );
  } else if (command === "set" && ["enabled", "disabled"].includes(process.argv[3])) {
    writeDiscoveryMode(process.argv[3] === "disabled");
    process.stdout.write(`${JSON.stringify({ discovery: process.argv[3] })}\n`);
  } else {
    console.error("Usage: discovery-mode.mjs status|set enabled|disabled");
    process.exit(2);
  }
}
