import { execFileSync } from "node:child_process";
import { closeSync, openSync, readSync, writeSync } from "node:fs";

import {
  apiProvider,
  credentialLabel,
  credentialStatus,
  primaryCredentialPath,
  writeProviderCredential,
} from "./provider-credentials.mjs";
import { providerNeedsCuration, removeApiCredential } from "./provider-onboarding.mjs";
import { enableProvider } from "./provider-selection.mjs";
import { secretEntryFeedback, secretEntryProblem } from "./secret-entry.mjs";
import {
  refreshTargetPickerIfInstalled,
  targetCli,
  targetPickerName,
  targetRestartHint,
} from "./target-integration.mjs";

const providerId = process.argv[2];
const command = process.argv[3] || "status";

if (!providerId || !new Set(["status", "set", "remove"]).has(command)) {
  console.error("Usage: provider-key.mjs PROVIDER status|set|remove");
  process.exit(2);
}

const provider = apiProvider(providerId);
const credentialType = credentialLabel(provider);
const credentialNoun = credentialType === "API key" ? "key" : credentialType.toLowerCase();

// The try/finally pair must live in a single array element: joining elements
// with "; " would otherwise produce "}; finally", which PowerShell rejects
// with "MissingCatchOrFinally" — silently breaking every hidden key prompt
// on Windows (the POSIX path reads /dev/tty directly and never hits this).
export const WINDOWS_HIDDEN_PROMPT_SCRIPT = [
  "$secret = Read-Host $env:CODEX_ROUTER_PROMPT_LABEL -AsSecureString",
  "$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)",
  "try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }",
].join("; ");

// A -Command argument is re-parsed by the Windows command-line quoting rules
// before PowerShell ever sees it, so the punctuation this prompt depends on is
// at the mercy of that layer. -EncodedCommand carries the script as base64
// UTF-16LE and skips the parsing entirely.
export function windowsHiddenPromptArgs(script = WINDOWS_HIDDEN_PROMPT_SCRIPT) {
  return [
    "-NoLogo",
    "-NoProfile",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ];
}

const WINDOWS_POWERSHELL_CANDIDATES = ["powershell.exe", "pwsh.exe"];

// A candidate that is not installed explains nothing about why the prompt
// failed, and pwsh.exe is absent on a stock Windows box. Keeping the last
// error used to bury the real powershell.exe failure under that ENOENT.
export function powerShellStartupError(failures) {
  return (
    failures.find((error) => error?.code !== "ENOENT") ||
    new Error(
      "PowerShell is required for hidden API-key input, but neither powershell.exe nor pwsh.exe could be started.",
    )
  );
}

function hiddenPrompt(label) {
  if (process.platform === "win32") {
    const args = windowsHiddenPromptArgs();
    const failures = [];
    for (const executable of WINDOWS_POWERSHELL_CANDIDATES) {
      try {
        return execFileSync(executable, args, {
          encoding: "utf8",
          env: { ...process.env, CODEX_ROUTER_PROMPT_LABEL: label },
          stdio: ["inherit", "pipe", "inherit"],
        });
      } catch (error) {
        failures.push(error);
      }
    }
    throw powerShellStartupError(failures);
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
      ? `${provider.displayName} ${credentialNoun} is configured via ${status.source}.${
          status.persistent
            ? ""
            : ` This environment-only ${credentialNoun} is not inherited by the background service; run the set command to save it securely.`
        }\n`
      : `${provider.displayName} ${credentialNoun} is not configured.\n`,
  );
  if (!status.configured) process.exitCode = 1;
} else if (command === "set") {
  const value = promptForKey(provider.credential.prompt || `${provider.displayName} API key`);
  const target = writeProviderCredential(provider, value);
  enableProvider(provider.id);
  const refreshed = refreshTargetPickerIfInstalled();
  process.stdout.write(
    `${provider.displayName} ${credentialNoun} saved to protected local storage at ${target}. The provider is enabled.${
      refreshed ? ` ${targetRestartHint()}` : ""
    }\n`,
  );
  if (providerNeedsCuration(provider.id)) {
    process.stdout.write(
      `${provider.displayName} ships no preselected models. Run \`${targetCli(`curate-models ${provider.id}`)}\` ` +
        `in an interactive terminal to choose which of its models appear in the picker.\n`,
    );
  }
} else {
  const removal = removeApiCredential(provider.id);
  const refreshed = removal.removedFiles ? refreshTargetPickerIfInstalled() : false;
  process.stdout.write(
    removal.removedFiles
      ? `Removed ${removal.removedFiles} managed ${provider.displayName} ${credentialNoun} file${removal.removedFiles === 1 ? "" : "s"} and disabled the provider.${
          refreshed ? ` ${targetRestartHint()}` : ""
        }\n`
      : `No managed ${provider.displayName} ${credentialNoun} file exists.\n`,
  );
  if (removal.stillConfigured) {
    process.stdout.write(
      `A ${provider.displayName} ${credentialNoun} is still available from ${removal.remainingSource}; remove it there to fully disconnect.\n`,
    );
  }
}
