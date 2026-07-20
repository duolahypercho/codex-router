import { execFileSync } from "node:child_process";
import { closeSync, openSync, readSync, writeSync } from "node:fs";

import {
  apiProvider,
  credentialStatus,
  primaryCredentialPath,
  removeProviderCredential,
  writeProviderCredential,
} from "./provider-credentials.mjs";

const providerId = process.argv[2];
const command = process.argv[3] || "status";

if (!providerId || !new Set(["status", "set", "remove"]).has(command)) {
  console.error("Usage: provider-key.mjs PROVIDER status|set|remove");
  process.exit(2);
}

const provider = apiProvider(providerId);

function hiddenPrompt(label) {
  let descriptor;
  try {
    descriptor = openSync("/dev/tty", "r+");
  } catch {
    throw new Error("An interactive terminal is required to enter an API key.");
  }
  let terminalState;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (terminalState) {
      try {
        execFileSync("/bin/stty", [terminalState], {
          stdio: [descriptor, "ignore", descriptor],
        });
      } catch {
        // Best-effort terminal restoration.
      }
    }
    try {
      writeSync(descriptor, "\n");
    } catch {
      // The terminal may already have gone away.
    }
  };
  const interrupted = (signal) => {
    cleanup();
    process.exit(signal === "SIGHUP" ? 129 : signal === "SIGINT" ? 130 : 143);
  };
  const handlers = new Map(
    ["SIGHUP", "SIGINT", "SIGTERM"].map((signal) => [
      signal,
      () => interrupted(signal),
    ]),
  );
  try {
    terminalState = execFileSync("/bin/stty", ["-g"], {
      encoding: "utf8",
      stdio: [descriptor, "pipe", descriptor],
    }).trim();
    for (const [signal, handler] of handlers) process.on(signal, handler);
    writeSync(descriptor, `${label}: `);
    execFileSync("/bin/stty", ["-echo"], {
      stdio: [descriptor, "ignore", descriptor],
    });
    const chunks = [];
    const byte = Buffer.alloc(1);
    while (readSync(descriptor, byte, 0, 1) === 1) {
      if (byte[0] === 10 || byte[0] === 13) break;
      chunks.push(Buffer.from(byte));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    cleanup();
    try {
      closeSync(descriptor);
    } catch {
      // The descriptor may already be closed after an interrupted terminal.
    }
  }
}

if (command === "status") {
  const status = credentialStatus(provider);
  process.stdout.write(
    status.configured
      ? `${provider.displayName} key is configured via ${status.source}.\n`
      : `${provider.displayName} key is not configured.\n`,
  );
  if (!status.configured) process.exitCode = 1;
} else if (command === "set") {
  const value = hiddenPrompt(provider.credential.prompt || `${provider.displayName} API key`);
  const target = writeProviderCredential(provider, value);
  process.stdout.write(
    `${provider.displayName} key saved to ${target} with mode 600. No service restart is required.\n`,
  );
} else {
  const removedCount = removeProviderCredential(provider);
  process.stdout.write(
    removedCount
      ? `Removed ${removedCount} managed ${provider.displayName} key file${removedCount === 1 ? "" : "s"}.\n`
      : `No managed ${provider.displayName} key file exists.\n`,
  );
}
