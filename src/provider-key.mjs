import { execFileSync } from "node:child_process";
import { closeSync, openSync, readSync, writeSync } from "node:fs";

import {
  apiProvider,
  credentialStatus,
  primaryCredentialPath,
  removeProviderCredential,
  writeProviderCredential,
} from "./provider-credentials.mjs";
import { disableProvider, enableProvider } from "./provider-selection.mjs";
import { secretEntryFeedback, secretEntryProblem } from "./secret-entry.mjs";
import {
  refreshTargetPickerIfInstalled,
  targetPickerName,
} from "./target-integration.mjs";

const providerId = process.argv[2];
const command = process.argv[3] || "status";

if (!providerId || !new Set(["status", "set", "remove"]).has(command)) {
  console.error("Usage: provider-key.mjs PROVIDER status|set|remove");
  process.exit(2);
}

const provider = apiProvider(providerId);

function hiddenPrompt(label) {
  if (process.platform === "win32") {
    const script = [
      "$secret = Read-Host $env:CODEX_ROUTER_PROMPT_LABEL -AsSecureString",
      "$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)",
      "try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)) }",
      "finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }",
    ].join("; ");
    let lastError;
    for (const executable of ["powershell.exe", "pwsh.exe"]) {
      try {
        return execFileSync(
          executable,
          ["-NoLogo", "-NoProfile", "-Command", script],
          {
            encoding: "utf8",
            env: { ...process.env, CODEX_ROUTER_PROMPT_LABEL: label },
            stdio: ["inherit", "pipe", "inherit"],
          },
        );
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("PowerShell is required for hidden API-key input.");
  }
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

function visiblePrompt(label) {
  if (process.platform === "win32") {
    const script = "[Console]::Out.Write((Read-Host $env:CODEX_ROUTER_PROMPT_LABEL))";
    let lastError;
    for (const executable of ["powershell.exe", "pwsh.exe"]) {
      try {
        return execFileSync(
          executable,
          ["-NoLogo", "-NoProfile", "-Command", script],
          {
            encoding: "utf8",
            env: { ...process.env, CODEX_ROUTER_PROMPT_LABEL: label },
            stdio: ["inherit", "pipe", "inherit"],
          },
        );
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("PowerShell is required for interactive confirmation.");
  }
  let descriptor;
  try {
    descriptor = openSync("/dev/tty", "r+");
  } catch {
    throw new Error("An interactive terminal is required to confirm the entered key.");
  }
  try {
    writeSync(descriptor, `${label}: `);
    const chunks = [];
    const byte = Buffer.alloc(1);
    while (readSync(descriptor, byte, 0, 1) === 1) {
      if (byte[0] === 10 || byte[0] === 13) break;
      chunks.push(Buffer.from(byte));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    try {
      closeSync(descriptor);
    } catch {
      // The descriptor may already be closed after an interrupted terminal.
    }
  }
}

const MAX_KEY_ATTEMPTS = 3;

// The hidden prompt disables terminal echo, so a paste gives no visual
// feedback; report the captured length and challenge input that looks like the
// same key pasted twice before anything is saved.
function promptForKey(label) {
  for (let attempt = 1; attempt <= MAX_KEY_ATTEMPTS; attempt += 1) {
    const value = hiddenPrompt(label);
    process.stdout.write(`${secretEntryFeedback(value)}\n`);
    const problem = secretEntryProblem(value);
    if (!problem) return value;
    let reason;
    if (problem === "empty") {
      reason = "No key was captured.";
    } else {
      const answer = visiblePrompt(
        "The input looks like the same key pasted twice. Save it anyway? [y/N]",
      ).trim();
      if (/^y(es)?$/i.test(answer)) return value;
      reason = "Discarded the doubled input.";
    }
    if (attempt === MAX_KEY_ATTEMPTS) {
      process.stdout.write(`${reason} Nothing was saved.\n`);
      process.exit(1);
    }
    process.stdout.write(`${reason} Paste or type the key again.\n`);
  }
}

if (command === "status") {
  const status = credentialStatus(provider);
  process.stdout.write(
    status.configured
      ? `${provider.displayName} key is configured via ${status.source}.${
          status.persistent
            ? ""
            : " This environment-only key is not inherited by the background service; run the set command to save it securely."
        }\n`
      : `${provider.displayName} key is not configured.\n`,
  );
  if (!status.configured) process.exitCode = 1;
} else if (command === "set") {
  const value = promptForKey(provider.credential.prompt || `${provider.displayName} API key`);
  const target = writeProviderCredential(provider, value);
  enableProvider(provider.id);
  const refreshed = refreshTargetPickerIfInstalled();
  process.stdout.write(
    `${provider.displayName} key saved to protected local storage at ${target}. The provider is enabled.${
      refreshed ? ` Fully quit and reopen ${targetPickerName()} to refresh the model picker.` : ""
    }\n`,
  );
} else {
  const removedCount = removeProviderCredential(provider);
  if (removedCount) disableProvider(provider.id);
  const refreshed = removedCount ? refreshTargetPickerIfInstalled() : false;
  process.stdout.write(
    removedCount
      ? `Removed ${removedCount} managed ${provider.displayName} key file${removedCount === 1 ? "" : "s"} and disabled the provider.${
          refreshed ? ` Fully quit and reopen ${targetPickerName()} to refresh the model picker.` : ""
        }\n`
      : `No managed ${provider.displayName} key file exists.\n`,
  );
}
